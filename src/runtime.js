/**
 * runtime.js — Bootstrap the Node.js runtime the desktop app uses.
 *
 * Rules of the road:
 *
 *   1. Prefer a compatible system Node (>= 20). If found, we do NOT modify
 *      anything on the user's machine — no PATH exports, no shell rc edits,
 *      no global installs. We simply record the absolute path and reuse it.
 *
 *   2. If no compatible system Node exists, download the pinned LTS from
 *      the official nodejs.org mirror into `~/.dsh/runtime/node/<version>/`
 *      and reuse it forever. The download is atomic (tmp dir → rename) and
 *      re-tried on every launch if a partial extract is detected.
 *
 *   3. Pnpm is optional and NEVER installed. We only detect it so callers
 *      can prepend its directory to a spawned child's `env.PATH`.
 *
 * Everything here is best-effort and reports progress through a callback so
 * the splash screen can render a live status. Nothing throws unless every
 * fallback is exhausted — in that case the caller shows the error UI.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { homePath, writeTextAtomic } = require('./fsx');
const { log } = require('./logger');

const isWin = process.platform === 'win32';

/** Pinned LTS. Bump this constant to move every user forward on the next launch. */
const NODE_LTS = '20.18.1';
/** Minimum system-Node major we accept before falling back to bundled. */
const MIN_NODE_MAJOR = 20;

// ── Paths ────────────────────────────────────────────────────────────────────

function dshHome() { return process.env.DSH_HOME || homePath('.dsh'); }
function runtimeRoot() { return path.join(dshHome(), 'runtime'); }
function bundledNodeRoot() { return path.join(runtimeRoot(), 'node'); }
function bundledNodeDir(version = NODE_LTS) { return path.join(bundledNodeRoot(), version); }

function bundledNodeBin(version = NODE_LTS) {
  return isWin
    ? path.join(bundledNodeDir(version), 'node.exe')
    : path.join(bundledNodeDir(version), 'bin', 'node');
}
function bundledNpxBin(version = NODE_LTS) {
  return isWin
    ? path.join(bundledNodeDir(version), 'npx.cmd')
    : path.join(bundledNodeDir(version), 'bin', 'npx');
}
function bundledNpmBin(version = NODE_LTS) {
  return isWin
    ? path.join(bundledNodeDir(version), 'npm.cmd')
    : path.join(bundledNodeDir(version), 'bin', 'npm');
}

// ── System detection ─────────────────────────────────────────────────────────

/**
 * Candidate absolute paths for a system Node. We keep this list explicit so
 * an Electron app bundle (which starts with a stripped PATH) can still find
 * a Homebrew or manually-installed Node.
 */
function systemNodeCandidates() {
  const home = os.homedir();
  return isWin
    ? [
        path.join(home, '.hermes', 'node', 'node.exe'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'node.exe'),
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
      ]
    : [
        path.join(home, '.hermes', 'node', 'bin', 'node'),
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
      ];
}

/** Ask a candidate `node` its version. Returns semver string or `null`. */
function probeNodeVersion(nodePath) {
  try {
    const r = spawnSync(nodePath, ['-p', 'process.versions.node'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    if (r.status === 0) return String(r.stdout || '').trim() || null;
  } catch { /* ignore */ }
  return null;
}

function parseMajor(semver) {
  const m = /^(\d+)\./.exec(String(semver || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Search well-known install locations for a Node >= MIN_NODE_MAJOR.
 * Also probes the bare `node` command as a last resort so a shell-provided
 * `node` still works when the app is launched from a terminal.
 */
function detectSystemNode() {
  const seen = new Set();
  const scan = (nodePath) => {
    const key = nodePath.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    try { if (!fs.existsSync(nodePath)) return null; } catch { return null; }
    const version = probeNodeVersion(nodePath);
    if (!version) return null;
    const major = parseMajor(version);
    if (major < MIN_NODE_MAJOR) {
      log(`system node ${nodePath} v${version} is too old (< ${MIN_NODE_MAJOR}), ignoring`);
      return null;
    }
    return { path: nodePath, version };
  };

  for (const c of systemNodeCandidates()) {
    const hit = scan(c);
    if (hit) return hit;
  }
  // Last resort: bare `node` on PATH. spawnSync resolves it via the launcher's PATH.
  const bare = isWin ? 'node.exe' : 'node';
  try {
    const version = probeNodeVersion(bare);
    if (version && parseMajor(version) >= MIN_NODE_MAJOR) {
      return { path: bare, version };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Derive `npx` / `npm` peers from a resolved system-node absolute path. When
 * `node` is a bare command, we return bare peers and trust PATH resolution.
 */
function peerBins(nodePath) {
  if (!nodePath.includes(path.sep) && !nodePath.includes('/') && !(isWin && nodePath.includes('\\'))) {
    return {
      npx: isWin ? 'npx.cmd' : 'npx',
      npm: isWin ? 'npm.cmd' : 'npm',
    };
  }
  const dir = path.dirname(nodePath);
  return isWin
    ? { npx: path.join(dir, 'npx.cmd'), npm: path.join(dir, 'npm.cmd') }
    : { npx: path.join(dir, 'npx'),    npm: path.join(dir, 'npm') };
}

/** Detect an existing pnpm without installing anything. Returns absolute path or `null`. */
function detectSystemPnpm() {
  const home = os.homedir();
  const candidates = isWin
    ? [
        path.join(home, 'AppData', 'Local', 'pnpm', 'pnpm.exe'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'pnpm.cmd'),
        'pnpm.cmd',
      ]
    : [
        path.join(home, '.local', 'share', 'pnpm', 'pnpm'),
        '/usr/local/bin/pnpm',
        '/opt/homebrew/bin/pnpm',
        'pnpm',
      ];
  for (const c of candidates) {
    try {
      const bare = !c.includes(path.sep) && !c.includes('/') && !(isWin && c.includes('\\'));
      if (bare) {
        const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
        if (r.status === 0) return c;
        continue;
      }
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Bundled Node install ─────────────────────────────────────────────────────

/** Map process.platform/arch to nodejs.org distribution tuple. */
function distTuple() {
  const platform = process.platform;
  const arch = process.arch;
  let osKey;
  if (platform === 'darwin') osKey = 'darwin';
  else if (platform === 'linux') osKey = 'linux';
  else if (platform === 'win32') osKey = 'win';
  else throw new Error(`Unsupported platform for bundled Node: ${platform}`);

  let archKey;
  if (arch === 'arm64') archKey = 'arm64';
  else if (arch === 'x64') archKey = 'x64';
  else throw new Error(`Unsupported arch for bundled Node: ${arch}`);

  const ext = osKey === 'win' ? 'zip' : 'tar.gz';
  return { osKey, archKey, ext };
}

function nodeDistUrl(version = NODE_LTS) {
  const { osKey, archKey, ext } = distTuple();
  const name = `node-v${version}-${osKey}-${archKey}`;
  return {
    url: `https://nodejs.org/dist/v${version}/${name}.${ext}`,
    dirName: name,
    ext,
  };
}

/** Is `~/.dsh/runtime/node/<ver>/bin/node` a working binary? */
function isBundledNodeReady(version = NODE_LTS) {
  const bin = bundledNodeBin(version);
  try {
    if (!fs.existsSync(bin)) return false;
  } catch { return false; }
  const v = probeNodeVersion(bin);
  return v === version;
}

/**
 * HTTPS download with progress. Follows one level of redirects (nodejs.org
 * sometimes redirects to a CDN). Resolves to the destination path on success.
 */
function download(url, destFile, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl, hops = 0) => {
      https.get(currentUrl, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 4) {
          res.resume();
          return attempt(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed (${res.statusCode}) for ${currentUrl}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        let lastPct = -1;
        const out = fs.createWriteStream(destFile);
        res.on('data', chunk => {
          received += chunk.length;
          if (total > 0 && onProgress) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(pct, received, total); }
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destFile)));
        out.on('error', reject);
      }).on('error', reject);
    };
    attempt(url);
  });
}

/** Extract tar.gz (POSIX) or zip (Windows) into a directory. */
function extractArchive(archivePath, targetDir, ext) {
  fs.mkdirSync(targetDir, { recursive: true });
  if (ext === 'tar.gz') {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', targetDir], {
      stdio: 'ignore', timeout: 120000,
    });
    if (r.status !== 0) throw new Error(`tar extract failed (status=${r.status})`);
  } else if (ext === 'zip') {
    // PowerShell Expand-Archive avoids adding a Node.js zip library dep.
    const cmd = `Expand-Archive -Path "${archivePath}" -DestinationPath "${targetDir}" -Force`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
      stdio: 'ignore', timeout: 180000, windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`Expand-Archive failed (status=${r.status})`);
  } else {
    throw new Error(`Unknown archive ext: ${ext}`);
  }
}

/**
 * Fetch + extract the pinned Node LTS into `~/.dsh/runtime/node/<version>/`.
 *
 * We extract under `.staging/` first, then rename the inner dist directory
 * to its final name so a partial install can never look complete.
 */
async function downloadAndExtractNode(version, { onProgress } = {}) {
  const { url, dirName, ext } = nodeDistUrl(version);
  const root = bundledNodeRoot();
  const staging = path.join(root, `.staging-${process.pid}-${Date.now()}`);
  const finalDir = bundledNodeDir(version);
  const archive = path.join(root, `.download-${process.pid}-${Date.now()}.${ext}`);

  fs.mkdirSync(root, { recursive: true });

  // Best-effort cleanup of any stale staging left behind by a killed run.
  try {
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith('.staging-') || entry.startsWith('.download-')) {
        try { fs.rmSync(path.join(root, entry), { recursive: true, force: true }); }
        catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  log(`bundled node: downloading ${url}`);
  onProgress?.({ phase: 'downloading', pct: 0 });
  await download(url, archive, (pct) => {
    onProgress?.({ phase: 'downloading', pct });
  });

  log(`bundled node: extracting to ${staging}`);
  onProgress?.({ phase: 'extracting', pct: 0 });
  try {
    extractArchive(archive, staging, ext);
  } finally {
    try { fs.unlinkSync(archive); } catch { /* ignore */ }
  }

  // The archive extracts to `<staging>/<dirName>/`. Move it into place atomically.
  const extractedInner = path.join(staging, dirName);
  if (!fs.existsSync(extractedInner)) {
    throw new Error(`extract produced no ${dirName} directory`);
  }
  try {
    // If a broken previous install exists, remove it first.
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.renameSync(extractedInner, finalDir);
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const v = probeNodeVersion(bundledNodeBin(version));
  if (v !== version) {
    throw new Error(`bundled node self-check failed (expected ${version}, got ${v})`);
  }

  // Write a marker so callers can display "bundled" mode without another probe.
  writeTextAtomic(path.join(root, 'STATE.json'), JSON.stringify({
    version, installedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  onProgress?.({ phase: 'done', pct: 100 });
  log(`bundled node ${version} ready at ${finalDir}`);
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Ensure a compatible Node runtime is available and return descriptors for it.
 *
 * @param {(evt: {phase: string, pct?: number, version?: string, mode?: string}) => void} [onProgress]
 * @returns {Promise<{
 *   mode: 'system' | 'bundled',
 *   nodePath: string,
 *   npxPath: string,
 *   npmPath: string,
 *   version: string,
 *   pnpmPath: string | null,
 * }>}
 */
async function ensureRuntime({ onProgress } = {}) {
  onProgress?.({ phase: 'detecting-system' });

  const sys = detectSystemNode();
  if (sys) {
    const peers = peerBins(sys.path);
    const pnpmPath = detectSystemPnpm();
    onProgress?.({ phase: 'system-found', version: sys.version, mode: 'system' });
    return {
      mode: 'system',
      nodePath: sys.path,
      npxPath: peers.npx,
      npmPath: peers.npm,
      version: sys.version,
      pnpmPath,
    };
  }

  // No compatible system Node → bundled runtime.
  if (isBundledNodeReady(NODE_LTS)) {
    onProgress?.({ phase: 'bundled-ready', version: NODE_LTS, mode: 'bundled' });
  } else {
    onProgress?.({ phase: 'bundled-preparing', version: NODE_LTS });
    await downloadAndExtractNode(NODE_LTS, { onProgress });
  }

  const pnpmPath = detectSystemPnpm();
  return {
    mode: 'bundled',
    nodePath: bundledNodeBin(NODE_LTS),
    npxPath: bundledNpxBin(NODE_LTS),
    npmPath: bundledNpmBin(NODE_LTS),
    version: NODE_LTS,
    pnpmPath,
  };
}

module.exports = {
  NODE_LTS,
  MIN_NODE_MAJOR,
  runtimeRoot,
  bundledNodeRoot,
  bundledNodeDir,
  bundledNodeBin,
  bundledNpxBin,
  bundledNpmBin,
  detectSystemNode,
  detectSystemPnpm,
  isBundledNodeReady,
  ensureRuntime,
};
