/**
 * preload-main.js — 主窗口 preload
 *
 * 唯一职责：桥接 dsh WebUI 的语言切换 → Electron 主进程。
 * 页面加载完成后注入一个脚本，通过 `postMessage` 从页面向 preload
 * 传递事件，preload 再转发给主进程（因为 contextIsolation 阻止
 * 页面直接访问 ipcRenderer）。
 */

const { ipcRenderer } = require('electron');

// 监听页面 window.postMessage，收到语言变化时转发给主进程
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (msg && msg.__dshDesktop === 'lang-change' && typeof msg.lang === 'string') {
    ipcRenderer.send('dsh-lang-changed', msg.lang);
  }
});
