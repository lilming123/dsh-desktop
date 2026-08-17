/**
 * paths.js — 平台无关的运行时路径解析
 *
 * Electron app bundle 启动时 PATH 常被精简，node/npx 可能找不到。
 * 本模块负责在 macOS / Windows 上定位 node、npx、以及缓存好的 dsh
 * 入口（bin.js），让 spawn 不依赖系统 shell 的 PATH。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

/** 候选的 node 可执行路径，按优先级排列 */
function nodeBinCandidates() {
  const home = os.homedir();
  const user = os.userInfo().username;
  const out = [];
  if (isWin) {
    out.push(
      `${home}\\.hermes\\node\\node.exe`,
      `${home}\\AppData\\Roaming\\npm\\node.exe`,
      'node.exe',
    );
  } else {
    out.push(
      `/Users/${user}/.hermes/node/bin/node`,
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      'node',
    );
  }
  return out;
}

/** 候选的 npx 可执行路径 */
function npxBinCandidates() {
  const home = os.homedir();
  const user = os.userInfo().username;
  const out = [];
  if (isWin) {
    out.push(
      `${home}\\.hermes\\node\\npx.cmd`,
      `${home}\\AppData\\Roaming\\npm\\npx.cmd`,
      'npx.cmd',
    );
  } else {
    out.push(
      `/Users/${user}/.hermes/node/bin/npx`,
      '/usr/local/bin/npx',
      '/opt/homebrew/bin/npx',
      'npx',
    );
  }
  return out;
}

/** 在候选列表里找第一个存在的可执行文件 */
function resolveBin(candidates) {
  for (const c of candidates) {
    try {
      // 裸命令名（'node' / 'npx'）直接信任，让系统 PATH 解析
      if (!c.includes(path.sep) && !c.includes('/') && !(isWin && c.includes('\\'))) return c;
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return candidates[candidates.length - 1]; // fallback 到最后一个裸命令名
}

/** 定位 node 可执行文件 */
function nodeBin() {
  return resolveBin(nodeBinCandidates());
}

/** 定位 npx 可执行文件 */
function npxBin() {
  return resolveBin(npxBinCandidates());
}

/**
 * 定位 npx 缓存里的 dsh 入口（lib/bin.js）。
 * 直接用 node 跑这个文件，比 `npx exec` 快约 8 倍（1.5s vs 12s）。
 * @returns {string|null} bin.js 绝对路径，找不到返回 null
 */
function dshEntryPath() {
  try {
    const cacheDir = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return null;
    for (const d of fs.readdirSync(cacheDir)) {
      const bin = path.join(cacheDir, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(bin)) return bin;
    }
  } catch { /* ignore */ }
  return null;
}

module.exports = { nodeBin, npxBin, dshEntryPath, isWin };
