'use strict';
// 网关日志的持久化环形缓冲：JSONL 逐条追加 + 启动时回放。
// 使用量页的数据源就是这个环。之前只写不读，每次重启后统计都会清零。

const fs = require('node:fs');
const path = require('node:path');

/** 环形上限，同时也是磁盘上保留的条数。旧值 200 一天就会被请求挤满。 */
const LOG_RING_SIZE = 20000;
/** 启动时最多读这么多字节：超过只读尾部，避免累积几年的文件卡住启动 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {{ logPath: string, maxEntries?: number, maxBytes?: number }} opts
 */
function createLogStore({ logPath, maxEntries = LOG_RING_SIZE, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!logPath || typeof logPath !== 'string') {
    throw new Error('createLogStore 需要 logPath');
  }

  /** @type {any[]} */
  let entries = [];

  function parseLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      /** @type {any} */
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // 进程被强杀时最后半行会留在盘上，丢掉这一行而不是放弃整份历史
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (!Number.isFinite(Number(parsed.at))) continue;
      out.push({ ...parsed, at: Number(parsed.at) });
    }
    return out;
  }

  /** 整体读或只读尾部。读尾部时切片点大概率落在半行中间，丢掉首个残段。 */
  function readText() {
    const size = fs.statSync(logPath).size;
    if (size <= maxBytes) return { text: fs.readFileSync(logPath, 'utf8'), size, truncated: false };
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      const nl = buf.indexOf(0x0a);
      return { text: buf.subarray(nl < 0 ? maxBytes : nl + 1).toString('utf8'), size, truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 原子重写：先写临时文件再 rename，避免压缩中途崩溃把历史清空 */
  function compact() {
    const text = entries.length ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
    const tmp = `${logPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, logPath);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 回放磁盘历史。必须在任何 append 之前调用，否则内存环与磁盘会错位。
   * @returns {any[]} 时间升序
   */
  function load() {
    let text = '';
    let size = 0;
    let truncated = false;
    try {
      ({ text, size, truncated } = readText());
    } catch {
      // 文件不存在（首次运行）或读不了：从空历史开始，不影响启动
      entries = [];
      return all();
    }
    const parsed = parseLines(text);
    entries = parsed.length > maxEntries ? parsed.slice(-maxEntries) : parsed;
    if (truncated || size > maxBytes || parsed.length > entries.length) compact();
    return all();
  }

  /** 追加一条：先入环再落盘，环满则丢最旧。 */
  function append(entry) {
    entries.push(entry);
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
    try {
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* 落盘失败不影响网关请求 */
    }
    return entry;
  }

  /** @returns {any[]} 浅拷贝，调用方改不坏内部状态 */
  function all() {
    return entries.slice();
  }

  return { load, append, all, logPath, maxEntries, maxBytes };
}

module.exports = { createLogStore, LOG_RING_SIZE, DEFAULT_MAX_BYTES };
