/**
 * upstream.js — Silent upstream Harness (`@deepseek-ai/dsh`) sync.
 *
 * Every launch, once the main window is up, we ask the npm registry for the
 * newest `latest` version of `@deepseek-ai/dsh`. If the local npx cache is
 * behind, we prefetch the new version silently — the running dsh instance
 * keeps its current version, but the **next** launch picks the newer entry
 * point via `dshEntryPath()` (which prefers the highest cached version).
 *
 * Design constraints:
 *
 *   - Never blocks the UI. All work is async, silently swallows errors.
 *   - Throttled to at most once per 24h unless the caller asks for a manual
 *     check (menu → "Check for updates").
 *   - Never installs pre-release channels. Only the `latest` dist-tag.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { homePath, readJsonSafe, writeJsonAtomic } = require('./fsx');
const { log } = require('./logger');

const STATE_FILE = homePath('.dsh-desktop.upstream.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const REGISTRY_TIMEOUT_MS = 3000;

// ── Semver helpers ───────────────────────────────────────────────────────────
//
// The user asked for the `latest` dist-tag only — we do NOT switch to `next`
// or `beta`. But `latest` itself may point at any string npm accepts (e.g.
// `0.1.0-rc.7` today for @deepseek-ai/dsh). So the parser accepts a semver
// with an optional pre-release identifier, and comparisons order pre-releases
// before their stable counterpart in the standard semver way. We refuse only
// values we cannot parse at all.

/** Parse `X.Y.Z` or `X.Y.Z-<pre>` into a comparable tuple. Returns null on garbage. */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || null,
  };
}

/** Compare two pre-release identifier chunks per SemVer §11 rules. */
function cmpPreChunk(a, b) {
  const anum = /^\d+$/.test(a), bnum = /^\d+$/.test(b);
  if (anum && bnum) return Number(a) - Number(b);
  if (anum) return -1;
  if (bnum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two semver strings. Positive if a > b, 0 if equal, negative otherwise. */
function cmpSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  if (A.patch !== B.patch) return A.patch - B.patch;
  // A pre-release has lower precedence than its stable equivalent.
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  const aa = A.pre.split('.'), bb = B.pre.split('.');
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const c = cmpPreChunk(aa[i], bb[i]);
    if (c !== 0) return c;
  }
  return aa.length - bb.length;
}

// ── State ────────────────────────────────────────────────────────────────────

function readState() {
  return readJsonSafe(STATE_FILE, { lastCheckedAt: 0, latest: null, prefetchedAt: 0 });
}
function writeState(patch) {
  const s = { ...readState(), ...patch };
  return writeJsonAtomic(STATE_FILE, s);
}

// ── Cache probe ──────────────────────────────────────────────────────────────

/**
 * Scan every npx cache entry for `@deepseek-ai/dsh` and report the highest
 * stable version found. Returns `null` if no cache exists yet.
 */
function readCachedDshVersion() {
  try {
    const cacheDir = homePath('.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return null;
    let best = null;
    for (const d of fs.readdirSync(cacheDir)) {
      const pkgFile = path.join(cacheDir, d, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      const pkg = readJsonSafe(pkgFile, null);
      if (!pkg || !pkg.version) continue;
      if (!best || cmpSemver(pkg.version, best) > 0) best = pkg.version;
    }
    return best;
  } catch { return null; }
}

// ── Registry query ───────────────────────────────────────────────────────────

/**
 * Ask registry.npmjs.org for the current `latest` dist-tag of
 * `@deepseek-ai/dsh`. Returns a version string or `null` on any failure.
 */
function fetchLatestDshVersion({ timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const url = 'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags';
    const req = https.get(url, { headers: { 'accept': 'application/json' } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 32 * 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const v = j && j.latest;
          if (parseSemver(v)) resolve(v);
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ── Prefetch ─────────────────────────────────────────────────────────────────

/**
 * Trigger `npx --yes @deepseek-ai/dsh@<version> --version` so npm caches
 * the requested version. We ignore stdout — the side effect is what matters.
 *
 * @param {string} version
 * @param {{ npxPath?: string, env?: object, onLog?: (s: string) => void }} opts
 */
function prefetchDsh(version, { npxPath, env, onLog } = {}) {
  return new Promise((resolve, reject) => {
    if (!parseSemver(version)) {
      return reject(new Error(`prefetchDsh: refusing unparseable version ${version}`));
    }
    const bin = npxPath || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
    log(`upstream: prefetching @deepseek-ai/dsh@${version} via ${bin}`);
    const proc = spawn(bin, ['--yes', `@deepseek-ai/dsh@${version}`, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env || process.env,
      shell: false,
    });
    let stderr = '';
    proc.stdout.on('data', d => { onLog?.(d.toString()); });
    proc.stderr.on('data', d => { stderr += d; onLog?.(d.toString()); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`prefetch exit ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', err => reject(err));
  });
}

// ── Public orchestrator ──────────────────────────────────────────────────────

/**
 * One background check + (if warranted) prefetch. Never throws. Returns a
 * summary object describing what happened.
 *
 * @param {{ npxPath?: string, env?: object, force?: boolean }} opts
 * @returns {Promise<{
 *   status: 'skipped-throttled' | 'up-to-date' | 'no-network' | 'upgraded' | 'failed',
 *   latest?: string,
 *   cached?: string,
 *   error?: string,
 * }>}
 */
async function checkUpstreamNow({ npxPath, env, force = false } = {}) {
  const state = readState();
  const now = Date.now();
  if (!force && state.lastCheckedAt && now - state.lastCheckedAt < CHECK_INTERVAL_MS) {
    log(`upstream: throttled (last check ${new Date(state.lastCheckedAt).toISOString()})`);
    return { status: 'skipped-throttled', latest: state.latest, cached: readCachedDshVersion() };
  }

  const latest = await fetchLatestDshVersion();
  if (!latest) {
    // Record the attempt so we don't hammer registry when offline.
    writeState({ lastCheckedAt: now });
    log('upstream: registry query failed (offline or blocked)');
    return { status: 'no-network' };
  }

  const cached = readCachedDshVersion();
  writeState({ lastCheckedAt: now, latest });

  if (cached && cmpSemver(cached, latest) >= 0) {
    log(`upstream: up-to-date (cached=${cached}, latest=${latest})`);
    return { status: 'up-to-date', latest, cached };
  }

  try {
    await prefetchDsh(latest, { npxPath, env });
    writeState({ prefetchedAt: Date.now() });
    log(`upstream: prefetched ${latest} (was ${cached || 'none'})`);
    return { status: 'upgraded', latest, cached };
  } catch (err) {
    log('upstream: prefetch failed:', err && err.message);
    return { status: 'failed', latest, cached, error: (err && err.message) || String(err) };
  }
}

/**
 * Schedule a silent background check some time after startup. Fire-and-forget:
 * failures are logged and never surfaced. This is what `main.js` calls once
 * the main window is up.
 */
function scheduleSilentUpgrade({ delayMs = 5000, npxPath, env } = {}) {
  const timer = setTimeout(() => {
    checkUpstreamNow({ npxPath, env, force: false }).catch(e => {
      log('upstream: scheduled check unexpectedly rejected:', e && e.message);
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  checkUpstreamNow,
  scheduleSilentUpgrade,
  fetchLatestDshVersion,
  readCachedDshVersion,
  cmpSemver,
  STATE_FILE,
};
