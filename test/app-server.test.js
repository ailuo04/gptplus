'use strict';
// Codex app-server 客户端：纯函数 + 真实子进程 JSON-RPC 往返。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createCodexAppServer,
  extractThreadId,
  extractTurnId,
  extractModel,
  extractTurnUsage,
  extractCompletedAgentText,
  threadStatusIsIdle,
  buildAppServerArgs,
  buildTurnInput,
} = require('../src/core/codex-app-server.js');

test('app-server: 参数构造把 -c 覆盖放在 app-server 子命令之前', () => {
  assert.deepEqual(buildAppServerArgs({}), ['app-server']);
  assert.deepEqual(
    buildAppServerArgs({ configOverrides: ['model_providers.gptplus.http_headers.X-Gptplus-Source=weixin'] }),
    ['-c', 'model_providers.gptplus.http_headers.X-Gptplus-Source=weixin', 'app-server'],
  );
});

test('app-server: turn 输入可同时携带文字和图片 file URL', () => {
  assert.deepEqual(buildTurnInput('看图', []), [{ type: 'text', text: '看图', text_elements: [] }]);
  const input = buildTurnInput('看图', ['file:///C:/tmp/a.png']);
  assert.equal(input.length, 2);
  assert.deepEqual(input[1], { type: 'image', url: 'file:///C:/tmp/a.png', detail: 'auto' });
});

test('app-server: 从当前响应形状提取线程、turn、模型与上下文用量', () => {
  assert.equal(extractThreadId({ thread: { id: 't1' } }), 't1');
  assert.equal(extractTurnId({ turn: { id: 'u1' } }), 'u1');
  assert.equal(extractModel({ model: 'gpt-test' }), 'gpt-test');
  assert.deepEqual(
    extractTurnUsage({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { last: { totalTokens: 41772 }, modelContextWindow: 1000000 } },
    }),
    { contextUsed: 41772, contextWindow: 1000000 },
  );
  assert.equal(
    extractCompletedAgentText({ params: { item: { type: 'agentMessage', text: ' done ' } } }),
    'done',
  );
  assert.equal(
    extractCompletedAgentText({ params: { item: { type: 'userMessage', text: 'input' } } }),
    null,
  );
  assert.equal(threadStatusIsIdle({ params: { status: { type: 'idle' } } }), true);
  assert.equal(threadStatusIsIdle({ params: { status: { type: 'running' } } }), false);
});

test('app-server: 真实子进程完成 initialize → thread → turn，并拒绝审批请求', async () => {
  const server = await createCodexAppServer({
    executable: process.execPath,
    args: [path.join(__dirname, 'fixtures', 'fake-app-server.js')],
    workDir: __dirname,
    model: 'test-model',
    sandbox: 'read-only',
  });
  try {
    assert.equal(server.isRunning(), true);
    assert.equal(await server.prepareThread(null), 'thread-1');
    assert.equal(await server.prepareThread('saved-thread'), 'thread-1');
    const turn = await server.runTurn('thread-1', 'hello');
    assert.equal(turn.reply, 'hello from fake');
    assert.equal(turn.model, 'test-model');
    assert.deepEqual(turn.usage, { contextUsed: 25, contextWindow: 100 });
  } finally {
    await server.close();
  }
  assert.equal(server.isRunning(), false);
});

test('app-server: 不存在的 CLI 给出可读错误', async () => {
  await assert.rejects(
    () => createCodexAppServer({
      executable: path.join(__dirname, 'fixtures', 'missing-codex.exe'),
      workDir: __dirname,
    }),
    /Codex app-server|启动失败/,
  );
});
