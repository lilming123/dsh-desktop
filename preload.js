/**
 * preload.js — contextBridge：渲染进程与主进程的通信桥
 *
 * 暴露给 splash.html 的 API：
 *   - onProgress(cb)   监听启动进度事件
 *   - onLangChange(cb) 监听语言切换事件
 *   - retry()          触发重试
 *
 * 事件缓冲队列解决 race condition：progress 事件可能在 renderer
 * 监听器注册前发出，用队列暂存确保不丢失。
 */

const { contextBridge, ipcRenderer } = require('electron');

// progress 事件缓冲（renderer 就绪前到达的）
const progressQueue = [];
let progressCb = null;

ipcRenderer.on('progress', (_e, data) => {
  if (progressCb) progressCb(data);
  else progressQueue.push(data);
});

// 语言切换事件
const langQueue = [];
let langCb = null;

ipcRenderer.on('lang-changed', (_e, lang) => {
  if (langCb) langCb(lang);
  else langQueue.push(lang);
});

// i18n 字典推送（主进程在 dom-ready 和语言切换时推送）
const i18nQueue = [];
let i18nCb = null;

ipcRenderer.on('i18n-dict', (_e, dict) => {
  if (i18nCb) i18nCb(dict);
  else i18nQueue.push(dict);
});

contextBridge.exposeInMainWorld('electronAPI', {
  // 启动进度：立即 drain 缓冲，再接实时流
  onProgress: (cb) => {
    progressCb = cb;
    progressQueue.splice(0).forEach(cb);
  },
  // 语言切换：同样 drain 缓冲
  onLangChange: (cb) => {
    langCb = cb;
    langQueue.splice(0).forEach(cb);
  },
  // i18n 字典：drain 缓冲
  onI18n: (cb) => {
    i18nCb = cb;
    i18nQueue.splice(0).forEach(cb);
  },
  retry: () => ipcRenderer.send('retry'),
});
