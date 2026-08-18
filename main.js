/**
 * main.js — Electron main-process entry.
 *
 * Responsibilities are deliberately narrow:
 *   1. Create the splash window and the main window.
 *   2. Orchestrate the setup pipeline (env check → dsh install → server
 *      start → open UI), including the "Try Again" retry path from the
 *      splash screen.
 *   3. Wire up the app menu, the companion HTTP service, and lifecycle
 *      teardown.
 *
 * Everything else lives under `src/`:
 *   paths / logger / fsx / pluginClient / dsh / install / setup /
 *   capabilities / companion / menu / i18n
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { log } = require('./src/logger');
const { buildMenu } = require('./src/menu');
const { runSetup } = require('./src/setup');
const { dshUrl } = require('./src/dsh');
const { getDict, onLangChange, watchDshLanguage } = require('./src/i18n');
const capabilities = require('./src/capabilities');
const { startCompanion } = require('./src/companion');

let splashWin = null;
let mainWin   = null;
let companion = null;

// Guards against running setup twice concurrently (e.g. retry clicked twice,
// or retry while the first attempt is still going).
let setupRunning = false;

/**
 * Run the setup pipeline against a splash window, guarded against
 * concurrency. Failures are logged (the splash already shows the error UI)
 * and never thrown to the caller.
 */
async function runSetupSafely(win) {
  if (setupRunning) return;
  if (!win || win.isDestroyed()) return;
  setupRunning = true;
  try {
    await runSetup(win, createMain);
  } catch (err) {
    log('setup error:', err && err.message);
  } finally {
    setupRunning = false;
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────

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

  // Push the current i18n dictionary as soon as the DOM is ready so the
  // splash renders in the right language before any progress arrives.
  splashWin.webContents.once('dom-ready', () => {
    splashWin.webContents.send('i18n-dict', getDict());
  });

  splashWin.on('closed', () => {
    splashWin = null;
    capabilities.setContext({ splashWin: null });
  });
  capabilities.setContext({ splashWin });
  return splashWin;
}

// Language switch → refresh splash dict (if still alive) + rebuild menu.
onLangChange(() => {
  try {
    if (splashWin && !splashWin.isDestroyed()) {
      splashWin.webContents.send('i18n-dict', getDict());
    }
  } catch (_) { /* splash gone */ }
  try {
    if (mainWin && !mainWin.isDestroyed()) buildMenu(mainWin, splashWin);
  } catch (e) { log('menu rebuild on lang change failed:', e && e.message); }
});

function createMain(port) {
  // setContext synchronizes pluginClient's port; this is the ONE place we do so.
  capabilities.setContext({ dshPort: port });
  const url = dshUrl();
  log('creating main window, url=', url);

  mainWin = new BrowserWindow({
    width: 1280, height: 840,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  capabilities.setContext({ mainWin });

  mainWin.loadURL(url);
  mainWin.once('ready-to-show', () => { splashWin?.close(); mainWin.show(); });
  mainWin.on('closed', () => {
    mainWin = null;
    capabilities.setContext({ mainWin: null });
  });

  // Thin scrollbar
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.insertCSS(
      '::-webkit-scrollbar{width:6px;height:6px}' +
      '::-webkit-scrollbar-track{background:transparent}' +
      '::-webkit-scrollbar-thumb{background:rgba(0,0,0,.18);border-radius:4px}'
    ).catch(() => { /* window may be destroyed already */ });
  });

  buildMenu(mainWin, splashWin);

  // Publish current port/workspace to the plugin via the companion discovery file.
  companion?.refresh();
  return mainWin;
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  log('=== DeepSeek Harness Desktop starting ===');
  watchDshLanguage(); // background poll of GET /dsh-api/language (interval is unref'd)

  companion = await startCompanion({ api: capabilities }).catch((err) => {
    log('companion start failed:', err.message);
    return null;
  });

  // State changes (workspace switch, port change) → refresh discovery file
  // and rebuild the menu so the current-workspace tooltip stays accurate.
  capabilities.setOnStateChanged(() => {
    companion?.refresh();
    if (mainWin && !mainWin.isDestroyed()) buildMenu(mainWin, splashWin);
  });

  // Splash "Try Again" button → re-run the whole setup pipeline. The button
  // only appears after a failure, and the guard above prevents overlaps.
  ipcMain.on('retry', () => {
    log('retry requested from splash');
    runSetupSafely(splashWin);
  });

  const win = createSplash();

  // Wait for the splash DOM to be ready AND the preload to register its
  // onProgress handler before running setup — otherwise progress events
  // fire before the renderer can listen for them (the original black-splash bug).
  win.webContents.once('dom-ready', () => {
    setTimeout(() => runSetupSafely(win), 80);
  });

  // macOS: clicking the Dock icon with no window ⇒ relaunch splash + setup.
  app.on('activate', () => {
    if (mainWin || splashWin) return;
    const s = createSplash();
    s.webContents.once('dom-ready', () => {
      setTimeout(() => runSetupSafely(s), 80);
    });
  });
});

// Standard macOS convention: closing all windows doesn't quit. dsh is detached, so we don't kill it either.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { companion?.stop(); } catch (_) { /* already down */ }
  companion = null;
});
