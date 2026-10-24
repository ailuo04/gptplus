'use strict';
// QQ 远程助手测试：OneBot HTTP 调用（本地 stub）、命令路由、上报鉴权、
// 通知格式化，以及与真实网关服务器的 /onebot/event 集成。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createStore } = require('../src/core/store.js');
const { createTaskCenter } = require('../src/core/task-center.js');
const { createQqBot, formatDuration } = require('../src/core/qq-bot.js');
const { createGateway } = require('../src/core/gateway/server.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** 本地 NapCat 替身：记录请求并按 action 返回 OneBot 响应。 */
async function startNapCatStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 非 JSON */ }
      const action = (req.url || '').replace(/^\//, '');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, action, at: Date.now() });
      const data = action === 'get_login_info'
        ? { user_id: 999000, nickname: '测试机器人' }
        : { message_id: 123 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server),
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 1111;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

async function makeHarness({ qqbot = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-qq-'));
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const codexPath = path.join(dir, 'codex.exe');
  fs.writeFileSync(codexPath, '');
  store.update((draft) => {
    draft.qqbot.codexPath = codexPath;
    draft.qqbot.workspaceDir = dir;
    Object.assign(draft.qqbot, qqbot);
  });
  const spawns = [];
  const taskCenter = createTaskCenter({
    store,
    log: () => {},
    now: () => 1_000_000,
    spawnImpl: (command, args, opts) => {
      const child = new FakeChild();
      spawns.push({ command, args: args.slice(), opts, child });
      return child;
    },
  });
  return { dir, store, taskCenter, spawns };
}

function makeQqBot(store, taskCenter) {
  return createQqBot({ store, taskCenter, log: () => {}, now: () => 1_000_000 });
}

function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: null,
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(body) { this.writableEnded = true; this.body = body == null ? '' : String(body); },
  };
}

function fakeReq({ headers = {}, url = '/onebot/event' } = {}) {
  return { headers, url };
}

function messageEvent({ userId = '10001', text = '任务' } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: Number(userId),
    sender: { user_id: Number(userId), nickname: '主人' },
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
  };
}

/** 轮询 stub 直到出现匹配的请求（命令处理是异步的）。 */
async function waitForRequest(stub, predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = stub.requests.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('等待 NapCat stub 请求超时: ' + label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('formatDuration 输出可读耗时', () => {
  assert.equal(formatDuration(45_000), '45 秒');
  assert.equal(formatDuration(60_000), '1 分钟');
  assert.equal(formatDuration(95_000), '1 分 35 秒');
  assert.equal(formatDuration(3_700_000), '1 小时 1 分');
});

test('sendPrivate 调用 send_private_msg，携带令牌与接收者', async () => {
  const stub = await startNapCatStub();
  try {
    const { store, taskCenter } = await makeHarness({ qqbot: { enabled: true, apiUrl: stub.url, accessToken: 'sekret', notifyQq: '10001' } });
    const bot = makeQqBot(store, taskCenter);
    const result = await bot.sendPrivate('你好');
    assert.equal(result.ok, true);
    const call = stub.requests.find((r) => r.action === 'send_private_msg');
    assert.ok(call);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer sekret');
    assert.equal(call.body.user_id, 10001);
    assert.equal(call.body.message, '你好');
  } finally {
    await stub.close();
  }
});

test('apiTest 通过 get_login_info 探测连通性', async () => {
  const stub = await startNapCatStub();
  try {
    const { store, taskCenter } = await makeHarness({ qqbot: { apiUrl: stub.url } });
    const bot = makeQqBot(store, taskCenter);
    const result = await bot.apiTest();
    assert.equal(result.ok, true);
    assert.equal(result.account, '999000');
    assert.equal(result.nickname, '测试机器人');
  } finally {
    await stub.close();
  }
});

test('apiTest 对不可达地址返回错误而不是抛出', async () => {
  const { store, taskCenter } = await makeHarness({ qqbot: { apiUrl: 'http://127.0.0.1:9' } });
  const bot = makeQqBot(store, taskCenter);
  const result = await bot.apiTest();
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('只有主人私聊消息会进入命令，CQ 码被剥掉，图片段被提取', async () => {
  const { store, taskCenter } = await makeHarness({ qqbot: { ownerQq: '10001' } });
  const bot = makeQqBot(store, taskCenter);
  const cmd = bot._commandFromEvent(messageEvent({ text: '[CQ:reply,id=1] 任务' }));
  assert.equal(cmd.text, '任务');
  assert.deepEqual(cmd.images, []);
  assert.equal(bot._commandFromEvent(messageEvent({ userId: '99999' })), null, '非主人忽略');
  assert.equal(bot._commandFromEvent({ post_type: 'notice' }), null);
  const group = { ...messageEvent(), message_type: 'group' };
  assert.equal(bot._commandFromEvent(group), null, '群消息忽略');
  const arrayOnly = messageEvent();
  delete arrayOnly.raw_message;
  assert.equal(bot._commandFromEvent(arrayOnly).text, '任务');

  // array 格式：image 段带图床直链
  const withImage = messageEvent({ text: '这是什么' });
  withImage.message = [
    { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/d?rkey=1&spec=0', file: 'ABC.jpg' } },
    { type: 'text', data: { text: '这是什么' } },
  ];
  const parsed = bot._commandFromEvent(withImage);
  assert.equal(parsed.text, '这是什么');
  assert.deepEqual(parsed.images, [{ url: 'https://multimedia.nt.qq.com.cn/d?rkey=1&spec=0' }]);

  // 字符串格式兜底：CQ:image 的 url 转义要还原
  const cqOnly = {
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    sender: { user_id: 10001 },
    raw_message: '[CQ:image,file=x.jpg,url=https://gchat.qpic.cn/a?k=1&amp;spec=0]看看',
    message: '[CQ:image,file=x.jpg,url=https://gchat.qpic.cn/a?k=1&amp;spec=0]看看',
  };
  const cq = bot._commandFromEvent(cqOnly);
  assert.equal(cq.text, '看看');
  assert.deepEqual(cq.images, [{ url: 'https://gchat.qpic.cn/a?k=1&spec=0' }], 'CQ 转义还原');

  // 只发图片不配文字：text 为空但能拿到图片
  const imageOnly = messageEvent({ text: '' });
  imageOnly.message = [{ type: 'image', data: { url: 'https://example.com/i.png' } }];
  imageOnly.raw_message = '[CQ:image,file=i.png,url=https://example.com/i.png]';
  const only = bot._commandFromEvent(imageOnly);
  assert.equal(only.text, '');
  assert.equal(only.images.length, 1);
});

test('handleWebhook：主人命令经 send_private_msg 回复；上报令牌校验', async () => {
  const stub = await startNapCatStub();
  try {
    const { store, taskCenter } = await makeHarness({
      qqbot: { enabled: true, apiUrl: stub.url, notifyQq: '10001', ownerQq: '10001', eventToken: 'evsec' },
    });
    const bot = makeQqBot(store, taskCenter);

    const denied = fakeRes();
    await bot.handleWebhook(fakeReq({ headers: {} }), denied, messageEvent());
    assert.equal(denied.statusCode, 401, '缺上报令牌应 401');

    const okRes = fakeRes();
    await bot.handleWebhook(fakeReq({ headers: { authorization: 'Bearer evsec' } }), okRes, messageEvent({ text: '任务' }));
    assert.equal(okRes.statusCode, 200);
    const reply = await waitForRequest(stub, (r) => r.action === 'send_private_msg' && String(r.body.message).includes('当前没有任务'), '任务列表回复');
    assert.equal(reply.body.user_id, 10001);
  } finally {
    await stub.close();
  }
});

/** 本地网关替身：/v1/models 与 /v1/responses（手机问答走这里，不经 codex）；/img.png 供图片下载用。 */
async function startGatewayStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON */ }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body, at: Date.now() });
      if ((req.url || '').includes('/img.png')) {
        // 故意用 octet-stream：让真实类型走魔数嗅探（PNG 头）
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if ((req.url || '').includes('/v1/models')) {
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'stub__chat', owned_by: 'Stub' }, { id: 'stub__pro', owned_by: 'StubPro' }],
        }));
      } else {
        res.end(JSON.stringify({
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '模型回答' }] }],
        }));
      }
    });
  });
  const port = await listen(server);
  return { port, requests, close: () => closeServer(server) };
}

test('命令：先列模型选序号，选完直接多轮问答；QQ 流量带跳过任务观察标记', async () => {
  const stub = await startNapCatStub();
  const gw = await startGatewayStub();
  try {
    const { store, taskCenter, spawns } = await makeHarness({
      qqbot: { enabled: true, apiUrl: stub.url, notifyQq: '10001', ownerQq: '10001' },
    });
    store.update((draft) => {
      draft.gateway.port = gw.port;
      draft.gateway.token = 'gwtoken';
    });
    const bot = makeQqBot(store, taskCenter);
    bot.bindGateway({ getState: () => ({ running: true, port: gw.port, url: '' }) });

    // 第一次提问：先出模型列表，不请求模型
    const list = await bot.runCommand('你好');
    assert.match(list, /请选择回答用的模型/);
    assert.match(list, /1\. stub__chat/);
    assert.match(list, /2\. stub__pro/);
    assert.equal(gw.requests.filter((r) => r.path === '/v1/responses').length, 0);

    // 回序号 2：用第二个模型回答
    assert.equal(await bot.runCommand('2'), '模型回答');
    const first = gw.requests.find((r) => r.path === '/v1/responses');
    assert.equal(first.body.model, 'stub__pro');
    assert.equal(first.body.input.length, 1);
    assert.equal(first.headers['x-gptplus-qq-chat'], '1', '问答请求带跳过任务观察标记');
    assert.equal(first.headers.authorization, 'Bearer gwtoken', '带网关令牌');

    // 追问不再出列表，带上下文且沿用所选模型
    assert.equal(await bot.runCommand('刚才我说了什么'), '模型回答');
    const second = gw.requests.filter((r) => r.path === '/v1/responses')[1];
    assert.equal(second.body.input.length, 3, '第二轮带上第一轮的上下文');
    assert.equal(second.body.model, 'stub__pro');

    // 「模型」重选：换回 1
    assert.match(await bot.runCommand('模型'), /请选择回答用的模型/);
    assert.match(await bot.runCommand('1'), /已切换模型：stub__chat/);

    // 「新对话」清空模型选择与上下文
    assert.match(await bot.runCommand('新对话'), /已清空/);
    const again = await bot.runCommand('再问一个问题');
    assert.match(again, /请选择回答用的模型/, '重置后重新选模型');

    assert.equal(spawns.length, 0, 'QQ 消息不再创建 codex 任务');
    const help = await bot.runCommand('帮助');
    assert.match(help, /模型/);
    assert.doesNotMatch(help, /新任务|插入|停止/);
  } finally {
    await stub.close();
    await gw.close();
  }
});

test('命令：网关未运行时问答给出可读提示', async () => {
  const { store, taskCenter } = await makeHarness({});
  const bot = makeQqBot(store, taskCenter);
  await assert.rejects(() => bot.runCommand('你好'), /网关未运行/);
});

test('图片消息：webhook 下载图床直链成 data URL，选模型后以 input_image 发给网关', async () => {
  const stub = await startNapCatStub();
  const gw = await startGatewayStub();
  try {
    const { store, taskCenter } = await makeHarness({
      qqbot: { enabled: true, apiUrl: stub.url, notifyQq: '10001', ownerQq: '10001' },
    });
    store.update((draft) => {
      draft.gateway.port = gw.port;
      draft.gateway.token = 'gwtoken';
    });
    const bot = makeQqBot(store, taskCenter);
    bot.bindGateway({ getState: () => ({ running: true, port: gw.port, url: '' }) });

    // 图 + 文字：图片随问题暂存，先回模型列表
    const event = messageEvent({ text: '回答这个图片' });
    event.message = [
      { type: 'image', data: { url: `http://127.0.0.1:${gw.port}/img.png` } },
      { type: 'text', data: { text: '回答这个图片' } },
    ];
    const res = fakeRes();
    await bot.handleWebhook(fakeReq(), res, event);
    assert.equal(res.statusCode, 200);
    await waitForRequest(stub, (r) => r.action === 'send_private_msg' && String(r.body.message).includes('请选择回答用的模型'), '模型列表');

    // 回序号 1：待答问题连同图片一起发给模型
    await bot.handleWebhook(fakeReq(), fakeRes(), messageEvent({ text: '1' }));
    await waitForRequest(stub, (r) => r.action === 'send_private_msg' && String(r.body.message).includes('模型回答'), '图片问答回复');
    const chat = gw.requests.filter((r) => r.path === '/v1/responses').pop();
    const content = chat.body.input[0].content;
    assert.equal(content[0].type, 'input_text');
    assert.equal(content[0].text, '回答这个图片');
    assert.equal(content[1].type, 'input_image');
    assert.match(content[1].image_url, /^data:image\/png;base64,/, 'octet-stream 响应按魔数识别为 PNG');
  } finally {
    await stub.close();
    await gw.close();
  }
});

test('图片问答：只发图片用默认提问；多轮上下文只保留最近两条消息的图片', async () => {
  const gw = await startGatewayStub();
  try {
    const { store, taskCenter } = await makeHarness({});
    store.update((draft) => {
      draft.gateway.port = gw.port;
      draft.gateway.token = 'gwtoken';
    });
    const bot = makeQqBot(store, taskCenter);
    bot.bindGateway({ getState: () => ({ running: true, port: gw.port, url: '' }) });

    const img = (tag) => `data:image/png;base64,${Buffer.from(tag).toString('base64')}`;
    assert.match(await bot.runCommand('', [img('A')]), /请选择回答用的模型/);
    assert.equal(await bot.runCommand('1'), '模型回答');
    const first = gw.requests.filter((r) => r.path === '/v1/responses').pop();
    assert.equal(first.body.input[0].content[0].text, '请描述这张图片的内容', '只发图片时用默认提问');
    assert.equal(first.body.input[0].content.filter((p) => p.type === 'input_image').length, 1);

    await bot.runCommand('第二张', [img('B')]);
    await bot.runCommand('第三张', [img('C')]);
    const last = gw.requests.filter((r) => r.path === '/v1/responses').pop();
    const urls = last.body.input
      .flatMap((message) => message.content || [])
      .filter((part) => part.type === 'input_image')
      .map((part) => part.image_url);
    assert.equal(urls.length, 2, '只保留最近两条带图消息的图片');
    assert.ok(!urls.includes(img('A')), '最早的图片被剔除');
    assert.ok(urls.includes(img('B')) && urls.includes(img('C')));
  } finally {
    await gw.close();
  }
});

test('task-center：exec 任务 stdin 必须 ignore（codex 等管道输入会永久挂起）', async () => {
  const { dir, taskCenter, spawns } = await makeHarness({});
  await taskCenter.startExecTask({ prompt: '修复登录超时', cwd: dir });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('任务完成事件 -> QQ 通知（enabled 时才发送）', async () => {
  const stub = await startNapCatStub();
  try {
    const { store, taskCenter } = await makeHarness({
      qqbot: { enabled: true, apiUrl: stub.url, notifyQq: '10001' },
    });
    makeQqBot(store, taskCenter);

    const body = {
      instructions: 'I',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '重构模块' }] }],
    };
    taskCenter.turnRequest({ body, slug: 's' });
    taskCenter.turnResponse({ body, slug: 's', ok: true, status: 200, hasToolCalls: false, text: '重构完成' });
    const notice = await waitForRequest(stub, (r) => r.action === 'send_private_msg' && String(r.body.message).includes('重构模块'), '完成通知');
    assert.match(String(notice.body.message), /「重构模块」/);
    assert.match(String(notice.body.message), /重构完成/);
    assert.doesNotMatch(String(notice.body.message), /🧠|📝|⏱/, '完成通知只留任务名+耗时+回答');
  } finally {
    await stub.close();
  }
});

test('网关集成：/onebot/event 不受网关令牌限制，/v1 仍需令牌', async () => {
  const stub = await startNapCatStub();
  try {
    const { store, taskCenter } = await makeHarness({
      qqbot: { enabled: true, apiUrl: stub.url, notifyQq: '10001', ownerQq: '10001' },
    });
    const bot = makeQqBot(store, taskCenter);
    const gateway = createGateway({
      store,
      paths: {},
      log: () => {},
      taskObserver: taskCenter,
      onebot: { handleEvent: (req, res, body) => bot.handleWebhook(req, res, body) },
    });
    bot.bindGateway(gateway);
    const started = await gateway.start({ port: 0, host: '127.0.0.1', token: 'gwtoken' });
    try {
      // /onebot/event：NapCat 不带网关令牌，也应 200 并触发回复
      const res = await fetch(`http://127.0.0.1:${started.port}/onebot/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageEvent({ text: '任务' })),
      });
      assert.equal(res.status, 200);
      await waitForRequest(stub, (r) => r.action === 'send_private_msg' && String(r.body.message).includes('当前没有任务'), 'webhook 命令回复');

      // /v1/models 仍要求网关令牌
      const unauthorized = await fetch(`http://127.0.0.1:${started.port}/v1/models`);
      assert.equal(unauthorized.status, 401);
      const authorized = await fetch(`http://127.0.0.1:${started.port}/v1/models`, {
        headers: { Authorization: 'Bearer gwtoken' },
      });
      assert.equal(authorized.status, 200);
    } finally {
      await gateway.stop();
    }
  } finally {
    await stub.close();
  }
});

test('webhookUrl 跟随网关端口', async () => {
  const { store, taskCenter } = await makeHarness({});
  const bot = makeQqBot(store, taskCenter);
  store.update((draft) => { draft.gateway.port = 18999; });
  assert.equal(bot.webhookUrl(), 'http://127.0.0.1:18999/onebot/event');
});

function centerTaskId(taskCenter) {
  const running = taskCenter.listTasks().running;
  return running[0] ? running[0].id : taskCenter.listTasks().recent[0].id;
}

// ---- 自动拉起 NapCat ----

/** fetch 序列 stub：第 N 次调用返回 results[N]（越界重复最后一个）；ok 走成功响应。 */
function sequenceFetch(results) {
  const calls = [];
  const impl = async () => {
    const item = results[Math.min(calls.length, results.length - 1)];
    calls.push(item);
    if (!item.ok) throw new Error(item.error || 'fetch failed');
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 888000, nickname: '拉起机器人' } }),
    };
  };
  impl.calls = calls;
  return impl;
}

/** 拉起测试专用：真实时钟（轮询依赖 deadline），注入式 fetch/spawn/detect。 */
async function makeLaunchHarness({
  qqbot = {},
  fetchResults = [{ ok: false, error: 'fetch failed' }],
  detect = null,
  fetchImpl = null,
} = {}) {
  const base = await makeHarness({ qqbot });
  const botSpawns = [];
  const launchEvents = [];
  const impl = fetchImpl || sequenceFetch(fetchResults);
  const bot = createQqBot({
    store: base.store,
    taskCenter: base.taskCenter,
    log: () => {},
    fetchImpl: impl,
    spawnImpl: (command, args, opts) => {
      const child = new FakeChild();
      botSpawns.push({ command, args: args.slice(), opts, child });
      return child;
    },
    onEvent: (s) => launchEvents.push(s),
    ...(detect ? { detectImpl: detect } : {}),
  });
  return { ...base, bot, botSpawns, launchEvents };
}

test('launchNapCat：解析不到启动命令直接失败，不 spawn', async () => {
  const { bot, botSpawns } = await makeLaunchHarness({ detect: () => null });
  const result = await bot.launchNapCat({ waitMs: 60, intervalMs: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到 NapCat 启动命令/);
  assert.equal(botSpawns.length, 0);
  assert.equal(bot.getLaunchState().phase, 'failed');
});

test('launchNapCat：NapCat 已在线时不重复拉起', async () => {
  const { bot, botSpawns } = await makeLaunchHarness({
    qqbot: { launchCommand: 'C:\\NC\\launcher.bat', launchQq: '10001' },
    fetchResults: [{ ok: true }],
  });
  const result = await bot.launchNapCat({ waitMs: 60, intervalMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.account, '888000');
  assert.equal(botSpawns.length, 0);
  assert.equal(bot.getLaunchState().phase, 'online');
});

test('launchNapCat：离线时经 cmd 拉起、追加 -q，轮询直到上线', async () => {
  const { bot, botSpawns } = await makeLaunchHarness({
    qqbot: { launchCommand: 'C:\\NC\\launcher.bat', launchQq: '10001' },
    fetchResults: [{ ok: false }, { ok: false }, { ok: true }],
  });
  const result = await bot.launchNapCat({ waitMs: 3000, intervalMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.account, '888000');
  assert.equal(bot.getLaunchState().phase, 'online');
  assert.equal(botSpawns.length, 1);
  const spawn = botSpawns[0];
  assert.equal(spawn.command, process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  assert.ok(spawn.args.join(' ').includes('C:\\NC\\launcher.bat -q 10001'));
  assert.equal(spawn.opts.detached, true);
  assert.equal(spawn.opts.stdio, 'ignore', 'NapCat 输出不连接到前台终端');
  if (process.platform === 'win32') assert.equal(spawn.opts.windowsHide, true, 'Windows 不显示 cmd 控制台');
});

test('launchNapCat：超时未上线返回失败并带最后错误', async () => {
  const { bot, botSpawns } = await makeLaunchHarness({
    qqbot: { launchCommand: 'C:\\NC\\launcher.bat' },
    fetchResults: [{ ok: false, error: 'ECONNREFUSED' }],
  });
  const result = await bot.launchNapCat({ waitMs: 40, intervalMs: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /未上线/);
  assert.match(result.error, /ECONNREFUSED/);
  assert.equal(botSpawns.length, 1);
  assert.equal(bot.getLaunchState().phase, 'failed');
});

test('launchNapCat：并发调用去重，只 spawn 一次', async () => {
  const { bot, botSpawns } = await makeLaunchHarness({
    qqbot: { launchCommand: 'C:\\NC\\launcher.bat' },
    fetchResults: [{ ok: false }, { ok: true }],
  });
  const [first, second] = await Promise.all([
    bot.launchNapCat({ waitMs: 3000, intervalMs: 5 }),
    bot.launchNapCat({ waitMs: 3000, intervalMs: 5 }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(botSpawns.length, 1, '并发拉起应合并为一次 spawn');
});

test('launchNapCat：状态变化经 onEvent 推送（launching → online）', async () => {
  const { bot, launchEvents } = await makeLaunchHarness({
    qqbot: { launchCommand: 'C:\\NC\\launcher.bat', launchQq: '10001' },
    fetchResults: [{ ok: false }, { ok: false }, { ok: true }],
  });
  const result = await bot.launchNapCat({ waitMs: 3000, intervalMs: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(launchEvents.map((e) => e.phase), ['launching', 'online']);
  assert.equal(launchEvents[1].account, '888000');
});

test('markLaunchOnline：宽限窗口登录成功时纠正拉起状态并推送', async () => {
  const { bot, launchEvents } = await makeLaunchHarness({
    qqbot: { launchCommand: 'C:\\NC\\launcher.bat' },
    fetchResults: [{ ok: false, error: 'ECONNREFUSED' }],
  });
  // 模拟拉起窗口超时（failed）后，安装器宽限轮询探到登录成功
  await bot.launchNapCat({ waitMs: 40, intervalMs: 5 });
  assert.equal(bot.getLaunchState().phase, 'failed');
  bot.markLaunchOnline('777000');
  assert.equal(bot.getLaunchState().phase, 'online');
  assert.equal(bot.getLaunchState().account, '777000');
  assert.deepEqual(launchEvents.map((e) => e.phase), ['launching', 'failed', 'online']);
  // 相同状态不重复推送
  bot.markLaunchOnline('777000');
  assert.equal(launchEvents.length, 3);
});

test('launchNapCat：超时失败信息带上 WebUI 登录阶段提示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-qq-hint-'));
  try {
    // launchCommand 同级的 config/webui.json 是 WebUI 探测的前提（Shell 布局）
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'webui.json'), JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'test-token' }));
    const launchCommand = path.join(dir, 'launcher-user.bat');
    fs.writeFileSync(launchCommand, '@echo off\r\n');
    // 按 URL 分流：OneBot 探测一律拒连，WebUI 报告停在等待扫码
    const routed = async (url) => {
      const target = String(url);
      if (target.includes('/api/auth/login')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { Credential: 'cred-1' } }) };
      }
      if (target.includes('/api/QQLogin/CheckLoginStatus')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: false, loginPhase: 'waiting_qrcode' } }) };
      }
      throw new Error('ECONNREFUSED');
    };
    const { bot } = await makeLaunchHarness({ qqbot: { launchCommand }, fetchImpl: routed });
    const startedAt = Date.now();
    const result = await bot.launchNapCat({ waitMs: 3000, intervalMs: 5, hintAfterMs: 10 });
    assert.equal(result.ok, false);
    // 探到「等扫码」后提前收场，不等满 waitMs
    assert.ok(Date.now() - startedAt < 2500, '应在探到等待扫码后提前结束');
    assert.match(result.error, /快速登录未生效/);
    assert.match(result.error, /等待扫码登录/);
    assert.equal(bot.getLaunchState().phase, 'failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeAutoLaunch：未开启/未配置时不拉起，条件齐备时拉起', async () => {
  const idle = await makeLaunchHarness({
    qqbot: { enabled: false, autoLaunch: true, launchCommand: 'C:\\NC\\launcher.bat' },
    fetchResults: [{ ok: false, error: 'x' }],
  });
  assert.equal(await idle.bot.maybeAutoLaunch(), null);
  assert.equal(idle.botSpawns.length, 0);

  const active = await makeLaunchHarness({
    qqbot: { enabled: true, autoLaunch: true, launchCommand: 'C:\\NC\\launcher.bat' },
    fetchResults: [{ ok: false }, { ok: true }],
  });
  const result = await active.bot.maybeAutoLaunch();
  assert.equal(result.ok, true);
  assert.equal(active.botSpawns.length, 1);
});

test('normalizeQqBot：自动拉起字段的默认值与清洗', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-qqstore-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    qqbot: { autoLaunch: true, launchCommand: '  C:\\NC\\launcher.bat  ', launchQq: '12345' },
  }));
  const store = createStore({ configPath });
  const cfg = store.get().qqbot;
  assert.equal(cfg.autoLaunch, true);
  assert.equal(cfg.launchCommand, 'C:\\NC\\launcher.bat');
  assert.equal(cfg.launchQq, '12345');

  store.update((draft) => {
    draft.qqbot.launchQq = 'abc';
    draft.qqbot.autoLaunch = 'yes';
  });
  const cleaned = store.get().qqbot;
  assert.equal(cleaned.launchQq, '', '非法 QQ 清空');
  assert.equal(cleaned.autoLaunch, false, 'autoLaunch 只认布尔 true');

  const defaults = createStore({ configPath: path.join(dir, 'none.json') }).get().qqbot;
  assert.equal(defaults.autoLaunch, false);
  assert.equal(defaults.launchCommand, '');
  assert.equal(defaults.launchQq, '');
});

// ---- NapCat 启动命令自动识别 ----

const { detectNapCatCommand } = require('../src/core/qq-bot.js');

/** 建一个临时候选目录，写入指定文件名（空数组=目录存在但无启动脚本）。 */
function makeRoot(dir, name, files) {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(root, file), '');
  return root;
}

test('detectNapCatCommand：根目录顺序优先，目录内按已知入口名优先级挑选', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-detect-'));
  try {
    const onlyExe = makeRoot(dir, 'only-exe', ['NapCatHelper.exe']);   // 兜底 exe 命中
    const shell = makeRoot(dir, 'NapCat.Shell_1.2.3', ['napcat.mjs', 'launcher.bat', 'NapCatWinBootMain.bat']);
    const empty = makeRoot(dir, 'empty', ['readme.txt']);              // 无脚本，跳过
    let found = detectNapCatCommand({ roots: [empty, onlyExe] });
    assert.equal(found.command, path.join(onlyExe, 'NapCatHelper.exe'));
    found = detectNapCatCommand({ roots: [shell] });
    assert.equal(found.command, path.join(shell, 'NapCatWinBootMain.bat'), '入口名优先级高于兜底排序');
    found = detectNapCatCommand({ roots: [path.join(dir, '不存在')] });
    assert.equal(found, null, '不存在的目录跳过');
    assert.equal(detectNapCatCommand({ roots: [] }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launchNapCat：未配置命令时用自动识别结果启动', async () => {
  const detected = 'D:\\Tools\\NapCat\\launcher.bat';
  const { bot, botSpawns } = await makeLaunchHarness({
    qqbot: { launchQq: '10002' },
    fetchResults: [{ ok: false }, { ok: true }],
    detect: () => ({ command: detected, source: 'D:\\Tools\\NapCat' }),
  });
  const result = await bot.launchNapCat({ waitMs: 3000, intervalMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.detected, true);
  assert.equal(botSpawns.length, 1);
  assert.ok(botSpawns[0].args.join(' ').includes(`${detected} -q 10002`));
});

test('maybeAutoLaunch：命令留空但能识别到 NapCat 时也拉起', async () => {
  const { bot, botSpawns } = await makeLaunchHarness({
    qqbot: { enabled: true, autoLaunch: true },
    fetchResults: [{ ok: false }, { ok: true }],
    detect: () => ({ command: 'C:\\NapCat\\launcher.bat', source: 'C:\\NapCat' }),
  });
  const result = await bot.maybeAutoLaunch();
  assert.equal(result.ok, true);
  assert.equal(botSpawns.length, 1);

  const none = await makeLaunchHarness({
    qqbot: { enabled: true, autoLaunch: true },
    detect: () => null,
  });
  assert.equal(await none.bot.maybeAutoLaunch(), null);
  assert.equal(none.botSpawns.length, 0);
});

// ---- NapCat onebot11 网络配置写入 ----

const { syncNapCatConfig } = require('../src/core/qq-bot.js');

/** 造一个 NapCat Shell 风格目录：<dir>/config/ 存放 onebot11 配置。 */
function napcatDirWith(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-ncfg-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'config', name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('syncNapCatConfig：全新安装时创建默认模板（端口/令牌/上报地址）', () => {
  const dir = napcatDirWith();
  try {
    const result = syncNapCatConfig({
      configDir: path.join(dir, 'config'), port: 3001, token: 'sec', webhook: 'http://127.0.0.1:18120/onebot/event', eventToken: 'evt', qq: '',
    });
    assert.equal(result.action, 'created');
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'onebot11.json'), 'utf8'));
    const server = data.network.httpServers[0];
    assert.equal(server.name, 'gptplus-api');
    assert.equal(server.enable, true);
    assert.equal(server.port, 3001);
    assert.equal(server.token, 'sec');
    const client = data.network.httpClients[0];
    assert.equal(client.name, 'gptplus-report');
    assert.equal(client.url, 'http://127.0.0.1:18120/onebot/event');
    assert.equal(client.token, 'evt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncNapCatConfig：已有配置只同步自有条目，不碰用户其它设置', () => {
  const existing = {
    network: {
      httpServers: [
        { name: '用户自己的', enable: true, port: 6099, host: '0.0.0.0', token: 'keep' },
        { name: 'gptplus-api', enable: true, port: 3000, host: '127.0.0.1', token: '' },
      ],
      httpClients: [],
    },
    musicSignUrl: 'http://example.com',
  };
  const dir = napcatDirWith({ 'onebot11_1554482628.json': existing });
  try {
    const result = syncNapCatConfig({
      configDir: path.join(dir, 'config'), port: 3001, token: '', webhook: 'http://127.0.0.1:18120/onebot/event', eventToken: '', qq: '1554482628',
    });
    assert.equal(result.action, 'synced');
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'onebot11_1554482628.json'), 'utf8'));
    const mine = data.network.httpServers.find((s) => s.name === 'gptplus-api');
    assert.equal(mine.port, 3001, '自有条目端口被同步');
    const theirs = data.network.httpServers.find((s) => s.name === '用户自己的');
    assert.equal(theirs.port, 6099, '用户条目不动');
    assert.equal(data.musicSignUrl, 'http://example.com');
    assert.equal(data.network.httpClients[0].url, 'http://127.0.0.1:18120/onebot/event', '补齐上报客户端');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncNapCatConfig：目录不存在或配置不含自有条目时安全跳过', () => {
  assert.equal(syncNapCatConfig({ configDir: 'C:\\不存在的目录', port: 3001 }).action, 'skipped');
  const dir = napcatDirWith({ 'onebot11.json': { network: { httpServers: [], httpClients: [] } } });
  try {
    const result = syncNapCatConfig({
      configDir: path.join(dir, 'config'), port: 3001, token: '', webhook: 'x', eventToken: '', qq: '',
    });
    assert.equal(result.action, 'noop', '不含自有条目不新增不修改');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
