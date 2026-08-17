/**
 * dsh.js — DeepSeek Harness service lifecycle.
 *
 * Port strategy:
 *   1. Scan 3080–3180 for an already-running dsh (verified by response
 *      signature). Match ⇒ reuse it on that port.
 *   2. No match ⇒ pick the first free port from 3080 up and spawn.
 *
 * dsh runs detached + unref'd, so closing the desktop app never kills the
 * server; the next launch just reconnects.
 *
 * Plugin: every time this file spawns dsh, it also installs the bundled
 * `dsh-api` plugin into the profile directory and hands the resulting patch
 * layer to dsh via `--patch`. That means the HTTP control-plane at
 * `/dsh-api/*` is always available on any dsh instance we start.
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const {
  nodeBin, npxBin, dshEntryPath,
  apiPluginDir, apiPluginPatchFile, bundledPluginFile,
} = require('./paths');
const { log } = require('./logger');

const DEFAULT_PORT = 3080;
const PORT_SCAN_RANGE = 100; // 3080–3180
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 60000;

/** The patch layer we write beside the plugin: append one entry to the loader graph. */
const API_PLUGIN_PATCH_CONTENT = `# dsh-api plugin patch (written by dsh-desktop on every launch)
- insert:
    - id: dsh-api
      name: ./dsh-api/index.mjs
`;

let dshProc = null;
let dshEntry = null;
let workspaceDir = null;
let actualPort = DEFAULT_PORT;

function dshUrl() { return `http://127.0.0.1:${actualPort}`; }

/**
 * Copy the bundled `dsh-api` plugin into the dsh web profile so `--patch`
 * can load it. Overwrites every launch to stay in sync with the shipped app.
 */
function installApiPlugin() {
  const src = bundledPluginFile();
  const dir = apiPluginDir();
  try {
    if (!fs.existsSync(src)) {
      log('dsh-api plugin: bundled source missing at', src);
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.mjs'), fs.readFileSync(src, 'utf8'), 'utf8');
    fs.writeFileSync(apiPluginPatchFile(), API_PLUGIN_PATCH_CONTENT, 'utf8');
    log('dsh-api plugin: installed to', dir);
    return true;
  } catch (e) {
    log('dsh-api plugin: install failed:', e.message);
    return false;
  }
}

/**
 * Environment for the spawned dsh process. Electron app bundles ship with a
 * stripped PATH, so we prepend the directories that hold node / npx.
 */
function buildEnv() {
  const nodeDir = path.dirname(nodeBin());
  const npxDir = path.dirname(npxBin());
  const extras = [nodeDir, npxDir, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean);
  const current = process.env.PATH || '';
  const combined = [...new Set([...extras, ...current.split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  return { ...process.env, PATH: combined };
}

/** Probe a port with an HTTP GET; a body containing dsh signatures ⇒ dsh is here. */
function isDshOnPort(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}`, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { resolve(body.includes('__DSH_BOOT__') || body.includes('@deepseek-ai')); });
      res.resume();
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

/** True if nothing is listening on the port. */
function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.listen(port, '127.0.0.1', () => { tester.close(() => resolve(true)); });
  });
}

async function findExistingDsh() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SCAN_RANGE; port++) {
    if (await isDshOnPort(port)) { log(`found existing dsh on :${port}`); return port; }
  }
  return null;
}

async function findFreePort() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SCAN_RANGE; port++) {
    if (await isPortFree(port)) { log(`found free port :${port}`); return port; }
  }
  throw new Error(`No free port in range ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_SCAN_RANGE - 1}`);
}

/** Poll a port until dsh answers; ~60s ceiling. */
function pollReady(port, startMs = Date.now()) {
  return new Promise((resolve, reject) => {
    if (Date.now() - startMs > POLL_TIMEOUT_MS) {
      return reject(new Error(`Server on :${port} did not respond within ${POLL_TIMEOUT_MS / 1000}s`));
    }
    const req = http.get(`http://127.0.0.1:${port}`, res => { res.resume(); resolve(); });
    req.setTimeout(POLL_MS, () => req.destroy());
    req.once('error', () => setTimeout(() => pollReady(port, startMs).then(resolve, reject), POLL_MS));
  });
}

/** Spawn one dsh process, detached from this app. */
function startDsh(onOutput, port) {
  if (!dshEntry) dshEntry = dshEntryPath();
  const useDirect = dshEntry && fs.existsSync(dshEntry);
  const cmd = useDirect ? nodeBin() : npxBin();
  // Note ordering: `--patch` is a dsh CLI flag; it must precede web-app args like `--port`.
  const patchArgs = fs.existsSync(apiPluginPatchFile()) ? ['--patch', apiPluginPatchFile()] : [];
  const args = useDirect
    ? [dshEntry, 'web', ...patchArgs, '--port', String(port)]
    : ['--no-install', '@deepseek-ai/dsh', 'web', ...patchArgs, '--port', String(port)];
  log('spawning dsh', useDirect ? '(direct node)' : '(npx)', cmd, args);

  dshProc = spawn(cmd, args, {
    ...(workspaceDir ? { cwd: workspaceDir } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv(),
    shell: false,
    detached: true,
  });
  dshProc.unref();
  log('dsh spawned, pid=', dshProc.pid, 'port=', port);

  const forward = d => { const s = d.toString().trim(); if (s && onOutput) onOutput(s); };
  dshProc.stdout.on('data', forward);
  dshProc.stderr.on('data', forward);
  dshProc.on('error', err => log('dsh:error', err.message));
}

/**
 * Ensure some dsh is available.
 *   reused  — found one already on 3080–3180
 *   started — none found; spawned a fresh one on the first free port
 * @returns {Promise<{mode: 'reused'|'started', port: number}>}
 */
async function ensureDsh(onOutput = null) {
  const existingPort = await findExistingDsh();
  if (existingPort !== null) {
    actualPort = existingPort;
    log(`reusing existing dsh on :${actualPort}`);
    return { mode: 'reused', port: actualPort };
  }

  actualPort = await findFreePort();
  startDsh(onOutput, actualPort);
  log('polling for dsh ready on :', actualPort);
  await pollReady(actualPort);
  log('dsh ready on :', actualPort);
  return { mode: 'started', port: actualPort };
}

/**
 * Switch workspace: kill old dsh (if we own it), spawn a new one on a free
 * port with the new cwd, and wait for ready. Returns the new port.
 */
async function switchWorkspace(dir, onOutput = null) {
  workspaceDir = dir;
  log('switching workspace to', dir);

  if (dshProc) {
    try { process.kill(-dshProc.pid); } catch { /* group already gone */ }
    dshProc = null;
  }

  actualPort = await findFreePort();
  startDsh(onOutput, actualPort);
  await pollReady(actualPort);
  log('workspace switched, dsh on :', actualPort);
  return actualPort;
}

function getWorkspaceDir() { return workspaceDir; }

module.exports = {
  dshUrl,
  DEFAULT_PORT,
  ensureDsh,
  switchWorkspace,
  isDshOnPort,
  isPortFree,
  findExistingDsh,
  findFreePort,
  installApiPlugin,
  getWorkspaceDir,
  buildEnv,
};
