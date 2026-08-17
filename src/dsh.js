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
 * Plugin: whenever this file **spawns** dsh, it also installs the bundled
 * `dsh-api` plugin into the profile directory and hands the resulting patch
 * layer to dsh via `--patch`. That means the HTTP control-plane at
 * `/dsh-api/*` is available on any dsh instance we start. When we reuse a
 * pre-existing dsh, the plugin might not be present — `pluginClient` and
 * the menu degrade gracefully.
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const {
  isWin,
  nodeBin, npxBin, dshEntryPath,
  apiPluginDir, apiPluginPatchFile, bundledPluginFile, bundledPluginPatchFile,
} = require('./paths');
const { readTextSafe, writeTextAtomic } = require('./fsx');
const { log } = require('./logger');

const DEFAULT_PORT = 3080;
const PORT_SCAN_RANGE = 100; // 3080–3180
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 60000;

let dshProc = null;
let dshEntry = null;
let workspaceDir = null;
let actualPort = DEFAULT_PORT;

function dshUrl() { return `http://127.0.0.1:${actualPort}`; }
function getWorkspaceDir() { return workspaceDir; }

/**
 * Copy the bundled `dsh-api` plugin into the dsh web profile so `--patch`
 * can load it. The plugin file and patch template both come from the app
 * bundle so their contents are guaranteed in sync with the current binary
 * — no risk of the runtime and the patch drifting apart.
 */
function installApiPlugin() {
  const src = bundledPluginFile();
  const patchSrc = bundledPluginPatchFile();
  const dir = apiPluginDir();
  try {
    if (!fs.existsSync(src)) {
      log('dsh-api plugin: bundled source missing at', src);
      return false;
    }
    const pluginBody = readTextSafe(src, null);
    if (pluginBody === null) {
      log('dsh-api plugin: bundled source unreadable at', src);
      return false;
    }
    const patchBody = readTextSafe(patchSrc, null);
    if (patchBody === null) {
      log('dsh-api plugin: bundled patch missing/unreadable at', patchSrc);
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    writeTextAtomic(path.join(dir, 'index.mjs'), pluginBody);
    writeTextAtomic(apiPluginPatchFile(), patchBody);
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
  const combined = [...new Set([...extras, ...current.split(path.delimiter).filter(Boolean)])]
    .join(path.delimiter);
  return { ...process.env, PATH: combined };
}

/** Probe a port with HTTP GET; body containing dsh signatures ⇒ dsh is here. */
function isDshOnPort(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}`, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body.includes('__DSH_BOOT__') || body.includes('@deepseek-ai')));
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

/**
 * Kill an old dsh instance we spawned. Cross-platform:
 *   - POSIX: `process.kill(-pid)` — signal the whole process group.
 *   - Windows: `taskkill /pid <pid> /T /F` — /T terminates the tree.
 * Errors are logged but never thrown — a "kill already dead" is normal.
 */
function killDshProc(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-proc.pid);
    }
  } catch (e) {
    if (e && e.code !== 'ESRCH') log('killDshProc:', e.message);
  }
}

/**
 * Spawn one dsh process, detached from this app.
 * We keep stdout/stderr pipes only long enough to observe the readiness
 * banner and forward log lines; once `pollReady` succeeds we destroy the
 * pipes so the child is fully detached — otherwise SIGPIPE would kill dsh
 * when this app exits.
 * @returns {ChildProcess}
 */
function startDsh(onOutput, port) {
  if (!dshEntry) dshEntry = dshEntryPath();
  const useDirect = dshEntry && fs.existsSync(dshEntry);
  const cmd = useDirect ? nodeBin() : npxBin();
  // Ordering matters: `--patch` is a dsh CLI flag; it must precede web-app args (`--port`).
  const patchArgs = fs.existsSync(apiPluginPatchFile()) ? ['--patch', apiPluginPatchFile()] : [];
  const args = useDirect
    ? [dshEntry, 'web', ...patchArgs, '--port', String(port)]
    : ['--no-install', '@deepseek-ai/dsh', 'web', ...patchArgs, '--port', String(port)];
  log('spawning dsh', useDirect ? '(direct node)' : '(npx)', cmd, args);

  const proc = spawn(cmd, args, {
    ...(workspaceDir ? { cwd: workspaceDir } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv(),
    shell: false,
    detached: true,
  });
  proc.unref();
  log('dsh spawned, pid=', proc.pid, 'port=', port);

  const forward = d => { const s = d.toString().trim(); if (s && onOutput) onOutput(s); };
  proc.stdout.on('data', forward);
  proc.stderr.on('data', forward);
  proc.on('error', err => log('dsh:error', err.message));

  return proc;
}

/** After dsh is ready, close pipes so it survives our exit cleanly. */
function detachStdio(proc) {
  if (!proc) return;
  try { proc.stdout && proc.stdout.destroy(); } catch { /* already closed */ }
  try { proc.stderr && proc.stderr.destroy(); } catch { /* already closed */ }
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
  dshProc = startDsh(onOutput, actualPort);
  log('polling for dsh ready on :', actualPort);
  await pollReady(actualPort);
  detachStdio(dshProc);
  log('dsh ready on :', actualPort);
  return { mode: 'started', port: actualPort };
}

/**
 * Switch workspace: kill the dsh we own, spawn a new one on a free port with
 * the new cwd, wait for ready. Returns the new port.
 */
async function switchWorkspace(dir, onOutput = null) {
  workspaceDir = dir;
  log('switching workspace to', dir);

  killDshProc(dshProc);
  dshProc = null;

  actualPort = await findFreePort();
  dshProc = startDsh(onOutput, actualPort);
  await pollReady(actualPort);
  detachStdio(dshProc);
  log('workspace switched, dsh on :', actualPort);
  return actualPort;
}

module.exports = {
  DEFAULT_PORT,
  dshUrl,
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
