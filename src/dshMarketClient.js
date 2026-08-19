/**
 * dshMarketClient.js — thin HTTP client for the dshmarket plugin's own
 * install/status endpoints.
 *
 * dshmarket ships as part of dsh's default profile bundle, so once the
 * dsh service is up the market's routes are automatically mounted at
 * `/dsh-market/*`. The desktop shell uses those routes to install the
 * dsh-api plugin the same way a user would with dshmarket's UI:
 *
 *   POST /dsh-market/install   { url }
 *
 * dshmarket rejects any `url` that is not in its curated registry
 * (`awesome-dsh-plugin.com/plugins.json` with a bundled snapshot). Until
 * dsh-api lands in that registry we treat a rejection as a signal to
 * fall back to the bundled copy — which is exactly what the older
 * install path already did on any failure.
 *
 * The client:
 *
 *   - Uses http.request against 127.0.0.1:<port> — no fetch polyfill or
 *     extra dependencies, works even when the renderer isn't around.
 *   - Sets Origin explicitly. dshmarket's install route enforces
 *     `sameOrigin`; matching Origin and Host to the same 127.0.0.1:<port>
 *     satisfies it.
 *   - Timeboxes every call (12s default) so a wedged dsh can't hold the
 *     splash screen open forever.
 */

'use strict';

const http = require('node:http');
const { log } = require('./logger');

const HOST = '127.0.0.1';

/**
 * POST /dsh-market/install
 *
 * @param {number}  port
 * @param {string}  url    plugin source url as it appears in the registry
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok:true} | {ok:false, status:number, error:string, body?:any}>}
 */
async function installPlugin(port, url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const body = JSON.stringify({ url });
  const origin = `http://${HOST}:${port}`;

  return await requestJson({
    port,
    method: 'POST',
    path: '/dsh-market/install',
    body,
    headers: { origin, 'content-type': 'application/json' },
    timeoutMs,
  })
    .then((r) => {
      // 200 with `{ ok: true }` (or 202 with a job id in newer versions):
      // treat any 2xx as success and hand the payload back.
      if (r.status >= 200 && r.status < 300) {
        log('dshmarket: install ok', url);
        return { ok: true };
      }
      const errText = r.json?.error || r.text || `HTTP ${r.status}`;
      log('dshmarket: install failed', url, r.status, errText);
      return { ok: false, status: r.status, error: errText, body: r.json };
    })
    .catch((e) => {
      log('dshmarket: install exec error', e && e.message);
      return { ok: false, status: 0, error: (e && e.message) || 'network error' };
    });
}

/**
 * GET /dsh-market/status
 *
 * Optional health check we can run to make sure dshmarket is up and its
 * routes are mounted. Returns `{ ok: false }` on any failure so the
 * caller can skip the dshmarket path without stopping the pipeline.
 */
async function isReady(port, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  try {
    const r = await requestJson({
      port, method: 'GET', path: '/dsh-market/status',
      headers: { origin: `http://${HOST}:${port}` },
      timeoutMs,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'network error' };
  }
}

// ── plumbing ─────────────────────────────────────────────────────────────────

/**
 * Minimal JSON HTTP request. Resolves with `{ status, headers, text, json? }`;
 * rejects on socket-level failure or timeout. 4xx/5xx are resolved responses,
 * not rejections — the caller decides what to do with a status.
 */
function requestJson({ port, method, path, body, headers = {}, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port, method, path,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { installPlugin, isReady };
