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
 * Anthropic 标准 Messages 将 system/developer 折叠到顶层 system；支持历史 system
 * 更新的 DeepSeek Flash 则保留其在 messages 中的位置。
 */
const { joinApiUrl, parseSse, toolParameters } = require('../responses.js');

const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';
const DEEPSEEK_EFFORT = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
};

function toDeepSeekEffort(effort) {
  if (typeof effort !== 'string') return undefined;
  const value = effort.toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEEPSEEK_EFFORT, value) ? DEEPSEEK_EFFORT[value] : undefined;
}

function supportsInHistorySystem(modelId) {
  return /deepseek.*flash/i.test(String(modelId || ''));
}

function flattenTools(tools, out = []) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) flattenTools(tool.tools, out);
    else out.push(tool);
  }
  return out;
}

function toolName(tool) {
  if (typeof tool === 'string') return tool;
  return tool?.name || tool?.function?.name || '';
}

function usageNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstUsageNumber(...values) {
  for (const value of values) {
    const number = usageNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function normalizeUsageCounts(usage, previous = {}) {
  const cachedInputTokens = firstUsageNumber(
    usage?.prompt_cache_hit_tokens,
    usage?.cache_read_input_tokens,
  ) ?? previous.cachedInputTokens ?? 0;
  const uncachedInputTokens = firstUsageNumber(
    usage?.prompt_cache_miss_tokens,
    usage?.input_tokens,
  ) ?? previous.uncachedInputTokens ?? 0;
  const cacheCreationInputTokens = usageNumber(usage?.cache_creation_input_tokens)
    ?? previous.cacheCreationInputTokens ?? 0;
  const outputTokens = usageNumber(usage?.output_tokens) ?? previous.outputTokens ?? 0;

  return {
    inputTokens: uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens,
    uncachedInputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
  };
}

function usageEvent(usage, previous) {
  const counts = normalizeUsageCounts(usage, previous);
  return {
    counts,
    event: {
      type: 'usage',
      usage: {
        ...usage,
        input_tokens: counts.inputTokens,
        output_tokens: counts.outputTokens,
        total_tokens: counts.inputTokens + counts.outputTokens,
        cache_read_input_tokens: counts.cachedInputTokens,
        cache_creation_input_tokens: counts.cacheCreationInputTokens,
      },
    },
  };
}

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
function contentToBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part) continue;
    if (['input_audio', 'input_video', 'input_file'].includes(part.type)) {
      throw Object.assign(new Error(`Anthropic Messages 转换不支持 ${part.type}`), { statusCode: 400 });
    }
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
    if (typeof text === 'string' && text) blocks.push({ type: 'text', text });
  }
  return blocks;
}

function parseJsonObject(text) {
  if (text && typeof text === 'object' && !Array.isArray(text)) return text;
  if (typeof text !== 'string' || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Keep malformed historical tool input visible as a request error rather than losing it.
  }
  throw Object.assign(new Error('Responses function_call.arguments 必须是有效的 JSON 对象'), { statusCode: 400 });
}

function stringifyToolOutput(output) {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
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

function toAnthropicMessages(body, { systemInHistory = false } = {}) {
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
      case 'message':
      case 'agent_message': {
        const blocks = contentToBlocks(item.content);
        if (item.role === 'system' || item.role === 'developer') {
          if (!blocks.length) break;
          if (systemInHistory) messages.push({ role: 'system', content: blocks });
          else {
            const text = textOf(item.content);
            if (text) systemParts.push(text);
          }
          break;
        }
        const role = type === 'agent_message' || item.role === 'assistant' || item.role === 'agent'
          ? 'assistant'
          : 'user';
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
        const input = typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? '');
        pushMessage(messages, 'assistant', [
          {
            type: 'tool_use',
            id: item.call_id || item.id || `toolu_${Math.random().toString(16).slice(2, 10)}`,
            name: item.name || 'custom_tool',
            input: { input },
          },
        ]);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = item.call_id || item.id;
        if (!callId) break;
        const text = stringifyToolOutput(item.output);
        pushMessage(messages, 'user', [
          { type: 'tool_result', tool_use_id: callId, content: text },
        ]);
        break;
      }
      case 'reasoning':
        if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
          const thinking = textOf(item.summary) || textOf(item.content);
          if (thinking) {
            pushMessage(messages, 'assistant', [{
              type: 'thinking',
              thinking,
              signature: item.encrypted_content,
            }]);
          }
        }
        break;
      case 'additional_tools':
        // Lite-mode tool definitions are extracted separately and do not become conversation text.
        break;
      case 'local_shell_call':
      default:
        // Anthropic has no equivalent for client-side shell, search, or bookkeeping items.
        break;
    }
  }
  return { system: systemParts.join('\n\n'), messages };
}

function toAnthropicTools(tools, { cache = false } = {}) {
  if (!Array.isArray(tools)) return null;
  const out = [];
  for (const tool of flattenTools(tools)) {
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

function toAnthropicToolChoice(choice, { deepseek = false, parallel = true } = {}) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'none') return { type: 'none' };
    if (choice === 'required') return { type: 'any', ...(!parallel ? { disable_parallel_tool_use: true } : {}) };
    return { type: 'auto', ...(!parallel ? { disable_parallel_tool_use: true } : {}) };
  }
  if (choice.type === 'none') return { type: 'none' };
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = choice.name || choice.function?.name;
    return name
      ? { type: 'tool', name, ...(!parallel ? { disable_parallel_tool_use: true } : {}) }
      : { type: 'auto', ...(!parallel ? { disable_parallel_tool_use: true } : {}) };
  }
  if (choice.type === 'allowed_tools') {
    const mode = choice.mode === 'required' ? 'any' : 'auto';
    return { type: mode, ...(!parallel ? { disable_parallel_tool_use: true } : {}) };
  }
  if (choice.type === 'required' || choice.type === 'any') {
    return { type: 'any', ...(!parallel ? { disable_parallel_tool_use: true } : {}) };
  }
  return { type: 'auto', ...(!parallel ? { disable_parallel_tool_use: true } : {}) };
}

function buildRequest({ provider, modelId, body = {}, stream = true, compat = false }) {
  const deepseek = /deepseek/i.test(modelId);
  const { system, messages } = toAnthropicMessages(body, {
    systemInHistory: deepseek && supportsInHistorySystem(modelId),
  });
  const maxOut = Number(body.max_output_tokens ?? body.max_tokens);
  const inputTools = (Array.isArray(body.input) ? body.input : [])
    .filter((item) => item?.type === 'additional_tools' && Array.isArray(item.tools))
    .flatMap((item) => item.tools);
  const requestedTools = flattenTools([...(Array.isArray(body.tools) ? body.tools : []), ...inputTools]);
  const choice = body.tool_choice;
  const allowedNames = choice?.type === 'allowed_tools' && Array.isArray(choice.tools)
    ? choice.tools.map(toolName).filter(Boolean)
    : null;
  const filteredTools = allowedNames !== null
    ? requestedTools.filter((tool) => allowedNames.includes(toolName(tool)))
    : requestedTools;
  const toolChoiceNone = choice === 'none' || choice?.type === 'none' || (allowedNames !== null && !allowedNames.length);
  const tools = toAnthropicTools(
    toolChoiceNone && !deepseek ? [] : filteredTools,
    { cache: !compat },
  );
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
    const toolChoice = toAnthropicToolChoice(choice || (body.parallel_tool_calls === false ? 'auto' : undefined), {
      deepseek,
      parallel: body.parallel_tool_calls !== false,
    });
    if (toolChoice) payload.tool_choice = toolChoice;
  }
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  const topP = Number(body.top_p);
  if (typeof body.top_p === 'number' && Number.isFinite(topP) && topP >= 0 && topP <= 1) payload.top_p = topP;
  if (Array.isArray(body.stop_sequences)) {
    const stopSequences = body.stop_sequences.filter((value) => typeof value === 'string' && value);
    if (stopSequences.length) payload.stop_sequences = stopSequences;
  }
  if (deepseek && typeof body.reasoning?.effort === 'string') {
    const effort = body.reasoning.effort.toLowerCase();
    payload.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
    const mappedEffort = toDeepSeekEffort(effort);
    if (mappedEffort) payload.output_config = { effort: mappedEffort };
  }
  if (body.anthropicThinking) payload.thinking = body.anthropicThinking;
  else if (!deepseek && typeof body.reasoning?.effort === 'string') {
    const effort = body.reasoning.effort.toLowerCase();
    if (effort === 'none') payload.thinking = { type: 'disabled' };
    else {
      payload.thinking = { type: 'adaptive' };
      payload.output_config = { effort: ({ minimal: 'low', xhigh: 'high', ultra: 'max' })[effort] || effort };
    }
  }
  if (body.anthropicOutputConfig) payload.output_config = body.anthropicOutputConfig;
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
  let usageCounts = normalizeUsageCounts(null);
  let finishReason = null;
  let messageStopped = false;
  const blockKinds = new Map();

  for await (const frame of parseSse(upstream.body)) {
    const data = frame.data;
    if (!data) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      throw new Error('Anthropic 上游包含无效 JSON SSE 帧');
    }
    const type = json.type || frame.event;
    switch (type) {
      case 'message_start': {
        const usage = json.message?.usage;
        if (usage) {
          const normalized = usageEvent(usage, usageCounts);
          usageCounts = normalized.counts;
          yield normalized.event;
        }
        break;
      }
      case 'content_block_start': {
        const block = json.content_block || {};
        const index = json.index ?? 0;
        blockKinds.set(index, block.type);
        if (block.type === 'tool_use') {
          yield { type: 'tool_start', key: index, id: block.id, name: block.name };
          if (block.input && Object.keys(block.input).length) yield { type: 'tool_args', key: index, delta: JSON.stringify(block.input) };
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          yield { type: 'text', delta: block.text };
        } else if (block.type === 'thinking') {
          if (block.thinking) yield { type: 'reasoning', delta: block.thinking };
          if (typeof block.signature === 'string' && block.signature) {
            yield { type: 'reasoning_signature', delta: block.signature };
          }
        }
        break;
      }
      case 'content_block_delta': {
        const delta = json.delta || {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          yield { type: 'text', delta: delta.text };
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          yield { type: 'reasoning', delta: delta.thinking };
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature) {
          yield { type: 'reasoning_signature', delta: delta.signature };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
          yield { type: 'tool_args', key: json.index ?? 0, delta: delta.partial_json };
        }
        break;
      }
      case 'message_delta': {
        if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
        if (json.usage) {
          const normalized = usageEvent(json.usage, usageCounts);
          usageCounts = normalized.counts;
          yield normalized.event;
        }
        break;
      }
      case 'error': {
        const message = json.error?.message || json.error?.type || 'Anthropic 返回错误事件';
        throw new Error(String(message));
      }
      case 'ping':
      case 'content_block_stop':
        if (type === 'content_block_stop') {
          const index = json.index ?? 0;
          if (blockKinds.get(index) === 'thinking') yield { type: 'reasoning_done' };
          blockKinds.delete(index);
        }
        break;
      case 'message_stop':
        messageStopped = true;
        break;
      default:
        break;
    }
  }
  if (!messageStopped) throw new Error('Anthropic stream ended before message_stop');
  yield { type: 'finish', reason: finishReason };
}

function parseJson(json) {
  if (!Array.isArray(json?.content)) throw new Error('Anthropic 上游响应缺少 content 数组');
  const blocks = Array.isArray(json?.content) ? json.content : [];
  let text = '';
  const reasoningItems = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'refusal' && typeof block.refusal === 'string') text += block.refusal;
    else if (block.type === 'thinking') {
      reasoningItems.push({
        text: typeof block.thinking === 'string' ? block.thinking : '',
        signature: typeof block.signature === 'string' ? block.signature : '',
      });
    }
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const reasoning = reasoningItems.map((item) => item.text).filter(Boolean).join('\n');
  const reasoningSignature = reasoningItems.length === 1 ? reasoningItems[0].signature : '';
  const usage = json?.usage ? usageEvent(json.usage).event.usage : null;
  return { text, reasoning, reasoningSignature, reasoningItems, toolCalls, usage, finishReason: json?.stop_reason || null };
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
