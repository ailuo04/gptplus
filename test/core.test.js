'use strict';
// core 层单测：全部在临时目录里跑，绝不写真实的 ~/.codex/config.toml 或 ~/.gptplus/config.json。
// 运行：node --test test/core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'src', 'core');

const pathsMod = require(path.join(CORE, 'paths.js'));
const { createStore } = require(path.join(CORE, 'store.js'));
const { createCatalog, slugify, parseSlug, FALLBACK_BASE_INSTRUCTIONS } = require(path.join(CORE, 'catalog.js'));
const { createCodexConfig, _internal: codexToml } = require(path.join(CORE, 'codex-config.js'));
const { createProviderClient } = require(path.join(CORE, 'provider-client.js'));
const { createLogStore, LOG_RING_SIZE } = require(path.join(CORE, 'log-store.js'));
const { createUsageStore } = require(path.join(CORE, 'usage-store.js'));

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

const REQUIRED_CATALOG_FIELDS = [
  'slug',
  'display_name',
  'description',
  'default_reasoning_level',
  'supported_reasoning_levels',
  'shell_type',
  'visibility',
  'supported_in_api',
  'priority',
  'support_verbosity',
  'truncation_policy',
  'experimental_supported_tools',
  'base_instructions',
];

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gptplus-${tag}-`));
}

function cleanup(t, dir) {
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------- 0. 模块可加载

test('core 模块都是纯 Node CommonJS（不依赖 electron）', () => {
  const files = ['paths.js', 'store.js', 'catalog.js', 'codex-config.js', 'provider-client.js', 'log-store.js', 'usage-store.js'];
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(CORE, f), 'utf8'));
    assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(src), `${f} 不应 require('electron')`);
  }
  assert.equal(typeof pathsMod.ensureDirs, 'function');
  assert.equal(typeof createStore, 'function');
  assert.equal(typeof createCatalog, 'function');
  assert.equal(typeof createCodexConfig, 'function');
  assert.equal(typeof createProviderClient, 'function');
  assert.equal(typeof createLogStore, 'function');
  assert.equal(typeof createUsageStore, 'function');
});

// ---------------------------------------------------------------- 1. paths

test('paths: 常量形状正确，$CODEX_HOME 可覆盖，ensureDirs 幂等', (t) => {
  assert.equal(pathsMod.HOME, os.homedir());
  assert.equal(pathsMod.APP_DIR, path.join(os.homedir(), '.gptplus'));
  assert.equal(pathsMod.CONFIG_PATH, path.join(pathsMod.APP_DIR, 'config.json'));
  assert.equal(pathsMod.BACKUP_DIR, path.join(pathsMod.APP_DIR, 'backups'));
  assert.equal(pathsMod.CATALOG_PATH, path.join(pathsMod.APP_DIR, 'model-catalog.json'));
  assert.equal(pathsMod.LOG_PATH, path.join(pathsMod.APP_DIR, 'gateway.log'));
  assert.equal(pathsMod.CODEX_CONFIG_PATH, path.join(pathsMod.CODEX_HOME, 'config.toml'));

  // 在隔离子进程里验证 $CODEX_HOME 覆盖与 ensureDirs（临时 HOME，不碰真实目录）
  const dir = tmpDir('paths');
  cleanup(t, dir);
  const fakeHome = path.join(dir, 'home');
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const script = `
    const p = require(${JSON.stringify(path.join(CORE, 'paths.js'))});
    p.ensureDirs();
    p.ensureDirs();
    const fs = require('fs');
    console.log(JSON.stringify({
      home: p.HOME, app: p.APP_DIR, config: p.CONFIG_PATH, backup: p.BACKUP_DIR,
      codexHome: p.CODEX_HOME, codexConfig: p.CODEX_CONFIG_PATH,
      appExists: fs.existsSync(p.APP_DIR), backupExists: fs.existsSync(p.BACKUP_DIR),
      codexExists: fs.existsSync(p.CODEX_HOME),
    }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CODEX_HOME: codexHome },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.home, fakeHome);
  assert.equal(out.app, path.join(fakeHome, '.gptplus'));
  assert.equal(out.config, path.join(fakeHome, '.gptplus', 'config.json'));
  assert.equal(out.backup, path.join(fakeHome, '.gptplus', 'backups'));
  assert.equal(out.codexHome, codexHome);
  assert.equal(out.codexConfig, path.join(codexHome, 'config.toml'));
  assert.equal(out.appExists, true);
  assert.equal(out.backupExists, true);
  // 不擅自创建用户的 codex 目录
  assert.equal(out.codexExists, false);
});

// ---------------------------------------------------------------- 2. store

test('store: 默认值 / provider CRUD / 深拷贝隔离', (t) => {
  const dir = tmpDir('store');
  cleanup(t, dir);
  const configPath = path.join(dir, 'config.json');
  const store = createStore({ configPath });

  const cfg = store.get();
  assert.equal(cfg.version, 1);
  assert.equal(cfg.gateway.enabled, true);
  assert.equal(cfg.gateway.port, 18120);
  assert.equal(cfg.gateway.host, '127.0.0.1');
  assert.deepEqual(cfg.network, { proxyMode: 'system' });
  assert.equal(cfg.theme, 'dark');
  assert.equal(typeof cfg.gateway.token, 'string');
  assert.equal(cfg.gateway.token.length, 32);
  assert.deepEqual(cfg.modelLimits, { contextWindow: 1_000_000, autoCompactTokenLimit: null });
  assert.deepEqual(cfg.inject, { enabled: false, catalogPath: null, defaultModel: null });
  assert.deepEqual(cfg.modelOrder, []);
  assert.deepEqual(cfg.providers, []);
  // 首次加载即落盘，保证 token 稳定
  assert.ok(fs.existsSync(configPath));

  const p1 = store.upsertProvider({
    name: '梦幻API',
    baseUrl: 'https://mhapi.net/v1',
    apiKey: 'sk-test-not-real',
    api: 'openai',
    headers: { 'X-Trace': '1' },
    enabled: true,
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true }],
  });
  assert.match(p1.id, /^p_[0-9a-f]{8}$/);
  assert.equal(p1.enabled, true);
  assert.equal(p1.models[0].reasoning, true);
  assert.equal(store.providers().length, 1);

  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.providers[0].id, p1.id);
  assert.equal(onDisk.providers[0].name, '梦幻API');
  assert.equal(onDisk.providers[0].apiKey, 'sk-test-not-real');

  // 快照/返回值为深拷贝
  const snap = store.providers();
  snap[0].name = 'HACK';
  snap[0].models.push({ id: 'injected' });
  const fetched = store.getProvider(p1.id);
  assert.equal(fetched.name, '梦幻API');
  assert.equal(fetched.models.length, 1);
  const full = store.get();
  full.providers.length = 0;
  assert.equal(store.providers().length, 1);

  // 同 id 更新（不新增）
  const p1b = store.upsertProvider({
    id: p1.id,
    name: '梦幻API 2',
    models: [{ id: 'a' }, { id: 'a', label: 'dup' }, { id: 'b', enabled: false }],
  });
  assert.equal(p1b.id, p1.id);
  assert.equal(store.providers().length, 1);
  assert.equal(p1b.name, '梦幻API 2');
  assert.deepEqual(p1b.models.map((m) => m.id), ['a', 'b']);
  assert.equal(p1b.models[0].label, 'a');
  assert.equal(p1b.models[1].enabled, false);

  const p2 = store.upsertProvider({ name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
  assert.notEqual(p2.id, p1.id);
  assert.match(p2.id, /^p_[0-9a-f]{8}$/);
  assert.equal(store.providers().length, 2);

  assert.equal(store.removeProvider(p1.id), true);
  assert.equal(store.removeProvider('p_nope'), false);
  assert.equal(store.providers().length, 1);

  // update 落盘 + 非法端口回落
  store.update((d) => {
    d.gateway.port = 19999;
  });
  assert.equal(store.get().gateway.port, 19999);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).gateway.port, 19999);
  store.update((d) => {
    d.gateway.port = 'not-a-port';
  });
  assert.equal(store.get().gateway.port, 18120);

  const token = store.newGatewayToken();
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 32);
  assert.notEqual(token, store.newGatewayToken());
});

test('store: 损坏文件恢复 + 备份损坏内容', (t) => {
  const dir = tmpDir('store-broken');
  cleanup(t, dir);
  const configPath = path.join(dir, 'config.json');
  const broken = '{ "version": 1, "providers": [';
  fs.writeFileSync(configPath, broken, 'utf8');

  const store = createStore({ configPath });
  assert.deepEqual(store.providers(), []);
  assert.equal(store.get().gateway.port, 18120);
  assert.equal(store.get().version, 1);

  const backupDir = path.join(dir, 'backups');
  const backups = fs
    .readdirSync(backupDir)
    .filter((n) => n.startsWith('config.json.'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), broken);

  // 损坏文件已被可用的默认配置替换
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).version, 1);
  // 可重复 load
  store.load();
  assert.equal(store.get().version, 1);
});

test('store: 半损坏字段被规整，重复 id 重新生成', (t) => {
  const dir = tmpDir('store-partial');
  cleanup(t, dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 'x',
      gateway: { port: 'nope', host: '', token: 123 },
      inject: { enabled: 'yes', catalogPath: '', defaultModel: '   ' },
      providers: [
        { name: 'A', models: 'bad' },
        { id: 'p_dupppp', name: 'B', models: [{ id: 'm1', label: 42 }, { id: '' }] },
        { id: 'p_dupppp', name: 'C' },
      ],
    }),
    'utf8',
  );
  const store = createStore({ configPath });
  const cfg = store.get();
  assert.equal(cfg.version, 1);
  assert.equal(cfg.gateway.port, 18120);
  assert.equal(cfg.gateway.host, '127.0.0.1');
  assert.equal(cfg.gateway.token.length, 32);
  assert.deepEqual(cfg.modelLimits, { contextWindow: 1_000_000, autoCompactTokenLimit: null });
  assert.equal(cfg.inject.enabled, false);
  assert.equal(cfg.inject.catalogPath, null);
  assert.equal(cfg.inject.defaultModel, null);
  assert.equal(cfg.providers.length, 3);
  assert.deepEqual(cfg.providers[0].models, []);
  assert.match(cfg.providers[0].id, /^p_[0-9a-f]{8}$/);
  assert.equal(cfg.providers[1].models.length, 1);
  assert.equal(cfg.providers[1].models[0].label, '42');
  assert.notEqual(cfg.providers[1].id, cfg.providers[2].id);
});

// ---------------------------------------------------------------- 3. catalog

test('catalog: slugify / parseSlug 往返（按第一个 __ 切分）', () => {
  assert.equal(slugify('p_ab12cd', 'gpt-6.1-sol'), 'p_ab12cd__gpt-6.1-sol');
  assert.deepEqual(parseSlug('p_ab12cd__gpt-6.1-sol'), {
    providerId: 'p_ab12cd',
    modelId: 'gpt-6.1-sol',
  });
  assert.deepEqual(parseSlug(slugify('p_abc', 'some__model')), {
    providerId: 'p_abc',
    modelId: 'some__model',
  });
  assert.deepEqual(parseSlug('a__b__c'), { providerId: 'a', modelId: 'b__c' });
  assert.deepEqual(parseSlug('p_x__qwen3-coder:30b'), { providerId: 'p_x', modelId: 'qwen3-coder:30b' });
  assert.equal(parseSlug('no-separator'), null);
  assert.equal(parseSlug('__x'), null);
  assert.equal(parseSlug('a__'), null);
  assert.equal(parseSlug(''), null);
  assert.equal(parseSlug(null), null);
  assert.equal(parseSlug(undefined), null);
  assert.equal(parseSlug(123), null);
  assert.equal(slugify('p_ab12cd', 'gpt-6.1-sol', '梦幻 API'), '梦幻-API__gpt-6.1-sol');
});

test('store/catalog: modelOrder 持久化，并按稳定键重排跨渠道模型', (t) => {
  const dir = tmpDir('model-order');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const p1 = store.upsertProvider({ name: '渠道 A', models: [{ id: 'm1' }, { id: 'm2' }] });
  const p2 = store.upsertProvider({ name: '渠道 B', models: [{ id: 'm3' }] });
  const order = [p2.id + '::m3', p1.id + '::m2', p1.id + '::m1'];
  store.update((draft) => { draft.modelOrder = order; });
  assert.deepEqual(store.get().modelOrder, order);
  const catalog = createCatalog({ store, paths: { CATALOG_PATH: path.join(dir, 'catalog.json'), CODEX_HOME: path.join(dir, 'codex-home') } });
  assert.deepEqual(catalog.buildEntries().map(({ entry }) => entry.slug), ['渠道-B__m3', '渠道-A__m2', '渠道-A__m1']);
  assert.deepEqual(catalog.buildEntries().map(({ entry }) => entry.priority), [1, 2, 3]);
});

test('store/catalog: 模型上下文设置可持久化并统一写入所有模型目录条目', (t) => {
  const dir = tmpDir('model-limits');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.update((draft) => {
    draft.modelLimits = { contextWindow: 272000, autoCompactTokenLimit: 244800 };
  });
  assert.deepEqual(store.get().modelLimits, { contextWindow: 272000, autoCompactTokenLimit: 244800 });

  store.upsertProvider({ name: 'A', baseUrl: 'https://a.example/v1', models: [{ id: 'm1' }, { id: 'm2' }] });
  store.upsertProvider({ name: 'B', baseUrl: 'https://b.example/v1', models: [{ id: 'm3' }] });
  const catalog = createCatalog({
    store,
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json'), CODEX_HOME: path.join(dir, 'codex-home') },
  });
  const entries = catalog.buildEntries();
  assert.equal(entries.length, 3);
  for (const { entry } of entries) {
    assert.equal(entry.context_window, 272000);
    assert.equal(entry.max_context_window, 272000);
    assert.equal(entry.auto_compact_token_limit, 244800);
    assert.equal(entry.effective_context_window_percent, 100);
    assert.equal(entry.truncation_policy.limit, 10000);
  }
});

test('catalog: 目录条目含全部必填字段，落盘可解析', (t) => {
  const dir = tmpDir('catalog');
  cleanup(t, dir);
  const catalogPath = path.join(dir, 'model-catalog.json');
  const codexHome = path.join(dir, 'codex-home');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const p1 = store.upsertProvider({
    name: '梦幻API',
    baseUrl: 'https://mhapi.net/v1',
    enabled: true,
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', enabled: true },
      { id: 'off-model', label: 'Off Model', enabled: false },
    ],
  });
  store.upsertProvider({
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', enabled: true }],
  });

  const catalog = createCatalog({ store, paths: { CATALOG_PATH: catalogPath, CODEX_HOME: codexHome } });
  const entries = catalog.buildEntries();
  assert.equal(entries.length, 3);

  for (const { slug, entry } of entries) {
    for (const field of REQUIRED_CATALOG_FIELDS) {
      assert.ok(field in entry, `缺少必填字段 ${slug}.${field}`);
    }
    assert.equal(entry.slug, slug);
    assert.equal(entry.visibility, 'list');
    assert.equal(entry.supported_in_api, true);
    assert.equal(entry.shell_type, 'unified_exec');
    assert.equal(entry.support_verbosity, true);
    assert.equal(typeof entry.priority, 'number');
    assert.equal(entry.context_window, 1_000_000);
    assert.equal(entry.max_context_window, 1_000_000);
    assert.equal(entry.effective_context_window_percent, 100);
    assert.equal(entry.auto_compact_token_limit, null);
    assert.ok(entry.supported_reasoning_levels.length > 0);
    assert.ok(entry.supported_reasoning_levels.every((l) => typeof l.effort === 'string'));
    assert.equal(entry.truncation_policy.mode, 'tokens');
    assert.equal(typeof entry.truncation_policy.limit, 'number');
    assert.ok(Array.isArray(entry.experimental_supported_tools));
    assert.ok(typeof entry.base_instructions === 'string' && entry.base_instructions.length > 0);
    assert.deepEqual(parseSlug(entry.slug) && slugify(parseSlug(entry.slug).providerId, parseSlug(entry.slug).modelId), entry.slug);
  }
  assert.equal(entries[0].slug, '梦幻API__gpt-6.1-sol');
  assert.ok(entries[0].entry.display_name.includes('梦幻API'));
  assert.ok(!entries.some((e) => e.slug.includes('off-model')));
  assert.deepEqual(entries.map((e) => e.entry.priority), [1, 2, 3]);

  const json = catalog.buildCatalogJson();
  assert.deepEqual(Object.keys(json), ['models']);
  assert.equal(json.models.length, 3);

  const written = catalog.writeCatalog();
  assert.equal(written.path, catalogPath);
  assert.equal(written.count, 3);
  const text = fs.readFileSync(catalogPath, 'utf8');
  assert.equal(written.bytes, Buffer.byteLength(text, 'utf8'));
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.models.map((m) => m.slug), entries.map((e) => e.slug));

  // 关掉 provider / model 后不再进目录
  store.update((d) => {
    d.providers[1].enabled = false;
    d.providers[0].models[1].enabled = false;
  });
  assert.deepEqual(catalog.buildEntries().map((e) => e.slug), ['梦幻API__gpt-6.1-sol']);
});

test('catalog: base_instructions 优先取 models_cache.json，缺失/损坏时用内置版', (t) => {
  const dir = tmpDir('catalog-bi');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.upsertProvider({ name: 'X', models: [{ id: 'm' }] });

  const goodHome = path.join(dir, 'good-home');
  fs.mkdirSync(goodHome, { recursive: true });
  const REAL = 'REAL-INSTRUCTIONS-FROM-CACHE';
  fs.writeFileSync(
    path.join(goodHome, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-5.9', base_instructions: 'OTHER' }, { slug: 'gpt-5.5', base_instructions: REAL }] }),
    'utf8',
  );
  const good = createCatalog({ store, paths: { CATALOG_PATH: path.join(dir, 'a.json'), CODEX_HOME: goodHome } });
  assert.equal(good.seedBaseInstructions(), REAL);
  assert.equal(good.buildEntries()[0].entry.base_instructions, REAL);

  const badHome = path.join(dir, 'bad-home');
  fs.mkdirSync(badHome, { recursive: true });
  fs.writeFileSync(path.join(badHome, 'models_cache.json'), '{oops', 'utf8');
  const bad = createCatalog({ store, paths: { CATALOG_PATH: path.join(dir, 'b.json'), CODEX_HOME: badHome } });
  assert.equal(bad.seedBaseInstructions(), FALLBACK_BASE_INSTRUCTIONS);
  assert.match(bad.seedBaseInstructions(), /You are Codex/);

  const missingHome = path.join(dir, 'missing-home');
  const missing = createCatalog({
    store,
    paths: { CATALOG_PATH: path.join(dir, 'c.json'), CODEX_HOME: missingHome },
  });
  assert.equal(missing.seedBaseInstructions(), FALLBACK_BASE_INSTRUCTIONS);
});

test('catalog: 真实 ~/.codex/models_cache.json 的 gpt-5.5 提示词可复用（只读）', (t) => {
  const cachePath = path.join(pathsMod.CODEX_HOME, 'models_cache.json');
  if (!fs.existsSync(cachePath)) return t.skip('models_cache.json 不存在');
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const official = (data.models || []).find((m) => m.slug === 'gpt-5.5');
  if (!official || !official.base_instructions) return t.skip('缓存里没有 gpt-5.5');

  const dir = tmpDir('catalog-real');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.upsertProvider({ name: 'X', models: [{ id: 'm' }] });
  const catalog = createCatalog({
    store,
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json'), CODEX_HOME: pathsMod.CODEX_HOME },
  });
  assert.equal(catalog.seedBaseInstructions(), official.base_instructions);
  assert.ok(catalog.seedBaseInstructions().length > 1000);
});

// ---------------------------------------------------------------- 4. codex-config

const SAMPLE_TOML = [
  '# user comment must survive',
  'model = "gpt-6-astra"',
  'model_provider = "custom"',
  'model_reasoning_effort = "xhigh"',
  '',
  'notify = [ "C:\\\\path\\\\codex.exe", "turn-ended" ]',
  '',
  '[model_providers.custom]',
  'name = "梦幻API"',
  'base_url = "https://mhapi.net"',
  '',
  '[mcp_servers.codegraph]',
  'command = "codegraph"',
  'args = ["serve", "--mcp"]',
  '',
  '[windows]',
  'sandbox = "elevated"',
  '',
].join('\n');

function makeCodex(t, opts = {}) {
  const { toml = SAMPLE_TOML, port = 18120, host = '127.0.0.1', token = 'tok-123', writeFile = true } = opts;
  const dir = tmpDir('codex');
  cleanup(t, dir);
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, 'config.toml');
  const catalogPath = path.join(dir, 'model-catalog.json');
  const backupDir = path.join(dir, 'backups');
  if (writeFile) fs.writeFileSync(configPath, toml, 'utf8');

  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.update((d) => {
    d.gateway.port = port;
    d.gateway.host = host;
    d.gateway.token = token;
  });
  const catalog = { writeCatalog: () => ({ path: catalogPath, count: 1, bytes: 2 }) };
  const codex = createCodexConfig({
    store,
    catalog,
    paths: { CODEX_CONFIG_PATH: configPath, CODEX_HOME: codexHome, BACKUP_DIR: backupDir, CATALOG_PATH: catalogPath },
  });
  return { dir, codexHome, configPath, catalogPath, backupDir, store, catalog, codex };
}

test('codex-config: 注入写入必需键/段，用户内容逐字保留', (t) => {
  const { codex, catalogPath } = makeCodex(t);
  const res = codex.applyInjection({
    enabled: true,
    catalogPath,
    defaultModel: 'p_ab12cd__gpt-6.1-sol',
  });
  assert.equal(res.changed, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath));
  assert.match(res.backupPath, /config\.toml\.\d{8}-\d{6}/);
  assert.equal(codex.isInjected(), true);

  const text = codex.readText();
  assert.match(text, /^\s*model_provider\s*=\s*"gptplus"\s*$/m);
  assert.match(text, /^\s*model\s*=\s*"p_ab12cd__gpt-6\.1-sol"\s*$/m);
  assert.match(text, /^\s*model_catalog_json\s*=\s*".*model-catalog\.json"\s*$/m);
  assert.match(text, /\[model_providers\.gptplus\]/);
  assert.match(text, /base_url\s*=\s*"http:\/\/127\.0\.0\.1:18120\/v1"/);
  assert.match(text, /wire_api\s*=\s*"responses"/);
  assert.match(text, /requires_openai_auth\s*=\s*false/);
  assert.match(text, /experimental_bearer_token\s*=\s*"tok-123"/);
  assert.ok(text.includes(catalogPath.replace(/\\/g, '\\\\')), '路径必须 TOML 转义');

  // 用户内容逐字保留
  assert.ok(text.includes('# user comment must survive'));
  assert.ok(text.includes('model_reasoning_effort = "xhigh"'));
  assert.ok(text.includes('notify = [ "C:\\\\path\\\\codex.exe", "turn-ended" ]'));
  assert.ok(text.includes('[model_providers.custom]'));
  assert.ok(text.includes('name = "梦幻API"'));
  assert.ok(text.includes('base_url = "https://mhapi.net"'));
  assert.ok(text.includes('[mcp_servers.codegraph]'));
  assert.ok(text.includes('args = ["serve", "--mcp"]'));
  assert.ok(text.includes('[windows]'));
  assert.ok(text.includes('sandbox = "elevated"'));

  // 幂等
  const again = codex.applyInjection({
    enabled: true,
    catalogPath,
    defaultModel: 'p_ab12cd__gpt-6.1-sol',
  });
  assert.equal(again.changed, false);
  assert.equal(codex.readText(), text);
});

test('codex-config: 关闭注入后逐字节还原，可反复开关', (t) => {
  const { codex, catalogPath } = makeCodex(t);
  codex.applyInjection({ enabled: true, catalogPath, defaultModel: 'slug-1' });
  assert.notEqual(codex.readText(), SAMPLE_TOML);

  const off = codex.applyInjection({ enabled: false });
  assert.equal(off.changed, true);
  assert.equal(codex.readText(), SAMPLE_TOML, '关闭后必须逐字节回到原文件');
  assert.equal(codex.isInjected(), false);
  assert.ok(!/gptplus/.test(codex.readText()));
  assert.equal(codex.applyInjection({ enabled: false }).changed, false);

  // 再开再关
  codex.applyInjection({ enabled: true, catalogPath, defaultModel: 'slug-2' });
  assert.match(codex.readText(), /^model = "slug-2"$/m);
  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), SAMPLE_TOML);
});

test('codex-config: 用户原本就有 model_catalog_json 也要能还原', (t) => {
  const toml = [
    '# c',
    'model = "a"',
    'model_provider = "custom"',
    'model_catalog_json = "C:\\\\old\\\\cat.json"',
    '',
    '[x]',
    'a = 1',
    '',
  ].join('\n');
  const { codex, catalogPath } = makeCodex(t, { toml });
  codex.applyInjection({ enabled: true, catalogPath, defaultModel: 's' });
  const injected = codex.readText();
  assert.ok(injected.includes(catalogPath.replace(/\\/g, '\\\\')));
  assert.ok(!injected.includes('old\\\\cat.json'));
  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), toml);
});

test('codex-config: 无末尾换行 / CRLF / 空文件边界', (t) => {
  // 1) 无末尾换行、无表头
  const bare = 'model = "old"';
  const c1 = makeCodex(t, { toml: bare });
  c1.codex.applyInjection({ enabled: true, catalogPath: c1.catalogPath, defaultModel: 's' });
  const mid = c1.codex.readText();
  assert.match(mid, /^model = "s"$/m);
  assert.match(mid, /^model_catalog_json = /m);
  assert.match(mid, /\[model_providers\.gptplus\]/);
  assert.equal(c1.codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(c1.codex.readText(), bare);

  // 2) CRLF 文件不应被混入裸 LF
  const crlf = [
    '# c',
    'model = "x"',
    'model_provider = "custom"',
    '',
    '[mcp_servers.a]',
    'command = "x"',
    '',
  ].join('\r\n');
  const c2 = makeCodex(t, { toml: crlf });
  c2.codex.applyInjection({ enabled: true, catalogPath: c2.catalogPath, defaultModel: 's' });
  const injectedCrlf = c2.codex.readText();
  assert.ok(injectedCrlf.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(injectedCrlf), 'CRLF 文件里不应出现裸 LF');
  assert.equal(c2.codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(c2.codex.readText(), crlf);

  // 3) 空文件
  const c3 = makeCodex(t, { toml: '' });
  assert.equal(c3.codex.readText(), '');
  c3.codex.applyInjection({ enabled: true, catalogPath: c3.catalogPath, defaultModel: 's' });
  assert.ok(c3.codex.readText().length > 0);
  assert.equal(c3.codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(c3.codex.readText(), '');

  // 4) 文件不存在时不报错
  const c4 = makeCodex(t, { writeFile: false });
  assert.equal(c4.codex.readText(), '');
  assert.equal(c4.codex.applyInjection({ enabled: false }).changed, false);
  c4.codex.applyInjection({ enabled: true, catalogPath: c4.catalogPath, defaultModel: 's' });
  assert.match(c4.codex.readText(), /\[model_providers\.gptplus\]/);
  c4.codex.applyInjection({ enabled: false });
  assert.equal(fs.existsSync(c4.configPath), false, '我们创建的空文件应被删除');
});

test('codex-config: 多行数组里的 [ 不被误判成表头', (t) => {
  const toml = [
    'model = "a"',
    'notify = [',
    '  "x",',
    '  ["nested"],',
    ']',
    '',
    '[table1]',
    'k = 1',
    '',
  ].join('\n');
  const { codex, catalogPath } = makeCodex(t, { toml });
  codex.applyInjection({ enabled: true, catalogPath, defaultModel: 's' });
  const injected = codex.readText();
  assert.ok(injected.includes('  ["nested"],'));
  const lines = injected.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim() === '[table1]');
  const catalogIdx = lines.findIndex((l) => l.startsWith('model_catalog_json'));
  assert.ok(catalogIdx >= 0 && catalogIdx < headerIdx, '顶层键必须写在第一个表头之前');
  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), toml);
});

test('codex-config: 备份保留最近 10 份', (t) => {
  const { codex, configPath, backupDir } = makeCodex(t, { toml: SAMPLE_TOML });
  for (let i = 0; i < 14; i += 1) {
    const text = `# rev ${i}\nmodel = "m${i}"\n`;
    fs.writeFileSync(configPath, text, 'utf8');
    const p = codex.backup();
    assert.ok(p && fs.existsSync(p), `第 ${i} 次备份应生成文件`);
    assert.equal(fs.readFileSync(p, 'utf8'), text);
    assert.ok(p.startsWith(backupDir));
  }
  const files = fs.readdirSync(backupDir).filter((n) => n.startsWith('config.toml.'));
  assert.equal(files.length, 10);
  const newest = files.sort().at(-1);
  assert.equal(fs.readFileSync(path.join(backupDir, newest), 'utf8'), '# rev 13\nmodel = "m13"\n');
  assert.match(newest, /^config\.toml\.\d{8}-\d{6}/);
});

test('codex-config: base_url 跟随 store.gateway.port/host，改端口后幂等更新', (t) => {
  const { codex, catalogPath, store } = makeCodex(t, { port: 18130 });
  const args = { enabled: true, catalogPath, defaultModel: 'slug-a' };
  // 我们追加的 gptplus 段永远在文件末尾，取它做“段内计数”，避免把用户自己段里的同名键算进来
  const ourSection = (text) => text.slice(text.indexOf('[model_providers.gptplus]'));

  // 1) 初始端口不是 18120 时必须写 18130（用户配置的端口）
  assert.equal(codex.applyInjection(args).changed, true);
  let text = codex.readText();
  assert.match(text, /^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:18130\/v1"\s*$/m);
  assert.equal(countMatches(text, /\[model_providers\.gptplus\]/g), 1);
  assert.equal(countMatches(ourSection(text), /^\s*base_url\s*=/gm), 1);
  assert.ok(text.includes('base_url = "https://mhapi.net"'), '用户自己段里的 base_url 不能被动');

  // 2) 用户在设置页改端口（ipc 会 store.update + 再调一次 applyInjection）
  store.update((d) => {
    d.gateway.port = 19999;
  });
  assert.equal(codex.applyInjection(args).changed, true);
  text = codex.readText();
  assert.match(text, /^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:19999\/v1"\s*$/m);
  assert.ok(!text.includes(':18130/v1'), '旧端口的 base_url 必须被就地替换掉');
  assert.equal(countMatches(text, /\[model_providers\.gptplus\]/g), 1, '不能出现重复的 gptplus 段');
  assert.equal(countMatches(ourSection(text), /^\s*base_url\s*=/gm), 1, 'base_url 只能保留一行');
  assert.equal(countMatches(ourSection(text), /^\s*wire_api\s*=/gm), 1);
  assert.equal(countMatches(text, /^\s*model_provider\s*=/gm), 1);
  assert.equal(countMatches(text, /^\s*model_catalog_json\s*=/gm), 1);

  // 3) 端口没变 → 重复注入完全幂等（无写入、无新段、无新行）
  const idempotent = codex.applyInjection(args);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.backupPath, '');
  assert.equal(codex.readText(), text);

  // 4) host 也跟随 store
  store.update((d) => {
    d.gateway.host = '0.0.0.0';
  });
  assert.equal(codex.applyInjection(args).changed, true);
  assert.match(codex.readText(), /^\s*base_url\s*=\s*"http:\/\/0\.0\.0\.0:19999\/v1"\s*$/m);

  // 5) 显式传入的 port/host 优先于 store
  codex.applyInjection({ ...args, port: 19001, host: 'localhost' });
  assert.match(codex.readText(), /^\s*base_url\s*=\s*"http:\/\/localhost:19001\/v1"\s*$/m);
  assert.equal(countMatches(codex.readText(), /\[model_providers\.gptplus\]/g), 1);

  // 6) 端口/host 改动不影响还原：仍然逐字节回到原文件
  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), SAMPLE_TOML);
});

test('codex-config: 端口变化下 enable→disable→enable 往返，其它内容逐字节不变', (t) => {
  const { codex, catalogPath, store } = makeCodex(t, { port: 18130 });
  const inject = () => codex.applyInjection({ enabled: true, catalogPath, defaultModel: 'slug-a' });

  inject();
  store.update((d) => {
    d.gateway.port = 18888;
  });
  inject();
  assert.match(codex.readText(), /^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:18888\/v1"\s*$/m);

  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), SAMPLE_TOML, '端口变化后还原仍必须逐字节等于原文');

  // 再开（用新端口）再关
  assert.equal(codex.applyInjection({ enabled: true, catalogPath, defaultModel: 'slug-b' }).changed, true);
  assert.match(codex.readText(), /^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:18888\/v1"\s*$/m);
  assert.equal(countMatches(codex.readText(), /\[model_providers\.gptplus\]/g), 1);
  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), SAMPLE_TOML);
});

test('codex-config: host/port 归一化（IPv6、误填端口、协议前缀、非法值）', () => {
  const { normalizePort, normalizeHost } = codexToml;
  assert.equal(normalizePort(19999, 18120), 19999);
  assert.equal(normalizePort('18130', 18120), 18130);
  assert.equal(normalizePort(0, 18120), 18120);
  assert.equal(normalizePort(-1, 18120), 18120);
  assert.equal(normalizePort(70000, 18120), 18120);
  assert.equal(normalizePort('abc', 18120), 18120);
  assert.equal(normalizePort(undefined, 18120), 18120);

  assert.equal(normalizeHost('127.0.0.1', 'fallback'), '127.0.0.1');
  assert.equal(normalizeHost('localhost', 'fallback'), 'localhost');
  assert.equal(normalizeHost('', 'fallback'), 'fallback');
  assert.equal(normalizeHost('   ', 'fallback'), 'fallback');
  assert.equal(normalizeHost(undefined, 'fallback'), 'fallback');
  assert.equal(normalizeHost('http://1.2.3.4/v1', 'fallback'), '1.2.3.4');
  assert.equal(normalizeHost('127.0.0.1:9999', 'fallback'), '127.0.0.1');
  assert.equal(normalizeHost('::1', 'fallback'), '[::1]');
  assert.equal(normalizeHost('[::1]', 'fallback'), '[::1]');
});

test('codex-config: 真实 ~/.codex/config.toml 可注入并逐字还原（临时副本，只读源文件）', (t) => {
  const realPath = pathsMod.CODEX_CONFIG_PATH;
  if (!fs.existsSync(realPath)) return t.skip('真实 config.toml 不存在');
  const toml = fs.readFileSync(realPath, 'utf8');
  if (toml.includes('# >>> gpt++ gateway provider >>>')) {
    // 真实文件当前正处于注入状态：还原（applyInjection(false) 会拆掉标记块）
    // 之后必然比原文件少这一段，逐字比对不再成立。测试只对未注入状态有意义。
    return t.skip('真实 config.toml 当前处于注入状态，跳过逐字还原比对');
  }
  assert.ok(toml.length > 100);
  const { codex, catalogPath } = makeCodex(t, { toml });
  const res = codex.applyInjection({
    enabled: true,
    catalogPath,
    defaultModel: 'p_ab12cd__gpt-6.1-sol',
  });
  assert.equal(res.changed, true);
  const injected = codex.readText();
  assert.match(injected, /^model_provider = "gptplus"$/m);
  assert.match(injected, /^model = "p_ab12cd__gpt-6\.1-sol"$/m);
  assert.ok(injected.includes('[mcp_servers.node_repl.env]'));
  assert.ok(injected.includes('[plugins."browser@openai-bundled"]'));
  assert.ok(injected.includes('[windows]'));
  // 源文件绝不能被改动
  assert.equal(fs.readFileSync(realPath, 'utf8'), toml);
  assert.equal(codex.applyInjection({ enabled: false }).changed, true);
  assert.equal(codex.readText(), toml, '真实 config.toml 必须能逐字还原');
});

// ---------------------------------------------------------------- 5. provider-client

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function closeServer(t, server) {
  t.after(() => {
    try {
      server.closeAllConnections();
    } catch {
      /* ignore */
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });
}

test('provider-client: 正常拉取 /models，带 Bearer 头', async (t) => {
  let seenAuth = null;
  let seenPath = null;
  const { server, url } = await startServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6.1-sol' }, { id: 'm2', name: 'M2' }, 'm3'] }));
  });
  closeServer(t, server);
  const dir = tmpDir('pc');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const provider = store.upsertProvider({ name: 'T', baseUrl: url, apiKey: 'sk-test', api: 'openai' });
  const client = createProviderClient({ store });

  const probe = await client.testProvider(provider.id);
  assert.equal(probe.ok, true);
  assert.equal(probe.status, 200);
  assert.ok(probe.latencyMs >= 0);
  assert.equal(probe.error, undefined);
  assert.equal(seenAuth, 'Bearer sk-test');
  assert.equal(seenPath, '/v1/models');

  const remote = await client.fetchRemoteModels(provider.id);
  assert.equal(remote.ok, true);
  assert.deepEqual(remote.models, [
    { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
    { id: 'm2', label: 'M2' },
    { id: 'm3', label: 'm3' },
  ]);
});

test('provider-client: 指定模型逐个请求实际生成接口并返回各自状态与延时', async (t) => {
  const requests = [];
  const { server, url } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    res.writeHead(body.model === 'bad-model' ? 400 : 200, { 'content-type': 'application/json' });
    res.end(body.model === 'bad-model'
      ? JSON.stringify({ error: { message: 'model unavailable' } })
      : JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  closeServer(t, server);
  const dir = tmpDir('pc-model-test');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const provider = store.upsertProvider({
    name: 'T', baseUrl: url, apiKey: 'sk-test', api: 'openai',
    models: [{ id: 'good-model' }, { id: 'bad-model' }],
  });
  const client = createProviderClient({ store });

  const result = await client.testProviderModels(provider.id, ['good-model', 'bad-model', 'good-model']);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2, '重复模型只测试一次');
  assert.deepEqual(result.results.map(({ modelId, ok, status }) => ({ modelId, ok, status })), [
    { modelId: 'good-model', ok: true, status: 200 },
    { modelId: 'bad-model', ok: false, status: 400 },
  ]);
  assert.ok(result.results.every((item) => item.latencyMs >= 0));
  assert.match(result.results[1].error, /model unavailable/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.path === '/v1/chat/completions'));
  assert.ok(requests.every((request) => request.auth === 'Bearer sk-test'));
  assert.deepEqual(requests.map((request) => request.body.model), ['good-model', 'bad-model']);
});

test('provider-client: 按 Anthropic 与 Responses 协议构造最小生成请求', async (t) => {
  const requests = [];
  const { server, url } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/messages')
      ? JSON.stringify({ content: [{ type: 'text', text: 'OK' }] })
      : JSON.stringify({ id: 'resp_test', status: 'completed', output: [] }));
  });
  closeServer(t, server);
  const dir = tmpDir('pc-model-protocols');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const anthropic = store.upsertProvider({ name: 'A', baseUrl: url, apiKey: 'sk-ant', api: 'anthropic', models: [{ id: 'claude-test' }] });
  const responses = store.upsertProvider({ name: 'R', baseUrl: url, apiKey: 'sk-res', api: 'responses', models: [{ id: 'gpt-test' }] });
  const client = createProviderClient({ store });

  assert.equal((await client.testProviderModels(anthropic.id, ['claude-test'])).ok, true);
  assert.equal((await client.testProviderModels(responses.id, ['gpt-test'])).ok, true);
  assert.equal(requests[0].path, '/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'sk-ant');
  assert.equal(requests[0].body.model, 'claude-test');
  assert.equal(requests[1].path, '/v1/responses');
  assert.equal(requests[1].headers.authorization, 'Bearer sk-res');
  assert.equal(requests[1].body.model, 'gpt-test');
});

test('provider-client: 401 / 非 JSON / 连接失败 / 未知 id 都返回结构化结果', async (t) => {
  const dir = tmpDir('pc-err');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const client = createProviderClient({ store });

  const unauthorized = await startServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  closeServer(t, unauthorized.server);
  const p401 = store.upsertProvider({ name: 'U', baseUrl: unauthorized.url, apiKey: 'nope' });
  const r401 = await client.testProvider(p401.id);
  assert.equal(r401.ok, false);
  assert.equal(r401.status, 401);
  assert.match(r401.error, /401/);
  assert.match(r401.error, /API Key/);
  const r401m = await client.fetchRemoteModels(p401.id);
  assert.equal(r401m.ok, false);
  assert.deepEqual(r401m.models, []);
  assert.ok(r401m.error);

  const notJson = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>hello</html>');
  });
  closeServer(t, notJson.server);
  const pnj = store.upsertProvider({ name: 'NJ', baseUrl: notJson.url });
  assert.equal((await client.testProvider(pnj.id)).ok, true, 'HTTP 200 即视为连通');
  const rnj = await client.fetchRemoteModels(pnj.id);
  assert.equal(rnj.ok, false);
  assert.match(rnj.error, /模型列表/);

  const dead = await startServer((req, res) => res.end('{}'));
  const deadUrl = dead.url;
  await new Promise((resolve) => dead.server.close(resolve));
  const pdead = store.upsertProvider({ name: 'D', baseUrl: deadUrl });
  const rdead = await client.testProvider(pdead.id);
  assert.equal(rdead.ok, false);
  assert.ok(rdead.error);

  const missing = await client.testProvider('p_missing');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);

  const noUrl = store.upsertProvider({ name: 'NoUrl' });
  const rNoUrl = await client.testProvider(noUrl.id);
  assert.equal(rNoUrl.ok, false);
  assert.match(rNoUrl.error, /Base URL/);
  assert.deepEqual(await client.fetchRemoteModels('p_missing'), {
    ok: false,
    models: [],
    error: '提供商不存在: p_missing',
  });
});

test('provider-client: 超时可配置且不抛异常', async (t) => {
  const { server, url } = await startServer(() => {
    /* 永不响应 */
  });
  closeServer(t, server);
  const dir = tmpDir('pc-timeout');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const provider = store.upsertProvider({ name: 'Slow', baseUrl: url, apiKey: 'k' });
  const client = createProviderClient({ store, timeoutMs: 200 });

  const started = Date.now();
  const res = await client.testProvider(provider.id);
  const elapsed = Date.now() - started;
  assert.equal(res.ok, false);
  assert.match(res.error, /超时/);
  assert.ok(elapsed < 5000, `超时应快速返回，实际 ${elapsed}ms`);
});

test('provider-client: 响应正文超时不能伪装成无效响应格式', async (t) => {
  const dir = tmpDir('pc-body-timeout');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const provider = store.upsertProvider({ name: 'Slow body', baseUrl: 'https://api.example/v1', models: [{ id: 'slow-model' }] });
  const client = createProviderClient({
    store,
    timeoutMs: 25,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    }),
  });

  const connection = await client.testProvider(provider.id);
  assert.equal(connection.ok, false);
  assert.equal(connection.status, 200);
  assert.match(connection.error, /超时/);

  const generation = await client.testProviderModels(provider.id, ['slow-model']);
  assert.equal(generation.ok, false);
  assert.equal(generation.results[0].status, 200);
  assert.match(generation.results[0].error, /超时/);
  assert.doesNotMatch(generation.results[0].error, /有效的模型结果/);
});

test('provider-client: anthropic 用 x-api-key，自定义头可覆盖', async (t) => {
  let seen = null;
  const { server, url } = await startServer((req, res) => {
    seen = { ...req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
  });
  closeServer(t, server);
  const dir = tmpDir('pc-anth');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const client = createProviderClient({ store });

  const pA = store.upsertProvider({ name: 'A', baseUrl: url, apiKey: 'sk-ant', api: 'anthropic' });
  const remote = await client.fetchRemoteModels(pA.id);
  assert.equal(remote.ok, true);
  assert.deepEqual(remote.models, [{ id: 'claude-x', label: 'Claude X' }]);
  assert.equal(seen['x-api-key'], 'sk-ant');
  assert.equal(seen.authorization, undefined);
  assert.ok(seen['anthropic-version']);

  const pB = store.upsertProvider({
    name: 'B',
    baseUrl: url,
    apiKey: 'sk-1',
    headers: { authorization: 'Bearer custom-token' },
  });
  await client.testProvider(pB.id);
  assert.equal(seen.authorization, 'Bearer custom-token', '用户自定义头应覆盖默认头');
});

// ---------------------------------------------------------------- 6. 验收镜像（与 tools/verify-e2e.cjs 同形）

test('验收镜像: store + catalog + codex 全链路（隔离目录）', (t) => {
  const sandbox = tmpDir('e2e');
  cleanup(t, sandbox);
  const codexHome = path.join(sandbox, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const catalogPath = path.join(sandbox, 'model-catalog.json');

  const store = createStore({ configPath: path.join(sandbox, 'config.json') });
  store.upsertProvider({
    name: '梦幻API',
    baseUrl: 'https://mhapi.net',
    apiKey: 'sk-test-not-real',
    api: 'openai',
    headers: {},
    enabled: true,
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', enabled: true },
    ],
  });
  store.upsertProvider({
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    api: 'openai',
    headers: {},
    enabled: true,
    models: [{ id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', enabled: true }],
  });

  const catalog = createCatalog({ store, paths: { CATALOG_PATH: catalogPath, CODEX_HOME: codexHome } });
  const written = catalog.writeCatalog();
  assert.equal(written.count, 3);

  const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.ok(Array.isArray(raw.models));
  const missing = [];
  for (const m of raw.models) {
    for (const f of REQUIRED_CATALOG_FIELDS) if (!(f in m)) missing.push(`${m.slug}.${f}`);
    if (!m.base_instructions && !(m.model_mappings && m.model_messages)) missing.push(`${m.slug}.base_instructions`);
  }
  assert.deepEqual(missing, []);

  const models = [];
  for (const p of store.providers()) {
    for (const m of p.models) models.push({ slug: catalog.slugify(p.id, m.id), providerId: p.id, modelId: m.id });
  }
  for (const m of models) {
    const parsed = catalog.parseSlug(m.slug);
    assert.equal(parsed.providerId, m.providerId);
    assert.equal(parsed.modelId, m.modelId);
  }
  const tricky = catalog.parseSlug(catalog.slugify('p_abc', 'some__model'));
  assert.equal(tricky.modelId, 'some__model');

  const userToml = [
    '# user comment must survive',
    'model = "gpt-6-astra"',
    'model_provider = "custom"',
    '',
    '[model_providers.custom]',
    'name = "梦幻API"',
    'base_url = "https://mhapi.net"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'experimental_bearer_token = "sk-existing"',
    '',
    '[mcp_servers.codegraph]',
    'command = "codegraph"',
    'args = ["serve", "--mcp"]',
    '',
  ].join('\n');
  const codexConfigPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(codexConfigPath, userToml, 'utf8');

  const codex = createCodexConfig({
    store,
    catalog,
    paths: {
      CODEX_CONFIG_PATH: codexConfigPath,
      CODEX_HOME: codexHome,
      BACKUP_DIR: path.join(sandbox, 'backups'),
      CATALOG_PATH: catalogPath,
    },
  });

  codex.applyInjection({ enabled: true, catalogPath, defaultModel: models[0].slug });
  const injected = codex.readText();
  assert.match(injected, /^\s*model_provider\s*=\s*"gptplus"\s*$/m);
  assert.ok(injected.includes(catalogPath.replace(/\\/g, '\\\\')) || injected.includes(catalogPath));
  assert.match(injected, /\[model_providers\.gptplus\]/);
  assert.match(injected, /base_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"/);
  assert.match(injected, /\[model_providers\.custom\]/);
  assert.match(injected, /\[mcp_servers\.codegraph\]/);
  assert.ok(injected.includes('# user comment must survive'));

  codex.applyInjection({ enabled: false });
  const restored = codex.readText();
  assert.ok(!/\[model_providers\.gptplus\]/.test(restored));
  assert.ok(!/model_catalog_json/.test(restored));
  assert.match(restored, /^\s*model_provider\s*=\s*"custom"\s*$/m);
  assert.match(restored, /^\s*model\s*=\s*"gpt-6-astra"\s*$/m);
  assert.match(restored, /\[mcp_servers\.codegraph\]/);
  assert.equal(restored, userToml);

  const backups = fs.readdirSync(path.join(sandbox, 'backups')).filter((f) => f.startsWith('config.toml.'));
  assert.ok(backups.length > 0, '写入前必须产生备份');
});

// ============================================================
// 11. 回归：本轮排查修掉的缺陷
// ============================================================

test('base-url: 用户粘贴完整端点 URL 时不得重复拼接路径', () => {
  const { normalizeBaseUrl, stripEndpoint } = require(path.join(CORE, 'base-url.js'));
  const { joinApiUrl } = require(path.join(ROOT, 'src', 'core', 'gateway', 'responses.js'));

  assert.equal(normalizeBaseUrl('api.x.com/v1/chat/completions'), 'https://api.x.com/v1');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(stripEndpoint('https://x.com/v1/messages'), 'https://x.com/v1');
  assert.equal(joinApiUrl('https://x.com/v1/chat/completions', '/chat/completions'), 'https://x.com/v1/chat/completions');
  // /v1beta 这类带后缀的版本段不能被当成「没有版本」再补一次 /v1
  assert.equal(joinApiUrl('https://x.com/v1beta', '/chat/completions'), 'https://x.com/v1beta/chat/completions');

  const { sanitizeProviderInput } = require(path.join(CORE, 'ipc.js'));
  assert.equal(sanitizeProviderInput({ name: 'a', baseUrl: 'api.x.com/v1/responses' }).baseUrl, 'https://api.x.com/v1');
});

test('catalog: 推理档位与 store 的 reasoning 默认值一致', () => {
  const dir = tmpDir('catalog-reasoning');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.upsertProvider({
    id: 'p_aaaaaaaa',
    name: 'P',
    baseUrl: 'https://api.x.com/v1',
    models: [{ id: 'plain' }, { id: 'thinker', reasoning: true }],
  });
  const catalog = createCatalog({
    store,
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json'), CODEX_HOME: path.join(dir, 'codex') },
  });
  const entries = catalog.buildEntries();
  const plain = entries.find((e) => e.slug === 'P__plain').entry;
  const thinker = entries.find((e) => e.slug === 'P__thinker').entry;
  // store 里 reasoning 默认 false -> 基础三档；显式开启才有 xhigh/max/ultra
  assert.deepEqual(plain.supported_reasoning_levels.map((l) => l.effort), ['low', 'medium', 'high']);
  assert.equal(thinker.supported_reasoning_levels.length, 6);
  assert.ok(thinker.supported_reasoning_levels.some((l) => l.effort === 'ultra'));
});

test('codex-config: 状态文件丢失时不得删掉用户自己的 model_catalog_json', (t) => {
  const { codex, configPath } = makeCodex(t, {
    toml: ['# c', 'model = "official-gpt"', 'model_catalog_json = "D:\\mine\\catalog.json"', ''].join('\n'),
  });
  // 从未注入过（没有 inject-state），关闭注入必须什么都不删
  codex.applyInjection({ enabled: false });
  const after = fs.readFileSync(configPath, 'utf8');
  assert.ok(after.includes('D:\\mine\\catalog.json'), '用户自己的目录键必须保留');
  assert.ok(after.includes('model = "official-gpt"'), '用户自己的 model 键必须保留');
});

test('codex-config: 只收回我们补的那一个尾换行，用户注入期间加的保留', (t) => {
  const { codex, configPath } = makeCodex(t, { toml: 'model = "old"' }); // 无尾换行
  codex.applyInjection({ enabled: true, catalogPath: codex.configPath.replace('config.toml', 'cat.json'), defaultModel: 'p_aaaaaaaa__m' });
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8') + '\n', 'utf8');
  codex.applyInjection({ enabled: false });
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "old"\n');
});

test('ipc: Codex 写入失败必须回滚注入开关，不能留下「界面已注入、配置没写」', async () => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-rollback');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.upsertProvider({ id: 'p_aaaaaaaa', name: 'P', baseUrl: 'https://api.x.com/v1', models: [{ id: 'm1' }] });
  const channels = new Map();
  let lastWrite = null;
  const ctx = {
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json'), CODEX_HOME: dir },
    store,
    catalog: { slugify: (a, b) => `${a}__${b}`, buildEntries: () => [{ slug: 'p_aaaaaaaa__m1' }], writeCatalog: () => ({ path: 'x', count: 1, bytes: 1 }) },
    // 典型失败：Windows 上目标文件被客户端占用，atomicWrite 的 rename 抛 EPERM
    codex: { applyInjection: (o) => { if (o.enabled) throw new Error('EPERM: rename locked'); return { changed: false }; }, isInjected: () => false },
    providerClient: {},
    models: () => [{ slug: 'p_aaaaaaaa__m1', enabled: true }],
    status: () => ({ inject: store.get().inject, gateway: { enabled: true, running: true, port: 1, url: '', host: '127.0.0.1' }, codex: { lastWrite } }),
    gateway: { getState: () => ({ running: true, port: 1, url: '', host: '127.0.0.1' }), start: async () => ({ port: 1, url: '' }), stop: async () => {}, on: () => () => {} },
    log: () => {},
    syncInjection: () => { const r = ctx.codex.applyInjection({ enabled: true }); return { changed: r.changed, count: 1 }; },
    markWrite: (ok, error) => { lastWrite = { at: Date.now(), ok, ...(error ? { error } : {}) }; },
    onLogEvent: () => () => {},
    emitStatus: () => {},
  };
  registerIpc({ ipcMain: { handle: (ch, fn) => channels.set(ch, fn) }, shell: { openPath: async () => '' }, dialog: {}, ctx });

  await assert.rejects(() => channels.get('gptplus:inject:set')({}, { enabled: true }), /EPERM/);
  assert.equal(store.get().inject.enabled, false, '注入开关必须回滚');
  assert.equal(store.get().inject.catalogPath, null, 'catalogPath 不能残留');
  assert.equal(lastWrite.ok, false, 'lastWrite 必须记为失败');
});

test('ipc: 提供商保存或删除导致注入同步失败时必须回滚配置', async (t) => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-provider-rollback');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const provider = store.upsertProvider({
    id: 'p_aaaaaaaa',
    name: '保留渠道',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'm1' }],
  });
  store.update((draft) => {
    draft.inject.enabled = true;
    draft.inject.defaultModel = 'p_aaaaaaaa__m1';
  });
  const channels = new Map();
  const logEntries = [];
  const ctx = {
    paths: {},
    store,
    providerClient: {},
    models: () => [],
    status: () => ({ providers: store.get().providers.length }),
    gateway: { getState: () => ({ running: true }) },
    log: (entry) => logEntries.push(entry),
    syncInjection: () => { throw new Error('没有可注入的模型'); },
    onLogEvent: () => () => {},
  };
  registerIpc({ ipcMain: { handle: (channel, fn) => channels.set(channel, fn) }, shell: {}, dialog: {}, ctx });

  await assert.rejects(
    () => channels.get('gptplus:provider:save')({}, {
      ...provider,
      name: '不应保存',
      models: [{ id: 'm1', enabled: false }],
    }),
    /没有可注入的模型/,
  );
  assert.deepEqual(store.getProvider(provider.id), provider, '失败的保存不得改变提供商');
  assert.equal(logEntries.some((entry) => entry.msg?.includes('已保存提供商')), false);

  await assert.rejects(() => channels.get('gptplus:provider:delete')({}, provider.id), /没有可注入的模型/);
  assert.deepEqual(store.getProvider(provider.id), provider, '失败的删除不得移除提供商');
});

test('context: 注入同步时默认模型失效会回退到首个仍启用的模型', (t) => {
  const dir = tmpDir('context-default-model');
  cleanup(t, dir);
  const appHome = path.join(dir, 'app-home');
  const codexHome = path.join(dir, 'codex-home');
  const script = `
    const fs = require('node:fs');
    const { createContext } = require(${JSON.stringify(path.join(CORE, 'context.js'))});
    (async () => {
      const ctx = await createContext();
      ctx.store.upsertProvider({
        id: 'p_aaaaaaaa', name: 'P', baseUrl: 'https://api.example.com/v1',
        models: [{ id: 'm1' }, { id: 'm2' }],
      });
      const first = ctx.models()[0].slug;
      const expectedDefaultModel = ctx.models()[1].slug;
      ctx.store.update((draft) => {
        draft.inject.enabled = true;
        draft.inject.defaultModel = first;
      });
      ctx.syncInjection();
      ctx.store.update((draft) => { draft.providers[0].models[0].enabled = false; });
      ctx.syncInjection();
      const config = fs.readFileSync(ctx.paths.CODEX_CONFIG_PATH, 'utf8');
      process.stdout.write(JSON.stringify({
        defaultModel: ctx.store.get().inject.defaultModel,
        expectedDefaultModel,
        first,
        config,
      }));
    })().catch((err) => { console.error(err); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GPTPLUS_HOME: appHome, CODEX_HOME: codexHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.defaultModel, output.expectedDefaultModel);
  assert.match(output.config, new RegExp(`model = "${output.expectedDefaultModel}"`));
  assert.doesNotMatch(output.config, new RegExp(`model = "${output.first}"`));
});

test('ipc: 模型开关和排序会持久化并返回最新状态', async () => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-model-controls');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const p = store.upsertProvider({ id: 'p_aaaaaaaa', name: '渠道 A', models: [{ id: 'm1' }, { id: 'm2' }] });
  const channels = new Map();
  const ctx = {
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json') }, store,
    catalog: { slugify: (a, b) => a + '__' + b }, codex: { applyInjection: () => ({ changed: false }) }, providerClient: {},
    models: () => [], status: () => ({ inject: store.get().inject, gateway: { enabled: true, running: true } }),
    gateway: { getState: () => ({ running: true, port: 1, url: '', host: '127.0.0.1' }), start: async () => ({}), stop: async () => {}, on: () => () => {} },
    log: () => {}, syncInjection: () => ({ changed: false }), markWrite: () => {}, onLogEvent: () => () => {}, emitStatus: () => {},
  };
  registerIpc({ ipcMain: { handle: (ch, fn) => channels.set(ch, fn) }, shell: {}, dialog: {}, ctx });
  await channels.get('gptplus:model:enabled:set')({}, { providerId: p.id, modelId: 'm1', enabled: false });
  assert.equal(store.getProvider(p.id).models[0].enabled, false);
  await channels.get('gptplus:model:move')({}, { providerId: p.id, modelId: 'm2', direction: 'up' });
  assert.deepEqual(store.getProvider(p.id).models.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(store.get().modelOrder, [p.id + '::m2', p.id + '::m1']);
});

test('ipc: 主题偏好可持久化并广播最新状态', async (t) => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-theme');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const channels = new Map();
  const ctx = {
    paths: {},
    store,
    catalog: {},
    codex: {},
    providerClient: {},
    models: () => [],
    status: () => ({ theme: store.get().theme }),
    gateway: { getState: () => ({ running: false, port: 18120, url: '', host: '127.0.0.1' }) },
    log: () => {},
    onLogEvent: () => () => {},
    emitStatus: () => {},
  };
  registerIpc({ ipcMain: { handle: (ch, fn) => channels.set(ch, fn) }, shell: {}, dialog: {}, ctx });

  assert.equal(await channels.get('gptplus:theme:get')({}), 'dark');
  const status = await channels.get('gptplus:theme:set')({}, { theme: 'light' });
  assert.equal(status.theme, 'light');
  assert.equal(store.get().theme, 'light');
  await assert.rejects(() => channels.get('gptplus:theme:set')({}, { theme: 'sepia' }), /主题必须是/);
});

test('ipc: 网络代理模式可在系统代理与直连之间热切换', async (t) => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-network');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const channels = new Map();
  const modes = [];
  const ctx = {
    paths: {},
    store,
    network: { setMode: (mode) => modes.push(mode) },
    catalog: {},
    codex: {},
    providerClient: {},
    models: () => [],
    status: () => ({ network: store.get().network }),
    gateway: { getState: () => ({ running: false, port: 18120, url: '', host: '127.0.0.1' }) },
    log: () => {},
    onLogEvent: () => () => {},
    emitStatus: () => {},
  };
  registerIpc({ ipcMain: { handle: (ch, fn) => channels.set(ch, fn) }, shell: {}, dialog: {}, ctx });

  assert.deepEqual(await channels.get('gptplus:network:get')({}), { proxyMode: 'system' });
  const direct = await channels.get('gptplus:network:set')({}, { proxyMode: 'direct' });
  assert.deepEqual(direct.network, { proxyMode: 'direct' });
  assert.deepEqual(modes, ['direct']);
  await assert.rejects(() => channels.get('gptplus:network:set')({}, { proxyMode: 'bad' }), /代理模式/);
  assert.equal(store.get().network.proxyMode, 'direct');
});

test('ipc: 开机自启动读取与切换委托给系统登录项设置', async (t) => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-startup');
  cleanup(t, dir);
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const channels = new Map();
  let enabled = false;
  const startup = {
    get: () => ({ supported: true, enabled }),
    set: (next) => { enabled = !!next; return { supported: true, enabled }; },
  };
  const ctx = {
    paths: {},
    store,
    catalog: {},
    codex: {},
    providerClient: {},
    models: () => [],
    status: () => ({}),
    gateway: { getState: () => ({ running: false, port: 18120, url: '', host: '127.0.0.1' }) },
    log: () => {},
    onLogEvent: () => () => {},
    emitStatus: () => {},
  };
  registerIpc({ ipcMain: { handle: (ch, fn) => channels.set(ch, fn) }, shell: {}, dialog: {}, ctx, startup });

  assert.deepEqual(await channels.get('gptplus:startup:get')({}), { supported: true, enabled: false });
  assert.deepEqual(await channels.get('gptplus:startup:set')({}, { enabled: true }), { supported: true, enabled: true });
  assert.equal(enabled, true);
  await assert.rejects(
    () => channels.get('gptplus:startup:set')({}, { enabled: 'yes' }),
    /开机自启动开关参数无效/,
  );
});

test('ipc: 批量排序会过滤未知和重复项，补齐缺失模型并触发状态更新', async () => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-model-reorder');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const p1 = store.upsertProvider({ id: 'p_aaaaaaaa', name: '渠道 A', models: [{ id: 'm1' }, { id: 'm2' }] });
  const p2 = store.upsertProvider({ id: 'p_bbbbbbbb', name: '渠道 B', models: [{ id: 'm3' }, { id: 'm4' }] });
  const channels = new Map();
  let statusCalls = 0;
  const ctx = {
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json') }, store,
    catalog: { slugify: (a, b) => a + '__' + b }, codex: { applyInjection: () => ({ changed: false }) }, providerClient: {},
    models: () => [], status: () => ({ ok: true }),
    gateway: { getState: () => ({ running: true, port: 1, url: '', host: '127.0.0.1' }), start: async () => ({}), stop: async () => {}, on: () => () => {} },
    log: () => {}, syncInjection: () => ({ changed: false }), markWrite: () => {}, onLogEvent: () => () => {}, emitStatus: () => {},
  };
  registerIpc({
    ipcMain: { handle: (ch, fn) => channels.set(ch, fn) },
    shell: {}, dialog: {}, ctx,
    onStatus: () => { statusCalls += 1; },
  });

  const status = await channels.get('gptplus:model:reorder')({}, {
    orderKeys: [
      p2.id + '::m4',
      'unknown::model',
      p2.id + '::m4',
      p1.id + '::m2',
    ],
  });
  assert.deepEqual(store.get().modelOrder, [
    p2.id + '::m4',
    p1.id + '::m2',
    p1.id + '::m1',
    p2.id + '::m3',
  ]);
  assert.deepEqual(status, { ok: true });
  assert.equal(statusCalls, 1);
  await assert.rejects(
    () => channels.get('gptplus:model:reorder')({}, { orderKeys: 'not-an-array' }),
    /orderKeys.*数组/,
  );
});

test('ipc: 网关起不来时回滚 gateway.enabled，不留下「已启用但没人监听」', async () => {
  const { registerIpc } = require(path.join(CORE, 'ipc.js'));
  const dir = tmpDir('ipc-gw-rollback');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.update((d) => { d.gateway.enabled = false; });
  const channels = new Map();
  const ctx = {
    paths: { CATALOG_PATH: path.join(dir, 'catalog.json') },
    store,
    catalog: { slugify: (a, b) => `${a}__${b}` },
    codex: { applyInjection: () => ({ changed: false }) },
    providerClient: {},
    models: () => [],
    status: () => ({ inject: store.get().inject, gateway: { enabled: store.get().gateway.enabled, running: false } }),
    gateway: {
      getState: () => ({ running: false, port: 18120, url: '', host: '127.0.0.1' }),
      start: async () => { throw new Error('端口 18120 已被占用，请换一个端口'); },
      stop: async () => {},
      on: () => () => {},
    },
    log: () => {},
    syncInjection: () => ({ changed: false }),
    markWrite: () => {},
    onLogEvent: () => () => {},
    emitStatus: () => {},
  };
  registerIpc({ ipcMain: { handle: (ch, fn) => channels.set(ch, fn) }, shell: {}, dialog: {}, ctx });
  await assert.rejects(() => channels.get('gptplus:gateway:set')({}, { enabled: true }), /已被占用/);
  assert.equal(store.get().gateway.enabled, false);
});

// ---------------------------------------------------------------- 12. log-store：使用量日志持久化

test('log-store: 重启后回放历史，使用量页不再清零', (t) => {
  const dir = tmpDir('logstore');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');

  const first = createLogStore({ logPath });
  first.append({ at: 1000, level: 'info', msg: '完成 a__m -> m (12ms)', providerId: 'p_1', model: 'a__m', status: 200, ms: 12, tokens: { input_tokens: 30, output_tokens: 12, total_tokens: 42 } });
  first.append({ at: 2000, level: 'info', msg: '已保存提供商「梦幻API」', providerId: 'p_1' });

  // 模拟退出重进：新实例只能看到磁盘
  const second = createLogStore({ logPath });
  const restored = second.load();
  assert.equal(restored.length, 2, '重启后应看到上一次会话的全部日志');
  assert.deepEqual(restored.map((r) => r.at), [1000, 2000], '按写入顺序（时间升序）回放');
  assert.equal(restored[0].tokens.total_tokens, 42, 'token 用量字段必须完整回来');
  assert.equal(restored[0].status, 200);
  assert.deepEqual(second.all(), restored, 'load() 之后 all() 与之一致');
});

test('log-store: 崩溃留下的半行只丢这一行，不丢整份历史', (t) => {
  const dir = tmpDir('logstore-partial');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');
  fs.writeFileSync(
    logPath,
    [JSON.stringify({ at: 1, msg: 'ok' }), '{"at":2,"msg":"这条被截', JSON.stringify({ at: 3, msg: 'ok' }), ''].join('\n'),
    'utf8',
  );

  assert.deepEqual(createLogStore({ logPath }).load().map((r) => r.at), [1, 3], '半行丢弃，其余保留');
});

test('log-store: 缺 at 的行与数组行不参与统计，直接丢弃', (t) => {
  const dir = tmpDir('logstore-junk');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');
  fs.writeFileSync(logPath, ['[1,2,3]', '"a string"', JSON.stringify({ msg: '没有 at' }), 'null', JSON.stringify({ at: 7, msg: 'ok' })].join('\n') + '\n', 'utf8');

  const rows = createLogStore({ logPath }).load();
  assert.deepEqual(rows.map((r) => r.at), [7]);
});

test('log-store: 文件缺失或为空时返回空历史且不抛', (t) => {
  const dir = tmpDir('logstore-missing');
  cleanup(t, dir);
  const store = createLogStore({ logPath: path.join(dir, 'nope.log') });
  assert.deepEqual(store.load(), []);
  store.append({ at: 5, msg: 'x' });
  assert.equal(createLogStore({ logPath: path.join(dir, 'nope.log') }).load().length, 1, 'append 立即可被下一个实例读到');
});

test('log-store: 默认环形上限远大于旧的 200 条', () => {
  assert.ok(Number.isFinite(LOG_RING_SIZE) && LOG_RING_SIZE > 200, `上限应被放大，实际 ${LOG_RING_SIZE}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-logstore-default-'));
  try {
    const store = createLogStore({ logPath: path.join(dir, 'gateway.log') });
    assert.equal(store.maxEntries, LOG_RING_SIZE, '未显式传参时按 LOG_RING_SIZE 裁剪');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('log-store: 超出条目上限时丢最旧，磁盘同步压缩且不留临时文件', (t) => {
  const dir = tmpDir('logstore-compact');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');
  const seed = [];
  for (let i = 1; i <= 10; i += 1) seed.push(JSON.stringify({ at: i, msg: `m${i}` }));
  fs.writeFileSync(logPath, seed.join('\n') + '\n', 'utf8');

  const rows = createLogStore({ logPath, maxEntries: 4 }).load();
  assert.deepEqual(rows.map((r) => r.at), [7, 8, 9, 10], '内存保留最近 4 条');
  const onDisk = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(onDisk.map((r) => r.at), [7, 8, 9, 10], '磁盘同步裁剪，文件不会无限增长');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, '压缩不留临时文件');
});

test('log-store: 未超上限时不重写文件，逐字节保持不变', (t) => {
  const dir = tmpDir('logstore-untouched');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');
  const text = [JSON.stringify({ at: 1, msg: 'a' }), JSON.stringify({ at: 2, msg: 'b' })].join('\n') + '\n';
  fs.writeFileSync(logPath, text, 'utf8');
  const before = fs.statSync(logPath).mtimeMs;

  assert.equal(createLogStore({ logPath, maxEntries: 50, maxBytes: 4096 }).load().length, 2);
  assert.equal(fs.readFileSync(logPath, 'utf8'), text, '无需压缩时不得改写磁盘文件');
  assert.equal(fs.statSync(logPath).mtimeMs, before, '连 mtime 都不该变');
});

test('log-store: 超大文件只读尾部，首个残缺行被丢弃后仍完成压缩', (t) => {
  const dir = tmpDir('logstore-huge');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');
  const seed = [];
  for (let i = 1; i <= 20; i += 1) seed.push(JSON.stringify({ at: i, msg: `m${i}`, pad: 'x'.repeat(40) }));
  fs.writeFileSync(logPath, seed.join('\n') + '\n', 'utf8');
  assert.ok(fs.statSync(logPath).size > 200, '构造出超过 maxBytes 的文件');

  const rows = createLogStore({ logPath, maxEntries: 50, maxBytes: 200 }).load();
  assert.ok(rows.length >= 2 && rows.length < 20, `只应回放尾部，实际 ${rows.length} 条`);
  assert.ok(rows.every((r) => Number.isFinite(r.at)), '尾部首个残缺行不能混进来');
  assert.deepEqual(rows.map((r) => r.at), rows.map((r) => r.at).sort((a, b) => a - b), '时间升序');
  assert.equal(rows[rows.length - 1].at, 20, '最新一条必须在');
  assert.ok(fs.statSync(logPath).size <= 200 + 512, '压缩后文件回到阈值附近');
});

test('usage-store: keeps one terminal record per request and survives partial lines', (t) => {
  const dir = tmpDir('usage-store');
  cleanup(t, dir);
  const usagePath = path.join(dir, 'usage.jsonl');
  const store = createUsageStore({ usagePath });
  const intermediate = {
    at: 1,
    requestId: 'req_same',
    providerId: 'p_1',
    model: 'p_1__m',
    status: 0,
    msg: '开始请求 p_1__m',
  };
  const terminal = {
    at: 2,
    requestId: 'req_same',
    providerId: 'p_1',
    model: 'p_1__m',
    status: 200,
    final: true,
    tokens: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  };

  store.importLogs([intermediate, terminal, { ...terminal, at: 3 }]);
  assert.equal(store.all().length, 1, '中间事件和同 requestId 的重复终结事件不能增加请求数');
  assert.equal(store.all()[0].requestId, 'req_same');
  assert.equal(store.all()[0].tokens.total_tokens, 13);

  fs.appendFileSync(usagePath, '{"at":4,"requestId":"broken', 'utf8');
  fs.appendFileSync(usagePath, `\n${JSON.stringify({ ...terminal, requestId: 'req_other', at: 5, status: 502 })}\n`, 'utf8');
  const restored = createUsageStore({ usagePath });
  const rows = restored.load();
  assert.deepEqual(rows.map((row) => row.requestId), ['req_same', 'req_other']);
  assert.equal(rows[1].status, 502, '半行损坏不能影响后续终结记录');
});

test('usage-store: 清空细数据时保留按天 Token 趋势，全部清空时连趋势一起删除', (t) => {
  const dir = tmpDir('usage-clear');
  cleanup(t, dir);
  const usagePath = path.join(dir, 'usage.jsonl');
  const trendPath = path.join(dir, 'usage-trend.json');
  const store = createUsageStore({ usagePath, trendPath });
  store.append({
    at: new Date('2026-10-17T10:00:00').getTime(),
    requestId: 'clear_req_1',
    providerId: 'p_1',
    model: 'p_1__m',
    status: 200,
    final: true,
    tokens: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  });
  assert.equal(store.all().length, 1);
  assert.deepEqual(store.trend(), [{ day: '2026-10-17', tokens: 13, requests: 1 }]);

  store.clear({ preserveTrend: true });
  assert.deepEqual(store.all(), [], '细数据清空后请求明细应为空');
  assert.deepEqual(store.trend(), [{ day: '2026-10-17', tokens: 13, requests: 1 }], '细数据清空应保留趋势');
  assert.equal(fs.readFileSync(usagePath, 'utf8'), '', '细数据文件应被清空');

  store.clear();
  assert.deepEqual(store.trend(), [], '全部清空应删除趋势');
  assert.equal(fs.existsSync(trendPath), false, '全部清空不应留下趋势文件');
});

test('context: 重启后从磁盘回放日志环，使用量统计不再清零（真子进程，隔离 GPTPLUS_HOME）', (t) => {
  const dir = tmpDir('context-replay');
  cleanup(t, dir);
  const logPath = path.join(dir, 'gateway.log');
  const entry = (at, extra) => JSON.stringify({ at, level: 'info', ...extra });
  const yesterday = Date.now() - 26 * 60 * 60 * 1000;
  fs.writeFileSync(
    logPath,
    [
      entry(yesterday, { msg: '完成 a__m -> m (120ms)', providerId: 'p_1', providerName: 'D', model: 'a__m', status: 200, ms: 120, tokens: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }),
      entry(yesterday + 1, { msg: '流式转发失败', providerId: 'p_1', model: 'a__m', status: 502, ms: 50 }),
      '{"at":999,"msg":"进程被强杀留下的半条',
    ].join('\n') + '\n',
    'utf8',
  );

  const probe = `
    const { createContext } = require(${JSON.stringify(path.join(CORE, 'context.js'))});
    createContext({}).then((c) => {
      const rows = c.logs();
      process.stdout.write(JSON.stringify({
        n: rows.length,
        ats: rows.map((r) => r.at),
        done: rows.filter((e) => e.tokens && e.status === 200).length,
        tokens: rows.reduce((s, e) => s + Number(e.tokens && e.tokens.total_tokens || 0), 0),
      }));
    });
  `;
  const run = () => spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, GPTPLUS_HOME: dir, CODEX_HOME: path.join(dir, 'codex') },
  });

  const first = run();
  assert.equal(first.status, 0, `子进程应正常退出：${first.stderr}`);
  const out = JSON.parse(first.stdout);
  assert.equal(out.n, 2, '两条历史记录被回放（残缺行丢弃，而不是整份历史作废）');
  assert.equal(out.done, 1, '使用量页的「已完成请求」跨重启保留');
  assert.equal(out.tokens, 120, 'Token 合计跨重启保留');
  assert.deepEqual(out.ats, [...out.ats].sort((a, b) => a - b), '时间升序');

  const second = run();
  assert.equal(JSON.parse(second.stdout).n, 2, '重复启动不会把历史越滚越多（无重复回放）');
});
