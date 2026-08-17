/**
 * logger.js — 轻量日志器，同时输出到 stdout 和 ~/.dsh-desktop.log
 *
 * 每条日志带 ISO 时间戳，方便排查启动卡顿问题。
 * 日志文件每次启动覆盖（'w' 模式），避免无限增长。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_FILE = path.join(os.homedir(), '.dsh-desktop.log');

let stream = null;
try {
  stream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
} catch { /* 日志写不了就跳过，不影响主流程 */ }

/**
 * 写一条日志。
 * 对象参数会 JSON.stringify，方便看嵌套结构。
 */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}\n`;
  try { stream?.write(line); } catch {}
  process.stdout.write(line);
}

module.exports = { log, LOG_FILE };
