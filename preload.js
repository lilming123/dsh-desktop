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
