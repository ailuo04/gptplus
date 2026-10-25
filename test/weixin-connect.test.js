'use strict';
// 微信连接：iLink 协议、状态持久化、白名单/去重与每联系人独立 thread。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/core/store.js');
const {
  MAX_REPLY_CHARS,
  createWeixinConnect,
  createWeixinClient,
  createStateStore,
  stateFilePath,
  normalizeBaseUrl,
  chunkText,
  messageDedupKey,
  isAllowedPeer,
  extractMessageText,
  extractImageSources,
  findRecentOutputImages,
  encryptAesEcb,
  decryptAesEcb,
  parseMediaAesKey,
  parseWeixinCommand,
  sandboxLabel,
  WEIXIN_COMMANDS_HELP,
  formatTaskNotification,
  appendReplyFooter,
  weixinFailureReply,
} = require('../src/core/weixin-connect.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function message(overrides = {}) {
  return {
    seq: 1,
    message_id: 1001,
    from_user_id: 'owner@im.wechat',
    client_id: 'client-1',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    context_token: 'ctx-token',
    ...overrides,
  };
}

function makeStore(dir, extra = {}) {
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.update((draft) => {
    draft.weixin = {
      ...draft.weixin,
      token: 'bot-token',
      accountId: 'bot@im.bot',
      allowFrom: 'owner@im.wechat',
      workDir: dir,
      ...extra,
    };
  });
  return store;
}

function fakeAppServer({ fail = false } = {}) {
  const calls = { prepare: [], turns: [], closed: 0 };
  return {
    calls,
    async prepareThread(threadId) {
      calls.prepare.push(threadId);
      return threadId || 'thread-1';
    },
    async runTurn(threadId, prompt) {
      calls.turns.push({ threadId, prompt });
      if (fail) throw new Error('模型不可用');
      return { reply: 'pong', model: 'm1', usage: { contextUsed: 10, contextWindow: 100 } };
    },
    async close() { calls.closed += 1; },
    isRunning() { return true; },
  };
}

async function waitFor(check, { timeoutMs = 4000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时: ${label}`);
}

test('weixin: 文本/语音/引用提取与分片、白名单、失败回复', () => {
  assert.equal(extractMessageText({ item_list: [{ type: 1, text_item: { text: ' hi ' } }] }), 'hi');
  assert.equal(extractMessageText({ item_list: [{ type: 3, voice_item: { text: '语音文字' } }] }), '语音文字');
  assert.equal(
    extractMessageText({
      item_list: [{
        type: 1,
        text_item: { text: '正文' },
        ref_msg: { title: '标题', message_item: { type: 1, text_item: { text: '被引用' } } },
      }],
    }),
    '[引用: 标题 | 被引用]\n正文',
  );
  assert.deepEqual(chunkText('一二三四五', 2), ['一二', '三四', '五']);
  assert.equal(chunkText('x'.repeat(MAX_REPLY_CHARS + 1)).length, 2);
  assert.equal(isAllowedPeer('', 'a@im.wechat'), true);
  assert.equal(isAllowedPeer('*', 'a@im.wechat'), true);
  assert.equal(isAllowedPeer('a@im.wechat, b@im.wechat', 'b@im.wechat'), true);
  assert.equal(isAllowedPeer('a@im.wechat', 'b@im.wechat'), false);
  assert.equal(normalizeBaseUrl('https://ilinkai.weixin.qq.com///'), 'https://ilinkai.weixin.qq.com');
  assert.equal(normalizeBaseUrl(''), 'https://ilinkai.weixin.qq.com');
  assert.notEqual(
    messageDedupKey({ from_user_id: 'a', message_id: 0, seq: 0, create_time_ms: 1, client_id: 'a' }),
    messageDedupKey({ from_user_id: 'a', message_id: 0, seq: 0, create_time_ms: 2, client_id: 'b' }),
  );
  const footer = appendReplyFooter('done', { reply: 'done', model: 'gpt-test', usage: { contextUsed: 257, contextWindow: 1000 } }, 'C:\\work');
  assert.match(footer, /done\n\ngpt-test · ctx 26%\nC:\\work/);
  assert.match(weixinFailureReply('第一行原因\n第二行堆栈'), /Codex 处理失败：第一行原因/);
  assert.equal(weixinFailureReply('  \n '), 'Codex 处理失败，请在 gpt++ 中查看连接状态。');
});

test('weixin: 状态文件按账号隔离，游标/thread/去重历史可往返且封顶', () => {
  const dir = tmpDir('gptplus-weixin-state-');
  try {
    const store = createStateStore({ dir, accountId: 'bot@im.bot' });
    const state = store.load();
    state.getUpdatesBuf = 'cursor';
    state.threadIds['peer@im.wechat'] = 'thread-1';
    for (let i = 0; i < 600; i += 1) store.markProcessed(state, `key-${i}`);
    store.save(state);
    const loaded = store.load();
    assert.equal(loaded.getUpdatesBuf, 'cursor');
    assert.equal(loaded.threadIds['peer@im.wechat'], 'thread-1');
    assert.equal(loaded.processedMessageKeys.length, 512);
    assert.equal(loaded.processedMessageKeys.includes('key-0'), false);
    assert.equal(loaded.processedMessageKeys.includes('key-599'), true);
    assert.match(stateFilePath(dir, 'bot@im.bot'), /weixin-connect-state-bot@im\.bot\.json$/);
    assert.match(stateFilePath(dir, ''), /weixin-connect-state\.json$/);
  } finally {
    cleanup(dir);
  }
});

test('weixin client: getupdates 带 Bearer/渠道版本，sendmessage 分片且必须带 context_token', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('/ilink/bot/getupdates')) {
      return jsonResponse({
        ret: 0,
        errcode: 0,
        msgs: [],
        get_updates_buf: 'next-cursor',
        longpolling_timeout_ms: 1200,
      });
    }
    return new Response('{}', { status: 200 });
  };
  const client = createWeixinClient({
    baseUrl: 'https://ilink.test',
    token: 'bot-token',
    routeTag: 'route-1',
    fetchImpl,
  });
  const updates = await client.getUpdates('cursor', 1000);
  assert.equal(updates.get_updates_buf, 'next-cursor');
  assert.equal(updates.longpolling_timeout_ms, 1200);
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.get_updates_buf, 'cursor');
  assert.equal(payload.base_info.channel_version, 'gptplus-weixin/1.0');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer bot-token');
  assert.equal(requests[0].init.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(requests[0].init.headers.skroutetag, 'route-1');
  assert.ok(requests[0].init.headers['X-WECHAT-UIN']);

  const sent = [];
  const sendFetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  };
  const sendClient = createWeixinClient({ baseUrl: 'https://ilink.test', token: 'bot-token', fetchImpl: sendFetch });
  await sendClient.sendTextChunks('peer@im.wechat', 'a'.repeat(MAX_REPLY_CHARS + 1), 'ctx-1');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].msg.to_user_id, 'peer@im.wechat');
  assert.equal(sent[0].msg.context_token, 'ctx-1');
  assert.equal(sent[0].msg.message_type, 2);
  assert.equal(sent[0].msg.item_list[0].text_item.text.length, MAX_REPLY_CHARS);

  await assert.rejects(
    () => sendClient.sendTextChunks('peer@im.wechat', 'x', ''),
    /context_token/,
  );
});

test('weixin connect: 收到白名单消息后建 thread、回复并持久化状态', async () => {
  const dir = tmpDir('gptplus-weixin-connect-');
  const store = makeStore(dir);
  const server = fakeAppServer();
  const sendBodies = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/ilink/bot/getupdates')) {
      polls += 1;
      const first = polls === 1;
      return jsonResponse({
        ret: 0,
        errcode: 0,
        msgs: first ? [message()] : [],
        get_updates_buf: `cursor-${polls}`,
        longpolling_timeout_ms: 1000,
      });
    }
    if (String(url).includes('/ilink/bot/sendmessage')) {
      sendBodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  let appServerOptions = null;
  const connect = createWeixinConnect({
    store,
    stateDir: dir,
    fetchImpl,
    appServerFactory: async (options) => { appServerOptions = options; return server; },
    resolveCli: async () => ({ path: 'codex.exe', source: 'test' }),
    log: () => {},
  });
  try {
    const started = await connect.start();
    assert.equal(started.ok, true);
    await waitFor(() => connect.getStatus().processedMessages === 1, { label: '消息处理完成' });
    const status = connect.getStatus();
    assert.equal(status.state, 'running');
    assert.equal(status.lastPeerId, 'owner@im.wechat');
    assert.equal(server.calls.prepare[0], undefined);
    assert.deepEqual(server.calls.turns[0], { threadId: 'thread-1', prompt: '你好' });
    assert.deepEqual(appServerOptions.configOverrides, ['model_providers.gptplus.http_headers.X-Gptplus-Source=weixin']);
    assert.equal(appServerOptions.workDir, dir);
    assert.equal(sendBodies.length, 1);
    const body = sendBodies[0];
    assert.equal(body.msg.to_user_id, 'owner@im.wechat');
    assert.equal(body.msg.context_token, 'ctx-token');
    assert.match(body.msg.item_list[0].text_item.text, /^pong\n\nm1 · ctx 10%/);
    const state = createStateStore({ dir, accountId: 'bot@im.bot' }).load();
    assert.equal(state.threadIds['owner@im.wechat'], 'thread-1');
    assert.equal(state.processedMessageKeys.length, 1);
    assert.ok(state.getUpdatesBuf.startsWith('cursor-'));
  } finally {
    await connect.stop();
    cleanup(dir);
  }
  assert.ok(server.calls.closed >= 1);
});

test('weixin connect: 非白名单消息只更新状态，不启动 Codex', async () => {
  const dir = tmpDir('gptplus-weixin-allow-');
  const store = makeStore(dir, { allowFrom: 'only@im.wechat' });
  const server = fakeAppServer();
  const fetchImpl = async (url) => {
    if (String(url).includes('/ilink/bot/getupdates')) {
      return jsonResponse({
        ret: 0,
        errcode: 0,
        msgs: [message({ from_user_id: 'stranger@im.wechat' })],
        get_updates_buf: 'cursor',
        longpolling_timeout_ms: 1000,
      });
    }
    return new Response('{}', { status: 200 });
  };
  const connect = createWeixinConnect({
    store, stateDir: dir, fetchImpl,
    appServerFactory: async () => server,
    resolveCli: async () => ({ path: 'codex.exe', source: 'test' }),
    log: () => {},
  });
  try {
    await connect.start();
    await waitFor(() => /已忽略/.test(connect.getStatus().message), { label: '非白名单提示' });
    assert.equal(server.calls.turns.length, 0);
  } finally {
    await connect.stop();
    cleanup(dir);
  }
});

test('weixin connect: Codex 失败时回发带原因的消息并清除该条消息去重', async () => {
  const dir = tmpDir('gptplus-weixin-fail-');
  const store = makeStore(dir);
  const server = fakeAppServer({ fail: true });
  const sent = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/ilink/bot/getupdates')) {
      polls += 1;
      return jsonResponse({
        ret: 0,
        errcode: 0,
        msgs: polls === 1 ? [message()] : [],
        get_updates_buf: 'cursor',
        longpolling_timeout_ms: 1000,
      });
    }
    if (String(url).includes('/ilink/bot/sendmessage')) {
      sent.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connect = createWeixinConnect({
    store, stateDir: dir, fetchImpl,
    appServerFactory: async () => server,
    resolveCli: async () => ({ path: 'codex.exe', source: 'test' }),
    log: () => {},
  });
  try {
    await connect.start();
    await waitFor(() => connect.getStatus().state === 'retrying', { label: '失败状态' });
    assert.equal(connect.getStatus().processedMessages, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].msg.item_list[0].text_item.text, /^Codex 处理失败：模型不可用/);
    assert.match(sent[0].msg.item_list[0].text_item.text, /gpt\+\+/);
    const state = createStateStore({ dir, accountId: 'bot@im.bot' }).load();
    assert.equal(state.processedMessageKeys.length, 1);
  } finally {
    await connect.stop();
    cleanup(dir);
  }
});

test('weixin connect: 扫码确认后自动保存 token/账号/白名单/baseUrl', async () => {
  const dir = tmpDir('gptplus-weixin-qr-');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('get_bot_qrcode')) {
      return jsonResponse({ qrcode: 'qr-1', qrcode_img_content: 'https://example.test/login' });
    }
    if (String(url).includes('get_qrcode_status')) {
      return jsonResponse({
        status: 'confirmed',
        bot_token: 'new-token',
        ilink_bot_id: 'new-bot@im.bot',
        baseurl: 'https://ilinkai.weixin.qq.com/',
        ilink_user_id: 'owner@im.wechat',
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connect = createWeixinConnect({
    store,
    stateDir: dir,
    fetchImpl,
    qrRenderer: () => 'data:image/png;base64,AAA',
    log: () => {},
  });
  try {
    const qr = await connect.qrStart({ baseUrl: 'https://ilink.test', routeTag: 'route-9' });
    assert.equal(qr.qrStatus, 'wait');
    assert.equal(qr.qrImage, 'data:image/png;base64,AAA');
    const confirmed = await connect.qrStatus();
    assert.equal(confirmed.qrStatus, 'confirmed');
    assert.equal(confirmed.accountId, 'new-bot@im.bot');
    const cfg = store.get().weixin;
    assert.equal(cfg.token, 'new-token');
    assert.equal(cfg.accountId, 'new-bot@im.bot');
    assert.equal(cfg.baseUrl, 'https://ilinkai.weixin.qq.com');
    assert.equal(cfg.allowFrom, 'owner@im.wechat');
    assert.equal(cfg.routeTag, 'route-9');
    const statusRequest = requests.find((item) => item.url.includes('get_qrcode_status'));
    assert.equal(statusRequest.init.headers['iLink-App-ClientVersion'], '1');
    assert.equal(statusRequest.init.headers.skroutetag, 'route-9');
  } finally {
    cleanup(dir);
  }
});

test('weixin: 配置清洗保留沙箱枚举，并一次性迁移旧 QQ 工作目录/CLI 路径', () => {
  const { normalizeWeixin } = require('../src/core/store.js');
  const defaults = normalizeWeixin(null);
  assert.equal(defaults.baseUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(defaults.sandbox, 'read-only');
  assert.equal(defaults.enabled, false);
  const migrated = normalizeWeixin(null, {
    workspaceDir: 'D:\projects',
    codexPath: 'C:\tools\codex.exe',
    notifyQq: '10001',
  });
  assert.equal(migrated.workDir, 'D:\projects');
  assert.equal(migrated.codexPath, 'C:\tools\codex.exe');
  assert.equal(Object.prototype.hasOwnProperty.call(migrated, 'notifyQq'), false);
  const explicit = normalizeWeixin({
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    sandbox: 'workspace-write',
    workDir: '',
  }, { workspaceDir: 'D:\old' });
  assert.equal(explicit.baseUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(explicit.sandbox, 'workspace-write');
  assert.equal(explicit.workDir, '', '新配置里的空工作目录不能被旧 QQ 值回填');
  assert.equal(normalizeWeixin({ sandbox: 'unsafe' }).sandbox, 'read-only');
});

test('weixin: 指令只匹配整条消息，支持中英文与斜杠别名', () => {
  assert.equal(parseWeixinCommand('帮助'), 'help');
  assert.equal(parseWeixinCommand('指令'), 'help');
  assert.equal(parseWeixinCommand('HELP!'), 'help');
  assert.equal(parseWeixinCommand('/help'), 'help');
  assert.equal(parseWeixinCommand('？'), 'help');
  assert.equal(parseWeixinCommand('帮助。'), 'help');
  assert.equal(parseWeixinCommand('新对话'), 'new');
  assert.equal(parseWeixinCommand('新会话'), 'new');
  assert.equal(parseWeixinCommand('清空上下文。'), 'new');
  assert.equal(parseWeixinCommand('/new'), 'new');
  assert.equal(parseWeixinCommand('状态'), 'status');
  assert.equal(parseWeixinCommand('/status'), 'status');
  assert.equal(parseWeixinCommand('帮助我改代码'), null, '正常提问不能被当成指令');
  assert.equal(parseWeixinCommand('新对话 然后画图'), null, '带内容的句子不能被当成指令');
  assert.equal(parseWeixinCommand(''), null);
  assert.match(WEIXIN_COMMANDS_HELP, /新对话/);
  assert.match(WEIXIN_COMMANDS_HELP, /状态/);
  assert.equal(sandboxLabel('danger-full-access'), '完全访问');
  assert.equal(sandboxLabel('workspace-write'), '允许修改工作目录');
  assert.equal(sandboxLabel('read-only'), '只读');
});

test('weixin connect: 帮助/状态/新对话指令不启动 Codex，且能清空 thread', async () => {
  const dir = tmpDir('gptplus-weixin-commands-');
  const store = makeStore(dir, { model: 'm1', sandbox: 'workspace-write' });
  const stateStore = createStateStore({ dir, accountId: 'bot@im.bot' });
  const seeded = stateStore.load();
  seeded.threadIds['owner@im.wechat'] = '01a1723f-9c12-7920-a156-5328124fcde5';
  stateStore.save(seeded);

  let appServerCalls = 0;
  const sent = [];
  let polls = 0;
  const messages = [
    message({ message_id: 2001, seq: 11, item_list: [{ type: 1, text_item: { text: '帮助' } }] }),
    message({ message_id: 2002, seq: 12, item_list: [{ type: 1, text_item: { text: '状态' } }] }),
    message({ message_id: 2003, seq: 13, item_list: [{ type: 1, text_item: { text: '新对话' } }] }),
  ];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/ilink/bot/getupdates')) {
      polls += 1;
      return jsonResponse({
        ret: 0,
        errcode: 0,
        msgs: polls === 1 ? messages : [],
        get_updates_buf: 'cursor',
        longpolling_timeout_ms: 1000,
      });
    }
    if (String(url).includes('/ilink/bot/sendmessage')) {
      sent.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connect = createWeixinConnect({
    store,
    stateDir: dir,
    fetchImpl,
    appServerFactory: async () => {
      appServerCalls += 1;
      return fakeAppServer();
    },
    resolveCli: async () => ({ path: 'codex.exe', source: 'test' }),
    log: () => {},
  });
  try {
    await connect.start();
    await waitFor(() => connect.getStatus().processedMessages === 3, { label: '三条指令处理完成' });
    assert.equal(appServerCalls, 0, '指令不能启动 Codex app-server');
    assert.equal(sent.length, 3);
    const replies = sent.map((body) => body.msg.item_list[0].text_item.text);
    assert.match(replies[0], /微信连接指令/);
    assert.match(replies[0], /新对话/);
    assert.match(replies[1], /微信连接：运行中/);
    assert.match(replies[1], /模型：m1/);
    assert.match(replies[1], /沙箱：允许修改工作目录/);
    assert.match(replies[1], /会话：01a1723f…/);
    assert.match(replies[2], /已清空当前联系人的对话上下文/);
    const state = stateStore.load();
    assert.equal(state.threadIds['owner@im.wechat'], undefined);
    assert.equal(state.processedMessageKeys.length, 3);
    assert.equal(connect.getStatus().lastPeerId, 'owner@im.wechat');
  } finally {
    await connect.stop();
    cleanup(dir);
  }
});

test('weixin: ChatGPT 任务通知格式包含状态、时长与结果，不附加 Codex 页脚', () => {
  const startedAt = 1_000_000;
  const task = {
    title: '修复登录超时', model: 'm1', startedAt, endedAt: startedAt + 5 * 60 * 1000,
    lastText: '已修复并通过测试', lastError: '',
  };
  assert.match(formatTaskNotification({ kind: 'started', task }), /^▶️ ChatGPT 任务开始\n修复登录超时\n模型：m1$/);
  assert.match(
    formatTaskNotification({ kind: 'progress', task: { ...task, startedAt: Date.now() - 5 * 60 * 1000, endedAt: null } }),
    /^⏳ ChatGPT 任务进行中 · 已 5 分钟/,
  );
  assert.match(formatTaskNotification({ kind: 'done', task }), /^✅ ChatGPT 任务完成 · 5 分钟\n修复登录超时\n\n已修复并通过测试$/);
  assert.match(formatTaskNotification({ kind: 'failed', task: { ...task, lastError: 'HTTP 502' } }), /^❌ ChatGPT 任务失败 · 5 分钟\n修复登录超时\nHTTP 502$/);
  assert.match(formatTaskNotification({ kind: 'stale', task }), /^💤 ChatGPT 任务已结束 · 5 分钟/);
  assert.equal(formatTaskNotification({ kind: 'unknown', task }), '');
});

test('weixin connect: 任务通知直接发微信，不启动 Codex、不增加已处理消息', async () => {
  const dir = tmpDir('gptplus-weixin-task-notify-');
  const store = makeStore(dir);
  const stateStore = createStateStore({ dir, accountId: 'bot@im.bot' });
  const state = stateStore.load();
  state.contextTokens['owner@im.wechat'] = 'notify-context';
  stateStore.save(state);

  let appServerCalls = 0;
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/ilink/bot/getupdates')) {
      return jsonResponse({
        ret: 0, errcode: 0, msgs: [], get_updates_buf: 'cursor', longpolling_timeout_ms: 1000,
      });
    }
    if (String(url).includes('/ilink/bot/sendmessage')) {
      sent.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connect = createWeixinConnect({
    store,
    stateDir: dir,
    fetchImpl,
    appServerFactory: async () => {
      appServerCalls += 1;
      return fakeAppServer();
    },
    resolveCli: async () => ({ path: 'codex.exe', source: 'test' }),
    log: () => {},
  });
  try {
    await connect.start();
    await waitFor(() => connect.isRunning(), { label: '微信连接启动' });
    const now = Date.now();
    connect.notifyTask({ kind: 'started', task: { title: '修复登录', model: 'm1', startedAt: now } });
    await waitFor(() => sent.length === 1, { label: '任务开始通知' });
    assert.match(sent[0].msg.item_list[0].text_item.text, /^▶️ ChatGPT 任务开始\n修复登录\n模型：m1/);
    assert.equal(sent[0].msg.context_token, 'notify-context');
    connect.notifyTask({ kind: 'progress', task: { title: '修复登录', model: 'm1', startedAt: now - 6 * 60 * 1000 } });
    await waitFor(() => sent.length === 2, { label: '任务进度通知' });
    assert.match(sent[1].msg.item_list[0].text_item.text, /^⏳ ChatGPT 任务进行中/);
    connect.notifyTask({ kind: 'done', task: { title: '修复登录', model: 'm1', startedAt: now - 6 * 60 * 1000, endedAt: now, lastText: '完成' } });
    await waitFor(() => sent.length === 3, { label: '任务完成通知' });
    assert.match(sent[2].msg.item_list[0].text_item.text, /^✅ ChatGPT 任务完成/);
    assert.equal(appServerCalls, 0, '任务通知不能启动 Codex');
    assert.equal(connect.getStatus().processedMessages, 0, '通知不计入已处理消息');
    const saved = stateStore.load();
    assert.equal(saved.processedMessageKeys.length, 0, '通知不能写入消息去重记录');
    assert.doesNotMatch(sent[0].msg.item_list[0].text_item.text, /ctx \d+%/, '通知不能带 Codex 页脚');
  } finally {
    await connect.stop();
    cleanup(dir);
  }
});
