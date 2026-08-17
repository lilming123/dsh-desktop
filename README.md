# DeepSeek Harness Desktop

English | [中文](README.zh.md)

A native desktop wrapper for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web UI.

Under the hood it is a thin Electron shell that (1) makes sure `dsh` is installed, running, and reused across launches; (2) loads its Web UI in a native window; and (3) exposes the shell-only capabilities (folder picker, workspace switching, window focus, input injection…) as a **companion** that the [`dsh-api` plugin](https://github.com/lilming123/dsh-api) can bridge to.

<p align="center">
  <img src="icon.png" width="120">
</p>

## Design in one paragraph

Everything that reaches into `dsh` internals is done through a single seam: the [`dsh-api` plugin](https://github.com/lilming123/dsh-api). The plugin (bundled with the app under `dsh-plugin/`) is installed into the dsh web profile on every launch and loaded via `--patch`, so `dsh` publishes an HTTP control plane at `http://127.0.0.1:<port>/dsh-api/*`. Language switching, workspace listing, "open workspace", window control — the desktop menu never talks to dsh directly; it goes through this plugin. The plugin, in turn, delegates the desktop-only operations back to this app through a local companion service on a random port. The result: one plugin, one integration surface, no back doors into dsh's files.

## Features

- **Auto environment check** — installs `@deepseek-ai/dsh` on first run; subsequent launches use a marker file + FS check (< 5 ms)
- **Dynamic port** — defaults to 3080, auto-increments to find a free port in 3080–3180
- **Server reuse** — scans ports for an already-running dsh (verifies response signature), reuses it on any port
- **Detached process** — dsh runs detached; closing the app doesn't kill the service; next launch is instant
- **Fast startup** — calls the cached `bin.js` directly (~1.5 s) instead of `npx exec` (~12 s)
- **Workspace switching** — `File → Open Folder as Workspace…` restarts dsh with a new cwd; `File → Open Recent` pulls the workspace list from `dsh-api`
- **Multilingual** — English / Simplified Chinese, switchable via menu. Writes go through `dsh-api`'s `settings` service; the shell polls the same endpoint to stay in sync
- **HTTP control plane** — everything the app can do is also reachable at `http://127.0.0.1:<port>/dsh-api/*`; see [dsh-api](https://github.com/lilming123/dsh-api) for the full API
- **Cross-platform** — macOS (arm64/x64) + Windows (x64 NSIS installer)

## Install

### Build from source

```bash
git clone https://github.com/lilming123/dsh-desktop.git
cd dsh-desktop
npm install

# macOS
npm run pack:mac    # → dist/mac-arm64/DeepSeek Harness.app

# Windows
npm run pack:win    # → dist/win-unpacked/DeepSeek Harness.exe
```

Drop the `.app` into `/Applications` (macOS), or run the `.exe` installer (Windows).

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 18 (required at runtime; the app checks on launch)
- First launch auto-installs `@deepseek-ai/dsh` (cached in `~/.npm/_npx/`)

## Menu

Slimmed down after the refactor — dsh-facing actions go through the plugin, standard Electron roles cover the rest:

| Menu | Item | Notes |
|---|---|---|
| **File** | Open Folder as Workspace… | ⌘⇧O / Ctrl+Shift+O — picks a folder, restarts dsh with the new cwd |
| | Open Recent ▸ | Populated from `GET /dsh-api/workspace/list` |
| | Add File… | ⌘O / Ctrl+O — inject file paths into the dsh input |
| | Close Window | Standard role |
| **Language** | English / 简体中文 | Goes through `POST /dsh-api/language`; dsh clients refresh live |
| **Edit** | Standard role | Undo / redo / cut / copy / paste / select all |
| **View** | Reload dsh UI | ⌘R / Ctrl+R — reload the WebView |
| | Force Reload / Toggle DevTools / Zoom / Fullscreen | Standard roles |
| **Window** | Show Window | ⌘⇧W / Ctrl+Shift+W |
| | Minimize / Zoom / Front | Standard roles |
| **Help** | Open dsh in Browser | Opens the current dsh URL in the default browser |
| | dsh-api Plugin on GitHub | Link to the plugin repo |

## The `dsh-api` plugin

The desktop app ships a copy of the plugin under `dsh-plugin/`; it is installed into `$DSH_HOME/profiles/web/dsh-api/` and loaded via `--patch` every time this app starts dsh. External programs only need to know the dsh port:

```
http://127.0.0.1:<port>/dsh-api/...
```

Two capability layers:

- **dsh-native** (always available): `/health`, `/language` (GET/POST), `/workspace/list`, `/workspace/current`
- **companion-bridged** (available only when this app is running): `/workspace/open`, `/input/paste`, `/window/show`, `/window/reload`, `/companion/state`, `/app/quit`

Examples:

```bash
# Current language
curl http://127.0.0.1:3080/dsh-api/language

# Switch language (dsh-native, works without the desktop app)
curl -X POST http://127.0.0.1:3080/dsh-api/language \
  -H 'content-type: application/json' -d '{"language":"en"}'

# Open a workspace (needs the desktop companion — the app must be running)
curl -X POST http://127.0.0.1:3080/dsh-api/workspace/open \
  -H 'content-type: application/json' -d '{"path":"/path/to/project"}'

# Paste text into the dsh input box
curl -X POST http://127.0.0.1:3080/dsh-api/input/paste \
  -H 'content-type: application/json' -d '{"text":"summarize this repo"}'
```

Security:

- dsh binds `127.0.0.1` only — the API is machine-local
- Mutating requests validate `Origin`: browser cross-site requests from non-loopback origins are rejected with `403`
- The companion port and token are random per launch, written to `$DSH_HOME/dsh-api-companion.json`, and removed on quit
- Language switching works even when dsh was started outside the app; companion-only routes return `503` in that case (graceful degradation)

Full plugin docs: <https://github.com/lilming123/dsh-api>

### Reopening after close

dsh is detached, so it survives app quit. Next launch scans and connects instantly. To fully stop dsh:

```bash
# macOS
lsof -ti tcp:3080 | xargs kill -9

# Windows
netstat -ano | findstr :3080 | findstr LISTENING
# then: taskkill /F /PID <pid>
```

## Configuration

No extra config — dsh manages its own settings. This app only launches dsh and loads its UI.

- **Language memory** — `~/.dsh-desktop.lang` (last-known good; used before dsh answers on startup)
- **Startup logs** — `~/.dsh-desktop.log` (timestamped, one file per launch)

```bash
tail -f ~/.dsh-desktop.log
```

## Project structure

```
dsh-desktop/
├── main.js               # Electron main: windows + setup + companion wiring
├── preload.js            # contextBridge: splash comms (progress / i18n / retry)
├── splash.html           # Splash UI (white bg + progress + logo + i18n)
├── icon.png              # App icon (512×512)
├── package.json          # Deps + electron-builder cross-platform config
├── dsh-plugin/           # Bundled copy of the dsh-api plugin (installed on every launch)
│   ├── index.mjs         #   Upstream: github.com/lilming123/dsh-api
│   ├── patch.yml         #   `--patch` template
│   └── README.md
└── src/
    ├── paths.js          # Cross-platform node/npx/dsh/profile path resolution
    ├── logger.js         # ~/.dsh-desktop.log logger
    ├── i18n.js           # Local i18n; polls the plugin for authoritative language
    ├── pluginClient.js   # HTTP client for /dsh-api/* (the only seam into dsh)
    ├── dsh.js            # dsh lifecycle (port scan / spawn / patch install / workspace switch)
    ├── install.js        # dsh install detection (marker + FS fast check)
    ├── capabilities.js   # Shared capability layer (menu + companion)
    ├── companion.js      # Local companion HTTP service (token auth, /companion/*)
    ├── menu.js           # Application menu (File / Language / Edit / View / Window / Help)
    ├── setup.js          # 4-step startup pipeline
    └── locales/          # Language packs
        ├── en.json
        └── zh.json
```

## Development

```bash
npm install
npm start            # run Electron directly (no packaging, for debugging)
tail -f ~/.dsh-desktop.log
```

## Technical decisions

| Problem | Solution | Why |
|---|---|---|
| `npx exec` slow (~12 s) | Call cached `bin.js` directly (~1.5 s) | Bypass npm exec resolution |
| Install check slow | `~/.dsh-desktop.installed` marker + FS check | Skip ~8 s `npx --version` |
| Electron PATH stripped → `node: not found` | `buildEnv()` prepends node/npx dirs | Bundle doesn't inherit shell PATH |
| Port 3080 occupied | Auto-increment 3080 → 3180 | No conflict, seamless |
| Repeated dsh startup | Scan ports and verify response signature | Cross-port reuse, instant connect |
| App quit kills dsh | `detached: true` + `unref()` | dsh survives, next launch instant |
| Multilingual | Local `src/i18n.js` + `dsh-api` plugin as source of truth | Menu / splash stay in sync with dsh's own locale |
| External / same-machine callers of desktop capabilities | Everything at `http://127.0.0.1:<port>/dsh-api/*` via one plugin | One integration surface, generic across host types |
| Plugin ships with the app | Installed into the profile + `dsh web --patch` overlay | User's own `cordis.patch.yml` untouched; upgrades follow the app |
| Language applies instantly | Plugin uses `settings.update('locale')`; clients watch the setting | No full reload |
| No direct access to dsh files | All dsh state changes flow through the plugin | Clean seam, easy to audit |

## License

MIT
