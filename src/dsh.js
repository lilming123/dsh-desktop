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

/**
 * Resolved runtime the setup pipeline picked (system or bundled). Kept as a
 * process-scope singleton so `startDsh` uses the right absolute node/npx no
 * matter which module calls in. `setRuntime` is invoked from `setup.js`
 * right after `ensureRuntime` returns.
 */
let resolvedRuntime = null;
function setRuntime(rt) { resolvedRuntime = rt || null; }
function getRuntime()   { return resolvedRuntime; }

function dshUrl() { return `http://127.0.0.1:${actualPort}`; }
function getWorkspaceDir() { return workspaceDir; }

/**
 * Copy the bundled `dsh-api` plugin into the dsh web profile so `--patch`
 * can load it. The plugin file and patch template both come from the app
 * bundle so their contents are guaranteed in sync with the current binary
 * — no risk of the runtime and the patch drifting apart.
 *
 * Modern install path: `dsh plugin --profile web add dsh-api` (from npm)
 * or `add github:lilming123/dsh-api` drops the package into the profile's
 * `node_modules/` and registers it in `dsh.profile.bundles`. When that has
 * happened we skip the bundled copy entirely and let dsh's own loader do
 * the work — this function only exists as a fallback for profiles that
 * haven't been migrated yet.
 *
 * @returns {'skipped-installed'|'installed'|false}
 *   `'skipped-installed'` — profile already carries an npm-installed copy;
 *   `'installed'`         — bundled fallback written to the profile dir;
 *   `false`               — we couldn't install even the fallback (loud in log).
 */
function installApiPlugin() {
  // Detection first: if the profile's node_modules/dsh-api resolves and its
  // package.json says `dsh.bundle.patch` (i.e. it's a real bundle-eligible
  // install), skip the fallback so we don't shadow it. We also need the
  // profile's `dsh.profile.bundles` to list "dsh-api" — otherwise dsh's
  // loader won't pick it up and we do still need to patch it in manually.
  const detected = detectInstalledApiPlugin();
  if (detected) {
    log('dsh-api plugin: detected npm install at', detected);
    // Best-effort: clean up a stale bundled copy so the two don't coexist
    // and confuse a user reading the profile directory. Failures are fine
    // — the loader picks the node_modules copy regardless.
    tryRemoveLegacyFallback();
    return 'skipped-installed';
  }

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
    return 'installed';
  } catch (e) {
    log('dsh-api plugin: install failed:', e.message);
    return false;
  }
}

/**
 * Return the absolute path of an npm-installed dsh-api inside the web
 * profile, or `null` if it isn't there / isn't a real bundle package.
 *
 * We check three things:
 *   1. `node_modules/dsh-api/package.json` exists and parses;
 *   2. it declares `dsh.bundle.patch` (a real dsh bundle, not an unrelated
 *      package that happens to share the name);
 *   3. the profile's own package.json lists "dsh-api" in
 *      `dsh.profile.bundles` — otherwise the loader won't apply it.
 *
 * Any check failure returns `null`, and the caller falls back to the
 * bundled copy. This keeps the "always works" property of the desktop
 * app: if the user's profile is weird, we still install our own copy.
 */
function detectInstalledApiPlugin() {
  try {
    const profile = path.dirname(apiPluginDir()); // profiles/web/
    const modPkgPath = path.join(profile, 'node_modules', 'dsh-api', 'package.json');
    if (!fs.existsSync(modPkgPath)) return null;
    const modPkg = JSON.parse(fs.readFileSync(modPkgPath, 'utf8'));
    if (!modPkg?.dsh?.bundle?.patch) return null;
    const profilePkgPath = path.join(profile, 'package.json');
    if (!fs.existsSync(profilePkgPath)) return null;
    const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
    const bundles = profilePkg?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes('dsh-api')) return null;
    return path.dirname(modPkgPath);
  } catch (e) {
    log('dsh-api plugin: detect failed:', e && e.message);
    return null;
  }
}

/**
 * Remove `<profile>/dsh-api/` and `<profile>/dsh-api.patch.yml` — the
 * legacy fallback layout — so nothing shadows the npm-installed copy.
 * Errors are swallowed: the loader is fine either way.
 */
function tryRemoveLegacyFallback() {
  const dir = apiPluginDir();
  const patch = apiPluginPatchFile();
  try {
    if (fs.existsSync(patch)) fs.unlinkSync(patch);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

/**
 * Install `dsh-api` from GitHub into the web profile's node_modules, using
 * dsh's own `dsh plugin --profile web add <spec>` command (which is a thin
 * pnpm wrapper that also registers the package in `dsh.profile.bundles`).
 *
 * On success the plugin loader picks it up automatically on the next dsh
 * spawn — no `--patch` needed, and `installApiPlugin()` will return
 * `'skipped-installed'` from now on.
 *
 * Failure modes surfaced to the caller:
 *   - No dsh entry (npx cache miss / offline first-run)  → 'no-dsh-entry'
 *   - No runtime resolved (called before setup Step 1)   → 'no-runtime'
 *   - `dsh plugin add` exited non-zero (network, git, …) → 'exec-failed'
 *   - Post-install detection still says "not installed"  → 'not-detected'
 *
 * The caller (splash pipeline) uses failures to decide whether to fall back
 * to the bundled copy; the menu action shows the failure to the user.
 *
 * @param {{
 *   spec?: string,                       // pnpm-style spec; default 'github:lilming123/dsh-api'
 *   onStdout?: (chunk: string) => void,  // streaming pnpm progress for the splash
 *   onStderr?: (chunk: string) => void,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, spec: string, status?: string, error?: string, path?: string }>}
 */
async function installApiPluginFromGitHub(opts = {}) {
  const spec = opts.spec || 'github:lilming123/dsh-api';
  const env = opts.env || buildEnv();
  const onStdout = typeof opts.onStdout === 'function' ? opts.onStdout : () => {};
  const onStderr = typeof opts.onStderr === 'function' ? opts.onStderr : () => {};

  // Prefer direct-node execution (fast + deterministic) whenever the dsh
  // entry is resolvable; otherwise fall back to npx (first-run before dsh
  // is even prefetched — unusual for this call site, since Step 2 already
  // ran, but defensively handled).
  const dshEntry = dshEntryPath();
  let cmd, args;
  if (dshEntry && resolvedRuntime?.nodePath) {
    cmd = resolvedRuntime.nodePath;
    args = [dshEntry, 'plugin', '--profile', 'web', 'add', spec];
  } else if (resolvedRuntime?.npxPath) {
    cmd = resolvedRuntime.npxPath;
    args = ['--no-install', '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', spec];
  } else {
    return { ok: false, spec, status: 'no-runtime', error: 'runtime not resolved yet' };
  }

  log('dsh-api plugin: installing from', spec, 'via', cmd);

  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let settled = false;
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (c) => {
      const s = c.toString('utf8'); stdout += s; onStdout(s);
    });
    proc.stderr.on('data', (c) => {
      const s = c.toString('utf8'); stderr += s; onStderr(s);
    });
    proc.on('error', (e) => {
      if (settled) return; settled = true;
      log('dsh-api plugin: spawn error:', e.message);
      resolve({ ok: false, spec, status: 'exec-failed', error: e.message });
    });
    proc.on('exit', (code) => {
      if (settled) return; settled = true;
      if (code !== 0) {
        // Trim to the last non-empty error line to keep splash status readable.
        const tail = (stderr || stdout).trim().split('\n').filter(Boolean).slice(-1)[0] || `exit ${code}`;
        log('dsh-api plugin: install exited', code, tail);
        return resolve({ ok: false, spec, status: 'exec-failed', error: tail });
      }
      const detected = detectInstalledApiPlugin();
      if (!detected) {
        log('dsh-api plugin: install exited 0 but detection failed');
        return resolve({ ok: false, spec, status: 'not-detected', error: 'post-install detection failed' });
      }
      // Legacy fallback would shadow the fresh install on load; drop it.
      tryRemoveLegacyFallback();
      log('dsh-api plugin: installed via', spec, 'at', detected);
      resolve({ ok: true, spec, path: detected });
    });
  });
}

/**
 * Environment for the spawned dsh process. Electron app bundles ship with a
 * stripped PATH, so we prepend the directories that hold node / npx.
 *
 * When `setup.js` has already resolved a runtime (system or bundled), we use
 * those absolute paths as the primary contributor to PATH. If an optional
 * pnpm binary was detected on the host, its directory is also prepended so
 * dsh subprocesses can call `pnpm` without us touching the user's shell.
 *
 * IMPORTANT: PATH mutations happen only inside the spawned child's env — the
 * parent Electron process and the user's shell rc files are never touched.
 */
function buildEnv() {
  const rt = resolvedRuntime;
  const nodeDir = rt ? path.dirname(rt.nodePath) : path.dirname(nodeBin());
  const npxDir  = rt ? path.dirname(rt.npxPath)  : path.dirname(npxBin());
  const pnpmDir = rt && rt.pnpmPath ? path.dirname(rt.pnpmPath) : null;
  const extras = [nodeDir, npxDir, pnpmDir, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean);
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
  // Always re-probe: a background upstream prefetch may have installed a
  // newer @deepseek-ai/dsh into the npx cache since the last spawn, and we
  // want to pick that up on the next start without a full app restart.
  dshEntry = dshEntryPath();
  const useDirect = dshEntry && fs.existsSync(dshEntry);
  // Prefer the runtime `setup.js` resolved for us (system or bundled). Fall
  // back to `paths.js` heuristics only if we somehow spawned before setup.
  const node = resolvedRuntime ? resolvedRuntime.nodePath : nodeBin();
  const npx  = resolvedRuntime ? resolvedRuntime.npxPath  : npxBin();
  const cmd  = useDirect ? node : npx;
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

/**
 * Find the pid that owns `port`, using `lsof` on POSIX and `netstat` on
 * Windows. Returns `null` when the port is free or the query fails.
 * We deliberately avoid `pgrep`-style process-name matching: it can miss
 * a `node` process that's actually dsh, or match unrelated node processes.
 */
function findPortOwnerPid(port) {
  try {
    if (isWin) {
      const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      const out = r.stdout || '';
      const rx = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'm');
      const m = out.match(rx);
      return m ? Number(m[1]) : null;
    }
    // POSIX: `lsof -tiTCP:<port> -sTCP:LISTEN` prints one pid per line.
    const r = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pid = Number((r.stdout || '').trim().split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (e) {
    log('findPortOwnerPid:', e && e.message);
    return null;
  }
}

/**
 * Kill an arbitrary dsh process by pid (used for "restart dsh" when we
 * don't own the child — e.g. the dsh we reused was started by an earlier
 * desktop-app run and survived our exit). POSIX: SIGTERM then SIGKILL after
 * 1s if the process still exists. Windows: taskkill /PID <pid> /T /F.
 * Fatal errors are logged but never thrown.
 */
function killDshByPid(pid) {
  if (!pid || pid <= 0) return;
  log('killDshByPid: pid=' + pid);
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    // On POSIX, if we didn't spawn it we can't reach the process *group*;
    // signal the single pid instead. That leaves any orphaned child (e.g.
    // a dsh worker fork) to a supervisor — dsh doesn't fork on POSIX today.
    try { process.kill(pid, 'SIGTERM'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; return; }
    // Blocking sleep is fine here: the caller (Restart button) is already
    // in an async flow and this bounds the wait to 1s.
    const start = Date.now();
    while (Date.now() - start < 1000) {
      try { process.kill(pid, 0); } // signal 0 = existence check
      catch (e) { if (e.code === 'ESRCH') return; }
      // still alive — brief sleep
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    try { process.kill(pid, 'SIGKILL'); }
    catch (e) { if (e.code !== 'ESRCH') log('killDshByPid SIGKILL:', e.message); }
  } catch (e) {
    log('killDshByPid:', e && e.message);
  }
}

/**
 * Restart the dsh backing the desktop app. Handles both cases:
 *   1. We own the child (`dshProc` set) — kill our tree and respawn.
 *   2. We reused an already-running dsh — look up its pid by port and
 *      kill it, then respawn.
 *
 * The new dsh listens on the same port when possible; if that port hasn't
 * freed up within a short window (kernel TIME_WAIT, or another process
 * grabbed it), we allocate a fresh free port.
 *
 * @param {(chunk: string) => void} [onOutput]
 * @returns {Promise<{ ok: true, port: number } | { ok: false, error: string }>}
 */
async function restartDsh(onOutput = null) {
  try {
    const oldPort = actualPort;
    if (dshProc) {
      killDshProc(dshProc);
      dshProc = null;
    } else {
      const pid = findPortOwnerPid(oldPort);
      if (pid) killDshByPid(pid);
    }
    // Wait up to 2s for the port to free. If it doesn't, walk to a new one.
    let target = oldPort;
    const start = Date.now();
    while (Date.now() - start < 2000) {
      // eslint-disable-next-line no-await-in-loop
      if (await isPortFree(target)) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await isPortFree(target))) target = await findFreePort();

    actualPort = target;
    dshProc = startDsh(onOutput, target);
    await pollReady(target);
    detachStdio(dshProc);
    log('dsh restarted on :', target);
    return { ok: true, port: target };
  } catch (e) {
    log('restartDsh:', e && e.message);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
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
  installApiPluginFromGitHub,
  detectInstalledApiPlugin,
  restartDsh,
  getWorkspaceDir,
  buildEnv,
  setRuntime,
  getRuntime,
};
