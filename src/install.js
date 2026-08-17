/**
 * install.js — @deepseek-ai/dsh 的安装检测与安装
 *
 * 用 ~/.dsh-desktop.installed marker 文件 + npx 缓存路径检查，
 * 避免每次启动都跑 `npx --version`（约 8s）。已安装时检测 < 5ms。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { npxBin } = require('./paths');
const { buildEnv } = require('./dsh');
const { log } = require('./logger');

const MARKER_FILE = path.join(os.homedir(), '.dsh-desktop.installed');

/**
 * 快速检查：marker 文件存在 + npx 缓存里有 @deepseek-ai/dsh 包。
 * 两步都是 FS 检查，几毫秒完成。
 */
function isDshReady() {
  if (!fs.existsSync(MARKER_FILE)) return false;
  try {
    const cacheDir = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return false;
    for (const d of fs.readdirSync(cacheDir)) {
      if (fs.existsSync(path.join(cacheDir, d, 'node_modules', '@deepseek-ai', 'dsh'))) {
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/** 写 marker 文件，标记 dsh 已安装 */
function markInstalled() {
  try { fs.writeFileSync(MARKER_FILE, new Date().toISOString()); } catch {}
}

/**
 * 确保 dsh 已安装。
 * - 已安装（marker + 缓存都在）→ 立即返回，不 spawn 任何进程
 * - 没装 → `npx --yes @deepseek-ai/dsh --version` 拉取安装，成功后写 marker
 */
function ensureInstalled() {
  return new Promise((resolve, reject) => {
    if (isDshReady()) {
      log('dsh already installed (marker + cache)');
      return resolve();
    }
    log('dsh not installed, running npx --yes @deepseek-ai/dsh --version…');
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
