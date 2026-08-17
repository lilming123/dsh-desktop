/**
 * menu.js — Application menu bar.
 *
 * The menu is a thin routing surface. Every dsh-facing action goes through
 * `src/capabilities.js`, which in turn talks to dsh only through the
 * `dsh-api` plugin over HTTP. Nothing here reaches into dsh internals.
 *
 * Layout (slimmed vs. the pre-refactor version):
 *
 *   [App]                     — macOS only, standard roles
 *   File
 *     Open Folder as Workspace…       ⌘⇧O   (tooltip: current dsh cwd)
 *     Open Recent  ▸ <workspaces from plugin>
 *     ──
 *     Add File…                       ⌘O
 *     ──
 *     Close Window
 *   Language                              — options from i18n.getLangLabels()
 *   Edit                                  — standard role
 *   View                                  — Reload dsh UI (⌘R) + standard roles
 *   Window                                — Show Window (⌘⇧W) + standard roles
 *   Help
 *     Open dsh in Browser
 *     dsh-api Plugin on GitHub
 *
 * Async data (recent workspaces, current cwd) are cached across rebuilds so
 * the menu never regresses to a `…` placeholder once we've seen a real answer.
 */

'use strict';

const { app, Menu, shell } = require('electron');
const { t, getLang, getSupportedLangs, getLangLabels } = require('./i18n');
const capabilities = require('./capabilities');
const pluginClient = require('./pluginClient');
const { log } = require('./logger');

// ── Async-data cache (survives rebuilds; refreshed on every buildMenu call) ──

const cache = {
  recentWorkspaces: null, // array | null (null = never loaded yet)
  currentCwd: null,       // string | null
};

// Build-sequence guard: discard late async results that arrive out of order.
let buildSeq = 0;

/**
 * Build and install the application menu.
 * @param {BrowserWindow} mainWin        main window (unused; kept for arity)
 * @param {BrowserWindow|null} splashWin unused; kept for signature compat
 */
function buildMenu(mainWin, splashWin) { // eslint-disable-line no-unused-vars
  const seq = ++buildSeq;
  const currentLang = getLang();

  // Render immediately with whatever is cached (may be null on first paint).
  render(seq, currentLang);

  // Refresh cache in the background; re-render only if this build is still current.
  Promise.all([pluginClient.listWorkspaces(), pluginClient.workspaceCurrent()])
    .then(([recent, cur]) => {
      if (recent !== null) cache.recentWorkspaces = recent;
      if (cur && cur.cwd) cache.currentCwd = cur.cwd;
      if (seq === buildSeq) render(seq, currentLang);
    })
    .catch((e) => log('menu: async refresh failed', e && e.message));
}

function render(seq, currentLang) {
  if (seq !== buildSeq) return;
  const template = buildTemplate(currentLang);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTemplate(currentLang) {
  const langLabels = getLangLabels();
  const workspaceTip = cache.currentCwd || undefined;

  const langSubmenu = getSupportedLangs().map((lang) => ({
    label: (lang === currentLang ? '✓ ' : '   ') + (langLabels[lang] || lang),
    click: () => { capabilities.setLanguage(lang); },
  }));

  const recentSubmenu = buildRecentSubmenu();

  return [
    ...(process.platform === 'darwin' ? [macAppMenu()] : []),
    fileMenu(recentSubmenu, workspaceTip),
    { label: t('menu.language'), submenu: langSubmenu },
    { label: t('menu.edit'), role: 'editMenu' },
    viewMenu(),
    windowMenu(),
    helpMenu(),
  ];
}

// ── Menu builders ────────────────────────────────────────────────────────────

function macAppMenu() {
  return {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
}

function buildRecentSubmenu() {
  const list = cache.recentWorkspaces;
  if (list === null) return [{ label: '…', enabled: false }];
  if (list.length === 0) return [{ label: t('menu.noRecent'), enabled: false }];
  return list.map((ws) => ({
    label: ws.title || ws.path,
    toolTip: ws.path,
    click: () => { capabilities.openWorkspaceRequested(ws.path); },
  }));
}

function fileMenu(recentSubmenu, workspaceTip) {
  return {
    label: t('menu.file'),
    toolTip: workspaceTip,
    submenu: [
      {
        label: t('menu.openFolder'),
        accelerator: 'CmdOrCtrl+Shift+O',
        toolTip: workspaceTip,
        click: () => { capabilities.openWorkspaceDialog(); },
      },
      { label: t('menu.openRecent'), submenu: recentSubmenu },
      { type: 'separator' },
      {
        label: t('menu.addFile'),
        accelerator: 'CmdOrCtrl+O',
        click: () => { capabilities.pickFilesAndInject(); },
      },
      { type: 'separator' },
      { label: t('menu.closeWindow'), role: 'close' },
    ],
  };
}

function viewMenu() {
  return {
    label: t('menu.view'),
    submenu: [
      {
        label: t('menu.reloadDsh'),
        accelerator: 'CmdOrCtrl+R',
        click: () => { capabilities.reloadWindow(); },
      },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
}

function windowMenu() {
  return {
    label: t('menu.window'),
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      {
        label: t('menu.showWindow'),
        accelerator: 'CmdOrCtrl+Shift+W',
        click: () => { capabilities.showWindow(); },
      },
      ...(process.platform === 'darwin'
        ? [{ type: 'separator' }, { role: 'front' }]
        : [{ type: 'separator' }, { role: 'close' }]),
    ],
  };
}

function helpMenu() {
  return {
    label: t('menu.help'),
    submenu: [
      { label: t('menu.openInBrowser'), click: () => { capabilities.openInBrowser(); } },
      {
        label: t('menu.pluginRepo'),
        click: () => { shell.openExternal('https://github.com/lilming123/dsh-api').catch(() => {}); },
      },
    ],
  };
}

module.exports = { buildMenu };
