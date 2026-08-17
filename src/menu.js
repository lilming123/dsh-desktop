/**
 * menu.js — 应用菜单栏（macOS 顶部 / Windows 窗口菜单）
 *
 * 菜单项全部走 src/capabilities.js 统一能力层：
 *   - File > Open Folder as Workspace…  (⌘⇧O / Ctrl+Shift+O)
 *   - File > Open Recent > <工作区列表>    （来自 dsh 插件 API，异步刷新）
 *   - File > Add File…                    (⌘O   / Ctrl+O)
 *   - Language > English / 简体中文       （优先走 dsh 插件 settings 服务）
 *   - DSH > 当前工作区 / 重载 / 显示窗口 / 浏览器打开 / 开发者工具
 *
 * 菜单在语言切换 / 最近工作区列表到达时会重建。
 */

'use strict';

const { app, Menu } = require('electron');
const { t, getLang, getSupportedLangs } = require('./i18n');
const capabilities = require('./capabilities');

/** 菜单重建序号：防止异步回来的最近工作区列表覆盖更新的重建 */
let buildSeq = 0;

/**
 * 构建并设置应用菜单。
 * @param {BrowserWindow} mainWin        主窗口引用
 * @param {BrowserWindow|null} splashWin 启动页引用（语言切换时刷新文案）
 */
function buildMenu(mainWin, splashWin) {
  const seq = ++buildSeq;
  const currentLang = getLang();

  const render = (recentWorkspaces) => {
    if (seq !== buildSeq) return; // 已有更新的重建，丢弃过期结果
    const template = buildTemplate(mainWin, recentWorkspaces, currentLang);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  // 先渲染（最近工作区未就绪时显示占位），再异步拉取列表并重建
  render(null);
  capabilities.fetchWorkspaceList().then((list) => {
    if (list !== null) render(list);
  }).catch(() => {});
}

/** 组装菜单模板 */
function buildTemplate(mainWin, recentWorkspaces, currentLang) {
  const LANG_LABELS = capabilities.LANG_LABELS;
  const state = capabilities.getState();

  const langSubmenu = getSupportedLangs().map(lang => ({
    label: (lang === currentLang ? '✓ ' : '   ') + LANG_LABELS[lang],
    click: () => { capabilities.setLanguage(lang); },
  }));

  // File > Open Recent：来自 dsh 工作区注册表（插件 API）
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
    // macOS: 首项必须是 app-name 菜单
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
      submenu: [
        { label: t('menu.openFolder'), accelerator: 'CmdOrCtrl+Shift+O',
          click: () => { capabilities.openWorkspaceDialog(); } },
        {
          label: t('menu.openRecent'),
          submenu: recentSubmenu,
        },
        { type: 'separator' },
        { label: t('menu.addFile'), accelerator: 'CmdOrCtrl+O',
          click: () => { capabilities.pickFilesAndInject(); } },
        { type: 'separator' },
        { label: t('menu.closeWindow'), role: 'close' },
      ],
    },
    {
      label: t('menu.language'),
      submenu: langSubmenu,
    },
    {
      // dsh 内部能力（与插件 API 对齐，外部应用也可通过 HTTP 调用）
      label: t('menu.dsh'),
      submenu: [
        {
          label: t('menu.currentWorkspace'),
          enabled: false,
          toolTip: state.workspace || state.cwd || undefined,
        },
        { type: 'separator' },
        { label: t('menu.reloadDsh'), accelerator: 'CmdOrCtrl+R',
          click: () => { capabilities.reloadWindow(); } },
        { label: t('menu.showWindow'), accelerator: 'CmdOrCtrl+Shift+W',
          click: () => { capabilities.showWindow(); } },
        { label: t('menu.openInBrowser'),
          click: () => { capabilities.openInBrowser(); } },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { label: t('menu.edit'),   role: 'editMenu' },
    { label: t('menu.view'),   role: 'viewMenu' },
    { label: t('menu.window'), role: 'windowMenu' },
  ];
}

module.exports = { buildMenu };
