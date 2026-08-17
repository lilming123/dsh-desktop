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
 * ({ port, token, pid, ...state }) so the plugin can find and authenticate to
 * it. The port is OS-assigned and the token is random per launch.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { companionInfoFile } = require('./paths');
const { log } = require('./logger');

const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const TOKEN_HEADER = 'x-dsh-api-companion-token';

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
 * Pure dispatcher (kept dependency-free so it can be unit-tested).
 * @param {object} api  Capability implementation: getState/openWorkspaceRequested/pasteToInput/showWindow/reloadWindow/quitApp
 * @param {string} token  Expected companion token
 */
function createHandler(api, token) {
  return async (req, res) => {
    try {
      if (req.headers[TOKEN_HEADER] !== token) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const method = req.method || 'GET';
      const pathname = url.pathname;

      if (method === 'GET' && pathname === '/companion/state') {
        sendJson(res, 200, { ok: true, state: api.getState() });
        return;
      }

      if (method === 'POST' && pathname === '/companion/workspace/open') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
        const result = await api.openWorkspaceRequested(
          typeof body.path === 'string' && body.path.length ? body.path : null
        );
        if (result && result.ok) {
          sendJson(res, 200, { ok: true, result });
        } else if (result && result.canceled) {
          sendJson(res, 200, { ok: true, canceled: true, result: null });
        } else {
          sendJson(res, 400, { ok: false, error: (result && result.error) || 'workspace open failed' });
        }
        return;
      }

      if (method === 'POST' && pathname === '/companion/input/paste') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
        if (typeof body.text !== 'string') {
          sendJson(res, 400, { ok: false, error: 'text (string) is required' });
          return;
        }
        const result = api.pasteToInput(body.text);
        sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'paste failed' });
        return;
      }

      if (method === 'POST' && pathname === '/companion/window/show') {
        const result = api.showWindow();
        sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'show failed' });
        return;
      }

      if (method === 'POST' && pathname === '/companion/window/reload') {
        const result = api.reloadWindow();
        sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'reload failed' });
        return;
      }

      if (method === 'POST' && pathname === '/companion/app/quit') {
        sendJson(res, 200, { ok: true });
        api.quitApp();
        return;
      }

      sendJson(res, 404, { ok: false, error: 'unknown companion endpoint: ' + pathname });
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
    try {
      const info = {
        port: server.address().port,
        token,
        pid: process.pid,
        ...api.getState(),
      };
      fs.mkdirSync(path.dirname(infoFile), { recursive: true });
      fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
    } catch (e) {
      log('companion: write info failed', e.message);
    }
  };

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      writeInfo();
      log('companion: listening on 127.0.0.1:' + port);
      resolve({
        port,
        stop: () => {
          try { fs.unlinkSync(infoFile); } catch (_) { /* file already gone */ }
          server.close();
        },
        refresh: writeInfo,
      });
    });
    server.once('error', reject);
  });
}

module.exports = { startCompanion, createHandler };
