/**
 * setup.js — 启动校验流程编排
 *
 * 四步顺序执行，每步都向启动页报告进度。
 * 所有文案走 i18n，支持中英文切换。
 */

const { execSync } = require('child_process');
const { nodeBin } = require('./paths');
const { ensureInstalled } = require('./install');
const { ensureDsh } = require('./dsh');
const { log } = require('./logger');
const { t } = require('./i18n');

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
 * @param {function} openMain        打开主窗口的回调，接收 dsh 端口参数
 */
async function runSetup(splashWin, openMain) {
  // Step 1: Node.js — 读 version，瞬间完成
  progress(splashWin, 'node', 'active', { label: t('steps.node.checking'), pct: 10 });
  try {
    const ver = execSync(`"${nodeBin()}" --version`, { encoding: 'utf8', timeout: 3000 }).trim();
    progress(splashWin, 'node', 'done', { msg: `Node ${ver}`, pct: 20 });
  } catch (e) {
    progress(splashWin, 'node', 'error', { msg: t('steps.node.notFound') });
    throw e;
  }

  // Step 2: dsh 安装检查 — 已装秒过，未装才走 npx
  progress(splashWin, 'install', 'active', { label: t('steps.install.checking'), pct: 25 });
  await ensureInstalled();
  progress(splashWin, 'install', 'done', { label: t('steps.install.ready'), pct: 40 });

  // Step 3: 启动/复用 dsh 服务（动态端口）
  progress(splashWin, 'start', 'active', { label: t('steps.start.starting'), pct: 50 });
  let result;
  try {
    result = await ensureDsh(stdout => {
      progress(splashWin, 'start', 'active', { msg: stdout.slice(0, 80), pct: 60 });
    });
  } catch (e) {
    const msg = e.message.includes('No free port')
      ? t('steps.start.noFreePort')
      : t('steps.start.portInUse', { port: 3080 });
    progress(splashWin, 'start', 'error', { msg });
    throw e;
  }
  progress(splashWin, 'start', 'done', {
    label: result.mode === 'reused'
      ? t('steps.start.reused', { port: result.port })
      : t('steps.start.ready', { port: result.port }),
    pct: 90,
  });

  // Step 4: 打开主窗口
  progress(splashWin, 'ready', 'done', { label: t('steps.ready.opening'), pct: 100 });
  openMain(result.port);
}

module.exports = { runSetup, progress };
