# DeepSeek Harness Desktop

[English](README.md) | 中文

原生桌面应用封装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI。

用 Electron WebView 加载本地运行的 dsh 服务，启动时自动检测环境——若本机未安装 `@deepseek-ai/dsh` 则从 npm 拉取安装，已安装则直接复用，已运行则秒开。

<p align="center">
  <img src="icon.png" width="120">
</p>

## 特性

- **自动环境检测** — 首次启动自动 `npx --yes @deepseek-ai/dsh` 安装，后续用 marker 文件 + FS 检查秒过
- **动态端口** — 默认 3080，被占用自动递增找空闲端口（3080–3180）
- **服务复用** — 扫描端口找已运行的 dsh（验证响应特征），找到就复用，不限 3080
- **独立存活** — dsh 以 detached 进程运行，关闭 app 不杀服务，下次打开秒连
- **快速启动** — 优先用 `node bin.js` 直接调用（~1.5s），绕过 `npx exec` 的 ~12s 开销
- **工作区切换** — `文件 → 打开文件夹作为工作区…` 选文件夹后重启 dsh 并切到新目录
- **多语种** — 英语、简体中文、繁体中文，菜单可切换，语言持久化
- **双平台** — macOS（arm64/x64）+ Windows（x64 NSIS 安装包）

## 安装

### 从源码构建

```bash
git clone https://github.com/lilming123/dsh-desktop.git
cd dsh-desktop
npm install

# macOS
npm run pack:mac    # 产出 dist/mac-arm64/DeepSeek Harness.app

# Windows
npm run pack:win    # 产出 dist/win-unpacked/DeepSeek Harness.exe
```

打包产物在 `dist/` 下，把 `.app` 拖进 `/Applications`（macOS）或运行 `.exe` 安装（Windows）即可。

### 依赖

- [Node.js](https://nodejs.org) ≥ 18（运行时需要，app 启动会检测）
- 首次启动会自动安装 `@deepseek-ai/dsh`（通过 npx 缓存到 `~/.npm/_npx/`）

## 使用

启动应用后：

1. **启动页** — 显示环境检查 → dsh 安装 → 服务启动 → 打开界面 四步进度
2. **主窗口** — 加载 dsh Web UI（`http://127.0.0.1:<port>`）
3. **菜单栏**
   - `文件 → 打开文件夹作为工作区…`（⌘⇧O / Ctrl+Shift+O）— 选文件夹作为工作区，dsh 重启并切换
   - `文件 → 添加文件…`（⌘O / Ctrl+O）— 选文件，路径注入到 dsh 输入框
   - `语言 → English / 简体中文 / 繁體中文` — 切换界面语言，立即生效

### 关闭后重新打开

dsh 进程是 detached 的，关掉 app 后 dsh 继续在后台跑。下次打开 app 时扫描端口找到已运行的 dsh，直接打开界面（秒开）。如果想彻底停掉 dsh：

```bash
# macOS
lsof -ti tcp:3080 | xargs kill -9

# Windows
netstat -ano | findstr :3080 | findstr LISTENING
# 然后 taskkill /F /PID <pid>
```

## 配置

应用不需要额外配置，dsh 的配置走它自己的机制。本应用只负责拉起 dsh 服务并加载界面。

### 语言

界面语言自动检测系统语言，也可通过菜单 `语言` 手动切换。选择会持久化到 `~/.dsh-desktop.lang`，下次启动记住。

### 日志

启动日志写到 `~/.dsh-desktop.log`，带时间戳，排查启动问题用：

```bash
tail -f ~/.dsh-desktop.log
```

## 项目结构

```
dsh-desktop/
├── main.js           # 主进程入口：窗口生命周期 + setup 编排
├── preload.js        # contextBridge：splash 页通信（progress / i18n / retry）
├── splash.html       # 启动页 UI（白底 + 进度条 + 蓝色鲸鱼 logo + i18n）
├── icon.png          # 应用图标（512×512）
├── package.json      # 依赖 + electron-builder 双平台配置
├── README.md         # 英文文档
├── README.zh.md      # 中文文档
└── src/
    ├── paths.js      # 平台无关的 node/npx/dsh 路径解析
    ├── logger.js     # 轻量日志器（stdout + ~/.dsh-desktop.log）
    ├── i18n.js       # 国际化模块（en/zh/zh-TW，语言持久化）
    ├── dsh.js        # dsh 服务生命周期（动态端口/复用/启动/工作区切换）
    ├── install.js    # dsh 安装检测与安装（marker + FS 快速检查）
    ├── menu.js       # 应用菜单（文件/语言/编辑/视图/窗口）
    ├── setup.js      # 启动校验流程编排（四步顺序执行）
    └── locales/      # 语言包
        ├── en.json
        ├── zh.json
        └── zh-TW.json
```

## 开发

```bash
npm install
npm start            # 直接跑 Electron（不打包，调试用）
```

调试时看实时日志：

```bash
tail -f ~/.dsh-desktop.log
```

## 技术决策

| 问题 | 方案 | 原因 |
|---|---|---|
| `npx exec` 启动慢（~12s） | 直接 `node bin.js` 调缓存入口（~1.5s） | 绕过 npm exec 的包解析开销 |
| 每次检查安装慢 | `~/.dsh-desktop.installed` marker + FS 检查 | 避免 `npx --version` 的 ~8s |
| Electron PATH 精简导致 `node: not found` | `buildEnv()` 补回 node/npx 目录 | app bundle 不继承完整 shell PATH |
| 端口 3080 被占 | 从 3080 起递增找空闲端口 | 避免冲突，用户无感 |
| 重复启动 dsh | 扫端口找已运行 dsh（验证响应特征） | 支持跨端口复用，秒开 |
| 关 app 杀 dsh | `detached: true` + `unref()` | dsh 独立存活，下次秒连 |
| 多语种 | `src/i18n.js` + `locales/*.json` + 菜单切换 | 支持 en/zh/zh-TW，持久化 |

## License

MIT
