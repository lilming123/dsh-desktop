/**
 * dsh.js — DeepSeek Harness 服务生命周期管理
 *
 * 端口策略：
 *   1. 扫描 3080–3180 找已运行的 dsh（验证响应含 __DSH_BOOT__ 特征）
 *   2. 找到 → 复用那个端口（支持跨端口复用，不限 3080）
 *   3. 没找到 → 从 3080 起递增找空闲端口，dsh --port <空闲端口> 启动
 *
 * dsh 进程 detached + unref，关闭 app 不杀 dsh，下次打开复用。
 *
 * 桌面桥接插件：每次自己启动 dsh 时，把仓库自带的 dsh-plugin/ 安装到
 * web profile 目录（desktop-bridge/），并通过 `--patch` 叠加给 dsh 加载，
 * 让外部应用可通过 http://127.0.0.1:<port>/desktop-api/* 调用能力。
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { nodeBin, npxBin, dshEntryPath, bridgePluginDir, bridgePatchFile, bundledBridgePluginFile } = require('./paths');
const { log } = require('./logger');

const DEFAULT_PORT = 3080;
const PORT_SCAN_RANGE = 100;           // 3080–3180
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 60000;

/** --patch 覆盖文件的内容（顶层 insert 追加新插件行；name 相对 profile 目录） */
const BRIDGE_PATCH_CONTENT = `# dsh-desktop-bridge 插件补丁层（由 dsh-desktop 应用写入）
- insert:
    - id: dsh-desktop-bridge
      name: ./desktop-bridge/index.mjs
`;

let dshProc = null;
let dshEntry = null;
let workspaceDir = null;
let actualPort = DEFAULT_PORT;        // 运行时实际使用的端口

/** 当前 dsh 服务的 URL（动态端口） */
function dshUrl() {
  return `http://127.0.0.1:${actualPort}`;
}

/** 当前工作区目录（可能为 null —— 未通过本应用切换过） */
function getWorkspaceDir() {
  return workspaceDir;
}

/**
 * 把仓库自带的桌面桥接插件安装到 web profile 目录，供 --patch 引用。
 * 每次启动都重写（文件很小），保证与当前 app 版本一致。
 * 在 ensureDsh 之前调用一次即可。
 */
function installDesktopBridgePlugin() {
  const src = bundledBridgePluginFile();
  const dir = bridgePluginDir();
  try {
    if (!fs.existsSync(src)) {
      log('desktop-bridge: bundled plugin missing at', src);
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.mjs'), fs.readFileSync(src, 'utf8'), 'utf8');
    fs.writeFileSync(bridgePatchFile(), BRIDGE_PATCH_CONTENT, 'utf8');
    log('desktop-bridge: plugin installed to', dir);
    return true;
  } catch (e) {
    log('desktop-bridge: install failed:', e.message);
    return false;
  }
}

/**
 * 构建传给 spawn 的环境变量。
 * Electron app bundle 的 PATH 常被精简，补回 node/npx 目录。
 */
function buildEnv() {
  const nodeDir = path.dirname(nodeBin());
  const npxDir = path.dirname(npxBin());
  const extras = [nodeDir, npxDir, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean);
  const current = process.env.PATH || '';
  const combined = [...new Set([...extras, ...current.split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  return { ...process.env, PATH: combined };
}

/**
 * 检查指定端口是否有 **dsh** 在响应。
 * 通过 HTTP GET + 响应体特征（__DSH_BOOT__ / @deepseek-ai）判断。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isDshOnPort(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve(body.includes('__DSH_BOOT__') || body.includes('@deepseek-ai'));
      });
      res.resume();
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

/**
 * 检查端口是否空闲（没有程序在 listen）。
 * @param {number} port
 * @returns {Promise<boolean>} true = 空闲
 */
function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));   // 被占用
    tester.listen(port, '127.0.0.1', () => {
      tester.close(() => resolve(true));           // 空闲
    });
  });
}

/**
 * 扫描 3080–3180 找已运行的 dsh。
 * @returns {Promise<number|null>} dsh 端口，找不到返回 null
 */
async function findExistingDsh() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SCAN_RANGE; port++) {
    if (await isDshOnPort(port)) {
      log(`found existing dsh on :${port}`);
      return port;
    }
  }
  return null;
}

/**
 * 从 3080 起递增找空闲端口。
 * @returns {Promise<number>}
 * @throws 3080–3180 全被占用时抛错
 */
async function findFreePort() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SCAN_RANGE; port++) {
    if (await isPortFree(port)) {
      log(`found free port :${port}`);
      return port;
    }
  }
  throw new Error(`No free port in range ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_SCAN_RANGE - 1}`);
}

/**
 * 轮询指定端口直到 dsh 就绪，超时 60s 抛错。
 * @param {number} port
 */
function pollReady(port, startMs = Date.now()) {
  return new Promise((resolve, reject) => {
    if (Date.now() - startMs > POLL_TIMEOUT_MS) {
      return reject(new Error(`Server on :${port} did not respond within ${POLL_TIMEOUT_MS / 1000}s`));
    }
    const req = http.get(`http://127.0.0.1:${port}`, res => { res.resume(); resolve(); });
    req.setTimeout(POLL_MS, () => req.destroy());
    req.once('error', () => setTimeout(() => pollReady(port, startMs).then(resolve, reject), POLL_MS));
  });
}

/**
 * 启动一个 dsh 进程（detached，独立于 app 生命周期）。
 * @param {function|null} onOutput  dsh stdout/stderr 回调
 * @param {number} port             dsh 监听端口
 */
function startDsh(onOutput, port) {
  if (!dshEntry) dshEntry = dshEntryPath();
  const useDirect = dshEntry && fs.existsSync(dshEntry);
  const cmd = useDirect ? nodeBin() : npxBin();
  // 注意顺序：--patch 是 dsh CLI 自身选项，必须排在 web app 透传参数（--port）之前
  const patchArgs = fs.existsSync(bridgePatchFile())
    ? ['--patch', bridgePatchFile()]
    : [];
  const args = useDirect
    ? [dshEntry, 'web', ...patchArgs, '--port', String(port)]
    : ['--no-install', '@deepseek-ai/dsh', 'web', ...patchArgs, '--port', String(port)];
  log('spawning dsh', useDirect ? '(direct node)' : '(npx)', cmd, args);

  dshProc = spawn(cmd, args, {
    ...(workspaceDir ? { cwd: workspaceDir } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv(),
    shell: false,
    detached: true,
  });
  dshProc.unref();
  log('dsh spawned, pid=', dshProc.pid, 'port=', port);

  dshProc.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s && onOutput) onOutput(s);
  });
  dshProc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s && onOutput) onOutput(s);
  });
  dshProc.on('error', err => log('dsh:error', err.message));
}

/**
 * 确保有一个可用的 dsh 服务。
 * - 扫到已运行的 dsh（任意端口）→ 复用
 * - 没扫到 → 找空闲端口启动新的
 * @returns {Promise<{mode: 'reused'|'started', port: number}>}
 */
async function ensureDsh(onOutput = null) {
  // 1. 扫描找已运行的 dsh
  const existingPort = await findExistingDsh();
  if (existingPort !== null) {
    actualPort = existingPort;
    log(`reusing existing dsh on :${actualPort}`);
    return { mode: 'reused', port: actualPort };
  }

  // 2. 没找到 → 找空闲端口启动
  actualPort = await findFreePort();
  startDsh(onOutput, actualPort);
  log('polling for dsh ready on :', actualPort);
  await pollReady(actualPort);
  log('dsh ready on :', actualPort);
  return { mode: 'started', port: actualPort };
}

/**
 * 切换工作区：kill 旧 dsh → 用新目录+找新端口重启 → 等就绪。
 * @param {string} dir  新的工作目录
 * @param {function|null} onOutput
 * @returns {Promise<number>} 新端口
 */
async function switchWorkspace(dir, onOutput = null) {
  workspaceDir = dir;
  log('switching workspace to', dir);

  // kill 旧的 dsh（如果是我们启动的）
  if (dshProc) {
    try { process.kill(-dshProc.pid); } catch {}
    dshProc = null;
  }

  // 找空闲端口（旧的可能还没释放，递增找下一个）
  actualPort = await findFreePort();
  startDsh(onOutput, actualPort);
  await pollReady(actualPort);
  log('workspace switched, dsh on :', actualPort);
  return actualPort;
}

module.exports = {
  dshUrl,
  DEFAULT_PORT,
  ensureDsh,
  switchWorkspace,
  isDshOnPort,
  isPortFree,
  findExistingDsh,
  findFreePort,
  installDesktopBridgePlugin,
  getWorkspaceDir,
};
