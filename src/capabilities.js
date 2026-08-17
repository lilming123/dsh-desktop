/**
 * capabilities.js — Unified capability layer (Electron main process).
 *
 * Two callers share this module: the menu (`src/menu.js`) and the companion
 * HTTP service (`src/companion.js`). It offers:
 *
 *   - Workspace: pick a directory / open by path (restarts dsh with new cwd)
 *   - Files:     multi-pick then inject paths into the dsh input
 *   - Language:  delegated to the dsh-api plugin (POST /dsh-api/language)
 *   - Window:    show / reload / open in default browser
 *   - State:     dsh port, workspace dir, window visibility
 *
 * The important design rule of this refactor:
 * **We never touch dsh internals directly.** Language and workspace list live
 * inside dsh — this module reaches them only through the `dsh-api` plugin over
 * HTTP. The only knobs here are the Electron-shell things dsh itself cannot
 * do: file dialogs, spawning / restarting dsh, focusing the window.
 *
 * Runtime state (windows, port, workspace) is injected by main.js via
 * `setContext()`.
 */

'use strict';

const { app, dialog, shell } = require('electron');
const fs = require('fs');
const { t, setLang } = require('./i18n');
const { switchWorkspace, dshUrl: dshUrlOf } = require('./dsh');
const pluginClient = require('./pluginClient');

const LANG_LABELS = { en: 'English', zh: '简体中文' };

// ── Runtime state (populated by main.js) ─────────────────────────────────────

const state = {
  mainWin: null,      // BrowserWindow
  splashWin: null,    // BrowserWindow | null
  dshPort: 3080,      // dsh actual listening port
  workspace: null,    // Current workspace directory (as seen by this app)
};

/** Inject / update runtime state (main.js is the source of truth). */
function setContext(partial) {
  Object.assign(state, partial);
  if (partial && typeof partial.dshPort === 'number') pluginClient.setPort(partial.dshPort);
}

/** State snapshot (pure JSON) shared with the companion HTTP surface. */
function getState() {
  const mainWin = state.mainWin;
  return {
    pid: process.pid,
    dshPort: state.dshPort,
    dshUrl: dshUrlOf(),
    workspace: state.workspace || null,
    cwd: process.cwd(),
    windowVisible: !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible()),
    platform: process.platform,
  };
}

// Callback fired when observable state changes (workspace/port). main.js uses
// it to refresh the companion discovery file and rebuild the menu.
let onStateChanged = null;
function setOnStateChanged(fn) { onStateChanged = fn; }
function notifyChanged() { try { onStateChanged && onStateChanged(); } catch (_) { /* swallow */ } }

// ── Workspace ────────────────────────────────────────────────────────────────

/** Switch to a directory as the workspace: restart dsh, process cwd changes. */
async function openWorkspaceAt(dir) {
  if (!state.mainWin || state.mainWin.isDestroyed()) return { ok: false, error: 'no main window' };

  // 1. Show a placeholder page while dsh is restarting
  state.mainWin.webContents.loadURL('about:blank');
  state.mainWin.webContents.executeJavaScript(
    `document.body.style.cssText='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#666;background:#fff';` +
    `document.body.innerHTML='<div style="text-align:center"><div style="font-size:32px;margin-bottom:12px">🔄</div><div>${t('menu.switchingWorkspace')}</div><div style="font-size:12px;color:#aaa;margin-top:6px">${String(dir).replace(/[<>&"]/g, '')}</div></div>'`
  ).catch(() => {});

  // 2. Restart dsh (kill old + pick free port + spawn + wait for ready)
  const newPort = await switchWorkspace(dir);
  state.dshPort = newPort;
  state.workspace = dir;
  pluginClient.setPort(newPort);

  // 3. Load the new dsh UI
  state.mainWin.webContents.loadURL(dshUrlOf());
  notifyChanged();
  return { ok: true, port: newPort, workspace: dir };
}

/** Directory-picker → openWorkspaceAt. Cancel returns `{ ok:false, canceled:true }`. */
async function openWorkspaceDialog() {
  if (!state.mainWin) return { ok: false, error: 'no main window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(state.mainWin, {
    title: t('menu.openFolder'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return openWorkspaceAt(filePaths[0]);
}

/** Open a workspace by explicit path (caller already has the directory). */
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

// ── Files / input injection ──────────────────────────────────────────────────

/** Inject text into whichever input element is currently focused. */
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

/** Multi-file picker; join with spaces and paste into the dsh input. */
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

// ── Language ─────────────────────────────────────────────────────────────────

/**
 * Switch UI language.
 * Sync: local i18n switches first so the menu label + splash text update
 *       immediately (matters when dsh is still starting or was reused
 *       without the plugin).
 * Async: the dsh-api plugin does the authoritative write via the `settings`
 *        service. dsh clients then refresh live. We never touch settings.yaml
 *        ourselves — that's dsh's own concern.
 */
async function setLanguage(lang) {
  if (!['en', 'zh'].includes(lang)) return { ok: false, error: 'unsupported language: ' + lang };
  try { setLang(lang); } catch (_) { /* i18n load failure isn't fatal */ }

  const ok = await pluginClient.setLanguage(lang);
  return { ok: true, applied: ok ? 'plugin' : 'local-only' };
}

/** Recent-workspaces list for the menu — delegated to the plugin. */
async function fetchWorkspaceList() {
  return pluginClient.listWorkspaces();
}

// ── Window / app ─────────────────────────────────────────────────────────────

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
  setImmediate(() => { try { app.quit(); } catch (_) { /* app already quitting */ } });
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
