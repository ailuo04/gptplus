'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createStore } = require('../src/core/store.js');
const { createPluginManager, normalizeImageConfig } = require('../src/core/plugin-manager.js');

function fixture(t, secure = true) {
  const root = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, 'gptplus-imagegen-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(dir)).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(dir).startsWith('gptplus-imagegen-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const key = crypto.randomBytes(32);
  const secretStorage = {
    isAvailable: () => true,
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  const configPath = path.join(dir, 'app', 'config.json');
  const store = createStore({ configPath, secretStorage: secure ? secretStorage : null });
  const plugins = createPluginManager({ store });
  return { dir, configPath, store, plugins, secretStorage };
}

function configure(f, patch = {}) {
  f.plugins.install('custom-imagegen');
  f.plugins.setConfig('custom-imagegen', {
    baseUrl: 'https://images.example/v1', apiKey: 'sk-private-image-key', model: 'my-image-model', preferDefault: true, ...patch,
  });
}

test('custom image plugin is opt-in, normalizes settings, masks secrets and preserves blank key updates', (t) => {
  const f = fixture(t);
  const initial = f.plugins.list().find((p) => p.id === 'custom-imagegen');
  assert.ok(initial, 'custom-imagegen should be in the marketplace');
  assert.equal(initial.installed, false);
  assert.equal(initial.enabled, false);
  assert.deepEqual(normalizeImageConfig({ model: ' custom ', preferDefault: false }), {
    baseUrl: '', apiKey: '', model: 'custom', preferDefault: false,
    resolution: '1K', aspectRatio: '1:1', quality: 'auto', background: 'auto',
  });
  configure(f);
  const events = [];
  f.plugins.onChange((event) => events.push(event));
  f.plugins.setConfig('custom-imagegen', { baseUrl: 'https://new.example/v1', apiKey: '', model: 'new-model', preferDefault: false });
  f.plugins.setConfig('custom-imagegen', { baseUrl: 'https://new.example/v1', apiKey: '   ', model: 'new-model', preferDefault: false });
  assert.equal(f.plugins.config('custom-imagegen').apiKey, 'sk-private-image-key');
  const publicPlugin = f.plugins.get('custom-imagegen');
  assert.equal(publicPlugin.config.hasKey, true);
  assert.equal(publicPlugin.config.apiKey, undefined);
  assert.ok(!JSON.stringify(events).includes('sk-private-image-key'));
});

test('image credentials are encrypted on disk and reload; unavailable secure storage fails closed', (t) => {
  const f = fixture(t);
  configure(f);
  const disk = fs.readFileSync(f.configPath, 'utf8');
  assert.ok(!disk.includes('sk-private-image-key'), 'key must not appear in config.json');
  assert.ok(!disk.includes('https://images.example/v1'));
  const reload = createPluginManager({ store: createStore({ configPath: f.configPath, secretStorage: f.secretStorage }) });
  assert.equal(reload.config('custom-imagegen').apiKey, 'sk-private-image-key');
  assert.equal(reload.config('custom-imagegen').baseUrl, 'https://images.example/v1');
  assert.deepEqual(Object.fromEntries(['resolution', 'aspectRatio', 'quality', 'background'].map((name) => [name, reload.config('custom-imagegen')[name]])), { resolution: '1K', aspectRatio: '1:1', quality: 'auto', background: 'auto' });
  assert.throws(() => createStore({ configPath: f.configPath }), /安全存储/);
  const insecure = fixture(t, false);
  insecure.plugins.install('custom-imagegen');
  const before = fs.readFileSync(insecure.configPath, 'utf8');
  assert.throws(() => insecure.plugins.setConfig('custom-imagegen', { apiKey: 'never-write-plaintext', baseUrl: 'https://x.example/v1' }), /安全存储/);
  assert.equal(fs.readFileSync(insecure.configPath, 'utf8'), before);
  assert.equal(insecure.plugins.config('custom-imagegen').apiKey, '');
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII=';
async function listen(t, listener) {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function imageService(f, options = {}) {
  const mod = require('../src/core/image-generation.js');
  return mod.createImageGeneration({ plugins: f.plugins, fetchImpl: fetch, ...options });
}

test('image execution fixes URL, model and key; supports base64 and never accepts caller routing overrides', async (t) => {
  const f = fixture(t);
  const calls = [];
  const base = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, key: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
  });
  configure(f, { baseUrl: base + '/v1/images/generations' });
  f.plugins.setEnabled('custom-imagegen', true);
  const service = imageService(f);
  const result = await service.generate({ prompt: '画一朵云', size: '1024x1024' });
  assert.equal(result.data[0].b64_json, PNG);
  assert.equal(result.data[0].format, 'png');
  assert.deepEqual(calls[0], { url: '/v1/images/generations', key: 'Bearer sk-private-image-key', body: {
    model: 'my-image-model', prompt: '画一朵云', n: 1, size: '1024x1024', quality: 'auto', background: 'auto',
  } });
  await assert.rejects(service.generate({ prompt: 'x', model: 'other', baseUrl: 'https://other.example' }), /不允许|参数/);
  await assert.rejects(service.generate({ prompt: '' }), /提示词/);
  await assert.rejects(service.generate({ prompt: 'x', n: 0 }), /数量/);
  f.plugins.setEnabled('custom-imagegen', false);
  await assert.rejects(service.generate({ prompt: 'x' }), /未启用/);
  assert.equal(calls.length, 1);
});

test('upstream URL results download without API credentials; errors, redirects and invalid output do not fallback', async (t) => {
  const f = fixture(t);
  let mode = 'url', generations = 0, downloadAuth;
  const base = await listen(t, (req, res) => {
    if (req.url === '/image.png') { downloadAuth = req.headers.authorization; res.end(Buffer.from(PNG, 'base64')); return; }
    generations++;
    if (mode === 'error') { res.writeHead(401); res.end('sk-private-image-key sensitive upstream body'); return; }
    if (mode === 'redirect') { res.writeHead(307, { location: '/wrong-provider' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [mode === 'invalid' ? { b64_json: 'bm90IGFuIGltYWdl' } : { url: base + '/image.png' }] }));
  });
  configure(f, { baseUrl: base + '/v1' }); f.plugins.setEnabled('custom-imagegen', true);
  const service = imageService(f);
  assert.equal((await service.generate({ prompt: 'cloud' })).data[0].b64_json, PNG);
  assert.equal(downloadAuth, undefined);
  for (mode of ['error', 'redirect', 'invalid']) {
    await assert.rejects(service.generate({ prompt: 'cloud' }), (err) => !err.message.includes('sk-private-image-key'));
  }
  assert.equal(generations, 4, 'each request uses only its configured endpoint once');
});

test('image execution rejects missing credentials, non-HTTP URLs, oversized responses and timeouts', async (t) => {
  const f = fixture(t);
  configure(f, { baseUrl: 'file:///private', model: '' }); f.plugins.setEnabled('custom-imagegen', true);
  await assert.rejects(imageService(f).generate({ prompt: 'x' }), /URL|模型/);
  const base = await listen(t, (req, res) => {
    if (req.url.startsWith('/slow')) return;
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999999' }); res.end();
  });
  f.plugins.setConfig('custom-imagegen', { baseUrl: base, model: 'x', apiKey: '' });
  await assert.rejects(imageService(f).generate({ prompt: 'x' }), /大小|过大/);
  f.plugins.setConfig('custom-imagegen', { baseUrl: base + '/slow', model: 'x', apiKey: '' });
  await assert.rejects(imageService(f, { timeoutMs: 50 }).generate({ prompt: 'x' }), /超时|失败/);
});

test('local image gateway requires a bearer token, rejects browser origins, and never accepts peer authorization', async (t) => {
  const { createGateway } = require('../src/core/gateway/server.js');
  const f = fixture(t); let calls = 0;
  const base = await listen(t, (req, res) => { calls++; res.end(JSON.stringify({ data: [{ b64_json: PNG }] })); });
  configure(f, { baseUrl: base + '/v1' }); f.plugins.setEnabled('custom-imagegen', true);
  const service = imageService(f);
  const gateway = createGateway({ store: f.store, imageGeneration: service });
  t.after(() => gateway.stop());
  await gateway.start({ port: 0, host: '127.0.0.1' });
  const endpoint = new URL('/gptplus/images/generations', gateway.getState().url).href;
  const key = f.store.get().gateway.token;
  const request = (headers = {}, body = { prompt: 'cloud' }) => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request({ Authorization: `Bearer ${key}`, Origin: 'https://untrusted.example' })).status, 403);
  const response = await request({ Authorization: `Bearer ${key}` });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].b64_json, PNG);
  assert.equal((await request({ Authorization: `Bearer ${key}` }, { prompt: 'cloud', apiKey: 'override' })).status, 400);
  assert.equal(calls, 1);
});

function skillFixture(t, original = '# user config\r\nmodel = "keep"\r\n') {
  const f = fixture(t);
  const codexHome = path.join(f.dir, 'codex');
  const configPath = path.join(codexHome, 'config.toml');
  const builtin = path.join(codexHome, 'skills', '.system', 'imagegen', 'SKILL.md');
  fs.mkdirSync(path.dirname(builtin), { recursive: true });
  fs.writeFileSync(builtin, 'builtin image skill');
  fs.writeFileSync(configPath, original);
  const backups = [];
  const { createImagegenSkill } = require('../src/core/imagegen-skill.js');
  const runtime = createImagegenSkill({ codexHome, configPath, appConfigPath: f.configPath,
    backup: () => { const file = path.join(f.dir, `backup-${backups.length}.toml`); fs.copyFileSync(configPath, file); backups.push(file); return file; },
  });
  return { ...f, codexHome, codexConfigPath: configPath, builtin, runtime, backups };
}

test('managed image skill installs secret-free assets, changes only own settings, and disables cleanly', (t) => {
  const original = '# user config\r\nmodel = "keep"\r\n[other]\r\nvalue = 1\r\n';
  const f = skillFixture(t, original);
  const enabled = f.runtime.sync({ enabled: true, preferDefault: true });
  assert.equal(enabled.changed, true);
  assert.equal(fs.readFileSync(f.backups[0], 'utf8'), original);
  const active = fs.readFileSync(f.codexConfigPath, 'utf8');
  assert.ok(active.startsWith(original));
  assert.match(active, /\[\[skills\.config\]\]/);
  assert.match(active, /imagegen[\\/]+SKILL\.md"\r?\nenabled = false/);
  assert.equal(f.runtime.status().builtinSkillDisabled, true);
  assert.equal(f.runtime.status().automaticSelectionGuaranteed, false);
  const skill = path.join(f.codexHome, 'skills', 'gptplus-imagegen');
  const text = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
  assert.match(text, /generate\.py/);
  assert.match(text, /load_workspace_dependencies/);
  assert.doesNotMatch(text, /sk-private-image-key|Bearer /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(skill, 'bridge.json'), 'utf8')).configPath, f.configPath);
  assert.equal(f.runtime.sync({ enabled: true, preferDefault: true }).changed, false);
  f.runtime.sync({ enabled: false, preferDefault: true });
  const disabled = fs.readFileSync(f.codexConfigPath, 'utf8');
  assert.ok(disabled.startsWith(original));
  assert.equal(f.runtime.status().enabled, false);
  assert.equal(f.runtime.status().builtinSkillDisabled, false);
  assert.equal(fs.readFileSync(f.builtin, 'utf8'), 'builtin image skill');
  assert.equal(f.runtime.sync({ enabled: false }).changed, false);
});

test('skill preference updates are reversible; external edits and inline skill arrays are not overwritten', (t) => {
  const f = skillFixture(t);
  const before = fs.readFileSync(f.codexConfigPath, 'utf8');
  const first = f.runtime.sync({ enabled: true, preferDefault: true });
  first.rollback();
  assert.equal(fs.readFileSync(f.codexConfigPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'skills', 'gptplus-imagegen', 'SKILL.md')), false);
  f.runtime.sync({ enabled: true, preferDefault: true });
  f.runtime.sync({ enabled: true, preferDefault: false });
  assert.equal(f.runtime.status().builtinSkillDisabled, false);
  const file = path.join(f.codexHome, 'skills', 'gptplus-imagegen', 'SKILL.md');
  fs.appendFileSync(file, '\nuser edit\n');
  assert.throws(() => f.runtime.sync({ enabled: true, preferDefault: true }), /技能.*修改|覆盖/);
  assert.match(fs.readFileSync(file, 'utf8'), /user edit/);
  // Turning it off remains possible without overwriting an edited skill.
  f.runtime.sync({ enabled: false });
  const g = skillFixture(t, '[skills]\nconfig = []\n');
  const original = fs.readFileSync(g.codexConfigPath, 'utf8');
  assert.throws(() => g.runtime.sync({ enabled: true, preferDefault: true }), /skills|内联/);
  assert.equal(fs.readFileSync(g.codexConfigPath, 'utf8'), original);
});

test('edited managed config is preserved and reported instead of being silently replaced', (t) => {
  const f = skillFixture(t);
  f.runtime.sync({ enabled: true, preferDefault: true });
  const text = fs.readFileSync(f.codexConfigPath, 'utf8').replace('enabled = true', 'enabled = false');
  fs.writeFileSync(f.codexConfigPath, text);
  assert.throws(() => f.runtime.sync({ enabled: false }), /修改|校验/);
  assert.equal(fs.readFileSync(f.codexConfigPath, 'utf8'), text);
  assert.ok(f.runtime.status().error);
});

function pythonExecutable() {
  const { spawnSync } = require('node:child_process');
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  return [process.env.GPTPLUS_TEST_PYTHON, bundled, 'python3', 'python'].filter(Boolean)
    .find((exe) => spawnSync(exe, ['--version'], { windowsHide: true }).status === 0);
}
async function runPython(exe, args) {
  const { spawn } = require('node:child_process');
  const child = spawn(exe, args, { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  return { code, stdout, stderr };
}

test('installed skill helper actually uses local authenticated route, saves output, and refuses overwrite before generating', async (t) => {
  const python = pythonExecutable();
  if (!python) { t.skip('Python 3 is not available on this runner'); return; }
  const f = skillFixture(t); let calls = 0, authorization, payload;
  const base = await listen(t, async (req, res) => {
    calls++; authorization = req.headers.authorization;
    let body = ''; for await (const chunk of req) body += chunk;
    payload = JSON.parse(body);
    assert.equal(req.url, '/gptplus/images/generations');
    res.end(JSON.stringify({ model: 'synthetic-model', data: [{ b64_json: PNG, format: 'png' }] }));
  });
  configure(f);
  f.plugins.setEnabled('custom-imagegen', true);
  f.store.update((draft) => { draft.gateway.port = Number(new URL(base).port); });
  f.runtime.sync({ enabled: true, preferDefault: true });
  const script = path.join(f.codexHome, 'skills', 'gptplus-imagegen', 'scripts', 'generate.py');
  const output = path.join(f.dir, 'output', 'cloud.png');
  const result = await runPython(python, [script, '--prompt', '画一朵云', '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(authorization, `Bearer ${f.store.get().gateway.token}`);
  assert.deepEqual(payload, { prompt: '画一朵云', n: 1 });
  assert.equal(fs.readFileSync(output).toString('base64'), PNG);
  assert.deepEqual(JSON.parse(result.stdout).paths, [output]);
  assert.ok(!result.stdout.includes('sk-private-image-key'));
  const again = await runPython(python, [script, '--prompt', 'another', '--output', output]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /已存在/);
  assert.equal(calls, 1);
  f.plugins.setEnabled('custom-imagegen', false);
  const disabled = await runPython(python, [script, '--prompt', 'another', '--output', path.join(f.dir, 'other.png')]);
  assert.notEqual(disabled.code, 0);
  assert.match(disabled.stderr, /未启用/);
  assert.equal(calls, 1);
});

function ipcFixture(t) {
  const f = skillFixture(t);
  const { registerIpc } = require('../src/core/ipc.js');
  const channels = new Map();
  const ctx = { store: f.store, plugins: f.plugins, imageGeneration: imageService(f), imagegenSkill: f.runtime, log() {}, onLogEvent: () => () => {},
    status: () => ({}), gateway: { getState: () => ({ running: false }) } };
  registerIpc({ ipcMain: { handle: (name, fn) => channels.set(name, fn) }, shell: {}, dialog: {}, ctx });
  return { ...f, ctx, call: (name, ...args) => channels.get('gptplus:plugin:' + name)(null, ...args) };
}

test('image IPC validates before enable and synchronizes enable, preference, uninstall and key-preserving config', async (t) => {
  const f = ipcFixture(t);
  await f.call('install', 'custom-imagegen');
  const before = fs.readFileSync(f.codexConfigPath, 'utf8');
  await assert.rejects(f.call('enabled:set', { id: 'custom-imagegen', enabled: true }), /URL|配置/);
  assert.equal(fs.readFileSync(f.codexConfigPath, 'utf8'), before);
  await f.call('config:set', { id: 'custom-imagegen', config: {
    baseUrl: 'https://images.example/v1', apiKey: 'sk-private-image-key', model: 'model', preferDefault: true,
  } });
  const enabled = await f.call('enabled:set', { id: 'custom-imagegen', enabled: true });
  assert.equal(enabled.imageStatus.enabled, true);
  assert.equal(enabled.imageStatus.builtinSkillDisabled, true);
  assert.equal(enabled.config.apiKey, undefined);
  await f.call('config:set', { id: 'custom-imagegen', config: {
    baseUrl: 'https://images.example/v1', apiKey: '', model: 'model', preferDefault: false,
  } });
  assert.equal(f.runtime.status().builtinSkillDisabled, false);
  assert.equal(f.plugins.config('custom-imagegen').apiKey, 'sk-private-image-key');
  await f.call('install', 'custom-imagegen');
  assert.equal(f.plugins.isActive('custom-imagegen'), true, 'repeat install must not bypass skill cleanup');
  await f.call('uninstall', 'custom-imagegen');
  assert.equal(f.runtime.status().enabled, false);
  assert.equal(f.plugins.get('custom-imagegen').installed, false);
  assert.equal(f.plugins.config('custom-imagegen').apiKey, 'sk-private-image-key');
});

test('image IPC rolls skill/config changes back when secure state persistence fails', async (t) => {
  const f = ipcFixture(t);
  configure(f);
  const original = fs.readFileSync(f.codexConfigPath, 'utf8');
  f.secretStorage.encrypt = () => { throw new Error('encryption failure'); };
  await assert.rejects(f.call('enabled:set', { id: 'custom-imagegen', enabled: true }), /加密|保存/);
  assert.equal(fs.readFileSync(f.codexConfigPath, 'utf8'), original);
  assert.equal(f.plugins.isActive('custom-imagegen'), false);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'skills', 'gptplus-imagegen', 'SKILL.md')), false);
});

test('skill status is read-only and reports missing installed assets', (t) => {
  const f = skillFixture(t);
  f.runtime.sync({ enabled: true, preferDefault: true });
  fs.rmSync(path.join(f.codexHome, 'skills', 'gptplus-imagegen', 'SKILL.md'));
  assert.match(f.runtime.status().error, /缺失|缺少|修改/);
  fs.renameSync(path.join(f.codexHome, 'skills', 'gptplus-imagegen'), path.join(f.dir, 'removed-skill'));
  assert.match(f.runtime.status().error, /缺失|缺少/);
  const untouched = path.join(f.dir, 'not-created');
  const runtime = require('../src/core/imagegen-skill.js').createImagegenSkill({
    codexHome: untouched, configPath: path.join(untouched, 'config.toml'), appConfigPath: f.configPath, backup: () => '',
  });
  assert.equal(runtime.status().configured, false);
  assert.equal(fs.existsSync(untouched), false);
});

test('paid verification uses unsaved draft config before enable with no gateway or persistent changes', async (t) => {
  const f = ipcFixture(t), calls = [];
  const base = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, key: req.headers.authorization, body: JSON.parse(body) });
    res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
  });
  f.plugins.install('custom-imagegen');
  const before = fs.readFileSync(f.configPath, 'utf8');
  const codexBefore = fs.readFileSync(f.codexConfigPath, 'utf8');
  const draft = { baseUrl: base, apiKey: 'sk-draft-image-key', model: 'draft-model',
    resolution: '2K', aspectRatio: '16:9', quality: 'high', background: 'transparent', preferDefault: false };
  const result = await f.call('image:verify', draft);
  assert.equal(result.ok, true); assert.equal(result.model, 'draft-model');
  assert.equal(result.count, 1); assert.deepEqual(result.formats, ['png']);
  assert.equal(result.baseUrl, base + '/v1');
  assert.equal(typeof result.at, 'number');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: '/v1/images/generations', key: 'Bearer sk-draft-image-key', body: {
    model: 'draft-model', prompt: 'A small white cloud on a plain blue background.', n: 1,
    size: '2048x1152', quality: 'high', background: 'transparent', output_format: 'png',
  } });
  assert.ok(!JSON.stringify(result).includes(PNG));
  assert.ok(!JSON.stringify(result).includes('sk-draft-image-key'));
  assert.equal(f.plugins.isActive('custom-imagegen'), false);
  assert.equal(f.ctx.gateway.getState().running, false);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  assert.equal(fs.readFileSync(f.codexConfigPath, 'utf8'), codexBefore);
  assert.equal(f.backups.length, 0);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'skills', 'gptplus-imagegen')), false);
  await assert.rejects(f.ctx.imageGeneration.generate({ prompt: 'cloud' }), /未启用/);
  assert.equal(calls.length, 1, 'draft verification must not enable ordinary skill/gateway generation');
});

test('draft verification reuses only a blank saved key, never old routing or output defaults', async (t) => {
  const f = ipcFixture(t), calls = [];
  const base = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, key: req.headers.authorization, body: JSON.parse(body) });
    res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
  });
  configure(f, { baseUrl: 'https://saved.example/v2', model: 'saved-model', resolution: '4K',
    aspectRatio: '9:16', quality: 'low', background: 'opaque' });
  const before = fs.readFileSync(f.configPath, 'utf8');
  const draft = { baseUrl: base + '/custom/images/generations', apiKey: '  ', model: 'new-model' };
  await f.call('image:verify', draft);
  assert.deepEqual(calls[0], { url: '/custom/images/generations', key: 'Bearer sk-private-image-key', body: {
    model: 'new-model', prompt: 'A small white cloud on a plain blue background.', n: 1,
    size: '1024x1024', quality: 'auto', background: 'auto',
  } });
  await f.call('image:verify', { ...draft, apiKey: 'sk-new-draft-key', model: 'another-model' });
  assert.equal(calls[1].key, 'Bearer sk-new-draft-key');
  assert.equal(calls[1].body.model, 'another-model');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  assert.equal(f.plugins.config('custom-imagegen').model, 'saved-model');
  assert.equal(f.plugins.config('custom-imagegen').apiKey, 'sk-private-image-key');
  const saved = await f.call('config:set', { id: 'custom-imagegen', config: { ...draft, baseUrl: base } });
  assert.equal(saved.config.baseUrl, base + '/v1', 'saving and verifying use identical URL normalization');
  assert.equal(f.plugins.isActive('custom-imagegen'), false);
  assert.equal(calls.length, 2, 'saving never issues a paid generation');
});

test('draft verification validates required fields before sending and leaves failed drafts unsaved', async (t) => {
  const f = ipcFixture(t); let calls = 0;
  const base = await listen(t, (req, res) => {
    calls++; res.writeHead(401); res.end('sk-draft-secret private upstream response');
  });
  f.plugins.install('custom-imagegen');
  const before = fs.readFileSync(f.configPath, 'utf8');
  const draft = { baseUrl: base, model: 'draft-model', apiKey: 'sk-draft-secret' };
  for (const [patch, message] of [[{ baseUrl: '' }, /URL/], [{ apiKey: '' }, /Key/], [{ model: '' }, /模型/]]) {
    await assert.rejects(f.call('image:verify', { ...draft, ...patch }), message);
  }
  assert.equal(calls, 0);
  await assert.rejects(f.call('image:verify', draft), (err) => /HTTP 401/.test(err.message)
    && !err.message.includes('sk-draft-secret') && !err.message.includes('private upstream response'));
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  assert.equal(f.plugins.isActive('custom-imagegen'), false);
});

test('image URLs add protocol and version like providers while preserving full endpoints', () => {
  const { imageEndpoint } = require('../src/core/image-generation.js');
  const cases = [
    ['https://images.example', 'https://images.example/v1', 'https://images.example/v1/images/generations'],
    ['images.example/', 'https://images.example/v1', 'https://images.example/v1/images/generations'],
    ['http://localhost:8080/', 'http://localhost:8080/v1', 'http://localhost:8080/v1/images/generations'],
    ['localhost:8080', 'https://localhost:8080/v1', 'https://localhost:8080/v1/images/generations'],
    ['https://images.example/v1/', 'https://images.example/v1', 'https://images.example/v1/images/generations'],
    ['https://images.example/v2', 'https://images.example/v2', 'https://images.example/v2/images/generations'],
    ['https://images.example/api/v1beta/', 'https://images.example/api/v1beta', 'https://images.example/api/v1beta/images/generations'],
    ['https://images.example/api', 'https://images.example/api/v1', 'https://images.example/api/v1/images/generations'],
    ['https://images.example/v1/chat/completions', 'https://images.example/v1', 'https://images.example/v1/images/generations'],
    ['https://images.example/images/generations/', 'https://images.example/images/generations', 'https://images.example/images/generations'],
    ['images.example/custom/images/generations', 'https://images.example/custom/images/generations', 'https://images.example/custom/images/generations'],
  ];
  for (const [raw, normalized, endpoint] of cases) {
    assert.equal(normalizeImageConfig({ baseUrl: raw }).baseUrl, normalized, raw);
    assert.equal(imageEndpoint(raw), endpoint, raw);
    assert.equal(imageEndpoint(normalized), endpoint, 'URL completion must be idempotent');
  }
  for (const baseUrl of ['file:///private', 'data:text/plain,hello', 'ftp://images.example',
    'https://user:password@images.example', 'https://images.example?key=private', 'https://images.example/#fragment']) {
    assert.throws(() => imageEndpoint(normalizeImageConfig({ baseUrl }).baseUrl), /URL/, baseUrl);
  }
  assert.equal(normalizeImageConfig({}).baseUrl, '');
});

test('helper response budget accepts every supported four-image gateway output', async (t) => {
  const python = pythonExecutable();
  if (!python) { t.skip('Python 3 is not available on this runner'); return; }
  const file = path.join(__dirname, '..', 'src', 'core', 'assets', 'custom-imagegen', 'generate.py');
  const result = await runPython(python, ['-c', 'import runpy,sys;print(runpy.run_path(sys.argv[1])["MAX_RESPONSE_BYTES"])', file]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Number(result.stdout.trim()) >= 4 * 24 * 1024 * 1024 * 4 / 3 + 1024, 'helper must accept max 4 x 24 MiB base64 plus JSON metadata');
});

test('image resolution tiers map aspect ratios to explicit long-edge 1K, 2K and 4K sizes', () => {
  const { selectImageSize } = require('../src/core/image-generation.js');
  assert.equal(selectImageSize('1K', '1:1'), '1024x1024');
  assert.equal(selectImageSize('2K', '1:1'), '2048x2048');
  assert.equal(selectImageSize('4K', '1:1'), '4096x4096');
  assert.equal(selectImageSize('1K', '4:3'), '1024x768');
  assert.equal(selectImageSize('2K', '3:4'), '1536x2048');
  assert.equal(selectImageSize('4K', '16:9'), '4096x2304');
  assert.equal(selectImageSize('1K', '9:16'), '576x1024');
  assert.throws(() => selectImageSize('8K', '16:9'), /尺寸/);
  assert.throws(() => selectImageSize('1K', '2:1'), /比例/);
});

test('image output quality and background choices are sent with configured defaults and request overrides', async (t) => {
  const f = fixture(t); let payload;
  const base = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    payload = JSON.parse(body); res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
  });
  configure(f, { baseUrl: base + '/v1', resolution: '2K', aspectRatio: '3:4', quality: 'high', background: 'transparent' });
  f.plugins.setEnabled('custom-imagegen', true);
  const service = imageService(f);
  await service.generate({ prompt: 'cloud' });
  assert.equal(payload.size, '1536x2048');
  assert.equal(payload.quality, 'high');
  assert.equal(payload.background, 'transparent');
  assert.equal(payload.output_format, 'png');
  await service.generate({ prompt: 'cloud', resolution: '4K', aspectRatio: '16:9', quality: 'low', background: 'opaque' });
  assert.equal(payload.size, '4096x2304');
  assert.equal(payload.quality, 'low');
  assert.equal(payload.background, 'opaque');
  assert.equal(payload.output_format, undefined);
  await assert.rejects(service.generate({ prompt: 'x', resolution: '5K' }), /尺寸/);
  await assert.rejects(service.generate({ prompt: 'x', aspectRatio: '2:1' }), /比例/);
  await assert.rejects(service.generate({ prompt: 'x', quality: 'xhigh' }), /画质/);
  await assert.rejects(service.generate({ prompt: 'x', background: 'blur' }), /背景/);
});

test('installed helper forwards explicit resolution, aspect ratio, quality and background', async (t) => {
  const python = pythonExecutable();
  if (!python) { t.skip('Python 3 is not available on this runner'); return; }
  const f = skillFixture(t); let payload;
  const base = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    payload = JSON.parse(body);
    res.end(JSON.stringify({ data: [{ b64_json: PNG, format: 'png' }] }));
  });
  configure(f); f.plugins.setEnabled('custom-imagegen', true);
  f.store.update((draft) => { draft.gateway.port = Number(new URL(base).port); });
  f.runtime.sync({ enabled: true, preferDefault: true });
  const output = path.join(f.dir, 'custom-options.png');
  const script = path.join(f.codexHome, 'skills', 'gptplus-imagegen', 'scripts', 'generate.py');
  const result = await runPython(python, [script, '--prompt', 'cloud', '--output', output,
    '--resolution', '4K', '--aspect-ratio', '3:4', '--quality', 'high', '--background', 'transparent']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(payload, { prompt: 'cloud', n: 1, resolution: '4K', aspectRatio: '3:4', quality: 'high', background: 'transparent' });
  assert.equal(fs.existsSync(output), true);
});

test('per-request image options never mutate stored defaults or leak into later and concurrent generations', async (t) => {
  const f = fixture(t), requests = new Map();
  const base = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.set(body.prompt, body);
    res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
  });
  configure(f, { baseUrl: base + '/v1', resolution: '1K', aspectRatio: '1:1', quality: 'auto', background: 'auto' });
  f.plugins.setEnabled('custom-imagegen', true);
  const stored = f.plugins.config('custom-imagegen');
  const disk = fs.readFileSync(f.configPath, 'utf8');
  const service = imageService(f);
  const overrides = { resolution: '4K', aspectRatio: '3:4', quality: 'high', background: 'transparent' };
  await service.generate({ prompt: 'temporary', ...overrides });
  await service.generate({ prompt: 'later-default' });
  await Promise.all([
    service.generate({ prompt: 'parallel-temporary', resolution: '2K', aspectRatio: '16:9', quality: 'low', background: 'opaque' }),
    service.generate({ prompt: 'parallel-default' }),
  ]);
  await service.generate({ prompt: 'partial-override', quality: 'medium' });
  assert.deepEqual(f.plugins.config('custom-imagegen'), stored, 'request overrides must not alter plugin defaults');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), disk, 'generation must never persist temporary settings');
  assert.equal(requests.get('temporary').size, '3072x4096');
  assert.equal(requests.get('temporary').quality, 'high');
  assert.equal(requests.get('temporary').background, 'transparent');
  assert.equal(requests.get('parallel-temporary').size, '2048x1152');
  for (const prompt of ['later-default', 'parallel-default']) {
    assert.deepEqual(requests.get(prompt), { model: 'my-image-model', prompt, n: 1, size: '1024x1024', quality: 'auto', background: 'auto' });
  }
  assert.deepEqual(requests.get('partial-override'), {
    model: 'my-image-model', prompt: 'partial-override', n: 1, size: '1024x1024', quality: 'medium', background: 'auto',
  }, 'only explicitly supplied fields override the saved defaults');
  assert.deepEqual(overrides, { resolution: '4K', aspectRatio: '3:4', quality: 'high', background: 'transparent' }, 'the caller input is not mutated');
});

test('skill instructions scope conversational output settings to the current generation only', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'assets', 'custom-imagegen', 'SKILL.md'), 'utf8');
  assert.match(text, /## Per-request settings/);
  assert.match(text, /current image request/i);
  assert.match(text, /Never persist/i);
  assert.match(text, /previous generation/i);
});
