/**
 * dsh-plugin/index.mjs — DeepSeek Harness Desktop 能力桥接插件
 *
 * 以 HTTP 路由的形式挂在 dsh 的 webServer 上（路径前缀 /desktop-api），
 * 把「桌面应用」与「dsh 内部能力」暴露给外部应用：
 *
 *   - 语言：读 / 写 dsh 的 locale 设置（settings 服务，dsh 原生实现）
 *   - 工作区：列出 dsh 工作区注册表；打开工作区需桌面端重启 dsh（桥接）
 *   - 窗口 / 输入 / 文件对话框：桌面专属能力（桥接到 Electron 主进程）
 *
 * 桥接发现：桌面应用把桥接服务信息写到 $DSH_HOME/desktop-bridge.json
 * （{ port, token, dshPort, pid }）。插件按需读取；桥接不可达时，
 * dsh 原生能力（语言、工作区列表）照常可用，桌面专属能力返回 503。
 *
 * 安全：
 *   - 仅处理回环请求（dsh server 本身绑定 127.0.0.1）
 *   - 写操作校验 Origin：浏览器跨站页面（非 127.0.0.1/localhost 来源）拒绝
 *   - 桥接代理携带 desktop-bridge.json 中的 token
 *
 * 安装方式（由桌面应用完成，见 src/dsh.js）：
 *   dsh web --patch <profile>/desktop-bridge.patch.yml --port <port>
 *   patch 条目: { id: dsh-desktop-bridge, name: ./desktop-bridge/index.mjs }
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const API_BASE = '/desktop-api';
const SUPPORTED_LANGS = ['zh', 'en'];
const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const BRIDGE_TIMEOUT_MS = 8000;

/** $DSH_HOME（桌面应用 spawn 时也可通过环境变量覆盖） */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 读取桌面桥接信息；文件缺失或损坏返回 null */
function readBridgeInfo(file) {
  try {
    if (!existsSync(file)) return null;
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (!info || typeof info.port !== 'number' || info.port <= 0) return null;
    return info;
  } catch {
    return null;
  }
}

/** 收集请求体（上限 1 MiB） */
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

/** 写操作校验来源：无 Origin（curl/CLI）或回环来源放行 */
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

/** 代理请求到 Electron 桥接服务 */
function proxyToBridge(bridge, method, path, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: bridge.port,
      path,
      method,
      headers: {
        'x-dsh-bridge-token': bridge.token || '',
        ...(payload !== null
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: BRIDGE_TIMEOUT_MS,
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

/** 把 work 的异常统一成 JSON 错误响应 */
function safe(res, work) {
  Promise.resolve()
    .then(work)
    .catch((err) => sendError(res, 500, err instanceof Error ? err.message : String(err)));
}

export default {
  name: 'dsh-desktop-bridge',
  // webServer 由同树中的 dsh-host-webserver 条目并行提供；声明硬依赖
  // 让 Cordis 等到服务就绪后再激活本插件（loader 条目是并行 apply 的）。
  inject: ['webServer'],

  // loader 把插件配置作为 apply 的第二个参数传入（Cordis Fiber.execute）
  apply(ctx, config) {
    config = config || {};
    const bridgeFile = config.bridgeFile || join(dshHome(), 'desktop-bridge.json');
    const webServer = ctx.webServer;

    const getBridge = () => readBridgeInfo(bridgeFile);

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: (req, res) => safe(res, async () => {
        // settings / workspaceRegistry 由其他条目提供，请求时再取
        const settings = ctx.get('settings');
        const workspaceRegistry = ctx.get('workspaceRegistry');
        const url = new URL(req.url || '/', 'http://localhost');
        const sub = url.pathname.slice(API_BASE.length).replace(/^\/+/, '');
        const method = req.method || 'GET';
        const dshPort = req.socket.localPort || null;

        // 读端点（无副作用）：GET /health /workspace/current /workspace/list /language /app/state
        if (method === 'GET' && (sub === 'health' || sub === 'workspace/current' || sub === 'workspace/list' || sub === 'language' || sub === 'app/state')) {
          if (sub === 'health') {
            const bridge = getBridge();
            sendJson(res, 200, {
              ok: true,
              service: 'dsh-desktop-bridge',
              dshPort,
              cwd: process.cwd(),
              desktop: bridge ? { port: bridge.port, pid: bridge.pid || null } : null,
            });
            return;
          }
          if (sub === 'workspace/current') {
            const bridge = getBridge();
            let desktopState = null;
            if (bridge) {
              const r = await proxyToBridge(bridge, 'GET', '/bridge/state');
              if (r.body && r.body.ok) desktopState = r.body.state || null;
            }
            sendJson(res, 200, { ok: true, cwd: process.cwd(), dshPort, desktop: desktopState });
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
          if (sub === 'language') {
            let language = null;
            try {
              const locale = settings?.get('locale');
              if (locale && typeof locale === 'object') language = locale.preference || null;
            } catch { /* namespace 未注册 */ }
            sendJson(res, 200, { ok: true, language, supported: SUPPORTED_LANGS });
            return;
          }
          if (sub === 'app/state') {
            const bridge = getBridge();
            if (!bridge) {
              sendJson(res, 200, { ok: true, desktop: null });
              return;
            }
            const r = await proxyToBridge(bridge, 'GET', '/bridge/state');
            if (!r.body || !r.body.ok) {
              sendError(res, 502, 'desktop bridge unreachable');
              return;
            }
            sendJson(res, 200, { ok: true, ...r.body.state });
            return;
          }
        }

        // 写端点（有副作用）：必须通过 Origin 校验
        if (!originAllowed(req)) {
          sendError(res, 403, 'origin not allowed');
          return;
        }

        // POST /language — dsh 原生能力，无需桥接
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
          'health', 'workspace/current', 'workspace/list', 'workspace/open',
          'language', 'input/paste', 'window/show', 'window/reload',
          'app/state', 'app/quit',
        ]);
        if (!KNOWN_ENDPOINTS.has(sub)) {
          sendError(res, 404, `unknown ${API_BASE} endpoint: /${sub}`);
          return;
        }
        // 到这里说明：读端点且非 GET（已在上方处理 GET）、或 language 且非 POST
        if (sub === 'language' || method !== 'POST') {
          sendError(res, 405, 'method not allowed');
          return;
        }

        // 其余写端点走桌面桥接
        const bridge = getBridge();
        if (!bridge) {
          sendError(res, 503, 'desktop bridge unavailable (dsh started without the desktop app?)');
          return;
        }

        if (sub === 'workspace/open') {
          let body = {};
          try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
          const pathValue = typeof body.path === 'string' && body.path.length > 0 ? body.path : null;
          const r = await proxyToBridge(bridge, 'POST', '/bridge/workspace/open', { path: pathValue });
          if (!r.body || !r.body.ok) {
            sendError(res, (r.body && r.body.error) ? 400 : 502, (r.body && r.body.error) || 'workspace switch failed');
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
          const r = await proxyToBridge(bridge, 'POST', '/bridge/input/paste', { text: body.text });
          if (!r.body || !r.body.ok) {
            sendError(res, 502, (r.body && r.body.error) || 'paste failed');
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (sub === 'window/show') {
          const r = await proxyToBridge(bridge, 'POST', '/bridge/window/show');
          sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'bridge error' });
          return;
        }

        if (sub === 'window/reload') {
          const r = await proxyToBridge(bridge, 'POST', '/bridge/window/reload');
          sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'bridge error' });
          return;
        }

        if (sub === 'app/quit') {
          const r = await proxyToBridge(bridge, 'POST', '/bridge/app/quit');
          sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'bridge error' });
          return;
        }

        sendError(res, 500, 'unhandled endpoint');
      }),
    }));
  },
};
