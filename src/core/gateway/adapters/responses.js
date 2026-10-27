'use strict';
/**
 * OpenAI Responses 原生上游适配器（透传，spec 第 6 节）。
 *
 * 适用：本身就实现 POST {baseUrl}/responses 的上游（官方 api.openai.com、
 * 部分新一代中转）。与 openai 适配器（Responses -> chat/completions 转换）的
 * 区别：
 *   - buildRequest 不做协议翻译：请求体原样转发，只把 slug 改写成真实
 *     modelId（客户端不校验 model 回显，spec 第 6 节）；
 *   - 流式响应不走「内部事件」翻译，由 server 检测 `passthrough` 标记后
 *     逐字节转发上游 SSE（responses.js 的 pipeResponsesSse），保住
 *     encrypted reasoning、原生事件序列等转换会丢失的信息。多轮工具调用时
 *     客户端要回传上游给的 reasoning 项（store:false 场景），转换模式会
 *     把它们丢掉导致上游报错——这是透传模式存在的核心理由；
 *   - compat 重试（去掉可选参数重发）对透传无意义：网关没有注入任何
 *     可选参数，server 会跳过。
 */
const { joinApiUrl, parseSse, extractResponseText } = require('../responses.js');
const { buildHeaders } = require('./openai.js');

function buildRequest({ provider, modelId, body = {} }) {
  return {
    url: joinApiUrl(provider.baseUrl, '/responses'),
    headers: buildHeaders(provider),
    payload: { ...body, model: modelId },
  };
}

/** reasoning 项的思考文本：OpenAI 放在 summary，DeepSeek 放在 content。 */
function reasoningTextOf(item) {
  const collect = (parts) => {
    const out = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      if (typeof part === 'string') out.push(part);
      else if (part && typeof part.text === 'string') out.push(part.text);
    }
    return out.join('');
  };
  // content 是原始思考；summary 是它的摘要。两者都有时优先原文，避免拼接重复。
  return collect(item?.content) || collect(item?.summary);
}

function parseJson(json) {
  if (!json || !Array.isArray(json.output)) throw new Error('Responses 上游响应缺少 output 数组');
  if (json.error || json.status === 'failed') throw new Error(json.error?.message || 'Responses 上游失败');
  const reasoningItems = [];
  const toolCalls = [];
  for (const item of json.output) {
    if (item.type === 'reasoning') reasoningItems.push({
      text: reasoningTextOf(item),
      signature: item.encrypted_content || '',
    });
    else if (item.type === 'function_call') toolCalls.push({ id: item.call_id || item.id, name: item.name, arguments: item.arguments || '{}' });
    else if (item.type === 'custom_tool_call') toolCalls.push({ id: item.call_id || item.id, name: item.name, arguments: JSON.stringify({ input: item.input || '' }) });
  }
  return {
    text: extractResponseText(json.output),
    reasoning: reasoningItems.map((item) => item.text).join('\n'),
    reasoningItems, toolCalls, usage: json.usage || null,
    finishReason: json.status === 'incomplete' ? json.incomplete_details?.reason || 'max_output_tokens' : toolCalls.length ? 'tool_calls' : 'stop',
  };
}

async function* translate(upstream) {
  const states = new Map();
  let terminal = false;
  const stateFor = (id) => {
    if (!states.has(id)) states.set(id, { key: states.size, text: '', reasoning: '', args: '', started: false, done: false });
    return states.get(id);
  };
  function* finishItem(item) {
    const state = stateFor(item.id || item.call_id);
    if (state.done) return;
    if (item.type === 'message') {
      const text = extractResponseText([item]);
      if (text.length > state.text.length) yield { type: 'text', delta: text.slice(state.text.length) };
      yield { type: 'text_done' };
    } else if (item.type === 'reasoning') {
      const text = reasoningTextOf(item);
      if (text.length > state.reasoning.length) yield { type: 'reasoning', delta: text.slice(state.reasoning.length) };
      if (item.encrypted_content) yield { type: 'reasoning_signature', delta: item.encrypted_content };
      yield { type: 'reasoning_done' };
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (!state.started) yield { type: 'tool_start', key: state.key, id: item.call_id || item.id, name: item.name };
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input || '' }) : item.arguments || '{}';
      if (args.length > state.args.length) yield { type: 'tool_args', key: state.key, delta: args.slice(state.args.length) };
    }
    state.done = true;
  }
  for await (const frame of parseSse(upstream.body)) {
    if (!frame.data || frame.data.trim() === '[DONE]') continue;
    let event;
    try { event = JSON.parse(frame.data); } catch { throw new Error('Responses 上游包含无效 JSON SSE 帧'); }
    const type = event.type || frame.event;
    if (type === 'error' || type === 'response.failed') throw new Error(event.response?.error?.message || event.message || 'Responses 上游失败');
    const state = stateFor(event.item_id || event.item?.id || `index_${event.output_index ?? 0}`);
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      state.text += event.delta || '';
      yield { type: 'text', delta: event.delta || '' };
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = event.delta || '';
      if (delta) {
        state.reasoning += delta;
        yield { type: 'reasoning', delta };
      }
    } else if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
      // 只补发 delta 未覆盖的尾巴；正常流式到这里时两者长度相同。
      const text = typeof event.text === 'string' ? event.text : '';
      if (text.length > state.reasoning.length) {
        const delta = text.slice(state.reasoning.length);
        state.reasoning = text;
        yield { type: 'reasoning', delta };
      }
    } else if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      state.started = true;
      yield { type: 'tool_start', key: state.key, id: event.item.call_id || event.item.id, name: event.item.name };
    } else if (type === 'response.function_call_arguments.delta') {
      state.args += event.delta || '';
      yield { type: 'tool_args', key: state.key, delta: event.delta || '' };
    } else if (type === 'response.output_item.done' && event.item) {
      yield* finishItem(event.item);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      for (const item of event.response?.output || []) yield* finishItem(item);
      if (event.response?.usage) yield { type: 'usage', usage: event.response.usage };
      yield { type: 'finish', reason: type === 'response.incomplete' ? event.response?.incomplete_details?.reason || 'max_output_tokens' : 'stop' };
      terminal = true;
    } else if (type === 'response.cancelled') throw new Error('Responses 上游取消了响应');
  }
  if (!terminal) throw new Error('Responses stream ended before a terminal event');
}

function createResponsesAdapter() {
  return {
    name: 'responses',
    passthrough: true,
    endpoint: (provider) => joinApiUrl(provider.baseUrl, '/responses'),
    buildHeaders,
    buildRequest,
    parseJson,
    translate,
  };
}

module.exports = { createResponsesAdapter, buildRequest, parseJson, translate };
