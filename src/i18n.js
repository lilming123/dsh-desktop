/**
 * i18n.js — 轻量国际化模块
 *
 * 支持：英语 (en)、简体中文 (zh)
 * 语言文件在 src/locales/<lang>.json
 *
 * 语言来源优先级：
 *   1. dsh 自己的 ~/.dsh/settings.yaml 里的 locale.preference（若可读，优先跟随 dsh）
 *   2. ~/.dsh-desktop.lang（app 内菜单选择的备用持久化）
 *   3. 系统 LANG 环境变量
 *   4. 英语
 *
 * 用法：
 *   const { t, setLang, getLang, onLangChange } = require('./src/i18n');
 *   t('steps.start.ready', { port: 3081 })  // "Server ready on :3081 ✓"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SUPPORTED_LANGS = ['en', 'zh'];
const LANG_FILE = path.join(os.homedir(), '.dsh-desktop.lang');
const DSH_SETTINGS = path.join(os.homedir(), '.dsh', 'settings.yaml');
const DEFAULT_LANG = detectDefaultLang();

let currentLang = loadLang();
let dict = loadDict(currentLang);
const listeners = new Set();

/** 根据系统语言推断默认语言 */
function detectDefaultLang() {
  const locale = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || 'en').toLowerCase();
  if (locale.startsWith('zh')) return 'zh';
  return 'en';
}

/** 从 dsh 的 settings.yaml 读 locale.preference（不解析完整 YAML，简单正则即可） */
function readDshLocale() {
  try {
    if (!fs.existsSync(DSH_SETTINGS)) return null;
    const text = fs.readFileSync(DSH_SETTINGS, 'utf8');
    // 匹配 "locale:\n  preference: <值>"
    const m = text.match(/^locale:\s*\n\s+preference:\s*['"]?([\w-]+)['"]?/m);
    if (!m) return null;
    const raw = m[1].toLowerCase();
    if (raw.startsWith('zh')) return 'zh';
    if (raw.startsWith('en')) return 'en';
    return null;
  } catch { return null; }
}

/** 从配置文件读语言，优先 dsh 设置 → app 备份 → 系统默认 */
function loadLang() {
  const fromDsh = readDshLocale();
  if (fromDsh) return fromDsh;
  try {
    const saved = fs.readFileSync(LANG_FILE, 'utf8').trim();
    if (SUPPORTED_LANGS.includes(saved)) return saved;
  } catch {}
  return DEFAULT_LANG;
}

/** 加载语言包 */
function loadDict(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${lang}.json`), 'utf8'));
  } catch {
    // 回退到英文
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8')); }
    catch { return {}; }
  }
}

/** 保存语言选择 */
function saveLang(lang) {
  try { fs.writeFileSync(LANG_FILE, lang); } catch {}
}

/**
 * 翻译键值，支持插值。
 * @param {string} key   点分路径，如 'steps.start.ready'
 * @param {object} vars  插值变量，如 { port: 3081 } 替换 {{port}}
 * @returns {string}
 */
function t(key, vars = {}) {
  let val = dict;
  for (const part of key.split('.')) {
    val = val?.[part];
    if (val === undefined) return key;  // 找不到就返回 key 本身
  }
  let str = typeof val === 'string' ? val : String(val);
  // 插值 {{var}}
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
  }
  return str;
}

/** 当前语言 */
function getLang() { return currentLang; }

/** 所有支持的语言 */
function getSupportedLangs() { return [...SUPPORTED_LANGS]; }

/**
 * 切换语言，重新加载字典，通知监听器。
 * @param {string} lang
 */
function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  dict = loadDict(lang);
  saveLang(lang);
  listeners.forEach(fn => fn(lang));
}

/** 监听语言切换 */
function onLangChange(fn) { listeners.add(fn); }

/** 当前语言的字典对象（供主进程推送给 splash） */
function getDict() { return dict; }

/**
 * 监听 dsh settings.yaml 变化，检测到 locale.preference 改变时自动 setLang。
 * 主进程创建主窗口后调用一次即可。返回 stop 函数。
 */
function watchDshLocale() {
  let watcher = null;
  const start = () => {
    try {
      if (!fs.existsSync(DSH_SETTINGS)) {
        // dsh 还没写过 settings.yaml，稍后再试
        setTimeout(start, 2000);
        return;
      }
      watcher = fs.watch(DSH_SETTINGS, { persistent: false }, () => {
        // 文件变化时可能触发多次，读到值不变时 setLang 会 no-op
        const l = readDshLocale();
        if (l && l !== currentLang) setLang(l);
      });
    } catch { /* 静默失败 */ }
  };
  start();
  return () => { try { watcher?.close(); } catch {} };
}

module.exports = { t, getLang, setLang, getSupportedLangs, onLangChange, getDict, watchDshLocale };
