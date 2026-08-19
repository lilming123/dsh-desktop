/**
 * setup.js — bootstrap pipeline orchestration.
 *
 * Three visible steps drive the splash from launch to a live dsh window:
 *
 *   1. runtime — provision Node.js and verify @deepseek-ai/dsh is
 *      installed. Was two separate splash lines ("Checking Node.js" +
 *      "Checking @deepseek-ai/dsh"); collapsed into one because they
 *      always run back-to-back and, together, mean "the harness itself
 *      is ready".
 *
 *   2. start — start (or reuse) the dsh service on a free port. dsh's
 *      default profile bundle includes `dshmarket`, so as soon as the
 *      service is up its /dsh-market/* routes are mounted too. This
 *      step used to come after the plugin step; it now comes BEFORE it
 *      so the next step can talk to dshmarket over HTTP.
 *
 *   3. plugin — install `dsh-api` through dshmarket's install route.
 *      Falls back to the bundled shell copy (via `--patch`) if the
 *      curated registry rejects the source or dshmarket is unreachable.
 *      The bundled path is exactly what earlier versions of the shell
 *      did and remains a safe last resort.
 *
 * The old "Opening UI" step was removed: it never did any real work
 * and only added visual noise between step 3 done and the main window
 * actually appearing.
 *
 * The pipeline is best-effort: any step that can succeed with a
 * fallback (dsh-api install, in particular) does so silently and the
 * splash reports the fallback outcome as a normal `done`. Only truly
 * fatal failures (Node provisioning broken, dsh cannot start) surface
 * as `error` states with a Retry button.
 */

'use strict';

const { ensureInstalled } = require('./install');
const {
  ensureDsh, installApiPlugin, detectInstalledApiPlugin, setRuntime,
} = require('./dsh');
const { ensureRuntime } = require('./runtime');
const dshmarket = require('./dshMarketClient');
const { log } = require('./logger');
const { t } = require('./i18n');

// The canonical dsh-api source url as it appears in dshmarket's curated
// registry. When PR #1924 lands in awesome-dsh-plugin/plugins.json this
// exact url will be there. Until then the install route returns 400
// ("plugin is not in the curated registry") and we take the bundled
// fallback path — user-visible behaviour is identical either way.
const DSH_API_REGISTRY_URL = 'https://github.com/lilming123/dsh-api';

/**
 * Send a step-progress event to the splash renderer.
 * @param {BrowserWindow} win
 * @param {'runtime' | 'start' | 'plugin'} step
 * @param {'active' | 'done' | 'error'} state
 * @param {{ label?: string, msg?: string, pct?: number }} [opts]
 */
function progress(win, step, state, opts = {}) {
  log(`progress: ${step}=${state}`, opts);
  win?.webContents?.send('progress', { step, state, ...opts });
}

/**
 * Translate an ensureRuntime phase event into a splash progress row.
 * runtime + install share the 0–45% slice of the bar; the Node phases
 * end at ~30 and the "checking dsh" phase caps at 45 so `start` picks
 * up around 55.
 */
function mapRuntimeProgress(splashWin, evt) {
  const { phase, pct, version } = evt || {};
  switch (phase) {
    case 'detecting-system':
      progress(splashWin, 'runtime', 'active', { label: t('steps.runtime.checking'), pct: 4 });
      return;
    case 'system-found':
      progress(splashWin, 'runtime', 'active', {
        msg: t('steps.runtime.systemNodeFound', { version }), pct: 25,
      });
      return;
    case 'bundled-ready':
      progress(splashWin, 'runtime', 'active', {
        msg: t('steps.runtime.bundledNodeReady', { version }), pct: 25,
      });
      return;
    case 'bundled-preparing':
      progress(splashWin, 'runtime', 'active', {
        label: t('steps.runtime.bundling', { version }), pct: 6,
      });
      return;
    case 'downloading':
      // Registry download 0–100% → splash 6–22%.
      progress(splashWin, 'runtime', 'active', {
        label: t('steps.runtime.downloading', { pct: pct || 0 }),
        pct: 6 + Math.floor((pct || 0) * 0.16),
      });
      return;
    case 'extracting':
      progress(splashWin, 'runtime', 'active', { label: t('steps.runtime.extracting'), pct: 24 });
      return;
    case 'done':
      // Emitted by ensureRuntime just before it returns. The caller
      // renders the final "done" for step 1 once install verification
      // (Step 1's second half) is also complete.
      return;
    default:
      log('runtime: unhandled progress phase', phase);
  }
}

/**
 * Run the full setup pipeline.
 * @param {BrowserWindow} splashWin
 * @param {(port: number) => void} openMain
 */
async function runSetup(splashWin, openMain) {
  // ── Step 1: runtime — Node + dsh ────────────────────────────────────
  progress(splashWin, 'runtime', 'active', { label: t('steps.runtime.checking'), pct: 4 });

  let rt;
  try {
    rt = await ensureRuntime({
      onProgress: (evt) => mapRuntimeProgress(splashWin, evt),
    });
  } catch (e) {
    progress(splashWin, 'runtime', 'error', {
      msg: t('steps.runtime.provisionFailed') + ' — ' + (e && e.message),
    });
    throw e;
  }
  setRuntime(rt);

  // Node ready → verify dsh install (fast when already installed).
  progress(splashWin, 'runtime', 'active', {
    label: t('steps.runtime.verifyingDsh'), pct: 35,
  });
  await ensureInstalled();

  const nodeMsg = rt.mode === 'system'
    ? t('steps.runtime.systemNodeFound', { version: rt.version })
    : t('steps.runtime.bundledNodeReady', { version: rt.version });
  progress(splashWin, 'runtime', 'done', {
    label: t('steps.runtime.ready', { node: nodeMsg }), pct: 45,
  });

  // ── Step 2: start — spawn or reuse dsh ──────────────────────────────
  progress(splashWin, 'start', 'active', { label: t('steps.start.starting'), pct: 55 });

  let result;
  try {
    result = await ensureDsh((stdout) => {
      progress(splashWin, 'start', 'active', { msg: stdout.slice(0, 80), pct: 65 });
    });
  } catch (e) {
    const msg = e.message.includes('No free port')
      ? t('steps.start.noFreePort')
      : t('steps.start.portInUse', { port: 3080 });
    progress(splashWin, 'start', 'error', { msg });
    throw e;
  }
  progress(splashWin, 'start', 'done', {
    label: result.mode === 'reused'
      ? t('steps.start.reused', { port: result.port })
      : t('steps.start.ready', { port: result.port }),
    pct: 75,
  });

  // ── Step 3: plugin — install dsh-api via dshmarket ──────────────────
  await ensureApiPlugin(splashWin, result.port);

  // No terminal "Opening UI" step — main.js opens the window immediately.
  openMain(result.port);
}

/**
 * Ensure the dsh-api plugin is loadable by dsh.
 *
 * Three paths, tried in order:
 *
 *   A. Already installed (fresh npm resolve in ~/.dsh/profiles/web).
 *      Detected pre-emptively; the shell only enforces the "no stale
 *      bundled copy shadowing a real install" invariant.
 *
 *   B. dshmarket install route accepts the source url. This is the
 *      normal happy path once dsh-api lives in the curated registry.
 *      dshmarket runs `dsh plugin --profile web add …` internally, so
 *      we get exactly the same result as the CLI path — just gated
 *      through the market's curation.
 *
 *   C. dshmarket rejects the url (not in registry today) OR dshmarket
 *      is unreachable OR the install returns an error. Fall back to
 *      the desktop-bundled copy: dsh loads it via a `--patch` layer
 *      and the /dsh-api endpoints work identically for the user.
 *
 * We never fail the pipeline here — dsh boots without dsh-api and the
 * shell degrades gracefully (no menu integration, no notifications).
 */
async function ensureApiPlugin(splashWin, port) {
  // A. Already installed → nothing to do.
  if (detectInstalledApiPlugin()) {
    progress(splashWin, 'plugin', 'done', {
      label: t('steps.plugin.installed'), pct: 100,
    });
    // Enforce "npm install shadows any bundled fallback" via installApiPlugin:
    // it clears the bundled copy when it detects a real install.
    installApiPlugin();
    return;
  }

  // B. Ask dshmarket to install it. dshmarket's registry gates the source,
  //    so this only succeeds once dsh-api is listed there. When it's not
  //    (today, before PR #1924 lands) we get a 400 and drop to (C).
  progress(splashWin, 'plugin', 'active', {
    label: t('steps.plugin.installingViaMarket'), pct: 82,
  });
  const r = await dshmarket.installPlugin(port, DSH_API_REGISTRY_URL);
  if (r.ok) {
    // Post-install, dshmarket runs pnpm inside the profile; detection
    // should now see it. Belt-and-braces: don't just trust r.ok.
    if (detectInstalledApiPlugin()) {
      progress(splashWin, 'plugin', 'done', {
        label: t('steps.plugin.installedViaMarket'), pct: 100,
      });
      installApiPlugin(); // clears bundled shadow
      return;
    }
    log('dsh-api plugin: dshmarket reported ok but detection failed');
    // Fall through to bundled fallback rather than error out.
  }

  // C. Bundled fallback. This is what the older setup did on the failure
  //    path; it's a first-class supported mode (loaded via --patch).
  log('dsh-api plugin: dshmarket install unavailable, using bundled fallback:', r.error || 'n/a');
  const bundled = installApiPlugin();
  if (bundled === 'installed' || bundled === 'skipped-installed') {
    progress(splashWin, 'plugin', 'done', {
      label: t('steps.plugin.usingBundled'), pct: 100,
    });
    return;
  }

  // Neither path worked. We surface the error but let the app boot —
  // dsh still starts, dsh-api endpoints simply won't be available.
  progress(splashWin, 'plugin', 'error', {
    msg: t('steps.plugin.bothFailed', { error: r.error || 'unknown' }),
  });
}

module.exports = { runSetup, progress };
