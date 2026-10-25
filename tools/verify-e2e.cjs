'use strict';
// 端到端验证：证明「App 生成的目录 + codex 配置」能让目标客户端解析出自定义模型。
// 用法: node tools/verify-e2e.cjs [--home <隔离测试目录>]
//
// 关键点：全程在隔离的临时 CODEX_HOME 下操作，绝不触碰用户真实的 ~/.codex/config.toml。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CODEX = process.env.CODEX_CLI_PATH
  || 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const ROOT = path.resolve(__dirname, '..');

const argIdx = process.argv.indexOf('--home');
const sandbox = argIdx !== -1 ? process.argv[argIdx + 1] : path.join(ROOT, 'probe', 'e2e');
const codexHome = path.join(sandbox, 'codex-home');
const catalogPath = path.join(sandbox, 'model-catalog.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

console.log('gpt++ end-to-end verification');
console.log('sandbox: ' + sandbox + '\n');

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(codexHome, { recursive: true });

// ---------------------------------------------------------------- 1. catalog
const { createStore } = require(path.join(ROOT, 'src/core/store.js'));
const { createCatalog } = require(path.join(ROOT, 'src/core/catalog.js'));
const pathsShim = { CATALOG_PATH: catalogPath };

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

const catalog = createCatalog({ store, paths: pathsShim });
const written = catalog.writeCatalog();
console.log('catalog -> ' + written.path + ' (' + written.count + ' models, ' + written.bytes + ' bytes)\n');

check('目录文件已生成', fs.existsSync(catalogPath), written.count + ' models');
const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
check('目录顶层为 { models: [...] }', Array.isArray(raw.models), 'models=' + raw.models.length);

const REQUIRED = [
  'slug', 'display_name', 'description', 'default_reasoning_level',
  'supported_reasoning_levels', 'shell_type', 'visibility', 'supported_in_api',
  'priority', 'support_verbosity', 'truncation_policy', 'experimental_supported_tools',
];
const missing = [];
for (const m of raw.models) {
  for (const f of REQUIRED) if (!(f in m)) missing.push(m.slug + '.' + f);
  if (!m.base_instructions && !(m.model_messages && m.model_messages.instructions_template)) {
    missing.push(m.slug + '.base_instructions');
  }
}
check('每个条目都有 codex 必填字段', missing.length === 0, missing.join(', ') || 'all present');

// ---------------------------------------------------------------- 2. slug
const models = [];
for (const p of store.providers()) {
  for (const m of p.models) models.push({ slug: catalog.slugForProvider(p, m.id, store.providers()), providerId: p.id, modelId: m.id });
}
const roundTrip = models.every((m) => {
  const parsed = catalog.parseSlug(m.slug);
  return parsed && parsed.providerId === m.slug.slice(0, m.slug.indexOf('__')) && parsed.modelId === m.modelId;
});
check('slug 反查往返一致', roundTrip, models.map((m) => m.slug).join(' | '));

// 边界：modelId 自身含 '__'
const tricky = catalog.parseSlug(catalog.slugify('p_abc', 'some__model'));
check('模型 id 含 __ 时按第一个分隔符解析', tricky && tricky.modelId === 'some__model', JSON.stringify(tricky));

// ---------------------------------------------------------------- 3. config
const toml = [
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
fs.writeFileSync(codexConfigPath, toml, 'utf8');

const { createCodexConfig } = require(path.join(ROOT, 'src/core/codex-config.js'));
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
const injected = fs.readFileSync(codexConfigPath, 'utf8');
check('注入后写入 model_provider = "gptplus"', /^\s*model_provider\s*=\s*"gptplus"\s*$/m.test(injected));
check('注入后写入 model_catalog_json', injected.includes(catalogPath.replace(/\\/g, '\\\\')) || injected.includes(catalogPath));
check('注入后写入 [model_providers.gptplus] 段', /\[model_providers\.gptplus\]/.test(injected));
check('注入后 base_url 指向本地网关', /base_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"/.test(injected));
check('用户原有 model_providers.custom 段保留', /\[model_providers\.custom\]/.test(injected));
check('用户原有 mcp_servers 段保留', /\[mcp_servers\.codegraph\]/.test(injected));
check('用户注释保留', injected.includes('# user comment must survive'));

// ---------------------------------------------------------------- 4. codex
const env = { ...process.env, CODEX_HOME: codexHome };
function debugModels() {
  const r = spawnSync(CODEX, ['debug', 'models'], {
    env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

const first = debugModels();
if (!first.out.startsWith('{')) {
  check('codex 接受生成的目录 JSON', false, (first.err || first.out).slice(0, 300));
} else {
  const data = JSON.parse(first.out);
  check('codex 接受生成的目录 JSON', true, 'models=' + data.models.length);
  const slugs = data.models.map((m) => m.slug);
  const expected = models.map((m) => m.slug);
  const allShown = expected.every((s) => slugs.includes(s));
  check('自定义模型全部出现在客户端模型清单', allShown,
    'expected=' + expected.join(',') + '  actual=' + slugs.join(','));
  const firstEntry = data.models.find((m) => m.slug === expected[0]);
  check('显示名正确', !!firstEntry && firstEntry.display_name.includes('梦幻API'),
    firstEntry ? firstEntry.display_name : 'not found');
  check('visibility=list（会显示在选择器中）',
    data.models.filter((m) => m.visibility === 'list').length === expected.length,
    data.models.map((m) => m.slug + ':' + m.visibility).join(', '));
  fs.writeFileSync(path.join(sandbox, 'codex-models.json'), JSON.stringify(data, null, 2), 'utf8');
  console.log('\n  client model list:');
  for (const m of data.models) console.log('    ' + m.slug.padEnd(30) + ' | ' + m.display_name);
}

// ---------------------------------------------------------------- 5. restore
codex.applyInjection({ enabled: false });
const restored = fs.readFileSync(codexConfigPath, 'utf8');
check('还原后不再包含 gptplus 段', !/\[model_providers\.gptplus\]/.test(restored));
check('还原后不再包含 model_catalog_json', !/model_catalog_json/.test(restored));
check('还原后原 model_provider = "custom" 回归', /^\s*model_provider\s*=\s*"custom"\s*$/m.test(restored));
check('还原后 mcp_servers 段仍在', /\[mcp_servers\.codegraph\]/.test(restored));
const backups = fs.existsSync(path.join(sandbox, 'backups'))
  ? fs.readdirSync(path.join(sandbox, 'backups')) : [];
check('写入前产生备份', backups.length > 0, backups.join(', '));

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
console.log('E2E OK — 自定义模型可被目标客户端解析并渲染');
