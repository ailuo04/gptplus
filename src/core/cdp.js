'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const DEFAULT_HTTP_TIMEOUT_MS = 3000;
const DEFAULT_EVAL_TIMEOUT_MS = 8000;

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferred = 9229) {
  const first = Number(preferred) || 9229;
  for (let offset = 0; offset < 64; offset += 1) {
    const port = first + offset;
    if (port > 65535) break;
    if (await canBindPort(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error('无法分配 CDP 端口')));
    });
  });
}

function requestJson(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, { headers: { Accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`CDP HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`CDP 返回无效 JSON: ${error.message}`)); }
      });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error('CDP HTTP 请求超时'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on('close', () => clearTimeout(timer));
  });
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const ws = String(target.webSocketDebuggerUrl || '').trim();
  if (target.type !== 'page' || !ws) return null;
  return { ...target, webSocketDebuggerUrl: ws };
}

async function listTargets(port) {
  const value = await requestJson(`http://127.0.0.1:${Number(port)}/json/list`);
  return Array.isArray(value) ? value.map(normalizeTarget).filter(Boolean) : [];
}

function pickMainTarget(targets) {
  const pages = Array.isArray(targets) ? targets.filter(Boolean) : [];
  return pages.find((target) => String(target.url || '').toLowerCase() === 'app://-/index.html')
    || pages.find((target) => /codex|chatgpt/i.test(`${target.title} ${target.url}`))
    || pages[0]
    || null;
}

async function waitForTarget(port, { timeoutMs = 15000, pollMs = 250, sleep = null } = {}) {
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = pickMainTarget(await listTargets(port));
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(lastError ? `等待 ChatGPT CDP 页面失败: ${lastError.message}` : '等待 ChatGPT CDP 页面超时');
}

function sendCommand(target, method, params = {}, { timeoutMs = DEFAULT_EVAL_TIMEOUT_MS } = {}) {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') throw new Error('当前运行时没有 WebSocket，无法连接 ChatGPT CDP');
  const url = String(target?.webSocketDebuggerUrl || '').trim();
  if (!url) throw new Error('CDP 页面缺少 WebSocket 地址');
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const id = 1;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`CDP ${method} 超时`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', async (event) => {
      let text = event.data;
      if (typeof text !== 'string') {
        if (typeof text?.text === 'function') text = await text.text();
        else if (text instanceof ArrayBuffer) text = Buffer.from(text).toString('utf8');
        else return;
      }
      let payload;
      try { payload = JSON.parse(text); } catch { return; }
      if (payload.id !== id) return;
      if (payload.error) {
        finish(new Error(payload.error.message || `CDP ${method} 失败`));
        return;
      }
      finish(null, payload.result);
    });
    socket.addEventListener('error', () => finish(new Error('CDP WebSocket 连接失败')));
    socket.addEventListener('close', () => {
      if (!settled) finish(new Error('CDP WebSocket 意外关闭'));
    });
  });
}

async function evaluate(target, expression, options = {}) {
  const result = await sendCommand(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, options);
  const value = result?.result;
  if (value?.subtype === 'error' || value?.description?.startsWith('Error')) {
    throw new Error(value.description || '页面脚本执行失败');
  }
  return value?.value;
}

/** 注册到目标页面，后续每次导航/重载都会在文档创建时重新执行。 */
function addScriptOnNewDocument(target, source, options = {}) {
  return sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', { source }, options);
}

function removeScriptOnNewDocument(target, identifier, options = {}) {
  const id = String(identifier || '').trim();
  if (!id) return Promise.resolve({});
  return sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, options);
}

async function inject(port, expression, options = {}) {
  const target = options.target || await waitForTarget(port, options);
  return evaluate(target, expression, options);
}

module.exports = {
  requestJson,
  listTargets,
  pickMainTarget,
  waitForTarget,
  sendCommand,
  evaluate,
  addScriptOnNewDocument,
  removeScriptOnNewDocument,
  inject,
  canBindPort,
  findAvailablePort,
};
