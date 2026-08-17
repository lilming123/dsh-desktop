/**
 * menu.js — 应用菜单栏（macOS 顶部 / Windows 窗口菜单）
 *
 * 提供两个 File 菜单项：
 *   - Open Folder as Workspace…  (⌘⇧O / Ctrl+Shift+O)
 *   - Add File…                    (⌘O   / Ctrl+O)
 *
 * 选中后把路径注入到 dsh 的输入框（textarea / contenteditable）。
 * macOS 首项必须是 app-name 菜单，否则 File 等后续菜单不显示。
 */

const { app, Menu, dialog } = require('electron');

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
 * @param {BrowserWindow} mainWin  主窗口引用（注入输入用）
 * @param {function} onOpenWorkspace  选了文件夹后的回调（重启 dsh）
 */
function buildMenu(mainWin, onOpenWorkspace) {
  const openWorkspace = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: 'Open Folder as Workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return;
    await onOpenWorkspace(filePaths[0]);
  };

  const openFile = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: 'Add File',
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || !filePaths.length) return;
    const paths = filePaths.map(p => p.replace(/\\/g, '/')).join(' ');
    injectToInput(mainWin, paths);
  };

  const template = [
    // macOS: 首项必须是 app-name 菜单，否则 File 不显示
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
      label: 'File',
      submenu: [
        { label: 'Open Folder as Workspace…', accelerator: 'CmdOrCtrl+Shift+O', click: openWorkspace },
        { label: 'Add File…',                 accelerator: 'CmdOrCtrl+O',       click: openFile },
        { type: 'separator' },
        { label: 'Close Window', role: 'close' },
      ],
    },
    { label: 'Edit',   role: 'editMenu' },
    { label: 'View',   role: 'viewMenu' },
    { label: 'Window', role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
