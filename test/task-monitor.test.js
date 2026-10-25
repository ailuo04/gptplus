'use strict';
// ChatGPT 桌面端任务监听：开始/完成即时通知、5 分钟进度、完成后停止。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskMonitor, isTitleGenBody } = require('../src/core/task-monitor.js');

function body(text = '修复登录超时') {
  return {
    instructions: 'You are Codex.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  };
}

test('task-monitor: 开始即通知，5 分钟进度，完成后立即停止进度', () => {
  let at = 0;
  const events = [];
  const monitor = createTaskMonitor({ now: () => at, onNotify: (event) => events.push(event) });
  const payload = body();
  monitor.turnRequest({ body: payload, slug: 'gpt-test' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'started');
  assert.equal(events[0].task.title, '修复登录超时');
  assert.equal(events[0].task.model, 'gpt-test');

  at = 4 * 60 * 1000;
  monitor.tick();
  assert.equal(events.length, 1, '不到 5 分钟不发进度');

  at = 5 * 60 * 1000;
  monitor.tick();
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'progress');

  at = 9 * 60 * 1000;
  monitor.tick();
  assert.equal(events.length, 2, '进度间隔按 5 分钟计算');

  at = 10 * 60 * 1000;
  monitor.tick();
  assert.equal(events.length, 3);
  assert.equal(events[2].kind, 'progress');

  monitor.turnResponse({ body: payload, slug: 'gpt-test', ok: true, status: 200, hasToolCalls: false, text: '完成' });
  assert.equal(events.length, 4);
  assert.equal(events[3].kind, 'done');
  assert.equal(events[3].task.endedAt, at);
  assert.equal(events[3].task.lastText, '完成');

  at = 30 * 60 * 1000;
  monitor.tick();
  assert.equal(events.length, 4, '完成后不再发 5 分钟进度');
  monitor.stop();
});

test('task-monitor: 工具调用期间保持同一任务，最终答复才完成', () => {
  let at = 1000;
  const events = [];
  const monitor = createTaskMonitor({ now: () => at, onNotify: (event) => events.push(event) });
  const payload = body('跑测试并修复');
  monitor.turnRequest({ body: payload, slug: 'm' });
  monitor.turnResponse({ body: payload, ok: true, status: 200, hasToolCalls: true, text: '' });
  assert.deepEqual(events.map((e) => e.kind), ['started'], '工具调用不能提前完成');

  at += 1000;
  monitor.turnRequest({ body: payload, slug: 'm' });
  assert.deepEqual(events.map((e) => e.kind), ['started'], '同一轮请求不能重复开始');
  assert.equal(monitor.listRunning()[0].rounds, 2);

  monitor.turnResponse({ body: payload, ok: true, status: 200, hasToolCalls: false, text: '已修复' });
  assert.deepEqual(events.map((e) => e.kind), ['started', 'done']);
  assert.equal(events[1].task.rounds, 2);
  monitor.stop();
});

test('task-monitor: 失败等待重试，超时后失败收口；运行中请求不会被误判 stale', () => {
  let at = 0;
  const events = [];
  const monitor = createTaskMonitor({ now: () => at, onNotify: (event) => events.push(event) });
  const payload = body('失败任务');
  const started = monitor.turnRequest({ body: payload, slug: 'm' });
  monitor.requestStarted({ turnKey: started.turnKey, requestId: 'r1', abort: () => {} });
  monitor.turnResponse({ body: payload, ok: false, status: 502, hasToolCalls: false, text: '' });

  at = 20 * 60 * 1000 + 1;
  monitor.tick();
  assert.equal(events.filter((e) => e.kind === 'failed').length, 0, '请求仍在途时不能判 stale/failed');
  monitor.requestFinished({ requestId: 'r1' });

  at += 5 * 60 * 1000 + 1;
  monitor.tick();
  assert.equal(events.filter((e) => e.kind === 'failed').length, 1);
  monitor.stop();
});

test('task-monitor: 标题生成请求不产生任务通知', () => {
  const titleBody = {
    instructions: 'You are a helpful assistant. Return a title JSON.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'You are a helpful assistant. Return title.' }] }],
  };
  assert.equal(isTitleGenBody(titleBody), true);
  const events = [];
  const monitor = createTaskMonitor({ now: () => 0, onNotify: (event) => events.push(event) });
  assert.equal(monitor.turnRequest({ body: titleBody, slug: 'm' }), null);
  assert.equal(events.length, 0);
  monitor.stop();
});
