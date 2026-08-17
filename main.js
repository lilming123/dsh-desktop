/**
 * main.js — Electron 主进程入口
 *
 * 职责仅限于：
 *   1. 创建启动页（splash）和主窗口
 *   2. 编排 setup 流程（环境检查 → dsh 安装 → 服务启动 → 打开 UI）
 *   3. 应用菜单和生命周期
 *
 * 所有业务逻辑拆到 src/ 下：paths / logger / dsh / install / setup / menu
 */

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { log } = require('./src/logger');
const { buildMenu } = require('./src/menu');
const { runSetup } = require('./src/setup');
const { switchWorkspace, dshUrl } = require('./src/dsh');

let splashWin = null;
let mainWin   = null;
let dshPort   = 3080;  // 运行时由 setup 填入实际端口

// ── 窗口创建 ──────────────────────────────────────────────────────────────────

/** 创建启动页窗口（无标题栏，居中，白底） */
function createSplash() {
  splashWin = new BrowserWindow({
    width: 480, height: 520,
    frame: false,
    resizable: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWin.loadFile('splash.html');
  splashWin.on('closed', () => { splashWin = null; });
  return splashWin;
}

/**
 * 创建主窗口（加载 dsh Web UI）。
 * @param {number} port  dsh 实际监听端口
 */
function createMain(port) {
  dshPort = port;
  const url = dshUrl();  // http://127.0.0.1:<port>
  log('creating main window, url=', url);

  mainWin = new BrowserWindow({
    width: 1280, height: 840,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  mainWin.loadURL(url);
  mainWin.once('ready-to-show', () => { splashWin?.close(); mainWin.show(); });
  mainWin.on('closed', () => { mainWin = null; });

  // 注入滚动条样式
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.insertCSS(
      '::-webkit-scrollbar{width:6px;height:6px}' +
      '::-webkit-scrollbar-track{background:transparent}' +
      '::-webkit-scrollbar-thumb{background:rgba(0,0,0,.18);border-radius:4px}'
    );
  });

  // 菜单：Open Folder 会调 switchWorkspace 重启 dsh，拿到新端口后 reload
  buildMenu(mainWin, async (folder) => {
    if (!mainWin) return;
    mainWin.webContents.loadURL('about:blank');
    mainWin.webContents.executeJavaScript(
      `document.body.style.cssText='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#666;background:#fff';` +
      `document.body.innerHTML='<div style="text-align:center"><div style="font-size:32px;margin-bottom:12px">🔄</div><div>Switching workspace…</div><div style="font-size:12px;color:#aaa;margin-top:6px">${folder}</div></div>'`
    ).catch(() => {});
    const newPort = await switchWorkspace(folder);
    dshPort = newPort;
    mainWin.webContents.loadURL(dshUrl());
  });

  return mainWin;
}

// ── 应用生命周期 ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  log('=== DeepSeek Harness Desktop starting ===');
  const win = createSplash();

  // 等 splash 的 DOM ready + preload 注册好 onProgress 后再跑 setup，
  // 避免 progress 事件在 renderer 监听器就绪前发出（黑屏 bug 根因）。
  win.webContents.once('dom-ready', () => {
    setTimeout(() => {
      runSetup(win, createMain).catch(err => log('setup error:', err.message));
    }, 80);
  });

  // macOS: 点 Dock 图标时，没有窗口就重新启动 splash + setup
  app.on('activate', () => {
    if (mainWin || splashWin) return;
    const s = createSplash();
    s.webContents.once('dom-ready', () => {
      setTimeout(() => runSetup(s, createMain).catch(() => {}), 80);
    });
  });
});

// 关窗口不退出（macOS 惯例）；dsh 是 detached 的，不杀
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// dsh 进程以 detached + unref 启动，app 退出时自然不影响它
app.on('before-quit', () => { /* dsh 独立存活，不 kill */ });
