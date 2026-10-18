'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { launchChatGpt } = require('../src/core/chatgpt-launch.js');

function launcher(options = {}) {
  const calls = [];
  return {
    calls,
    options: {
      resolveExe: async () => 'C:\\Apps\\ChatGPT.exe',
      resolveAppId: async () => options.appId || null,
      spawnImpl: (command, args, settings) => {
        calls.push({ command, args, settings });
        const child = new EventEmitter();
        child.on('error', () => {});
        child.unref = () => calls.push('unref');
        process.nextTick(() => {
          if (options.failAll || (options.failShell && command === 'explorer.exe')) {
            child.emit('error', new Error('spawn failed'));
          } else {
            child.emit('spawn');
          }
        });
        return child;
      },
    },
  };
}

test('registered ChatGPT is activated through Windows shell instead of only spawning its executable', async () => {
  const { calls, options } = launcher({ appId: 'OpenAI.Codex_publisher!App' });
  assert.deepEqual(await launchChatGpt(options), { ok: true, exe: 'C:\\Apps\\ChatGPT.exe' });
  assert.equal(calls[0].command, 'explorer.exe');
  assert.deepEqual(calls[0].args, ['shell:AppsFolder\\OpenAI.Codex_publisher!App']);
  assert.equal(calls[0].settings.windowsHide, true);
  assert.equal(calls[0].settings.detached, true);
  assert.deepEqual(calls.slice(1), ['unref']);
});

test('a manually selected non-package executable still launches directly', async () => {
  const { calls, options } = launcher();
  assert.equal((await launchChatGpt(options)).ok, true);
  assert.equal(calls[0].command, 'C:\\Apps\\ChatGPT.exe');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].settings.windowsHide, false);
});

test('failed Windows shell activation falls back to the executable without killing any client', async () => {
  const { calls, options } = launcher({ appId: 'OpenAI.Codex_publisher!App', failShell: true });
  assert.equal((await launchChatGpt(options)).ok, true);
  assert.deepEqual(calls.filter((call) => call !== 'unref').map((call) => call.command), [
    'explorer.exe', 'C:\\Apps\\ChatGPT.exe',
  ]);
});

test('asynchronous spawn errors are returned as a failure instead of logging a successful launch', async () => {
  const { options } = launcher({ failAll: true });
  assert.deepEqual(await launchChatGpt(options), { ok: false, error: 'spawn failed' });
});

test('package discovery failure does not prevent launching a valid executable', async () => {
  const { calls, options } = launcher();
  options.resolveAppId = async () => { throw new Error('package unavailable'); };
  assert.equal((await launchChatGpt(options)).ok, true);
  assert.equal(calls[0].command, 'C:\\Apps\\ChatGPT.exe');
});
