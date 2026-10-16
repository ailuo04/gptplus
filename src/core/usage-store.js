'use strict';

// 请求级使用量持久化：一条网关请求只保留一条终结记录，避免原始日志事件挤掉统计数据。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function isUsageRecord(entry) {
  if (!entry || typeof entry !== 'object' || !Number.isFinite(Number(entry.at))) return false;
  const status = Number(entry.status);
  if (!Number.isFinite(status) || status <= 0) return false;
  if (entry.final === true || entry.usageRecord === true) return true;
  const message = String(entry.msg || '');
  if (/^(开始请求|上游返回 HTTP|上游拒绝可选参数|请求异常:)/.test(message)) return false;
  if (status === 200) return message.startsWith('完成 ') || !!entry.tokens || !message;
  return message.startsWith('客户端中断:') || message.startsWith('流式转发失败:') ||
    message.startsWith('上游请求失败:') || message.startsWith('上游返回失败事件:');
}

function legacyRequestId(entry) {
  const stable = [
    entry.at,
    entry.providerId,
    entry.providerName,
    entry.model,
    entry.upstreamModel,
    entry.status,
    entry.ms,
    entry.msg,
    JSON.stringify(entry.tokens || null),
  ].join('\u001f');
  return `legacy_${crypto.createHash('sha1').update(stable).digest('hex')}`;
}

function toUsageRecord(entry) {
  if (!isUsageRecord(entry)) return null;
  return {
    ...entry,
    at: Number(entry.at),
    requestId: String(entry.requestId || legacyRequestId(entry)),
    usageRecord: true,
  };
}

function createUsageStore({ usagePath, trendPath } = {}) {
  if (!usagePath || typeof usagePath !== 'string') throw new Error('createUsageStore 需要 usagePath');
  const resolvedTrendPath = typeof trendPath === 'string' && trendPath ? trendPath : `${usagePath}.trend.json`;

  /** @type {any[]} */
  let entries = [];
  const ids = new Set();
  let trend = new Map();

  function localDayKey(at) {
    const date = new Date(Number(at));
    if (!Number.isFinite(date.getTime())) return null;
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function tokenCount(entry) {
    const usage = entry?.tokens && typeof entry.tokens === 'object' ? entry.tokens : {};
    const total = Number(usage.total_tokens);
    if (Number.isFinite(total) && total >= 0) return total;
    const input = Number(usage.input_tokens ?? usage.prompt_tokens);
    const output = Number(usage.output_tokens ?? usage.completion_tokens);
    return (Number.isFinite(input) && input > 0 ? input : 0) + (Number.isFinite(output) && output > 0 ? output : 0);
  }

  function addToTrend(entry) {
    const day = localDayKey(entry?.at);
    if (!day) return;
    const current = trend.get(day) || { day, tokens: 0, requests: 0 };
    current.tokens += tokenCount(entry);
    current.requests += 1;
    trend.set(day, current);
  }

  function trendRows() {
    return [...trend.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((row) => ({ day: row.day, tokens: row.tokens, requests: row.requests }));
  }

  function persistTrend() {
    try {
      fs.mkdirSync(path.dirname(resolvedTrendPath), { recursive: true });
      fs.writeFileSync(resolvedTrendPath, JSON.stringify(trendRows()) + '\n', 'utf8');
    } catch {
      // 趋势落盘失败不应阻塞网关请求；明细记录仍然保留。
    }
  }

  function loadTrend() {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolvedTrendPath, 'utf8'));
      trend = new Map();
      for (const row of Array.isArray(parsed) ? parsed : []) {
        const day = String(row?.day || '');
        const tokens = Number(row?.tokens);
        const requests = Number(row?.requests);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(tokens) && Number.isFinite(requests)) {
          trend.set(day, { day, tokens: Math.max(0, tokens), requests: Math.max(0, requests) });
        }
      }
      return trend.size > 0 || Array.isArray(parsed);
    } catch {
      return false;
    }
  }

  function parseLines(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = toUsageRecord(JSON.parse(trimmed));
        if (record) out.push(record);
      } catch {
        // 进程被强杀时最后半行可能不完整，只丢这一行。
      }
    }
    return out;
  }

  function add(record, persist) {
    const normalized = toUsageRecord(record);
    if (!normalized || ids.has(normalized.requestId)) return false;
    ids.add(normalized.requestId);
    entries.push(normalized);
    if (persist) {
      try {
        fs.mkdirSync(path.dirname(usagePath), { recursive: true });
        fs.appendFileSync(usagePath, JSON.stringify(normalized) + '\n', 'utf8');
      } catch {
        // 统计落盘失败不应阻塞网关请求；下次可由原始日志重新迁移。
      }
    }
    return true;
  }

  function load() {
    let text = '';
    try {
      text = fs.readFileSync(usagePath, 'utf8');
    } catch {
      entries = [];
      ids.clear();
      if (!loadTrend()) trend = new Map();
      return all();
    }
    entries = [];
    ids.clear();
    for (const record of parseLines(text)) add(record, false);
    entries.sort((a, b) => Number(a.at) - Number(b.at));
    if (!loadTrend()) {
      trend = new Map();
      for (const record of entries) addToTrend(record);
      persistTrend();
    }
    return all();
  }

  /** 从旧版 gateway.log 补齐请求级记录，重复项按 requestId 去重。 */
  function importLogs(logs) {
    let added = 0;
    for (const entry of Array.isArray(logs) ? logs : []) {
      if (add(entry, true)) {
        addToTrend(toUsageRecord(entry));
        added += 1;
      }
    }
    if (added) persistTrend();
    if (added) entries.sort((a, b) => Number(a.at) - Number(b.at));
    return added;
  }

  function append(record) {
    if (add(record, true)) {
      addToTrend(toUsageRecord(record));
      persistTrend();
    }
    return record;
  }

  function all() {
    return entries.slice();
  }

  function clear({ preserveTrend = false } = {}) {
    entries = [];
    ids.clear();
    if (!preserveTrend) trend = new Map();
    try {
      fs.mkdirSync(path.dirname(usagePath), { recursive: true });
      fs.writeFileSync(usagePath, '', 'utf8');
    } catch {
      // 清理失败保持进程可用，由调用方把错误反馈给用户。
    }
    if (preserveTrend) persistTrend();
    else {
      try { fs.rmSync(resolvedTrendPath, { force: true }); } catch { /* ignore */ }
    }
    return true;
  }

  return { load, importLogs, append, all, trend: trendRows, clear, usagePath, trendPath: resolvedTrendPath };
}

module.exports = { createUsageStore, isUsageRecord, toUsageRecord };
