/**
 * dsh-api — DeepSeek Harness HTTP control-plane plugin
 *
 * 把 dsh 自身的内部能力以 HTTP 路由的形式挂到 dsh 的 webServer 上（前缀
 * `/dsh-api`），让**同机的任何应用**（浏览器扩展、CLI 工具、桌面壳、编辑器
 * 集成等）都可以通过一个稳定的入口调用 dsh，而不必去理解 dsh 的进程模型或
 * 各服务的 in-process 接口。
 *
 * ── 两类能力 ──────────────────────────────────────────────────────────────────
 *
 *   1. dsh-native（**始终可用**，只要插件加载了）：
 *        - GET  /dsh-api/health              存活探针
 *        - GET  /dsh-api/language            读 locale.preference
 *        - POST /dsh-api/language            写 locale.preference（settings 服务）
 *        - GET  /dsh-api/workspace/list      列出工作区注册表
 *        - GET  /dsh-api/workspace/current   当前 cwd / dsh 端口 / companion 状态
 *
 *   2. companion-bridged（**需要同机 companion 进程注册**）：
 *        - GET  /dsh-api/companion/state     companion 状态快照
 *        - POST /dsh-api/workspace/open      打开工作区（会重启 dsh，需 companion）
 *        - POST /dsh-api/input/paste         向 dsh Web UI 注入文本
 *        - POST /dsh-api/window/show|reload  host 窗口控制
 *        - POST /dsh-api/app/quit            退出 host 应用
 *
 *   Companion 通过写发现文件 `$DSH_HOME/dsh-api-companion.json` 注册；
 *   文件格式 `{ port, token, pid, ...state }`。不存在 / 端口不可达时，
 *   companion 类接口一律返回 503（native 类接口不受影响）。
 *
 * ── 安全 ─────────────────────────────────────────────────────────────────────
 *
 *   - dsh 的 webServer 只绑定 127.0.0.1，本插件复用同一 socket
 *   - 写接口（`POST`）校验 `Origin`：允许无 Origin（curl/CLI）与回环源；
 *     非回环 Origin 一律 403，防止其他站点在浏览器中偷偷调用
 *   - Companion 代理携带发现文件里的随机 token，companion 侧强制校验
 *
 * ── 安装 ─────────────────────────────────────────────────────────────────────
 *
 *   1) 拷贝 index.mjs 到某个 dsh profile 目录，例如：
 *        $DSH_HOME/profiles/web/dsh-api/index.mjs
 *   2) 写一份 patch 覆盖层（`--patch`）：
 *        - insert:
 *            - id: dsh-api
 *              name: ./dsh-api/index.mjs
 *   3) 启动 dsh 时透传：
 *        dsh web --patch <patch.yml> --port 3080
 *
 *   插件可选 config：
 *     { companionFile: '<path>' }  自定义 companion 发现文件（默认见上）
 *     { basePath: '/dsh-api' }      自定义路由前缀（默认 /dsh-api）
 *
 * @packageDocumentation
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const DEFAULT_BASE_PATH = '/dsh-api';
const DEFAULT_COMPANION_FILE_NAME = 'dsh-api-companion.json';
const SUPPORTED_LANGS = ['zh', 'en'];
const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const COMPANION_TIMEOUT_MS = 8000;

/** $DSH_HOME（覆盖：环境变量 DSH_HOME，默认 ~/.dsh） */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 读取 companion 发现文件；文件缺失、损坏、端口不合法返回 null */
function readCompanionInfo(file) {
  try {
    if (!existsSync(file)) return null;
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (!info || typeof info.port !== 'number' || info.port <= 0) return null;
    return info;
  } catch {
    return null;
  }
}

/** 收集请求体（上限 1 MiB，超过直接 destroy 连接） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 写接口 Origin 校验：无 Origin（curl/本地进程）与回环 Origin 放行 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/** 短超时的 HTTP 代理到 companion；网络层错误落成结构化 status */
function proxyToCompanion(companion, method, path, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: companion.port,
      path,
      method,
      headers: {
        'x-dsh-api-companion-token': companion.token || '',
        ...(payload !== null
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: COMPANION_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 500, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: null }); });
    req.on('error', () => resolve({ status: 502, body: null }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 统一 JSON 响应 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

/** 把 work 的异常收敛成 JSON 错误响应，避免 500 页面 */
function safe(res, work) {
  Promise.resolve()
    .then(work)
    .catch((err) => sendError(res, 500, err instanceof Error ? err.message : String(err)));
}

export default {
  name: 'dsh-api',
  // webServer 由 dsh-host-webserver 提供；声明硬依赖让 Cordis 等 service 就绪后再激活
  inject: ['webServer'],

  apply(ctx, config) {
    config = config || {};
    const basePath = typeof config.basePath === 'string' && config.basePath.startsWith('/')
      ? config.basePath.replace(/\/+$/, '') || DEFAULT_BASE_PATH
      : DEFAULT_BASE_PATH;
    const companionFile = config.companionFile || join(dshHome(), DEFAULT_COMPANION_FILE_NAME);
    const webServer = ctx.webServer;

    const readCompanion = () => readCompanionInfo(companionFile);

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: basePath,
      handler: (req, res) => safe(res, async () => {
        // 这些 service 由其他条目提供，可选依赖：每次请求现取，缺失时降级
        const settings = ctx.get('settings');
        const workspaceRegistry = ctx.get('workspaceRegistry');
        const url = new URL(req.url || '/', 'http://localhost');
        const sub = url.pathname.slice(basePath.length).replace(/^\/+/, '');
        const method = req.method || 'GET';
        const dshPort = req.socket.localPort || null;

        // ── 只读端点（无副作用，GET） ────────────────────────────────────────
        if (method === 'GET') {
          if (sub === 'health' || sub === '') {
            const companion = readCompanion();
            sendJson(res, 200, {
              ok: true,
              service: 'dsh-api',
              basePath,
              dshPort,
              cwd: process.cwd(),
              companion: companion ? { port: companion.port, pid: companion.pid || null } : null,
            });
            return;
          }

          if (sub === 'language') {
            let language = null;
            try {
              const locale = settings?.get('locale');
              if (locale && typeof locale === 'object') language = locale.preference || null;
            } catch { /* namespace 未注册 */ }
            sendJson(res, 200, { ok: true, language, supported: SUPPORTED_LANGS });
            return;
          }

          if (sub === 'workspace/list') {
            if (workspaceRegistry === undefined) {
              sendJson(res, 200, { ok: true, workspaces: [] });
              return;
            }
            const workspaces = workspaceRegistry.list().map((w) => ({
              id: w.id,
              path: w.path,
              title: w.title,
              createdAt: w.createdAt,
              sessionCount: (w.sessionIds || []).length,
            }));
            sendJson(res, 200, { ok: true, workspaces });
            return;
          }

          if (sub === 'workspace/current') {
            const companion = readCompanion();
            let companionState = null;
            if (companion) {
              const r = await proxyToCompanion(companion, 'GET', '/companion/state');
              if (r.body && r.body.ok) companionState = r.body.state || null;
            }
            sendJson(res, 200, { ok: true, cwd: process.cwd(), dshPort, companion: companionState });
            return;
          }

          if (sub === 'companion/state') {
            const companion = readCompanion();
            if (!companion) {
              sendError(res, 503, 'companion not available');
              return;
            }
            const r = await proxyToCompanion(companion, 'GET', '/companion/state');
            if (!r.body || !r.body.ok) {
              sendError(res, 502, 'companion unreachable');
              return;
            }
            sendJson(res, 200, { ok: true, ...r.body.state });
            return;
          }
        }

        // ── 写端点（POST） ─────────────────────────────────────────────────
        if (!originAllowed(req)) {
          sendError(res, 403, 'origin not allowed');
          return;
        }

        // POST /language — dsh 原生能力，无需 companion
        if (sub === 'language' && method === 'POST') {
          if (settings === undefined) {
            sendError(res, 503, 'settings service unavailable');
            return;
          }
          let body = {};
          try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
          const language = typeof body.language === 'string' ? body.language : null;
          if (!language || !SUPPORTED_LANGS.includes(language)) {
            sendError(res, 400, `language must be one of: ${SUPPORTED_LANGS.join(', ')}`);
            return;
          }
          await settings.update('locale', { preference: language });
          sendJson(res, 200, { ok: true, language });
          return;
        }

        const KNOWN_ENDPOINTS = new Set([
          'health', '', 'workspace/current', 'workspace/list', 'workspace/open',
          'language', 'input/paste', 'window/show', 'window/reload',
          'companion/state', 'app/quit',
        ]);
        if (!KNOWN_ENDPOINTS.has(sub)) {
          sendError(res, 404, `unknown ${basePath} endpoint: /${sub}`);
          return;
        }
        if (method !== 'POST') {
          sendError(res, 405, 'method not allowed');
          return;
        }

        // 剩余写端点走 companion
        const companion = readCompanion();
        if (!companion) {
          sendError(res, 503, 'companion not available (dsh started without a host companion?)');
          return;
        }

        if (sub === 'workspace/open') {
          let body = {};
          try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
          const pathValue = typeof body.path === 'string' && body.path.length > 0 ? body.path : null;
          const r = await proxyToCompanion(companion, 'POST', '/companion/workspace/open', { path: pathValue });
          if (!r.body || !r.body.ok) {
            const message = (r.body && r.body.error) || 'workspace switch failed';
            sendError(res, (r.body && r.body.error) ? 400 : 502, message);
            return;
          }
          sendJson(res, 200, { ok: true, ...r.body.result });
          return;
        }

        if (sub === 'input/paste') {
          let body = {};
          try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
          if (typeof body.text !== 'string') {
            sendError(res, 400, 'text (string) is required');
            return;
          }
          const r = await proxyToCompanion(companion, 'POST', '/companion/input/paste', { text: body.text });
          if (!r.body || !r.body.ok) {
            sendError(res, 502, (r.body && r.body.error) || 'paste failed');
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (sub === 'window/show') {
          const r = await proxyToCompanion(companion, 'POST', '/companion/window/show');
          sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'companion error' });
          return;
        }

        if (sub === 'window/reload') {
          const r = await proxyToCompanion(companion, 'POST', '/companion/window/reload');
          sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'companion error' });
          return;
        }

        if (sub === 'app/quit') {
          const r = await proxyToCompanion(companion, 'POST', '/companion/app/quit');
          sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'companion error' });
          return;
        }

        sendError(res, 500, 'unhandled endpoint');
      }),
    }));
  },
};
