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

const fs = require('fs');
const os = require('os');
const path = require('path');
const pluginClient = require('./pluginClient');
const { log } = require('./logger');

const SUPPORTED_LANGS = ['en', 'zh'];
const LANG_FILE = path.join(os.homedir(), '.dsh-desktop.lang');
const DEFAULT_LANG = detectDefaultLang();

const POLL_INTERVAL_MS = 3000;

let currentLang = loadInitialLang();
let dict = loadDict(currentLang);
const listeners = new Set();
let pollTimer = null;

/** Detect from LANG / LC_ALL / LC_MESSAGES; default en. */
function detectDefaultLang() {
  const locale = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || 'en').toLowerCase();
  if (locale.startsWith('zh')) return 'zh';
  return 'en';
}

/** Restore last-known-good language from the local memory file (best-effort). */
function loadInitialLang() {
  try {
    const saved = fs.readFileSync(LANG_FILE, 'utf8').trim();
    if (SUPPORTED_LANGS.includes(saved)) return saved;
  } catch { /* file missing or unreadable, that's fine */ }
  return DEFAULT_LANG;
}

/** Load a locale dictionary from disk, falling back to en, then empty. */
function loadDict(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${lang}.json`), 'utf8'));
  } catch {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8')); }
    catch { return {}; }
  }
}

/** Persist local language memory (for the next launch, before dsh is up). */
function saveLang(lang) {
  try { fs.writeFileSync(LANG_FILE, lang); } catch { /* not fatal */ }
}

/**
 * Translate a dotted key with `{{var}}` interpolation.
 * @param {string} key   Dotted path like `steps.start.ready`
 * @param {object} vars  Interpolation vars, e.g. `{ port: 3081 }`
 * @returns {string}     Original key when missing
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
function getDict() { return dict; }

/** Switch language: swap dict, persist local memory, notify listeners. */
function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  dict = loadDict(lang);
  saveLang(lang);
  listeners.forEach(fn => { try { fn(lang); } catch (e) { log('i18n listener error:', e && e.message); } });
}

function onLangChange(fn) { listeners.add(fn); }

/**
 * Start polling the dsh-api plugin for the authoritative language and mirror
 * changes into the shell. This replaces the previous fs.watch on dsh's
 * settings.yaml — the plugin is the only interface to dsh internals now.
 * Returns a stop function.
 */
function watchDshLanguage() {
  const tick = async () => {
    const lang = await pluginClient.getLanguage();
    if (lang && SUPPORTED_LANGS.includes(lang) && lang !== currentLang) {
      setLang(lang);
    }
  };
  // Fire once immediately (dsh may already be up), then on interval.
  tick().catch(() => {});
  pollTimer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  return () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
}

module.exports = { t, getLang, setLang, getSupportedLangs, onLangChange, getDict, watchDshLanguage };
