'use strict';

const path = require('node:path');
const {
  findAvailablePort,
  listTargets,
  pickMainTarget,
  evaluate,
  addScriptOnNewDocument,
  removeScriptOnNewDocument,
} = require('./cdp.js');
const { findChatGptDebugPort } = require('./chatgpt-launch.js');
const { buildUsageStatuslineScript } = require('./usage-statusline.js');

const DEFAULT_INJECT_TIMEOUT_MS = 30000;
const SCRIPT_READY_WAIT_MS = 15000;
const PROBE_READY_WAIT_MS = 2000;
const RETRY_INTERVAL_MS = 400;
const VISIBLE_INTERVAL_MS = 500;
const HIDDEN_INTERVAL_MS = 1000;
const BRIDGE_RETRY_MS = 2000;
const COMMAND_TIMEOUT_MS = 5000;
const ERROR_LOG_INTERVAL_MS = 60000;
const CONTEXT_EXPRESSION = 'globalThis.__gptplusUsageStatusline?.context?.()';

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function buildScriptSources(metrics) {
  return {
    add: buildUsageStatuslineScript({ readyWaitMs: SCRIPT_READY_WAIT_MS, metrics }),
    probe: buildUsageStatuslineScript({ readyWaitMs: PROBE_READY_WAIT_MS, metrics }),
  };
}

function applyExpression(id, events, request) {
  return `globalThis.__gptplusUsageStatusline?.apply?.(${JSON.stringify(String(id))}, ${JSON.stringify(events)}, ${JSON.stringify(request || null)})`;
}

async function ensurePageScript(page, scripts, prepared) {
  if (!prepared.has(page.id)) {
    // 注册到页面后，后续导航/重载会重新执行；prepared 只避免重复注册同一目标。
    const registered = await addScriptOnNewDocument(page, scripts.add, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (registered?.identifier) injectedScriptIds.set(page.id, { page, identifier: registered.identifier });
    prepared.add(page.id);
  }
  return evaluate(page, scripts.probe, { timeoutMs: PROBE_READY_WAIT_MS + 5000 });
}

function usageStatuslineEndpoint(gateway) {
  if (!gateway?.running || !Number.isInteger(Number(gateway.port)) || Number(gateway.port) <= 0) {
    throw new Error('本地网关未运行，无法读取输入框用量状态');
  }
  const configuredHost = String(gateway.host || '127.0.0.1');
  const host = configuredHost === '0.0.0.0' ? '127.0.0.1' : configuredHost === '::' ? '::1' : configuredHost;
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${Number(gateway.port)}/thread-usage-live`;
}

async function injectUsageStatusline({
  cdpPort,
  target = null,
  timeoutMs = DEFAULT_INJECT_TIMEOUT_MS,
  pause = sleep,
  metrics,
} = {}) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');

  const scripts = buildScriptSources(metrics);
  const prepared = new Set();
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_INJECT_TIMEOUT_MS);
  let lastError = null;

  while (Date.now() < deadline) {
    let page = target;
    if (!page) {
      try { page = pickMainTarget(await listTargets(port)); }
      catch (error) { lastError = error; page = null; }
    }
    if (page) {
      try {
        const result = await ensurePageScript(page, scripts, prepared);
        if (result?.installed === true) return { ok: true, installed: true, target: page };
        if (result?.ok === false) lastError = new Error(result.error || 'ChatGPT 用量状态栏脚本未成功执行');
        else lastError = new Error('ChatGPT 页面尚未就绪');
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() >= deadline) break;
    await pause(RETRY_INTERVAL_MS);
  }
  throw new Error(lastError ? `注入用量状态栏失败: ${lastError.message}` : '等待 ChatGPT 页面就绪超时');
}

async function ensureUsageGateway(ctx) {
  if (!ctx?.gateway || typeof ctx.gateway.getState !== 'function' || typeof ctx.gateway.start !== 'function') {
    throw new Error('本地网关服务不可用');
  }
  const before = ctx.gateway.getState();
  const config = ctx.store?.get?.()?.gateway || {};
  await ctx.gateway.start({ port: config.port, host: config.host, token: config.token });
  const state = ctx.gateway.getState();
  if (!before?.running) {
    ctx.log?.({ level: 'info', msg: `为 ChatGPT 用量状态栏启动本地网关: ${state?.url || state?.port || ''}` });
  }
  usageStatuslineEndpoint(state);
  return state;
}

let activeBridge = null;
const injectedScriptIds = new Map();

function stopUsageStatuslineBridge() {
  if (!activeBridge) return;
  activeBridge.stop();
  activeBridge = null;
}

async function disposeUsageStatusline({ cdpPort, target = null, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  const page = target || pickMainTarget(await listTargets(port));
  if (!page) return { ok: false, skipped: true };
  await evaluate(page, 'globalThis.__gptplusUsageStatuslineDispose?.(); ({ ok: true })', { timeoutMs });
  const registered = injectedScriptIds.get(page.id);
  if (registered?.identifier) {
    try {
      await removeScriptOnNewDocument(page, registered.identifier, { timeoutMs });
    } finally {
      injectedScriptIds.delete(page.id);
    }
  }
  return { ok: true, target: page };
}

function usageMetrics(ctx) {
  const config = ctx?.plugins?.config?.('usage-statusline');
  return config && typeof config === 'object' && config.metrics && typeof config.metrics === 'object'
    ? config.metrics
    : undefined;
}

/**
 * 页面自身受 CSP connect-src 限制，不能直接访问 127.0.0.1；
 * 用量由 gpt++ 读取后通过 CDP 推送，顺便负责页面重载后的重新注入。
 */
function startUsageStatuslineBridge({
  cdpPort,
  read,
  requestSpeed,
  subscribe,
  log,
  metrics,
  visibleIntervalMs = VISIBLE_INTERVAL_MS,
  hiddenIntervalMs = HIDDEN_INTERVAL_MS,
  listTargetsImpl = listTargets,
  evaluateImpl = evaluate,
} = {}) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  if (typeof read !== 'function') throw new Error('本机会话用量读取器不可用');

  stopUsageStatuslineBridge();
  const scripts = buildScriptSources(metrics);
  const prepared = new Set();
  let stopped = false;
  let target = null;
  let lastErrorAt = 0;
  let wakeResolver = null;
  let wakeRequested = false;

  function requestWake() {
    if (stopped) return;
    wakeRequested = true;
    const resolve = wakeResolver;
    wakeResolver = null;
    resolve?.();
  }

  function waitForNext(delay) {
    if (stopped || wakeRequested) {
      wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (wakeResolver === finish) wakeResolver = null;
        resolve();
      };
      wakeResolver = finish;
      timer = setTimeout(finish, delay);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  function reportError(message, error) {
    const now = Date.now();
    if (typeof log !== 'function' || now - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = now;
    log({ level: 'warn', msg: `${message}: ${error?.message || error}` });
  }

  async function run() {
    while (!stopped) {
      let delay = visibleIntervalMs;
      try {
        if (!target) target = pickMainTarget(await listTargetsImpl(port));
        if (!target) {
          delay = BRIDGE_RETRY_MS;
        } else {
          let value = await evaluateImpl(target, CONTEXT_EXPRESSION, { timeoutMs: COMMAND_TIMEOUT_MS });
          if (!value || typeof value !== 'object') {
            const installed = await ensurePageScript(target, scripts, prepared);
            if (installed?.installed === true) {
              value = await evaluateImpl(target, CONTEXT_EXPRESSION, { timeoutMs: COMMAND_TIMEOUT_MS });
            }
          }
          if (value?.id) {
            const request = typeof requestSpeed === 'function' ? requestSpeed(value.id) : null;
            let snapshot = null;
            try {
              snapshot = read(value.id);
            } catch (error) {
              // rollout 正在续接或短暂不可读时，网关请求数据仍然可以立即显示。
              reportError('本机会话用量读取失败，先推送网关请求数据', error);
            }
            if (snapshot?.status === 'ok' && Array.isArray(snapshot.events)) {
              await evaluateImpl(target, applyExpression(value.id, snapshot.events, request || snapshot.request), { timeoutMs: COMMAND_TIMEOUT_MS });
            } else if (request) {
              // 网关请求已经完成时不等 rollout 落盘：先推送速度、缓存和请求总量，
              // 等 token_count 到达后再补充上下文窗口与最新事件。
              await evaluateImpl(target, applyExpression(value.id, null, request), { timeoutMs: COMMAND_TIMEOUT_MS });
            }
          }
          if (value?.hidden === true) delay = hiddenIntervalMs;
        }
      } catch (error) {
        target = null;
        prepared.clear();
        delay = BRIDGE_RETRY_MS;
        reportError('输入框用量栏数据推送暂停', error);
      }
      if (stopped) break;
      await waitForNext(delay);
    }
  }

  let unsubscribe = null;
  const bridge = {
    stop() {
      stopped = true;
      wakeRequested = false;
      unsubscribe?.();
      unsubscribe = null;
      const resolve = wakeResolver;
      wakeResolver = null;
      resolve?.();
    },
    wake: requestWake,
    cdpPort: port,
  };
  if (typeof subscribe === 'function') {
    try {
      const off = subscribe((entry) => {
        if (entry?.final === true && Number(entry.status) === 200) requestWake();
      });
      if (typeof off === 'function') unsubscribe = off;
    } catch (error) {
      reportError('订阅网关完成事件失败，继续使用定时刷新', error);
    }
  }
  activeBridge = bridge;
  void run();
  return bridge;
}

function isChatGptPage(target) {
  const url = String(target?.url || '').toLowerCase();
  if (url === 'app://-/index.html') return true;
  return /codex|chatgpt/i.test(`${target?.title || ''} ${url}`);
}

/**
 * gpt++ 自身重启后重新接上仍在运行的 ChatGPT：找回它上次的调试端口并恢复数据推送。
 * 未运行或未开放调试端口时静默跳过，不打扰正常启动。
 */
async function resumeUsageStatusline({
  ctx,
  timeoutMs = 10000,
  findPort = findChatGptDebugPort,
  listTargetsImpl = listTargets,
  inject = injectUsageStatusline,
  startBridge = startUsageStatuslineBridge,
} = {}) {
  if (ctx?.plugins?.isActive && !ctx.plugins.isActive('usage-statusline')) {
    stopUsageStatuslineBridge();
    return { ok: false, skipped: true, disabled: true };
  }
  if (activeBridge) return { ok: true, resumed: false, active: true };
  let port = null;
  try {
    const executablePath = ctx?.store?.get?.()?.chatgpt?.executablePath || '';
    const imageName = executablePath ? path.win32.basename(executablePath) : '';
    port = await findPort(imageName ? { imageName } : {});
  } catch {
    port = null;
  }
  if (!port) return { ok: false, skipped: true };

  let target = null;
  try {
    target = pickMainTarget(await listTargetsImpl(port));
  } catch {
    return { ok: false, skipped: true };
  }
  if (!target || !isChatGptPage(target)) return { ok: false, skipped: true };

  try {
    const metrics = usageMetrics(ctx);
    const result = await inject({ cdpPort: port, target, timeoutMs, ...(metrics ? { metrics } : {}) });
    if (result?.installed !== true) throw new Error('页面状态栏未安装');
    let bridge = null;
    if (typeof ctx?.usageLive?.read === 'function' && typeof startBridge === 'function') {
      const metrics = usageMetrics(ctx);
      bridge = startBridge({
        cdpPort: port,
        read: (id) => ctx.usageLive.read(id),
        requestSpeed: (id) => ctx.gateway?.getRequestSpeed?.(id),
        ...(typeof ctx.gateway?.on === 'function' ? { subscribe: (cb) => ctx.gateway.on('log', cb) } : {}),
        log: ctx.log,
        ...(metrics ? { metrics } : {}),
      });
    }
    ctx?.log?.({ level: 'info', msg: `已恢复 ChatGPT 输入框用量状态栏（调试端口 ${port}）` });
    return { ok: true, cdpPort: port, bridge: !!bridge };
  } catch (error) {
    ctx?.log?.({ level: 'warn', msg: `恢复输入框用量状态栏失败: ${error.message}` });
    return { ok: false, error: error.message };
  }
}

async function launchChatGptWithUsageStatusline({
  ctx,
  launch,
  launchOptions = {},
  wrapperDir,
  findPort = findAvailablePort,
  inject = injectUsageStatusline,
  startBridge = startUsageStatuslineBridge,
} = {}) {
  if (typeof launch !== 'function') throw new Error('ChatGPT 启动函数不可用');
  if (ctx?.plugins?.isActive && !ctx.plugins.isActive('usage-statusline')) {
    throw new Error('ChatGPT 用量信息栏插件未启用');
  }

  stopUsageStatuslineBridge();
  const gateway = await ensureUsageGateway(ctx);
  const cdpPort = await findPort(9229);
  const launched = await launch({
    ...launchOptions,
    cdpPort,
    ...(wrapperDir ? { wrapperDir } : {}),
  });
  if (!launched?.ok) return launched || { ok: false, error: '启动 ChatGPT 失败' };

  try {
    const metrics = usageMetrics(ctx);
    await inject({ cdpPort, ...(metrics ? { metrics } : {}) });
    ctx.log?.({ level: 'info', msg: '已将用量状态栏注入 ChatGPT 输入框下方' });
    let bridge = null;
    if (typeof ctx?.usageLive?.read === 'function' && typeof startBridge === 'function') {
      const metrics = usageMetrics(ctx);
      bridge = startBridge({
        cdpPort,
        read: (id) => ctx.usageLive.read(id),
        requestSpeed: (id) => ctx.gateway?.getRequestSpeed?.(id),
        ...(typeof ctx.gateway?.on === 'function' ? { subscribe: (cb) => ctx.gateway.on('log', cb) } : {}),
        log: ctx.log,
        ...(metrics ? { metrics } : {}),
      });
    }
    return { ...launched, injected: true, cdpPort, bridge: !!bridge };
  } catch (error) {
    ctx.log?.({ level: 'warn', msg: `ChatGPT 已启动，但用量状态栏注入失败: ${error.message}` });
    return { ...launched, injected: false, cdpPort, injectError: error.message };
  }
}

module.exports = {
  ensureUsageGateway,
  disposeUsageStatusline,
  injectUsageStatusline,
  launchChatGptWithUsageStatusline,
  resumeUsageStatusline,
  startUsageStatuslineBridge,
  stopUsageStatuslineBridge,
  usageStatuslineEndpoint,
};
