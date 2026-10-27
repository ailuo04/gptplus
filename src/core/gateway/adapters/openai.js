'use strict';
/**
 * OpenAI 兼容上游适配器（spec 第 6 节 + task-2）。
 *
 * 职责划分：
 *   - buildRequest: Responses 请求体 -> `POST {baseUrl}/chat/completions`
 *     （绝大多数"OpenAI 兼容中转"只实现 chat/completions，不一定实现 /responses）
 *   - translate:    上游 chat SSE 分片 -> responses.js 定义的内部事件
 *   - parseJson:    非流式（stream:false）的 chat 响应 -> 内部结果
 *
 * 只有纯文本路径是 100% 验证过的；tools/function_call 走的是同一套内部事件，
 * 已按 OpenAI chat 的 tool_calls 分片语义实现（含 name 分片补齐的缓冲）。
 */
const { joinApiUrl, parseSse, toolParameters } = require('../responses.js');

const DEFAULT_MAX_TOKENS = 8192;

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/** provider.headers 先铺，再补默认头（用户自定义优先）。 */
function buildHeaders(provider) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const [key, value] of Object.entries(provider.headers || {})) {
    if (!key) continue;
    headers[key] = String(value ?? '');
  }
  // task-2 明确要求：openai 适配器发 Authorization: Bearer <apiKey>
  if (provider.apiKey && !hasHeader(headers, 'authorization')) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const part of content) {
    if (typeof part === 'string') texts.push(part);
    else if (part && typeof part.text === 'string') texts.push(part.text);
    else if (part && typeof part.refusal === 'string') texts.push(part.refusal);
  }
  return texts.join('');
}

/** Responses 的 content 数组 -> chat 的 content（字符串或 parts 数组）。 */
function contentToChat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!part) continue;
    if (['input_audio', 'input_video', 'input_file'].includes(part.type)) {
      throw Object.assign(new Error(`Chat 转换不支持 ${part.type}`), { statusCode: 400 });
    }
    switch (part.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        parts.push({ type: 'text', text: String(part.text ?? '') });
        break;
      case 'refusal':
        parts.push({ type: 'text', text: String(part.refusal ?? '') });
        break;
      case 'input_image':
      case 'image_url': {
        const image = part.image_url;
        const url = (image && typeof image === 'object' ? image.url : image) || part.url || '';
        if (typeof url === 'string' && url) parts.push({ type: 'image_url', image_url: { url } });
        break;
      }
      default:
        if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
        break;
    }
  }
  if (!parts.length) return '';
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('');
  return parts;
}

function stringifyOutput(output) {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function pushAssistantToolCall(messages, call) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) {
    last.tool_calls.push(call);
    return;
  }
  messages.push({ role: 'assistant', content: null, tool_calls: [call] });
}

/**
 * 合并连续的 assistant 消息。
 *
 * Responses 的一轮助手输出是 reasoning + message(文本) + function_call 三个独立条目，
 * 逐条转换会得到两条连续的 assistant 消息（一条纯文本、一条只带 tool_calls）。OpenAI 直连
 * 能收，但 Anthropic 系上游（含内部再转 Anthropic 的中转）要求一个 assistant 轮只出现一次，
 * 开启 thinking 时会整轮 400：`The content[].thinking in the thinking mode must be passed
 * back to the API.`。合并成一条 content + tool_calls 才是 chat 的标准形状。
 */
function mergeAssistantTurns(messages) {
  const out = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (!last || last.role !== 'assistant' || message.role !== 'assistant'
      || Array.isArray(last.content) || Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const text = [last.content, message.content].filter((c) => typeof c === 'string' && c).join('');
    last.content = text || null;
    const thinking = [last.reasoning_content, message.reasoning_content].filter((c) => typeof c === 'string' && c).join('\n');
    if (thinking) last.reasoning_content = thinking;
    if (Array.isArray(message.tool_calls)) {
      last.tool_calls = [...(last.tool_calls || []), ...message.tool_calls];
    }
  }
  return out;
}

/**
 * 追加一条 system 消息：与上一条 system 合并。
 * 真实 codex 流量里 instructions(21k 系统提示词) 后面紧跟 role=developer 的
 * skills/environment 消息，直接发两条 system 会被部分中转嫌弃，合并最稳。
 */
function pushSystemMessage(messages, text) {
  if (!text) return;
  const last = messages[messages.length - 1];
  if (last && last.role === 'system') {
    last.content = `${last.content}\n\n${text}`;
    return;
  }
  messages.push({ role: 'system', content: text });
}

/** reasoning 项里的思考文本（Codex 回传时放在 summary，个别上游放在 content）。 */
function thinkingText(item) {
  const parts = [];
  for (const key of ['summary', 'content']) {
    if (!Array.isArray(item[key])) continue;
    for (const part of item[key]) {
      const text = typeof part === 'string' ? part : part && part.text;
      if (text) parts.push(text);
    }
  }
  return parts.join('');
}

/**
 * Responses 的 input（字符串 / item 数组）-> chat messages。
 * 已覆盖：message(input_text/output_text/input_image)、function_call、
 * function_call_output、custom_tool_call(+output)、local_shell_call；
 * reasoning 的思考文本回挂到其后第一条 assistant 消息上。
 *
 * @param {object} body
 * @param {{ keepThinking?: boolean }} [opts] keepThinking=false 时不回挂 reasoning_content，
 *        供兼容重试使用：不认这个字段的严格上游会报 Unknown parameter。
 */
function toMessages(body, { keepThinking = true } = {}) {
  const messages = [];
  let pendingThinking = '';
  // 上游在 thinking 模式下要求把上一轮的 reasoning_content 原样回传，
  // 丢了会整轮 400：The `reasoning_content` in the thinking mode must be passed back to the API.
  const flushThinking = () => {
    if (!pendingThinking) return;
    const last = messages[messages.length - 1];
    if (keepThinking && last && last.role === 'assistant' && typeof last.reasoning_content !== 'string') {
      last.reasoning_content = pendingThinking;
    }
    pendingThinking = '';
  };
  if (body && typeof body.instructions === 'string' && body.instructions.trim()) {
    pushSystemMessage(messages, body.instructions);
  }
  const input = body ? body.input : undefined;
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (item.role ? 'message' : '');
    switch (type) {
      case 'message':
      case 'agent_message': {
        // 真实流量里 role 会出现 developer（skills/环境说明），归一到 system
        if (item.role === 'developer' || item.role === 'system') {
          pushSystemMessage(messages, textOfContent(item.content));
          break;
        }
        const role = type === 'agent_message' || item.role === 'agent' ? 'assistant' : item.role || 'user';
        const content = contentToChat(item.content);
        if (content === '' && !Array.isArray(content)) continue;
        if (Array.isArray(content) && content.length === 0) continue;
        messages.push({ role, content });
        if (role === 'assistant') flushThinking();
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = item.name || (item.type === 'custom_tool_call' ? 'custom_tool' : 'tool');
        const args =
          item.type === 'custom_tool_call'
            ? JSON.stringify({ input: item.input ?? '' })
            : typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {});
        pushAssistantToolCall(messages, {
          id: item.call_id || item.id || '',
          type: 'function',
          function: { name, arguments: args },
        });
        flushThinking();
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = item.call_id || item.id || '';
        if (!callId) break;
        messages.push({ role: 'tool', tool_call_id: callId, content: stringifyOutput(item.output) });
        break;
      }
      case 'local_shell_call': {
        // codex 的本地 shell 历史项：降级成一个普通 function_call，避免丢失上下文。
        pushAssistantToolCall(messages, {
          id: item.call_id || item.id || '',
          type: 'function',
          function: { name: 'local_shell', arguments: JSON.stringify(item.action ?? {}) },
        });
        flushThinking();
        break;
      }
      case 'reasoning':
        pendingThinking += thinkingText(item);
        break;
      default:
        // web_search_call / 其它：chat 上游没有对应结构，丢弃。
        break;
    }
  }
  return mergeAssistantTurns(messages);
}

/** Responses tools -> chat tools。 */
function toTools(tools) {
  if (!Array.isArray(tools)) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'namespace') {
      out.push(...(toTools(tool.tools) || []));
      continue;
    }
    if (tool.type === 'function' && tool.function && tool.function.name) {
      // 已经是 chat 形状，但 parameters 仍要清洗
      out.push({ ...tool, function: { ...tool.function, parameters: toolParameters(tool.function.parameters) } });
      continue;
    }
    if (tool.type === 'function' && tool.name) {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: toolParameters(tool.parameters),
        },
      });
      continue;
    }
    if (tool.type === 'custom' && tool.name) {
      // codex 的 freeform 工具（例如 apply_patch）：降级成一个单字符串入参的 function。
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: '完整工具输入文本' } },
            required: ['input'],
          },
        },
      });
    }
    // 真实 codex 流量里还会出现 type:"namespace"（嵌套工具组）、
    // type:"web_search" 等内置工具：chat 上游没有对应协议，直接跳过。
  }
  return out.length ? out : null;
}

function toToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = choice.name || choice.function?.name;
    return name ? { type: 'function', function: { name } } : 'auto';
  }
  if (choice.type === 'allowed_tools' || choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'required' || choice.type === 'any') return 'required';
  return undefined;
}

/** codex 的 effort 取值 -> chat 的 reasoning_effort（上游不认识的值直接不发）。 */
function toReasoningEffort(effort) {
  if (typeof effort !== 'string') return undefined;
  const value = effort.toLowerCase();
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) return value;
  return undefined;
}

/**
 * @param {{provider:any, modelId:string, body:any, stream?:boolean, compat?:boolean}} ctx
 * @returns {{url:string, headers:Record<string,string>, payload:object}}
 */
function buildRequest({ provider, modelId, body = {}, stream = true, compat = false }) {
  const omitted = (name) => compat === true || (typeof compat === 'string' && compat.includes(name));
  const payload = { model: modelId, messages: toMessages(body, { keepThinking: !omitted('reasoning_content') }), stream: !!stream };
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim() && !omitted('prompt_cache_key')) {
    // Chat Completions 兼容中转可能支持同名缓存键；兼容重试会主动移除它。
    payload.prompt_cache_key = body.prompt_cache_key.trim();
  }
  if (stream && !omitted('stream_options')) {
    // 让上游在最后一个 chunk 里带 usage；少数中转不认这个参数 -> retro 重试时去掉。
    payload.stream_options = { include_usage: true };
  }
  const inputTools = (Array.isArray(body.input) ? body.input : [])
    .filter((item) => item?.type === 'additional_tools').flatMap((item) => item.tools || []);
  let tools = toTools([...(body.tools || []), ...inputTools]);
  if (body.tool_choice?.type === 'allowed_tools') {
    const names = (body.tool_choice.tools || []).map((tool) => typeof tool === 'string' ? tool : tool.name || tool.function?.name);
    tools = (tools || []).filter((tool) => names.includes(tool.function.name));
  }
  if (tools) {
    payload.tools = tools;
    const toolChoice = body.tool_choice?.type === 'allowed_tools'
      ? body.tool_choice.mode === 'required' ? 'required' : 'auto' : toToolChoice(body.tool_choice);
    if (toolChoice !== undefined) payload.tool_choice = toolChoice;
    if (typeof body.parallel_tool_calls === 'boolean') {
      payload.parallel_tool_calls = body.parallel_tool_calls;
    }
  }
  const maxOut = Number(body.max_output_tokens ?? body.max_tokens);
  if (Number.isFinite(maxOut) && maxOut > 0 && compat !== true) {
    // UNKNOWN：新版 OpenAI 直连要 max_completion_tokens，老中转只认 max_tokens。
    // 兼容面优先，这里用 max_tokens；被拒时 server 会用 compat 请求重试一次。
    payload[omitted('max_tokens') ? 'max_completion_tokens' : 'max_tokens'] = Math.floor(maxOut);
  }
  const effort = toReasoningEffort(body.reasoning && body.reasoning.effort);
  if (effort && compat !== true) payload.reasoning_effort = effort;
  if (compat !== true) {
    for (const key of ['temperature', 'top_p']) if (typeof body[key] === 'number') payload[key] = body[key];
    if (body.stop_sequences) payload.stop = body.stop_sequences;
    const format = body.text?.format;
    if (format?.type === 'json_schema') {
      const { type, ...schema } = format;
      payload.response_format = { type, json_schema: schema };
    } else if (format?.type === 'json_object') payload.response_format = format;
  }

  return {
    url: joinApiUrl(provider.baseUrl, '/chat/completions'),
    headers: buildHeaders(provider),
    payload,
  };
}

/**
 * 上游 chat SSE -> 内部事件。
 * @param {{body: AsyncIterable<Uint8Array>, status:number}} upstream
 */
async function* translate(upstream) {
  let finishReason = null;
  let done = false;
  const toolNames = new Map();
  for await (const frame of parseSse(upstream.body)) {
    const data = frame.data;
    if (!data) continue;
    if (data.trim() === '[DONE]') { done = true; break; }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      throw new Error('Chat 上游包含无效 JSON SSE 帧');
    }
    if (json.error) {
      const message =
        (json.error && (json.error.message || json.error.type)) || '上游返回了错误事件';
      throw new Error(String(message));
    }
    if (json.usage) yield { type: 'usage', usage: json.usage };
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) continue;

    const delta = choice.delta || choice.message || {};
    if (typeof delta.refusal === 'string' && delta.refusal) yield { type: 'text', delta: delta.refusal };
    if (typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', delta: delta.content };
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        const piece = typeof part === 'string' ? part : part && part.text;
        if (typeof piece === 'string' && piece) yield { type: 'text', delta: piece };
      }
    }

    const reasoning =
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
      (typeof delta.reasoning === 'string' && delta.reasoning) ||
      (typeof delta.reasoning_text === 'string' && delta.reasoning_text) ||
      '';
    if (reasoning) yield { type: 'reasoning', delta: reasoning };

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const key = call.index ?? 0;
        if (call.id || call.function?.name) {
          const name = (toolNames.get(key) || '') + (call.function?.name || '');
          toolNames.set(key, name);
          yield { type: 'tool_start', key, id: call.id, name };
        }
        const args = call.function?.arguments;
        if (typeof args === 'string' && args) yield { type: 'tool_args', key, delta: args };
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!finishReason && !done) throw new Error('Chat stream ended before a terminal event');
  yield { type: 'finish', reason: finishReason };
}

/** 非流式 chat 响应 -> 内部结果。 */
function parseJson(json) {
  if (!Array.isArray(json?.choices) || !json.choices.length) throw new Error('Chat 上游响应缺少 choices');
  const choice = (Array.isArray(json?.choices) && json.choices[0]) || {};
  const message = choice.message || {};
  let text = '';
  if (typeof message.content === 'string') text = message.content;
  else if (Array.isArray(message.content)) text = textOfContent(message.content);
  if (typeof message.refusal === 'string') text += message.refusal;
  const reasoning =
    (typeof message.reasoning_content === 'string' && message.reasoning_content) ||
    (typeof message.reasoning === 'string' && message.reasoning) ||
    (typeof message.reasoning_text === 'string' && message.reasoning_text) ||
    '';
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call) => ({
    id: call.id,
    name: call.function?.name,
    arguments: call.function?.arguments || '',
  }));
  return { text, reasoning, toolCalls, usage: json?.usage || null, finishReason: choice.finish_reason };
}

function createOpenAIAdapter() {
  return {
    name: 'openai',
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    endpoint: (provider) => joinApiUrl(provider.baseUrl, '/chat/completions'),
    buildHeaders,
    buildRequest,
    translate,
    parseJson,
  };
}

module.exports = {
  createOpenAIAdapter,
  buildRequest,
  buildHeaders,
  contentToChat,
  toMessages,
  toToolChoice,
  toTools,
  parseJson,
  translate,
};
