/**
 * externalLinks.js — Route external HTTP(S) links out of the desktop shell
 * to the user's default browser.
 *
 * The problem this solves: dsh is a Web app served on 127.0.0.1:<port>. A
 * link to any other origin (a docs page, a repo URL, a shared session on
 * some other host) that the user clicks inside our main window would
 * otherwise navigate the top-level frame away from dsh — turning the
 * desktop app into a generic browser stuck on foreign content, with no
 * way to get back short of ⌘R + retype the URL. That's neither what the
 * user wants nor what dsh's authors expect.
 *
 * The three Electron entry points that need to be handled together
 * (missing any one leaves a hole):
 *
 *   1. setWindowOpenHandler   — `window.open()`, `target="_blank"`, middle
 *                               click, `<form target="_blank">`. Default
 *                               action is "open a new Electron window"
 *                               — always undesirable here.
 *   2. will-navigate          — top-level navigations that stay in-frame
 *                               (`location.href = …`, plain `<a>` click).
 *   3. will-frame-navigate    — same, but for sub-frames (rarer, but a
 *                               same-window YouTube embed clicking through
 *                               would count).
 *
 * Scope decision, per the desktop-app contract:
 *   - Anything hosted on 127.0.0.1:<current-dsh-port> stays in the window.
 *     This includes dsh's own in-page routing (`/session/…`, `/settings`,
 *     etc.), which uses full navigations rather than SPA replaces on some
 *     paths.
 *   - Anything else with an http(s) scheme is opened in the default
 *     browser and the shell navigation is cancelled.
 *   - Other schemes (`mailto:`, `file://`, `vscode:`) are LEFT ALONE.
 *     Electron's default handling for those is fine — `mailto:` goes to
 *     the OS mail handler, `file://` is blocked by Electron by default,
 *     etc. We deliberately don't wrap them: policy for those belongs
 *     upstream, not here.
 *
 * Ports are looked up through a callback the caller injects
 * (`getDshPort()`) so the module can react to workspace switches and
 * "Restart dsh" without needing to be re-installed on each port change.
 */

'use strict';

const { shell } = require('electron');
const { log } = require('./logger');

/**
 * Install the three handlers on the given `webContents`. Idempotent per
 * webContents: repeated calls just remove the previous handler set and
 * re-arm with the latest `getDshPort` closure (Electron doesn't let us
 * un-set setWindowOpenHandler, so we swap it for a fresh function).
 *
 * @param {import('electron').WebContents} wc
 * @param {{ getDshPort: () => number | null | undefined }} opts
 * @returns {{ dispose: () => void }}
 *   dispose() removes the event listeners it added and replaces
 *   setWindowOpenHandler with a permissive default. Safe to call
 *   before wc is destroyed; a no-op after.
 */
function install(wc, { getDshPort }) {
  if (!wc || wc.isDestroyed()) {
    return { dispose() {} };
  }
  if (typeof getDshPort !== 'function') {
    throw new TypeError('externalLinks.install: getDshPort must be a function');
  }

  // Decide once, at click time, whether `url` is our-own-dsh or foreign.
  // Constructor throws on malformed input, which we treat as foreign — no
  // valid dsh URL would be unparseable, and letting an error propagate
  // would let a broken link crash the click handler.
  const isForeignHttp = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const port = String(getDshPort() ?? '');
      const isLocalHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      if (!isLocalHost) return true;
      // Same host but a different port is also foreign — we don't own
      // localhost, only our specific dsh port.
      if (port && u.port !== port) return true;
      return false;
    } catch (_) {
      // Unparseable — safest to treat as foreign so we don't accidentally
      // let it navigate the shell into a broken state.
      return true;
    }
  };

  const openInBrowser = (url) => {
    log('externalLinks: opening in default browser:', url);
    shell.openExternal(url).catch((e) => log('shell.openExternal failed:', e && e.message));
  };

  // 1. window.open / target=_blank / middle-click
  wc.setWindowOpenHandler(({ url }) => {
    // For http(s) foreign URLs: hand off to the OS browser and deny the
    // new-window request. For anything else (including same-origin
    // window.open of a dsh internal page, which dsh may use for a popup),
    // still deny — a popup here would produce a chrome-less BrowserWindow
    // that the user can't manage. If dsh ever needs a real in-app popup
    // we can revisit this policy row by row.
    if (isForeignHttp(url)) openInBrowser(url);
    else log('externalLinks: blocked non-foreign new-window request:', url);
    return { action: 'deny' };
  });

  // 2. top-level navigations
  const onWillNavigate = (event, url) => {
    if (!isForeignHttp(url)) return; // let dsh navigate itself
    event.preventDefault();
    openInBrowser(url);
  };
  wc.on('will-navigate', onWillNavigate);

  // 3. sub-frame navigations (Electron 22+; feature-detected)
  const onWillFrameNavigate = (details) => {
    // The event object shape differs across Electron versions; guard both.
    const url = details?.url || (details?.event && details.event.url);
    if (!url) return;
    if (!isForeignHttp(url)) return;
    if (typeof details?.preventDefault === 'function') details.preventDefault();
    else if (details?.event && typeof details.event.preventDefault === 'function') details.event.preventDefault();
    openInBrowser(url);
  };
  // `will-frame-navigate` was added in Electron 22. If the runtime is
  // older, `wc.on` still accepts the string but no events will fire —
  // functionally the same as not registering, so there's no branch here.
  wc.on('will-frame-navigate', onWillFrameNavigate);

  return {
    dispose() {
      if (wc.isDestroyed()) return;
      try { wc.removeListener('will-navigate', onWillNavigate); } catch { /* ignore */ }
      try { wc.removeListener('will-frame-navigate', onWillFrameNavigate); } catch { /* ignore */ }
      // Reset to Electron's default (allow new windows). We do this so a
      // subsequent install() on the same wc — should there ever be one —
      // starts from a known state.
      try { wc.setWindowOpenHandler(() => ({ action: 'allow' })); } catch { /* ignore */ }
    },
  };
}

module.exports = { install };
