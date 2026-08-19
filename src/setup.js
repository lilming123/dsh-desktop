/**
 * setup.js — 启动校验流程编排
 *
 * 四步顺序执行，每步都向启动页报告进度。所有文案走 i18n，支持中英文切换。
 *
 * Step 1 (Runtime) 已从"仅 `node --version`"扩展为完整的运行时装配：
 *   - 探测本机 Node ≥ 20 LTS：命中即复用，不改动任何系统环境。
 *   - 未命中则下载 pinned Node LTS 到 `~/.dsh/runtime/node/<ver>/`，
 *     进度实时映射到启动页进度条。
 *   - 若本机存在 pnpm 则记下路径供子进程 env.PATH 使用，不主动安装。
 *
 * Step 3 之后（主窗口已由 main.js 打开）由 main.js 自行调度 upstream 静默升级
 * 检查——本文件不做该工作，避免阻塞用户可见的启动进度。
 */

'use strict';

const { ensureInstalled } = require('./install');
const {
  ensureDsh, installApiPlugin, installApiPluginFromGitHub,
  detectInstalledApiPlugin, setRuntime,
} = require('./dsh');
const { ensureRuntime } = require('./runtime');
const { log } = require('./logger');
const { t } = require('./i18n');

/**
 * 向启动页发送进度事件。
 * @param {BrowserWindow} win
 * @param {string} step    'node' | 'install' | 'start' | 'ready'
 * @param {string} state   'active' | 'done' | 'error'
 * @param {object} opts    { label, msg, pct }
 */
function progress(win, step, state, opts = {}) {
  log(`progress: ${step}=${state}`, opts);
  win?.webContents?.send('progress', { step, state, ...opts });
}

/**
 * 把 runtime.ensureRuntime 的 phase 事件翻译成一条启动页 progress。
 * Step 1 占据进度条 0–20%；下载阶段线性映射到 4–18%。
 */
function mapRuntimeProgress(splashWin, evt) {
  const { phase, pct, version, mode } = evt || {};
  switch (phase) {
    case 'detecting-system':
      progress(splashWin, 'node', 'active', { label: t('steps.node.checking'), pct: 4 });
      return;
    case 'system-found':
      progress(splashWin, 'node', 'done', {
        msg: t('steps.node.systemFound', { version }), pct: 20,
      });
      return;
    case 'bundled-ready':
      progress(splashWin, 'node', 'done', {
        msg: t('steps.node.bundledReady', { version }), pct: 20,
      });
      return;
    case 'bundled-preparing':
      progress(splashWin, 'node', 'active', {
        label: t('steps.node.bundling', { version }), pct: 6,
      });
      return;
    case 'downloading':
      // Map registry download 0–100% → splash 6–17%.
      progress(splashWin, 'node', 'active', {
        label: t('steps.node.downloading', { pct: pct || 0 }),
        pct: 6 + Math.floor((pct || 0) * 0.11),
      });
      return;
    case 'extracting':
      progress(splashWin, 'node', 'active', { label: t('steps.node.extracting'), pct: 18 });
      return;
    case 'done':
      // Final "done" event; the corresponding "done" progress is emitted by
      // the caller once ensureRuntime resolves and we know the resolved mode.
      return;
    default:
      log('runtime: unhandled progress phase', phase);
  }
}

/**
 * 运行完整启动校验。
 * @param {BrowserWindow} splashWin  启动页窗口
 * @param {function} openMain        打开主窗口的回调，接收 dsh 端口参数
 */
async function runSetup(splashWin, openMain) {
  // Step 1: Runtime — 探测系统 Node 或装配内置 Node LTS
  progress(splashWin, 'node', 'active', { label: t('steps.node.checking'), pct: 4 });

  let rt;
  try {
    rt = await ensureRuntime({
      onProgress: (evt) => mapRuntimeProgress(splashWin, evt),
    });
  } catch (e) {
    progress(splashWin, 'node', 'error', { msg: t('steps.node.provisionFailed') + ' — ' + (e && e.message) });
    throw e;
  }

  // 把 resolvedRuntime 交给 dsh.js，供 install.js / dsh.js 一致使用。
  setRuntime(rt);

  const readyMsg = rt.mode === 'system'
    ? t('steps.node.systemFound', { version: rt.version })
    : t('steps.node.bundledReady', { version: rt.version });
  progress(splashWin, 'node', 'done', { msg: readyMsg, pct: 20 });

  // Step 2: dsh 安装检查 — 已装秒过，未装才走 npx
  progress(splashWin, 'install', 'active', { label: t('steps.install.checking'), pct: 25 });
  await ensureInstalled();
  progress(splashWin, 'install', 'done', { label: t('steps.install.ready'), pct: 40 });

  // Step 3: dsh-api 插件 — 优先"标准安装"（github via `dsh plugin add`），
  // 装不上再回退到 bundled 副本 + --patch。三种可能路径：
  //   A. 已装 → 立即 done
  //   B. 未装但网络 OK → 从 GitHub 自动装
  //   C. 未装且网络失败 / 装出错 → 静默降级 bundled + --patch，pipeline 继续
  await ensureApiPlugin(splashWin);

  // Step 4: 启动/复用 dsh 服务（动态端口）
  progress(splashWin, 'start', 'active', { label: t('steps.start.starting'), pct: 60 });

  let result;
  try {
    result = await ensureDsh(stdout => {
      progress(splashWin, 'start', 'active', { msg: stdout.slice(0, 80), pct: 70 });
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

  // Step 5: 打开主窗口
  progress(splashWin, 'ready', 'done', { label: t('steps.ready.opening'), pct: 100 });
  openMain(result.port);
}

/**
 * Ensure `dsh-api` is loadable by the next dsh spawn — either as an
 * npm-installed profile bundle (preferred), or as the desktop-shipped
 * fallback copy. Renders the outcome as a single splash step.
 *
 * We never fail the pipeline here: if the network install fails, we
 * silently fall back to the bundled copy so the app still boots.
 * Only if BOTH paths fail (bundled source unreadable, network down) do
 * we surface it as a step error — and even then the caller may decide
 * to continue without the plugin.
 */
async function ensureApiPlugin(splashWin) {
  // A. Already installed → nothing to do.
  if (detectInstalledApiPlugin()) {
    progress(splashWin, 'plugin', 'done', {
      label: t('steps.plugin.installed'), pct: 55,
    });
    // Purge any stale bundled fallback in one place, but from setup.js we
    // don't have direct access — the next installApiPlugin() call inside
    // ensureDsh() will do it (its detect branch already calls the cleaner).
    // Instead call installApiPlugin() ONCE here to enforce the invariant:
    installApiPlugin();
    return;
  }

  // B. Try the standard install path (network required). This is what the
  //    user would do manually with `dsh plugin --profile web add …`; doing
  //    it automatically at first launch removes the manual step entirely.
  progress(splashWin, 'plugin', 'active', {
    label: t('steps.plugin.installingFromGithub'), pct: 45,
  });
  const r = await installApiPluginFromGitHub({
    onStdout: (chunk) => {
      const line = chunk.split('\n').map(s => s.trim()).filter(Boolean).slice(-1)[0];
      if (line) progress(splashWin, 'plugin', 'active', { msg: line.slice(0, 80), pct: 50 });
    },
  });
  if (r.ok) {
    progress(splashWin, 'plugin', 'done', {
      label: t('steps.plugin.installedFromGithub'), pct: 55,
    });
    return;
  }

  // C. Network / registry / git failure → fall back to the bundled copy.
  //    The `installApiPlugin()` call in setup Step 4 would do this anyway
  //    when it sees no detected npm install, but we do it here so the
  //    splash shows the correct "offline / bundled" label.
  log('dsh-api plugin: github install failed, falling back to bundled:', r.error);
  const bundled = installApiPlugin();
  if (bundled === 'installed') {
    progress(splashWin, 'plugin', 'done', {
      label: t('steps.plugin.usingBundled'), pct: 55,
    });
    return;
  }
  if (bundled === 'skipped-installed') {
    // Extremely rare: detectInstalledApiPlugin was false above but true now.
    // Belt-and-braces: treat as installed.
    progress(splashWin, 'plugin', 'done', {
      label: t('steps.plugin.installed'), pct: 55,
    });
    return;
  }
  // Neither path worked — surface the error but don't abort. dsh will still
  // start; the /dsh-api endpoints simply won't be there.
  progress(splashWin, 'plugin', 'error', {
    msg: t('steps.plugin.bothFailed', { error: r.error || 'unknown' }),
  });
}

module.exports = { runSetup, progress };
