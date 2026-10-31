'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexConfig } = require('../src/core/codex-config.js');
const { createChatGptPluginRecovery, BEGIN, END } = require('../src/core/chatgpt-plugin-recovery.js');
const { createStore } = require('../src/core/store.js');
const { createPluginManager } = require('../src/core/plugin-manager.js');
const { registerIpc } = require('../src/core/ipc.js');

function fixture(t, original = '') {
  const root = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, 'gptplus-plugin-recovery-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('gptplus-plugin-recovery-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const codexHome = path.join(dir, 'codex');
  const configPath = path.join(codexHome, 'config.toml');
  const manifest = path.join(codexHome, '.tmp', 'plugins', '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  const names = ['linear', 'gmail'];
  fs.writeFileSync(manifest, JSON.stringify({ name: 'openai-curated', plugins: names.map((name) => ({
    name, source: { source: 'local', path: `./plugins/${name}` },
  })) }));
  for (const name of names) {
    const pluginDir = path.join(codexHome, '.tmp', 'plugins', 'plugins', name);
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
    fs.mkdirSync(path.join(pluginDir, 'skills', 'example'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'skills', 'example', 'SKILL.md'), `# ${name} skill\n`);
  }
  fs.writeFileSync(configPath, original, 'utf8');
  const appDir = path.join(dir, 'gptplus');
  const codex = createCodexConfig({ paths: { CODEX_CONFIG_PATH: configPath, BACKUP_DIR: path.join(dir, 'backups') } });
  const recovery = createChatGptPluginRecovery({ codexHome, configPath, appDir, backup: codex.backup });
  return { dir, codexHome, configPath, appDir, manifest, codex, recovery };
}

test('插件目录修复：注册、幂等、备份和停用后逐字节恢复原配置', async (t) => {
  const original = '# 用户注释\r\nmodel = "example"\r\n\r\n[plugins."example@custom"]\r\nenabled = true\r\n';
  const f = fixture(t, original);
  assert.deepEqual(f.recovery.status(), { configured: false, needsMigration: false, catalogAvailable: true, catalogCount: 2, error: '' });
  const enabled = await f.recovery.setEnabled(true);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.configured, true);
  assert.equal(fs.readFileSync(enabled.backupPath, 'utf8'), original);
  const active = fs.readFileSync(f.configPath, 'utf8');
  assert.ok(active.startsWith(original));
  assert.match(active, /\[marketplaces\.gptplus-curated\]/);
  assert.match(active, /source_type = "local"/);
  assert.equal((await f.recovery.setEnabled(true)).changed, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), active);
  assert.equal((await f.recovery.setEnabled(false)).changed, true);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.equal((await f.recovery.setEnabled(false)).changed, false);
});

test('插件目录修复：保留无终止换行和启用期间新增的用户配置', async (t) => {
  const original = 'model = "example"';
  const f = fixture(t, original);
  await f.recovery.setEnabled(true);
  await f.recovery.setEnabled(false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  await f.recovery.setEnabled(true);
  fs.appendFileSync(f.configPath, '\n[other]\nvalue = 1\n');
  await f.recovery.setEnabled(false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original + '\n\n[other]\nvalue = 1\n');
});

test('插件目录修复：缓存缺失或无效时不修改配置', async (t) => {
  const original = 'model = "keep"\n';
  const f = fixture(t, original);
  fs.unlinkSync(f.manifest);
  await assert.rejects(f.recovery.setEnabled(true), /未找到完整的 ChatGPT 本机插件缓存/);
  assert.equal(f.recovery.status().catalogAvailable, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  fs.writeFileSync(f.manifest, JSON.stringify({ name: 'other', plugins: [{ name: 'fake' }] }));
  await assert.rejects(f.recovery.setEnabled(true), /格式不受支持/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});

test('插件目录修复：拒绝覆盖同名、内联或已修改的配置', async (t) => {
  for (const original of [
    '[marketplaces."gptplus-curated"]\nsource_type = "local"\n',
    '[[marketplaces.gptplus-curated]]\nsource = "keep"\n',
    '[marketplaces]\ngptplus-curated = { source_type = "local" }\n',
    'marketplaces = {}\n',
    'marketplaces.gptplus-curated = {}\n',
    'marketplaces.gptplus-curated.source = "other"\n',
  ]) {
    const f = fixture(t, original);
    await assert.rejects(f.recovery.setEnabled(true), /已有/);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  }
  const f = fixture(t, 'model = "keep"\n');
  await f.recovery.setEnabled(true);
  const edited = fs.readFileSync(f.configPath, 'utf8').replace(END, 'user_key = "keep"\n' + END);
  fs.writeFileSync(f.configPath, edited, 'utf8');
  await assert.rejects(f.recovery.setEnabled(false), /配置块已被修改/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), edited);
  assert.match(f.recovery.status().error, /配置块已被修改/);
});

test('插件目录修复：备份或并发修改失败时不会覆盖用户配置', async (t) => {
  const f = fixture(t, 'model = "keep"\n');
  const failedBackup = createChatGptPluginRecovery({ codexHome: f.codexHome, configPath: f.configPath, appDir: f.appDir, backup() { throw new Error('backup failed'); } });
  await assert.rejects(failedBackup.setEnabled(true), /backup failed/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "keep"\n');
  const concurrentlyChanged = createChatGptPluginRecovery({ codexHome: f.codexHome, configPath: f.configPath, appDir: f.appDir, backup() {
    fs.appendFileSync(f.configPath, '# concurrent edit\n');
    return '';
  } });
  await assert.rejects(concurrentlyChanged.setEnabled(true), /发生变化/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "keep"\n# concurrent edit\n');
});

test('插件目录修复 IPC：显式启用才修改配置，停用与卸载仅移除托管块', async (t) => {
  const f = fixture(t, 'model = "keep"\n');
  const store = createStore({ configPath: path.join(f.dir, 'gptplus.json') });
  const plugins = createPluginManager({ store });
  const handlers = new Map();
  const ctx = { store, plugins, chatgptPluginRecovery: f.recovery, log() {}, status() { return {}; }, onLogEvent() {} };
  registerIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, ctx, shell: {}, dialog: {}, clipboard: {} });
  const call = (name, ...args) => handlers.get(name)(null, ...args);
  const id = 'chatgpt-plugin-catalog';
  assert.equal(plugins.get(id).installed, false);
  await assert.rejects(call('gptplus:plugin:enabled:set', { id, enabled: true }), /请先安装/);
  await call('gptplus:plugin:install', id);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "keep"\n');
  const enabled = await call('gptplus:plugin:enabled:set', { id, enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.catalogStatus.configured, true);
  const reinstalled = await call('gptplus:plugin:install', id);
  assert.equal(reinstalled.enabled, true, '重复安装不应关闭已启用的目录修复');
  assert.match(fs.readFileSync(f.configPath, 'utf8'), new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await call('gptplus:plugin:enabled:set', { id, enabled: false });
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "keep"\n');
  await call('gptplus:plugin:enabled:set', { id, enabled: true });
  await call('gptplus:plugin:uninstall', id);
  assert.equal(plugins.get(id).installed, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "keep"\n');
});

test('插件目录修复 IPC：配置修复失败不改变启用状态', async (t) => {
  const f = fixture(t, 'model = "keep"\n');
  fs.unlinkSync(f.manifest);
  const store = createStore({ configPath: path.join(f.dir, 'gptplus.json') });
  const plugins = createPluginManager({ store });
  plugins.install('chatgpt-plugin-catalog');
  const handlers = new Map();
  registerIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    ctx: { store, plugins, chatgptPluginRecovery: f.recovery, log() {}, status() { return {}; }, onLogEvent() {} }, shell: {}, dialog: {} });
  await assert.rejects(handlers.get('gptplus:plugin:enabled:set')(null, { id: 'chatgpt-plugin-catalog', enabled: true }), /未找到/);
  assert.equal(plugins.get('chatgpt-plugin-catalog').enabled, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "keep"\n');
});

test('插件目录修复 IPC：状态保存失败时撤销本次配置改动', async (t) => {
  const original = 'model = "keep"\n';
  const f = fixture(t, original);
  const store = createStore({ configPath: path.join(f.dir, 'gptplus.json') });
  const plugins = createPluginManager({ store });
  plugins.install('chatgpt-plugin-catalog');
  plugins.setEnabled = () => { throw new Error('state save failed'); };
  const handlers = new Map();
  registerIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    ctx: { store, plugins, chatgptPluginRecovery: f.recovery, log() {}, status() { return {}; }, onLogEvent() {} }, shell: {}, dialog: {} });
  await assert.rejects(handlers.get('gptplus:plugin:enabled:set')(null, { id: 'chatgpt-plugin-catalog', enabled: true }), /state save failed/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.equal(plugins.get('chatgpt-plugin-catalog').enabled, false);
});

test('插件目录修复与模型注入互不覆盖，可以按不同顺序关闭', async (t) => {
  const original = '# user settings\nmodel = "original"\n';
  const f = fixture(t, original);
  await f.recovery.setEnabled(true);
  f.codex.applyInjection({ enabled: true, defaultModel: 'test-model', catalogPath: path.join(f.dir, 'catalog.json') });
  assert.equal(f.recovery.status().configured, true);
  await f.recovery.setEnabled(false);
  assert.equal(f.codex.isInjected(), true);
  f.codex.applyInjection({ enabled: false });
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);

  f.codex.applyInjection({ enabled: true, defaultModel: 'test-model', catalogPath: path.join(f.dir, 'catalog.json') });
  await f.recovery.setEnabled(true);
  f.codex.applyInjection({ enabled: false });
  assert.equal(f.recovery.status().configured, true);
  await f.recovery.setEnabled(false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});

function legacyConfig(f, original) {
  const { _internal } = require('../src/core/codex-config.js');
  return original + [BEGIN, '[marketplaces.gptplus-curated]', 'source_type = "local"',
    `source = ${_internal.tomlString(f.recovery.sourcePath)}`, END, ''].join('\n');
}

function registeredSource(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^source = (".*")$/m);
  assert.ok(match, '配置中应包含本地市场来源');
  return JSON.parse(match[1]);
}

test('插件目录修复：迁移旧版注册为独立市场，保留缓存和可回滚配置', async (t) => {
  const original = 'model = "original"\n';
  const f = fixture(t, original);
  const old = legacyConfig(f, original);
  fs.writeFileSync(f.configPath, old, 'utf8');
  assert.equal(f.recovery.status().needsMigration, true);
  assert.equal(f.recovery.status().configured, false);
  const result = await f.recovery.setEnabled(true);
  assert.equal(result.changed, true);
  assert.equal(result.configured, true);
  assert.equal(result.needsMigration, false);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), old);
  const registered = registeredSource(f.configPath);
  assert.notEqual(registered, f.recovery.sourcePath);
  const manifest = JSON.parse(fs.readFileSync(path.join(registered, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, 'gptplus-curated');
  assert.equal(manifest.plugins.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.manifest, 'utf8')).name, 'openai-curated', '不可修改 ChatGPT 的缓存');
  assert.ok(fs.existsSync(path.join(registered, 'plugins', 'linear', 'skills', 'example', 'SKILL.md')));
  await f.recovery.setEnabled(false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});

test('插件目录修复：原缓存丢失后仍可使用已注册的完整本地副本', async (t) => {
  const f = fixture(t, 'model = "original"\n');
  await f.recovery.setEnabled(true);
  const source = registeredSource(f.configPath);
  fs.unlinkSync(f.manifest);
  const status = f.recovery.status();
  assert.equal(status.configured, true);
  assert.equal(status.catalogAvailable, true);
  assert.equal(status.catalogCount, 2);
  assert.equal(status.error, '');
  assert.equal((await f.recovery.setEnabled(true)).changed, false);
  assert.ok(fs.existsSync(path.join(source, 'plugins', 'linear', 'skills', 'example', 'SKILL.md')));
});

test('插件目录修复：缓存更新后创建新快照，保留旧副本及原文件', async (t) => {
  const f = fixture(t, 'model = "original"\n');
  await f.recovery.setEnabled(true);
  const first = registeredSource(f.configPath);
  const originalSkill = path.join(f.recovery.sourcePath, 'plugins', 'linear', 'skills', 'example', 'SKILL.md');
  fs.writeFileSync(originalSkill, '# updated skill\n');
  assert.equal((await f.recovery.setEnabled(true)).changed, true);
  const second = registeredSource(f.configPath);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(first, 'plugins', 'linear', 'skills', 'example', 'SKILL.md'), 'utf8'), '# linear skill\n');
  assert.equal(fs.readFileSync(path.join(second, 'plugins', 'linear', 'skills', 'example', 'SKILL.md'), 'utf8'), '# updated skill\n');
});

test('插件目录修复：拒绝越界来源，不复制或修改配置', async (t) => {
  const original = 'model = "keep"\n';
  const f = fixture(t, original);
  fs.writeFileSync(f.manifest, JSON.stringify({ name: 'openai-curated', plugins: [{
    name: 'linear', source: { source: 'local', path: '../../outside' },
  }] }));
  await assert.rejects(f.recovery.setEnabled(true), /格式不受支持/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.equal(fs.existsSync(f.recovery.snapshotRoot), false);
});

test('插件目录修复 IPC：旧配置迁移后若状态保存失败，恢复原有旧配置', async (t) => {
  const f = fixture(t, 'model = "keep"\n');
  const original = legacyConfig(f, 'model = "keep"\n');
  fs.writeFileSync(f.configPath, original, 'utf8');
  const store = createStore({ configPath: path.join(f.dir, 'gptplus.json') });
  const plugins = createPluginManager({ store });
  plugins.install('chatgpt-plugin-catalog');
  plugins.setEnabled = () => { throw new Error('state save failed'); };
  const handlers = new Map();
  registerIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    ctx: { store, plugins, chatgptPluginRecovery: f.recovery, log() {}, status() { return {}; }, onLogEvent() {} }, shell: {}, dialog: {} });
  await assert.rejects(handlers.get('gptplus:plugin:enabled:set')(null, { id: 'chatgpt-plugin-catalog', enabled: true }), /state save failed/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
  assert.equal(f.recovery.status().needsMigration, true);
});
