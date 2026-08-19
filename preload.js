/**
 * preload.js — Context bridge between the Electron main process and the
 * splash / main renderer.
 *
 * Exposes three inbound IPC channels to the renderer with a small twist:
 * because the renderer may register its callback *after* main.js already
 * emitted an event (a classic startup race we hit as the "black splash"
 * bug), each channel buffers events until the renderer subscribes, then
 * drains the buffer on first subscribe.
 *
 * Public API on `window.electronAPI`:
 *   onProgress(cb)    ← 'progress'      — setup pipeline updates
 *   onLangChange(cb)  ← 'lang-changed'  — language switched in the shell
 *   onI18n(cb)        ← 'i18n-dict'     — full dictionary push (on dom-ready + switch)
 *   retry()           → 'retry'         — user hit "Try Again" on the splash
 *
 * Also exposes `window.__dshShellBridge` for the connection-status banner
 * we inject into dsh's page (see `src/mainWindowBanner.js`). That bridge
 * forwards banner state pushes to a global the injected script attaches
 * itself to, and exposes tiny `restart()` / `retry()` senders.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Create a subscribable inbound IPC channel with startup buffering.
 * Only the first registration is honored — this matches the previous
 * behavior and keeps semantics obvious.
 */
function queueChannel(channel) {
  const queue = [];
  let cb = null;
  ipcRenderer.on(channel, (_e, data) => {
    if (cb) cb(data);
    else queue.push(data);
  });
  return (subscriber) => {
    if (cb || typeof subscriber !== 'function') return;
    cb = subscriber;
    // Drain everything that arrived before the subscriber showed up.
    while (queue.length) cb(queue.shift());
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  onProgress:   queueChannel('progress'),
  onLangChange: queueChannel('lang-changed'),
  onI18n:       queueChannel('i18n-dict'),
  retry:        () => ipcRenderer.send('retry'),
});

// Banner bridge: the injected page script (see mainWindowBanner.js) reads
// `window.__dshShellBanner.apply` and calls this bridge for actions. We
// route state pushes here and forward them; page-side buffering handles the
// (very brief) race between dom-ready and the main-process state push that
// follows it.
{
  const BANNER_STATE = 'dsh-shell:banner-state';
  const BANNER_RESTART = 'dsh-shell:banner-restart';
  const BANNER_RETRY = 'dsh-shell:banner-retry';

  let queued = [];
  ipcRenderer.on(BANNER_STATE, (_e, payload) => {
    const applier = typeof window.__dshShellBanner?.apply === 'function'
      ? window.__dshShellBanner.apply
      : null;
    if (applier) {
      try { applier(payload); } catch { /* ignore */ }
    } else {
      // Injected script hasn't registered its applier yet — queue for it.
      queued.push(payload);
    }
  });

  contextBridge.exposeInMainWorld('__dshShellBridge', {
    /** Drains any state frames received before the injected applier was ready. */
    flushQueued() {
      const applier = window.__dshShellBanner?.apply;
      if (typeof applier !== 'function') return;
      const pending = queued; queued = [];
      for (const p of pending) { try { applier(p); } catch { /* ignore */ } }
    },
    restart: () => ipcRenderer.send(BANNER_RESTART),
    retry:   () => ipcRenderer.send(BANNER_RETRY),
  });
}
