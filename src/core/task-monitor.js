'use strict';
/**
 * ChatGPT 桌面端任务监听：只观察本地网关上的 /v1/responses 轮次，
 * 用于开始/完成即时通知与运行中每 5 分钟进度通知。
 *
 * 微信 app-server 的请求会带 x-gptplus-source: weixin（网关不会转交本模块），
 * 因此微信自己的对话不会被当成 ChatGPT 任务反复通知。
 * 纯 Node CommonJS，now / onNotify 可注入，方便 node --test。
 */
const crypto = require('node:crypto');

const TICK_MS = 30 * 1000;
const PROGRESS_INTERVAL_MS = 5 * 60 * 1000;
const STALE_RUNNING_MS = 20 * 60 * 1000;
const STALE_FAILING_MS = 5 * 60 * 1000;
const TITLE_LIMIT = 60;
const TEXT_LIMIT = 240;

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  const value = oneLine(text);
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** 取 Responses 请求里最后一条 user 消息文本（即最新输入的提示词）。 */
function lastUserText(body) {
  const input = Array.isArray(body && body.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || item.type !== 'message' || item.role !== 'user') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

function turnKeyOf(body) {
  const instructions = String((body && body.instructions) || '').slice(0, 4000);
  return crypto.createHash('sha1')
    .update(instructions + '\u001f' + lastUserText(body), 'utf8')
    .digest('hex');
}

function isTitleGenBody(body) {
  const texts = [String((body && body.instructions) || ''), lastUserText(body)];
  return texts.some((text) => /^you are a helpful assistant\./i.test(text) && /\btitle\b/i.test(text));
}

function snapshot(task) {
  return {
    id: task.id,
    title: task.title,
    model: task.model,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt || null,
    rounds: task.rounds,
    lastText: task.lastText || '',
    lastError: task.lastError || null,
  };
}

/**
 * @param {{ onNotify?: (event:{kind:string, task:any})=>void, log?: (e:any)=>void,
 *           now?: ()=>number, tickMs?: number, progressMs?: number }} deps
 */
function createTaskMonitor(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const onNotify = typeof deps.onNotify === 'function' ? deps.onNotify : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const tickMs = Number.isFinite(Number(deps.tickMs)) && Number(deps.tickMs) > 0
    ? Number(deps.tickMs) : TICK_MS;
  const progressMs = Number.isFinite(Number(deps.progressMs)) && Number(deps.progressMs) > 0
    ? Number(deps.progressMs) : PROGRESS_INTERVAL_MS;

  /** @type {Map<string, any>} turnKey -> task */
  const running = new Map();
  /** @type {Map<string, string>} requestId -> turnKey */
  const requestTurns = new Map();
  let ticker = null;

  function emit(kind, task) {
    try {
      onNotify({ kind, task: snapshot(task) });
    } catch (err) {
      log({ level: 'warn', msg: `任务通知回调失败: ${err && err.message ? err.message : err}` });
    }
  }

  function finish(task, kind, error) {
    if (!running.has(task.turnKey)) return;
    running.delete(task.turnKey);
    task.status = kind;
    task.endedAt = now();
    if (error) task.lastError = String(error).slice(0, 300);
    emit(kind, task);
  }

  function turnRequest({ body, slug } = {}) {
    if (!body || !Array.isArray(body.input) || body.input.length === 0) return null;
    if (isTitleGenBody(body)) return null;
    const title = truncate(lastUserText(body), TITLE_LIMIT);
    if (!title) return null;
    const turnKey = turnKeyOf(body);
    const existing = running.get(turnKey);
    if (existing) {
      existing.rounds += 1;
      existing.lastSeenAt = now();
      existing.failing = false;
      existing.lastError = null;
      if (slug && !existing.model) existing.model = String(slug);
      return { turnKey };
    }
    const task = {
      id: `g_${crypto.randomBytes(4).toString('hex')}`,
      turnKey,
      title,
      model: String(slug || ''),
      status: 'running',
      startedAt: now(),
      lastSeenAt: now(),
      lastNotifyAt: now(),
      rounds: 1,
      lastText: '',
      lastError: null,
      inFlight: 0,
    };
    running.set(turnKey, task);
    emit('started', task);
    return { turnKey };
  }

  function turnResponse({ body, slug, ok, status, hasToolCalls, text } = {}) {
    if (!body) return;
    const task = running.get(turnKeyOf(body));
    if (!task) return;
    task.lastSeenAt = now();
    if (text) task.lastText = truncate(text, TEXT_LIMIT);
    if (slug && !task.model) task.model = String(slug);
    const statusCode = Number(status);
    if (Number.isFinite(statusCode) && statusCode === 200) task.failing = false;
    if (ok === true && statusCode === 200) {
      if (!hasToolCalls) finish(task, 'done');
      return;
    }
    if (statusCode === 499) {
      finish(task, 'stopped');
      return;
    }
    task.failing = true;
    task.lastError = `HTTP ${statusCode || '???'}`;
  }

  function requestStarted({ turnKey, requestId } = {}) {
    if (!turnKey || !requestId) return;
    requestTurns.set(requestId, turnKey);
    const task = running.get(turnKey);
    if (task) task.inFlight += 1;
  }

  function requestFinished({ requestId } = {}) {
    if (!requestId) return;
    const turnKey = requestTurns.get(requestId);
    requestTurns.delete(requestId);
    const task = turnKey ? running.get(turnKey) : null;
    if (task) task.inFlight = Math.max(0, task.inFlight - 1);
  }

  function tick() {
    const at = now();
    for (const task of [...running.values()]) {
      const idle = at - (task.lastSeenAt || task.startedAt);
      if (task.inFlight <= 0 && task.failing && idle > STALE_FAILING_MS) {
        finish(task, 'failed', task.lastError || '上游连续失败');
        continue;
      }
      if (task.inFlight <= 0 && idle > STALE_RUNNING_MS) {
        finish(task, 'stale');
        continue;
      }
      if (at - task.startedAt >= progressMs && at - (task.lastNotifyAt || task.startedAt) >= progressMs) {
        task.lastNotifyAt = at;
        emit('progress', task);
      }
    }
  }

  function start() {
    if (ticker) return;
    ticker = setInterval(() => {
      try { tick(); } catch (err) {
        log({ level: 'warn', msg: `任务监听 tick 失败: ${err && err.message ? err.message : err}` });
      }
    }, tickMs);
    if (typeof ticker.unref === 'function') ticker.unref();
  }

  function stop() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    running.clear();
    requestTurns.clear();
  }

  function listRunning() {
    return [...running.values()].map(snapshot);
  }

  return {
    turnRequest,
    turnResponse,
    requestStarted,
    requestFinished,
    start,
    stop,
    tick,
    listRunning,
    _tick: tick,
  };
}

module.exports = {
  createTaskMonitor,
  lastUserText,
  turnKeyOf,
  isTitleGenBody,
  PROGRESS_INTERVAL_MS,
};
