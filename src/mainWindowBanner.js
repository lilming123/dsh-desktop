/**
 * mainWindowBanner.js — Top-of-window yellow banner injected into the dsh page.
 *
 * The banner is a shell-owned overlay: dsh has no idea it exists. Every
 * dsh page load (initial, reload, in-page navigation) triggers a `dom-ready`
 * event; we (re)inject the CSS + DOM + script on each one so the banner
 * survives reloads without extra plumbing.
 *
 * Wire-up (per main window):
 *
 *   const banner = install({ mainWindow, monitor, translate, onRestartClick });
 *   // ...
 *   banner.dispose();   // remove listeners; the DOM will die with the page
 *
 * The banner renders only when `monitor.state !== 'healthy'`. Its shape:
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │ ⚠ Reconnecting to dsh…                        [Retry] │  reconnecting
 *   │ ⚠ dsh connection lost. Restart to recover.   [Restart]│  lost
 *   └───────────────────────────────────────────────────────┘
 *
 * "Retry" (reconnecting state) just tells the shell to prod apiClient.
 * "Restart" (lost state) is a stronger action routed through capabilities:
 * kill and respawn dsh. The renderer only signals; the main process does
 * the work.
 */

'use strict';

const { ipcMain } = require('electron');
const { log } = require('./logger');

// One symbol used both for the IPC channel and the injected script marker.
// Kept stable and namespaced so it's unlikely to collide with anything dsh
// puts on `window`.
const CHANNEL_STATE = 'dsh-shell:banner-state';
const CHANNEL_RESTART = 'dsh-shell:banner-restart';
const CHANNEL_RETRY = 'dsh-shell:banner-retry';
const HOST_ID = '__dsh_shell_banner__';

/**
 * @param {{
 *   mainWindow: import('electron').BrowserWindow,
 *   monitor: { subscribe: (fn: Function) => (() => void), getState: () => any },
 *   translate: (key: string, params?: Record<string, string>) => string,
 *   onRestartClick: () => void,
 *   onRetryClick?: () => void,
 * }} deps
 */
function install(deps) {
  const { mainWindow, monitor, translate, onRestartClick, onRetryClick } = deps;
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('banner: no main window; skipping install');
    return { dispose() {} };
  }

  const wc = mainWindow.webContents;
  let lastPayload = statePayload(monitor.getState(), translate);
  let unsubscribeMonitor = null;
  let disposed = false;

  const pushState = (payload) => {
    if (disposed || wc.isDestroyed()) return;
    try {
      wc.send(CHANNEL_STATE, payload);
    } catch (e) {
      log('banner: send state failed', e && e.message);
    }
  };

  // Re-inject on every navigation / reload so the banner survives page churn.
  const injectAndPush = () => {
    if (disposed || wc.isDestroyed()) return;
    wc.executeJavaScript(rendererBootstrapScript(HOST_ID, CHANNEL_STATE, CHANNEL_RESTART, CHANNEL_RETRY), true)
      .catch((e) => log('banner: inject failed', e && e.message))
      .then(() => pushState(lastPayload));
  };

  wc.on('dom-ready', injectAndPush);
  // A brand-new load might not have hit dom-ready yet — inject once now too.
  if (!wc.isLoading()) injectAndPush();

  // Bridge monitor → renderer.
  unsubscribeMonitor = monitor.subscribe((s) => {
    lastPayload = statePayload(s, translate);
    pushState(lastPayload);
  });

  // IPC actions from the injected script.
  const onRestart = (event) => {
    if (event.sender !== wc) return;
    log('banner: user clicked Restart');
    try { onRestartClick?.(); }
    catch (e) { log('banner: restart handler threw', e && e.message); }
  };
  const onRetry = (event) => {
    if (event.sender !== wc) return;
    log('banner: user clicked Retry');
    try { onRetryClick?.(); }
    catch (e) { log('banner: retry handler threw', e && e.message); }
  };
  ipcMain.on(CHANNEL_RESTART, onRestart);
  ipcMain.on(CHANNEL_RETRY, onRetry);

  return {
    /**
     * Called by main.js when the language changes: rebuild the payload from
     * the current monitor state with the new translations, and push it so
     * the banner text updates in place without waiting for a state change.
     */
    refreshLocale() {
      lastPayload = statePayload(monitor.getState(), translate);
      pushState(lastPayload);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wc.removeListener('dom-ready', injectAndPush);
      ipcMain.removeListener(CHANNEL_RESTART, onRestart);
      ipcMain.removeListener(CHANNEL_RETRY, onRetry);
      unsubscribeMonitor?.();
      unsubscribeMonitor = null;
      // No need to remove the DOM: the page owns the banner and will drop
      // it on the next navigation / close.
    },
  };
}

/**
 * Build the payload the injected script consumes. Kept as a pure function
 * so refreshLocale() can call it without maintaining separate render state.
 */
function statePayload(state, t) {
  const kind = state?.state || 'healthy';
  const visible = kind !== 'healthy';
  if (!visible) return { visible: false };
  if (kind === 'reconnecting') {
    return {
      visible: true,
      severity: 'reconnecting',
      message: t('banner.reconnecting'),
      buttonLabel: t('banner.retry'),
      buttonAction: 'retry',
    };
  }
  // 'lost'
  return {
    visible: true,
    severity: 'lost',
    message: t('banner.lost'),
    buttonLabel: t('banner.restart'),
    buttonAction: 'restart',
  };
}

/**
 * The script we inject on every dom-ready. Written as a string so we don't
 * ship a separate renderer entry: the desktop app has no bundler for the
 * renderer, and dsh's own page loading logic doesn't know about us.
 *
 * The script:
 *   1. Ensures a top-level fixed banner host exists (idempotent — checks
 *      by `id === HOST_ID`).
 *   2. Wires it to receive state updates via ipcRenderer, exposed by
 *      preload as `window.__dshShellBanner`.
 *   3. Reserves 32px of top space when visible, using CSS to push the dsh
 *      page down instead of overlapping — so the banner never covers
 *      interactive UI.
 *
 * We're careful to run under `contextIsolation: true`: the main-world
 * script cannot call ipcRenderer directly. Preload exposes a tiny bridge
 * (see preload.js) with only three methods.
 */
function rendererBootstrapScript(hostId, chanState, chanRestart, chanRetry) {
  // Everything below runs inside the dsh page's main world. Keep it
  // dependency-free and defensive.
  return `
    (() => {
      // Bail out if we've already installed for this document.
      if (document.getElementById(${JSON.stringify(hostId)})) return;

      const host = document.createElement('div');
      host.id = ${JSON.stringify(hostId)};
      host.style.cssText = [
        'position: fixed',
        'top: 0', 'left: 0', 'right: 0',
        'z-index: 2147483647',
        'display: none',
        'align-items: center',
        'gap: 10px',
        'padding: 6px 14px',
        'font: 500 12.5px/1.4 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif',
        'color: #7a4f00',
        'background: linear-gradient(180deg, #fff4c9 0%, #ffe994 100%)',
        'border-bottom: 1px solid #e0be5a',
        'box-shadow: 0 1px 0 rgba(0,0,0,.04)',
        'user-select: none',
        '-webkit-app-region: no-drag',
      ].join(';');

      const icon = document.createElement('span');
      icon.textContent = '⚠';
      icon.style.cssText = 'flex-shrink:0;font-size:13px;line-height:1;';

      const spinner = document.createElement('span');
      spinner.style.cssText = [
        'display: none',
        'width: 12px', 'height: 12px',
        'border: 2px solid rgba(122,79,0,0.3)',
        'border-top-color: #7a4f00',
        'border-radius: 50%',
        'animation: dshShellSpin 0.65s linear infinite',
        'flex-shrink: 0',
      ].join(';');

      const msg = document.createElement('span');
      msg.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      const btn = document.createElement('button');
      btn.style.cssText = [
        'flex-shrink: 0',
        'padding: 3px 12px',
        'background: #7a4f00',
        'color: #fff',
        'border: none',
        'border-radius: 5px',
        'font: inherit',
        'font-size: 12px',
        'font-weight: 500',
        'cursor: pointer',
      ].join(';');
      btn.onmouseenter = () => { btn.style.background = '#5c3b00'; };
      btn.onmouseleave = () => { btn.style.background = '#7a4f00'; };

      let currentAction = null;
      btn.onclick = () => {
        if (!currentAction) return;
        if (currentAction === 'restart') {
          window.__dshShellBanner && window.__dshShellBanner.sendRestart();
        } else if (currentAction === 'retry') {
          window.__dshShellBanner && window.__dshShellBanner.sendRetry();
        }
      };

      host.appendChild(icon);
      host.appendChild(spinner);
      host.appendChild(msg);
      host.appendChild(btn);

      // One-time global CSS for the spinner keyframes. Injecting into
      // documentElement avoids racing document.body creation (some SPAs
      // remove and re-mount body).
      if (!document.getElementById('__dsh_shell_banner_style__')) {
        const st = document.createElement('style');
        st.id = '__dsh_shell_banner_style__';
        st.textContent = '@keyframes dshShellSpin { to { transform: rotate(360deg); } }';
        document.documentElement.appendChild(st);
      }

      const attach = () => {
        if (!document.body) return false;
        if (host.parentNode) return true;
        document.body.appendChild(host);
        return true;
      };
      if (!attach()) {
        // Body not ready yet — retry on the next tick.
        new MutationObserver((_muts, obs) => {
          if (attach()) obs.disconnect();
        }).observe(document.documentElement, { childList: true, subtree: false });
      }

      function apply(payload) {
        if (!payload || !payload.visible) {
          host.style.display = 'none';
          document.body && (document.body.style.paddingTop = '');
          currentAction = null;
          return;
        }
        host.style.display = 'flex';
        // Reserve vertical space so dsh's own top bar isn't hidden.
        // 32px matches the banner's rendered height (padding+font).
        if (document.body) document.body.style.paddingTop = '32px';

        msg.textContent = payload.message || '';
        btn.textContent = payload.buttonLabel || '';
        currentAction = payload.buttonAction || null;

        // Reconnecting: show spinner + softer palette.
        // Lost: hide spinner, keep icon (⚠) as the sole affordance.
        if (payload.severity === 'lost') {
          spinner.style.display = 'none';
          icon.style.display = '';
          host.style.background = 'linear-gradient(180deg, #ffddb8 0%, #ffc98a 100%)';
          host.style.borderBottom = '1px solid #e0965a';
          host.style.color = '#7a3900';
          btn.style.background = '#7a3900';
        } else {
          spinner.style.display = 'inline-block';
          icon.style.display = 'none';
          host.style.background = 'linear-gradient(180deg, #fff4c9 0%, #ffe994 100%)';
          host.style.borderBottom = '1px solid #e0be5a';
          host.style.color = '#7a4f00';
          btn.style.background = '#7a4f00';
        }
      }

      window.__dshShellBanner = {
        apply,
        sendRestart() { window.__dshShellBridge && window.__dshShellBridge.restart(); },
        sendRetry()   { window.__dshShellBridge && window.__dshShellBridge.retry(); },
      };

      // Drain any state frames that arrived before this injected script ran.
      // Preload buffers state pushes exactly so this handoff works even if
      // the main process pushed state before dom-ready fired.
      try {
        window.__dshShellBridge && window.__dshShellBridge.flushQueued();
      } catch (_) { /* ignore */ }
    })();
  `;
}

module.exports = {
  install,
  CHANNEL_STATE, CHANNEL_RESTART, CHANNEL_RETRY,
  HOST_ID,
};
