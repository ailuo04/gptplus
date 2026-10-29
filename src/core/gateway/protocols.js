'use strict';

/**
 * 入站协议归一化与非-Responses 出站协议适配。
 *
 * 网关内部以 Responses input/output item 作为中间表示：这样三种公开协议
 * 不需要互相写 N^2 套转换，所有上游适配器都只处理同一个请求形状，输出
 * 再由本文件按客户端要求还原成 Chat Completions 或 Messages。
 */
const {
  SseWriter,
  estimateUsage,
  hasCacheUsage,
  newItemId,
  newResponseId,
  normalizeUsage,
  nowSeconds,
} = require('./responses.js');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  return asArray(content).map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    if (part && typeof part.refusal === 'string') return part.refusal;
    if (part && typeof part.thinking === 'string') return part.thinking;
    return '';
  }).join('');
}

function inputText(text) {
  return { type: 'input_text', text: String(text ?? '') };
}

function outputText(text) {
  return { type: 'output_text', text: String(text ?? '') };
}

function chatContentToResponses(content, role) {
  if (typeof content === 'string') {
    return [role === 'assistant' ? outputText(content) : inputText(content)];
  }
  const out = [];
  for (const part of asArray(content)) {
    if (typeof part === 'string') {
      out.push(role === 'assistant' ? outputText(part) : inputText(part));
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      out.push(role === 'assistant' ? outputText(part.text) : inputText(part.text));
    } else if (part.type === 'refusal') {
      out.push({ type: 'refusal', refusal: String(part.refusal ?? '') });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      const image = part.image_url;
      const url = (image && typeof image === 'object' ? image.url : image) || part.url || '';
      if (typeof url === 'string' && url) out.push({ type: 'input_image', image_url: { url } });
    } else if (['input_audio', 'audio', 'file', 'input_file', 'input_video'].includes(part.type)) {
      throw Object.assign(new Error(`跨协议转换不支持内容类型 ${part.type}`), { statusCode: 400 });
    } else if (typeof part.text === 'string') {
      out.push(role === 'assistant' ? outputText(part.text) : inputText(part.text));
    } else throw Object.assign(new Error(`跨协议转换不支持内容类型 ${part.type}`), { statusCode: 400 });
  }
  return out;
}

function reasoningItem(text, signature) {
  const item = { type: 'reasoning', summary: [{ type: 'summary_text', text: String(text ?? '') }] };
  if (signature) item.encrypted_content = String(signature);
  return item;
}

function chatMessagesToInput(messages) {
  const input = [];
  for (const message of asArray(messages)) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role || 'user';
    if (role === 'system' || role === 'developer') {
      const content = chatContentToResponses(message.content, 'user');
      if (content.length) input.push({ type: 'message', role: 'developer', content });
      continue;
    }
    if (role === 'tool') {
      const callId = message.tool_call_id || message.call_id || message.id;
      if (callId) input.push({ type: 'function_call_output', call_id: callId, output: message.content ?? '' });
      continue;
    }
    if (role === 'assistant') {
      const reasoning = message.reasoning_content || message.reasoning || message.reasoning_text;
      const signature = message.reasoning_signature || message.encrypted_content;
      if (reasoning) input.push(reasoningItem(reasoning, signature));
      const content = chatContentToResponses(message.content, 'assistant');
      if (content.length) input.push({ type: 'message', role: 'assistant', content });
      for (const call of asArray(message.tool_calls)) {
        const fn = call && call.function;
        if (!fn?.name) continue;
        input.push({
          type: 'function_call',
          call_id: call.id || call.call_id || '',
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }
    const content = chatContentToResponses(message.content, 'user');
    if (content.length) input.push({ type: 'message', role: 'user', content });
  }
  return input;
}

function chatToolsToResponses(tools) {
  const out = [];
  for (const tool of asArray(tools)) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && tool.function?.name) {
      out.push({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters,
      });
    } else if (tool.type === 'function' && tool.name) {
      out.push({ ...tool });
    } else if (tool.type === 'custom' && tool.name) {
      out.push({ ...tool });
    }
  }
  return out;
}

function chatToolChoiceToResponses(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = choice.name || choice.function?.name;
    return name ? { type: choice.type, name } : 'auto';
  }
  if (choice.type === 'required' || choice.type === 'any') return 'required';
  if (choice.type === 'none' || choice.type === 'auto') return choice.type;
  return choice;
}

function anthropicImageToResponses(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'input_image', image_url: { url: source.url } };
  }
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = source.media_type || 'image/png';
    return { type: 'input_image', image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  return null;
}

function anthropicMessageToInput(message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const normal = [];
  const out = [];
  const flush = () => {
    if (normal.length) {
      out.push({ type: 'message', role, content: normal.splice(0, normal.length) });
    }
  };
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : asArray(message.content);
  for (const block of content) {
    if (typeof block === 'string') {
      normal.push(role === 'assistant' ? outputText(block) : inputText(block));
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking') {
      flush();
      out.push(reasoningItem(block.thinking, block.signature));
    } else if (block.type === 'text') {
      normal.push(role === 'assistant' ? outputText(block.text) : inputText(block.text));
    } else if (block.type === 'image') {
      const image = anthropicImageToResponses(block.source);
      if (image) normal.push(image);
    } else if (block.type === 'tool_use') {
      flush();
      out.push({
        type: 'function_call',
        call_id: block.id || '',
        name: block.name || 'tool',
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      });
    } else if (block.type === 'tool_result') {
      flush();
      if (Array.isArray(block.content) && block.content.some((part) => part.type !== 'text')) {
        throw Object.assign(new Error('跨协议转换暂不支持非文本 tool_result'), { statusCode: 400 });
      }
      out.push({ type: 'function_call_output', call_id: block.tool_use_id || '', output: textOfBlocks(block.content) });
    } else if (block.type === 'refusal') {
      normal.push({ type: 'refusal', refusal: String(block.refusal ?? '') });
    } else if (typeof block.text === 'string') {
      normal.push(role === 'assistant' ? outputText(block.text) : inputText(block.text));
    } else throw Object.assign(new Error(`跨协议转换不支持内容类型 ${block.type}`), { statusCode: 400 });
  }
  flush();
  return out;
}

function anthropicToolsToResponses(tools) {
  if (asArray(tools).some((tool) => tool?.type && tool.type !== 'custom')) {
    throw Object.assign(new Error('跨协议转换暂不支持 Anthropic 服务端内置工具'), { statusCode: 400 });
  }
  return asArray(tools).filter((tool) => tool && typeof tool === 'object' && tool.name).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema,
  }));
}

function anthropicToolChoiceToResponses(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'none' || choice.type === 'auto') return choice.type;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') return { type: 'function', name: choice.name };
  if (choice.type === 'allowed_tools') {
    return { type: 'allowed_tools', mode: choice.mode || 'auto', tools: choice.tools || [] };
  }
  return choice;
}

function setInternal(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true });
  return target;
}

function effortFromThinking(thinking) {
  if (!thinking || thinking.type === 'disabled') return thinking ? 'none' : undefined;
  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return 'medium';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 16384) return 'high';
  return 'max';
}

function normalizeRequest(body, protocol) {
  const source = body && typeof body === 'object' ? body : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 });
  if (protocol === 'responses') return { body: source, options: {} };
  if (!Array.isArray(source.messages)) throw Object.assign(new Error('messages 必须是数组'), { statusCode: 400 });
  if (source.n != null && source.n !== 1) throw Object.assign(new Error('协议转换当前只支持 n=1'), { statusCode: 400 });
  const common = {};
  for (const key of ['model', 'stream', 'temperature', 'top_p', 'metadata', 'parallel_tool_calls', 'prompt_cache_key']) {
    if (source[key] !== undefined) common[key] = source[key];
  }
  if (protocol === 'chat') {
    const normalized = { ...common, input: chatMessagesToInput(source.messages) };
    delete normalized.messages;
    normalized.tools = chatToolsToResponses(source.tools);
    if (!normalized.tools.length) delete normalized.tools;
    normalized.tool_choice = chatToolChoiceToResponses(source.tool_choice);
    if (normalized.tool_choice === undefined) delete normalized.tool_choice;
    if (normalized.max_output_tokens == null && source.max_completion_tokens != null) {
      normalized.max_output_tokens = source.max_completion_tokens;
    } else if (normalized.max_output_tokens == null && source.max_tokens != null) {
      normalized.max_output_tokens = source.max_tokens;
    }
    delete normalized.max_tokens;
    if (normalized.reasoning == null && source.reasoning_effort) {
      normalized.reasoning = { effort: source.reasoning_effort };
    }
    if (source.stop != null && normalized.stop_sequences == null) {
      normalized.stop_sequences = Array.isArray(source.stop) ? source.stop : [source.stop];
    }
    if (source.response_format) {
      const format = source.response_format;
      normalized.text = { format: format.type === 'json_schema' ? { type: 'json_schema', ...format.json_schema } : format };
    }
    setInternal(normalized, 'inputProtocol', 'chat');
    return { body: normalized, options: { includeUsage: !!source.stream_options?.include_usage } };
  }
  if (protocol === 'anthropic') {
    const normalized = { ...common };
    delete normalized.messages;
    normalized.instructions = textOfBlocks(source.system);
    normalized.input = [];
    for (const message of asArray(source.messages)) normalized.input.push(...anthropicMessageToInput(message));
    normalized.tools = anthropicToolsToResponses(source.tools);
    if (!normalized.tools.length) delete normalized.tools;
    normalized.tool_choice = anthropicToolChoiceToResponses(source.tool_choice);
    if (normalized.tool_choice === undefined) delete normalized.tool_choice;
    if (normalized.max_output_tokens == null && source.max_tokens != null) normalized.max_output_tokens = source.max_tokens;
    delete normalized.max_tokens;
    if (normalized.reasoning == null && source.thinking) normalized.reasoning = { effort: effortFromThinking(source.thinking) };
    if (source.output_config?.effort) normalized.reasoning = { effort: source.output_config.effort };
    if (source.thinking) setInternal(normalized, 'anthropicThinking', source.thinking);
    if (source.output_config) setInternal(normalized, 'anthropicOutputConfig', source.output_config);
    if (source.stop_sequences) normalized.stop_sequences = source.stop_sequences;
    if (source.tool_choice?.disable_parallel_tool_use) normalized.parallel_tool_calls = false;
    setInternal(normalized, 'inputProtocol', 'anthropic');
    return { body: normalized, options: { includeUsage: true } };
  }
  throw new Error(`不支持的入站协议: ${protocol}`);
}

function protocolFromPath(pathname) {
  if (pathname === '/v1/chat/completions') return 'chat';
  if (pathname === '/v1/messages') return 'anthropic';
  if (pathname === '/v1/responses') return 'responses';
  return null;
}

function finishReasonForChat(reason, hasToolCalls) {
  const value = String(reason || '').toLowerCase();
  if (value === 'max_tokens' || value === 'max_output_tokens' || value === 'length') return 'length';
  if (hasToolCalls || value === 'tool_use' || value === 'function_call' || value === 'tool_calls') return 'tool_calls';
  if (value === 'content_filter') return 'content_filter';
  return 'stop';
}

function finishReasonForAnthropic(reason, hasToolCalls) {
  const value = String(reason || '').toLowerCase();
  if (value === 'max_tokens' || value === 'max_output_tokens' || value === 'length') return 'max_tokens';
  if (hasToolCalls || value === 'tool_use' || value === 'function_call' || value === 'tool_calls') return 'tool_use';
  if (value === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

function anthropicUsage(raw, requestBody, text) {
  const usage = normalizeUsage(raw) || estimateUsage(requestBody, text);
  return {
    input_tokens: Math.max(0, usage.input_tokens - (usage.input_tokens_details?.cached_tokens || 0) - (usage.input_tokens_details?.cache_write_tokens || 0)),
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0,
    cache_creation_input_tokens: usage.input_tokens_details?.cache_write_tokens || 0,
  };
}

function chatUsage(usage) {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0 },
  };
}

function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Preserve malformed free-form input under the documented custom input key.
    }
  }
  throw new Error('上游工具参数不是有效的 JSON 对象');
}

function buildChatResponse({ id, model, text, reasoning, reasoningItems, reasoningSignature, toolCalls, usage, requestBody, finishReason }) {
  const calls = asArray(toolCalls).map((call) => ({
    id: call.id || newItemId('call_'),
    type: 'function',
    function: { name: call.name || 'tool', arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
  }));
  const message = { role: 'assistant', content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  const signature = reasoningSignature || (reasoningItems?.length === 1 ? reasoningItems[0].signature : '');
  if (signature) message.reasoning_signature = signature;
  if (calls.length) message.tool_calls = calls;
  const normalized = normalizeUsage(usage) || estimateUsage(requestBody, text);
  return {
    id: id || `chatcmpl_${newResponseId().slice(5)}`,
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReasonForChat(finishReason, calls.length > 0) }],
    usage: chatUsage(normalized),
  };
}

function buildAnthropicResponse({ id, model, text, reasoningItems, reasoning, toolCalls, usage, requestBody, finishReason }) {
  const content = [];
  if (Array.isArray(reasoningItems) && reasoningItems.length) {
    for (const item of reasoningItems) {
      if (!item?.text && !item?.signature) continue;
      content.push({ type: 'thinking', thinking: item.text || '', ...(item.signature ? { signature: item.signature } : {}) });
    }
  } else if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning });
  }
  if (text) content.push({ type: 'text', text });
  for (const call of asArray(toolCalls)) {
    content.push({ type: 'tool_use', id: call.id || newItemId('toolu_'), name: call.name || 'tool', input: parseToolArguments(call.arguments) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: id || `msg_${newResponseId().slice(5)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: finishReasonForAnthropic(finishReason, asArray(toolCalls).length > 0),
    stop_sequence: null,
    usage: anthropicUsage(usage, requestBody, text),
  };
}

class ChatCompletionsStream {
  constructor({ res, model, includeUsage = false }) {
    this.writer = res instanceof SseWriter ? res : new SseWriter(res, { namedEvents: false });
    this.model = model;
    this.id = `chatcmpl_${newResponseId().slice(5)}`;
    this.created = nowSeconds();
    this.includeUsage = includeUsage;
    this._usage = null;
    this._usageEstimated = false;
    this._cacheUsageAvailable = false;
    this._finished = false;
    this._text = '';
    this._reasoning = '';
    this._reasoningSignature = '';
    this._tools = new Map();
    this._emitted = [];
    this.finishReason = null;
  }

  get usage() { return this._usage; }
  get usageEstimated() { return this._usageEstimated; }
  get cacheUsageAvailable() { return this._cacheUsageAvailable; }
  get text() { return this._text; }
  get emittedTypes() { return this._emitted.slice(); }
  _send(payload) { this._emitted.push('chat.completion.chunk'); this.writer.write(payload); }
  start() {
    this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    return this;
  }
  textDelta(delta) { if (delta) { this._text += delta; this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }); } }
  reasoningDelta(delta) { if (delta) { this._reasoning += delta; this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] }); } }
  reasoningSignature(delta) { if (delta) { this._reasoningSignature += delta; this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { reasoning_signature: delta }, finish_reason: null }] }); } }
  reasoningDone() {}
  toolStart({ key = 0, id, name }) {
    const index = Number(key);
    const state = this._tools.get(index) || { id: id || newItemId('call_'), name: '', args: '' };
    if (id) state.id = id;
    const first = !state.started;
    const nameDelta = name ? name.slice(state.name.length) : '';
    if (name) state.name = name;
    state.started = true;
    this._tools.set(index, state);
    const functionDelta = {};
    if (nameDelta) functionDelta.name = nameDelta;
    this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index, ...(first ? { id: state.id, type: 'function' } : {}), function: functionDelta }] }, finish_reason: null }] });
  }
  toolArgsDelta({ key = 0, delta }) {
    if (!delta) return;
    const index = Number(key);
    const state = this._tools.get(index) || { id: newItemId('call_'), name: '', args: '' };
    state.args += delta;
    this._tools.set(index, state);
    this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: delta } }] }, finish_reason: null }] });
  }
  setUsage(raw) { if (hasCacheUsage(raw)) this._cacheUsageAvailable = true; const normalized = normalizeUsage(raw); if (normalized) this._usage = normalized; return normalized; }
  complete({ requestBody, finishReason } = {}) {
    if (this._finished) return this;
    this._finished = true;
    this.finishReason = finishReason;
    if (!this._usage) {
      const estimateText = [
        this._text,
        this._reasoning,
        ...[...this._tools.values()].flatMap((tool) => [tool.name, tool.args]),
      ].filter(Boolean).join('\n');
      this._usage = estimateUsage(requestBody, estimateText);
      this._usageEstimated = true;
    }
    const choice = { index: 0, delta: {}, finish_reason: finishReasonForChat(finishReason, this._tools.size > 0) };
    const payload = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [choice] };
    this._send(payload);
    if (this.includeUsage) this._send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: chatUsage(this._usage) });
    this.writer.end();
    return this;
  }
  fail(message) { if (this._finished) return this; this._finished = true; this.writer.write({ error: { message: String(message || 'upstream error'), type: 'upstream_error', code: 'upstream_error' } }); this.writer.end(); return this; }
}

class AnthropicMessagesStream {
  constructor({ res, model }) {
    this.writer = res instanceof SseWriter ? res : new SseWriter(res, { doneFrame: false });
    this.model = model;
    this.id = `msg_${newResponseId().slice(5)}`;
    this._usage = null;
    this._usageEstimated = false;
    this._cacheUsageAvailable = false;
    this._finished = false;
    this._text = '';
    this._reasoning = '';
    this._active = null;
    this._nextIndex = 0;
    this._tools = new Map();
    this._emitted = [];
  }
  get usage() { return this._usage; }
  get usageEstimated() { return this._usageEstimated; }
  get cacheUsageAvailable() { return this._cacheUsageAvailable; }
  get text() { return this._text; }
  get emittedTypes() { return this._emitted.slice(); }
  _send(event) { this._emitted.push(event.type); this.writer.write(event); }
  start() {
    this._send({ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    return this;
  }
  _closeActive() {
    if (!this._active) return;
    this._send({ type: 'content_block_stop', index: this._active.index });
    this._active = null;
  }
  _ensure(type) {
    if (this._active?.type === type) return this._active;
    this._closeActive();
    const state = { type, index: this._nextIndex++ };
    this._active = state;
    if (type === 'thinking') this._send({ type: 'content_block_start', index: state.index, content_block: { type: 'thinking', thinking: '' } });
    else this._send({ type: 'content_block_start', index: state.index, content_block: { type: 'text', text: '' } });
    return state;
  }
  textDelta(delta) { if (!delta) return; this._text += delta; const state = this._ensure('text'); this._send({ type: 'content_block_delta', index: state.index, delta: { type: 'text_delta', text: delta } }); }
  reasoningDelta(delta) { if (!delta) return; this._reasoning += delta; const state = this._ensure('thinking'); this._send({ type: 'content_block_delta', index: state.index, delta: { type: 'thinking_delta', thinking: delta } }); }
  reasoningSignature(delta) { if (!delta) return; const state = this._ensure('thinking'); this._send({ type: 'content_block_delta', index: state.index, delta: { type: 'signature_delta', signature: delta } }); }
  reasoningDone() { if (this._active?.type === 'thinking') this._closeActive(); }
  textDone() { if (this._active?.type === 'text') this._closeActive(); }
  toolStart({ key = 0, id, name }) {
    const state = this._tools.get(key) || { id: id || newItemId('toolu_'), name: '', args: '' };
    if (id) state.id = id;
    if (name) state.name = name;
    this._tools.set(key, state);
  }
  toolArgsDelta({ key = 0, delta }) {
    if (!this._tools.has(key)) this.toolStart({ key });
    this._tools.get(key).args += delta || '';
  }
  setUsage(raw) { if (hasCacheUsage(raw)) this._cacheUsageAvailable = true; const normalized = normalizeUsage(raw); if (normalized) this._usage = normalized; return normalized; }
  complete({ requestBody, finishReason } = {}) {
    if (this._finished) return this;
    const tools = [...this._tools.values()].map((state) => ({ ...state, input: parseToolArguments(state.args || '{}') }));
    if (!this._usage) {
      const estimateText = [
        this._text,
        this._reasoning,
        ...[...this._tools.values()].flatMap((tool) => [tool.name, tool.args]),
      ].filter(Boolean).join('\n');
      this._usage = estimateUsage(requestBody, estimateText);
      this._usageEstimated = true;
    }
    this._closeActive();
    for (const tool of tools) {
      const index = this._nextIndex++;
      this._send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
      this._send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
      this._send({ type: 'content_block_stop', index });
    }
    this._send({ type: 'message_delta', delta: { stop_reason: finishReasonForAnthropic(finishReason, tools.length > 0), stop_sequence: null }, usage: anthropicUsage(this._usage, requestBody, this._text) });
    this._send({ type: 'message_stop' });
    this._finished = true;
    this.writer.end();
    return this;
  }
  fail(message) { if (this._finished) return this; this._finished = true; this._send({ type: 'error', error: { type: 'api_error', message: String(message || 'upstream error') } }); this.writer.end(); return this; }
}

function createOutputStream(format, res, options = {}) {
  if (format === 'chat') return new ChatCompletionsStream({ res, ...options });
  if (format === 'anthropic') return new AnthropicMessagesStream({ res, ...options });
  return null;
}

module.exports = {
  buildAnthropicResponse,
  buildChatResponse,
  chatMessagesToInput,
  createOutputStream,
  normalizeRequest,
  protocolFromPath,
};
