/**
 * fsx.js — Small filesystem helpers shared across the app.
 *
 * The main-process code writes several JSON/text files:
 *   - `~/.dsh/dsh-api-companion.json`  (read by the dsh-api plugin)
 *   - `~/.dsh-desktop.installed`       (marker file)
 *   - `~/.dsh-desktop.lang`            (pre-boot language memory)
 *
 * Two properties matter:
 *
 *   1. **Atomicity.** The plugin can read the companion discovery file at any
 *      moment; a torn read (open() between our truncate and full write) would
 *      look like corruption. We write to `<path>.tmp` then rename — rename on
 *      the same filesystem is atomic on POSIX and best-effort on Windows.
 *
 *   2. **Silent best-effort reads.** Missing / unreadable files return the
 *      caller-provided fallback; parse errors do the same. Nothing here ever
 *      throws — callers get a defined value or the fallback.
 *
 * If a helper here is not obviously helpful, don't add it. Keep the surface
 * small so the rest of the codebase doesn't accrete another mini-library.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Atomically write UTF-8 text.
 * Writes to `<file>.tmp` in the same directory, then renames.
 * Returns `true` on success, `false` on any error (nothing is thrown).
 */
function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    return false;
  }
}

/** Atomically write a JSON value (pretty-printed). Returns `true` on success. */
function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/** Read UTF-8 text; return `fallback` if the file is missing or unreadable. */
function readTextSafe(file, fallback = null) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return fallback; }
}

/** Read JSON; return `fallback` if the file is missing or invalid JSON. */
function readJsonSafe(file, fallback = null) {
  const text = readTextSafe(file, null);
  if (text === null) return fallback;
  try { return JSON.parse(text); }
  catch { return fallback; }
}

/** Unlink without throwing. Returns `true` if the file is gone afterwards. */
function unlinkSafe(file) {
  try { fs.unlinkSync(file); return true; }
  catch (e) { return e && e.code === 'ENOENT'; }
}

/**
 * Home-relative path shorthand — mainly used by tests / paths.js so callers
 * don't need to import `os` just to build `~/foo`.
 */
function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

module.exports = {
  writeTextAtomic,
  writeJsonAtomic,
  readTextSafe,
  readJsonSafe,
  unlinkSafe,
  homePath,
};
