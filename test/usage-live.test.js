'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageLiveReader, usageEvent } = require('../src/core/usage-live.js');
const { buildUsageStatuslineScript } = require('../src/core/usage-statusline.js');
const {
  launchChatGptWithUsageStatusline,
  resumeUsageStatusline,
  startUsageStatuslineBridge,
  usageStatuslineEndpoint,
} = require('../src/core/chatgpt-statusline.js');

test('live usage reader returns token_count data for the requested local session', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-usage-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions', '2026', '10');
  fs.mkdirSync(sessions, { recursive: true });
  const id = 'thread_12345678';
  const file = path.join(sessions, `${id}.jsonl`);
  const records = [
    { type: 'turn_context', payload: { turn_id: 'turn_1' } },
    { type: 'event_msg', timestamp: '2026-10-25T10:00:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110 }, total_token_usage: { output_tokens: 10 }, model_context_window: 1000 } } },
    { type: 'event_msg', timestamp: '2026-10-25T10:00:02.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, total_tokens: 120 }, total_token_usage: { output_tokens: 20 }, model_context_window: 1000 } } },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

  const result = createUsageLiveReader({ codexHome: home }).read(`local:${id}`);
  assert.equal(result.status, 'ok');
  assert.equal(result.session_id, id);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[1].cached_input_tokens, 50);
  assert.equal(result.events[1].turn_output_tokens, 20);
  assert.equal(result.events[1].context_window, 1000);
  assert.equal(Object.hasOwn(result.events[1], 'text'), false, 'message bodies must not be exposed');
});

test('live usage reader prefers a continuation rollout that contains token_count events', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-usage-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions', '2026', '10', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const id = '01a182d9-259f-7b40-81da-d83babe58651';
  const primary = path.join(sessions, `${id}.jsonl`);
  const continuation = path.join(sessions, `rollout-2026-10-28T22-12-16-${id}_01a182da-bfc2-7d03-a302-6f335986f17b.jsonl`);
  fs.writeFileSync(primary, `${JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn_empty' } })}\n`);
  const records = [
    { type: 'turn_context', payload: { turn_id: 'turn_live' } },
    { type: 'event_msg', timestamp: '2026-10-28T13:12:20.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 80, total_tokens: 1280 }, total_token_usage: { output_tokens: 80 }, model_context_window: 200000 } } },
  ];
  fs.writeFileSync(continuation, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

  const reader = createUsageLiveReader({ codexHome: home });
  const result = reader.read(`local:${id}`);
  assert.equal(result.status, 'ok');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].cached_input_tokens, 900);
  assert.equal(result.events[0].context_window, 200000);
  assert.equal(reader.resolveRolloutPath(id), continuation, '空的主 rollout 不能遮蔽包含用量的续接文件');
});

test('live usage reader incrementally exposes newly appended token_count events', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-usage-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions', '2026', '10', '29');
  fs.mkdirSync(sessions, { recursive: true });
  const id = 'thread_incremental_1';
  const file = path.join(sessions, `${id}.jsonl`);
  const first = [
    { type: 'turn_context', payload: { turn_id: 'turn_live' } },
    { type: 'event_msg', timestamp: '2026-10-29T01:00:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, total_token_usage: { output_tokens: 10 }, model_context_window: 1000 } } },
  ];
  fs.writeFileSync(file, first.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const reader = createUsageLiveReader({ codexHome: home });
  assert.equal(reader.read(id).events.at(-1).turn_output_tokens, 10);

  const next = { type: 'event_msg', timestamp: '2026-10-29T01:00:01.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, total_token_usage: { output_tokens: 30 }, model_context_window: 1000 } } };
  fs.appendFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
  const updated = reader.read(id);
  assert.equal(updated.events.length, 2);
  assert.equal(updated.events.at(-1).turn_output_tokens, 30);
  assert.equal(updated.events.filter((event) => event.output_tokens === 10).length, 1, '旧事件不能被重复解析');
});

test('live usage reader refreshes path resolution when a newer continuation appears', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-usage-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions', '2026', '10', '29');
  fs.mkdirSync(sessions, { recursive: true });
  const id = 'thread_continuation_2';
  const primary = path.join(sessions, `${id}.jsonl`);
  fs.writeFileSync(primary, [
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn_old' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-10-29T01:00:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, total_token_usage: { output_tokens: 10 }, model_context_window: 1000 } } }),
  ].join('\n') + '\n');
  const reader = createUsageLiveReader({ codexHome: home, resolutionTtlMs: 0 });
  assert.equal(reader.read(id).events.at(-1).turn_output_tokens, 10);

  const continuation = path.join(sessions, `rollout-2026-10-29T01-00-01-${id}.jsonl`);
  fs.writeFileSync(continuation, [
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn_new' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-10-29T01:00:02.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, total_token_usage: { output_tokens: 20 }, model_context_window: 1000 } } }),
  ].join('\n') + '\n');
  const updated = reader.read(id);
  assert.equal(updated.events.at(-1).turn_output_tokens, 20);
  assert.equal(reader.resolveRolloutPath(id), continuation);
});

test('live usage reader rejects invalid ids and rollout paths outside session folders', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-usage-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'outside_thread_12345678.jsonl'), '{}');
  const reader = createUsageLiveReader({ codexHome: home });

  assert.equal(reader.read('../thread_12345678').status, 'unavailable');
  assert.equal(reader.read('constructor').status, 'unavailable');
  assert.equal(reader.read('thread_12345678').status, 'unavailable');
});

test('usage event derives total Tokens when the rollout omits total_tokens', () => {
  const event = usageEvent({
    type: 'event_msg',
    timestamp: '2026-10-29T02:00:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
        model_context_window: 1000,
      },
    },
  }, 'turn_1');

  assert.equal(event.total_tokens, 120);
});

test('usage statusline script retains the composer placement, icons, and valid syntax', () => {
  const script = buildUsageStatuslineScript({ readyWaitMs: 2000 });
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /\[data-composer-surface-variant\]/);
  assert.match(script, /M2 12\.5a6 6 0 0 1 12 0/);
  assert.match(script, /cached_input_tokens/);
  assert.match(script, /context_window/);
  assert.match(script, /turn_output_tokens/);
  assert.match(script, /document\.hidden/);
  assert.match(script, /if \(!card\)/);
  assert.match(script, /__gptplusUsageStatuslineDispose\?\.\(\)/);
  assert.match(script, /if \(!document\.body\)/, 'must wait for body before observing');
  assert.match(script, /__gptplusUsageStatusline/);
  assert.match(script, /READY_WAIT_MS = 2000/);
  assert.match(script, /SYNC_INTERVAL_MS = 1000/);
  assert.match(script, /gptplus-usage-statusline-v7/);
  assert.match(script, /request\.speed/);
  assert.match(script, /function apply\(id, events, request\)/);
  assert.match(script, /requestTime >= latestTime - 15000/);
  assert.match(script, /opacity:1!important/);
  assert.match(script, /color:var\(--color-token-text-primary,#000\)!important/);
  assert.ok(script.includes('html[data-theme=\\"light\\"] #gptplus-codex-usage-statusline'));
  assert.match(script, /gptplus-usage-item svg\{flex:0 0 auto\}/);
  assert.doesNotMatch(script, /data-stale=.*gptplus-usage-item\{opacity:\.55\}/);
  assert.doesNotMatch(script, /fetch\(endpoint/);
});

test('statusline launch starts the gateway first and shares one CDP injection path', async () => {
  const calls = [];
  let gatewayState = { running: false, port: 18120, host: '127.0.0.1' };
  const ctx = {
    store: { get: () => ({ gateway: { port: 18120, host: '127.0.0.1', token: 'gateway-token' } }) },
    gateway: {
      getState: () => gatewayState,
      start: async (options) => {
        calls.push(['gateway', options]);
        gatewayState = { ...gatewayState, running: true };
      },
    },
    log: () => {},
  };

  const result = await launchChatGptWithUsageStatusline({
    ctx,
    launchOptions: { preferredPath: 'C:\\ChatGPT.exe' },
    wrapperDir: 'C:\\gptplus\\cdp',
    findPort: async (port) => { calls.push(['port', port]); return 9331; },
    launch: async (options) => {
      calls.push(['launch', options]);
      return { ok: true, pid: 42 };
    },
    inject: async (options) => { calls.push(['inject', options]); return { ok: true }; },
  });

  assert.equal(result.injected, true);
  assert.equal(result.cdpPort, 9331);
  assert.equal(result.bridge, false);
  assert.deepEqual(calls.map(([name]) => name), ['gateway', 'port', 'launch', 'inject']);
  assert.deepEqual(calls[0][1], { port: 18120, host: '127.0.0.1', token: 'gateway-token' });
  assert.deepEqual(calls[2][1], {
    preferredPath: 'C:\\ChatGPT.exe', cdpPort: 9331, wrapperDir: 'C:\\gptplus\\cdp',
  });
  assert.deepEqual(calls[3][1], { cdpPort: 9331 });
});

test('statusline launch starts a data bridge when a live usage reader is available', async () => {
  const bridged = [];
  let subscriptions = 0;
  const result = await launchChatGptWithUsageStatusline({
    ctx: {
      store: { get: () => ({ gateway: {} }) },
      gateway: {
        getState: () => ({ running: true, port: 18120, host: '127.0.0.1' }),
        start: async () => {},
        on: (event) => {
          assert.equal(event, 'log');
          subscriptions += 1;
          return () => {};
        },
      },
      usageLive: { read: (id) => ({ status: 'ok', session_id: id, events: [] }) },
      log: () => {},
    },
    findPort: async () => 9333,
    launch: async () => ({ ok: true, pid: 44 }),
    inject: async () => ({ ok: true }),
    startBridge: (options) => {
      bridged.push(options);
      return { stop() {} };
    },
  });

  assert.equal(result.bridge, true);
  assert.equal(bridged.length, 1);
  assert.equal(bridged[0].cdpPort, 9333);
  assert.equal(typeof bridged[0].read, 'function');
  assert.equal(typeof bridged[0].requestSpeed, 'function');
  assert.equal(typeof bridged[0].subscribe, 'function');
  bridged[0].subscribe(() => {});
  assert.equal(subscriptions, 1);
  assert.deepEqual(bridged[0].read('thread_12345678'), {
    status: 'ok', session_id: 'thread_12345678', events: [],
  });
});

test('statusline bridge pushes a completed gateway request even when rollout is not ready', async () => {
  const applied = [];
  const bridge = startUsageStatuslineBridge({
    cdpPort: 9335,
    read: () => { throw new Error('rollout is still being written'); },
    requestSpeed: () => ({
      at: Date.now(), speed: 25, inputTokens: 400, cachedInputTokens: 300,
      outputTokens: 50, totalTokens: 450, cacheUsageAvailable: true,
    }),
    listTargetsImpl: async () => [{
      id: 'page-1', type: 'page', title: 'Codex', url: 'app://-/index.html',
    }],
    evaluateImpl: async (_page, expression) => {
      if (expression.includes('context?.()')) return { id: 'thread_gateway_only', hidden: false };
      applied.push(expression);
      return true;
    },
    visibleIntervalMs: 5,
    hiddenIntervalMs: 5,
  });
  try {
    const deadline = Date.now() + 1000;
    while (!applied.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    bridge.stop();
  }
  assert.equal(applied.length > 0, true, 'rollout 未就绪时也应推送网关请求数据');
  assert.match(applied[0], /thread_gateway_only/);
  assert.match(applied[0], /"speed":25/);
  assert.match(applied[0], /null, \{"at"/);
});

test('statusline bridge wakes immediately when a gateway request completes', async () => {
  let request = null;
  let notify = null;
  let contextCalls = 0;
  const applied = [];
  const bridge = startUsageStatuslineBridge({
    cdpPort: 9336,
    read: () => ({ status: 'unavailable', session_id: 'thread_event_driven', events: [] }),
    requestSpeed: () => request,
    subscribe: (callback) => {
      notify = callback;
      return () => { notify = null; };
    },
    listTargetsImpl: async () => [{
      id: 'page-2', type: 'page', title: 'Codex', url: 'app://-/index.html',
    }],
    evaluateImpl: async (_page, expression) => {
      if (expression.includes('context?.()')) {
        contextCalls += 1;
        return { id: 'thread_event_driven', hidden: false };
      }
      applied.push(expression);
      return true;
    },
    visibleIntervalMs: 5000,
    hiddenIntervalMs: 5000,
  });
  try {
    const initialDeadline = Date.now() + 500;
    while ((contextCalls < 1 || typeof notify !== 'function') && Date.now() < initialDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(typeof notify, 'function');
    request = {
      at: Date.now(), speed: 25, inputTokens: 400, cachedInputTokens: 300,
      outputTokens: 50, totalTokens: 450, cacheUsageAvailable: true,
    };
    const started = Date.now();
    notify({ final: true, status: 200, sessionId: 'thread_event_driven' });
    const deadline = started + 500;
    while (!applied.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(applied.length > 0, '完成事件应立即唤醒数据推送');
    assert.ok(Date.now() - started < 500, '不应等待下一轮 5 秒轮询');
    assert.match(applied[0], /"speed":25/);
  } finally {
    bridge.stop();
  }
});

test('statusline gateway endpoint supports loopback binding and rejects a stopped gateway', () => {
  assert.equal(usageStatuslineEndpoint({ running: true, host: '0.0.0.0', port: 18120 }), 'http://127.0.0.1:18120/thread-usage-live');
  assert.equal(usageStatuslineEndpoint({ running: true, host: '::1', port: 18120 }), 'http://[::1]:18120/thread-usage-live');
  assert.throws(() => usageStatuslineEndpoint({ running: false, port: 18120 }), /网关未运行/);
});

test('statusline launch reports injection errors without hiding the launched client result', async () => {
  const ctx = {
    store: { get: () => ({ gateway: { token: 'gateway-token' } }) },
    gateway: {
      getState: () => ({ running: true, port: 18120, host: '127.0.0.1' }),
      start: async () => {},
    },
    log: () => {},
  };
  const result = await launchChatGptWithUsageStatusline({
    ctx,
    findPort: async () => 9332,
    launch: async () => ({ ok: true, pid: 43 }),
    inject: async () => { throw new Error('调试端口不可达'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.injected, false);
  assert.equal(result.injectError, '调试端口不可达');
});

test('resumeUsageStatusline reattaches to a running ChatGPT and skips when absent', async () => {
  const calls = [];
  const result = await resumeUsageStatusline({
    ctx: {
      usageLive: { read: (id) => ({ status: 'ok', session_id: id, events: [] }) },
      log: () => {},
    },
    findPort: async () => 9334,
    listTargetsImpl: async () => [
      { id: 'page-1', type: 'page', title: 'Codex', url: 'app://-/index.html' },
    ],
    inject: async (options) => { calls.push(['inject', options]); return { installed: true }; },
    startBridge: (options) => { calls.push(['bridge', options]); return { stop() {} }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.cdpPort, 9334);
  assert.equal(result.bridge, true);
  assert.deepEqual(calls.map(([name]) => name), ['inject', 'bridge']);
  assert.equal(calls[0][1].cdpPort, 9334);
  assert.equal(calls[0][1].target.id, 'page-1');
  assert.equal(calls[1][1].cdpPort, 9334);

  assert.deepEqual(await resumeUsageStatusline({
    ctx: {},
    findPort: async () => null,
  }), { ok: false, skipped: true });

  assert.deepEqual(await resumeUsageStatusline({
    ctx: {},
    findPort: async () => 9229,
    listTargetsImpl: async () => [{ id: 'x', type: 'page', title: 'Other', url: 'http://example.com' }],
  }), { ok: false, skipped: true });
});
