/**
 * connectionMonitor.js — dsh connection state machine.
 *
 * Consolidates every "is dsh reachable right now?" signal into a single
 * observable state, so callers (banner, notifier, menu enable/disable, …)
 * don't each maintain their own timers and thresholds.
 *
 * State machine (deliberately three states — no need for finer grain):
 *
 *   healthy       SSE handshake open, or a recent onOpen and no errors since.
 *   reconnecting  ≥ RECONNECT_THRESHOLD consecutive SSE errors observed.
 *                 The banner is visible in "auto-retry in progress" mode.
 *   lost          Consecutive errors have persisted for LOST_AFTER_MS with
 *                 no successful onOpen. The banner surfaces a "Restart dsh"
 *                 button; auto-reconnect (in apiClient) keeps running.
 *
 * Contract for callers:
 *
 *   - `onOpen()`  MUST be invoked from apiClient's onOpen callback.
 *   - `onError()` MUST be invoked from apiClient's onError callback.
 *     (Both must be idempotent and cheap; apiClient may call them often.)
 *   - `subscribe(fn)` sends the current state immediately, then every change.
 *     Returned unsubscribe function is safe to call multiple times.
 *   - `getState()` returns the current state snapshot (never null).
 *
 * The monitor does not itself reconnect — apiClient's exponential back-off
 * owns that. It also does not restart dsh — that's a menu / banner action
 * routed through capabilities. Its only job is state tracking.
 */

'use strict';

const { log } = require('./logger');

const RECONNECT_THRESHOLD = 2;   // consecutive errors before we alarm
const LOST_AFTER_MS = 15_000;    // sustained-outage threshold

/** @typedef {{ state: 'healthy'|'reconnecting'|'lost', since: number, error: string|null }} MonitorState */

function createMonitor() {
  /** @type {MonitorState} */
  let state = { state: 'healthy', since: Date.now(), error: null };
  let consecutiveErrors = 0;
  let firstErrorAt = 0;
  let lostTimer = null;
  const subscribers = new Set();

  const clearLostTimer = () => {
    if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
  };

  const publish = () => {
    // Emit a shallow snapshot so subscribers can't mutate our state.
    const snap = { ...state };
    for (const fn of Array.from(subscribers)) {
      try { fn(snap); }
      catch { /* subscriber bug — never propagate */ }
    }
  };

  const setState = (next, error = null) => {
    if (state.state === next && state.error === error) return;
    state = { state: next, since: Date.now(), error };
    log('monitor: state -> ' + next + (error ? ' err=' + error : '') + ' subs=' + subscribers.size);
    publish();
  };

  return {
    /** Notify: SSE handshake open (or a data frame arrived). */
    onOpen() {
      log('monitor: onOpen');
      consecutiveErrors = 0;
      firstErrorAt = 0;
      clearLostTimer();
      setState('healthy', null);
    },

    /**
     * Notify: SSE errored, got a non-200 status, timed out, or the socket
     * closed. `err` may be an Error or a plain message.
     */
    onError(err) {
      consecutiveErrors += 1;
      const message = err instanceof Error ? err.message : (err ? String(err) : 'disconnected');
      log('monitor: onError #' + consecutiveErrors + ' state=' + state.state + ' msg=' + message);

      if (consecutiveErrors < RECONNECT_THRESHOLD) {
        // Single hiccups are common (dsh reload, LAN blip) — stay quiet.
        return;
      }
      if (firstErrorAt === 0) firstErrorAt = Date.now();

      // Escalate to 'reconnecting' on the first alarm-worthy failure, and
      // arm the 'lost' timer. Every subsequent error inside the window
      // just refreshes the message.
      if (state.state === 'healthy') {
        setState('reconnecting', message);
        clearLostTimer();
        lostTimer = setTimeout(() => {
          // Still down after LOST_AFTER_MS with no onOpen call — escalate.
          setState('lost', message);
        }, LOST_AFTER_MS);
        if (typeof lostTimer.unref === 'function') lostTimer.unref();
      } else if (state.state === 'reconnecting') {
        // Refresh the message without publishing repeated state churn.
        // (setState is a no-op when both state and error are unchanged.)
        setState('reconnecting', message);
      }
      // While already 'lost', additional errors don't change anything.
    },

    /** Force a state (used only by the manual "Restart dsh" flow). */
    reset() {
      consecutiveErrors = 0;
      firstErrorAt = 0;
      clearLostTimer();
      setState('healthy', null);
    },

    /**
     * Subscribe to state changes. Immediately delivers the current snapshot
     * so consumers don't need a separate `getState()` read to render.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subscribers.add(fn);
      try { fn({ ...state }); } catch { /* ignore */ }
      return () => { subscribers.delete(fn); };
    },

    /** Current snapshot (defensive copy). */
    getState() { return { ...state }; },

    /** Dispose all listeners and pending timers. */
    dispose() {
      subscribers.clear();
      clearLostTimer();
    },
  };
}

module.exports = { createMonitor, RECONNECT_THRESHOLD, LOST_AFTER_MS };
