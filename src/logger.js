/**
 * logger.js — Lightweight logger writing to stdout and `~/.dsh-desktop.log`.
 *
 * On startup we **rotate once**: any existing log becomes `.log.prev`, then a
 * fresh `.log` is opened for the new session. That gives us exactly two files
 * — current run and the previous one — so a crash on launch never destroys
 * evidence of what happened last time. We deliberately don't keep a longer
 * chain: the log is meant for the last-mile "what went wrong now" question,
 * not long-term telemetry.
 *
 * Every line is timestamped (ISO 8601 UTC). Non-string args go through
 * `JSON.stringify` for readable nested structures.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { homePath } = require('./fsx');

const LOG_FILE = homePath('.dsh-desktop.log');
const PREV_LOG_FILE = homePath('.dsh-desktop.log.prev');

function rotateOnStart() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      // Rename is atomic on POSIX; on Windows it fails if PREV is open — fall
      // back to unlink + rename, and if even that fails, silently truncate.
      try { fs.unlinkSync(PREV_LOG_FILE); } catch { /* prev may not exist */ }
      try { fs.renameSync(LOG_FILE, PREV_LOG_FILE); }
      catch { fs.writeFileSync(LOG_FILE, ''); }
    }
  } catch { /* rotation is best-effort; never block startup */ }
}

rotateOnStart();

let stream = null;
try { stream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); }
catch { /* file may be unwritable; console still gets output */ }

/**
 * Write a log line.
 * String args are printed as-is; everything else is JSON-stringified so nested
 * objects don't collapse to `[object Object]`.
 */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : safeStringify(a)
  ).join(' ')}\n`;
  try { stream?.write(line); } catch { /* stream died; skip */ }
  process.stdout.write(line);
}

function safeStringify(value) {
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

module.exports = { log, LOG_FILE, PREV_LOG_FILE };
