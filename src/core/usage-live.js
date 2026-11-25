'use strict';

// 只从本机 Codex rollout 提取用量元数据：保留最近的事件，
// 另行增量累加会话缓存统计，不保留或发送消息正文。
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // 旧版 Node/Electron 没有 node:sqlite 时退回标准 sessions 目录扫描。
}

const INITIAL_WINDOW_BYTES = 512 * 1024;
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;
const EVENT_LIMIT = 24;
const TAIL_CACHE_EVENTS = 128;
const MAX_CACHED_READERS = 64;
const DEFAULT_RESOLUTION_TTL_MS = 1000;
const MAX_SCAN_ENTRIES = 8192;
const MAX_SCAN_DEPTH = 4;

function normalizeSessionId(value) {
  const id = String(value || '').replace(/^local:/, '').trim();
  if (!id || id === '__proto__' || id === 'prototype' || id === 'constructor') return '';
  return /^[A-Za-z0-9_.-]{8,128}$/.test(id) ? id : '';
}

function normalizeFsPath(value) {
  let text = String(value || '').trim();
  if (text.startsWith('\\\\?\\')) text = text.slice(4);
  return path.normalize(text);
}

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return normalizeFsPath(value);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function allowedRolloutPath(home, rawPath) {
  const candidate = canonicalPath(rawPath);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  if (!/\.jsonl$/i.test(candidate)) return null;
  const roots = ['sessions', 'archived_sessions']
    .map((name) => path.join(home, name))
    .filter((root) => fs.existsSync(root))
    .map(canonicalPath);
  return roots.some((root) => isWithin(root, candidate)) ? candidate : null;
}

function candidateDatabases(home) {
  const out = [
    path.join(home, 'state_5.sqlite'),
    path.join(home, 'sqlite', 'state_5.sqlite'),
  ];
  try {
    for (const name of fs.readdirSync(path.join(home, 'sqlite'))) {
      if (/\.db$/i.test(name)) out.push(path.join(home, 'sqlite', name));
    }
  } catch {
    // 目录不存在或当前用户无法读取时，继续走文件名扫描。
  }
  return [...new Set(out.map((item) => path.normalize(item)))];
}

function resolveFromDatabases(home, sessionId) {
  if (!DatabaseSync) return [];
  const matches = [];
  for (const dbPath of candidateDatabases(home)) {
    if (!fs.existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout=50'); } catch { /* best effort */ }
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?1 LIMIT 1').get(sessionId);
      const resolved = allowedRolloutPath(home, row?.rollout_path);
      if (resolved) matches.push(resolved);
    } catch {
      // 某个数据库正在迁移或 schema 不兼容时，继续查下一个。
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return matches;
}

function resolveByScan(home, sessionId) {
  const roots = ['sessions', 'archived_sessions']
    .map((name) => path.join(home, name))
    .filter((root) => fs.existsSync(root));
  const queue = roots.map((root) => ({ root, depth: 0 }));
  const matches = [];
  let visited = 0;
  while (queue.length && visited < MAX_SCAN_ENTRIES) {
    const { root, depth } = queue.pop();
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (visited++ >= MAX_SCAN_ENTRIES) break;
      const target = path.join(root, entry.name);
      if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
        queue.push({ root: target, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name) || !entry.name.includes(sessionId)) continue;
      const resolved = allowedRolloutPath(home, target);
      if (resolved) matches.push(resolved);
    }
  }
  return matches;
}

function numberField(source, key) {
  const value = Number(source && source[key]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function validTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageEvent(record, turnId) {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') return null;
  const info = record.payload.info;
  const last = info?.last_token_usage;
  if (!last || typeof last !== 'object') return null;
  const inputTokens = numberField(last, 'input_tokens');
  const outputTokens = numberField(last, 'output_tokens');
  const totalTokens = numberField(last, 'total_tokens');
  const event = {
    t: typeof record.timestamp === 'string' ? record.timestamp : '',
    input_tokens: inputTokens,
    cached_input_tokens: numberField(last, 'cached_input_tokens'),
    output_tokens: outputTokens,
    reasoning_output_tokens: numberField(last, 'reasoning_output_tokens'),
    total_tokens: totalTokens || inputTokens + outputTokens,
    context_window: numberField(info, 'model_context_window'),
    turn_output_tokens: numberField(info?.total_token_usage, 'output_tokens'),
    cache_usage_available: validTokenCount(last.input_tokens) !== null
      && validTokenCount(last.cached_input_tokens) !== null
      && last.cached_input_tokens <= last.input_tokens,
  };
  if (turnId) event.turn_id = turnId;
  if (!(event.input_tokens || event.output_tokens || event.total_tokens)) return null;
  return event;
}

function consumeUsageRecord(record, state) {
  const type = record?.type;
  const payload = record?.payload || {};
  const eventType = payload.type;
  const turnId = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : null;

  if (type === 'turn_context') {
    if (turnId && state.currentTurnId !== turnId) {
      state.segmentStart = state.events.length;
      state.currentTurnId = turnId;
    }
    return;
  }
  if (type !== 'event_msg') return;
  if (eventType === 'task_started' || eventType === 'turn_started') {
    state.segmentStart = state.events.length;
    state.currentTurnId = turnId;
    return;
  }
  if (['task_complete', 'turn_complete', 'turn_completed', 'task_failed', 'turn_aborted', 'task_aborted'].includes(eventType)) {
    if (turnId) {
      for (let index = state.segmentStart; index < state.events.length; index += 1) {
        if (!state.events[index].turn_id) state.events[index].turn_id = turnId;
      }
    }
    state.segmentStart = state.events.length;
    state.currentTurnId = null;
    return;
  }
  const event = usageEvent(record, state.currentTurnId);
  if (event) {
    state.events.push(event);
    if (state.cacheSamples) rememberCacheSample(record.payload.info.total_token_usage, event, state);
  }
}

function rememberCacheSample(total, event, state) {
  const usage = [event.input_tokens, event.cached_input_tokens, event.output_tokens, event.total_tokens];
  const hasCumulative = validTokenCount(total?.input_tokens) !== null && validTokenCount(total?.output_tokens) !== null;
  const fingerprint = hasCumulative ? JSON.stringify([total.input_tokens, total.cached_input_tokens,
    total.output_tokens, total.total_tokens, usage, event.cache_usage_available]) : null;
  const duplicate = fingerprint !== null && fingerprint === state.lastFingerprint
    && (!event.turn_id || !state.lastTurnId || event.turn_id === state.lastTurnId);
  state.lastFingerprint = fingerprint;
  state.lastTurnId = event.turn_id;
  if (duplicate || !event.cache_usage_available || !(event.input_tokens > 0)) return;

  // A continuation may replay the same records with the original timestamps.
  const key = event.t ? JSON.stringify([event.t, usage]) : Symbol();
  if (state.cacheSamples.has(key)) return;
  state.cacheSamples.set(key, [event.input_tokens, event.cached_input_tokens]);
  state.cacheTotals.inputTokens += event.input_tokens;
  state.cacheTotals.cachedInputTokens += event.cached_input_tokens;
}

function readUsageWindow(filePath, start, out) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.statSync(filePath).size;
    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();

    const state = { currentTurnId: null, segmentStart: 0, events: out };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || (!line.includes('"event_msg"') && !line.includes('"turn_context"'))) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      consumeUsageRecord(record, state);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readUsageTail(filePath, limit = EVENT_LIMIT) {
  const size = fs.statSync(filePath).size;
  let window = INITIAL_WINDOW_BYTES;
  for (;;) {
    const start = Math.max(0, size - window);
    const events = [];
    readUsageWindow(filePath, start, events);
    const latestTurnKnown = typeof events.at(-1)?.turn_id === 'string';
    if ((events.length >= 2 && latestTurnKnown) || start === 0 || window >= MAX_WINDOW_BYTES) {
      return events.slice(-limit);
    }
    window = Math.min(MAX_WINDOW_BYTES, window * 4);
  }
}

/**
 * 首次分块读完整个文件来统计历史；随后只处理已追加的完整行。
 * 状态栏仍只接收最近的事件和两个累计数值。
 */
function createIncrementalUsageReader(limit = EVENT_LIMIT) {
  const states = new Map();

  function consumeLine(bytes, state) {
    if (!bytes.includes('"token_count"') && !bytes.includes('"turn_context"')
      && !bytes.includes('"task_') && !bytes.includes('"turn_')) return false;
    try {
      consumeUsageRecord(JSON.parse(bytes.toString('utf8')), state);
      return true;
    } catch {
      return false;
    }
  }

  function consumeChunk(chunk, state) {
    let start = 0;
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      const rest = chunk.subarray(start, end);
      if (!state.skipLine && state.pending.length + rest.length <= MAX_WINDOW_BYTES) {
        const bytes = state.pending.length ? Buffer.concat([state.pending, rest]) : rest;
        consumeLine(bytes, state);
      }
      state.pending = Buffer.alloc(0);
      state.skipLine = false;
      start = end + 1;
    }
    if (start < chunk.length && !state.skipLine) {
      const rest = chunk.subarray(start);
      state.skipLine = state.pending.length + rest.length > MAX_WINDOW_BYTES;
      state.pending = state.skipLine ? Buffer.alloc(0) : Buffer.concat([state.pending, rest]);
    }
    const excess = state.events.length - Math.max(limit, TAIL_CACHE_EVENTS);
    if (excess > 0) {
      state.events.splice(0, excess);
      state.segmentStart = Math.max(0, state.segmentStart - excess);
    }
  }

  return (filePath) => {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const id = [stat.dev, stat.ino, stat.birthtimeMs].join(':');
      let state = states.get(filePath);
      if (!state || stat.size < state.offset || id !== state.id
        || (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs)) {
        state = { id, offset: 0, pending: Buffer.alloc(0), skipLine: false, events: [],
          currentTurnId: null, segmentStart: 0, cacheSamples: new Map(),
          cacheTotals: { inputTokens: 0, cachedInputTokens: 0 } };
      }
      if (stat.size > state.offset) {
        const buffer = Buffer.allocUnsafe(Math.min(INITIAL_WINDOW_BYTES, stat.size - state.offset));
        while (state.offset < stat.size) {
          const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - state.offset), state.offset);
          if (!read) break;
          consumeChunk(buffer.subarray(0, read), state);
          state.offset += read;
        }
        // A JSONL file may end with a complete record before a newline is written.
        if (state.pending.length && consumeLine(state.pending, state)) {
          state.pending = Buffer.alloc(0);
          state.skipLine = true;
        }
      }
      state.mtimeMs = stat.mtimeMs;
      states.delete(filePath);
      states.set(filePath, state);
      while (states.size > MAX_CACHED_READERS) states.delete(states.keys().next().value);
      return state;
    } finally {
      fs.closeSync(fd);
    }
  };
}

/**
 * 同一会话可能因续接、恢复或客户端重启产生多个 rollout 文件。
 * 数据库通常只记录主文件，而真实 token_count 可能只出现在续接文件中，
 * 因此必须比较全部候选，不能拿到第一个文件名命中就返回。
 */
function rolloutCandidates(home, sessionId) {
  return [...new Set([
    ...resolveFromDatabases(home, sessionId),
    ...resolveByScan(home, sessionId),
  ].map(canonicalPath))];
}

function resolveRolloutPath(home, sessionId, readCandidateEvents = (candidate) => readUsageTail(candidate, 1)) {
  const candidates = rolloutCandidates(home, sessionId);
  if (!candidates.length) return null;

  const ranked = candidates.map((candidate) => {
    let events = [];
    let mtimeMs = 0;
    try {
      events = readCandidateEvents(candidate);
      mtimeMs = fs.statSync(candidate).mtimeMs;
    } catch {
      // 候选文件正被客户端追加时，下一次轮询可以重新尝试。
    }
    const latestEventAt = Date.parse(events.at(-1)?.t || '');
    return {
      path: candidate,
      hasUsage: events.length > 0,
      latestEventAt: Number.isFinite(latestEventAt) ? latestEventAt : 0,
      mtimeMs,
      exactPrimary: path.basename(candidate).toLowerCase() === `${sessionId.toLowerCase()}.jsonl`,
    };
  });

  ranked.sort((left, right) => (
    Number(right.hasUsage) - Number(left.hasUsage)
    || right.latestEventAt - left.latestEventAt
    || right.mtimeMs - left.mtimeMs
    || Number(right.exactPrimary) - Number(left.exactPrimary)
    || left.path.localeCompare(right.path)
  ));
  return ranked[0].path;
}

function unavailable(sessionId, message) {
  return { status: 'unavailable', session_id: sessionId, message, events: [] };
}

function createUsageLiveReader({ codexHome, resolutionTtlMs = DEFAULT_RESOLUTION_TTL_MS } = {}) {
  const home = path.resolve(String(codexHome || ''));
  const pathCache = new Map();
  const readRollout = createIncrementalUsageReader(EVENT_LIMIT);
  const ttl = Number.isFinite(Number(resolutionTtlMs)) && Number(resolutionTtlMs) >= 0
    ? Number(resolutionTtlMs) : DEFAULT_RESOLUTION_TTL_MS;

  function read(sessionId) {
    const id = normalizeSessionId(sessionId);
    if (!id) return unavailable('', '会话 ID 无效');
    const now = Date.now();
    const cached = pathCache.get(id);
    const fresh = cached && now - cached.checkedAt < ttl && cached.paths.every((file) => fs.existsSync(file));
    const paths = fresh ? cached.paths : rolloutCandidates(home, id);
    const entry = fresh ? cached : { ...cached, paths, checkedAt: now };
    pathCache.delete(id);
    pathCache.set(id, entry);
    while (pathCache.size > MAX_CACHED_READERS) pathCache.delete(pathCache.keys().next().value);
    if (!paths.length) return unavailable(id, '未找到本机会话记录');

    const rollouts = [];
    for (const file of paths) {
      try { rollouts.push(readRollout(file)); } catch { /* 续接或替换时下一次重试 */ }
    }
    if (!rollouts.length) return unavailable(id, '会话记录暂不可读');
    const latestAt = (rollout) => Date.parse(rollout.events.at(-1)?.t) || 0;
    const latest = rollouts.reduce((best, next) => {
      if (!!best.events.length !== !!next.events.length) return next.events.length ? next : best;
      return latestAt(next) > latestAt(best) || (latestAt(next) === latestAt(best) && next.mtimeMs > best.mtimeMs)
        ? next : best;
    });
    // Reuse the aggregate until a candidate adds a unique record or is replaced.
    const signature = rollouts.map(({ cacheSamples }) => [cacheSamples, cacheSamples.size]);
    if (signature.length !== entry.signature?.length || signature.some(([samples, size], i) =>
      samples !== entry.signature[i][0] || size !== entry.signature[i][1])) {
      entry.signature = signature;
      if (rollouts.length === 1) {
        entry.cacheTotals = { ...rollouts[0].cacheTotals };
      } else {
        const seen = new Set();
        const cacheTotals = { inputTokens: 0, cachedInputTokens: 0 };
        for (const { cacheSamples } of rollouts) {
          for (const [key, [input, cachedInput]] of cacheSamples) {
            if (seen.has(key)) continue;
            seen.add(key);
            cacheTotals.inputTokens += input;
            cacheTotals.cachedInputTokens += cachedInput;
          }
        }
        entry.cacheTotals = cacheTotals;
      }
    }
    return { status: 'ok', session_id: id, events: latest.events.slice(-EVENT_LIMIT), cacheTotals: entry.cacheTotals };
  }
  return { read, resolveRolloutPath: (id) => resolveRolloutPath(home, normalizeSessionId(id)) };
}

module.exports = {
  createUsageLiveReader,
  normalizeSessionId,
  resolveRolloutPath,
  readUsageTail,
  usageEvent,
};
