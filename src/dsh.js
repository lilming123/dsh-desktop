/**
 * dsh.js — DeepSeek Harness 服务生命周期管理
 *
 * 职责：
 *   1. 检测 :3080 是否已有 dsh 在跑（复用，避免重复启动）
 *   2. 启动新的 dsh 进程（优先直接 node bin.js，比 npx exec 快 ~8x）
 *   3. 切换工作区（kill 旧 → 用新 cwd 重启）
 *   4. 轮询端口就绪状态
 *
 * dsh 进程以 detached 模式启动 + unref()，关闭 app 不杀 dsh，
 * 下次打开 app 直接复用，秒开。
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { nodeBin, npxBin, dshEntryPath } = require('./paths');
const { log } = require('./logger');

const DSH_PORT = 3080;
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 60000;

let dshProc = null;
let dshEntry = null;   // 缓存 dsh bin.js 路径
let workspaceDir = null; // null = dsh 默认目录；用户选了文件夹才设值

/**
 * 构建传给 spawn 的环境变量。
 * Electron app bundle 的 PATH 常被精简，这里补回 node/npx 所在目录，
 * 否则 dsh 内部调 `node` 会报 "env: node: No such file or directory"。
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
 * 探测 :3080 是否有 **dsh** 在响应。
 * 不只看有没有 HTTP 响应——还要确认响应确实来自 dsh（避免别的程序占了 3080 被误判为已就绪）。
 * dsh 的响应特征：body 里有 `window.__DSH_BOOT__` 或 header 含 dsh 标识。
 */
function isServerUp() {
  return new Promise(resolve => {
    const req = http.get(DSH_URL, res => {
      // 检查响应体里有没有 dsh 特征标记
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const isDsh = body.includes('__DSH_BOOT__') || body.includes('@deepseek-ai');
        req.destroy();
        resolve(isDsh);
      });
      // 兜底：响应头里也可能有线索
      res.resume();
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

/**
 * 轮询直到 dsh 就绪，超时 60s 抛错。
 */
function pollReady(startMs = Date.now()) {
  return new Promise((resolve, reject) => {
    const elapsed = Date.now() - startMs;
    if (elapsed > POLL_TIMEOUT_MS) {
      return reject(new Error(`Server did not respond within ${POLL_TIMEOUT_MS / 1000}s`));
    }
    const req = http.get(DSH_URL, res => { res.resume(); resolve(); });
    req.setTimeout(POLL_MS, () => req.destroy());
    req.once('error', () => setTimeout(() => pollReady(startMs).then(resolve, reject), POLL_MS));
  });
}

/**
 * kill 掉占用 :3080 的所有进程（防止端口残留导致新 dsh EADDRINUSE）。
 */
/**
 * 检查 :3080 是否被任何进程占用（不一定是 dsh）。
 * @returns {Promise<boolean>}
 */
function isPortInUse() {
  return new Promise(resolve => {
    const req = http.get(DSH_URL, () => { req.destroy(); resolve(true); });
    req.setTimeout(500, () => req.destroy());
    req.once('error', () => resolve(false));
  });
}

/**
 * kill 掉占用 :3080 的所有进程。
 * ⚠️ 调用方必须先确认占用者是 dsh（或已征得用户同意），否则会误杀别的程序。
 */
function killPort3080() {
  try {
    const cmd = process.platform === 'win32'
      ? 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :3080 ^| findstr LISTENING\') do taskkill /F /PID %a'
      : 'lsof -ti tcp:3080 2>/dev/null';
    const out = execSync(cmd, { encoding: 'utf8', timeout: 3000, shell: true }).trim();
    if (!out) return;
    for (const pid of out.split('\n').filter(Boolean)) {
      try { execSync(`kill -9 ${pid.trim()}`, { shell: true, stdio: 'ignore' }); } catch {}
    }
  } catch { /* 没人占用就跳过 */ }
}

/**
 * 启动一个 dsh 进程（detached，独立于 app 生命周期）。
 * @param {function|null} onOutput  回调，收到 dsh stdout/stderr 时触发
 */
function startDsh(onOutput = null) {
  // 优先直接 node 调 bin.js（1.5s），fallback 到 npx exec（12s）
  if (!dshEntry) dshEntry = dshEntryPath();
  const useDirect = dshEntry && fs.existsSync(dshEntry);
  const cmd = useDirect ? nodeBin() : npxBin();
  const args = useDirect
    ? [dshEntry, 'web']
    : ['--no-install', '@deepseek-ai/dsh', 'web'];
  log('spawning dsh', useDirect ? '(direct node)' : '(npx)', cmd, args);

  dshProc = spawn(cmd, args, {
    ...(workspaceDir ? { cwd: workspaceDir } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv(),
    shell: false,
    detached: true,   // dsh 独立存活，app 退出不杀
  });
  dshProc.unref();     // 不让 dsh 阻止 app 退出
  log('dsh spawned, pid=', dshProc.pid);

  // 实时把 dsh 输出转发给回调（用于启动页显示状态）
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
 * 三种情况：
 *   1. dsh 已在 :3080 跑 → 直接复用（秒开）
 *   2. 别的程序占了 :3080（响应不含 dsh 特征）→ 抛错，让用户知道
 *   3. 没人占用 → 启动新的 dsh，轮询就绪
 * @returns {Promise<'reused'|'started'>}
 * @throws {Error} 端口被非 dsh 程序占用时
 */
async function ensureDsh(onOutput = null) {
  const portInUse = await isPortInUse();

  if (portInUse) {
    // 端口有响应，确认是不是 dsh
    if (await isServerUp()) {
      log('dsh already running on :3080 — reusing');
      return 'reused';
    }
    // 端口被别的程序占了——不强杀，报错让用户处理
    const msg = `Port ${DSH_PORT} is in use by another program (not dsh). ` +
      `Please free it (e.g. lsof -ti tcp:${DSH_PORT} | xargs kill -9) and restart.`;
    log('ERROR:', msg);
    throw new Error(msg);
  }

  // 没人占用，启动新的 dsh
  killPort3080();  // 兜底清理（极端情况：端口残留但 GET 不通）
  await new Promise(r => setTimeout(r, 200));
  startDsh(onOutput);
  log('polling for :3080 ready…');
  await pollReady();
  log('server is ready');
  return 'started';
}

/**
 * 切换工作区：kill 旧 dsh → 用新目录重启 → 等就绪。
 * @param {string} dir  新的工作目录绝对路径
 */
async function switchWorkspace(dir, onOutput = null) {
  workspaceDir = dir;
  log('switching workspace to', dir);
  killPort3080();
  await new Promise(r => setTimeout(r, 250));
  startDsh(onOutput);
  await pollReady();
  log('workspace switched, server ready');
}

module.exports = { DSH_URL, DSH_PORT, ensureDsh, switchWorkspace, isServerUp, killPort3080 };
