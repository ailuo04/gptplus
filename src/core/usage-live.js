'use strict';

// 与 Codex++ 的用量状态栏保持同一数据源：只读本机 Codex rollout 尾部，
// 不读取消息正文，也不把完整会话文件加载进内存。
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
  if (!DatabaseSync) return null;
  for (const dbPath of candidateDatabases(home)) {
    if (!fs.existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout=50'); } catch { /* best effort */ }
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?1 LIMIT 1').get(sessionId);
      const resolved = allowedRolloutPath(home, row?.rollout_path);
      if (resolved) return resolved;
    } catch {
      // 某个数据库正在迁移或 schema 不兼容时，继续查下一个。
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return null;
}

function resolveByScan(home, sessionId) {
  const roots = ['sessions', 'archived_sessions']
    .map((name) => path.join(home, name))
    .filter((root) => fs.existsSync(root));
  const queue = roots.map((root) => ({ root, depth: 0 }));
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
      if (resolved) return resolved;
    }
  }
  return null;
}

function resolveRolloutPath(home, sessionId) {
  return resolveFromDatabases(home, sessionId) || resolveByScan(home, sessionId);
}

function numberField(source, key) {
  const value = Number(source && source[key]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageEvent(record, turnId) {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') return null;
  const info = record.payload.info;
  const last = info?.last_token_usage;
  if (!last || typeof last !== 'object') return null;
  const event = {
    t: typeof record.timestamp === 'string' ? record.timestamp : '',
    input_tokens: numberField(last, 'input_tokens'),
    cached_input_tokens: numberField(last, 'cached_input_tokens'),
    output_tokens: numberField(last, 'output_tokens'),
    reasoning_output_tokens: numberField(last, 'reasoning_output_tokens'),
    total_tokens: numberField(last, 'total_tokens'),
    context_window: numberField(info, 'model_context_window'),
    turn_output_tokens: numberField(info?.total_token_usage, 'output_tokens'),
  };
  if (turnId) event.turn_id = turnId;
  if (!(event.input_tokens || event.output_tokens || event.total_tokens)) return null;
  return event;
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

    let currentTurnId = null;
    let segmentStart = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || (!line.includes('"event_msg"') && !line.includes('"turn_context"'))) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const type = record?.type;
      const payload = record?.payload || {};
      const eventType = payload.type;
      const turnId = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : null;

      if (type === 'turn_context') {
        if (turnId && currentTurnId !== turnId) {
          segmentStart = out.length;
          currentTurnId = turnId;
        }
        continue;
      }
      if (type !== 'event_msg') continue;
      if (eventType === 'task_started' || eventType === 'turn_started') {
        segmentStart = out.length;
        currentTurnId = turnId;
        continue;
      }
      if (['task_complete', 'turn_complete', 'turn_completed', 'task_failed', 'turn_aborted', 'task_aborted'].includes(eventType)) {
        if (turnId) {
          for (let index = segmentStart; index < out.length; index += 1) {
            if (!out[index].turn_id) out[index].turn_id = turnId;
          }
        }
        segmentStart = out.length;
        currentTurnId = null;
        continue;
      }
      const event = usageEvent(record, currentTurnId);
      if (event) out.push(event);
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

function unavailable(sessionId, message) {
  return { status: 'unavailable', session_id: sessionId, message, events: [] };
}

function createUsageLiveReader({ codexHome } = {}) {
  const home = path.resolve(String(codexHome || ''));
  const pathCache = new Map();
  function read(sessionId) {
    const id = normalizeSessionId(sessionId);
    if (!id) return unavailable('', '会话 ID 无效');
    let rollout = pathCache.get(id);
    if (!rollout || !fs.existsSync(rollout)) {
      rollout = resolveRolloutPath(home, id);
      if (rollout) pathCache.set(id, rollout);
    }
    if (!rollout) return unavailable(id, '未找到本机会话记录');
    try {
      return { status: 'ok', session_id: id, events: readUsageTail(rollout) };
    } catch (error) {
      return unavailable(id, `会话记录暂不可读: ${error.message}`);
    }
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
