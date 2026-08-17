/**
 * install.js — Detect and install @deepseek-ai/dsh.
 *
 * We avoid running `npx --version` on every launch (~8s) by using a marker
 * file + a fast FS check for the presence of dsh in the npx cache. When both
 * pass, this whole module returns in <5ms.
 */

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { npxBin } = require('./paths');
const { buildEnv } = require('./dsh');
const { homePath, writeTextAtomic } = require('./fsx');
const { log } = require('./logger');

const MARKER_FILE = homePath('.dsh-desktop.installed');

/**
 * Fast liveness: marker + at least one npx cache entry that contains dsh.
 * Both branches are FS-only, milliseconds at most.
 */
function isDshReady() {
  if (!fs.existsSync(MARKER_FILE)) return false;
  try {
    const cacheDir = homePath('.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return false;
    for (const d of fs.readdirSync(cacheDir)) {
      const candidate = `${cacheDir}/${d}/node_modules/@deepseek-ai/dsh`;
      if (fs.existsSync(candidate)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** Write the marker (atomic; failures are logged, not fatal). */
function markInstalled() {
  if (!writeTextAtomic(MARKER_FILE, new Date().toISOString())) {
    log('install: marker write failed (non-fatal)');
  }
}

/**
 * Ensure dsh is installed.
 *   - fast path (marker + cache hit): resolve immediately, no subprocess
 *   - slow path (missing): `npx --yes @deepseek-ai/dsh --version` to trigger
 *     the npm install into the local npx cache, then write the marker
 */
function ensureInstalled() {
  return new Promise((resolve, reject) => {
    if (isDshReady()) {
      log('dsh already installed (marker + cache)');
      return resolve();
    }
    log('dsh not installed, running `npx --yes @deepseek-ai/dsh --version`…');
    const proc = spawn(npxBin(), ['--yes', '@deepseek-ai/dsh', '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildEnv(),
      shell: false,
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) { markInstalled(); log('dsh installed ✓'); resolve(); }
      else reject(new Error(`Install failed (exit ${code}): ${stderr.slice(-300)}`));
    });
    proc.on('error', err => reject(new Error(`Failed to run npx: ${err.message}`)));
  });
}

module.exports = { ensureInstalled, isDshReady, MARKER_FILE };
