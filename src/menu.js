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
 *     Open Folder as Workspace…      ⌘⇧O
 *     Open Recent  ▸ <workspaces from plugin>
 *     ──
 *     Add File…                       ⌘O
 *     ──
 *     Close Window
 *   Language
 *     English / 简体中文
 *   Edit                              (standard)
 *   View                              (standard + Reload dsh UI ⌘R)
 *   Window                            (standard + Show Window ⌘⇧W)
 *   Help
 *     Open dsh in Browser
 *
 * The dedicated "DSH" menu is gone: Reload / Show Window / Open in Browser
 * are ordinary shell operations that belong in the standard View / Window /
 * Help positions. "Current workspace" is now a tooltip on the File menu.
 */

'use strict';

const { app, Menu, shell } = require('electron');
const { t, getLang, getSupportedLangs } = require('./i18n');
const capabilities = require('./capabilities');

/** Menu-rebuild sequence guard: discard late async results that arrive out of order. */
let buildSeq = 0;

/**
 * Build and install the application menu.
 * @param {BrowserWindow} mainWin        main window (required for role-based items)
 * @param {BrowserWindow|null} splashWin unused; kept for signature compat with main.js
 */
function buildMenu(mainWin, splashWin) { // eslint-disable-line no-unused-vars
  const seq = ++buildSeq;
  const currentLang = getLang();

  const render = (recentWorkspaces) => {
    if (seq !== buildSeq) return; // A newer build has started; discard.
    const template = buildTemplate(recentWorkspaces, currentLang);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  // Render once with a loading placeholder, then rebuild once the plugin
  // answers. If the plugin isn't reachable (dsh reused without plugin), the
  // list degrades to an empty submenu.
  render(null);
  capabilities.fetchWorkspaceList()
    .then((list) => { render(list === null ? [] : list); })
    .catch(() => { render([]); });
}

function buildTemplate(recentWorkspaces, currentLang) {
  const { LANG_LABELS } = capabilities;
  const state = capabilities.getState();
  const workspaceTip = state.workspace || state.cwd || undefined;

  const langSubmenu = getSupportedLangs().map(lang => ({
    label: (lang === currentLang ? '✓ ' : '   ') + LANG_LABELS[lang],
    click: () => { capabilities.setLanguage(lang); },
  }));

  const recentSubmenu = recentWorkspaces === null
    ? [{ label: '…', enabled: false }]
    : recentWorkspaces.length
      ? recentWorkspaces.map(ws => ({
          label: ws.title || ws.path,
          toolTip: ws.path,
          click: () => { capabilities.openWorkspaceRequested(ws.path); },
        }))
      : [{ label: t('menu.noRecent'), enabled: false }];

  return [
    ...(process.platform === 'darwin' ? [{
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
    }] : []),

    {
      label: t('menu.file'),
      toolTip: workspaceTip,
      submenu: [
        {
          label: t('menu.openFolder'),
          accelerator: 'CmdOrCtrl+Shift+O',
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
    },

    { label: t('menu.language'), submenu: langSubmenu },

    { label: t('menu.edit'), role: 'editMenu' },

    {
      // Standard View menu, with "Reload dsh UI" replacing the previous DSH menu item.
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
    },

    {
      // Standard Window menu, with "Show Window" replacing the previous DSH menu item.
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
    },

    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.openInBrowser'),
          click: () => { capabilities.openInBrowser(); },
        },
        {
          label: t('menu.pluginRepo'),
          click: () => { shell.openExternal('https://github.com/lilming123/dsh-api').catch(() => {}); },
        },
      ],
    },
  ];
}

module.exports = { buildMenu };
