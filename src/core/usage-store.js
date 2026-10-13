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

function createUsageStore({ usagePath } = {}) {
  if (!usagePath || typeof usagePath !== 'string') throw new Error('createUsageStore 需要 usagePath');

  /** @type {any[]} */
  let entries = [];
  const ids = new Set();

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
      return all();
    }
    entries = [];
    ids.clear();
    for (const record of parseLines(text)) add(record, false);
    entries.sort((a, b) => Number(a.at) - Number(b.at));
    return all();
  }

  /** 从旧版 gateway.log 补齐请求级记录，重复项按 requestId 去重。 */
  function importLogs(logs) {
    let added = 0;
    for (const entry of Array.isArray(logs) ? logs : []) if (add(entry, true)) added += 1;
    if (added) entries.sort((a, b) => Number(a.at) - Number(b.at));
    return added;
  }

  function append(record) {
    add(record, true);
    return record;
  }

  function all() {
    return entries.slice();
  }

  return { load, importLogs, append, all, usagePath };
}

module.exports = { createUsageStore, isUsageRecord, toUsageRecord };
