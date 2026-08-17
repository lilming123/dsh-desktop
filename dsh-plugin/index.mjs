/**
 * dsh-api — DeepSeek Harness HTTP control-plane plugin.
 *
 * Exposes dsh's own internal capabilities as HTTP routes on the dsh
 * webServer (default prefix: `/dsh-api`). Any process on the same machine
 * — a browser extension, a CLI, a desktop wrapper, an editor integration —
 * can drive dsh through this single entry point instead of reaching into
 * its in-process services directly.
 *
 * ── Capability layers ────────────────────────────────────────────────────
 *
 *   1. dsh-native (always available once the plugin is loaded):
 *        GET  /dsh-api/health              liveness probe
 *        GET  /dsh-api/language            read locale.preference
 *        POST /dsh-api/language            write locale.preference
 *        GET  /dsh-api/workspace/list      list workspace registry
 *        GET  /dsh-api/workspace/current   cwd + optional companion state
 *
 *   2. companion-bridged (needs a same-machine "companion" process to be
 *      registered — see the companion protocol below):
 *        GET  /dsh-api/companion/state     companion state snapshot
 *        POST /dsh-api/workspace/open      open workspace (dsh restart)
 *        POST /dsh-api/input/paste         inject text into the dsh UI
 *        POST /dsh-api/window/show|reload  host window control
 *        POST /dsh-api/app/quit            quit the host app
 *
 *   A companion registers itself by writing `$DSH_HOME/dsh-api-companion.json`
 *   ({ port, token, pid, ...state }). If the file is missing or its port is
 *   unreachable, companion-only routes return 503; native routes keep working.
 *
 * ── Security ─────────────────────────────────────────────────────────────
 *
 *   - dsh binds 127.0.0.1 only; this plugin reuses that socket.
 *   - Mutating requests (`POST`) validate `Origin`: no Origin (curl/CLI) or
 *     loopback origins are allowed; any other origin is 403. This prevents
 *     drive-by browser calls from unrelated sites.
 *   - Companion proxying carries the discovery-file token as
 *     `x-dsh-api-companion-token`; the companion is expected to reject
 *     mismatches.
 *
 * ── Install ──────────────────────────────────────────────────────────────
 *
 *   1) Copy this file into a dsh profile, e.g.
 *        $DSH_HOME/profiles/web/dsh-api/index.mjs
 *   2) Write a patch layer (`--patch`) that inserts the plugin:
 *        - insert:
 *            - id: dsh-api
 *              name: ./dsh-api/index.mjs
 *   3) Start dsh with the patch:
 *        dsh web --patch <patch.yml> --port 3080
 *
 *   Optional plugin config (via the patch entry's `config: { ... }`):
 *     basePath      — HTTP route prefix (default: /dsh-api)
 *     companionFile — companion discovery file
 *                     (default: $DSH_HOME/dsh-api-companion.json)
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

/** `$DSH_HOME` (env override, default `~/.dsh`). */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Read the companion discovery file; returns null on missing / bad shape. */
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

/** Read a request body with a hard cap; destroys the socket on overflow. */
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

/** Parse a JSON body (returns {} on empty / invalid). */
async function readJsonBody(req) {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

/** Origin check for mutating requests. Missing Origin (CLI) is allowed. */
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

/**
 * Proxy an HTTP call to the companion. Returns `{ status, body }`; transport
 * errors surface as status 502 / 504 with a null body so the caller can
 * uniformly translate them to a client-facing 502.
 */
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 500, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: null }); });
    req.on('error', () => resolve({ status: 502, body: null }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── Response helpers ─────────────────────────────────────────────────────────

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
function sendError(res, status, message) { sendJson(res, status, { ok: false, error: message }); }

/**
 * A "handler" is `(ctxLite, req, res) => Promise<void>` where ctxLite exposes
 * only what handlers legitimately need. Keeping this contract narrow lets
 * the dispatch table stay short and testable.
 */
function buildRoutes({ getCompanion }) {
  return {
    // ── dsh-native GETs ──────────────────────────────────────────────────
    'GET health':            handleHealth(getCompanion),
    'GET ':                  handleHealth(getCompanion), // '/dsh-api' with no trailing sub
    'GET language':          handleLanguageGet,
    'GET workspace/list':    handleWorkspaceList,
    'GET workspace/current': handleWorkspaceCurrent(getCompanion),

    // ── companion state (needs companion) ────────────────────────────────
    'GET companion/state':   handleCompanionState(getCompanion),

    // ── mutating routes (Origin-checked before dispatch) ─────────────────
    'POST language':         handleLanguagePost,
    'POST workspace/open':   handleWorkspaceOpen(getCompanion),
    'POST input/paste':      handleInputPaste(getCompanion),
    'POST window/show':      handleCompanionBridge(getCompanion, 'POST', '/companion/window/show'),
    'POST window/reload':    handleCompanionBridge(getCompanion, 'POST', '/companion/window/reload'),
    'POST app/quit':         handleCompanionBridge(getCompanion, 'POST', '/companion/app/quit'),
  };
}

// ── Handler implementations ──────────────────────────────────────────────────

const handleHealth = (getCompanion) => async ({ dshPort }, _req, res) => {
  const companion = getCompanion();
  sendJson(res, 200, {
    ok: true,
    service: 'dsh-api',
    dshPort,
    cwd: process.cwd(),
    companion: companion ? { port: companion.port, pid: companion.pid || null } : null,
  });
};

const handleLanguageGet = async ({ settings }, _req, res) => {
  let language = null;
  try {
    const locale = settings?.get('locale');
    if (locale && typeof locale === 'object') language = locale.preference || null;
  } catch { /* namespace not registered yet */ }
  sendJson(res, 200, { ok: true, language, supported: SUPPORTED_LANGS });
};

const handleWorkspaceList = async ({ workspaceRegistry }, _req, res) => {
  if (workspaceRegistry === undefined) {
    // No registry ⇒ empty list, not an error: the plugin can still be useful
    // (e.g. language) in profiles that don't include the workspace service.
    return sendJson(res, 200, { ok: true, workspaces: [] });
  }
  const workspaces = workspaceRegistry.list().map((w) => ({
    id: w.id,
    path: w.path,
    title: w.title,
    createdAt: w.createdAt,
    sessionCount: (w.sessionIds || []).length,
  }));
  sendJson(res, 200, { ok: true, workspaces });
};

const handleWorkspaceCurrent = (getCompanion) => async ({ dshPort }, _req, res) => {
  const companion = getCompanion();
  let companionState = null;
  if (companion) {
    const r = await proxyToCompanion(companion, 'GET', '/companion/state');
    if (r.body && r.body.ok) companionState = r.body.state || null;
  }
  sendJson(res, 200, { ok: true, cwd: process.cwd(), dshPort, companion: companionState });
};

const handleCompanionState = (getCompanion) => async (_ctx, _req, res) => {
  const companion = getCompanion();
  if (!companion) return sendError(res, 503, 'companion not available');
  const r = await proxyToCompanion(companion, 'GET', '/companion/state');
  if (!r.body || !r.body.ok) return sendError(res, 502, 'companion unreachable');
  sendJson(res, 200, { ok: true, ...r.body.state });
};

const handleLanguagePost = async ({ settings }, req, res) => {
  if (settings === undefined) return sendError(res, 503, 'settings service unavailable');
  const body = await readJsonBody(req);
  const language = typeof body.language === 'string' ? body.language : null;
  if (!language || !SUPPORTED_LANGS.includes(language)) {
    return sendError(res, 400, `language must be one of: ${SUPPORTED_LANGS.join(', ')}`);
  }
  await settings.update('locale', { preference: language });
  sendJson(res, 200, { ok: true, language });
};

const handleWorkspaceOpen = (getCompanion) => async (_ctx, req, res) => {
  const companion = getCompanion();
  if (!companion) return sendError(res, 503, 'companion not available');
  const body = await readJsonBody(req);
  const pathValue = typeof body.path === 'string' && body.path.length > 0 ? body.path : null;
  const r = await proxyToCompanion(companion, 'POST', '/companion/workspace/open', { path: pathValue });
  if (!r.body || !r.body.ok) {
    const msg = (r.body && r.body.error) || 'workspace switch failed';
    return sendError(res, (r.body && r.body.error) ? 400 : 502, msg);
  }
  sendJson(res, 200, { ok: true, ...r.body.result });
};

const handleInputPaste = (getCompanion) => async (_ctx, req, res) => {
  const companion = getCompanion();
  if (!companion) return sendError(res, 503, 'companion not available');
  const body = await readJsonBody(req);
  if (typeof body.text !== 'string') return sendError(res, 400, 'text (string) is required');
  const r = await proxyToCompanion(companion, 'POST', '/companion/input/paste', { text: body.text });
  if (!r.body || !r.body.ok) return sendError(res, 502, (r.body && r.body.error) || 'paste failed');
  sendJson(res, 200, { ok: true });
};

/** Generic pass-through for endpoints whose only job is to forward the call. */
const handleCompanionBridge = (getCompanion, method, path) => async (_ctx, _req, res) => {
  const companion = getCompanion();
  if (!companion) return sendError(res, 503, 'companion not available');
  const r = await proxyToCompanion(companion, method, path);
  sendJson(res, r.body && r.body.ok ? 200 : 502, r.body || { ok: false, error: 'companion error' });
};

// ── Plugin entry point ───────────────────────────────────────────────────────

export default {
  name: 'dsh-api',
  // webServer is provided by dsh-host-webserver; hard-inject so Cordis waits
  // for that service before activating this plugin (loader entries are
  // applied in parallel, so we can't assume the service is up otherwise).
  inject: ['webServer'],

  apply(ctx, config) {
    config = config || {};
    const basePath = typeof config.basePath === 'string' && config.basePath.startsWith('/')
      ? config.basePath.replace(/\/+$/, '') || DEFAULT_BASE_PATH
      : DEFAULT_BASE_PATH;
    const companionFile = config.companionFile || join(dshHome(), DEFAULT_COMPANION_FILE_NAME);
    const webServer = ctx.webServer;
    const getCompanion = () => readCompanionInfo(companionFile);
    const routes = buildRoutes({ getCompanion });

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: basePath,
      handler: (req, res) => dispatch(ctx, routes, basePath, req, res),
    }));
  },
};

async function dispatch(ctx, routes, basePath, req, res) {
  try {
    // These services are provided by other loader entries; look them up per
    // request so a slow-starting service doesn't block plugin activation.
    const ctxLite = {
      settings: ctx.get('settings'),
      workspaceRegistry: ctx.get('workspaceRegistry'),
      dshPort: req.socket.localPort || null,
    };
    const url = new URL(req.url || '/', 'http://localhost');
    const sub = url.pathname.slice(basePath.length).replace(/^\/+/, '');
    const method = req.method || 'GET';
    const key = `${method} ${sub}`;

    // Origin check runs before all mutating handlers. Missing entries fall
    // through to the 404/405 checks below without touching Origin at all.
    if (method !== 'GET' && !originAllowed(req)) return sendError(res, 403, 'origin not allowed');

    const handler = routes[key];
    if (handler) return handler(ctxLite, req, res);

    // Distinguish "unknown path" vs. "known path, wrong method" for better UX.
    const anyMethodOnPath = Object.keys(routes).some((k) => k.endsWith(` ${sub}`));
    if (anyMethodOnPath) return sendError(res, 405, 'method not allowed');
    return sendError(res, 404, `unknown ${basePath} endpoint: /${sub}`);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}
