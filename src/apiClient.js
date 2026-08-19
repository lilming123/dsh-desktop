/**
 * apiClient.js — Long-lived event stream client for `dsh-api /events`.
 *
 * The plugin publishes internal dsh events (agent-idle, approval-needed,
 * heartbeat, …) as Server-Sent Events. This module opens a single HTTP GET,
 * parses the SSE frames, and dispatches `(eventName, payload)` to the
 * caller. It transparently reconnects with exponential back-off — the
 * desktop shell should call `openEventStream` exactly once at startup and
 * dispose it at quit.
 *
 * Design notes:
 *
 *   - Uses Node's built-in `http` (no `EventSource` dependency, no polyfill).
 *     dsh binds 127.0.0.1 only, so we always speak plain HTTP on loopback.
 *   - Back-off: 500 ms → 15 s cap. A successful connection resets the delay
 *     to 500 ms; a graceful `server-stopping` event triggers an immediate
 *     retry (with the same back-off ceiling on repeated failure).
 *   - Heartbeats: the plugin sends one every 25 s. We watch the incoming
 *     data flow; if no bytes arrive for 60 s the underlying socket has
 *     silently died, so we destroy and reconnect.
 *   - Never throws. Every failure funnels through `onError` (for logging)
 *     and the reconnect timer.
 */

'use strict';

const http = require('http');

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;
const IDLE_TIMEOUT_MS = 60_000;

/**
 * @param {number} port  dsh port
 * @param {{
 *   pathname?: string,
 *   onEvent: (event: string, payload: unknown) => void,
 *   onError?: (err: Error) => void,
 *   onOpen?: () => void,
 * }} opts
 * @returns {() => void}  dispose function; safe to call repeatedly.
 */
function openEventStream(port, opts) {
  const pathname = opts.pathname || '/dsh-api/events';
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  const onOpen  = typeof opts.onOpen  === 'function' ? opts.onOpen  : () => {};

  let cancelled = false;
  let retryMs = INITIAL_RETRY_MS;
  let currentReq = null;
  let retryTimer = null;
  let idleTimer = null;

  const scheduleRetry = (reason) => {
    if (cancelled) return;
    if (reason) onError(reason);
    if (retryTimer) return;   // retry already armed
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      connect();
    }, retryMs);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // The server should have sent a heartbeat by now. Assume the socket
      // is silently dead (e.g. laptop-sleep TCP RST loss) and reconnect.
      const req = currentReq; currentReq = null;
      try { req?.destroy(new Error('sse idle timeout')); } catch { /* ignore */ }
      scheduleRetry(new Error('sse idle timeout'));
    }, IDLE_TIMEOUT_MS);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  const connect = () => {
    if (cancelled) return;
    let buffer = '';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers: { accept: 'text/event-stream', 'cache-control': 'no-store' },
    }, (res) => {
      if (res.statusCode !== 200) {
        // 404 / 503 / 5xx — plugin not loaded, or dsh reused without patch.
        // Retry with back-off; the plugin may appear later (e.g. reload).
        res.resume();
        scheduleRetry(new Error(`sse status ${res.statusCode}`));
        return;
      }
      retryMs = INITIAL_RETRY_MS;
      currentReq = req;
      onOpen();
      armIdleTimer();
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        armIdleTimer();
        buffer += chunk;
        // SSE frames are separated by a blank line (\n\n).
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'server-stopping') {
            // Server is going away cleanly; reconnect promptly.
            scheduleRetry();
            continue;
          }
          if (parsed.event === 'heartbeat' || parsed.event === 'ready') {
            // Liveness only; the idle timer has already been rearmed.
            continue;
          }
          try {
            const payload = parsed.data ? JSON.parse(parsed.data) : {};
            onEvent(parsed.event, payload);
          } catch (e) {
            onError(new Error(`sse payload parse: ${e.message}`));
          }
        }
      });
      const finish = (err) => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (currentReq === req) currentReq = null;
        scheduleRetry(err instanceof Error ? err : undefined);
      };
      res.on('end', () => finish());
      res.on('error', finish);
      res.on('close', () => finish());
    });
    req.on('error', (err) => {
      currentReq = null;
      scheduleRetry(err);
    });
    // Ensure the request itself doesn't inherit any short socket timeout.
    // We rely on our own idle detector, above.
    req.setTimeout(0);
    req.end();
  };

  connect();

  return function dispose() {
    if (cancelled) return;
    cancelled = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (idleTimer)  { clearTimeout(idleTimer);  idleTimer  = null; }
    try { currentReq?.destroy(); } catch { /* ignore */ }
    currentReq = null;
  };
}

/**
 * Parse one raw SSE frame (no trailing \n\n). Handles `event:` and one or
 * more `data:` lines (per SSE, multiple data lines are joined with \n).
 * Returns `null` if the frame has no data (e.g. a `retry:` directive).
 */
function parseSseFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith(':')) continue;   // comment
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
    }
    // ignore `retry:` and other fields — we don't act on them
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

module.exports = { openEventStream, _parseSseFrame: parseSseFrame };
