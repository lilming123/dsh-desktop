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
 * Also exposes `window.__dshShellModal` for the disconnect-recovery modal
 * window (see `src/disconnectModal.js`). That window subscribes to state
 * pushes and forwards Retry / Quit clicks back to the shell.
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

// Modal bridge: the modal renderer (see disconnectModal.js) subscribes
// to state pushes and sends Retry / Quit actions back. Both directions
// are only useful for the modal window itself, but preload.js is shared
// so we expose the bridge unconditionally — the modal renderer checks
// for `window.__dshShellModal` and no-ops in the main window (which is
// the dsh page, and never touches this object).
{
  const CH_STATE = 'dsh-shell:modal-state';
  const CH_RETRY = 'dsh-shell:modal-retry';
  const CH_QUIT = 'dsh-shell:modal-quit';
  const CH_READY = 'dsh-shell:modal-ready';

  let subscriber = null;
  let queued = [];
  ipcRenderer.on(CH_STATE, (_e, payload) => {
    if (subscriber) { try { subscriber(payload); } catch { /* ignore */ } }
    else queued.push(payload);
  });

  contextBridge.exposeInMainWorld('__dshShellModal', {
    /** Subscribe once to state updates; drains any queued pushes. */
    onState(fn) {
      if (subscriber || typeof fn !== 'function') return;
      subscriber = fn;
      const pending = queued; queued = [];
      for (const p of pending) { try { fn(p); } catch { /* ignore */ } }
    },
    retry: () => ipcRenderer.send(CH_RETRY),
    quit:  () => ipcRenderer.send(CH_QUIT),
    ready: () => ipcRenderer.send(CH_READY),
  });
}
