# DeepSeek Harness Desktop

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）Web UI 的原生桌面壳。

底层是一个薄的 Electron 壳：(1) 确保 `dsh` 已安装、正在运行、多次启动之间可复用；(2) 在原生窗口里加载它的 Web UI；(3) 把「桌面独占的能力」（选择文件夹、切换工作区、聚焦窗口、注入输入…）作为 **companion** 暴露给 [`dsh-api` 插件](https://github.com/lilming123/dsh-api) 代理。

<p align="center">
  <img src="icon.png" width="120">
</p>

## 一段话讲清架构

所有需要访问 `dsh` 内部的操作只走一个接口——[`dsh-api` 插件](https://github.com/lilming123/dsh-api)。桌面 app 打包了插件源码在 `dsh-plugin/`，每次启动都把它安装进 dsh 的 web profile 并用 `--patch` 加载。dsh 于是在 `http://127.0.0.1:<port>/dsh-api/*` 暴露一整套 HTTP 控制面。切换语言、列工作区、打开工作区、窗口控制——桌面菜单永远不直接读写 dsh 的文件，而是走这套 HTTP。桌面独占的能力反过来通过一个本地 companion 服务提供给插件调用。结果：**一个插件、一个集成面、没有绕过 dsh 的后门**。

## 特性

- **自动环境检查** — 首次启动安装 `@deepseek-ai/dsh`；之后用 marker + FS 检查（< 5 ms）
- **动态端口** — 默认 3080，被占用则在 3080–3180 内递增找空闲端口
- **服务复用** — 扫描端口找已运行的 dsh（校验响应特征），任意端口都能复用
- **detached 进程** — dsh 以 detached 启动，关掉 app 不会杀 dsh，下次启动秒开
- **快速启动** — 直接跑缓存里的 `bin.js`（~1.5 秒），比 `npx exec`（~12 秒）快 8 倍
- **切换工作区** — `文件 → 打开文件夹作为工作区…` 用新 cwd 重启 dsh；`最近工作区` 由 `dsh-api` 提供
- **多语言** — 中英文，菜单切换。写走 `dsh-api` 的 `settings` 服务；壳自身通过轮询同一接口保持同步
- **HTTP 控制面** — app 能做的都可以在 `http://127.0.0.1:<port>/dsh-api/*` 调到；接口详情见 [dsh-api](https://github.com/lilming123/dsh-api)
- **跨平台** — macOS（arm64/x64）+ Windows（x64 NSIS 安装包）

## 安装

### 从源码构建

```bash
git clone https://github.com/lilming123/dsh-desktop.git
cd dsh-desktop
npm install

# macOS
npm run pack:mac    # → dist/mac-arm64/DeepSeek Harness.app

# Windows
npm run pack:win    # → dist/win-unpacked/DeepSeek Harness.exe
```

macOS 拖进 `/Applications`；Windows 运行 `.exe` 安装器。

### 前置条件

- [Node.js](https://nodejs.org) ≥ 18（运行时需要，app 启动会检查）
- 首次启动自动安装 `@deepseek-ai/dsh`（缓存在 `~/.npm/_npx/`）

## 菜单

重构之后菜单变薄了——dsh 相关操作走插件，其它交给标准 Electron 角色：

| 菜单 | 项目 | 说明 |
|---|---|---|
| **文件** | 打开文件夹作为工作区… | ⌘⇧O / Ctrl+Shift+O — 选目录，用新 cwd 重启 dsh |
| | 打开最近的工作区 ▸ | 数据来自 `GET /dsh-api/workspace/list` |
| | 添加文件… | ⌘O / Ctrl+O — 把文件路径注入 dsh 输入框 |
| | 关闭窗口 | 标准角色 |
| **语言** | English / 简体中文 | 走 `POST /dsh-api/language`；dsh 客户端自动重渲染 |
| **编辑** | 标准角色 | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 |
| **视图** | 重载 dsh 界面 | ⌘R / Ctrl+R — 重载 WebView |
| | 强制重载 / 开发者工具 / 缩放 / 全屏 | 标准角色 |
| **窗口** | 显示窗口 | ⌘⇧W / Ctrl+Shift+W |
| | 最小化 / 缩放 / 前置 | 标准角色 |
| **帮助** | 在浏览器中打开 dsh | 用默认浏览器打开当前 dsh URL |
| | dsh-api 插件 GitHub 仓库 | 跳转插件仓库 |

## `dsh-api` 插件

桌面 app 在 `dsh-plugin/` 携带了插件的一份副本；每次启动 dsh 时都会安装到 `$DSH_HOME/profiles/web/dsh-api/` 并通过 `--patch` 加载。外部程序只需要知道 dsh 端口：

```
http://127.0.0.1:<port>/dsh-api/...
```

两层能力：

- **dsh 原生**（始终可用）：`/health`、`/language`（GET/POST）、`/workspace/list`、`/workspace/current`
- **companion 桥接**（仅当本 app 在运行时可用）：`/workspace/open`、`/input/paste`、`/window/show`、`/window/reload`、`/companion/state`、`/app/quit`

示例：

```bash
# 当前语言
curl http://127.0.0.1:3080/dsh-api/language

# 切换语言（原生能力，不依赖桌面 app）
curl -X POST http://127.0.0.1:3080/dsh-api/language \
  -H 'content-type: application/json' -d '{"language":"zh"}'

# 打开工作区（需要桌面 companion —— app 必须在运行）
curl -X POST http://127.0.0.1:3080/dsh-api/workspace/open \
  -H 'content-type: application/json' -d '{"path":"/path/to/project"}'

# 向 dsh 输入框注入文本
curl -X POST http://127.0.0.1:3080/dsh-api/input/paste \
  -H 'content-type: application/json' -d '{"text":"summarize this repo"}'
```

安全：

- dsh 只绑定 `127.0.0.1`，接口仅本机可达
- 写接口校验 `Origin`：非回环源浏览器请求返回 `403`
- Companion 每次启动随机 token + 端口，写在 `$DSH_HOME/dsh-api-companion.json`，退出时删除
- 语言切换在 dsh 被外部启动（app 未运行）时依然可用；companion 相关接口在这种情形下返回 `503`（优雅降级）

完整插件文档：<https://github.com/lilming123/dsh-api>

### 关闭后再打开

dsh 是 detached 的，能在 app 退出后继续存在。下次启动秒连。要完全停掉 dsh：

```bash
# macOS
lsof -ti tcp:3080 | xargs kill -9

# Windows
netstat -ano | findstr :3080 | findstr LISTENING
# then: taskkill /F /PID <pid>
```

## 配置

不需要额外配置——dsh 自己管自己的设置，本 app 只负责启动 dsh 并加载它的 UI。

- **语言记忆** — `~/.dsh-desktop.lang`（最后一次的选择，用于 dsh 未起来时的默认值）
- **启动日志** — `~/.dsh-desktop.log`（带时间戳，每次启动覆盖）

```bash
tail -f ~/.dsh-desktop.log
```

## 项目结构

```
dsh-desktop/
├── main.js               # 主进程：窗口 + setup + companion 装配
├── preload.js            # contextBridge：进度 / i18n / 重试
├── splash.html           # 启动页（白底 + 进度条 + logo + i18n）
├── icon.png              # 应用图标（512×512）
├── package.json          # 依赖 + electron-builder 跨平台配置
├── dsh-plugin/           # 打包内的 dsh-api 插件副本（每次启动都会安装）
│   ├── index.mjs         #   上游：github.com/lilming123/dsh-api
│   ├── patch.yml         #   `--patch` 模板
│   └── README.md
└── src/
    ├── paths.js          # 跨平台 node/npx/dsh/profile 路径解析
    ├── logger.js         # ~/.dsh-desktop.log 日志器
    ├── i18n.js           # 本地 i18n；轮询插件拿权威语言
    ├── pluginClient.js   # /dsh-api/* HTTP 客户端（访问 dsh 的唯一接口）
    ├── dsh.js            # dsh 生命周期（端口扫描 / 启动 / patch 安装 / 切工作区）
    ├── install.js        # dsh 安装检测（marker + FS 快检）
    ├── capabilities.js   # 共享能力层（菜单 + companion 共用）
    ├── companion.js      # 本地 companion HTTP 服务（token 鉴权，/companion/*）
    ├── menu.js           # 菜单（文件 / 语言 / 编辑 / 视图 / 窗口 / 帮助）
    ├── setup.js          # 四步启动流水线
    └── locales/          # 语言包
        ├── en.json
        └── zh.json
```

## 开发

```bash
npm install
npm start            # 直接跑 Electron（不打包，调试用）
tail -f ~/.dsh-desktop.log
```

## 技术决策

| 问题 | 方案 | 原因 |
|---|---|---|
| `npx exec` 慢（~12 秒） | 直接跑缓存里的 `bin.js`（~1.5 秒） | 绕过 npm exec 的包解析 |
| 安装检查慢 | `~/.dsh-desktop.installed` marker + FS 检查 | 免掉 ~8 秒的 `npx --version` |
| Electron PATH 精简 → `node: not found` | `buildEnv()` 追加 node/npx 目录 | app bundle 不继承 shell PATH |
| 端口 3080 被占 | 3080 → 3180 递增找空闲 | 用户无感 |
| 重复启动 dsh | 扫端口 + 响应特征校验 | 跨端口复用，秒连 |
| app 退出会杀 dsh | `detached: true` + `unref()` | dsh 存活，下次启动秒开 |
| 多语言 | 本地 `src/i18n.js` + `dsh-api` 插件作为权威 | 菜单 / splash 与 dsh 内部一致 |
| 外部或同机应用要调用桌面能力 | 统一 `http://127.0.0.1:<port>/dsh-api/*` | 一个接入面，不绑桌面壳 |
| 插件跟随 app 一起分发 | 装进 profile + `dsh web --patch` 叠加 | 用户 `cordis.patch.yml` 不受影响；插件随 app 升级 |
| 语言即时生效 | 插件用 `settings.update('locale')`，客户端订阅 | 不用整页 reload |
| 不直接访问 dsh 文件 | 所有 dsh 状态改动只经过插件 | 一个干净的接缝，可审计 |

## License

MIT
