'use strict';
// 决定性验证：用 App 真实写出的配置，跑目标客户端的 model/list（= 模型选择器读取的接口）。
// 全程在隔离 CODEX_HOME 下进行，不触碰用户的 ~/.codex。
// 用法: node tools/verify-picker.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const ROOT = path.resolve(__dirname, '..');
const sandbox = path.join(ROOT, 'probe', 'picker');
const codexHome = path.join(sandbox, 'codex-home');
const catalogPath = path.join(sandbox, 'model-catalog.json');
const gatewayPort = 18130;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -- ' + detail : ''));
}

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(codexHome, { recursive: true });

// ---------- 1) 用真实模块生成配置（模拟 App 的行为，路径全部指向沙箱）
const store = require(path.join(ROOT, 'src/core/store.js')).createStore({
  configPath: path.join(sandbox, 'config.json'),
});
const catalog = require(path.join(ROOT, 'src/core/catalog.js')).createCatalog({
  store,
  paths: { CATALOG_PATH: catalogPath, CODEX_HOME: codexHome },
});

store.upsertProvider({
  name: '梦幻API', baseUrl: 'https://mhapi.net', apiKey: 'sk-sandbox-not-real', api: 'openai',
  headers: {}, enabled: true,
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', enabled: true },
  ],
});
store.upsertProvider({
  name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', api: 'openai',
  headers: {}, enabled: true,
  models: [{ id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', enabled: true }],
});
// 关键：把网关端口改成非默认值，验证 base_url 真的跟随 store 而不是硬编码
store.update((d) => { d.gateway.port = gatewayPort; });
// 用户已有配置：带注释、已有 [model_providers.custom] 段、末尾还有 [windows] 段（陷阱源）
const userToml = [
  '# 机甲配置，勿删',
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
  '[windows]',
  'sandbox = "elevated"',
  '',
].join('\n');
const codexConfigPath = path.join(codexHome, 'config.toml');
fs.writeFileSync(codexConfigPath, userToml, 'utf8');

const codex = require(path.join(ROOT, 'src/core/codex-config.js')).createCodexConfig({
  store, catalog,
  paths: {
    CODEX_CONFIG_PATH: codexConfigPath,
    CODEX_HOME: codexHome,
    BACKUP_DIR: path.join(sandbox, 'backups'),
    CATALOG_PATH: catalogPath,
  },
});

const written = catalog.writeCatalog();
const slugs = [];
for (const p of store.providers()) for (const m of p.models) slugs.push(catalog.slugForProvider(p, m.id, store.providers()));
codex.applyInjection({ enabled: true, catalogPath: written.path, defaultModel: slugs[0] });

const text = fs.readFileSync(codexConfigPath, 'utf8');
console.log('--- generated config.toml ---\n' + text + '\n');

// 关键陷阱：model_catalog_json / model_provider / model 必须是顶层键，且在任何 [table] 之前
const firstTable = text.search(/^\s*\[/m);
const keyPos = (k) => text.search(new RegExp('^\\s*' + k + '\\s*=', 'm'));
const before = (k) => {
  const p = keyPos(k);
  return p !== -1 && (firstTable === -1 || p < firstTable);
};
check('model 是顶层键且在首个 [table] 之前', before('model'), 'pos=' + keyPos('model') + ' firstTable=' + firstTable);
check('model_provider 是顶层键且在首个 [table] 之前', before('model_provider'));
check('model_catalog_json 是顶层键且在首个 [table] 之前（否则会被当成 windows.* 静默忽略）', before('model_catalog_json'));
check('model_catalog_json 指向生成的目录', text.includes(written.path.replace(/\\/g, '\\\\')) || text.includes(written.path));
check('用户 [windows] 段仍在末尾且未被污染',
  /\[windows\]\s*\nsandbox = "elevated"/.test(text) && !/\[windows\][\s\S]*model_catalog_json/.test(text));
check('base_url 指向本地网关端口', new RegExp('base_url\\s*=\\s*"http://127\\.0\\.0\\.1:' + gatewayPort + '/v1"').test(text),
  'gatewayPort=' + gatewayPort);
check('保留用户原有 [model_providers.custom]', /\[model_providers\.custom\]/.test(text));
check('保留用户注释', text.includes('# 机甲配置，勿删'));

// ---------- 2) 目录条目：supported_in_api 必须为 true，否则条目会被直接丢弃
const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
check('目录条目 supported_in_api 全为 true（false 会被客户端整条丢弃）',
  cat.models.every((m) => m.supported_in_api === true));
check('目录条目 visibility=list', cat.models.every((m) => m.visibility === 'list'));
check('目录条目模型数量与 provider 配置一致', cat.models.length === slugs.length,
  cat.models.length + ' vs ' + slugs.length);

// ---------- 3) 决定性一步：跑客户端的 model/list（模型选择器读的就是它）
function modelList(includeHidden) {
  return new Promise((resolve) => {
    const child = spawn(CODEX, ['app-server', '--stdio'], {
      cwd: codexHome, env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let buf = '';
    const seen = new Map();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { child.kill(); } catch {} resolve(v); } };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id) seen.set(m.id, m);
        if (seen.has(2)) done(seen.get(2));
      }
    });
    child.on('error', () => done(null));
    setTimeout(() => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'verify', title: 'verify', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden, cursor: null, limit: 100 } }) + '\n');
    }, 400);
    setTimeout(() => done(null), 30000);
  });
}

(async () => {
  const hiddenResp = await modelList(true);
  const dataAll = hiddenResp?.result?.data ?? [];
  console.log('\n--- model/list (includeHidden=true) 返回 ' + dataAll.length + ' 条 ---');
  for (const m of dataAll) {
    console.log('   ' + String(m.model).padEnd(32) + ' hidden=' + String(m.hidden).padEnd(5) +
      ' default=' + String(m.isDefault).padEnd(5) + ' display=' + JSON.stringify(m.displayName));
  }

  check('model/list 有响应（客户端接受了我们的配置）', !!hiddenResp && !hiddenResp.error,
    hiddenResp?.error ? JSON.stringify(hiddenResp.error).slice(0, 200) : 'ok');

  const allModels = dataAll.map((m) => m.model);
  const allShown = slugs.every((s) => allModels.includes(s));
  check('三个自定义模型全部出现在 model/list', allShown,
    'expected=' + slugs.join(',') + ' | actual=' + allModels.join(','));

  const visibleResp = await modelList(false);
  const dataVisible = visibleResp?.result?.data ?? [];
  const visible = dataVisible.map((m) => m.model);
  console.log('\n--- model/list (includeHidden=false, 即选择器可见) 返回 ' + dataVisible.length + ' 条 ---');
  for (const m of dataVisible) console.log('   ' + String(m.model).padEnd(32) + ' display=' + JSON.stringify(m.displayName));
  check('自定义模型对选择器可见（hidden=false）', slugs.every((s) => visible.includes(s)),
    'visible=' + visible.join(','));
  check('内置 GPT 模型已被替换（注入是整体替换而非追加）',
    !visible.some((m) => /gpt-6-astra|gpt-6-sol|gpt-5\.6/.test(m)),
    'visible=' + visible.join(','));

  const first = dataAll.find((m) => m.model === slugs[0]);
  check('显示名包含提供商名', !!first && String(first.displayName).includes('梦幻API'),
    first ? first.displayName : 'not found');

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
  console.log('PICKER OK — App 写出的配置会让自定义模型出现在模型选择器的数据源里');
})();
