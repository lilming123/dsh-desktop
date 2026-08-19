/**
 * notifier.js — Electron system notifications for dsh events.
 *
 * Wires two notification kinds to two dsh-plugin SSE events:
 *
 *   - `agent-idle`      → "Task complete"  — one agent finished a turn.
 *   - `approval-needed` → "Approval needed" — dsh is about to ask the user
 *                         to confirm something.
 *
 * Behavioural rules:
 *
 *   1. If the main window is present AND focused, we stay silent. The user
 *      is already watching dsh; a system-notification banner would be pure
 *      noise.
 *   2. Clicking a notification always brings the main window to the front.
 *      When the payload carries a sessionId, we forward it to the app-level
 *      capability so the UI can navigate to that session (if implemented).
 *   3. The module exposes a single `install()` entry point returning a
 *      dispose function; main.js owns exactly one instance.
 *
 * The `Notification` API is cross-platform; on Linux and Windows we set
 * `urgency: 'critical'` on approvals so notification managers keep them
 * on-screen until dismissed. macOS ignores that field cleanly.
 */

'use strict';

const path = require('path');
const { Notification } = require('electron');
const { log } = require('./logger');

const ICON_PATH = path.join(__dirname, '..', 'icon.png');

/**
 * @param {{
 *   getMainWindow: () => (import('electron').BrowserWindow | null),
 *   translate: (key: string, params?: Record<string, string>) => string,
 *   isEnabled?: () => boolean,
 *   onFocusRequest?: (payload: { sessionId?: string | null }) => void,
 * }} deps
 * @returns {{
 *   handleEvent: (event: string, payload: any) => void,
 *   dispose: () => void,
 * }}
 */
function install(deps) {
  const {
    getMainWindow,
    translate,
    isEnabled = () => true,
    onFocusRequest = () => {},
  } = deps;

  // Track live Notification objects so we can close them on dispose. Notifi-
  // cation objects don't hold the process open, but this lets tests observe
  // that we haven't leaked references, and lets a "quit while pending"
  // flow tidy up cleanly.
  const live = new Set();

  const canNotify = () => {
    if (!isEnabled()) return false;
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      return false;
    }
    const win = getMainWindow();
    // Silent when the app is in the foreground: the user can see dsh directly.
    if (win && !win.isDestroyed() && win.isFocused()) return false;
    return true;
  };

  const buildAndShow = (options, payload) => {
    if (!canNotify()) return;
    let n;
    try {
      n = new Notification({
        icon: ICON_PATH,
        silent: false,
        ...options,
      });
    } catch (e) {
      log('notifier: failed to construct Notification:', e && e.message);
      return;
    }
    live.add(n);
    n.on('click', () => {
      try {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        onFocusRequest({ sessionId: payload?.sessionId ?? null });
      } catch (e) {
        log('notifier: click handler error:', e && e.message);
      }
    });
    n.on('close', () => { live.delete(n); });
    try { n.show(); } catch (e) { log('notifier: show failed:', e && e.message); }
  };

  const onAgentIdle = (payload) => {
    const title = translate('notify.taskDone.title');
    const body = translate('notify.taskDone.body', {
      title: (payload && typeof payload.title === 'string' && payload.title) || '',
    }).trim();
    buildAndShow({ title, body }, payload);
  };

  const onApprovalNeeded = (payload) => {
    const title = translate('notify.approval.title');
    const body = translate('notify.approval.body', {
      summary: (payload && typeof payload.summary === 'string' && payload.summary) || '',
    }).trim();
    // `urgency` is respected on Linux/Windows; macOS ignores it silently.
    buildAndShow({ title, body, urgency: 'critical' }, payload);
  };

  const handleEvent = (event, payload) => {
    if (event === 'agent-idle')      return onAgentIdle(payload);
    if (event === 'approval-needed') return onApprovalNeeded(payload);
    // Unknown events (e.g. future additions) are silently ignored so the
    // notifier stays forward-compatible with newer dsh-plugin versions.
  };

  const dispose = () => {
    for (const n of Array.from(live)) {
      try { n.close(); } catch { /* already gone */ }
    }
    live.clear();
  };

  return { handleEvent, dispose };
}

module.exports = { install };
