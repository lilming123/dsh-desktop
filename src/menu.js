/**
 * menu.js — 应用菜单栏（macOS 顶部 / Windows 窗口菜单）
 *
 * 提供三个主功能：
 *   - File > Open Folder as Workspace…  (⌘⇧O / Ctrl+Shift+O)
 *   - File > Add File…                    (⌘O   / Ctrl+O)
 *   - Language > English / 简体中文 / 繁體中文
 *
 * 选中文件后把路径注入到 dsh 的输入框（textarea / contenteditable）。
 * 切换语言后重建菜单 + 通知启动页更新文案。
 */

const { app, Menu, dialog } = require('electron');
const { t, getLang, setLang, getSupportedLangs } = require('./i18n');

const LANG_LABELS = { 'en': 'English', 'zh': '简体中文' };

/** 把文本注入到当前激活的输入元素 */
function injectToInput(mainWin, text) {
  if (!mainWin?.webContents) return;
  mainWin.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
      if (!el) return;
      el.focus();
      const v = ${JSON.stringify(text)};
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const pos = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, pos) + v + el.value.slice(pos);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, v);
      }
    })();
  `).catch(() => {});
}

/**
 * 构建并设置应用菜单。
 * @param {BrowserWindow} mainWin        主窗口引用
 * @param {BrowserWindow|null} splashWin 启动页引用（语言切换时刷新文案）
 * @param {function} onOpenWorkspace     选了文件夹后的回调
 */
function buildMenu(mainWin, splashWin, onOpenWorkspace) {
  const openWorkspace = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: t('menu.openFolder'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return;
    await onOpenWorkspace(filePaths[0]);
  };

  const openFile = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: t('menu.addFile'),
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || !filePaths.length) return;
    const paths = filePaths.map(p => p.replace(/\\/g, '/')).join(' ');
    injectToInput(mainWin, paths);
  };

  const currentLang = getLang();

  // Language 子菜单（带 ✓ 标记当前选中）
  // Language 子菜单（带 ✓ 标记当前选中）
  const langSubmenu = getSupportedLangs().map(lang => ({
    label: (lang === currentLang ? '✓ ' : '   ') + LANG_LABELS[lang],
    click: () => {
      try {
        setLang(lang);
        // 重建菜单以刷新语言标签（如 File/Edit 等）
        buildMenu(mainWin, splashWin, onOpenWorkspace);
      } catch (e) {
        // 语言已切换成功；UI 局部刷新失败不影响功能
        console.error('[menu] lang switch UI refresh failed:', e && e.message);
      }
    },
  }));

  const template = [
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
        { label: t('menu.openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: openWorkspace },
        { label: t('menu.addFile'),    accelerator: 'CmdOrCtrl+O',       click: openFile },
        { type: 'separator' },
        { label: t('menu.closeWindow'), role: 'close' },
      ],
    },
    {
      label: t('menu.language'),
      submenu: langSubmenu,
    },
    { label: t('menu.edit'),   role: 'editMenu' },
    { label: t('menu.view'),   role: 'viewMenu' },
    { label: t('menu.window'), role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
