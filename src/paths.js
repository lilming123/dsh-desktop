/**
 * paths.js — Cross-platform runtime path resolution.
 *
 * Electron app bundles start with a stripped PATH, so `node` / `npx` need to
 * be located explicitly. This module also owns every location the app writes
 * under `$DSH_HOME`: the `dsh-api` plugin install directory, the loader patch
 * file, and the companion discovery file the plugin uses to find us.
 *
 * The exported functions are pure — they compute paths, they don't create
 * anything. Callers do the mkdirp when they actually write.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { homePath } = require('./fsx');

const isWin = process.platform === 'win32';

/** dsh HOME (env `DSH_HOME` overrides, default `~/.dsh`). */
function dshHome() {
  return process.env.DSH_HOME || homePath('.dsh');
}

/** dsh web profile directory used when the desktop app spawns dsh. */
function dshProfileDir() {
  return path.join(dshHome(), 'profiles', 'web');
}

/** Where the bundled `dsh-api` plugin file is copied to inside the profile. */
function apiPluginDir() {
  return path.join(dshProfileDir(), 'dsh-api');
}

/** The `--patch` overlay file that inserts the plugin into the loader graph. */
function apiPluginPatchFile() {
  return path.join(dshProfileDir(), 'dsh-api.patch.yml');
}

/**
 * Companion discovery file. The desktop process writes it after starting the
 * companion HTTP service; the plugin reads it to proxy companion-only routes.
 */
function companionInfoFile() {
  return path.join(dshHome(), 'dsh-api-companion.json');
}

/** Bundled plugin source (dev: repo dir; production: inside `app.asar`). */
function bundledPluginFile() {
  return path.join(__dirname, '..', 'dsh-plugin', 'index.mjs');
}

/** Bundled patch template (installed alongside the plugin every launch). */
function bundledPluginPatchFile() {
  return path.join(__dirname, '..', 'dsh-plugin', 'patch.yml');
}

/**
 * Root of the bundled Node runtime that `runtime.js` may install into.
 * The desktop app never modifies system PATH — a bundled Node lives here
 * and is only used inside spawned child processes.
 */
function bundledRuntimeNodeRoot() {
  return path.join(dshHome(), 'runtime', 'node');
}

/**
 * Enumerate `<runtime>/node/<version>/{bin/node|node.exe}` for every version
 * present, newest-first (best-effort semver-ish sort). Used as the highest-
 * priority candidate so a freshly-provisioned runtime wins immediately.
 */
function bundledRuntimeBins(kind /* 'node' | 'npx' | 'npm' */) {
  const root = bundledRuntimeNodeRoot();
  let versions = [];
  try {
    versions = fs.readdirSync(root).filter(n => /^\d+\.\d+\.\d+$/.test(n));
  } catch { return []; }
  versions.sort((a, b) => {
    const A = a.split('.').map(Number), B = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return B[i] - A[i];
    return 0;
  });
  return versions.map(v => {
    if (isWin) {
      return path.join(root, v, kind === 'node' ? 'node.exe' : `${kind}.cmd`);
    }
    return path.join(root, v, 'bin', kind);
  });
}

/** node executable candidates, in preference order (bundled first). */
function nodeBinCandidates() {
  const home = homePath();
  const bundled = bundledRuntimeBins('node');
  return isWin
    ? [...bundled, `${home}\\.hermes\\node\\node.exe`, `${home}\\AppData\\Roaming\\npm\\node.exe`, 'node.exe']
    : [...bundled, `${home}/.hermes/node/bin/node`, '/usr/local/bin/node', '/opt/homebrew/bin/node', 'node'];
}

/** npx executable candidates. */
function npxBinCandidates() {
  const home = homePath();
  const bundled = bundledRuntimeBins('npx');
  return isWin
    ? [...bundled, `${home}\\.hermes\\node\\npx.cmd`, `${home}\\AppData\\Roaming\\npm\\npx.cmd`, 'npx.cmd']
    : [...bundled, `${home}/.hermes/node/bin/npx`, '/usr/local/bin/npx', '/opt/homebrew/bin/npx', 'npx'];
}

/**
 * First existing candidate; falls back to the last (a bare command name that
 * we trust the runtime PATH to resolve). This keeps the app usable even when
 * none of the well-known install prefixes are present.
 */
function resolveBin(candidates) {
  for (const c of candidates) {
    // Bare command names (no separator) are trusted to the system PATH.
    const bare = !c.includes(path.sep) && !c.includes('/') && !(isWin && c.includes('\\'));
    if (bare) return c;
    try { if (fs.existsSync(c)) return c; } catch { /* ignore stat errors */ }
  }
  return candidates[candidates.length - 1];
}

function nodeBin() { return resolveBin(nodeBinCandidates()); }
function npxBin()  { return resolveBin(npxBinCandidates()); }

/**
 * Locate the cached `@deepseek-ai/dsh` entry (`lib/bin.js`) inside
 * `~/.npm/_npx`. Running it directly with node is ~8× faster than `npx exec`.
 *
 * When multiple cache entries exist, prefer the one with the highest
 * `package.json` version — that's how a background upstream prefetch
 * takes effect on the next launch without a desktop-app upgrade.
 *
 * @returns {string|null} absolute path, or `null` if not cached yet.
 */
function dshEntryPath() {
  try {
    const cacheDir = homePath('.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return null;
    const hits = [];
    for (const d of fs.readdirSync(cacheDir)) {
      const pkgDir = path.join(cacheDir, d, 'node_modules', '@deepseek-ai', 'dsh');
      const bin = path.join(pkgDir, 'lib', 'bin.js');
      if (!fs.existsSync(bin)) continue;
      let version = '0.0.0';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        if (typeof pkg.version === 'string') version = pkg.version;
      } catch { /* keep default */ }
      hits.push({ bin, version });
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => {
      const A = a.version.split('.').map(Number);
      const B = b.version.split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (B[i] || 0) - (A[i] || 0);
      return 0;
    });
    return hits[0].bin;
  } catch { /* ignore */ }
  return null;
}

module.exports = {
  isWin,
  nodeBin, npxBin, dshEntryPath,
  dshHome, dshProfileDir,
  apiPluginDir, apiPluginPatchFile,
  companionInfoFile,
  bundledPluginFile, bundledPluginPatchFile,
  bundledRuntimeNodeRoot,
};
