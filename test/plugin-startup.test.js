'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launchThenRestore, restoreEnabledPagePlugins } = require('../src/core/plugin-startup.js');

test('ChatGPT launch begins before gateway and plugin prerequisites finish', async () => {
  const calls = [];
  let finishLaunch;
  let finishPrerequisites;
  const launchTask = new Promise((resolve) => { finishLaunch = resolve; });
  const prerequisites = new Promise((resolve) => { finishPrerequisites = resolve; });
  const task = launchThenRestore({
    launch: () => { calls.push('launch'); return launchTask; },
    prerequisites,
    restore: async (result) => { calls.push(['restore', result]); },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['launch']);
  finishLaunch({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['launch']);
  finishPrerequisites();
  await task;
  assert.deepEqual(calls, ['launch', ['restore', { ok: true }]]);
});

test('enabled page plugins restore after launch in order on the same CDP port', async () => {
  const calls = [];
  const result = await restoreEnabledPagePlugins({
    ctx: {
      plugins: {
        isActive: (id) => ['usage-statusline', 'voice-input'].includes(id),
        config: () => ({ balance: { enabled: true } }),
      },
    },
    cdpPort: 9338,
    resumeUsageStatusline: async (options) => { calls.push(['usage', await options.findPort()]); return { ok: true }; },
    resumeChatGptBalance: async (options) => { calls.push(['balance', await options.findPort()]); return { ok: true }; },
    resumeVoiceInput: async (options) => { calls.push(['voice', await options.findPort()]); return { ok: true }; },
  });

  assert.deepEqual(calls, [['usage', 9338], ['balance', 9338], ['voice', 9338]]);
  assert.deepEqual(result.map(({ id, ok }) => [id, ok]), [
    ['usage-statusline', true], ['balance', true], ['voice-input', true],
  ]);
});
