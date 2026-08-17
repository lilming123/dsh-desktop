/**
 * bridge.js — 桌面桥接 HTTP 服务（Electron 主进程）
 *
 * 把「只有桌面应用能做到」的能力暴露给 dsh 插件（进而暴露给外部应用）：
 *
 *   GET  /bridge/state            状态快照
 *   POST /bridge/workspace/open   打开工作区（{ path? }，缺省弹目录对话框）
 *   POST /bridge/input/paste      向 dsh 输入框注入文本（{ text }）
 *   POST /bridge/window/show      显示并聚焦主窗口
 *   POST /bridge/window/reload    重载主窗口
 *   POST /bridge/app/quit         退出应用
 *
 * 安全：
 *   - 只绑定 127.0.0.1，随机端口（OS 分配）
 *   - 所有请求必须带 x-dsh-bridge-token（每次启动随机生成，
 *     写入 $DSH_HOME/desktop-bridge.json，dsh 插件读取后携带）
 *
 * 发现文件 desktop-bridge.json: { port, token, dshPort, pid, workspace }
 * 工作区切换 / 端口变化后由 refresh() 或成功处理 /workspace/open 后重写。
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bridgeInfoFile } = require('./paths');
const { log } = require('./logger');

const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/** 收集请求体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 纯请求分发器（不依赖 Electron，便于单独测试）。
 * @param {object} api 能力实现：getState/openWorkspaceRequested/pasteToInput/showWindow/reloadWindow/quitApp
 * @param {string} token 期望的桥接 token
 */
function createBridgeHandler(api, token) {
  return async (req, res) => {
    try {
      // token 校验：任何请求都必须携带
      if (req.headers['x-dsh-bridge-token'] !== token) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const method = req.method || 'GET';

      if (method === 'GET' && url.pathname === '/bridge/state') {
        sendJson(res, 200, { ok: true, state: api.getState() });
        return;
      }

      if (method === 'POST' && url.pathname === '/bridge/workspace/open') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
        const result = await api.openWorkspaceRequested(
          typeof body.path === 'string' && body.path.length ? body.path : null
        );
        if (result && result.ok) {
          sendJson(res, 200, { ok: true, result });
        } else if (result && result.canceled) {
          sendJson(res, 200, { ok: true, canceled: true, result: null });
        } else {
          sendJson(res, 400, { ok: false, error: (result && result.error) || 'workspace open failed' });
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/bridge/input/paste') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
        if (typeof body.text !== 'string') {
          sendJson(res, 400, { ok: false, error: 'text (string) is required' });
          return;
        }
        const result = api.pasteToInput(body.text);
        sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'paste failed' });
        return;
      }

      if (method === 'POST' && url.pathname === '/bridge/window/show') {
        const result = api.showWindow();
        sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'show failed' });
        return;
      }

      if (method === 'POST' && url.pathname === '/bridge/window/reload') {
        const result = api.reloadWindow();
        sendJson(res, result && result.ok ? 200 : 400, result || { ok: false, error: 'reload failed' });
        return;
      }

      if (method === 'POST' && url.pathname === '/bridge/app/quit') {
        sendJson(res, 200, { ok: true });
        api.quitApp();
        return;
      }

      sendJson(res, 404, { ok: false, error: 'unknown bridge endpoint: ' + url.pathname });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}

/**
 * 启动桥接服务并写发现文件。
 * @param {object} opts
 *   api       能力实现（见 createBridgeHandler）
 *   infoFile  发现文件路径（默认 $DSH_HOME/desktop-bridge.json）
 * @returns {{ port: number, stop: () => void, refresh: () => void }}
 */
function startBridge(opts) {
  const api = opts.api;
  const token = crypto.randomBytes(24).toString('hex');
  const infoFile = opts.infoFile || bridgeInfoFile();

  const server = http.createServer(createBridgeHandler(api, token));
  server.on('error', (e) => log('bridge: server error', e.message));

  const writeInfo = () => {
    try {
      const info = {
        port: server.address().port,
        token,
        pid: process.pid,
        ...api.getState(),
      };
      fs.mkdirSync(path.dirname(infoFile), { recursive: true });
      fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
    } catch (e) {
      log('bridge: write info failed', e.message);
    }
  };

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      writeInfo();
      log('bridge: listening on 127.0.0.1:' + port);
      resolve({
        port,
        stop: () => {
          try { fs.unlinkSync(infoFile); } catch (_) {}
          server.close();
        },
        refresh: writeInfo,
      });
    });
    server.once('error', reject);
  });
}

module.exports = { startBridge, createBridgeHandler, readBody, sendJson };
