'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setupAutoUpdater, cleanupInstalledUpdateCache, listRollbackReleases } = require('../src/main/updater.js');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mkdtemp, readFile, rm } = fs;

function createUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: { version: '0.1.1' } });
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => {};
  updater.setFeedURL = () => {};
  return updater;
}

test('历史版本只返回较早稳定版且必须包含安装器和更新元数据', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [{ name: 'gpt-plus-0.2.0-setup.exe' }, { name: 'latest.yml' }] },
      { tag_name: 'v0.1.9', draft: false, prerelease: true, assets: [{ name: 'gpt-plus-0.1.9-setup.exe' }, { name: 'latest.yml' }] },
      { tag_name: 'v0.1.8', draft: false, prerelease: false, assets: [{ name: 'latest.yml' }] },
      { tag_name: 'v0.1.7', draft: false, prerelease: false, assets: [{ name: 'gpt-plus-0.1.7-setup.exe' }, { name: 'latest.yml' }] },
      { tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [{ name: 'gpt-plus-0.3.0-setup.exe' }, { name: 'latest.yml' }] },
    ],
  });
  assert.deepEqual(await listRollbackReleases({ currentVersion: '0.2.1', fetchImpl }), [
    { version: '0.2.0', name: 'v0.2.0', publishedAt: null },
    { version: '0.1.7', name: 'v0.1.7', publishedAt: null },
  ]);
});

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

test('NSIS 更新保留差分下载能力，并关闭自动安装', () => {
  const updater = createUpdater();
  setupAutoUpdater({ app: { isPackaged: true, getVersion: () => '0.1.3' }, autoUpdater: updater });
  assert.equal(updater.disableDifferentialDownload, false);
});

test('回退到指定历史版本会切换 Release、允许降级并自动安装', async () => {
  const updater = createUpdater();
  const feeds = [];
  let downloadCalls = 0;
  let installed = false;
  updater.setFeedURL = (feed) => feeds.push(feed);
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.1.2' });
    return { isUpdateAvailable: true, updateInfo: { version: '0.1.2' } };
  };
  updater.downloadUpdate = async () => {
    downloadCalls += 1;
    updater.emit('update-downloaded');
  };
  updater.quitAndInstall = () => { installed = true; };
  const controller = setupAutoUpdater({
    app: { isPackaged: true, getVersion: () => '0.2.1' },
    autoUpdater: updater,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ tag_name: 'v0.1.2', draft: false, prerelease: false, assets: [
        { name: 'gpt-plus-0.1.2-setup.exe' }, { name: 'latest.yml' },
      ] }],
    }),
  });

  const state = await controller.rollbackToVersion('0.1.2');
  assert.equal(state.status, 'downloaded');
  assert.equal(state.rollbackTarget, '0.1.2');
  assert.equal(downloadCalls, 1);
  assert.deepEqual(feeds[0], { provider: 'generic', url: 'https://github.com/ailuo04/gptplus/releases/download/v0.1.2/' });
  assert.equal(updater.allowDowngrade, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(installed, true);
});

test('新版本首次启动后清理已安装版本对应的更新缓存', async (t) => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'gptplus-update-cache-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const cacheDir = path.join(localAppData, 'gptplus-updater');
  const pendingDir = path.join(cacheDir, 'pending');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(path.join(pendingDir, 'gpt-plus-0.1.3-setup.exe'), 'installer');
  await fs.writeFile(path.join(pendingDir, 'update-info.json'), JSON.stringify({ fileName: 'gpt-plus-0.1.3-setup.exe' }));
  await fs.writeFile(path.join(cacheDir, 'installer.exe'), 'old installer');
  await fs.writeFile(path.join(cacheDir, 'current.blockmap'), 'old blockmap');
  await fs.writeFile(path.join(pendingDir, 'current.blockmap'), 'new blockmap');

  const cleaned = await cleanupInstalledUpdateCache({
    app: { isPackaged: true, getVersion: () => '0.1.3' },
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
  });

  assert.equal(cleaned, true);
  assert.equal(await readFile(path.join(cacheDir, 'installer.exe'), 'utf8'), 'installer');
  assert.equal(await readFile(path.join(cacheDir, 'current.blockmap'), 'utf8'), 'new blockmap');
  await assert.rejects(readFile(pendingDir));
});

test('未成功安装的新版本不会清除待安装缓存', async (t) => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'gptplus-update-cache-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const pendingDir = path.join(localAppData, 'gptplus-updater', 'pending');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(path.join(pendingDir, 'gpt-plus-0.1.4-setup.exe'), 'installer');
  await fs.writeFile(path.join(pendingDir, 'update-info.json'), JSON.stringify({ fileName: 'gpt-plus-0.1.4-setup.exe' }));

  const cleaned = await cleanupInstalledUpdateCache({
    app: { isPackaged: true, getVersion: () => '0.1.3' },
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
  });

  assert.equal(cleaned, false);
  await fs.access(path.join(pendingDir, 'gpt-plus-0.1.4-setup.exe'));
});

test('较旧版本的更新缓存会在当前版本启动时清理', async (t) => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'gptplus-update-cache-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const cacheDir = path.join(localAppData, 'gptplus-updater');
  const pendingDir = path.join(cacheDir, 'pending');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(path.join(pendingDir, 'gpt-plus-0.1.2-setup.exe'), 'stale installer');
  await fs.writeFile(path.join(pendingDir, 'update-info.json'), JSON.stringify({ fileName: 'gpt-plus-0.1.2-setup.exe' }));
  await fs.writeFile(path.join(localAppData, 'gptplus-updater', 'installer.exe'), 'current baseline');

  const cleaned = await cleanupInstalledUpdateCache({
    app: { isPackaged: true, getVersion: () => '0.1.3' },
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
  });

  assert.equal(cleaned, true);
  assert.equal(await readFile(path.join(cacheDir, 'installer.exe'), 'utf8'), 'current baseline');
  await assert.rejects(readFile(path.join(cacheDir, 'pending')));
});
