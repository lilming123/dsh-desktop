/**
 * companion.js — Host companion HTTP service (Electron main process).
 *
 * The `dsh-api` plugin publishes dsh's own capabilities directly, but some
 * things only the desktop wrapper can do: pick a folder, restart dsh with a
 * new cwd, focus the window, quit the app. This file implements the companion
 * side of the dsh-api companion protocol.
 *
 * Endpoints (all authenticated by `x-dsh-api-companion-token`):
 *
 *   GET  /companion/state             capability-layer state snapshot
 *   POST /companion/workspace/open    { path? }  — no path ⇒ folder picker
 *   POST /companion/input/paste       { text }   — inject into dsh UI input
 *   POST /companion/window/show       show + focus the main window
 *   POST /companion/window/reload     reload dsh UI in the main window
 *   POST /companion/app/quit          quit the desktop app
 *
 * Discovery: this service writes `$DSH_HOME/dsh-api-companion.json`
 * atomically ({ port, token, pid, ...state }) so the plugin can find and
 * authenticate to it. The port is OS-assigned and the token is random per
 * launch.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { companionInfoFile } = require('./paths');
const { writeJsonAtomic, unlinkSafe } = require('./fsx');
const { log } = require('./logger');

const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const TOKEN_HEADER = 'x-dsh-api-companion-token';

/** Read a request body with a size cap; rejects and destroys on overflow. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Parse a request body as JSON, swallowing errors down to `{}`. Used for
 * every write endpoint here — all of them treat missing/invalid bodies as
 * "no options provided", which lines up with the current callers.
 */
async function readJsonBody(req) {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

/**
 * Wrap a capability result into an HTTP response.
 *   { ok: true, ... }             → 200
 *   { ok: false, canceled: true } → 200 with canceled flag preserved
 *   { ok: false, error }          → 400
 *   anything else / thrown        → 500 (caller wraps this)
 */
function sendResult(res, result, defaultError) {
  if (result && result.ok) return sendJson(res, 200, { ok: true, result });
  if (result && result.canceled) return sendJson(res, 200, { ok: true, canceled: true, result: null });
  return sendJson(res, 400, { ok: false, error: (result && result.error) || defaultError });
}

/**
 * Dispatch table for the companion HTTP surface. Each entry receives the
 * whole request, whichever `api` we were built with, and a `sendJson`
 * helper — the table drives all method / path matching, so there's exactly
 * one place to add or rename endpoints.
 */
function buildRoutes(api) {
  return {
    'GET /companion/state': async (_req, res) => {
      sendJson(res, 200, { ok: true, state: api.getState() });
    },
    'POST /companion/workspace/open': async (req, res) => {
      const body = await readJsonBody(req);
      const targetPath = typeof body.path === 'string' && body.path.length ? body.path : null;
      const result = await api.openWorkspaceRequested(targetPath);
      sendResult(res, result, 'workspace open failed');
    },
    'POST /companion/input/paste': async (req, res) => {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'text (string) is required' });
      }
      const result = api.pasteToInput(body.text);
      sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'paste failed' });
    },
    'POST /companion/window/show': async (_req, res) => {
      const result = api.showWindow();
      sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'show failed' });
    },
    'POST /companion/window/reload': async (_req, res) => {
      const result = api.reloadWindow();
      sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'reload failed' });
    },
    'POST /companion/app/quit': async (_req, res) => {
      // Ack synchronously — the quit itself is scheduled on setImmediate by the caller.
      sendJson(res, 200, { ok: true });
      api.quitApp();
    },
  };
}

/**
 * Pure dispatcher (kept dependency-free so it can be unit-tested).
 * @param {object} api  Capability implementation
 * @param {string} token  Expected companion token
 */
function createHandler(api, token) {
  const routes = buildRoutes(api);
  return async (req, res) => {
    try {
      if (req.headers[TOKEN_HEADER] !== token) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const key = `${req.method || 'GET'} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) return sendJson(res, 404, { ok: false, error: `unknown companion endpoint: ${key}` });
      await handler(req, res);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}

/**
 * Start the companion HTTP service and publish the discovery file.
 * @returns {Promise<{ port: number, stop: () => void, refresh: () => void }>}
 */
function startCompanion(opts) {
  const api = opts.api;
  const token = crypto.randomBytes(24).toString('hex');
  const infoFile = opts.infoFile || companionInfoFile();

  const server = http.createServer(createHandler(api, token));
  server.on('error', (e) => log('companion: server error', e.message));

  const writeInfo = () => {
    const info = { port: server.address()?.port, token, pid: process.pid, ...api.getState() };
    if (!writeJsonAtomic(infoFile, info)) log('companion: write info failed', infoFile);
  };

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      writeInfo();
      log('companion: listening on 127.0.0.1:' + port);
      resolve({
        port,
        stop: () => {
          unlinkSafe(infoFile);
          // Force-close idle keep-alive sockets so process exit doesn't hang.
          // Available since Node 18.2; guard for older Electron builds.
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          server.close();
        },
        refresh: writeInfo,
      });
    });
    server.once('error', reject);
  });
}

// Exposed for tests / other tooling; not used by the app itself.
function _testInternals() { return { buildRoutes, TOKEN_HEADER, MAX_BODY_BYTES }; }

module.exports = { startCompanion, createHandler, _testInternals };
