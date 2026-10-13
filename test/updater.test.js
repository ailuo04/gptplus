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
    isDev: true,
  });
  assert.equal(controller.enabled, false);
  assert.equal((await controller.checkForUpdates()).status, 'disabled');
});

test('发现更新后只记录版本，用户确认后才下载并安装', async () => {
  const updater = createUpdater();
  const logs = [];
  let installed = false;
  let downloadCalls = 0;
  updater.downloadUpdate = async () => { downloadCalls += 1; };
  updater.quitAndInstall = () => { installed = true; };
  const controller = setupAutoUpdater({
    app: { isPackaged: true, getVersion: () => '0.1.0' },
    autoUpdater: updater,
    onLog: (entry) => logs.push(entry),
  });

  assert.equal(controller.enabled, true);
  await controller.checkForUpdates();
  updater.emit('update-available', { version: '0.1.1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloadCalls, 0);
  assert.equal(controller.getState().status, 'available');

  await controller.downloadUpdate();
  assert.equal(downloadCalls, 1);
  updater.emit('update-downloaded');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(installed, true);
  assert.ok(logs.some((entry) => entry.msg.includes('等待用户选择')));
});
