'use strict';
/**
 * Codex app-server 的最小 JSON-RPC 客户端（换行分隔 JSON）。
 * 与 Codex++ 的 connect/app_server.rs 对齐：initialize → thread/resume|start
 * → turn/start，收集 item/completed 的 agentMessage 文本、模型与上下文用量。
 * 纯 Node CommonJS，spawn 可注入，方便 node --test。
 */
const { spawn } = require('node:child_process');

const REQUEST_TIMEOUT_MS = 120 * 1000;
const TURN_TIMEOUT_MS = 600 * 1000;
const STDERR_TAIL_LINES = 8;
const OPT_OUT_METHODS = [
  'command/exec/outputDelta',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/fileChange/outputDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
];

function normalizeSandbox(value) {
  return value === 'workspace-write' || value === 'danger-full-access' ? value : 'read-only';
}

function buildTurnInput(prompt, images = []) {
  const input = [{ type: 'text', text: String(prompt || ''), text_elements: [] }];
  for (const url of Array.isArray(images) ? images : []) {
    const value = String(url || '').trim();
    if (value) input.push({ type: 'image', url: value, detail: 'auto' });
  }
  return input;
}

function buildAppServerArgs(opts = {}) {
  const baseArgs = Array.isArray(opts.args) && opts.args.length ? opts.args.map(String) : ['app-server'];
  const overrides = Array.isArray(opts.configOverrides)
    ? opts.configOverrides.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const args = [];
  for (const override of overrides) args.push('-c', override);
  args.push(...baseArgs);
  return args;
}

function responseId(message) {
  return message && Number.isInteger(message.id) ? message.id : null;
}

function isServerRequest(message) {
  return !!message
    && message.id != null
    && typeof message.method === 'string';
}

function deepString(value, keys) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => deepString(item, keys)).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof value !== 'object') return null;
  for (const key of keys) {
    const found = deepString(value[key], keys);
    if (found) return found;
  }
  return null;
}

function rpcError(message) {
  const error = message && message.error;
  if (!error) return null;
  return deepString(error, ['message', 'error']) || JSON.stringify(error);
}

function extractThreadId(result) {
  return deepString(result, ['threadId', 'id'])
    || deepString(result && result.thread, ['id', 'threadId']);
}

function extractTurnId(result) {
  return deepString(result, ['turnId', 'id'])
    || deepString(result && result.turn, ['id', 'turnId']);
}

function extractModel(value) {
  const model = deepString(value, ['model', 'modelSlug', 'model_slug', 'modelId', 'model_id']);
  return model ? model.trim() : '';
}

function valueAsU64(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseTurnUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const window = valueAsU64(value.modelContextWindow ?? value.model_context_window);
  const last = value.last || value.last_token_usage;
  const contextUsed = valueAsU64(last && (last.totalTokens ?? last.total_tokens))
    ?? valueAsU64(value.contextUsed ?? value.context_used);
  if (contextUsed == null && window == null) return null;
  return { contextUsed, contextWindow: window };
}

function extractTurnUsage(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = extractTurnUsage(item);
      if (usage) return usage;
    }
    return null;
  }
  const direct = parseTurnUsage(value.tokenUsage || value.token_usage);
  if (direct) return direct;
  if (value.method === 'thread/tokenUsage/updated') return extractTurnUsage(value.params);
  for (const child of Object.values(value)) {
    const usage = extractTurnUsage(child);
    if (usage) return usage;
  }
  return null;
}

function extractCompletedAgentText(message) {
  const item = message && message.params && message.params.item;
  if (!item) return null;
  const type = String(item.type || '');
  if (type !== 'agentMessage' && type !== 'assistantMessage' && type !== 'output_text') return null;
  const text = deepString(item, ['text', 'content', 'output_text']);
  const trimmed = text ? text.trim() : '';
  return trimmed || null;
}

function threadStatusIsIdle(message) {
  const status = message && message.params && message.params.status;
  const type = status && typeof status === 'object' ? (status.type ?? status) : status;
  return type === 'idle';
}

async function killProcessTree(child, spawnImpl = spawn) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    // 先杀整棵进程树，再杀直接子进程：桌面版 codex.exe 会 re-exec 出真正的
    // app-server，先 kill 父进程会让 taskkill /T 找不到这棵树的根。
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('close', finish);
        killer.on('error', finish);
        const timer = setTimeout(finish, 2000);
        if (typeof timer.unref === 'function') timer.unref();
      } catch {
        finish();
      }
    });
    try { child.kill(); } catch { /* 已被 taskkill 结束 */ }
  } else {
    try { child.kill(); } catch { /* 已退出 */ }
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* ignore */ }
  }
  try { child.unref(); } catch { /* ignore */ }
}

/**
 * @param {{ executable: string, workDir: string, model?: string, sandbox?: string,
 *           env?: Record<string,string>, spawnImpl?: Function, appVersion?: string }} opts
 * @returns {Promise<object>}
 */
async function createCodexAppServer(opts = {}) {
  const executable = String(opts.executable || '').trim();
  const workDir = String(opts.workDir || '').trim();
  if (!executable) throw new Error('未配置 Codex CLI');
  if (!workDir) throw new Error('未配置工作目录');
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  const model = String(opts.model || '').trim();
  const sandbox = normalizeSandbox(opts.sandbox);
  const isScript = /\.(cmd|bat)$/i.test(executable);
  const args = buildAppServerArgs(opts);
  const spawnOpts = {
    cwd: workDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env || {}) },
  };
  const child = isScript
    ? spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...args], spawnOpts)
    : spawnImpl(executable, args, spawnOpts);

  const stderrTail = [];
  let stderrBuffer = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      let index;
      while ((index = stderrBuffer.indexOf('\n')) !== -1) {
        const line = stderrBuffer.slice(0, index).trim();
        stderrBuffer = stderrBuffer.slice(index + 1);
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });
  }

  /** @type {any[]} */
  let queue = [];
  let waiter = null;
  let closed = false;
  let running = true;
  let nextId = 1;
  let stdoutBuffer = '';

  function deliver(message) {
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.resolve(message);
    } else {
      queue.push(message);
    }
  }

  function rejectWaiter(error) {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    current.reject(error);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    deliver(message);
  }

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) handleLine(line);
      }
    });
  }

  child.on('close', () => {
    running = false;
    closed = true;
    rejectWaiter(new Error('Codex app-server 已关闭'));
  });
  child.on('error', (err) => {
    running = false;
    rejectWaiter(new Error(`Codex app-server 启动失败: ${err.message}`));
  });

  function readMessage(timeoutMs) {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.reject(new Error('Codex app-server 已关闭'));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: (message) => {
          clearTimeout(timer);
          if (waiter === entry) waiter = null;
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (waiter === entry) waiter = null;
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        if (waiter === entry) waiter = null;
        reject(new Error('等待 Codex app-server 响应超时'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      waiter = entry;
    });
  }

  function writeJson(value) {
    if (!child.stdin || child.stdin.destroyed) throw new Error('Codex app-server stdin 不可写');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async function rejectServerRequest(message) {
    const id = message.id;
    const method = String(message.method || '');
    let result;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      result = { decision: 'decline' };
    } else if (method === 'item/permissions/requestApproval') {
      result = { permissions: {} };
    } else if (method === 'item/tool/requestUserInput') {
      result = { answers: {} };
    } else if (method === 'item/tool/call') {
      result = {
        success: false,
        contentItems: [{ type: 'inputText', text: 'tool not available on this client' }],
      };
    } else {
      writeJson({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
      return;
    }
    writeJson({ jsonrpc: '2.0', id, result });
  }

  async function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = nextId;
    nextId += 1;
    writeJson({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Codex app-server ${method} 请求超时`);
      const message = await readMessage(remaining);
      if (isServerRequest(message)) {
        await rejectServerRequest(message);
        continue;
      }
      if (responseId(message) !== id) continue;
      const error = rpcError(message);
      if (error) throw new Error(`Codex app-server ${method} 失败：${error}`);
      return message.result ?? null;
    }
  }

  function threadParams() {
    const params = {
      cwd: workDir,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      approvalPolicy: 'never',
      sandbox,
    };
    if (model) params.model = model;
    return params;
  }

  async function initialize() {
    await request('initialize', {
      clientInfo: {
        name: 'gptplus-weixin',
        title: 'gpt++ 微信连接',
        version: String(opts.appVersion || '0.0.0'),
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: OPT_OUT_METHODS,
      },
    });
    writeJson({ jsonrpc: '2.0', method: 'initialized' });
  }

  async function prepareThread(threadId) {
    const params = threadParams();
    const resumeId = String(threadId || '').trim();
    const method = resumeId ? 'thread/resume' : 'thread/start';
    if (resumeId) {
      params.threadId = resumeId;
      params.persistExtendedHistory = true;
    }
    const result = await request(method, params);
    const id = extractThreadId(result);
    if (!id) throw new Error(`Codex app-server ${method} 未返回 thread id`);
    return id;
  }

  async function runTurn(threadId, prompt, options = {}) {
    const id = nextId;
    nextId += 1;
    const params = {
      threadId,
      input: buildTurnInput(prompt, options.images),
      approvalPolicy: 'never',
    };
    if (model) params.model = model;
    writeJson({ jsonrpc: '2.0', id, method: 'turn/start', params });

    let responseReceived = false;
    let turnCompleted = false;
    const replyParts = [];
    let reportedModel = model;
    let usage = { contextUsed: null, contextWindow: null };
    const deadline = Date.now() + TURN_TIMEOUT_MS;

    while (!responseReceived || !turnCompleted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('等待 Codex 回复超时');
      const message = await readMessage(remaining);
      if (isServerRequest(message)) {
        await rejectServerRequest(message);
        continue;
      }
      if (responseId(message) === id) {
        const error = rpcError(message);
        if (error) throw new Error(`Codex turn/start 失败：${error}`);
        const result = message.result ?? null;
        if (!extractTurnId(result)) throw new Error('Codex turn/start 未返回 turn id');
        if (!reportedModel) reportedModel = extractModel(result);
        const reported = extractTurnUsage(result);
        if (reported) usage = reported;
        responseReceived = true;
        continue;
      }

      if (!reportedModel) reportedModel = extractModel(message);
      const reported = extractTurnUsage(message);
      if (reported) usage = reported;

      const method = message.method;
      if (method === 'item/completed') {
        const text = extractCompletedAgentText(message);
        if (text && !replyParts.includes(text)) replyParts.push(text);
      } else if (method === 'turn/completed') {
        turnCompleted = true;
      } else if (method === 'thread/status/changed' && threadStatusIsIdle(message)) {
        turnCompleted = true;
      } else if (method === 'error') {
        const text = deepString(message.params, ['message', 'error']) || 'Codex app-server 返回未知错误';
        throw new Error(text);
      }
    }

    return {
      reply: replyParts.join('\n\n'),
      model: reportedModel || '',
      usage,
    };
  }

  function isRunning() {
    return running && !closed;
  }

  async function close() {
    if (closed && !child.pid) return;
    closed = true;
    running = false;
    rejectWaiter(new Error('Codex app-server 已关闭'));
    try { child.stdin.end(); } catch { /* ignore */ }
    await killProcessTree(child, spawnImpl);
  }

  try {
    await initialize();
  } catch (error) {
    await close();
    const detail = stderrTail.join('；');
    if (detail) throw new Error(`${error.message}（Codex app-server 输出：${detail}）`);
    throw error;
  }

  return {
    prepareThread,
    runTurn,
    isRunning,
    close,
    get pid() { return child.pid || null; },
  };
}

module.exports = {
  createCodexAppServer,
  extractThreadId,
  extractTurnId,
  extractModel,
  extractTurnUsage,
  extractCompletedAgentText,
  threadStatusIsIdle,
  normalizeSandbox,
  deepString,
  buildAppServerArgs,
  buildTurnInput,
};
