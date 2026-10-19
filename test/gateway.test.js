'use strict';
/**
 * 网关测试（task-2 验收）。
 *
 * 约定：
 *   - 全部走真实 http server + 本地 mock 上游（node:http），端口用 0 随机，
 *     不访问外网，也不占用用户机器上的 18120。
 *   - 断言的不只是"能跑"，还包括真实 SSE 报文的字段形状（codex 0.159 实际解析的字段）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createGateway } = require('../src/core/gateway/server.js');
const { pipeResponsesSse } = require('../src/core/gateway/responses.js');
const { slugify, parseSlug, createRouter } = require('../src/core/gateway/router.js');
const openaiAdapter = require('../src/core/gateway/adapters/openai.js');
const anthropicAdapter = require('../src/core/gateway/adapters/anthropic.js');

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

function makeStore(providers, gatewayPatch = {}) {
  const cfg = {
    version: 1,
    gateway: { enabled: false, port: 0, host: '127.0.0.1', token: '', ...gatewayPatch },
    inject: { enabled: false, catalogPath: null, defaultModel: null },
    providers,
  };
  return {
    get: () => JSON.parse(JSON.stringify(cfg)),
    providers: () => cfg.providers,
    getProvider: (id) => cfg.providers.find((p) => p.id === id),
    upsertProvider: (input) => input,
    removeProvider: () => false,
    update: (fn) => {
      fn(cfg);
      return cfg;
    },
  };
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** 本地 mock 上游：记录收到的请求，行为由 handler 决定。 */
async function startMockUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* 非 JSON 请求体 */
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: json, raw });
      try {
        handler(req, res, json);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => closeServer(server),
  };
}

/** 写一段 OpenAI chat SSE 分片。 */
function writeChatSse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeAnthropicSse(res, frames) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  for (const frame of frames) {
    res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  }
  res.end();
}

/** 把网关吐出的 SSE 原始报文解析成帧列表。 */
function parseFrames(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = null;
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        data = data === null ? value : `${data}\n${value}`;
      }
    }
    if (event === null && data === null) continue;
    let json = null;
    if (data && data !== '[DONE]') {
      try {
        json = JSON.parse(data);
      } catch {
        /* 保留 raw */
      }
    }
    frames.push({ event, data, json });
  }
  return frames;
}

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, contentType: res.headers.get('content-type') };
}

const SAMPLE_PROVIDER = {
  id: 'p_ab12cd',
  name: '梦幻API',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'sk-upstream-key',
  api: 'openai',
  headers: { 'X-Custom-Trace': 'trace-1' },
  enabled: true,
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
    { id: 'dsv4-pro', label: 'DSv4 Pro', enabled: true },
  ],
};

async function withGateway({ providers = [SAMPLE_PROVIDER], gatewayPatch = {}, logs = [] } = {}) {
  const store = makeStore(providers, gatewayPatch);
  const gw = createGateway({ store, log: (entry) => logs.push(entry) });
  const started = await gw.start({ port: 0, host: '127.0.0.1', token: gatewayPatch.token ?? '' });
  return { gw, store, logs, port: started.port, base: started.url };
}

// ---------------------------------------------------------------------------
// 1. slug 解析
// ---------------------------------------------------------------------------

test('router: slugify/parseSlug 按第一个 "__" 切分', () => {
  assert.equal(slugify('p_ab12cd', 'gpt-6.1-sol'), 'p_ab12cd__gpt-6.1-sol');
  assert.equal(slugify('p_ab12cd', 'gpt-6.1-sol', '梦幻 API'), '梦幻-API__gpt-6.1-sol');
  assert.deepEqual(parseSlug('p_ab12cd__gpt-6.1-sol'), {
    providerId: 'p_ab12cd',
    modelId: 'gpt-6.1-sol',
  });
  // modelId 里再出现 __ 时归 modelId（按第一个切分）
  assert.deepEqual(parseSlug('p_a__model__with__underscores'), {
    providerId: 'p_a',
    modelId: 'model__with__underscores',
  });
  assert.equal(parseSlug('no-separator'), null);
  assert.equal(parseSlug('__leading'), null);
  assert.equal(parseSlug(''), null);
  assert.equal(parseSlug(null), null);
});

test('router: resolve 支持未登记但形状正确的 slug，未知 provider 不通过', () => {
  const router = createRouter({ store: makeStore([SAMPLE_PROVIDER]) });
  const known = router.resolve('p_ab12cd__gpt-6.1-sol');
  assert.equal(known.ok, true);
  assert.equal(known.modelId, 'gpt-6.1-sol');
  assert.equal(known.declared, true);

  const undeclared = router.resolve('p_ab12cd__brand-new-model');
  assert.equal(undeclared.ok, true);
  assert.equal(undeclared.declared, false);
  assert.equal(undeclared.modelId, 'brand-new-model');

  assert.equal(router.resolve('p_missing__gpt-6.1-sol').ok, false);
  assert.equal(router.resolve('garbage').ok, false);
  assert.equal(router.counts().providers, 1);
  assert.equal(router.counts().models, 2);
});

test('router: 渠道名 slug 可列出并反查，旧 providerId slug 仍兼容', () => {
  const router = createRouter({ store: makeStore([SAMPLE_PROVIDER]) });
  assert.deepEqual(router.listModels().map((model) => model.slug), ['梦幻API__gpt-6.1-sol', '梦幻API__dsv4-pro']);
  const named = router.resolve('梦幻API__gpt-6.1-sol');
  assert.equal(named.ok, true);
  assert.equal(named.providerId, 'p_ab12cd');
  assert.equal(named.modelId, 'gpt-6.1-sol');
  assert.equal(router.resolve('p_ab12cd__gpt-6.1-sol').ok, true);
});

// ---------------------------------------------------------------------------
// 2. 健康检查 / 认证 / 模型列表 / 404
// ---------------------------------------------------------------------------

test('GET /healthz 返回 providers/models 计数，probe() 返回 ok:true', async () => {
  const ctx = await withGateway();
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, providers: 1, models: 2 });

    const probed = await ctx.gw.probe();
    assert.equal(probed.ok, true);
    assert.equal(typeof probed.latencyMs, 'number');
    assert.equal(probed.providers, 1);
    assert.equal(probed.models, 2);
  } finally {
    await ctx.gw.stop();
  }
});

test('token 非空时必须是 Authorization: Bearer <token>，否则 401', async () => {
  const ctx = await withGateway({ gatewayPatch: { token: 'secret-token' } });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
    assert.equal(noAuth.status, 401);
    const noAuthBody = await noAuth.json();
    assert.equal(noAuthBody.error.type, 'authentication_error');

    const wrong = await fetch(`http://127.0.0.1:${ctx.port}/healthz`, {
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`http://127.0.0.1:${ctx.port}/healthz`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assert.equal(ok.status, 200);

    // /v1/responses 也受保护
    const guarded = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, { model: 'x__y' });
    assert.equal(guarded.status, 401);

    // probe 自己带 token，仍然 ok
    assert.equal((await ctx.gw.probe()).ok, true);
  } finally {
    await ctx.gw.stop();
  }
});

test('GET /v1/models 返回 slug 列表（OpenAI list 形状）', async () => {
  const ctx = await withGateway();
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['梦幻API__gpt-6.1-sol', '梦幻API__dsv4-pro'],
    );
    assert.equal(body.data[0].object, 'model');
    assert.equal(body.data[0].owned_by, '梦幻API');
  } finally {
    await ctx.gw.stop();
  }
});

test('未知 slug -> 404 unknown model <slug>', async () => {
  const ctx = await withGateway();
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_nothere__gpt-x',
      stream: true,
      input: 'hi',
    });
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.text), {
      error: { message: 'unknown model p_nothere__gpt-x', type: 'invalid_request_error' },
    });

    const noSep = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, { model: 'plain' });
    assert.equal(noSep.status, 404);
    assert.equal(JSON.parse(noSep.text).error.message, 'unknown model plain');

    const badPath = await fetch(`http://127.0.0.1:${ctx.port}/v1/whatever`);
    assert.equal(badPath.status, 404);
  } finally {
    await ctx.gw.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. 流式 Responses 契约（mock OpenAI 上游）
// ---------------------------------------------------------------------------

test('POST /v1/responses：OpenAI 上游 -> Responses SSE 事件序列完整', async () => {
  const upstream = await startMockUpstream((req, res, body) => {
    assert.equal(body.model, 'gpt-6.1-sol'); // 必须是真实 modelId，不是 slug
    writeChatSse(res, [
      { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
      { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' } }] },
      { id: 'c1', choices: [{ index: 0, delta: { content: ' world' } }] },
      { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        id: 'c1',
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 3,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    ]);
  });

  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'p_ab12cd__gpt-6.1-sol',
        stream: true,
        prompt_cache_key: 'session-cache-key',
        instructions: 'You are Codex.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    const frames = parseFrames(text);

    // 事件序列
    assert.deepEqual(
      frames.filter((f) => f.json).map((f) => f.json.type),
      [
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
      ],
    );
    assert.equal(frames[frames.length - 1].data, '[DONE]');
    assert.equal(frames[frames.length - 1].json, null);

    // 每个事件：type + sequence_number + 事件名一致
    frames
      .filter((f) => f.json)
      .forEach((frame, index) => {
        assert.equal(frame.json.sequence_number, index, 'sequence_number 必须连续');
        assert.equal(frame.event, frame.json.type, 'event: 名与 data.type 必须一致');
      });

    // 文本增量字段
    const deltas = frames.filter((f) => f.json && f.json.type === 'response.output_text.delta');
    assert.deepEqual(
      deltas.map((f) => f.json.delta),
      ['Hello', ' world'],
    );
    for (const frame of deltas) {
      assert.equal(frame.json.output_index, 0);
      assert.equal(frame.json.content_index, 0);
      assert.match(frame.json.item_id, /^msg_/);
    }
    assert.equal(deltas[0].json.item_id, deltas[1].json.item_id);

    const added = frames.find((f) => f.json && f.json.type === 'response.output_item.added').json;
    assert.equal(added.item.type, 'message');
    assert.equal(added.item.role, 'assistant');
    assert.equal(added.item.status, 'in_progress');
    assert.equal(added.item.id, deltas[0].json.item_id);

    const textDone = frames.find((f) => f.json && f.json.type === 'response.output_text.done').json;
    assert.equal(textDone.text, 'Hello world');
    assert.equal(textDone.content_index, 0);

    const itemDone = frames.find((f) => f.json && f.json.type === 'response.output_item.done').json;
    assert.equal(itemDone.item.status, 'completed');
    assert.deepEqual(itemDone.item.content, [
      { type: 'output_text', text: 'Hello world', annotations: [] },
    ]);

    // usage 归一化（codex 期望 6 字段形状里的前 5 个）
    const completed = frames.find((f) => f.json && f.json.type === 'response.completed').json;
    assert.match(completed.response.id, /^resp_/);
    assert.equal(completed.response.status, 'completed');
    assert.deepEqual(completed.response.usage, {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 14,
    });
    assert.equal(completed.response.output.length, 1);
    assert.equal(completed.response.output[0].content[0].text, 'Hello world');

    // 上游请求翻译
    assert.equal(upstream.requests.length, 1);
    const sentBody = upstream.requests[0].body;
    assert.equal(sentBody.stream, true);
    assert.deepEqual(sentBody.messages, [
      { role: 'system', content: 'You are Codex.' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(sentBody.prompt_cache_key, 'session-cache-key');
    assert.deepEqual(sentBody.stream_options, { include_usage: true });
    // 认证与自定义头
    assert.equal(upstream.requests[0].headers.authorization, 'Bearer sk-upstream-key');
    assert.equal(upstream.requests[0].headers['x-custom-trace'], 'trace-1');
    assert.equal(upstream.requests[0].url, '/v1/chat/completions');

    // 日志回调 + 内存环形日志
    const done = logs.filter((e) => e.status === 200 && e.ms !== undefined);
    assert.equal(done.length, 1);
    assert.equal(done[0].level, 'info');
    assert.equal(done[0].providerId, 'p_ab12cd');
    assert.equal(done[0].model, 'p_ab12cd__gpt-6.1-sol');
    assert.equal(done[0].tokens.total_tokens, 14);
    const ring = ctx.gw.getLogs();
    assert.equal(ring.length >= 1, true);
    assert.equal(typeof ring[ring.length - 1].at, 'number');
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('真实 codex 流量形状（probe/live-traffic.jsonl）：顶层键、developer 角色、namespace 工具', async () => {
  // 取自 Lead 真机验证抓到的 POST /v1/responses body（截断长文本，保留结构与值）。
  const REAL_BODY = {
    model: 'p_test__gpt-6.1-sol',
    instructions: 'You are Codex, a coding agent based on GPT-5.',
    input: [
      {
        type: 'message',
        id: 'msg_dev',
        role: 'developer',
        content: [{ type: 'input_text', text: '<skills_instructions>...</skills_instructions>' }],
      },
      {
        type: 'message',
        id: 'msg_u1',
        role: 'user',
        content: [{ type: 'input_text', text: 'Reply with exactly: PING-OK' }],
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'exec_command',
        description: 'Runs a command in a PTY.',
        strict: false,
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        },
      },
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        description: 'Tools for spawning and managing sub-agents.',
        tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
      },
      { type: 'web_search', external_web_access: false },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: '01a0fd6b-c512-7473-9767-fcf7003ceb94',
    client_metadata: { turn_id: '01a0fd6b-c569-74d2-9129-20467e4f29a5' },
  };

  const upstream = await startMockUpstream((req, res, body) => {
    // developer 消息并入 system；namespace/web_search 工具被跳过
    assert.deepEqual(body.messages, [
      {
        role: 'system',
        content:
          'You are Codex, a coding agent based on GPT-5.\n\n<skills_instructions>...</skills_instructions>',
      },
      { role: 'user', content: 'Reply with exactly: PING-OK' },
    ]);
    assert.deepEqual(
      body.tools.map((t) => t.function.name),
      ['exec_command'],
    );
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.store, undefined, 'store 不是 chat 参数，不能透传');
    assert.equal(body.prompt_cache_key, '01a0fd6b-c512-7473-9767-fcf7003ceb94', '会话缓存键需要转发给上游');
    assert.equal(body.client_metadata, undefined);
    writeChatSse(res, [
      { id: 'c5', choices: [{ index: 0, delta: { content: 'PING-OK' } }] },
      { id: 'c5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });

  const provider = {
    id: 'p_test',
    name: '测试中转',
    baseUrl: `${upstream.url}/v1`,
    apiKey: 'sk-live',
    api: 'openai',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true }],
  };
  const ctx = await withGateway({ providers: [provider] });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, REAL_BODY);
    assert.equal(res.status, 200);
    const frames = parseFrames(res.text);
    // Lead 真机验证过的、客户端完整接受的序列
    assert.deepEqual(
      frames.filter((f) => f.json).map((f) => f.json.type),
      [
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
      ],
    );
    const msgItem = frames.find((f) => f.json && f.json.type === 'response.output_item.done').json.item;
    assert.deepEqual(Object.keys(msgItem).sort(), ['content', 'id', 'role', 'status', 'type']);
    assert.deepEqual(msgItem.content, [{ type: 'output_text', text: 'PING-OK', annotations: [] }]);
    const completed = frames.find((f) => f.json && f.json.type === 'response.completed').json;
    assert.equal(completed.response.usage.input_tokens > 0, true);
    assert.equal(completed.response.usage.total_tokens > 0, true);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('非流式（stream:false）返回完整 response 对象', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-9',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'plain answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const ctx = await withGateway({ providers });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: false,
      input: 'hi',
    });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    const body = JSON.parse(res.text);
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.model, 'p_ab12cd__gpt-6.1-sol');
    assert.equal(body.output[0].type, 'message');
    assert.equal(body.output[0].content[0].text, 'plain answer');
    assert.equal(body.usage.total_tokens, 7);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('function_call（tools）双向转换 + 流式回写', async () => {
  const upstream = await startMockUpstream((req, res, body) => {
    // tools 转换断言
    assert.deepEqual(body.tools, [
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: [] },
        },
      },
    ]);
    assert.deepEqual(body.tool_choice, 'auto');
    assert.equal(body.parallel_tool_calls, true);
    writeChatSse(res, [
      {
        id: 'c2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_abc', type: 'function', function: { name: 'shell', arguments: '' } },
              ],
            },
          },
        ],
      },
      { id: 'c2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] },
      { id: 'c2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
      { id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const ctx = await withGateway({ providers });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'run ls',
      tools: [
        {
          type: 'function',
          name: 'shell',
          description: 'run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
          strict: false,
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
    const frames = parseFrames(res.text);
    const types = frames.filter((f) => f.json).map((f) => f.json.type);
    assert.deepEqual(types, [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const added = frames.find((f) => f.json && f.json.type === 'response.output_item.added').json;
    assert.equal(added.item.type, 'function_call');
    assert.equal(added.item.name, 'shell');
    assert.equal(added.item.call_id, 'call_abc');
    assert.equal(added.output_index, 0);

    const argsDone = frames.find((f) => f.json && f.json.type === 'response.function_call_arguments.done').json;
    assert.equal(argsDone.arguments, '{"command":"ls"}');
    assert.equal(argsDone.call_id, 'call_abc');

    const itemDone = frames.find((f) => f.json && f.json.type === 'response.output_item.done').json;
    assert.equal(itemDone.item.arguments, '{"command":"ls"}');
    assert.equal(itemDone.item.status, 'completed');

    const completed = frames.find((f) => f.json && f.json.type === 'response.completed').json;
    assert.equal(completed.response.output[0].type, 'function_call');
    assert.equal(completed.response.output[0].call_id, 'call_abc');
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('reasoning（reasoning_content）映射为 reasoning_summary 事件', async () => {
  const upstream = await startMockUpstream((req, res) => {
    writeChatSse(res, [
      { id: 'c3', choices: [{ index: 0, delta: { reasoning_content: '先想' } }] },
      { id: 'c3', choices: [{ index: 0, delta: { reasoning_content: '再算' } }] },
      { id: 'c3', choices: [{ index: 0, delta: { content: '答案' } }] },
      { id: 'c3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const ctx = await withGateway({ providers });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'hi',
      reasoning: { effort: 'medium' },
    });
    const frames = parseFrames(res.text);
    const types = frames.filter((f) => f.json).map((f) => f.json.type);
    assert.deepEqual(types, [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const reasoningDone = frames.find(
      (f) => f.json && f.json.type === 'response.reasoning_summary_text.done',
    ).json;
    assert.equal(reasoningDone.text, '先想再算');
    const itemDone = frames.filter((f) => f.json && f.json.type === 'response.output_item.done')[0].json;
    assert.equal(itemDone.item.type, 'reasoning');
    assert.deepEqual(itemDone.item.summary, [{ type: 'summary_text', text: '先想再算' }]);
    const completed = frames.find((f) => f.json && f.json.type === 'response.completed').json;
    assert.deepEqual(
      completed.response.output.map((item) => item.type),
      ['reasoning', 'message'],
    );
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('anthropic 提供商：走 /v1/messages，x-api-key + anthropic-version，事件同样映射', async () => {
  const upstream = await startMockUpstream((req, res, body) => {
    assert.equal(body.model, 'claude-sonnet-4');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.system, [
      { type: 'text', text: 'You are Codex.', cache_control: { type: 'ephemeral' } },
    ]);
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    writeAnthropicSse(res, [
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
  });
  const provider = {
    id: 'p_anth01',
    name: 'Claude 中转',
    baseUrl: `${upstream.url}/v1`,
    apiKey: 'sk-ant-key',
    api: 'anthropic',
    headers: {},
    enabled: true,
    models: [{ id: 'claude-sonnet-4', label: 'Sonnet 4', enabled: true }],
  };
  const ctx = await withGateway({ providers: [provider] });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_anth01__claude-sonnet-4',
      stream: true,
      instructions: 'You are Codex.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      max_output_tokens: 4096,
    });
    assert.equal(res.status, 200);
    const frames = parseFrames(res.text);
    assert.deepEqual(
      frames.filter((f) => f.json).map((f) => f.json.type),
      [
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
      ],
    );
    assert.equal(frames.find((f) => f.json && f.json.type === 'response.output_text.done').json.text, '你好世界');
    const usage = frames.find((f) => f.json && f.json.type === 'response.completed').json.response.usage;
    assert.equal(usage.input_tokens, 14, '输入统计应包含未缓存、缓存读取与缓存写入 Token');
    assert.equal(usage.output_tokens, 5);
    assert.equal(usage.input_tokens_details.cached_tokens, 5);
    assert.equal(usage.input_tokens_details.cache_write_tokens, 2);
    assert.equal(usage.total_tokens, 19);

    const sent = upstream.requests[0];
    assert.equal(sent.url, '/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'sk-ant-key');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.headers.authorization, undefined);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 失败路径 / 兼容重试 / 生命周期 / 环形日志
// ---------------------------------------------------------------------------

test('上游 5xx -> 502 JSON 错误，且写入 error 日志', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'hi',
    });
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.text).error.message, 'upstream exploded');
    const errorLog = logs.find((e) => e.level === 'error');
    assert.ok(errorLog, '应有 error 日志');
    assert.equal(errorLog.status, 502);
    assert.equal(errorLog.providerId, 'p_ab12cd');
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('客户端在上游响应前断开仍写入唯一 499 终结记录', async () => {
  let upstreamResponse = null;
  let upstreamStarted;
  const upstreamReady = new Promise((resolve) => {
    upstreamStarted = resolve;
  });
  const upstream = await startMockUpstream((req, res) => {
    upstreamResponse = res;
    upstreamStarted();
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const client = http.request(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const clientClosed = new Promise((resolve) => {
      client.once('close', resolve);
      client.once('error', () => {});
    });
    client.end(JSON.stringify({
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: false,
      input: 'disconnect before upstream response',
    }));

    await upstreamReady;
    client.destroy();
    await clientClosed;

    let finalLogs = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const startLog = logs.find((entry) => entry.msg === '开始请求 p_ab12cd__gpt-6.1-sol');
      finalLogs = startLog ? logs.filter((entry) => entry.requestId === startLog.requestId && entry.final === true) : [];
      if (finalLogs.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const startLog = logs.find((entry) => entry.msg === '开始请求 p_ab12cd__gpt-6.1-sol');
    assert.ok(startLog, '应先写入请求起点日志');
    assert.equal(finalLogs.length, 1, '客户端断开只能写入一条终结记录');
    assert.equal(finalLogs[0].requestId, startLog.requestId);
    assert.equal(finalLogs[0].status, 499);
    assert.match(finalLogs[0].msg, /^客户端中断:/);
  } finally {
    if (upstreamResponse && !upstreamResponse.writableEnded) upstreamResponse.end();
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('流式客户端断开时保留已经收到的 usage 和缓存命中字段', async () => {
  let upstreamResponse = null;
  const upstream = await startMockUpstream((req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({
      id: 'partial-usage',
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'partial-usage',
      choices: [{ index: 0, delta: { content: 'partial output' } }],
    })}\n\n`);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const client = http.request(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    let responseText = '';
    const outputReceived = new Promise((resolve) => {
      client.once('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseText += chunk;
          if (responseText.includes('partial output')) resolve();
        });
      });
    });
    client.once('error', () => {});
    client.end(JSON.stringify({
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'disconnect after usage',
    }));

    await outputReceived;
    client.destroy();

    let finalLog = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      finalLog = logs.find((entry) => entry.final === true && entry.status === 499);
      if (finalLog) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(finalLog, '客户端断开后应有 499 终结记录');
    assert.equal(finalLog.tokens.input_tokens, 10);
    assert.equal(finalLog.tokens.input_tokens_details.cached_tokens, 4);
    assert.equal(finalLog.tokens.output_tokens, 2);
    assert.equal(finalLog.tokens.total_tokens, 12);
    assert.equal(finalLog.cacheUsageAvailable, true);
  } finally {
    if (upstreamResponse && !upstreamResponse.writableEnded) upstreamResponse.end();
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('上游 502 Unknown error 且提示不兼容参数时也自动降级重试', async () => {
  let calls = 0;
  const upstream = await startMockUpstream((req, res, body) => {
    calls += 1;
    if (body.stream_options || body.reasoning_effort || body.max_tokens) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown error: unsupported reasoning_effort' } }));
      return;
    }
    writeChatSse(res, [
      { id: 'c502', choices: [{ index: 0, delta: { content: 'ok after 502 retry' } }] },
      { id: 'c502', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'hi',
      max_output_tokens: 128,
      reasoning: { effort: 'medium' },
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.match(res.text, /ok after 502 retry/);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('上游 400 报可选参数错误时去掉可选参数重试一次（compat）', async () => {
  let calls = 0;
  const upstream = await startMockUpstream((req, res, body) => {
    calls += 1;
    if (body.stream_options || body.reasoning_effort || body.max_tokens) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unsupported parameter: stream_options' } }));
      return;
    }
    writeChatSse(res, [
      { id: 'c4', choices: [{ index: 0, delta: { content: 'ok after retry' } }] },
      { id: 'c4', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      prompt_cache_key: 'session-cache-key',
      input: 'hi',
      max_output_tokens: 128,
      reasoning: { effort: 'medium' },
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 2, '应重试一次');
    const frames = parseFrames(res.text);
    assert.equal(frames.find((f) => f.json && f.json.type === 'response.output_text.done').json.text, 'ok after retry');
    assert.equal(upstream.requests[0].body.prompt_cache_key, 'session-cache-key');
    assert.equal(upstream.requests[1].body.stream_options, undefined);
    assert.equal(upstream.requests[1].body.max_tokens, undefined);
    assert.equal(upstream.requests[1].body.prompt_cache_key, undefined);
    assert.ok(logs.some((e) => e.level === 'warn' && /兼容请求重试/.test(e.msg)));
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('autoStart 读 store.gateway：enabled 启动、disabled 停止、端口占用不抛', async () => {
  const store = makeStore([SAMPLE_PROVIDER], { enabled: true, port: 0, host: '127.0.0.1', token: 'tk' });
  const gw = createGateway({ store });
  try {
    await gw.autoStart();
    const running = gw.getState();
    assert.equal(running.running, true);
    assert.ok(running.port > 0);
    assert.equal(running.url, `http://127.0.0.1:${running.port}/v1`);
    assert.equal((await gw.probe()).ok, true);

    const res = await fetch(`${running.url}/models`, { headers: { Authorization: 'Bearer tk' } });
    assert.equal(res.status, 200);

    await gw.stop();
    assert.equal(gw.getState().running, false);
    assert.equal((await gw.probe()).ok, false);

    store.update((draft) => {
      draft.gateway.enabled = false;
    });
    await gw.autoStart();
    assert.equal(gw.getState().running, false);
  } finally {
    gw.stopSync();
  }
});

test('端点冲突：端口被占用时 start() 抛出可读错误', async () => {
  const blocker = http.createServer((req, res) => res.end('busy'));
  const port = await listen(blocker);
  const store = makeStore([SAMPLE_PROVIDER], { enabled: true, port });
  const gw = createGateway({ store });
  try {
    await assert.rejects(() => gw.start({ port, host: '127.0.0.1', token: '' }), /端口 \d+ 已被占用/);
    assert.equal(gw.getState().running, false);
  } finally {
    gw.stopSync();
    await closeServer(blocker);
  }
});

test('内存环形日志最多保留 200 条，且 on("log") 可取消订阅', async () => {
  const ctx = await withGateway();
  const seen = [];
  const off = ctx.gw.on('log', (entry) => seen.push(entry));
  try {
    for (let i = 0; i < 205; i += 1) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `p_missing_${i}__m` }),
      });
      assert.equal(res.status, 404);
      await res.arrayBuffer();
    }
    assert.equal(seen.length, 205);
    const ring = ctx.gw.getLogs();
    assert.equal(ring.length, 200);
    assert.equal(ring[ring.length - 1].status, 404);
    off();
    const next = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
    await next.arrayBuffer();
    // healthz 不写日志，用一个 404 再验证订阅已取消
    const oneMore = await fetch(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    await oneMore.arrayBuffer();
    assert.equal(seen.length, 205);
  } finally {
    await ctx.gw.stop();
  }
});

test('gateway.getState() 停止后仍报告配置端口，start 幂等', async () => {
  const store = makeStore([SAMPLE_PROVIDER], { enabled: true, port: 18120 });
  const gw = createGateway({ store });
  try {
    assert.equal(gw.getState().port, 18120);
    const first = await gw.start({ port: 0, host: '127.0.0.1', token: '' });
    const second = await gw.start({ port: first.port, host: '127.0.0.1', token: '' });
    assert.equal(second.port, first.port, '同参数 start 应复用已运行的 server');
    await gw.stop();
    assert.equal(gw.getState().port, 18120, '停止后回落到配置端口，便于 UI 展示');
  } finally {
    gw.stopSync();
  }
});

// ---------------------------------------------------------------------------
// 5. 适配器/契约纯函数单测
// ---------------------------------------------------------------------------

test('openai 适配器：Responses input -> chat messages 全类型覆盖', () => {
  const { toMessages, toTools, buildRequest } = openaiAdapter;
  const messages = toMessages({
    instructions: 'SYS',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEV' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'ignored' }] },
    ],
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'SYS\n\nDEV' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
  ]);

  assert.deepEqual(
    toMessages({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: { url: 'https://example.com/image.png' } }],
      }],
    }),
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }],
  );

  assert.deepEqual(toTools([{ type: 'function', name: 'f', parameters: { type: 'object' } }]), [
    { type: 'function', function: { name: 'f', description: '', parameters: { type: 'object', properties: {}, required: [] } } },
  ]);

  const built = buildRequest({
    provider: { baseUrl: 'https://example.com/v1', apiKey: 'k' },
    modelId: 'm',
    body: { input: 'x', prompt_cache_key: 'session-cache-key' },
    stream: false,
  });
  assert.equal(built.url, 'https://example.com/v1/chat/completions');
  assert.equal(built.headers.Authorization, 'Bearer k');
  assert.equal(built.payload.stream_options, undefined, '非流式不应带 stream_options');
  assert.equal(built.payload.prompt_cache_key, 'session-cache-key');

  const compat = buildRequest({
    provider: { baseUrl: 'https://example.com/v1', apiKey: 'k' },
    modelId: 'm',
    body: { input: 'x', prompt_cache_key: 'session-cache-key' },
    stream: true,
    compat: true,
  });
  assert.equal(compat.payload.prompt_cache_key, undefined, '兼容请求应去掉可能不受支持的缓存键');

  const noVersion = buildRequest({
    provider: { baseUrl: 'https://example.com', apiKey: 'k' },
    modelId: 'm',
    body: { input: 'x' },
    stream: true,
  });
  assert.equal(noVersion.url, 'https://example.com/v1/chat/completions', 'baseUrl 无 /v1 时补齐');
});

test('anthropic 适配器：tool_use/tool_result 双向 + 相邻同角色合并', () => {
  const { toAnthropicMessages, toAnthropicTools, buildRequest } = anthropicAdapter;
  const { system, messages } = toAnthropicMessages({
    instructions: 'SYS',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] },
      { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  });
  assert.equal(system, 'SYS');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
  });
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: { command: 'ls' } }],
  });
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
  });

  const imageInput = toAnthropicMessages({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: { url: 'https://example.com/image.png' } }],
    }],
  });
  assert.deepEqual(imageInput.messages, [{
    role: 'user',
    content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }],
  }]);

  assert.deepEqual(toAnthropicTools([{ type: 'function', name: 'f', parameters: { type: 'object' } }]), [
    { name: 'f', description: '', input_schema: { type: 'object', properties: {}, required: [] } },
  ]);

  const built = buildRequest({
    provider: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' },
    modelId: 'claude',
    body: { instructions: 'You are Codex.', input: 'hi' },
    stream: true,
  });
  assert.equal(built.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(built.payload.max_tokens, 8192, 'Anthropic 要求 max_tokens');
  assert.deepEqual(built.payload.system, [
    { type: 'text', text: 'You are Codex.', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(built.payload.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]);
  assert.equal(built.headers['x-api-key'], 'k');
  assert.equal(built.headers['anthropic-version'], '2023-06-01');

  // 兼容重试时去掉缓存断点，避免老上游因 cache_control 报错
  const compat = buildRequest({
    provider: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' },
    modelId: 'claude',
    body: { instructions: 'You are Codex.', input: 'hi' },
    stream: true,
    compat: true,
  });
  assert.equal(compat.payload.system, 'You are Codex.');
  assert.deepEqual(compat.payload.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]);

  const withTools = buildRequest({
    provider: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' },
    modelId: 'claude',
    body: {
      instructions: 'You are Codex.',
      input: 'hi',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    },
    stream: true,
  });
  assert.equal(withTools.payload.system, 'You are Codex.', '有工具时断点应放到工具列表末尾');
  assert.deepEqual(withTools.payload.tools[0].cache_control, { type: 'ephemeral' });
});

test('适配器：工具 parameters 必须补齐成合法对象 schema（严格上游会整轮 400）', () => {
  // Codex 内建工具（list_mcp_resources 等）没有必填参数时，serde 把 Option::None
  // 序列化成 "required": null。OpenAI 直连容忍，但严格的 OpenAI 兼容上游按
  // JSON Schema 元模式校验 -> 400 Invalid schema for function 'x':
  // null is not of type "array"（实测 required 缺失同样会被补成 null 而报同一个错）。
  const codexTool = {
    type: 'function',
    name: 'list_mcp_resources',
    description: 'Lists resources provided by MCP servers.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name.' },
        cursor: { type: null, description: 'Opaque cursor.' },
      },
      required: null,
      additionalProperties: false,
    },
  };
  const cleaned = {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name.' },
      cursor: { description: 'Opaque cursor.' },
    },
    additionalProperties: false,
    required: [],
  };

  const [chatTool] = openaiAdapter.toTools([codexTool]);
  assert.deepEqual(chatTool.function.parameters, cleaned);

  const [anthropicTool] = anthropicAdapter.toAnthropicTools([codexTool]);
  assert.deepEqual(anthropicTool.input_schema, cleaned);

  // 缺 required / 缺 properties 也要补成数组与对象
  const [noRequired] = openaiAdapter.toTools([{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }]);
  assert.deepEqual(noRequired.function.parameters, { type: 'object', properties: {}, required: [] });
  const [noProperties] = openaiAdapter.toTools([{ type: 'function', name: 'f', parameters: { type: 'object', required: [] } }]);
  assert.deepEqual(noProperties.function.parameters, { type: 'object', properties: {}, required: [] });

  // chat 形状的工具此前是整对象透传，同样要清洗，但其余字段保持原样
  const [nested] = openaiAdapter.toTools([
    { type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {}, required: null } }, strict: true },
  ]);
  assert.deepEqual(nested, { type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {}, required: [] } }, strict: true });

  // parameters 缺失或为 null：补一个合法的空对象 schema
  const [bare] = openaiAdapter.toTools([{ type: 'function', name: 'g', description: 'd', parameters: null }]);
  assert.deepEqual(bare.function.parameters, { type: 'object', properties: {}, required: [] });

  // enum 里的 null 是数据不是关键字，必须保留
  const [withEnum] = openaiAdapter.toTools([
    { type: 'function', name: 'h', parameters: { type: 'object', properties: { a: { type: 'string', enum: ['x', null] } } } },
  ]);
  assert.deepEqual(withEnum.function.parameters.properties.a.enum, ['x', null]);
});

test('responses SSE 透传：客户端断开后不再写入或消费上游', async () => {
  let yielded = 0;
  const upstream = {
    body: {
      async *[Symbol.asyncIterator]() {
        yielded += 1;
        yield Buffer.from('data: {"type":"response.created"}\n\n');
        yielded += 1;
        yield Buffer.from('data: {"type":"response.completed"}\n\n');
      },
    },
  };
  const res = {
    destroyed: true,
    writableEnded: false,
    on() {},
    write() { throw new Error('write after disconnect'); },
  };

  await assert.doesNotReject(() => pipeResponsesSse(upstream, res, { events: 0 }));
  assert.equal(yielded, 1, '客户端不可写时应停止读取上游');
});

test('responses.js：SSE 解析容忍 event 名、多行 data、CRLF 与心跳注释', async () => {
  const { parseSse } = require('../src/core/gateway/responses.js');
  async function* body() {
    yield 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"a"}\r\n\r\n';
    yield ': keep-alive\n\n';
    yield 'data: {"a":1}\ndata: {"b":2}\n\n';
    yield 'data: [DONE]\n\n';
  }
  const frames = [];
  for await (const frame of parseSse(body())) frames.push(frame);
  assert.deepEqual(frames, [
    { event: 'response.output_text.delta', data: '{"type":"response.output_text.delta","delta":"a"}' },
    { event: null, data: '{"a":1}\n{"b":2}' },
    { event: null, data: '[DONE]' },
  ]);
});

test('createGateway 有 fetch 缺失保护，且不需要 electron', () => {
  const store = makeStore([SAMPLE_PROVIDER]);
  assert.throws(() => createGateway({ store, fetch: 'nope', log: () => {} }), /fetch/);
  const gw = createGateway({ store });
  assert.equal(typeof gw.start, 'function');
  assert.equal(typeof gw.stop, 'function');
  assert.equal(typeof gw.stopSync, 'function');
  assert.equal(typeof gw.getState, 'function');
  assert.equal(typeof gw.autoStart, 'function');
  assert.equal(typeof gw.probe, 'function');
  assert.equal(typeof gw.on, 'function');
});

// ---------------------------------------------------------------------------
// N. Responses 透传适配器（api: 'responses'）
// ---------------------------------------------------------------------------

const responsesAdapter = require('../src/core/gateway/adapters/responses.js');

test('responses 适配器：buildRequest 只改写 model，其余字段原样转发', () => {
  const provider = { baseUrl: 'https://relay.example/v1', apiKey: 'sk-resp', headers: { 'X-Trace': 't1' } };
  const body = {
    model: 'p_resp01__gpt-6.1-sol',
    instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{ type: 'custom', name: 'apply_patch' }],
    reasoning: { effort: 'xhigh' },
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
  };
  const built = responsesAdapter.buildRequest({ provider, modelId: 'gpt-6.1-sol', body });
  assert.equal(built.url, 'https://relay.example/v1/responses');
  assert.equal(built.headers.Authorization, 'Bearer sk-resp');
  assert.equal(built.headers['X-Trace'], 't1');
  // 转换适配器会丢弃 tools/reasoning/include：透传必须原样保留
  assert.deepEqual(built.payload, { ...body, model: 'gpt-6.1-sol' });
  assert.equal(built.payload.model, 'gpt-6.1-sol');
  // baseUrl 不带 /v1 时按规则补齐
  const bare = responsesAdapter.buildRequest({
    provider: { baseUrl: 'https://relay.example', apiKey: '', headers: {} },
    modelId: 'm1',
    body: {},
  });
  assert.equal(bare.url, 'https://relay.example/v1/responses');
});

test('gateway: responses 透传（流式）逐字节转发，只改写 model，并记录 usage', async () => {
  const upstreamSse = [
    'event: response.created',
    'data: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_up1', object: 'response', status: 'in_progress' } }),
    '',
    'event: response.output_item.added',
    'data: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_enc1', type: 'reasoning', summary: [], encrypted_content: 'ENCEXT-abc' } }),
    '',
    'event: response.output_text.delta',
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'pong' }),
    '',
    'event: response.completed',
    'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_up1', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }),
    '',
    '',
  ].join('\n');

  const upstream = await startMockUpstream((req, res, json) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(json.model, 'gpt-6.1-sol'); // slug 已改写
    assert.equal(json.instructions, 'be brief');
    assert.deepEqual(json.reasoning, { effort: 'xhigh' });
    assert.deepEqual(json.include, ['reasoning.encrypted_content']);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write(upstreamSse);
    res.end();
  });

  const provider = {
    id: 'p_resp01',
    name: '原生 Responses',
    baseUrl: upstream.url + '/v1',
    apiKey: 'sk-resp',
    api: 'responses',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'sol', enabled: true, reasoning: true }],
  };
  const logs = [];
  const ctx = await withGateway({ providers: [provider], logs });
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'p_resp01__gpt-6.1-sol',
        instructions: 'be brief',
        input: '你好',
        reasoning: { effort: 'xhigh' },
        include: ['reasoning.encrypted_content'],
        store: false,
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    // 逐字节透传：encrypted_content 等原生字段原样到达客户端
    assert.equal(text, upstreamSse);

    const done = logs.find((l) => l.msg && l.msg.startsWith('完成'));
    assert.ok(done, '应有完成日志');
    assert.equal(done.status, 200);
    assert.equal(done.tokens && done.tokens.total_tokens, 12);
    assert.ok(done.events >= 4);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('gateway: Responses 上游瞬时 502 -> 只重试一次并成功', async () => {
  let hits = 0;
  const upstream = await startMockUpstream((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_retry',
      object: 'response',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
  });
  const provider = {
    id: 'p_resp01',
    name: '原生 Responses',
    baseUrl: upstream.url + '/v1',
    apiKey: 'sk-resp',
    api: 'responses',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'sol', enabled: true }],
  };
  const logs = [];
  const ctx = await withGateway({ providers: [provider], logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_resp01__gpt-6.1-sol',
      input: '你好',
      stream: false,
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).id, 'resp_retry');
    assert.equal(hits, 2);
    assert.ok(logs.some((entry) => entry.msg.includes('短暂重试一次')));
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});
test('gateway: responses 透传（非流式）原样转发 JSON', async () => {
  const responseObject = {
    id: 'resp_ns1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  };
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseObject));
  });
  const provider = {
    id: 'p_resp01',
    name: '原生 Responses',
    baseUrl: upstream.url + '/v1',
    apiKey: 'sk-resp',
    api: 'responses',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'sol', enabled: true }],
  };
  const ctx = await withGateway({ providers: [provider] });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_resp01__gpt-6.1-sol',
      input: '你好',
      stream: false,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), responseObject);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('gateway: responses 透传上游 5xx 直接 502，不做 compat 重试', async () => {
  let hits = 0;
  const upstream = await startMockUpstream((req, res) => {
    hits += 1;
    // 报错文本刻意匹配 COMPAT_TRIGGER（openai 适配器会因此重试一次）
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unknown error' } }));
  });
  const provider = {
    id: 'p_resp01',
    name: '原生 Responses',
    baseUrl: upstream.url + '/v1',
    apiKey: 'sk-resp',
    api: 'responses',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'sol', enabled: true }],
  };
  const logs = [];
  const ctx = await withGateway({ providers: [provider], logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_resp01__gpt-6.1-sol',
      input: '你好',
      stream: false,
    });
    assert.equal(res.status, 502);
    assert.match(res.text, /Unknown error/);
    assert.equal(hits, 1, '透传模式不应触发兼容重试');
    const fail = logs.find((l) => l.msg && l.msg.startsWith('上游请求失败'));
    assert.ok(fail, '应有失败日志');
    assert.equal(fail.status, 502);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('gateway: responses 透传提前 EOF -> 补发单个失败收口并记日志', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.end(
      'event: response.created\n' +
        'data: ' +
        JSON.stringify({ type: 'response.created', response: { id: 'resp_incomplete', status: 'in_progress' } }) +
        '\n\n' +
        'event: response.output_text.delta\n' +
        'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }) +
        '\n\n',
    );
  });
  const provider = {
    id: 'p_resp01',
    name: '原生 Responses',
    baseUrl: upstream.url + '/v1',
    apiKey: 'sk-resp',
    api: 'responses',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'sol', enabled: true }],
  };
  const logs = [];
  const ctx = await withGateway({ providers: [provider], logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_resp01__gpt-6.1-sol',
      input: '你好',
      stream: true,
    });
    assert.equal(res.status, 200);
    const frames = parseFrames(res.text);
    assert.equal(frames.filter((frame) => frame.json?.type === 'response.failed').length, 1);
    assert.match(res.text, /response\.completed 之前结束/);
    assert.ok(logs.some((l) => l.msg === '流式转发失败: 上游响应在 response.completed 之前结束'));
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});


test('gateway: responses 透传上游中途 response.failed -> 原样转发且不重复补帧', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(
      'event: response.created\n' +
        'data: ' +
        JSON.stringify({ type: 'response.created', response: { id: 'resp_fail1', object: 'response', status: 'in_progress' } }) +
        '\n\n',
    );
    res.write(
      'event: response.failed\n' +
        'data: ' +
        JSON.stringify({
          type: 'response.failed',
          response: { id: 'resp_fail1', status: 'failed', error: { code: 'upstream_error', message: 'model exploded' } },
        }) +
        '\n\n',
    );
    res.end();
  });
  const provider = {
    id: 'p_resp01',
    name: '原生 Responses',
    baseUrl: upstream.url + '/v1',
    apiKey: 'sk-resp',
    api: 'responses',
    headers: {},
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'sol', enabled: true }],
  };
  const logs = [];
  const ctx = await withGateway({ providers: [provider], logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_resp01__gpt-6.1-sol',
      input: '你好',
      stream: true,
    });
    assert.equal(res.status, 200); // SSE 已出 200，失败在流里收口
    const text = res.text;
    assert.match(text, /response\.failed/);
    assert.match(text, /model exploded/);
    const frames = parseFrames(text);
    assert.equal(frames.filter((frame) => frame.json?.type === 'response.failed').length, 1, '上游已发失败帧时网关不应重复补发');
    const fail = logs.find((l) => l.msg && l.msg.startsWith('上游返回失败事件'));
    assert.ok(fail, '应有失败事件日志');
    assert.equal(fail.status, 502);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 重试分类（回归）
// ---------------------------------------------------------------------------

test('非透传上游 503（与参数无关）原样重试一次后成功', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (upstream.requests.length === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'backend busy' } }));
      return;
    }
    writeChatSse(res, [
      { id: 'c503', choices: [{ index: 0, delta: { content: 'ok after 503' } }] },
      { id: 'c503', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const logs = [];
  const ctx = await withGateway({ providers, logs });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'hi',
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /ok after 503/);
    assert.equal(upstream.requests.length, 2, '瞬时错误应重试一次');
    assert.ok(logs.some((e) => e.level === 'warn' && /临时错误/.test(e.msg)));
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('上游 404（地址填错）不做兼容重发，状态码原样转给客户端', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unsupported route: /v1/chat/completions' } }));
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const ctx = await withGateway({ providers });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'hi',
      max_output_tokens: 64,
    });
    assert.equal(upstream.requests.length, 1, '404 重发一次也是错，纯属浪费');
    assert.equal(res.status, 404);
    assert.match(res.text, /Unsupported route/);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});

test('502 且报错提到可选参数时优先兼容重试（总共只重发一次）', async () => {
  const upstream = await startMockUpstream((req, res, body) => {
    if (body && (body.stream_options || body.reasoning_effort || body.max_tokens)) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown error: unsupported reasoning_effort' } }));
      return;
    }
    writeChatSse(res, [
      { id: 'c502b', choices: [{ index: 0, delta: { content: 'compat ok' } }] },
      { id: 'c502b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  const providers = [{ ...SAMPLE_PROVIDER, baseUrl: `${upstream.url}/v1` }];
  const ctx = await withGateway({ providers });
  try {
    const res = await postJson(`http://127.0.0.1:${ctx.port}/v1/responses`, {
      model: 'p_ab12cd__gpt-6.1-sol',
      stream: true,
      input: 'hi',
      reasoning: { effort: 'medium' },
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.requests.length, 2, '不能先原样重发再兼容重发（那是 3 次）');
    assert.equal(upstream.requests[1].body.reasoning_effort, undefined);
    assert.match(res.text, /compat ok/);
  } finally {
    await ctx.gw.stop();
    await upstream.close();
  }
});
