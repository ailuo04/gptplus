'use strict';
/**
 * Anthropic Messages 适配器（spec 第 6 节 `api: "anthropic"`）。
 *
 * 最小可用实现：
 *   - buildRequest: Responses 请求体 -> `POST {baseUrl}/messages`
 *   - translate:    上游 Messages SSE -> responses.js 的内部事件
 *   - parseJson:    非流式 Messages 响应 -> 内部结果
 *
 * 认证：Anthropic 用 `x-api-key` + `anthropic-version`（不是 Bearer）。
 *       provider.headers 里的自定义头优先，可用来覆盖 anthropic-version 或加
 *       `anthropic-beta`。
 * 已知差异（非阻塞）：Anthropic 的 system 是顶层参数、消息角色只有 user/assistant，
 * 所以 codex 的 developer/system 消息会被折叠进 system 字段。
 */
const { joinApiUrl, parseSse, toolParameters } = require('../responses.js');

const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function buildHeaders(provider) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  for (const [key, value] of Object.entries(provider.headers || {})) {
    if (!key) continue;
    headers[key] = String(value ?? '');
  }
  if (!hasHeader(headers, 'x-api-key') && provider.apiKey) {
    headers['x-api-key'] = String(provider.apiKey);
  }
  if (!hasHeader(headers, 'anthropic-version')) {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  }
  return headers;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.refusal === 'string') return part.refusal;
      return '';
    })
    .join('');
}

/** Responses content -> Anthropic content blocks。 */
function contentToBlocks(content, role) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  const textType = role === 'assistant' ? 'text' : 'text';
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: textType, text: part });
      continue;
    }
    if (!part) continue;
    if (part.type === 'input_image' || part.type === 'image_url') {
      const image = part.image_url;
      const url = (image && typeof image === 'object' ? image.url : image) || part.url || '';
      const match = typeof url === 'string' ? /^data:([^;]+);base64,(.*)$/.exec(url) : null;
      if (match) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      } else if (typeof url === 'string' && url) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
      continue;
    }
    const text = part.text ?? part.refusal;
    if (typeof text === 'string' && text) blocks.push({ type: textType, text });
  }
  return blocks;
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 相邻同角色消息必须合并，否则 Anthropic 直接 400。 */
function pushMessage(messages, role, content) {
  if (!content.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content = last.content.concat(content);
    return;
  }
  messages.push({ role, content });
}

function toAnthropicMessages(body) {
  const systemParts = [];
  const messages = [];
  if (body && typeof body.instructions === 'string' && body.instructions.trim()) {
    systemParts.push(body.instructions);
  }
  const input = body ? body.input : undefined;
  const items = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : Array.isArray(input) ? input : [];

  for (const item of items) {
    if (typeof item === 'string') {
      pushMessage(messages, 'user', [{ type: 'text', text: item }]);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (item.role ? 'message' : '');
    switch (type) {
      case 'message': {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const blocks = contentToBlocks(item.content, role);
        if (item.role === 'system' || item.role === 'developer') {
          const text = textOf(item.content);
          if (text) systemParts.push(text);
          break;
        }
        pushMessage(messages, role, blocks);
        break;
      }
      case 'function_call': {
        const toolUse = {
          type: 'tool_use',
          id: item.call_id || item.id || `toolu_${Math.random().toString(16).slice(2, 10)}`,
          name: item.name || 'tool',
          input: parseJsonObject(item.arguments),
        };
        pushMessage(messages, 'assistant', [toolUse]);
        break;
      }
      case 'custom_tool_call': {
        pushMessage(messages, 'assistant', [
          {
            type: 'tool_use',
            id: item.call_id || item.id || `toolu_${Math.random().toString(16).slice(2, 10)}`,
            name: item.name || 'custom_tool',
            input: { input: item.input ?? '' },
          },
        ]);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = item.call_id || item.id;
        if (!callId) break;
        const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        pushMessage(messages, 'user', [
          { type: 'tool_result', tool_use_id: callId, content: text || '(空)' },
        ]);
        break;
      }
      case 'reasoning':
      case 'local_shell_call':
      default:
        // reasoning 不回灌；local_shell_call 无对应结构，丢弃。
        break;
    }
  }
  return { system: systemParts.join('\n\n'), messages };
}

function toAnthropicTools(tools, { cache = false } = {}) {
  if (!Array.isArray(tools)) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && tool.name) {
      out.push({
        name: tool.name,
        description: tool.description || '',
        input_schema: toolParameters(tool.parameters),
      });
    } else if (tool.type === 'function' && tool.function?.name) {
      out.push({
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: toolParameters(tool.function.parameters),
      });
    } else if (tool.type === 'custom' && tool.name) {
      out.push({
        name: tool.name,
        description: tool.description || '',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string', description: '完整工具输入文本' } },
          required: ['input'],
        },
      });
    }
  }
  if (cache && out.length) out[out.length - 1].cache_control = { type: 'ephemeral' };
  return out.length ? out : null;
}

function toAnthropicToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'none') return { type: 'auto' }; // Anthropic 没有 none，退化为 auto
    if (choice === 'required') return { type: 'any' };
    return { type: 'auto' };
  }
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = choice.name || choice.function?.name;
    return name ? { type: 'tool', name } : { type: 'auto' };
  }
  if (choice.type === 'required' || choice.type === 'any') return { type: 'any' };
  return { type: 'auto' };
}

function buildRequest({ provider, modelId, body = {}, stream = true, compat = false }) {
  const { system, messages } = toAnthropicMessages(body);
  const maxOut = Number(body.max_output_tokens ?? body.max_tokens);
  const tools = toAnthropicTools(body.tools, { cache: !compat });
  const payload = {
    model: modelId,
    max_tokens: Number.isFinite(maxOut) && maxOut > 0 ? Math.floor(maxOut) : DEFAULT_MAX_TOKENS,
    // Anthropic 必须至少有一条 user 消息
    messages: messages.length ? messages : [{ role: 'user', content: [{ type: 'text', text: '(空)' }] }],
    stream: !!stream,
  };
  if (system) {
    payload.system = !compat && !tools
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  if (tools) {
    payload.tools = tools;
    if (!compat) {
      const choice = toAnthropicToolChoice(body.tool_choice);
      if (choice) payload.tool_choice = choice;
    }
  }
  if (Number.isFinite(Number(body.temperature)) && !compat) payload.temperature = Number(body.temperature);
  return {
    url: joinApiUrl(provider.baseUrl, '/messages'),
    headers: buildHeaders(provider),
    payload,
  };
}

/**
 * 上游 Messages SSE -> 内部事件。
 * 事件：message_start / content_block_start / content_block_delta /
 *       content_block_stop / message_delta / message_stop / error / ping
 */
async function* translate(upstream) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  const blockKinds = new Map();
  let finishReason = null;

  for await (const frame of parseSse(upstream.body)) {
    const data = frame.data;
    if (!data) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const type = json.type || frame.event;
    switch (type) {
      case 'message_start': {
        const usage = json.message?.usage;
        if (usage) {
          const uncachedInputTokens = Number(usage.input_tokens) || 0;
          outputTokens = Number(usage.output_tokens) || 0;
          cacheReadInputTokens = Number(usage.cache_read_input_tokens) || 0;
          cacheCreationInputTokens = Number(usage.cache_creation_input_tokens) || 0;
          inputTokens = uncachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
          yield {
            type: 'usage',
            usage: {
              ...usage,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              cache_read_input_tokens: cacheReadInputTokens,
              cache_creation_input_tokens: cacheCreationInputTokens,
            },
          };
        }
        break;
      }
      case 'content_block_start': {
        const block = json.content_block || {};
        const index = json.index ?? 0;
        blockKinds.set(index, block.type);
        if (block.type === 'tool_use') {
          yield { type: 'tool_start', key: index, id: block.id, name: block.name };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = json.delta || {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          yield { type: 'text', delta: delta.text };
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          yield { type: 'reasoning', delta: delta.thinking };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
          yield { type: 'tool_args', key: json.index ?? 0, delta: delta.partial_json };
        }
        break;
      }
      case 'message_delta': {
        if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
        if (json.usage) {
          outputTokens = Number(json.usage.output_tokens) || outputTokens;
          yield {
            type: 'usage',
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_input_tokens: cacheReadInputTokens,
              cache_creation_input_tokens: cacheCreationInputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          };
        }
        break;
      }
      case 'error': {
        const message = json.error?.message || json.error?.type || 'Anthropic 返回错误事件';
        throw new Error(String(message));
      }
      case 'ping':
      case 'message_stop':
      case 'content_block_stop':
      default:
        break;
    }
  }
  yield { type: 'finish', reason: finishReason };
}

function parseJson(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = json?.usage
    ? (() => {
        const input = (Number(json.usage.input_tokens) || 0)
          + (Number(json.usage.cache_read_input_tokens) || 0)
          + (Number(json.usage.cache_creation_input_tokens) || 0);
        const output = Number(json.usage.output_tokens) || 0;
        return { ...json.usage, input_tokens: input, output_tokens: output, total_tokens: input + output };
      })()
    : null;
  return { text, reasoning, toolCalls, usage, finishReason: json?.stop_reason || null };
}

function createAnthropicAdapter() {
  return {
    name: 'anthropic',
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    endpoint: (provider) => joinApiUrl(provider.baseUrl, '/messages'),
    buildHeaders,
    buildRequest,
    translate,
    parseJson,
  };
}

module.exports = {
  createAnthropicAdapter,
  buildRequest,
  buildHeaders,
  toAnthropicMessages,
  toAnthropicTools,
  parseJson,
  translate,
  ANTHROPIC_VERSION,
};
