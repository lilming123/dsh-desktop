/**
 * i18n.js — Lightweight in-process i18n for the Electron shell.
 *
 * The app has its own menu / splash strings that live outside dsh's client
 * i18n. We keep those in `src/locales/<lang>.json` and keep the shell's
 * language in step with dsh's own language setting.
 *
 * Two rules matter here, both a consequence of the refactor:
 *
 *   1. **We never read or write `~/.dsh/settings.yaml` directly.** dsh owns
 *      that file. The shell asks the `dsh-api` plugin for the current
 *      language and lets dsh's clients refresh themselves when it changes.
 *   2. **The local `~/.dsh-desktop.lang` file is only a pre-boot memory.**
 *      Before dsh is up (splash screen, first paint of the menu), the
 *      plugin can't answer yet. We remember the last known language locally
 *      to keep the UI in the right locale during that gap. Once dsh answers,
 *      it wins.
 */

'use strict';

const path = require('path');
const { readTextSafe, writeTextAtomic, homePath, readJsonSafe } = require('./fsx');
const pluginClient = require('./pluginClient');
const { log } = require('./logger');

const SUPPORTED_LANGS = ['en', 'zh'];
/** Human-readable labels for the language switcher menu. */
const LANG_LABELS = { en: 'English', zh: '简体中文' };
const LANG_FILE = homePath('.dsh-desktop.lang');
const DEFAULT_LANG = detectDefaultLang();

const POLL_INTERVAL_MS = 3000;

let currentLang = loadInitialLang();
let dict = loadDict(currentLang);
const listeners = new Set();
let pollTimer = null;

/** Detect from LANG / LC_ALL / LC_MESSAGES; default 'en'. */
function detectDefaultLang() {
  const locale = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || 'en').toLowerCase();
  return locale.startsWith('zh') ? 'zh' : 'en';
}

/** Restore last-known-good language from the local memory file (best-effort). */
function loadInitialLang() {
  const saved = readTextSafe(LANG_FILE, '').trim();
  if (SUPPORTED_LANGS.includes(saved)) return saved;
  return DEFAULT_LANG;
}

/** Load a locale dictionary from disk, falling back to en, then empty. */
function loadDict(lang) {
  const p = path.join(__dirname, 'locales', `${lang}.json`);
  const d = readJsonSafe(p, null);
  if (d) return d;
  return readJsonSafe(path.join(__dirname, 'locales', 'en.json'), {}) || {};
}

/** Persist local language memory (for the next launch, before dsh is up). */
function saveLang(lang) { writeTextAtomic(LANG_FILE, lang); }

/**
 * Translate a dotted key with `{{var}}` interpolation.
 * @param {string} key   Dotted path like `steps.start.ready`
 * @param {object} vars  Interpolation vars, e.g. `{ port: 3081 }`
 * @returns {string}     The original key on miss (loud in the UI)
 */
function t(key, vars = {}) {
  let val = dict;
  for (const part of key.split('.')) {
    val = val?.[part];
    if (val === undefined) return key;
  }
  let str = typeof val === 'string' ? val : String(val);
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
  }
  return str;
}

function getLang() { return currentLang; }
function getSupportedLangs() { return [...SUPPORTED_LANGS]; }
function getLangLabels() { return { ...LANG_LABELS }; }
function getDict() { return dict; }

/** Switch language: swap dict, persist local memory, notify listeners. */
function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  dict = loadDict(lang);
  saveLang(lang);
  for (const fn of listeners) {
    try { fn(lang); }
    catch (e) { log('i18n listener error:', e && e.message); }
  }
}

function onLangChange(fn) { listeners.add(fn); }

/**
 * Start polling the plugin for the authoritative language and mirror changes
 * into the shell. Replaces the pre-refactor `fs.watch` on `~/.dsh/settings.yaml`
 * — the plugin is the only interface to dsh internals now.
 *
 * The interval is `unref()`d so it never keeps the Node event loop alive
 * during Electron shutdown. Returns a `stop` function for tests / repeated
 * starts.
 */
function watchDshLanguage() {
  if (pollTimer) return () => stopPolling();
  const tick = async () => {
    const lang = await pluginClient.getLanguage();
    if (lang && SUPPORTED_LANGS.includes(lang) && lang !== currentLang) setLang(lang);
  };
  // Fire once immediately (dsh may already be up), then on interval.
  tick().catch(() => {});
  pollTimer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  return () => stopPolling();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = {
  t, getLang, setLang, getSupportedLangs, getLangLabels,
  onLangChange, getDict, watchDshLanguage,
};
