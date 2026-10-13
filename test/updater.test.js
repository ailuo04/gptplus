'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setupAutoUpdater } = require('../src/main/updater.js');

function createUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: { version: '0.1.1' } });
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => {};
  return updater;
}

test('开发模式跳过自动更新', async () => {
  const controller = setupAutoUpdater({
    app: { isPackaged: false },
    autoUpdater: createUpdater(),
    dialog: {},
    isDev: true,
  });
  assert.equal(controller.enabled, false);
  assert.equal(await controller.checkForUpdates(), null);
});

test('发现更新后自动下载，下载完成后可立即安装', async () => {
  const updater = createUpdater();
  const logs = [];
  let installed = false;
  let messageBoxCalls = 0;
  updater.quitAndInstall = () => { installed = true; };
  const controller = setupAutoUpdater({
    app: { isPackaged: true },
    autoUpdater: updater,
    dialog: {
      showMessageBox: async () => {
        messageBoxCalls += 1;
        return { response: 0 };
      },
    },
    onLog: (entry) => logs.push(entry),
  });

  assert.equal(controller.enabled, true);
  await controller.checkForUpdates();
  updater.emit('update-available');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof updater.downloadUpdate, 'function');

  updater.emit('update-downloaded');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageBoxCalls, 1);
  assert.equal(installed, true);
  assert.ok(logs.some((entry) => entry.msg.includes('发现新版本')));
});
