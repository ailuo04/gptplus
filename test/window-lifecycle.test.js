'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowLifecycle } = require('../src/main/window-lifecycle.js');

function makeLifecycle(options = {}) {
  const calls = [];
  const lifecycle = createWindowLifecycle({
    isSmoke: options.isSmoke === true,
    isQuitting: () => options.isQuitting === true,
    hideWindow: () => calls.push('hide'),
  });
  return { lifecycle, calls };
}

test('普通窗口关闭会隐藏到后台而不是退出', () => {
  const { lifecycle, calls } = makeLifecycle();
  let prevented = false;

  lifecycle.handleClose({ preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ['hide']);
});

test('真正退出时窗口关闭事件不再拦截', () => {
  const { lifecycle, calls } = makeLifecycle({ isQuitting: true });
  let prevented = false;

  lifecycle.handleClose({ preventDefault: () => { prevented = true; } });

  assert.equal(prevented, false);
  assert.deepEqual(calls, []);
});

test('冒烟测试模式保留原来的自动退出行为', () => {
  const { lifecycle, calls } = makeLifecycle({ isSmoke: true });
  let prevented = false;

  lifecycle.handleClose({ preventDefault: () => { prevented = true; } });

  assert.equal(prevented, false);
  assert.deepEqual(calls, []);
});
