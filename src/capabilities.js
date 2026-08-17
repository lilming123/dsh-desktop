/**
 * capabilities.js — Unified capability layer (Electron main process).
 *
 * Shared by two callers:
 *   - `src/menu.js`         (menu clicks)
 *   - `src/companion.js`    (companion HTTP endpoints proxied by the plugin)
 *
 * Offered capabilities:
 *   - Workspace: pick a directory / open by path (restarts dsh with new cwd)
 *   - Files:     multi-pick then inject paths into the dsh input
 *   - Language:  delegated to the `dsh-api` plugin
 *   - Window:    show / reload / open in default browser
 *   - State:     dsh port, workspace dir, window visibility
 *
 * Invariant: **we never touch dsh internals directly.** Language and
 * workspace-list live inside dsh — this module reaches them only through the
 * plugin over HTTP. The only knobs here are Electron-shell things dsh cannot
 * do: file dialogs, spawning / restarting dsh, focusing the window.
 *
 * Runtime state (windows, port, workspace) is injected by main.js through
 * `setContext()`; this is the single point that also propagates `dshPort` to
 * the plugin client, so there is exactly one authoritative source.
 */

'use strict';

const { app, dialog, shell } = require('electron');
const fs = require('fs');
const { t, setLang } = require('./i18n');
const { switchWorkspace, dshUrl: dshUrlOf } = require('./dsh');
const pluginClient = require('./pluginClient');
const { log } = require('./logger');

// ── Runtime state (populated by main.js) ─────────────────────────────────────

const state = {
  mainWin: null,      // BrowserWindow
  splashWin: null,    // BrowserWindow | null
  dshPort: 3080,      // dsh's actual listening port
  workspace: null,    // Current workspace directory (as tracked by this app)
};

/**
 * Inject / update runtime state (main.js is the source of truth).
 * If `dshPort` changes, propagate it to the plugin client here — this is the
 * ONE place that keeps the client's target port in sync with reality.
 */
function setContext(partial) {
  if (!partial) return;
  Object.assign(state, partial);
  if (typeof partial.dshPort === 'number') pluginClient.setPort(partial.dshPort);
}

/** JSON snapshot exposed to the companion HTTP surface. */
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
function notifyChanged() {
  try { onStateChanged && onStateChanged(); }
  catch (e) { log('capabilities: onStateChanged threw', e && e.message); }
}

// ── Workspace ────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding as an HTML text node inside an inline
 * script. NOT a general-purpose HTML escaper — only handles the characters
 * that can escape the interpolation context in `openWorkspaceAt`.
 */
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Switch to a directory as the workspace: restart dsh, process cwd changes. */
async function openWorkspaceAt(dir) {
  if (!state.mainWin || state.mainWin.isDestroyed()) return { ok: false, error: 'no main window' };

  // 1. Show a placeholder page while dsh is restarting. dir goes through:
  //    - JSON.stringify(): safe embedding inside the JS expression `${...}`
  //    - htmlEscape():     applied after the JS eval, inside .innerHTML
  //    …but easier: build the HTML string in JS, embed the finished string as
  //    a JSON literal so no interpolation quoting concerns remain.
  const label = t('menu.switchingWorkspace');
  const html =
    '<div style="text-align:center">' +
      '<div style="font-size:32px;margin-bottom:12px">🔄</div>' +
      `<div>${htmlEscape(label)}</div>` +
      `<div style="font-size:12px;color:#aaa;margin-top:6px">${htmlEscape(dir)}</div>` +
    '</div>';
  const script = `
    document.body.style.cssText='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#666;background:#fff';
    document.body.innerHTML=${JSON.stringify(html)};
  `;
  state.mainWin.webContents.loadURL('about:blank');
  state.mainWin.webContents.executeJavaScript(script).catch(() => { /* fine */ });

  // 2. Restart dsh (kill old + pick free port + spawn + wait for ready)
  const newPort = await switchWorkspace(dir);

  // 3. Publish new state (setContext also updates pluginClient's port).
  setContext({ dshPort: newPort, workspace: dir });

  // 4. Load the new dsh UI, then notify listeners so companion + menu refresh.
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

/**
 * Inject text into whichever input element is currently focused.
 * The selector is tuned for dsh's Web UI (textarea / contenteditable / text
 * input). Values are passed as a `JSON.stringify`'d literal, so any input
 * text — quotes, backslashes, newlines — is safe.
 */
function pasteToInput(text) {
  if (!state.mainWin?.webContents) return { ok: false, error: 'no main window' };
  const script = `
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
  `;
  state.mainWin.webContents.executeJavaScript(script).catch(() => { /* fine */ });
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
 *
 * Local first: swap our i18n dict immediately so the menu label + splash text
 * update without waiting for the network. Then ask the plugin to make the
 * change authoritative in dsh.
 *
 * The returned envelope reflects the authoritative state — if the plugin
 * cannot ack, `ok: false` and `via: 'local-only'`. Menu labels will still
 * look correct locally, but dsh's own clients won't refresh. Callers can
 * surface this to the user (toast, etc.) if they care.
 */
async function setLanguage(lang) {
  const supported = ['en', 'zh'];
  if (!supported.includes(lang)) return { ok: false, error: 'unsupported language: ' + lang };
  try { setLang(lang); } catch (e) { log('capabilities: local setLang failed', e && e.message); }

  const acked = await pluginClient.setLanguage(lang);
  if (acked) return { ok: true, via: 'plugin' };
  return { ok: false, via: 'local-only', error: 'dsh-api plugin unavailable' };
}

/** Workspace-registry list, delegated to the plugin (null when unavailable). */
async function fetchWorkspaceList() { return pluginClient.listWorkspaces(); }

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
  shell.openExternal(dshUrlOf()).catch((e) => log('openExternal failed:', e && e.message));
  return { ok: true };
}

function quitApp() {
  setImmediate(() => { try { app.quit(); } catch (_) { /* app already quitting */ } });
  return { ok: true };
}

module.exports = {
  // Wiring
  setContext,
  setOnStateChanged,
  getState,
  // Workspace
  openWorkspaceAt,
  openWorkspaceDialog,
  openWorkspaceRequested,
  // Files
  pasteToInput,
  pickFilesAndInject,
  // Language
  setLanguage,
  fetchWorkspaceList,
  // Window / app
  showWindow,
  reloadWindow,
  openInBrowser,
  quitApp,
};
