/**
 * pluginClient.js — Thin HTTP client for the local `dsh-api` plugin.
 *
 * The desktop app talks to dsh through exactly one seam: the `dsh-api`
 * plugin running inside the dsh process. This module is the app-side entry
 * point. It never implements a dsh capability itself; it only knows how to
 * reach `http://127.0.0.1:<port>/dsh-api/*` and interpret the JSON envelope
 * `{ ok, ... }`.
 *
 * Contracts:
 *
 *   - `setPort(port)` MUST only be called from `capabilities.setContext()`.
 *     That keeps one authoritative source for "which dsh are we talking to".
 *   - Every response envelope from the plugin is JSON `{ ok: boolean, ... }`.
 *     A missing envelope, non-JSON body, or `ok: false` means "the plugin
 *     couldn't answer authoritatively" — the client returns `null` (or the
 *     documented sentinel) so callers treat all failure modes uniformly.
 *   - **No fallbacks that touch dsh files.** If the plugin cannot answer, the
 *     operation fails. That's the whole point of the refactor: the app never
 *     reaches into dsh state directly.
 */

'use strict';

const http = require('http');

const DEFAULT_TIMEOUT_MS = 2000;

let dshPort = 3080;

/** Called from `capabilities.setContext({ dshPort })`. Do not call elsewhere. */
function setPort(port) {
  if (typeof port === 'number' && port > 0) dshPort = port;
}

/** Current known dsh port (before setPort: 3080). */
function getPort() { return dshPort; }

/**
 * One request/response cycle. Returns `null` on any transport / parse error
 * so callers can uniformly treat "plugin unreachable" and "plugin gave garbage"
 * as the same "no answer".
 * @returns {Promise<{status: number, body: any}|null>}
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // Note: when dsh is reused *without* the plugin loaded, dsh's SPA
        // fallback returns 200 + HTML for any path. JSON.parse will fail,
        // and we return null — callers treat that as "plugin unavailable".
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── Health / availability ─────────────────────────────────────────────────────

/**
 * GET `/dsh-api/health` — probe plugin availability.
 * Returns the parsed body on success, or `null` on any failure. Callers use
 * this to distinguish "reused dsh with plugin" from "reused dsh without".
 */
async function health() {
  const r = await request('GET', '/dsh-api/health', undefined, 800);
  if (!r || !r.body || r.body.ok !== true) return null;
  // Guard against unrelated services answering on the same path shape.
  if (r.body.service && r.body.service !== 'dsh-api') return null;
  return r.body;
}

/**
 * Convenience boolean: is the plugin present and answering right now?
 * Uses a shorter timeout than the underlying request; failures resolve to
 * `false`, never throw.
 */
async function isAvailable() {
  return (await health()) !== null;
}

// ── Language ──────────────────────────────────────────────────────────────────

/** GET `/dsh-api/language` — returns current language, or `null` if unavailable. */
async function getLanguage() {
  const r = await request('GET', '/dsh-api/language', undefined, 1000);
  if (!r || !r.body || r.body.ok !== true) return null;
  return typeof r.body.language === 'string' ? r.body.language : null;
}

/**
 * POST `/dsh-api/language` — request a language switch.
 * Returns `true` iff the plugin acknowledged the change. Failures include
 * the plugin being unavailable and the server rejecting the language.
 */
async function setLanguage(language) {
  const r = await request('POST', '/dsh-api/language', { language });
  return !!(r && r.body && r.body.ok === true);
}

// ── Workspace ─────────────────────────────────────────────────────────────────

/**
 * GET `/dsh-api/workspace/list` — returns the array, or `null` when the
 * plugin is unavailable. The menu treats `null` as "still loading" and `[]`
 * as "no recent workspaces yet".
 */
async function listWorkspaces(timeoutMs = 1500) {
  const r = await request('GET', '/dsh-api/workspace/list', undefined, timeoutMs);
  if (!r || !r.body || r.body.ok !== true) return null;
  return Array.isArray(r.body.workspaces) ? r.body.workspaces : null;
}

/**
 * GET `/dsh-api/workspace/current` — returns `{ cwd, dshPort, companion }`
 * or `null` when unavailable. The `companion` field is the companion state
 * snapshot the plugin got from us; when running standalone it is `null`.
 */
async function workspaceCurrent(timeoutMs = 1000) {
  const r = await request('GET', '/dsh-api/workspace/current', undefined, timeoutMs);
  if (!r || !r.body || r.body.ok !== true) return null;
  return {
    cwd: typeof r.body.cwd === 'string' ? r.body.cwd : null,
    dshPort: typeof r.body.dshPort === 'number' ? r.body.dshPort : null,
    companion: r.body.companion || null,
  };
}

module.exports = {
  // Port wiring (single-caller contract with capabilities.setContext)
  setPort,
  getPort,
  // Raw escape hatch — prefer the typed helpers below
  request,
  // Health
  health,
  isAvailable,
  // Language
  getLanguage,
  setLanguage,
  // Workspace
  listWorkspaces,
  workspaceCurrent,
};
