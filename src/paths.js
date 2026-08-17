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

/** node executable candidates, in preference order. */
function nodeBinCandidates() {
  const home = homePath();
  return isWin
    ? [`${home}\\.hermes\\node\\node.exe`, `${home}\\AppData\\Roaming\\npm\\node.exe`, 'node.exe']
    : [`${home}/.hermes/node/bin/node`, '/usr/local/bin/node', '/opt/homebrew/bin/node', 'node'];
}

/** npx executable candidates. */
function npxBinCandidates() {
  const home = homePath();
  return isWin
    ? [`${home}\\.hermes\\node\\npx.cmd`, `${home}\\AppData\\Roaming\\npm\\npx.cmd`, 'npx.cmd']
    : [`${home}/.hermes/node/bin/npx`, '/usr/local/bin/npx', '/opt/homebrew/bin/npx', 'npx'];
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
 * @returns {string|null} absolute path, or `null` if not cached yet.
 */
function dshEntryPath() {
  try {
    const cacheDir = homePath('.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return null;
    for (const d of fs.readdirSync(cacheDir)) {
      const bin = path.join(cacheDir, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(bin)) return bin;
    }
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
};
