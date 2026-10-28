'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  setupAutoUpdater,
  cleanupInstalledUpdateCache,
  listRollbackReleases,
  extractUpdateHighlights,
} = require('../src/main/updater.js');
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

function createTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timeouts.set(id, { fn, delay });
      return { id, unref() {} };
    },
    clearTimeout(timer) { timeouts.delete(timer?.id); },
    setInterval(fn, delay) {
      const id = nextId++;
      intervals.set(id, { fn, delay });
      return { id, unref() {} };
    },
    clearInterval(timer) { intervals.delete(timer?.id); },
    async fireTimeout() {
      const first = timeouts.entries().next().value;
      if (!first) return null;
      timeouts.delete(first[0]);
      return first[1].fn();
    },
    async fireInterval() {
      const first = intervals.entries().next().value;
      if (!first) return null;
      return first[1].fn();
    },
    timeoutDelays: () => [...timeouts.values()].map((item) => item.delay),
    intervalDelays: () => [...intervals.values()].map((item) => item.delay),
  };
}

function releaseFetch(body) {
  return async () => ({ ok: true, json: async () => ({ body }) });
}

test('更新摘要只保留精简要点并排除兼容性与验证章节', () => {
  const markdown = [
    '# gpt++ v1.6.5',
    '',
    '## 软件内更新摘要',
    '- **新模型默认启用**，并开启推理。',
    '- 修复 [用量状态栏](https://example.com) 三项显示为空。',
    '3. 更新弹窗展示精简摘要。',
    '- 保留“完整更新说明”入口。',
    '- 第五项不应进入软件内摘要。',
    '',
    '## 兼容性',
    '- 不需要迁移配置。',
    '',
    '## 验证',
    '- 全量测试通过。',
  ].join('\n');
  assert.deepEqual(extractUpdateHighlights(markdown), [
    '新模型默认启用，并开启推理。',
    '修复 用量状态栏 三项显示为空。',
    '更新弹窗展示精简摘要。',
    '保留“完整更新说明”入口。',
  ]);

  const fallback = '## 更新内容\n- 修复 A\n- 改进 B\n## 兼容性\n- 不需要迁移\n';
  assert.deepEqual(extractUpdateHighlights(fallback), ['修复 A', '改进 B']);
});

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
  assert.equal(controller.setCheckIntervalMinutes(45).checkIntervalMinutes, 45);
  assert.equal(controller.getState().checkIntervalMinutes, 45);
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
    fetchImpl: releaseFetch('## 软件内更新摘要\n- 修复用量状态栏。\n- 精简更新说明。\n'),
    onLog: (entry) => logs.push(entry),
  });

  assert.equal(controller.enabled, true);
  await controller.checkForUpdates();
  updater.emit('update-available', { version: '0.1.1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloadCalls, 0);
  assert.equal(controller.getState().status, 'available');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().notesStatus, 'ready');
  assert.deepEqual(controller.getState().highlights, ['修复用量状态栏。', '精简更新说明。']);
  assert.equal(controller.getState().releaseNotesUrl, 'https://github.com/ailuo04/gptplus/releases/tag/v0.1.1');

  await controller.downloadUpdate();
  assert.equal(downloadCalls, 1);
  updater.emit('update-downloaded');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(installed, true);
  assert.ok(logs.some((entry) => entry.msg.includes('等待用户选择')));
});

test('更新摘要读取失败不会阻塞版本提示和下载', async () => {
  const updater = createUpdater();
  let downloadCalls = 0;
  updater.downloadUpdate = async () => { downloadCalls += 1; };
  const controller = setupAutoUpdater({
    app: { isPackaged: true, getVersion: () => '0.1.0' },
    autoUpdater: updater,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  updater.emit('update-available', { version: '0.1.1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().status, 'available');
  assert.equal(controller.getState().notesStatus, 'error');
  assert.equal(controller.getState().error, null, '摘要失败不能把更新本身标记为失败');

  await controller.downloadUpdate();
  assert.equal(downloadCalls, 1, '摘要不可用时仍允许用户下载更新');
});

test('自动更新启动后延迟 20 秒首次检查，之后按设定间隔检查', async () => {
  const updater = createUpdater();
  const timers = createTimers();
  let checkCalls = 0;
  updater.checkForUpdates = async () => {
    checkCalls += 1;
    updater.emit('update-not-available');
    return { isUpdateAvailable: false };
  };
  const controller = setupAutoUpdater({
    app: { isPackaged: true, getVersion: () => '0.1.0' },
    autoUpdater: updater,
    checkIntervalMinutes: 30,
    timers,
  });

  assert.equal(checkCalls, 0);
  assert.deepEqual(timers.timeoutDelays(), [20_000]);
  assert.equal(controller.getState().initialCheckDelaySeconds, 20);
  assert.equal(controller.getState().checkIntervalMinutes, 30);

  await timers.fireTimeout();
  assert.equal(checkCalls, 1);
  assert.deepEqual(timers.intervalDelays(), [30 * 60 * 1000]);

  await timers.fireInterval();
  assert.equal(checkCalls, 2);
  controller.stopAutomaticChecks();
  assert.deepEqual(timers.intervalDelays(), []);
});

test('修改自动检查间隔会立即重排后续定时器', () => {
  const timers = createTimers();
  const controller = setupAutoUpdater({
    app: { isPackaged: true, getVersion: () => '0.1.0' },
    autoUpdater: createUpdater(),
    timers,
  });
  assert.equal(controller.setCheckIntervalMinutes(45).checkIntervalMinutes, 45);
  assert.deepEqual(timers.timeoutDelays(), [20_000]);
  controller.stopAutomaticChecks();
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
    fetchImpl: async (url) => String(url).includes('/tags/v0.1.2')
      ? { ok: true, json: async () => ({ body: '## 软件内更新摘要\n- 历史版本摘要。\n' }) }
      : {
          ok: true,
          json: async () => [{ tag_name: 'v0.1.2', draft: false, prerelease: false, assets: [
            { name: 'gpt-plus-0.1.2-setup.exe' }, { name: 'latest.yml' },
          ] }],
        },
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

test('主进程不再立即检查更新，自动检查由更新控制器调度', async () => {
  const { readFile } = require('node:fs/promises');
  const mainSource = await readFile(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(mainSource, /checkIntervalMinutes: ctx\.store\.get\(\)\.updates\.checkIntervalMinutes/);
  assert.doesNotMatch(mainSource, /if \(updater\.enabled\) \{[\s\S]{0,300}updater\.checkForUpdates\(\)/, '主进程不应再直接触发启动检查');
});
