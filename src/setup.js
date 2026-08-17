/**
 * setup.js — 启动校验流程编排
 *
 * 四步顺序执行，每步都向启动页报告进度：
 *   1. Node.js 环境检查（读 version，< 5ms）
 *   2. dsh 安装检查（marker + FS，已装时 < 5ms；未装才走 npx 安装）
 *   3. 启动/复用 dsh 服务（已在跑就秒开，否则启动并轮询就绪）
 *   4. 打开主窗口
 *
 * 设计原则：已安装/已运行的情况下，整个 setup 走完 < 200ms。
 */

const { execSync } = require('child_process');
const { nodeBin } = require('./paths');
const { ensureInstalled } = require('./install');
const { ensureDsh } = require('./dsh');
const { log } = require('./logger');

/**
 * 向启动页发送进度事件。
 * @param {BrowserWindow} win
 * @param {string} step    'node' | 'install' | 'start' | 'ready'
 * @param {string} state   'active' | 'done' | 'error'
 * @param {object} opts     { label, msg, pct }
 */
function progress(win, step, state, opts = {}) {
  log(`progress: ${step}=${state}`, opts);
  win?.webContents?.send('progress', { step, state, ...opts });
}

/**
 * 运行完整启动校验。
 * @param {BrowserWindow} splashWin  启动页窗口
 * @param {function} openMain        打开主窗口的回调
 */
async function runSetup(splashWin, openMain) {
  // Step 1: Node.js — 读 version，瞬间完成
  progress(splashWin, 'node', 'active', { label: 'Checking environment…', pct: 10 });
  try {
    const ver = execSync(`"${nodeBin()}" --version`, { encoding: 'utf8', timeout: 3000 }).trim();
    progress(splashWin, 'node', 'done', { msg: `Node ${ver}`, pct: 20 });
  } catch (e) {
    progress(splashWin, 'node', 'error', { msg: 'Node.js not found. Install from nodejs.org then restart.' });
    throw e;
  }

  // Step 2: dsh 安装检查 — 已装秒过，未装才走 npx
  progress(splashWin, 'install', 'active', { label: 'Checking @deepseek-ai/dsh…', pct: 25 });
  await ensureInstalled();
  progress(splashWin, 'install', 'done', { label: '@deepseek-ai/dsh  ✓', pct: 40 });

  // Step 3: 启动/复用 dsh 服务
  progress(splashWin, 'start', 'active', { label: 'Starting server…', pct: 50 });
  let result;
  try {
    result = await ensureDsh(stdout => {
      progress(splashWin, 'start', 'active', { msg: stdout.slice(0, 80), pct: 60 });
    });
  } catch (e) {
    // 端口被别的程序占用 / dsh 启动失败
    progress(splashWin, 'start', 'error', { msg: e.message });
    throw e;
  }
  progress(splashWin, 'start', 'done', { label: result === 'reused' ? 'Server already running ✓' : 'Server ready ✓', pct: 90 });

  // Step 4: 打开主窗口
  progress(splashWin, 'ready', 'done', { label: 'Opening UI', pct: 100 });
  openMain();
}

module.exports = { runSetup, progress };
