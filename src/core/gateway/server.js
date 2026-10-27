'use strict';
/**
 * 本地网关 HTTP 服务器（spec.md 第 6、8 节）。
 *
 * 路由：
 *   GET  /healthz          -> { ok:true, providers:<n>, models:<n> }
 *   GET  /v1/models        -> { object:'list', data:[{id:<slug>, object:'model', owned_by:<providerName>}] }
 *   POST /v1/responses     -> Responses 契约（流式 SSE / 非流式 JSON）
 *   POST /v1/chat/completions -> Chat Completions 契约
 *   POST /v1/messages      -> Anthropic Messages 契约
 *   OPTIONS *              -> 204（方便浏览器里调试）
 *
 * 认证：store.gateway.token（或 start() 传入的 token）非空时，要求
 *       `Authorization: Bearer <token>`，不匹配返回 401。
 *
 * 设计：server.js 只做「HTTP + 认证 + 路由 + 日志 + 生命周期」；
 *       Responses 事件契约在 responses.js，上游协议在 adapters/*。
 *       三个适配器返回统一的内部事件流，server 是唯一的翻译出口。
 *
 * 签名（spec 第 8 节末）：
 *   createGateway({ store, paths, log }) => { start, stop, stopSync, getState,
 *                                             autoStart, probe, on }
 *   额外可选依赖（不进契约，测试/调试用）：deps.fetch —— 替换 globalThis.fetch。
 *   `paths` 为签名兼容而接收，网关不直接落盘（日志走 log 回调与内存环形缓冲）。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const { createRouter } = require('./router.js');
const { createSystemProxyFetch } = require('../system-proxy.js');
const { redactDiagnostic } = require('../redact.js');
const { createPeerManifest, hashPeerToken, safeEqual: safePeerEqual, peerEndpoint } = require('../peer-sharing.js');
const { createOpenAIAdapter } = require('./adapters/openai.js');
const { createAnthropicAdapter } = require('./adapters/anthropic.js');
const { createResponsesAdapter } = require('./adapters/responses.js');
const { normalizeRequest, protocolFromPath, createOutputStream, buildChatResponse, buildAnthropicResponse } = require('./protocols.js');
const {
  ResponsesStream,
  buildResponseObject,
  countLoopToolItems,
  estimateUsage,
  extractErrorMessage,
  extractResponseText,
  generationSpeed,
  hasCacheUsage,
  normalizeUsage,
  pipeResponsesSse,
  readBodyText,
  readJsonBody,
  sendError,
  sendJson,
  sendResponsesFailure,
  writeSseHeaders,
} = require('./responses.js');

const RING_SIZE = 200;
const DEFAULT_PORT = 18120;
const DEFAULT_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 长思考模型可能要十几分钟
const PROBE_TIMEOUT_MS = 5000;
const UPSTREAM_TRANSIENT_RETRY_DELAY_MS = 250;

/** 上游 400 且报错提到这些参数时，去掉可选参数重试一次（老中转的兼容姿势）。 */
const COMPAT_TRIGGER = /stream_options|prompt_cache_key|cache_control|reasoning_effort|output_config|thinking|max_tokens|tool_choice|parallel_tool_calls|temperature|unknown|unsupported|not supported/i;

/**
 * 读取最终发给上游的思考档位。
 *
 * 必须从适配器已经构建好的 payload 里取，而不是直接读 body.reasoning.effort：
 * Anthropic 会把 medium 映射成 high；兼容重试或上游不收该字段时也可能根本没发。
 * 返回 null 表示这次请求没有携带显式档位，由上游使用默认值。
 */
function effectiveReasoningEffort(built, body) {
  if (!built) return undefined;
  const payload = built.payload && typeof built.payload === 'object' ? built.payload : null;
  if (payload) {
    if (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort.trim()) {
      return payload.reasoning_effort.trim().toLowerCase();
    }
    const outputEffort = payload.output_config?.effort;
    if (typeof outputEffort === 'string' && outputEffort.trim()) {
      return outputEffort.trim().toLowerCase();
    }
    if (payload.thinking && typeof payload.thinking === 'object' && payload.thinking.type === 'disabled') {
      return 'none';
    }
    const nested = payload.reasoning?.effort;
    if (typeof nested === 'string' && nested.trim()) return nested.trim().toLowerCase();
    return null;
  }
  // 对等端与 Responses 透传都是把请求体原样转发，body 就是最终上游载荷。
  if (built.passthrough) {
    const direct = body?.reasoning?.effort;
    if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
  }
  return null;
}

function isTransientUpstreamStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function describeListenError(err, port) {
  if (err && err.code === 'EADDRINUSE') return new Error(`端口 ${port} 已被占用，请换一个端口`);
  if (err && err.code === 'EACCES') return new Error(`没有权限监听端口 ${port}`);
  if (err && err.code === 'EADDRNOTAVAIL') return new Error(`地址不可用：${port}`);
  return err instanceof Error ? err : new Error(String(err));
}

/** 创建本地网关，并让默认上游请求自动跟随 Windows 系统代理。 */
function isWeixinGatewayRequest(req) {
  const source = String((req.headers && req.headers['x-gptplus-source']) || '').trim().toLowerCase();
  if (source === 'weixin') return true;
  return /^gptplus-weixin\b/i.test(String((req.headers && req.headers.originator) || ''));
}

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function imageMimeForFile(filePath, buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

/** 只允许把微信媒体目录内的 file:// 图片转成 data URL，避免读取任意本地文件。 */
function localWeixinImageDataUrl(fileUrl, mediaRoot) {
  let filePath;
  try {
    filePath = fileURLToPath(fileUrl);
  } catch {
    return null;
  }
  const root = path.resolve(mediaRoot);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let stat;
  try { stat = fs.lstatSync(target); } catch { return null; }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INLINE_IMAGE_BYTES) return null;
  let buffer;
  try { buffer = fs.readFileSync(target); } catch { return null; }
  return `data:${imageMimeForFile(target, buffer)};base64,${buffer.toString('base64')}`;
}

/**
 * 微信 app-server 把本地图片作为 file:// URL 放进 turn 输入；
 * 上游模型无法访问本机路径，因此在网关内按白名单目录转成 data URL。
 * @returns {number} 转换的图片数量
 */
function inlineWeixinImageUrls(body, mediaRoot) {
  if (!body || !Array.isArray(body.input) || !mediaRoot) return 0;
  let count = 0;
  for (const item of body.input) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || (part.type !== 'input_image' && part.type !== 'image_url')) continue;
      let fileUrl = '';
      if (part.type === 'input_image') {
        if (typeof part.image_url === 'string') fileUrl = part.image_url;
        else if (part.image_url && typeof part.image_url.url === 'string') fileUrl = part.image_url.url;
      }
      if (part.type === 'image_url') {
        if (typeof part.image_url === 'string') fileUrl = part.image_url;
        else if (part.image_url && typeof part.image_url.url === 'string') fileUrl = part.image_url.url;
      }
      if (!/^file:/i.test(fileUrl)) continue;
      const dataUrl = localWeixinImageDataUrl(fileUrl, mediaRoot);
      if (!dataUrl) continue;
      if (typeof part.image_url === 'string') part.image_url = dataUrl;
      else part.image_url.url = dataUrl;
      count += 1;
    }
  }
  return count;
}

/**
 * @param {{ store:any, paths?:any, log?:(e:any)=>void, fetch?:typeof fetch,
 *            usageLive?: { read: (sessionId:string) => any },
 *            taskObserver?: { turnRequest?:Function, requestStarted?:Function,
 *              requestFinished?:Function, turnResponse?:Function } }} deps
 */
function createGateway(deps = {}) {
  const {
    store,
    paths = null,
    log: externalLog,
    usageLive = null,
    taskObserver = null,
  } = deps;
  const requestTimeoutMs = Number.isFinite(Number(deps.requestTimeoutMs)) && Number(deps.requestTimeoutMs) > 0
    ? Number(deps.requestTimeoutMs) : REQUEST_TIMEOUT_MS;
  // deps.fetch 是契约外的测试注入点：null/undefined 表示用全局 fetch，
  // 显式传了别的类型说明调用方写错了，直接报错而不是静默忽略。
  const doFetch = deps.fetch == null ? globalThis.fetch : deps.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前 Node 运行时没有可用的 fetch，请升级到 Node 18+');
  }

  const router = createRouter({ store });
  const adapters = {
    openai: createOpenAIAdapter(),
    anthropic: createAnthropicAdapter(),
    responses: createResponsesAdapter(),
  };

  /** @type {any[]} 最近 200 条 */
  const ring = [];
  const listeners = new Set();

  const state = {
    server: null,
    running: false,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    url: '',
    startedAt: null,
    token: '',
    requests: 0,
  };

  function configSnapshot() {
    try {
      const cfg = typeof store?.get === 'function' ? store.get() : null;
      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch {
      return {};
    }
  }

  function storeToken() {
    const cfg = configSnapshot();
    return cfg.gateway && typeof cfg.gateway.token === 'string' ? cfg.gateway.token : '';
  }

  /** 生效 token：start() 传入的优先，其次 store.gateway.token。 */
  function effectiveToken() {
    return state.token || storeToken() || '';
  }

  function logEntry(entry) {
    const cfg = configSnapshot();
    const peerSecrets = (cfg.remoteSync?.connections || []).map((connection) => ({
      baseUrl: connection.baseUrl, apiKey: connection.authToken, headers: {},
    }));
    const full = redactDiagnostic({ at: Date.now(), level: 'info', ...entry }, [...(cfg.providers || []), ...peerSecrets]);
    ring.push(full);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    try {
      if (typeof externalLog === 'function') externalLog(full);
    } catch {
      /* 回调异常不影响网关 */
    }
    for (const cb of listeners) {
      try {
        cb(full);
      } catch {
        /* ignore */
      }
    }
    return full;
  }

  /** 最近一次成功请求的生成速度；供输入框状态栏按会话读取。 */
  function latestRequestSpeed(sessionId) {
    const id = String(sessionId || '').trim().replace(/^local:/, '');
    if (!id) return null;
    for (let index = ring.length - 1; index >= 0; index -= 1) {
      const entry = ring[index];
      if (entry.final !== true || Number(entry.status) !== 200 || entry.sessionId !== id) continue;
      const speed = Number(entry.speed);
      if (!(speed > 0)) continue;
      const tokens = normalizeUsage(entry.tokens);
      return {
        speed,
        at: entry.at,
        ms: entry.ms,
        firstOutputMs: entry.firstOutputMs,
        firstTextMs: entry.firstTextMs,
        outputTokens: tokens?.output_tokens || 0,
        model: entry.upstreamModel || entry.model || '',
      };
    }
    return null;
  }

  function configuredPort() {
    const cfg = configSnapshot();
    const port = Number(cfg?.gateway?.port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  function getState() {
    return {
      running: state.running,
      port: state.running ? state.port : configuredPort(),
      host: state.host || DEFAULT_HOST,
      url: state.running ? state.url : '',
      startedAt: state.startedAt,
      requests: state.requests,
    };
  }

  function authHeaders() {
    const token = effectiveToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /**
   * @param {{port?:number, host?:string, token?:string}} [opts]
   * @returns {Promise<{port:number, url:string}>}
   */
  async function start(opts = {}) {
    const cfg = configSnapshot();
    const wantPort = Number.isInteger(Number(opts.port)) ? Number(opts.port) : configuredPort();
    const wantHost = opts.host || cfg?.gateway?.host || DEFAULT_HOST;
    const wantToken = opts.token === undefined ? storeToken() : String(opts.token ?? '');

    if (state.running) {
      if (state.port === wantPort && state.host === wantHost && state.token === wantToken) {
        return { port: state.port, url: state.url };
      }
      await stop();
    }

    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        logEntry({ level: 'error', msg: `网关内部错误: ${err && err.message ? err.message : err}` });
        try {
          sendError(res, 500, (err && err.message) || '网关内部错误', 'server_error');
        } catch {
          /* 响应可能已经开始写了 */
        }
      });
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 70000;

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(describeListenError(err, wantPort));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(wantPort, wantHost);
    });

    const address = server.address();
    state.server = server;
    state.running = true;
    state.port = address && typeof address === 'object' ? address.port : wantPort;
    state.host = wantHost;
    state.token = wantToken;
    state.startedAt = Date.now();
    state.url = `http://${wantHost === '0.0.0.0' ? '127.0.0.1' : wantHost}:${state.port}/v1`;
    server.on('error', (err) => {
      logEntry({ level: 'error', msg: `网关服务器错误: ${err.message}` });
    });
    return { port: state.port, url: state.url };
  }

  async function stop() {
    const server = state.server;
    state.running = false;
    state.server = null;
    state.startedAt = null;
    state.url = '';
    if (!server) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(finish);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      const timer = setTimeout(finish, 1500);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  /** 进程退出用的同步版本。 */
  function stopSync() {
    const server = state.server;
    state.running = false;
    state.server = null;
    state.startedAt = null;
    state.url = '';
    if (!server) return;
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close();
    } catch {
      /* ignore */
    }
  }

  /** 读 store.gateway：enabled 就尝试启动；端口占用等失败只记日志，不抛。 */
  async function autoStart() {
    const cfg = configSnapshot();
    const gw = cfg.gateway || {};
    if (!gw.enabled) {
      if (state.running) await stop();
      return;
    }
    if (state.running) return;
    try {
      const started = await start({
        port: Number.isInteger(Number(gw.port)) ? Number(gw.port) : DEFAULT_PORT,
        host: gw.host || DEFAULT_HOST,
        token: gw.token || '',
      });
      logEntry({ level: 'info', msg: `网关已启动: ${started.url}` });
    } catch (err) {
      logEntry({ level: 'error', msg: `网关自动启动失败: ${err.message}` });
    }
  }

  /** 自测：GET /healthz。 */
  function probe() {
    const started = Date.now();
    return new Promise((resolve) => {
      if (!state.running) {
        return resolve({ ok: false, latencyMs: 0, error: '网关未启动' });
      }
      const req = http.request(
        {
          host: state.host === '0.0.0.0' ? '127.0.0.1' : state.host,
          port: state.port,
          path: '/healthz',
          method: 'GET',
          headers: authHeaders(),
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            const latencyMs = Date.now() - started;
            if (res.statusCode !== 200) {
              return resolve({ ok: false, latencyMs, error: `健康检查失败: HTTP ${res.statusCode}` });
            }
            try {
              const json = JSON.parse(data);
              if (json && json.ok) {
                return resolve({
                  ok: true,
                  latencyMs,
                  providers: json.providers,
                  models: json.models,
                  status: res.statusCode,
                });
              }
              resolve({ ok: false, latencyMs, error: '健康检查返回内容异常' });
            } catch {
              resolve({ ok: false, latencyMs, error: '健康检查返回内容不是 JSON' });
            }
          });
        },
      );
      req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('健康检查超时')));
      req.on('error', (err) => resolve({ ok: false, latencyMs: Date.now() - started, error: err.message }));
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // 请求处理
  // -------------------------------------------------------------------------

  function authorized(req) {
    const token = effectiveToken();
    if (!token) return true;
    const header = req.headers.authorization || req.headers.Authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) return req.url?.split('?')[0] === '/v1/messages' && safeEqual(req.headers['x-api-key'], token);
    return safeEqual(match[1].trim(), token);
  }

  function authorizedPeer(req) {
    const header = req.headers.authorization || req.headers.Authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) return false;
    const digest = hashPeerToken(match[1].trim());
    const clients = configSnapshot().sharing?.clients || [];
    return clients.some((client) => safePeerEqual(client.tokenHash, digest));
  }

  function sendPeerError(res, status, code, message) {
    sendJson(res, status, { error: { code, message } });
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      if (path === '/thread-usage-live') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        });
      } else res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/peer/v1/models' || path === '/peer/v1/responses') {
      if (!authorizedPeer(req)) {
        sendPeerError(res, 401, 'UNAUTHORIZED', '无效的对等端授权');
        return;
      }
      if (!configSnapshot().sharing?.enabled) {
        sendPeerError(res, 403, 'SHARING_DISABLED', '共享端当前未开启');
        return;
      }
      if (path === '/peer/v1/models' && method === 'GET') {
        sendJson(res, 200, createPeerManifest(configSnapshot(), router.localProviders()));
        return;
      }
      if (path === '/peer/v1/responses' && method === 'POST') {
        await handleResponses(req, res, { peerRequest: true });
        return;
      }
      sendPeerError(res, 405, 'INVALID_REQUEST', '不支持的对等端请求方法');
      return;
    }

    if (!authorized(req)) {
      logEntry({ level: 'warn', msg: `未授权访问: ${method} ${path}`, status: 401 });
      sendError(res, 401, '无效的网关令牌（Authorization: Bearer <token>）', 'authentication_error');
      return;
    }

    if (path === '/healthz' && method === 'GET') {
      const counts = router.counts();
      sendJson(res, 200, { ok: true, providers: counts.providers, models: counts.models });
      return;
    }

    if (path === '/thread-usage-live' && method === 'POST') {
      // Only the injected local status line needs CORS; the snapshot remains bearer-protected.
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!usageLive || typeof usageLive.read !== 'function') {
        sendJson(res, 503, { status: 'unavailable', message: '本机会话用量读取器未就绪', events: [] });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch (err) {
        sendJson(res, err.statusCode || 400, { status: 'failed', message: err.message, events: [] });
        return;
      }
      const sessionId = body?.session_id;
      const snapshot = usageLive.read(sessionId);
      const request = latestRequestSpeed(sessionId);
      const payload = snapshot && typeof snapshot === 'object'
        ? { ...snapshot, ...(request ? { request } : {}) }
        : { status: 'unavailable', message: '本机会话用量不可用', events: [], ...(request ? { request } : {}) };
      sendJson(res, snapshot?.status === 'ok' ? 200 : 404, payload);
      return;
    }

    if (path === '/v1/models' && method === 'GET') {
      const data = router.listModels().map((model) => ({
        id: model.slug,
        object: 'model',
        created: 0,
        owned_by: model.providerName,
        // 下面几个是本网关的扩展信息，标准客户端会忽略
        provider: model.providerId,
        display_name: model.label,
        enabled: model.enabled,
      }));
      sendJson(res, 200, { object: 'list', data });
      return;
    }

    const protocol = protocolFromPath(path);
    if (protocol && method === 'POST') {
      await handleResponses(req, res, { protocol });
      return;
    }

    sendError(res, 404, `not found: ${method} ${path}`, 'invalid_request_error');
  }

  async function callUpstream(adapter, { provider, modelId, body, stream, compat }, signal) {
    if (provider.remote) {
      const connection = provider.remoteConnection;
      if (!connection || !connection.baseUrl || !connection.authToken) {
        throw Object.assign(new Error('远端来源没有可用连接，请重新连接该共享端'), { upstreamStatus: 503 });
      }
      const upstream = await doFetch(peerEndpoint(connection.baseUrl, 'responses'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + connection.authToken, 'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify({ ...body, model: modelId }),
        signal,
      });
      return { built: { passthrough: true }, upstream };
    }
    const built = adapter.buildRequest({ provider, modelId, body, stream, compat });
    const upstream = await doFetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.payload),
      signal,
    });
    return { built, upstream };
  }

  /** 上游 400/422 且报错指向可选参数时，去掉可选参数重发才有意义；404 是地址错，重发也一样错。 */
  function isCompatRetryableStatus(status) {
    return status === 400 || status === 422 || (status >= 500 && status <= 599);
  }

  async function handleResponses(req, res, { peerRequest = false, protocol = 'responses' } = {}) {
    const started = Date.now();
    state.requests += 1;

    let body;
    const sendProtocolError = (status, message, type = 'invalid_request_error') => {
      if (protocol === 'anthropic') sendJson(res, status, { type: 'error', error: { type, message: String(message) } });
      else sendError(res, status, message, type);
    };
    let outputOptions = {};
    try {
      body = await readJsonBody(req);
      const normalized = normalizeRequest(body, protocol);
      body = normalized.body;
      outputOptions = normalized.options;
    } catch (err) {
      logEntry({ level: 'warn', msg: `请求体解析失败: ${err.message}`, status: err.statusCode || 400 });
      sendProtocolError(err.statusCode || 400, err.message);
      return;
    }

    if (isWeixinGatewayRequest(req) && paths && paths.APP_DIR) {
      const count = inlineWeixinImageUrls(body, path.join(paths.APP_DIR, 'weixin-media'));
      if (count) logEntry({ level: 'info', msg: `微信图片已内联: ${count} 张` });
    }

    const requestedModel = body && body.model != null ? String(body.model) : '';
    const route = peerRequest ? router.resolveLocalModelId(requestedModel) : router.resolve(requestedModel);
    const slug = peerRequest && route.ok ? route.slug : requestedModel;
    if (!route.ok) {
      if (peerRequest) sendPeerError(res, 404, 'MODEL_NOT_FOUND', '共享端未发布该模型');
      else sendProtocolError(404, route.reason);
      logEntry({ level: 'warn', msg: peerRequest ? '对等端请求了未发布模型' : route.reason, status: 404, model: slug });
      return;
    }

    const provider = route.provider;
    const upstreamAdapter = provider.remote ? adapters.responses :
      provider.api === 'anthropic'
        ? adapters.anthropic
        : provider.api === 'responses'
          ? adapters.responses
          : adapters.openai;
    const adapter = { ...upstreamAdapter, passthrough: !!upstreamAdapter.passthrough && protocol === 'responses' };
    const wantStream = protocol === 'responses' ? body.stream !== false : body.stream === true;
    body.stream = wantStream;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('上游响应超时')), requestTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    let clientGone = false;
    let pipe = null;
    let stream = null;
    let built = null;
    const onClose = () => {
      if (res.writableEnded) return;
      // 透传上游已经把终点事件（response.completed/failed/incomplete）交给客户端后，
      // 客户端收到终点就关闭连接属于正常收尾，不能记成 499。
      if (pipe?.terminal) return;
      clientGone = true;
      controller.abort(new Error('客户端中断'));
    };
    res.on('close', onClose);

    const sessionId = typeof body?.prompt_cache_key === 'string'
      ? body.prompt_cache_key.trim().replace(/^local:/, '').slice(0, 128)
      : '';
    const baseLog = {
      requestId: `req_${crypto.randomBytes(12).toString('hex')}`,
      providerId: provider.id,
      providerName: route.providerName,
      model: slug,
      upstreamModel: route.modelId,
      ...(sessionId ? { sessionId } : {}),
    };
    const requestedEffort = typeof body?.reasoning?.effort === 'string' && body.reasoning.effort.trim()
      ? body.reasoning.effort.trim().toLowerCase()
      : null;
    logEntry({ level: 'info', msg: `开始请求 ${slug}`, ...baseLog, status: 0 });

    const observeTask = !peerRequest && !isWeixinGatewayRequest(req)
      && !!taskObserver && taskObserver.turnRequest !== undefined;
    let turnInfo = null;
    if (observeTask && typeof taskObserver.turnRequest === 'function') {
      try {
        turnInfo = taskObserver.turnRequest({ body, slug }) || null;
      } catch {
        turnInfo = null;
      }
      if (turnInfo && typeof taskObserver.requestStarted === 'function') {
        taskObserver.requestStarted({
          turnKey: turnInfo.turnKey,
          requestId: baseLog.requestId,
          abort: () => controller.abort(new Error('任务通知停止')),
        });
      }
    }
    let sawToolCall = false;
    let firstOutputAt = null;
    let firstTextAt = null;
    const observed = { hasToolCalls: false, text: '' };

    let finalLogged = false;

    // 所有已进入上游处理的请求都必须有且只有一条终结记录，避免统计漏项或重复计数。
    const logFinal = (entry = {}) => {
      if (finalLogged) return null;
      finalLogged = true;
      const ms = entry.ms ?? Date.now() - started;
      const speed = entry.speed ?? generationSpeed(entry.tokens, ms, entry.firstOutputMs);
      const sentEffort = effectiveReasoningEffort(built, body);
      const final = logEntry({
        level: 'info',
        ...baseLog,
        ...entry,
        ...(sentEffort !== undefined ? { reasoningEffort: sentEffort } : {}),
        ...(requestedEffort ? { reasoningEffortRequested: requestedEffort } : {}),
        ...(speed ? { speed } : {}),
        final: true,
        ms,
      });
      if (observeTask && typeof taskObserver.turnResponse === 'function') {
        try {
          taskObserver.turnResponse({
            body,
            slug,
            ok: final.status === 200,
            status: final.status,
            hasToolCalls: observed.hasToolCalls,
            text: observed.text,
          });
        } catch {
          /* 任务观察失败不影响网关 */
        }
      }
      return final;
    };

    // 客户端提前断开时，尽量保留上游已经返回的 usage 和缓存字段。
    const partialUsage = () => {
      const firstOutputMs = firstOutputAt
        ? firstOutputAt - started
        : (pipe?.firstOutputAt ? pipe.firstOutputAt - started : undefined);
      const firstTextMs = firstTextAt
        ? firstTextAt - started
        : (pipe?.firstTextAt ? pipe.firstTextAt - started : undefined);
      const timings = {
        ...(firstOutputMs ? { firstOutputMs } : {}),
        ...(firstTextMs ? { firstTextMs } : {}),
      };
      if (stream) {
        const tokens = stream.usage || estimateUsage(body, stream.text);
        return {
          tokens,
          cacheUsageAvailable: stream.cacheUsageAvailable,
          estimatedUsage: stream.usageEstimated || !stream.usage || undefined,
          events: stream.emittedTypes.length,
          ...timings,
        };
      }
      if (pipe) {
        return {
          tokens: normalizeUsage(pipe.usage) || estimateUsage(body, pipe.outputText),
          cacheUsageAvailable: hasCacheUsage(pipe.usage),
          estimatedUsage: !pipe.usage || undefined,
          events: pipe.events,
          ...timings,
        };
      }
      return {};
    };

    // 客户端先断开、但上游的终点事件已经进入缓冲区时，透传循环往往还能读到
    // response.completed；这时是正常完成，不能因为 close 事件先发生就记成 499。
    const finalizeClientGone = () => {
      const usage = partialUsage();
      if (pipe?.completed) {
        observed.hasToolCalls = (pipe.toolCalls || 0) > 0;
        observed.text = pipe.outputText || observed.text;
        return logFinal({
          level: 'info',
          msg: `完成 ${slug} -> ${route.modelId} (${Date.now() - started}ms)`,
          status: 200,
          ...usage,
        });
      }
      if (pipe?.failed) {
        return logFinal({
          level: 'error',
          msg: `上游返回失败事件: ${pipe.failed.message}`,
          status: 502,
          ...usage,
        });
      }
      return logFinal({
        level: 'warn',
        msg: `客户端中断: ${slug}`,
        status: 499,
        ...usage,
      });
    };

    try {
      const firstAttempt = await callUpstream(
        adapter,
        { provider, modelId: route.modelId, body, stream: wantStream, compat: false },
        controller.signal,
      );
      let upstream = firstAttempt.upstream;
      built = firstAttempt.built;
      logEntry({ level: 'info', msg: `上游返回 HTTP ${upstream.status}`, ...baseLog, status: upstream.status });

      if (!upstream.ok) {
        const firstText = await readBodyText(upstream);
        // 两条互斥的重试路径：
        //   参数不兼容 -> 去掉网关注入的可选参数重发（只对非透传有意义）；
        //   瞬时错误   -> 原样重发一次（502/503/504；上游抖动很常见）。
        // 判据必须先看报错文本：502 里报 "unsupported reasoning_effort" 属于前者，
        // 原样重发只会再失败一次。
        const effortRequested = typeof body.reasoning?.effort === 'string';
        const effortRejected = effortRequested && /output_config|thinking|effort/i.test(firstText);
        const paramIssue = !effortRejected
          && !adapter.passthrough
          && isCompatRetryableStatus(upstream.status)
          && COMPAT_TRIGGER.test(firstText);
        const transientIssue = !paramIssue && isTransientUpstreamStatus(upstream.status);

        if (paramIssue) {
          logEntry({
            level: 'warn',
            msg: `上游拒绝可选参数，改用兼容请求重试: HTTP ${upstream.status}`,
            ...baseLog,
            status: upstream.status,
          });
          const compatAttempt = await callUpstream(
            adapter,
            { provider, modelId: route.modelId, body, stream: wantStream, compat: extractErrorMessage(firstText, '') },
            controller.signal,
          );
          upstream = compatAttempt.upstream;
          built = compatAttempt.built;
          if (!upstream.ok) {
            const text = await readBodyText(upstream);
            throw Object.assign(
              new Error(extractErrorMessage(text, `上游返回 HTTP ${upstream.status}`)),
              { upstreamStatus: upstream.status, upstreamText: text },
            );
          }
        } else if (transientIssue) {
          logEntry({
            level: 'warn',
            msg: `上游临时错误，短暂重试一次: HTTP ${upstream.status} ${extractErrorMessage(firstText, '')}`.trim(),
            ...baseLog,
            status: upstream.status,
          });
          await sleep(UPSTREAM_TRANSIENT_RETRY_DELAY_MS);
          const retryAttempt = await callUpstream(
            adapter,
            { provider, modelId: route.modelId, body, stream: wantStream, compat: false },
            controller.signal,
          );
          upstream = retryAttempt.upstream;
          built = retryAttempt.built;
          if (!upstream.ok) {
            const retryText = await readBodyText(upstream);
            throw Object.assign(
              new Error(extractErrorMessage(retryText, `上游返回 HTTP ${upstream.status}`)),
              { upstreamStatus: upstream.status, upstreamText: retryText },
            );
          }
        } else {
          throw Object.assign(
            new Error(extractErrorMessage(firstText, `上游返回 HTTP ${upstream.status}`)),
            { upstreamStatus: upstream.status, upstreamText: firstText },
          );
        }
      }

      if (!wantStream) {
        const json = await upstream.json().catch(() => null);
        if (!json) throw new Error('上游返回的不是 JSON');
        if (json.error) {
          throw Object.assign(new Error(extractErrorMessage(JSON.stringify(json), '上游返回错误')), {
            upstreamStatus: 502,
          });
        }
        if (adapter.passthrough) {
          // 原生 Responses 响应：原样回给客户端，网关只记日志
          observed.hasToolCalls = countLoopToolItems(json.output) > 0;
          observed.text = extractResponseText(json.output);
          const entry = logFinal({
            level: 'info',
            msg: `完成 ${slug} -> ${route.modelId} (${Date.now() - started}ms)`,
            status: 200,
            tokens: normalizeUsage(json.usage) || estimateUsage(body, extractResponseText(json.output)),
            estimatedUsage: !json.usage || undefined,
            cacheUsageAvailable: hasCacheUsage(json.usage),
          });
          sendJson(res, 200, json);
          return entry;
        }
        const parsed = adapter.parseJson(json);
        observed.hasToolCalls = !!(parsed.toolCalls && parsed.toolCalls.length);
        observed.text = parsed.text;
        const buildOutput = protocol === 'chat' ? buildChatResponse : protocol === 'anthropic' ? buildAnthropicResponse : buildResponseObject;
        const responseObject = buildOutput({
          model: slug,
          text: parsed.text,
          reasoning: parsed.reasoning,
          reasoningSignature: parsed.reasoningSignature,
          reasoningItems: parsed.reasoningItems,
          toolCalls: parsed.toolCalls,
          usage: parsed.usage,
          requestBody: body,
          finishReason: parsed.finishReason,
        });
        const entry = logFinal({
          level: 'info',
          msg: `完成 ${slug} -> ${route.modelId} (${Date.now() - started}ms)`,
          status: 200,
          tokens: normalizeUsage(parsed.usage) || estimateUsage(body, parsed.text),
          estimatedUsage: !parsed.usage || undefined,
          cacheUsageAvailable: hasCacheUsage(parsed.usage),
        });
        sendJson(res, 200, responseObject);
        return entry;
      }

      writeSseHeaders(res);
      // 透传模式：上游报文逐字节转发，不做内部事件重建（见 adapters/responses.js）；
      // pipe 只收集日志要用的信息（usage / responseId / 失败事件 / 工具调用数）。
      pipe = adapter.passthrough
        ? { usage: null, outputText: '', responseId: null, events: 0, completed: false, terminal: false, failed: null, toolCalls: 0, firstOutputAt: null, firstTextAt: null }
        : null;
      stream = adapter.passthrough ? null : createOutputStream(protocol, res, { model: slug, ...outputOptions }) || new ResponsesStream({ res, model: slug });
      if (stream) stream.start();
      try {
        let finishReason = null;
        if (adapter.passthrough) {
          await pipeResponsesSse(upstream, res, pipe);
        } else {
          for await (const event of adapter.translate(upstream)) {
            switch (event.type) {
              case 'text':
                if (!firstOutputAt) firstOutputAt = Date.now();
                if (!firstTextAt) firstTextAt = Date.now();
                stream.textDelta(event.delta);
                break;
              case 'reasoning':
                if (!firstOutputAt) firstOutputAt = Date.now();
                stream.reasoningDelta(event.delta);
                break;
              case 'reasoning_signature':
                stream.reasoningSignature(event.delta);
                break;
              case 'reasoning_done':
                stream.reasoningDone();
                break;
              case 'text_done':
                stream.textDone?.();
                break;
              case 'tool_start':
                sawToolCall = true;
                if (!firstOutputAt) firstOutputAt = Date.now();
                if (!firstTextAt) firstTextAt = Date.now();
                stream.toolStart({ key: event.key ?? 0, id: event.id, name: event.name });
                break;
              case 'tool_args':
                if (!firstOutputAt) firstOutputAt = Date.now();
                if (!firstTextAt) firstTextAt = Date.now();
                stream.toolArgsDelta({ key: event.key ?? 0, delta: event.delta });
                break;
              case 'usage':
                stream.setUsage(event.usage);
                break;
              case 'finish':
                finishReason = event.reason;
                break;
              default:
                break;
            }
          }
        }
        if (clientGone) {
          finalizeClientGone();
          return;
        }
        if (adapter.passthrough) {
          if (pipe.failed) {
            logFinal({
              level: 'error',
              msg: `上游返回失败事件: ${pipe.failed.message}`,
              status: 502,
              ...partialUsage(),
            });
            // 上游的 response.failed/error 已经逐字节转发，不能再补发第二个失败帧。
            if (!res.writableEnded) res.end();
            return;
          }
          if (!pipe.completed) {
            const message = '上游响应在 response.completed 之前结束';
            logFinal({
              level: 'error',
              msg: `流式转发失败: ${message}`,
              status: 502,
              ...partialUsage(),
            });
            sendResponsesFailure(res, { responseId: pipe.responseId, message });
            return;
          }
          observed.hasToolCalls = (pipe.toolCalls || 0) > 0;
          observed.text = pipe.outputText;
          const entry = logFinal({
            level: 'info',
            msg: `完成 ${slug} -> ${route.modelId} (${Date.now() - started}ms)`,
            status: 200,
            tokens: normalizeUsage(pipe.usage) || estimateUsage(body, pipe.outputText),
            cacheUsageAvailable: hasCacheUsage(pipe.usage),
            estimatedUsage: !pipe.usage || undefined,
            events: pipe.events,
            firstOutputMs: pipe.firstOutputAt ? pipe.firstOutputAt - started : undefined,
            firstTextMs: pipe.firstTextAt ? pipe.firstTextAt - started : undefined,
          });
          if (!res.writableEnded) res.end();
          return entry;
        }
        observed.hasToolCalls = sawToolCall;
        observed.text = stream.text;
        stream.complete({ requestBody: body, finishReason });
        logFinal({
          level: 'info',
          msg: `完成 ${slug} -> ${route.modelId} (${Date.now() - started}ms)`,
          status: 200,
          tokens: stream.usage,
          cacheUsageAvailable: stream.cacheUsageAvailable,
          estimatedUsage: stream.usageEstimated || undefined,
          events: stream.emittedTypes.length,
          firstOutputMs: firstOutputAt ? firstOutputAt - started : undefined,
          firstTextMs: firstTextAt ? firstTextAt - started : undefined,
        });
      } catch (err) {
        err.message = redactDiagnostic(err.message, [provider]);
        if (clientGone) {
          finalizeClientGone();
          return;
        }
        logEntry({ level: 'error', msg: `请求异常: ${err && err.message ? err.message : err}`, ...baseLog, status: 502, ms: Date.now() - started });
        logFinal({
          level: 'error',
          msg: `流式转发失败: ${err.message}`,
          status: 502,
          ...partialUsage(),
        });
        if (adapter.passthrough) {
          sendResponsesFailure(res, { responseId: pipe && pipe.responseId, message: err.message });
        } else {
          stream.fail(err.message);
        }
      }
    } catch (err) {
      err.message = redactDiagnostic(err.message, [provider]);
      if (clientGone) {
        finalizeClientGone();
        return;
      }
      if (res.writableEnded) return;
      const status = err.statusCode || (err.upstreamStatus && err.upstreamStatus < 500 ? err.upstreamStatus : 502);
      logFinal({
        level: 'error',
        msg: `上游请求失败: ${err.message}`,
        status,
      });
      if (!res.headersSent) sendProtocolError(status, err.message, status < 500 ? 'invalid_request_error' : 'api_error');
    } finally {
      clearTimeout(timer);
      res.removeListener('close', onClose);
      if (observeTask && typeof taskObserver.requestFinished === 'function') {
        try { taskObserver.requestFinished({ requestId: baseLog.requestId }); } catch { /* ignore */ }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  function on(event, cb) {
    if (event !== 'log' || typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return {
    start,
    stop,
    stopSync,
    getState,
    autoStart,
    probe,
    on,
    // ---- 以下为契约外的便利方法（渲染层/测试/诊断用）----
    getLogs: () => ring.slice(),
    getRequestSpeed: latestRequestSpeed,
    resetLogs: () => {
      ring.length = 0;
    },
    router,
  };
}

module.exports = {
  createGateway,
  inlineWeixinImageUrls,
  isWeixinGatewayRequest,
  RING_SIZE,
  DEFAULT_PORT,
};
