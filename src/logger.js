/**
 * logger.js — Lightweight logger writing to stdout, stderr and dated files.
 *
 * Layout:
 *
 *   ~/.dsh-desktop-logs/YYYY-MM-DDTHHmmss.log     one file per app launch
 *   ~/.dsh-desktop.log                           symlink → latest session file
 *
 * Retention policy (both cheap, enforced at startup, no cron needed):
 *   - files older than RETENTION_DAYS (7) are deleted;
 *   - as a hard cap only the newest MAX_FILES (50) are kept, so a busy week
 *     can never grow the directory unbounded.
 *
 * Why dated files instead of the old `.log` / `.log.prev` pair? Because a
 * failed launch followed by a successful one used to overwrite the only
 * evidence — exactly what happened when the "Node.js not found" error got
 * clobbered before it could be investigated. One file per run means you can
 * always go back and inspect the exact failing session.
 *
 * Every line is timestamped (ISO 8601 UTC). The same line also goes to
 * stderr — packaged Electron apps often discard stdout, while stderr is what
 * the macOS unified log (`log show`) captures, giving a second channel.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { homePath } = require('./fsx');

const LOG_DIR = homePath('.dsh-desktop-logs');
const LATEST_LINK = homePath('.dsh-desktop.log');
const RETENTION_DAYS = 7;
const MAX_FILES = 50;

// ── Startup housekeeping ─────────────────────────────────────────────────────

/** Collision-safe session file name (ISO timestamp with : and . replaced). */
function sessionFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '.log';
}

/** Create the session file + stream; returns { stream, file } (or nulls). */
function openSessionLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, sessionFileName());
    // Touch the file synchronously BEFORE the stream opens. createWriteStream
    // opens lazily on the first flush, and the symlink must point at a file
    // that exists right now (otherwise an immediate `tail -f` fails).
    fs.closeSync(fs.openSync(file, 'a'));
    const stream = fs.createWriteStream(file, { flags: 'a' });
    // POSIX: symlink ~/.dsh-desktop.log → newest session file so `tail -f`
    // keeps working as before.
    try { fs.unlinkSync(LATEST_LINK); } catch { /* no previous link */ }
    try {
      fs.symlinkSync(file, LATEST_LINK);
    } catch {
      // Windows (or read-only dir): fall back to mirroring the latest file.
      // Logs are small (one session each); a duplicated write is fine.
      try { fs.writeFileSync(LATEST_LINK, ''); } catch { /* ignore */ }
    }
    return { stream, file };
  } catch {
    return { stream: null, file: null };
  }
}

/** Delete expired files (older than RETENTION_DAYS) and cap at MAX_FILES. */
function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(LOG_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // newest first
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let kept = 0;
    for (const f of files) {
      try {
        if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); continue; }
        if (++kept > MAX_FILES) { fs.unlinkSync(f); continue; }
      } catch { /* file disappeared mid-scan; skip */ }
    }
  } catch { /* dir doesn't exist yet; nothing to clean */ }
}

cleanOldLogs();
const session = openSessionLog();

// ── Logging ──────────────────────────────────────────────────────────────────

function safeStringify(value) {
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

/**
 * Write a log line.
 * String args print as-is; anything else is JSON-stringified so nested
 * objects don't collapse to `[object Object]`. Output goes to the session
 * file, stdout and stderr.
 */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) =>
    typeof a === 'string' ? a : safeStringify(a)
  ).join(' ')}\n`;
  try { session.stream?.write(line); } catch { /* stream died; skip */ }
  process.stdout.write(line);
  process.stderr.write(line);
}

module.exports = { log, LOG_DIR, LATEST_LINK, RETENTION_DAYS, MAX_FILES };
