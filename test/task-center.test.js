'use strict';
// 任务中心测试：gateway 任务观察（开始/合并/完成/失败/中断/过期）、
// 进度通知节流、exec 任务的 codex exec 子进程驱动、插入排队与停止。
// 全部使用注入的 now 与 spawnImpl，不启动真实 codex。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createStore } = require('../src/core/store.js');
const { createTaskCenter, lastUserText, turnKeyOf } = require('../src/core/task-center.js');

function makeHarness({ clockStart = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-tc-'));
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  // 固定 codex 路径，resolveCodex 不依赖机器环境。
  const codexPath = path.join(dir, 'codex.exe');
  fs.writeFileSync(codexPath, '');
  store.update((draft) => {
    draft.qqbot.codexPath = codexPath;
    draft.qqbot.workspaceDir = dir;
  });

  let clock = clockStart;
  const spawns = [];
  const notifications = [];
  /** @type {Map<any, any>} 每次 spawn 返回的假子进程 */
  const children = [];
  const spawnImpl = (command, args, opts) => {
    const child = new FakeChild();
    spawns.push({ command, args: args.slice(), opts, child });
    children.push(child);
    return child;
  };
  const center = createTaskCenter({ store, log: () => {}, now: () => clock, spawnImpl });
  center.on('notify', (payload) => notifications.push(payload));
  return {
    store,
    center,
    notifications,
    spawns,
    children,
    dir,
    advance: (ms) => { clock += ms; },
    clock: () => clock,
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() {
    this.killed = true;
    return true;
  }
}

/** 构造一个 Responses 请求体：lastIsUser=false 模拟工具回灌后的续轮。 */
function makeBody({ user = '写一个排序脚本', lastIsUser = true, instructions = 'BASE-INSTRUCTIONS' } = {}) {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }];
  if (!lastIsUser) {
    input.push({ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' });
    input.push({ type: 'function_call_output', call_id: 'c1', output: 'ok' });
  }
  return { instructions, input, model: '梦幻__gpt-6', stream: true };
}

test('lastUserText 取最后一条 user 消息，忽略工具回灌项', () => {
  assert.equal(lastUserText(makeBody()), '写一个排序脚本');
  assert.equal(lastUserText(makeBody({ lastIsUser: false })), '写一个排序脚本');
  assert.equal(lastUserText({ input: [] }), '');
  // 环境上下文（也是 user 消息）不会被误当成任务标题来源：取的是“最后一条”
  const envBody = {
    instructions: 'i',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真正的请求' }] },
    ],
  };
  assert.equal(lastUserText(envBody), '真正的请求');
});

test('同一轮的请求与工具续轮归并为一个任务，rounds 递增', () => {
  const { center } = makeHarness();
  const first = center.turnRequest({ body: makeBody(), slug: '梦幻__gpt-6' });
  assert.ok(first && first.turnKey);
  center.turnRequest({ body: makeBody({ lastIsUser: false }), slug: '梦幻__gpt-6' });
  const tasks = center.listTasks();
  assert.equal(tasks.running.length, 1);
  assert.equal(tasks.running[0].rounds, 2);
  assert.equal(tasks.running[0].title, '写一个排序脚本');
  assert.equal(tasks.running[0].model, '梦幻__gpt-6');
  assert.equal(tasks.running[0].kind, 'gateway');
});

test('不同提示词是不同任务', () => {
  const { center } = makeHarness();
  center.turnRequest({ body: makeBody({ user: '任务A' }), slug: 's' });
  center.turnRequest({ body: makeBody({ user: '任务B' }), slug: 's' });
  assert.equal(center.listTasks().running.length, 2);
});

test('客户端自动的会话标题生成请求不建任务、不通知', () => {
  const { center, notifications } = makeHarness();
  const titlePrompt = 'You are a helpful assistant. You will be presented with a user conversation '
    + 'and will only be outputting a title for the conversation in JSON format '
    + 'with {"description": string, "title": string}';
  // 起名指令作为最后一条 user 消息（桌面端实际形态）
  const body = makeBody({ user: `${titlePrompt}\n\n用户：变量是什么` });
  assert.equal(center.turnRequest({ body, slug: 's' }), null);
  center.turnResponse({ body, ok: true, status: 200, hasToolCalls: false, text: '{"description":"解释变量","title":"解释变量概念"}' });
  assert.equal(center.listTasks().running.length, 0);
  assert.equal(center.listTasks().recent.length, 0);
  assert.equal(notifications.length, 0);
  // 起名指令在 instructions 里同样过滤
  const instrBody = makeBody({ instructions: titlePrompt, user: '对话内容' });
  assert.equal(center.turnRequest({ body: instrBody, slug: 's' }), null);
  // 真人提问不受影响
  const real = center.turnRequest({ body: makeBody({ user: '变量是什么' }), slug: 's' });
  assert.ok(real && real.turnKey);
  assert.equal(center.listTasks().running.length, 1);
});

test('无工具调用的成功响应 -> 任务完成通知（含耗时）', () => {
  const h = makeHarness({ clockStart: 1000 });
  const body = makeBody();
  h.center.turnRequest({ body, slug: 's' });
  h.advance(90_000);
  h.center.turnResponse({ body, slug: 's', ok: true, status: 200, hasToolCalls: false, text: '完成了' });
  const list = h.center.listTasks();
  assert.equal(list.running.length, 0);
  assert.equal(list.recent.length, 1);
  assert.equal(list.recent[0].status, 'done');
  assert.equal(list.recent[0].lastText, '完成了');
  assert.equal(list.recent[0].endedAt - list.recent[0].startedAt, 90_000);
  const done = h.notifications.find((n) => n.kind === 'done');
  assert.ok(done, '应发出 done 通知');
  assert.equal(done.task.status, 'done');
});

test('带工具调用的成功响应不结束任务，最终响应结束', () => {
  const { center } = makeHarness();
  const body = makeBody();
  center.turnRequest({ body, slug: 's' });
  center.turnResponse({ body, slug: 's', ok: true, status: 200, hasToolCalls: true, text: '调用工具' });
  assert.equal(center.listTasks().running.length, 1);
  const body2 = makeBody({ lastIsUser: false });
  center.turnRequest({ body: body2, slug: 's' });
  center.turnResponse({ body: body2, slug: 's', ok: true, status: 200, hasToolCalls: false, text: '最终答案' });
  assert.equal(center.listTasks().running.length, 0);
  assert.equal(center.listTasks().recent[0].status, 'done');
});

test('客户端中断(499) -> 已停止，冷却期内同 key 重试不再建任务', () => {
  const { center } = makeHarness();
  const body = makeBody();
  center.turnRequest({ body, slug: 's' });
  center.turnResponse({ body, slug: 's', ok: false, status: 499, hasToolCalls: false });
  assert.equal(center.listTasks().recent[0].status, 'stopped');
  const retried = center.turnRequest({ body, slug: 's' });
  assert.equal(retried, null, '冷却期内同 key 重试不跟踪');
  assert.equal(center.listTasks().running.length, 0);
  // 不同提示词不受冷却影响
  const other = center.turnRequest({ body: makeBody({ user: '新请求' }), slug: 's' });
  assert.ok(other);
});

test('上游失败不立即收口，客户端放弃后由 sweep 判失败', () => {
  const h = makeHarness();
  const body = makeBody();
  h.center.turnRequest({ body, slug: 's' });
  h.center.turnResponse({ body, slug: 's', ok: false, status: 502, hasToolCalls: false });
  assert.equal(h.center.listTasks().running.length, 1, '客户端可能重试，先不收口');
  h.advance(4 * 60 * 1000);
  h.center.tick();
  const list = h.center.listTasks();
  assert.equal(list.running.length, 0);
  assert.equal(list.recent[0].status, 'failed');
  assert.ok(h.notifications.some((n) => n.kind === 'failed'));
});

test('进度通知按间隔节流，长时间运行的任务空闲过期收口', () => {
  const h = makeHarness({ clockStart: 0 });
  const body = makeBody();
  h.center.turnRequest({ body, slug: 's' });
  h.advance(5 * 60 * 1000 + 1000);
  h.center.tick();
  assert.equal(h.notifications.filter((n) => n.kind === 'progress').length, 1);
  h.advance(10_000);
  h.center.tick();
  assert.equal(h.notifications.filter((n) => n.kind === 'progress').length, 1, '间隔内不重复提醒');
  h.advance(5 * 60 * 1000);
  h.center.tick();
  assert.equal(h.notifications.filter((n) => n.kind === 'progress').length, 2);
  // 长时间没有任何新请求 -> stale
  h.advance(11 * 60 * 1000);
  h.center.tick();
  assert.equal(h.center.listTasks().recent[0].status, 'stale');
  assert.ok(h.notifications.some((n) => n.kind === 'stale'));
});

test('停止 gateway 任务：断开在途请求并按已停止收口', () => {
  const { center } = makeHarness();
  const body = makeBody();
  const info = center.turnRequest({ body, slug: 's' });
  let aborted = 0;
  center.requestStarted({ turnKey: info.turnKey, requestId: 'req_1', abort: () => { aborted += 1; } });
  const task = center.listTasks().running[0];
  center.stopTask(task.id);
  assert.equal(aborted, 1, '应调用断开句柄');
  // 断开的请求以失败回到 turnResponse，应立即标记停止
  center.turnResponse({ body, slug: 's', ok: false, status: 502, hasToolCalls: false });
  assert.equal(center.listTasks().recent[0].status, 'stopped');
  assert.ok(center.listTasks().running.length === 0);
});

test('exec 任务：解析 JSONL 事件，完成后通知', async () => {
  const h = makeHarness();
  const { task } = await h.center.startExecTask({ prompt: '帮我写单元测试' });
  assert.equal(task.kind, 'exec');
  assert.ok(task.id.startsWith('e_'));
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].args[0], 'exec');
  assert.ok(h.spawns[0].args.includes('--json'));
  assert.ok(h.spawns[0].args.includes('帮我写单元测试'));
  assert.equal(h.center.listTasks().running.length, 1);

  const child = h.children[0];
  child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: 'T1' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '测试写好了' } }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'turn.completed', usage: { total_tokens: 1234 } }) + '\n');
  child.emit('close', 0);

  const list = h.center.listTasks();
  assert.equal(list.running.length, 0);
  assert.equal(list.recent[0].status, 'done');
  assert.equal(list.recent[0].sessionId, 'T1');
  assert.equal(list.recent[0].lastText, '测试写好了');
  assert.equal(list.recent[0].tokens, 1234);
  assert.ok(h.notifications.some((n) => n.kind === 'done'));
});

test('exec 任务：运行中插入排队，当前轮完成后自动 resume 续跑', async () => {
  const h = makeHarness();
  const { task } = await h.center.startExecTask({ prompt: '第一轮' });
  const queued = await h.center.followUp(task.id, '顺便加上注释');
  assert.equal(queued.queued, true);
  assert.equal(queued.position, 1);

  const child = h.children[0];
  child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: 'S1' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'turn.completed' }) + '\n');
  child.emit('close', 0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.spawns.length, 2, '第一轮结束后应自动续跑');
  assert.equal(h.spawns[1].args[1], 'resume');
  assert.ok(h.spawns[1].args.includes('S1'));
  assert.ok(h.spawns[1].args.includes('顺便加上注释'));
  assert.equal(h.center.listTasks().running.length, 1);
});

test('exec 任务：已结束后插入 -> 直接 resume；停止 -> 杀进程树', async () => {
  const h = makeHarness();
  const { task } = await h.center.startExecTask({ prompt: '跑一下' });
  const child = h.children[0];
  child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: 'S9' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'turn.completed' }) + '\n');
  child.emit('close', 0);
  assert.equal(h.center.listTasks().running.length, 0);

  await h.center.followUp(task.id, '再检查一遍');
  assert.equal(h.spawns.length, 2);
  assert.ok(h.spawns[1].args.includes('resume'));

  const running = h.center.listTasks().running[0];
  h.center.stopTask(running.id);
  if (process.platform === 'win32') {
    assert.ok(h.spawns.some((call) => call.command === 'taskkill.exe'), 'Windows 上应通过 taskkill 结束进程树');
  }
  assert.equal(h.center.listTasks().recent[0].status, 'stopped');
});

test('exec 任务失败：turn.failed / 异常退出都标记 failed', async () => {
  const h = makeHarness();
  await h.center.startExecTask({ prompt: '会失败的任务' });
  const child = h.children[0];
  child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: '模型超时' } }) + '\n');
  child.emit('close', 1);
  const recent = h.center.listTasks().recent[0];
  assert.equal(recent.status, 'failed');
  assert.equal(recent.lastError, '模型超时');
});

test('startExecTask 校验工作目录', async () => {
  const h = makeHarness();
  await assert.rejects(
    () => h.center.startExecTask({ prompt: 'x', cwd: path.join(h.dir, '不存在') }),
    /工作目录不存在/,
  );
  await assert.rejects(() => h.center.startExecTask({ prompt: '  ' }), /不能为空/);
});

test('followUp 拒绝 gateway 任务', async () => {
  const h = makeHarness();
  h.center.turnRequest({ body: makeBody(), slug: 's' });
  const task = h.center.listTasks().running[0];
  await assert.rejects(() => h.center.followUp(task.id, '新要求'), /只能查看或停止/);
});
