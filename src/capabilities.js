/**
 * capabilities.js — 统一能力层（Electron 主进程）
 *
 * 菜单栏与 HTTP 桥接服务共用同一套能力实现：
 *   - 工作区：对话框选目录 / 按路径打开（重启 dsh 并切换 cwd）
 *   - 文件：多选文件并把路径注入 dsh 输入框
 *   - 语言：优先走 dsh 插件的 settings 服务（POST /desktop-api/language），
 *     插件不可用时回退为直接改写 settings.yaml + reload
 *   - 窗口：显示 / 重载 / 浏览器打开
 *   - 状态：dsh 端口、工作区目录、窗口可见性
 *
 * 状态由 main.js 通过 setContext() 注入（窗口引用、端口、工作区）。
 */

'use strict';

const { app, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { t, getLang, setLang } = require('./i18n');
const { switchWorkspace, dshUrl: dshUrlOf } = require('./dsh');

const DSH_SETTINGS = path.join(os.homedir(), '.dsh', 'settings.yaml');
const LANG_LABELS = { 'en': 'English', 'zh': '简体中文' };

// ── 运行时状态（由 main.js 注入） ──────────────────────────────────────────────

const state = {
  mainWin: null,      // BrowserWindow
  splashWin: null,    // BrowserWindow | null
  dshPort: 3080,      // dsh 实际端口
  workspace: null,    // 当前工作区目录（经本应用打开过的）
};

/** 注入/更新运行时状态 */
function setContext(partial) {
  Object.assign(state, partial);
}

/** 能力层对外状态快照（纯 JSON，供菜单与桥接使用） */
function getState() {
  return {
    pid: process.pid,
    dshPort: state.dshPort,
    dshUrl: dshUrlOf(),
    workspace: state.workspace || null,
    cwd: process.cwd(),
    windowVisible: !!(state.mainWin && !state.mainWin.isDestroyed() && state.mainWin.isVisible()),
    platform: process.platform,
  };
}

/** 语言切换后的回调（main.js 注册，用于刷新桥接发现文件等） */
let onStateChanged = null;
function setOnStateChanged(fn) { onStateChanged = fn; }
function notifyChanged() { try { onStateChanged && onStateChanged(); } catch (_) {} }

// ── 工作区 ────────────────────────────────────────────────────────────────────

/** 切换到指定目录作为工作区（重启 dsh，进程级 cwd 变更） */
async function openWorkspaceAt(dir) {
  if (!state.mainWin || state.mainWin.isDestroyed()) return { ok: false, error: 'no main window' };

  // 1. 显示切换中的占位页
  state.mainWin.webContents.loadURL('about:blank');
  state.mainWin.webContents.executeJavaScript(
    `document.body.style.cssText='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#666;background:#fff';` +
    `document.body.innerHTML='<div style="text-align:center"><div style="font-size:32px;margin-bottom:12px">🔄</div><div>${t('steps.ready.opening')}</div><div style="font-size:12px;color:#aaa;margin-top:6px">${String(dir).replace(/[<>&"]/g, '')}</div></div>'`
  ).catch(() => {});

  // 2. 重启 dsh（kill 旧的 + 找新端口 + 启动 + 等就绪）
  const newPort = await switchWorkspace(dir);
  state.dshPort = newPort;
  state.workspace = dir;

  // 3. 加载新工作区的 UI
  state.mainWin.webContents.loadURL(dshUrlOf());
  notifyChanged();
  return { ok: true, port: newPort, workspace: dir };
}

/** 弹出目录选择对话框后打开工作区；取消返回 { ok:false, canceled:true } */
async function openWorkspaceDialog() {
  if (!state.mainWin) return { ok: false, error: 'no main window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(state.mainWin, {
    title: t('menu.openFolder'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return openWorkspaceAt(filePaths[0]);
}

/** 按路径打开工作区（外部调用方已给定目录） */
async function openWorkspaceRequested(dir) {
  if (typeof dir !== 'string' || !dir.length) return openWorkspaceDialog();
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return { ok: false, error: 'not a directory: ' + dir };
  } catch (e) {
    return { ok: false, error: 'invalid path: ' + (e && e.message) };
  }
  return openWorkspaceAt(dir);
}

// ── 文件 / 输入 ────────────────────────────────────────────────────────────────

/** 把文本注入到当前激活的输入元素（textarea / contenteditable / input） */
function pasteToInput(text) {
  if (!state.mainWin?.webContents) return { ok: false, error: 'no main window' };
  state.mainWin.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
      if (!el) return;
      el.focus();
      const v = ${JSON.stringify(String(text))};
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const pos = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, pos) + v + el.value.slice(pos);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, v);
      }
    })();
  `).catch(() => {});
  return { ok: true };
}

/** 弹出多选文件对话框，把路径注入 dsh 输入框 */
async function pickFilesAndInject() {
  if (!state.mainWin) return { ok: false, error: 'no main window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(state.mainWin, {
    title: t('menu.addFile'),
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const paths = filePaths.map(p => p.replace(/\\/g, '/')).join(' ');
  return pasteToInput(paths);
}

// ── 语言 ──────────────────────────────────────────────────────────────────────

/**
 * 直接修改 dsh 的 settings.yaml 里的 locale.preference（回退路径）。
 * 简单文本替换，避免引入完整 YAML 依赖。
 */
function writeDshLocalePreference(lang) {
  try {
    let text = fs.existsSync(DSH_SETTINGS) ? fs.readFileSync(DSH_SETTINGS, 'utf8') : '';
    const localeBlock = /^locale:\s*\n\s+preference:\s*['"]?[\w-]+['"]?/m;
    if (localeBlock.test(text)) {
      text = text.replace(localeBlock, `locale:\n  preference: ${lang}`);
    } else {
      if (text && !text.endsWith('\n')) text += '\n';
      text += `locale:\n  preference: ${lang}\n`;
    }
    fs.writeFileSync(DSH_SETTINGS, text, 'utf8');
    return true;
  } catch { return false; }
}

/** 短超时的 HTTP GET/POST 到 dsh 插件 API；失败返回 null */
function callPluginApi(port, method, pathname, body, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload !== null
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0 });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * 切换界面语言：
 * 1. 本地 i18n 切换（触发菜单重建）
 * 2. 优先走 dsh 插件 API（settings 服务），dsh 客户端自动重渲染
 * 3. 插件不可用（dsh 未起 / 未装插件）→ 直接改 settings.yaml + reload
 */
async function setLanguage(lang) {
  if (!['en', 'zh'].includes(lang)) return { ok: false, error: 'unsupported language: ' + lang };
  try { setLang(lang); } catch (_) {}

  const r = await callPluginApi(state.dshPort, 'POST', '/desktop-api/language', { language: lang });
  if (r && r.status >= 200 && r.status < 300) {
    return { ok: true, via: 'plugin' };
  }
  // 回退：直接写 settings.yaml + reload 主窗口
  writeDshLocalePreference(lang);
  if (state.mainWin && !state.mainWin.isDestroyed()) {
    state.mainWin.webContents.reload();
  }
  return { ok: true, via: 'fallback' };
}

/** 从 dsh 插件 API 拉取工作区列表（菜单“最近工作区”用），失败返回 null */
async function fetchWorkspaceList(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: state.dshPort,
      path: '/desktop-api/workspace/list',
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(buf);
          resolve(Array.isArray(data.workspaces) ? data.workspaces : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ── 窗口 / 应用 ───────────────────────────────────────────────────────────────

function showWindow() {
  if (!state.mainWin || state.mainWin.isDestroyed()) return { ok: false, error: 'no main window' };
  if (state.mainWin.isMinimized()) state.mainWin.restore();
  state.mainWin.show();
  state.mainWin.focus();
  return { ok: true };
}

function reloadWindow() {
  if (!state.mainWin || state.mainWin.isDestroyed()) return { ok: false, error: 'no main window' };
  state.mainWin.webContents.reload();
  return { ok: true };
}

function openInBrowser() {
  shell.openExternal(dshUrlOf()).catch(() => {});
  return { ok: true };
}

function quitApp() {
  setImmediate(() => { try { app.quit(); } catch (_) {} });
  return { ok: true };
}

module.exports = {
  setContext,
  getState,
  setOnStateChanged,
  openWorkspaceAt,
  openWorkspaceDialog,
  openWorkspaceRequested,
  pasteToInput,
  pickFilesAndInject,
  setLanguage,
  fetchWorkspaceList,
  showWindow,
  reloadWindow,
  openInBrowser,
  quitApp,
  LANG_LABELS,
};
