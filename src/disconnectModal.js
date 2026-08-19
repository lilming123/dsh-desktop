/**
 * disconnectModal.js — Electron-native "dsh disconnected" modal.
 *
 * Replaces the earlier page-DOM-injected banner: dsh's SPA repeatedly
 * remounts its root, wiping any DOM the shell tries to attach to the
 * page. Instead, when the connection state machine leaves 'healthy' we:
 *
 *   1. Blur the main window's page contents via a shell-owned CSS
 *      overlay (main-window CSS injection persists across dsh's
 *      React remounts because it lives on <html>, not inside <body>).
 *   2. Open a small frameless BrowserWindow parented to the main
 *      window, centered on top, with our own HTML string as content.
 *      The modal window is independent of dsh — no injection race.
 *   3. Wire two buttons: "Retry" invokes onRetryClick(); "Quit"
 *      invokes onQuitClick(). Both flow through IPC channels this
 *      module owns.
 *   4. When the monitor returns to 'healthy', close the modal and
 *      remove the blur. When the user asks to Quit, we just call the
 *      supplied callback (main.js decides whether to app.quit()).
 *
 * Contract:
 *
 *   const modal = install({
 *     mainWindow,       // BrowserWindow — parent for the modal
 *     monitor,          // connectionMonitor instance
 *     translate,        // (key, params?) => localized string
 *     onRetryClick,     // async () => { ok: boolean, error?: string }
 *     onQuitClick,      // () => void — usually app.quit()
 *   });
 *   ...
 *   modal.refreshLocale();  // re-render buttons/message with new lang
 *   modal.dispose();        // remove listeners, close modal if open
 */

'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { log } = require('./logger');

// IPC channels — namespaced so they can't collide with dsh or preload's
// other bridges. `state` pushes UI updates from main; `retry` / `quit` /
// `ready` come back from the modal renderer.
const CH_STATE = 'dsh-shell:modal-state';
const CH_RETRY = 'dsh-shell:modal-retry';
const CH_QUIT = 'dsh-shell:modal-quit';
const CH_READY = 'dsh-shell:modal-ready';

// A unique <style> tag id we drop into the main window's <html>. Keeping
// it on documentElement (not body) means dsh's React re-mounting body
// doesn't wipe our blur. Idempotent by id — safe to re-inject.
const BLUR_STYLE_ID = '__dsh_shell_blur_style__';

function install(deps) {
  const { mainWindow, monitor, translate, onRetryClick, onQuitClick } = deps;
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('modal: no main window; skipping install');
    return { dispose() {}, refreshLocale() {} };
  }

  let modalWin = null;         // the popup BrowserWindow, or null
  let modalReady = false;      // did the modal renderer send us 'ready'?
  let queuedState = null;      // last state payload if pushed pre-ready
  let unsubMonitor = null;
  let disposed = false;
  let currentSeverity = null;  // 'reconnecting' | 'lost' | null (healthy)

  // ── Blur the main window ────────────────────────────────────────────

  const applyBlur = () => {
    if (mainWindow.isDestroyed()) return;
    const js = `
      (() => {
        let st = document.getElementById(${JSON.stringify(BLUR_STYLE_ID)});
        if (!st) {
          st = document.createElement('style');
          st.id = ${JSON.stringify(BLUR_STYLE_ID)};
          document.documentElement.appendChild(st);
        }
        st.textContent = 'body { filter: blur(4px) grayscale(20%); pointer-events: none; transition: filter .2s ease-out; }';
      })();
    `;
    mainWindow.webContents.executeJavaScript(js, true).catch((e) => {
      log('modal: applyBlur failed', e && e.message);
    });
  };

  const removeBlur = () => {
    if (mainWindow.isDestroyed()) return;
    const js = `
      (() => {
        const st = document.getElementById(${JSON.stringify(BLUR_STYLE_ID)});
        if (st) st.remove();
      })();
    `;
    mainWindow.webContents.executeJavaScript(js, true).catch(() => { /* ignore */ });
  };

  // ── Modal lifecycle ─────────────────────────────────────────────────

  const pushState = (payload) => {
    if (!modalWin || modalWin.isDestroyed()) return;
    if (!modalReady) { queuedState = payload; return; }
    try { modalWin.webContents.send(CH_STATE, payload); }
    catch (e) { log('modal: send state failed', e && e.message); }
  };

  const openModal = () => {
    if (modalWin && !modalWin.isDestroyed()) return;
    modalReady = false;
    queuedState = null;

    const parentBounds = mainWindow.getBounds();
    const W = 440, H = 220;
    const x = Math.round(parentBounds.x + (parentBounds.width - W) / 2);
    const y = Math.round(parentBounds.y + (parentBounds.height - H) / 2);

    modalWin = new BrowserWindow({
      width: W, height: H, x, y,
      parent: mainWindow,
      modal: true,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      backgroundColor: '#ffffff',
      hasShadow: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });

    // Load our HTML directly via data URL — no file I/O, no path guessing,
    // and the CSP is trivially controlled inline.
    const html = renderModalHtml(CH_STATE, CH_RETRY, CH_QUIT, CH_READY);
    modalWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    modalWin.once('ready-to-show', () => {
      if (modalWin && !modalWin.isDestroyed()) modalWin.show();
    });

    modalWin.on('closed', () => { modalWin = null; modalReady = false; queuedState = null; });
  };

  const closeModal = () => {
    if (modalWin && !modalWin.isDestroyed()) {
      try { modalWin.close(); } catch (_) { /* ignore */ }
    }
    modalWin = null;
    modalReady = false;
  };

  // ── IPC handlers ────────────────────────────────────────────────────

  const isFromModal = (event) => {
    return modalWin && !modalWin.isDestroyed() && event.sender === modalWin.webContents;
  };

  const onReady = (event) => {
    if (!isFromModal(event)) return;
    modalReady = true;
    if (queuedState) { pushState(queuedState); queuedState = null; }
  };

  const onRetry = async (event) => {
    if (!isFromModal(event)) return;
    log('modal: user clicked Retry');
    // Tell the renderer we're working so the button becomes a spinner.
    pushState(payloadFor('retrying', translate));
    try {
      const r = await onRetryClick?.();
      if (r && r.ok === false) {
        pushState(payloadFor(currentSeverity || 'lost', translate, r.error || null));
      }
      // On success we do nothing here: monitor.onOpen() will flip state
      // to healthy and closeModal() runs from the subscribe callback.
    } catch (e) {
      log('modal: retry threw', e && e.message);
      pushState(payloadFor(currentSeverity || 'lost', translate, e && e.message));
    }
  };

  const onQuit = (event) => {
    if (!isFromModal(event)) return;
    log('modal: user clicked Quit');
    try { onQuitClick?.(); }
    catch (e) { log('modal: quit threw', e && e.message); }
  };

  ipcMain.on(CH_READY, onReady);
  ipcMain.on(CH_RETRY, onRetry);
  ipcMain.on(CH_QUIT, onQuit);

  // ── Monitor bridge ──────────────────────────────────────────────────

  const applyMonitorState = (s) => {
    const kind = s?.state || 'healthy';
    if (kind === 'healthy') {
      currentSeverity = null;
      removeBlur();
      closeModal();
      return;
    }
    // reconnecting or lost — ensure modal is visible & blurred backdrop
    currentSeverity = kind;
    applyBlur();
    openModal();
    pushState(payloadFor(kind, translate));
  };

  unsubMonitor = monitor.subscribe(applyMonitorState);

  // ── Return API ──────────────────────────────────────────────────────

  return {
    refreshLocale() {
      if (!currentSeverity) return;
      pushState(payloadFor(currentSeverity, translate));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ipcMain.removeListener(CH_READY, onReady);
      ipcMain.removeListener(CH_RETRY, onRetry);
      ipcMain.removeListener(CH_QUIT, onQuit);
      unsubMonitor?.();
      unsubMonitor = null;
      closeModal();
      removeBlur();
    },
  };
}

/**
 * Build the payload for a given severity, with localized copy.
 * `retryError` is an optional string appended in muted text if the last
 * retry attempt failed.
 */
function payloadFor(severity, t, retryError) {
  if (severity === 'retrying') {
    return {
      severity: 'retrying',
      title: t('modal.retrying.title'),
      message: t('modal.retrying.message'),
      retryLabel: t('modal.retryingButton'),
      quitLabel: t('modal.quit'),
      retryBusy: true,
      retryError: null,
    };
  }
  // reconnecting or lost — same UI, slightly different copy.
  const isLost = severity === 'lost';
  return {
    severity,
    title: isLost ? t('modal.lost.title') : t('modal.reconnecting.title'),
    message: isLost ? t('modal.lost.message') : t('modal.reconnecting.message'),
    retryLabel: t('modal.retry'),
    quitLabel: t('modal.quit'),
    retryBusy: false,
    retryError: retryError || null,
  };
}

/**
 * Renderer HTML. Kept as a single string so we can ship it via data URL
 * without a separate file. All styles are inline; behaviour is a tiny
 * inline script talking to preload's `__dshShellModal` bridge.
 */
function renderModalHtml(chState, chRetry, chQuit, chReady) {
  // We escape the channel names into the script to be safe; they're
  // static strings today but this keeps future changes honest.
  const esc = (s) => JSON.stringify(s);
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; color: #202124;
    font: 13px/1.5 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; user-select: none; }
  .wrap { display: flex; flex-direction: column; height: 100%; padding: 22px 24px 20px; box-sizing: border-box; }
  .title { font-size: 15px; font-weight: 600; color: #202124; margin: 0 0 8px; }
  .msg { flex: 1; font-size: 13px; color: #4a4a4a; margin: 0; line-height: 1.55;
    overflow-wrap: break-word; }
  .err { margin-top: 8px; font-size: 12px; color: #b3261e; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid transparent;
    background: transparent; cursor: pointer; }
  button.primary { background: #1a73e8; color: white; }
  button.primary:hover:not(:disabled) { background: #1662c4; }
  button.primary:disabled { background: #a3c1ea; cursor: default; }
  button.secondary { color: #202124; border-color: #dadce0; background: #fff; }
  button.secondary:hover { background: #f5f5f5; }
  .spinner { display: inline-block; width: 12px; height: 12px;
    border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff;
    border-radius: 50%; animation: spin 0.65s linear infinite; margin-right: 6px;
    vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
<div class="wrap">
  <h1 class="title" id="title">…</h1>
  <p class="msg" id="msg">…</p>
  <div class="err" id="err" style="display:none"></div>
  <div class="row">
    <button class="secondary" id="quit">Quit</button>
    <button class="primary" id="retry">Retry</button>
  </div>
</div>
<script>
  (() => {
    const CH_STATE = ${esc(chState)};
    const CH_RETRY = ${esc(chRetry)};
    const CH_QUIT  = ${esc(chQuit)};
    const CH_READY = ${esc(chReady)};

    const $ = (id) => document.getElementById(id);
    const titleEl = $('title'), msgEl = $('msg'), errEl = $('err');
    const retryBtn = $('retry'), quitBtn = $('quit');

    // The preload exposes a tiny bridge; check for it.
    const bridge = window.__dshShellModal;
    if (!bridge) {
      // Fallback: still render but buttons are inert. Should never happen
      // in practice — preload always attaches this window's channels.
      titleEl.textContent = 'Preload unavailable';
      msgEl.textContent = 'The desktop preload script did not load. Please quit and reopen.';
      return;
    }

    function apply(payload) {
      titleEl.textContent = payload.title || '';
      msgEl.textContent = payload.message || '';
      retryBtn.textContent = '';
      if (payload.retryBusy) {
        const sp = document.createElement('span');
        sp.className = 'spinner';
        retryBtn.appendChild(sp);
      }
      retryBtn.appendChild(document.createTextNode(payload.retryLabel || 'Retry'));
      quitBtn.textContent = payload.quitLabel || 'Quit';
      retryBtn.disabled = !!payload.retryBusy;
      if (payload.retryError) {
        errEl.style.display = '';
        errEl.textContent = payload.retryError;
      } else {
        errEl.style.display = 'none';
        errEl.textContent = '';
      }
    }

    bridge.onState(apply);
    retryBtn.addEventListener('click', () => bridge.retry());
    quitBtn.addEventListener('click', () => bridge.quit());

    // Tell the main process we're ready to receive state.
    bridge.ready();
  })();
</script></body></html>`;
}

module.exports = { install };
