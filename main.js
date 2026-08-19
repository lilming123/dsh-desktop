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
const { dshUrl, getRuntime, buildEnv, restartDsh } = require('./src/dsh');
const { getDict, onLangChange, watchDshLanguage, t } = require('./src/i18n');
const capabilities = require('./src/capabilities');
const { startCompanion } = require('./src/companion');
const { scheduleSilentUpgrade } = require('./src/upstream');
const { openEventStream } = require('./src/apiClient');
const notifier = require('./src/notifier');
const { createMonitor } = require('./src/connectionMonitor');
const banner = require('./src/mainWindowBanner');
const externalLinks = require('./src/externalLinks');

let splashWin = null;
let mainWin   = null;
let companion = null;
let eventStream = null;   // dispose fn for the SSE subscription
let notifierApi = null;   // { handleEvent, dispose }
let monitor = null;       // connection state machine
let bannerApi = null;     // { refreshLocale, dispose }
let externalLinksApi = null; // { dispose }
let currentPort = null;   // port the current pipeline is subscribed to
let restarting = false;   // guards concurrent Restart-button clicks

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
  // macOS: keep the frameless look but restore the native traffic lights
  // (titleBarStyle does that; setWindowButtonVisibility is belt-and-braces).
  // Other platforms stay fully frameless with no window controls.
  const isMac = process.platform === 'darwin';
  splashWin = new BrowserWindow({
    width: 480, height: 520,
    frame: false,
    resizable: false,
    backgroundColor: '#ffffff',
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isMac) splashWin.setWindowButtonVisibility(true);
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
  // The banner is a shell overlay — refresh its message when the user
  // toggles the language while it's visible.
  try { bannerApi?.refreshLocale(); } catch (e) { log('banner refresh failed:', e && e.message); }
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

  // Route http(s) links pointed at any host other than the current dsh
  // instance to the OS default browser, so clicking a docs / repo / social
  // link doesn't navigate our shell away from dsh. Installed BEFORE
  // loadURL so the very first navigation is already guarded. getDshPort
  // reads the module-scoped currentPort so workspace switches and dsh
  // restarts are picked up automatically without re-installing.
  externalLinksApi = externalLinks.install(mainWin.webContents, {
    getDshPort: () => currentPort ?? port,
  });

  mainWin.loadURL(url);
  mainWin.once('ready-to-show', () => {
    splashWin?.close();
    mainWin.show();
    // Fire-and-forget: 5s after the UI is visible, ask the npm registry for
    // the latest @deepseek-ai/dsh and prefetch it into the npx cache. The
    // running dsh keeps its current version; the next launch picks the newer
    // entry via `dshEntryPath()` — no desktop-app reinstall required.
    const rt = getRuntime();
    scheduleSilentUpgrade({
      delayMs: 5000,
      npxPath: rt ? rt.npxPath : undefined,
      env: buildEnv(),
    });
    // Start the notifier + SSE subscription now that we have a live window
    // to focus on click. Both are idempotent to stop (before-quit disposes
    // whatever is set); we also re-init here after each createMain call so
    // a "close all windows → activate again" cycle on macOS gets a fresh
    // connection.
    startEventPipeline(port);
  });
  mainWin.on('closed', () => {
    try { externalLinksApi?.dispose(); } catch (_) { /* ignore */ }
    externalLinksApi = null;
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

/**
 * Boot (or reboot) the notifier + SSE pipeline against the given dsh port.
 * Called once per main-window `ready-to-show`. Both handles are always
 * torn down first so a workspace-switch (which changes `port`) or a macOS
 * "close all windows → activate again" cycle gets a fresh connection.
 */
function startEventPipeline(port) {
  stopEventPipeline();
  currentPort = port;

  monitor = createMonitor();

  notifierApi = notifier.install({
    getMainWindow: () => mainWin,
    translate: (key, params) => t(key, params),
    // Notifications are on by default; a future setting can gate this here.
    isEnabled: () => true,
    // Best-effort: pull the window to the front on click. Any session-level
    // navigation happens through the dsh-api plugin when that endpoint lands.
    onFocusRequest: () => { /* no-op today */ },
  });

  if (mainWin && !mainWin.isDestroyed()) {
    bannerApi = banner.install({
      mainWindow: mainWin,
      monitor,
      translate: (key, params) => t(key, params),
      onRetryClick: () => {
        // apiClient handles auto-retry itself; the button here is really a
        // "user is watching, please hurry up". We reset the monitor so the
        // banner disappears immediately if the next probe wins the race —
        // apiClient will retry within its normal back-off window anyway.
        log('user requested retry — nudging apiClient (monitor stays until onOpen)');
      },
      onRestartClick: () => { void handleManualRestart(); },
    });
  }

  eventStream = openEventStream(port, {
    onEvent: (event, payload) => {
      try { notifierApi?.handleEvent(event, payload); }
      catch (e) { log('notifier: handleEvent threw', e && e.message); }
    },
    onError: (err) => {
      log('sse:', err && err.message);
      monitor?.onError(err);
    },
    onOpen: () => {
      log('sse: connected to :' + port + '/dsh-api/events');
      monitor?.onOpen();
    },
  });
}

function stopEventPipeline() {
  try { eventStream?.(); } catch { /* ignore */ }
  try { notifierApi?.dispose(); } catch { /* ignore */ }
  try { bannerApi?.dispose(); } catch { /* ignore */ }
  try { monitor?.dispose(); } catch { /* ignore */ }
  eventStream = null;
  notifierApi = null;
  bannerApi = null;
  monitor = null;
  currentPort = null;
}

/**
 * Manual dsh restart, triggered by the banner "Restart" button when the
 * connection has been down long enough that automatic reconnect gave up.
 *
 * Sequence:
 *   1. Log intent; guard against double-clicks.
 *   2. Ask dsh.js to kill the current dsh (whether we own it or found it
 *      by port) and spawn a fresh one on the same-or-next-free port.
 *   3. If the port changed, tell the main window to load the new URL
 *      (rare, but happens when the kernel is still holding TIME_WAIT on
 *      the old port). If it didn't change, we deliberately do NOT reload:
 *      the user asked for the connection back, not for their page state
 *      to be blown away.
 *   4. Rewire the SSE pipeline against the new port. The monitor's onOpen
 *      will fire and the banner will disappear.
 */
async function handleManualRestart() {
  if (restarting) { log('restart already in progress; ignoring click'); return; }
  restarting = true;
  const oldPort = currentPort;
  log('manual dsh restart requested; oldPort=' + oldPort);

  try {
    const r = await restartDsh((chunk) => log('dsh(restart): ' + String(chunk).slice(0, 120)));
    if (!r.ok) {
      log('manual restart failed:', r.error);
      // Leave the banner in 'lost' state so the button stays available.
      return;
    }
    log('manual restart succeeded on :' + r.port);
    if (r.port !== oldPort && mainWin && !mainWin.isDestroyed()) {
      // Only reload when the port actually changed — otherwise we honor
      // the "don't reload on reconnect" contract.
      mainWin.loadURL(dshUrl()).catch((e) => log('reload on new port failed:', e && e.message));
    }
    // Rewire against the (possibly new) port. This re-installs the banner
    // too; monitor starts fresh in 'healthy', banner hides immediately.
    startEventPipeline(r.port);
    // Rebuild the menu — capabilities' current-workspace tooltip may have
    // gone stale during the restart window.
    if (mainWin && !mainWin.isDestroyed()) buildMenu(mainWin, splashWin);
  } finally {
    restarting = false;
  }
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
  try { stopEventPipeline(); } catch (_) { /* already down */ }
  try { companion?.stop(); } catch (_) { /* already down */ }
  companion = null;
});
