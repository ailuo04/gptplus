'use strict';
/**
 * Responses API 流式契约（spec.md 第 6 节）+ 上游 SSE 解析工具。
 *
 * 本文件是网关里唯一负责「把内部事件翻译成 Responses SSE 报文」的地方，
 * 适配器只负责把各家上游的报文翻译成下面的**内部事件**：
 *
 *   { type: 'text',            delta }
 *   { type: 'reasoning',       delta }
 *   { type: 'tool_start',      id, name, key }
 *   { type: 'tool_args',       id, delta, key }
 *   { type: 'usage',           usage }          // 上游原始 usage（openai/anthropic 形状均可）
 *   { type: 'finish',          reason }
 *
 * ---------------------------------------------------------------------------
 * 取证依据（对本地 @openai/codex 0.159 的 codex.exe 二进制做字符串提取）：
 *
 *   1) 反序列化结构体 `ResponsesStreamEvent`（源码路径
 *      `codex-api\src\sse\responses.rs`）只有这些字段：
 *        type, headers, response, item, item_id, call_id, delta, text,
 *        summary_index, content_index, safety_buffering
 *      注意里面**没有** output_index / sequence_number，但也没有 deny_unknown_fields
 *      之类的痕迹，所以本文件额外携带的标准字段（sequence_number / output_index /
 *      status / annotations）会被 codex 当作未知字段忽略 —— 已用真实 codex 客户端
 *      实测通过（见完成说明里的 e2e 证据）。
 *
 *   2) codex 认得的 type 白名单（二进制里实际存在的字符串）：
 *        response.created / response.completed / response.failed / response.cancelled
 *        response.output_item.added / response.output_item.created / response.output_item.done
 *        response.output_text.delta / response.output_text.done
 *        response.reasoning_summary_part.added / response.reasoning_summary_part.done
 *        response.reasoning_summary_text.delta / response.reasoning_summary_text.done
 *        response.function_call_arguments.delta / response.function_call_arguments.done
 *        response.custom_tool_call_input.delta / response.custom_tool_call_input.done
 *        conversation.item.added / conversation.item.done
 *      无法识别的 type 走 `unhandled responses event: ` 分支被忽略（不会让整轮失败），
 *      所以 response.in_progress / response.content_part.added/done 这类官方形状的事件
 *      是安全的补充。
 *
 *   3) `response.completed` 的 response 字段对应 codex 的 `ResponseCompleted`（4 个字段：
 *      id / usage / usage_metadata / end_turn）。UNKNOWN：无法从二进制确认这几个字段
 *      是否必填；本实现写出 id + usage，并且**不**写 codex 专有的
 *      `codex_rollout_budget_units`（那是本地 rollout 预算，不是上游 API 字段）。
 *
 *   4) usage 形状按 codex 的 `ResponseCompletedUsage`（6 字段）：
 *        input_tokens, input_tokens_details{cached_tokens, cache_write_tokens},
 *        output_tokens, output_tokens_details{reasoning_tokens}, total_tokens,
 *        codex_rollout_budget_units(故意不写)
 */
const crypto = require('node:crypto');
const { ensureApiVersion } = require('../base-url.js');

const DONE_FRAME = 'data: [DONE]\n\n';
const MAX_BODY_BYTES = 32 * 1024 * 1024; // codex 的 instructions + 历史可能很大

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function newResponseId() {
  return `resp_${crypto.randomBytes(12).toString('hex')}`;
}

function newItemId(prefix) {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function asNumber(value, fallback = 0) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function hasCacheUsage(raw) {
  return !!(
    raw &&
    typeof raw === 'object' &&
    (raw.input_tokens_details?.cached_tokens != null ||
      raw.prompt_tokens_details?.cached_tokens != null ||
      raw.cache_read_input_tokens != null ||
      raw.prompt_cache_hit_tokens != null ||
      raw.cache_creation_input_tokens != null)
  );
}

/**
 * 把上游的 usage（OpenAI chat / Anthropic / Responses 形状）归一化成
 * codex 期望的 Responses usage 形状。
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = asNumber(raw.input_tokens ?? raw.prompt_tokens ??
    (raw.prompt_cache_miss_tokens != null ? asNumber(raw.prompt_cache_miss_tokens) + asNumber(raw.prompt_cache_hit_tokens) : undefined));
  const output = asNumber(raw.output_tokens ?? raw.completion_tokens);
  const cached = asNumber(
    raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens,
  );
  const cacheWrite = asNumber(
    raw.input_tokens_details?.cache_write_tokens ?? raw.cache_creation_input_tokens,
  );
  const reasoning = asNumber(
    raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens,
  );
  const total = asNumber(raw.total_tokens, input + output);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total || input + output,
  };
}

/**
 * 生成速度（tok/s）：输出 Token / 首段可见输出之后的耗时。
 * 分母排除首 Token 等待和思考阶段；拿不到首段计时时才退回整请求耗时。
 */
function generationSpeed(rawUsage, elapsedMs, firstTextMs) {
  const usage = normalizeUsage(rawUsage);
  const output = usage ? usage.output_tokens : 0;
  const totalMs = Number(elapsedMs);
  if (!(output > 0) || !(totalMs > 0)) return null;
  const first = Number(firstTextMs);
  const activeMs = Number.isFinite(first) && first > 0 && first < totalMs ? totalMs - first : totalMs;
  if (!(activeMs >= 50)) return null;
  return output / (activeMs / 1000);
}

/** 上游没给 usage 时的粗略估算（仅用于日志/展示，标注 estimated）。 */
function estimateUsage(body, outputText) {
  const chars = (value) => (typeof value === 'string' ? value.length : 0);
  let inputChars = chars(body?.instructions);
  const input = body?.input;
  if (typeof input === 'string') inputChars += input.length;
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') inputChars += item.length;
      else if (item && typeof item.content === 'string') inputChars += item.content.length;
      else if (item && Array.isArray(item.content)) {
        for (const part of item.content) inputChars += chars(part?.text) + chars(part?.output);
      } else inputChars += chars(item?.arguments) + chars(item?.output);
    }
  }
  const outChars = chars(outputText);
  const inputTokens = Math.max(1, Math.round(inputChars / 4));
  const outputTokens = Math.max(1, Math.round(outChars / 4));
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// SSE 写入
// ---------------------------------------------------------------------------

function sseFrame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function writeSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

/**
 * 把 Responses 事件流写进 HTTP 响应。
 * 只做「事件 -> SSE 帧」的搬运，序列号由 ResponsesStream 维护。
 */
class SseWriter {
  constructor(res, { namedEvents = true, doneFrame = true } = {}) {
    this.res = res;
    this.namedEvents = namedEvents;
    this.doneFrame = doneFrame;
    this.closed = false;
    // 客户端中途断开时，socket 层会异步在 res 上派发 'error'；没有监听器就是
    // unhandled error（try/catch 抓不到异步事件）。
    if (res && typeof res.on === 'function') res.on('error', () => {});
  }

  write(event) {
    if (this.closed) return;
    try {
      this.res.write(this.namedEvents ? sseFrame(event) : `data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.closed = true;
    }
  }

  comment(text) {
    if (this.closed) return;
    try {
      this.res.write(`: ${text}\n\n`);
    } catch {
      this.closed = true;
    }
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.doneFrame) this.res.write(DONE_FRAME);
    } catch {
      /* 客户端已断开 */
    }
    try {
      if (typeof this.res.end === 'function') this.res.end();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Responses 事件流状态机
// ---------------------------------------------------------------------------

/** response.created / response.in_progress 里带的 response 对象（官方形状）。 */
function responseEnvelope({ id, model, status, output, usage, createdAt, incompleteDetails = null }) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: incompleteDetails,
    instructions: null,
    max_output_tokens: null,
    model,
    output: output || [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: usage || null,
    metadata: {},
  };
}

/**
 * 内部事件 -> Responses SSE 事件序列。
 *
 * 完整序列（纯文本）：
 *   response.created
 *   response.in_progress
 *   response.output_item.added            (message, status=in_progress)
 *   response.content_part.added
 *   response.output_text.delta *          (逐 token)
 *   response.output_text.done
 *   response.content_part.done
 *   response.output_item.done             (message, status=completed)
 *   response.completed                     (response.output + usage)
 *   data: [DONE]
 */
class ResponsesStream {
  constructor({ res, model, responseId, createdAt }) {
    this.model = model;
    this.responseId = responseId || newResponseId();
    this.createdAt = createdAt || nowSeconds();
    this.writer = res instanceof SseWriter ? res : new SseWriter(res);
    this._seq = 0;
    this._outputIndex = 0;
    this._items = [];
    this._usage = null;
    this._usageEstimated = false;
    this._cacheUsageAvailable = false;
    this._finished = false;
    this._text = null;
    this._reasoning = null;
    this._tools = new Map();
    this._emitted = [];
  }

  /** 便于测试/日志：实际发出的 type 序列。 */
  get emittedTypes() {
    return this._emitted.slice();
  }

  get usage() {
    return this._usage;
  }

  get usageEstimated() {
    return this._usageEstimated;
  }

  get cacheUsageAvailable() {
    return this._cacheUsageAvailable;
  }

  get text() {
    return this._items.filter((entry) => entry.item.type === 'message')
      .map((entry) => extractResponseText([entry.item])).join('') + (this._text?.text || '');
  }

  get reasoningText() {
    return this._reasoning ? this._reasoning.text : '';
  }

  _send(type, extra) {
    const event = { type, sequence_number: this._seq++, ...extra };
    this._emitted.push(type);
    this.writer.write(event);
    return event;
  }

  _nextOutputIndex() {
    return this._outputIndex++;
  }

  start() {
    const base = { id: this.responseId, model: this.model, createdAt: this.createdAt };
    this._send('response.created', {
      response: responseEnvelope({ ...base, status: 'in_progress', output: [], usage: null }),
    });
    // codex 未识别 response.in_progress（走 unhandled 分支），但官方客户端依赖它。
    this._send('response.in_progress', {
      response: responseEnvelope({ ...base, status: 'in_progress', output: [], usage: null }),
    });
    return this;
  }

  // ---- 文本 ----

  _ensureTextItem() {
    if (this._text) return this._text;
    // 同一时刻只允许一个未完成的输出项（与官方流一致）：
    // 上游先吐 reasoning 再吐 content 时，先把 reasoning 项收口。
    this.reasoningDone();
    const item = {
      id: newItemId('msg_'),
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    };
    const outputIndex = this._nextOutputIndex();
    this._text = { item, outputIndex, text: '' };
    this._send('response.output_item.added', { output_index: outputIndex, item });
    this._send('response.content_part.added', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    return this._text;
  }

  textDelta(delta) {
    if (!delta) return;
    const state = this._ensureTextItem();
    state.text += delta;
    this._send('response.output_text.delta', {
      item_id: state.item.id,
      output_index: state.outputIndex,
      content_index: 0,
      delta,
    });
  }

  textDone() {
    if (!this._text) return;
    const { item, outputIndex, text } = this._text;
    this._send('response.output_text.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    this._send('response.content_part.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    const finalItem = {
      id: item.id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    this._send('response.output_item.done', { output_index: outputIndex, item: finalItem });
    this._items.push({ outputIndex, item: finalItem });
    this._text = null;
  }

  // ---- reasoning（思考摘要）----

  _ensureReasoningItem() {
    if (this._reasoning) return this._reasoning;
    const item = { id: newItemId('rs_'), type: 'reasoning', summary: [] };
    const outputIndex = this._nextOutputIndex();
    this._reasoning = { item, outputIndex, text: '' };
    this._send('response.output_item.added', { output_index: outputIndex, item });
    this._send('response.reasoning_summary_part.added', {
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    return this._reasoning;
  }

  reasoningDelta(delta) {
    if (!delta) return;
    const state = this._ensureReasoningItem();
    state.text += delta;
    this._send('response.reasoning_summary_text.delta', {
      item_id: state.item.id,
      output_index: state.outputIndex,
      summary_index: 0,
      delta,
    });
  }

  reasoningSignature(delta) {
    if (!delta) return;
    const state = this._ensureReasoningItem();
    state.signature = (state.signature || '') + delta;
  }

  reasoningDone() {
    if (!this._reasoning) return;
    const { item, outputIndex, text, signature } = this._reasoning;
    this._send('response.reasoning_summary_text.done', {
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      text,
    });
    this._send('response.reasoning_summary_part.done', {
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text },
    });
    const finalItem = {
      id: item.id,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text }],
      ...(signature ? { encrypted_content: signature } : {}),
      // codex 的 ReasoningItem 有 3 个字段（id/summary/content），
      // content 一并给出空数组，避免非 Option 字段缺失。
      content: [],
    };
    this._send('response.output_item.done', { output_index: outputIndex, item: finalItem });
    this._items.push({ outputIndex, item: finalItem });
    this._reasoning = null;
  }

  // ---- function call ----

  _tool(key) {
    let state = this._tools.get(key);
    if (!state) {
      state = {
        key,
        id: newItemId('fc_'),
        name: '',
        args: '',
        outputIndex: this._nextOutputIndex(),
        open: false,
      };
      this._tools.set(key, state);
    }
    return state;
  }

  /** 有些中转会分片补 name，所以拿到 name 之前先缓冲参数，不急着 added。 */
  _flushTool(state) {
    if (state.open || !state.name) return;
    // 工具调用开始前先收口前面打开的 reasoning / message 项。
    this.reasoningDone();
    this.textDone();
    state.open = true;
    const item = {
      id: state.id,
      type: 'function_call',
      status: 'in_progress',
      name: state.name,
      arguments: '',
      call_id: state.callId || state.id,
    };
    this._send('response.output_item.added', { output_index: state.outputIndex, item });
    if (state.args) {
      this._send('response.function_call_arguments.delta', {
        item_id: state.id,
        output_index: state.outputIndex,
        call_id: state.callId || state.id,
        delta: state.args,
      });
    }
  }

  toolStart({ key, id, name }) {
    const state = this._tool(key);
    if (id && !state.callId) state.callId = id;
    if (name) state.name = name;
    this._flushTool(state);
    return state;
  }

  toolArgsDelta({ key, delta }) {
    if (!delta) return;
    const state = this._tool(key);
    state.args += delta;
    if (state.open) {
      this._send('response.function_call_arguments.delta', {
        item_id: state.id,
        output_index: state.outputIndex,
        call_id: state.callId || state.id,
        delta,
      });
    }
    return state;
  }

  _closeTool(state) {
    this._flushTool(state);
    const callId = state.callId || state.id;
    this._send('response.function_call_arguments.done', {
      item_id: state.id,
      output_index: state.outputIndex,
      call_id: callId,
      arguments: state.args,
    });
    const finalItem = {
      id: state.id,
      type: 'function_call',
      status: 'completed',
      name: state.name,
      arguments: state.args,
      call_id: callId,
    };
    this._send('response.output_item.done', { output_index: state.outputIndex, item: finalItem });
    this._items.push({ outputIndex: state.outputIndex, item: finalItem });
  }

  setUsage(rawUsage) {
    if (hasCacheUsage(rawUsage)) this._cacheUsageAvailable = true;
    const normalized = normalizeUsage(rawUsage);
    if (normalized) this._usage = normalized;
    return normalized;
  }

  /** 收尾：关掉所有打开的输出项 -> response.completed -> [DONE]。 */
  complete({ usage, requestBody, finishReason } = {}) {
    if (this._finished) return this;
    this._finished = true;
    const outputText = this.text;
    if (usage) this.setUsage(usage);
    const pending = [];
    if (this._reasoning) pending.push({ kind: 'reasoning', outputIndex: this._reasoning.outputIndex });
    if (this._text) pending.push({ kind: 'text', outputIndex: this._text.outputIndex });
    for (const state of this._tools.values()) {
      if (state.open || state.args || state.name) {
        pending.push({ kind: 'tool', outputIndex: state.outputIndex, state });
      }
    }
    pending.sort((a, b) => a.outputIndex - b.outputIndex);
    for (const entry of pending) {
      if (entry.kind === 'reasoning') this.reasoningDone();
      else if (entry.kind === 'text') this.textDone();
      else this._closeTool(entry.state);
    }

    if (!this._usage) {
      this._usage = estimateUsage(requestBody, outputText);
      this._usageEstimated = true;
    }
    const output = this._items
      .slice()
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((entry) => entry.item);
    if (!output.length) {
      // 上游返回空内容（例如只有 finish_reason）：补一个空 message，避免客户端拿到空 output
      output.push({
        id: newItemId('msg_'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      });
    }
    const incomplete = ['max_tokens', 'max_output_tokens', 'length', 'content_filter'].includes(String(finishReason || '').toLowerCase());
    const incompleteReason = finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens';
    const responseStatus = incomplete ? 'incomplete' : 'completed';
    this._send(incomplete ? 'response.incomplete' : 'response.completed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: responseStatus,
        incomplete_details: incomplete ? { reason: incompleteReason } : null,
        model: this.model,
        output,
        usage: this._usage,
      },
    });
    this.writer.end();
    return this;
  }

  /** 已经开流之后才失败：用 response.failed 收口（HTTP 状态码已经发出去了）。 */
  fail(message) {
    if (this._finished) return this;
    this._finished = true;
    this._send('response.failed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'failed',
        model: this.model,
        output: [],
        usage: this._usage,
        error: { code: 'upstream_error', message: String(message || 'upstream error') },
      },
    });
    this.writer.end();
    return this;
  }

  cancel() {
    if (this._finished) return this;
    this._finished = true;
    this._send('response.cancelled', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'cancelled',
        model: this.model,
        output: [],
      },
    });
    this.writer.end();
    return this;
  }
}

// ---------------------------------------------------------------------------
// 非流式（stream:false）响应体
// ---------------------------------------------------------------------------

function buildResponseObject({ id, model, createdAt, text, reasoning, reasoningSignature, reasoningItems, toolCalls, usage, requestBody, status, finishReason }) {
  const output = [];
  if (Array.isArray(reasoningItems) && reasoningItems.length) {
    for (const entry of reasoningItems) {
      if (!entry?.text && !entry?.signature) continue;
      output.push({
        id: newItemId('rs_'),
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: entry.text || '' }],
        ...(entry.signature ? { encrypted_content: entry.signature } : {}),
        content: [],
      });
    }
  } else if (reasoning || reasoningSignature) {
    output.push({
      id: newItemId('rs_'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
      ...(reasoningSignature ? { encrypted_content: reasoningSignature } : {}),
      content: [],
    });
  }
  output.push({
    id: newItemId('msg_'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: text || '', annotations: [] }],
  });
  for (const call of toolCalls || []) {
    output.push({
      id: newItemId('fc_'),
      type: 'function_call',
      status: 'completed',
      name: call.name,
      arguments: call.arguments || '',
      call_id: call.id || newItemId('call_'),
    });
  }
  const incomplete = ['max_tokens', 'max_output_tokens', 'length', 'content_filter'].includes(String(finishReason || '').toLowerCase());
  return responseEnvelope({
    id: id || newResponseId(),
    model,
    status: status || (incomplete ? 'incomplete' : 'completed'),
    incompleteDetails: incomplete ? { reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } : null,
    output,
    usage: normalizeUsage(usage) || estimateUsage(requestBody, text),
    createdAt: createdAt || nowSeconds(),
  });
}

// ---------------------------------------------------------------------------
// 上游 SSE 解析（OpenAI chat / Anthropic messages 都用它）
// ---------------------------------------------------------------------------

/**
 * 解析 UTF-8 SSE 字节流，产出 { event, data }。
 * @param {AsyncIterable<Uint8Array|string>} body
 */
async function* parseSse(body) {
  if (!body) return;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = null;
  let dataLines = [];

  const flush = (line) => {
    if (line === '') {
      if (dataLines.length === 0 && eventName === null) return null;
      const payload = { event: eventName, data: dataLines.join('\n') };
      eventName = null;
      dataLines = [];
      return payload;
    }
    if (line.startsWith(':')) return null; // 注释/心跳
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    return null;
  };

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      const payload = flush(line);
      if (payload) yield payload;
    }
  }
  if (buffer) {
    const payload = flush(buffer.replace(/\r$/, ''));
    if (payload) yield payload;
  }
  const tail = flush('');
  if (tail) yield tail;
}

/** 读取上游响应体（错误分支用），带长度上限。 */
async function readBodyText(upstream, limit = 64 * 1024) {
  try {
    const text = await upstream.text();
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 上游 Responses SSE 透传管道（responses 适配器专用）
// ---------------------------------------------------------------------------

/**
 * 把上游 Responses SSE 逐字节转发给客户端（passthrough 模式）。
 *
 * 转发是字节级的：encrypted reasoning、原生事件序列等不经过重建，客户端看到
 * 的就是上游发出的原文。同时旁路解析完整帧，仅用于网关日志（usage / response
 * id / 失败事件）；解析出任何问题都不影响转发本身。
 *
 * @param {{body: AsyncIterable<Uint8Array>}} upstream fetch 响应
 * @param {import('node:http').ServerResponse} res SSE 头已写出的响应
 * @param {{usage: any, responseId: string|null, events: number,
 *          completed: boolean, failed: {message: string}|null}} out 调用方创建的结果袋；中途抛错时
 *   调用方仍能读到已解析到的字段（sendResponsesFailure 要用 responseId）
 */
async function pipeResponsesSse(upstream, res, out) {
  // 客户端断开后 res.write 会异步派发 'error'；没有监听器就是 unhandled error。
  // 这里挂一个空监听并把写入包起来，让转发循环能干净地停下来。
  res.on('error', () => {});
  const writable = () => !res.destroyed && !res.writableEnded;
  const write = (chunk) => {
    if (!writable()) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  if (!upstream || !upstream.body) {
    // undici fetch 总有 body；这只为极端运行时兜底：整读整发，不再逐帧
    const text = await upstream.text();
    write(Buffer.from(text));
    out.events = 1;
    try {
      const json = JSON.parse(text);
      out.responseId = (json && json.response && json.response.id) || json?.id || null;
      out.usage = (json && json.response && json.response.usage) || json?.usage || null;
    } catch {
      /* 保持原文转发 */
    }
    return;
  }
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = null;
  let dataLines = [];
  const handleFrame = () => {
    const data = dataLines.join('\n');
    dataLines = [];
    const evt = eventName;
    eventName = null;
    if (!data) return;
    let json = null;
    try {
      json = JSON.parse(data);
    } catch {
      return; // [DONE] 等非 JSON 载荷
    }
    out.events += 1;
    const type = json?.type || evt;
    if (!out.firstTextAt && (
      (type === 'response.output_text.delta' && typeof json?.delta === 'string' && json.delta)
      || (type === 'response.output_text.done' && typeof json?.text === 'string' && json.text)
      || (type === 'response.function_call_arguments.delta' && typeof json?.delta === 'string' && json.delta)
      || (type === 'response.output_item.added'
        && (json?.item?.type === 'function_call' || json?.item?.type === 'custom_tool_call'))
    )) out.firstTextAt = Date.now();
    if (type === 'response.created' || type === 'response.in_progress') {
      if (!out.responseId && json?.response?.id) out.responseId = json.response.id;
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.cancelled') {
      out.completed = true;
      out.usage = json?.response?.usage || null;
      out.outputText = extractResponseText(json?.response?.output);
      out.toolCalls = countLoopToolItems(json?.response?.output);
    } else if (type === 'response.failed') {
      const err = json?.response?.error;
      out.failed = { message: (err && err.message) || '上游返回 response.failed' };
    } else if (type === 'error') {
      out.failed = { message: json?.message || '上游返回 error 事件' };
    }
  };
  const handleLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') handleFrame();
    else if (line.startsWith(':')) return; // 注释/心跳
    else {
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
  };
  for await (const chunk of upstream.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!write(buf)) return;
    buffer += decoder.decode(buf, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    handleLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
  }
  if (buffer) handleLine(buffer); // 尾帧可能没有结束空行
  handleFrame();
}

/** 从原生 Responses 完成响应中提取可用于 usage 兜底估算的文本。 */
function extractResponseText(output) {
  if (!Array.isArray(output)) return '';
  return output.flatMap((item) => {
    // reasoning 项的 content 是 reasoning_text（DeepSeek 等），不能混进可见回答。
    if (!item || item.type === 'reasoning' || !Array.isArray(item.content)) return [];
    return item.content.map((part) => part && (part.text || part.refusal)).filter(Boolean);
  }).join('');
}

/**
 * 统计响应里需要客户端回灌结果的工具调用（function_call / custom_tool_call /
 * local_shell_call 等）。web_search_call / file_search_call 属于服务端工具，
 * 客户端不会为它们再发一轮请求，不算「任务还在进行」的信号。
 */
function countLoopToolItems(output) {
  if (!Array.isArray(output)) return 0;
  let count = 0;
  for (const item of output) {
    const type = String((item && item.type) || '');
    if (!type.endsWith('_call')) continue;
    if (type === 'web_search_call' || type === 'file_search_call') continue;
    count += 1;
  }
  return count;
}

/**
 * 透传模式中途失败时给客户端一个协议内的收口（headers 已发出，HTTP 状态码
 * 改不了）。responseId 尽量沿用上游 response.created 里的 id，让客户端把失败
 * 归到同一个响应上。
 */
function sendResponsesFailure(res, { responseId, message } = {}) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    res.write(
      sseFrame({
        type: 'response.failed',
        response: {
          id: responseId || newResponseId(),
          object: 'response',
          created_at: nowSeconds(),
          status: 'failed',
          output: [],
          usage: null,
          error: { code: 'upstream_error', message: String(message || 'upstream error') },
        },
      }),
    );
  } catch {
    /* 客户端已断开 */
  }
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

/** 从上游错误体里抠出一句人能看懂的 message。 */
function extractErrorMessage(text, fallback) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const json = JSON.parse(raw);
    const msg = json?.error?.message || json?.error?.error?.message || json?.message || json?.error;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    /* 不是 JSON，直接用原文 */
  }
  return raw.length > 500 ? raw.slice(0, 500) + '…' : raw;
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

/**
 * 拼上游 URL：规则见 core/base-url.js（与 ipc.js 的 sanitizeProviderInput 共用）。
 */
function joinApiUrl(baseUrl, path) {
  const base = ensureApiVersion(baseUrl);
  if (!base) throw new Error('提供商 Base URL 为空');
  return base + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * 工具参数 JSON Schema 清洗。
 *
 * 1) 递归去掉值为 null 的关键字。Codex 的内建工具（list_mcp_resources 等）没有必填参数时，
 *    客户端会把 `required` 序列化成 null。
 * 2) 补齐顶层的 type / properties / required。严格的 OpenAI 兼容上游（例如内部再做
 *    chat -> anthropic 转换的中转）会把缺失的 properties / required 当成 null 处理，
 *    再按 JSON Schema 元模式校验就整轮 400：
 *    `Invalid schema for function 'x': null is not of type "array"`。
 *    OpenAI 直连对这两种姿势都容忍，所以只有走中转时才暴露。
 *
 * 数组元素里的 null（如 enum 的取值）是数据不是关键字，保留不动。
 */
function sanitizeToolSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeToolSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === null) continue;
    out[key] = sanitizeToolSchema(value);
  }
  return out;
}

/** 工具 parameters -> 合法的对象 schema。 */
function toolParameters(parameters) {
  const clean = sanitizeToolSchema(parameters);
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) {
    return { type: 'object', properties: {}, required: [] };
  }
  if (clean.type !== 'object') {
    // 函数入参按契约只能是对象；非对象顶层 schema 上游同样会拒。
    clean.type = 'object';
    clean.properties = {};
  } else if (!clean.properties || typeof clean.properties !== 'object' || Array.isArray(clean.properties)) {
    clean.properties = {};
  }
  if (!Array.isArray(clean.required)) clean.required = [];
  return clean;
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message: String(message), type } });
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(Object.assign(new Error('客户端中断请求'), { statusCode: 499 })));
  });
}

module.exports = {
  DONE_FRAME,
  MAX_BODY_BYTES,
  SseWriter,
  ResponsesStream,
  buildResponseObject,
  countLoopToolItems,
  estimateUsage,
  extractErrorMessage,
  extractResponseText,
  generationSpeed,
  joinApiUrl,
  newItemId,
  newResponseId,
  normalizeUsage,
  hasCacheUsage,
  nowSeconds,
  parseSse,
  pipeResponsesSse,
  readBodyText,
  readJsonBody,
  responseEnvelope,
  sendError,
  sendJson,
  sendResponsesFailure,
  sseFrame,
  toolParameters,
  writeSseHeaders,
};
