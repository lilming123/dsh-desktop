/**
 * paths.js — 平台无关的运行时路径解析
 *
 * Electron app bundle 启动时 PATH 常被精简，node / npx 需要显式定位。
 * 本模块同时管理 app 写在 $DSH_HOME 下的所有位置：dsh-api 插件安装目录、
 * `--patch` 覆盖文件、以及让插件反向找到本 host 的 companion 发现文件。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

/** dsh HOME（DSH_HOME 环境变量可覆盖，默认 ~/.dsh） */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 桌面版 spawn 的 dsh 用的 profile 目录（`--profile web`） */
function dshProfileDir() {
  return path.join(dshHome(), 'profiles', 'web');
}

/** 打包插件在 profile 内的安装目录（patch 里 name 相对指向这里） */
function apiPluginDir() {
  return path.join(dshProfileDir(), 'dsh-api');
}

/** dsh 启动时通过 `--patch` 传入的覆盖文件路径 */
function apiPluginPatchFile() {
  return path.join(dshProfileDir(), 'dsh-api.patch.yml');
}

/**
 * Companion 发现文件：主进程启动本地 HTTP 服务后写入，插件读文件后把
 * 桌面专属请求代理过来。名字里去掉了「desktop」——它只是「dsh-api 的
 * 一个 host companion」，不排除以后是别的 host。
 */
function companionInfoFile() {
  return path.join(dshHome(), 'dsh-api-companion.json');
}

/** 应用打包内自带的 dsh-api 插件源码（dev 是仓库目录，打包后位于 app.asar 内） */
function bundledPluginFile() {
  return path.join(__dirname, '..', 'dsh-plugin', 'index.mjs');
}

/** node 可执行文件候选，按优先级排列 */
function nodeBinCandidates() {
  const home = os.homedir();
  const user = os.userInfo().username;
  return isWin
    ? [`${home}\\.hermes\\node\\node.exe`, `${home}\\AppData\\Roaming\\npm\\node.exe`, 'node.exe']
    : [`/Users/${user}/.hermes/node/bin/node`, '/usr/local/bin/node', '/opt/homebrew/bin/node', 'node'];
}

/** npx 可执行文件候选 */
function npxBinCandidates() {
  const home = os.homedir();
  const user = os.userInfo().username;
  return isWin
    ? [`${home}\\.hermes\\node\\npx.cmd`, `${home}\\AppData\\Roaming\\npm\\npx.cmd`, 'npx.cmd']
    : [`/Users/${user}/.hermes/node/bin/npx`, '/usr/local/bin/npx', '/opt/homebrew/bin/npx', 'npx'];
}

/** 挑第一个真实存在的候选；找不到就 fallback 到最后一个（裸命令名，交给 PATH） */
function resolveBin(candidates) {
  for (const c of candidates) {
    if (!c.includes(path.sep) && !c.includes('/') && !(isWin && c.includes('\\'))) return c;
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[candidates.length - 1];
}

function nodeBin() { return resolveBin(nodeBinCandidates()); }
function npxBin()  { return resolveBin(npxBinCandidates()); }

/**
 * 定位 npx 缓存里 @deepseek-ai/dsh 的入口（lib/bin.js）。
 * 直接用 node 跑它，比 `npx exec` 快约 8 倍（~1.5s vs ~12s）。
 * @returns {string|null} 绝对路径，找不到返回 null
 */
function dshEntryPath() {
  try {
    const cacheDir = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(cacheDir)) return null;
    for (const d of fs.readdirSync(cacheDir)) {
      const bin = path.join(cacheDir, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(bin)) return bin;
    }
  } catch { /* ignore */ }
  return null;
}

module.exports = {
  isWin,
  nodeBin, npxBin, dshEntryPath,
  dshHome, dshProfileDir,
  apiPluginDir, apiPluginPatchFile,
  companionInfoFile, bundledPluginFile,
};
