/**
 * pluginClient.js — Thin HTTP client for the local dsh-api plugin.
 *
 * The desktop app talks to dsh through exactly one path: the `dsh-api` plugin
 * running inside the dsh process. This module is the app-side entry point.
 * It does not implement any dsh capability itself; it only knows how to reach
 * `http://127.0.0.1:<port>/dsh-api/*` and parse the JSON envelope.
 *
 * Rules of the road:
 *   - The port is injected by main.js after dsh is up (setPort).
 *   - Every response envelope is `{ ok: boolean, ... }`; parse errors and
 *     network errors return `null` so callers can treat "plugin unavailable"
 *     uniformly (e.g. dsh reused from an older process without the plugin).
 *   - No fallbacks. If the plugin cannot answer, the operation fails. This is
 *     deliberate — the whole point of the refactor is that the app never
 *     touches dsh internals directly.
 */

'use strict';

const http = require('http');

const DEFAULT_TIMEOUT_MS = 2000;

let dshPort = 3080;

/** Called from main.js whenever dsh's listening port changes. */
function setPort(port) {
  if (typeof port === 'number' && port > 0) dshPort = port;
}

/** Current known dsh port (before setPort: 3080). */
function getPort() {
  return dshPort;
}

/**
 * One HTTP request/response cycle to the plugin.
 * @returns {Promise<{status: number, body: any}|null>} null on any network / parse error
 */
function request(method, pathname, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: dshPort,
      path: pathname,
      method,
      headers: payload !== null
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        // When dsh is reused without the plugin, its SPA fallback returns 200
        // + HTML for any path. Callers use `body.ok` to detect that case.
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON, treat as null */ }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** GET /dsh-api/health — probe plugin availability (used for degraded UI). */
async function health() {
  const r = await request('GET', '/dsh-api/health', undefined, 800);
  return r && r.body && r.body.ok ? r.body : null;
}

/** GET /dsh-api/language — returns current language or null when unavailable. */
async function getLanguage() {
  const r = await request('GET', '/dsh-api/language', undefined, 1000);
  if (!r || !r.body || !r.body.ok) return null;
  return typeof r.body.language === 'string' ? r.body.language : null;
}

/** POST /dsh-api/language — returns true on success (dsh clients refresh live). */
async function setLanguage(language) {
  const r = await request('POST', '/dsh-api/language', { language });
  return !!(r && r.body && r.body.ok);
}

/** GET /dsh-api/workspace/list — returns array or null (menu treats null as loading). */
async function listWorkspaces(timeoutMs = 1500) {
  const r = await request('GET', '/dsh-api/workspace/list', undefined, timeoutMs);
  if (!r || !r.body || !r.body.ok) return null;
  return Array.isArray(r.body.workspaces) ? r.body.workspaces : null;
}

module.exports = {
  setPort,
  getPort,
  request,
  health,
  getLanguage,
  setLanguage,
  listWorkspaces,
};
