'use strict';
// 真机验证：用真实客户端（codex-cli，与 ChatGPT 桌面端同源）把一次对话请求打到本地网关。
// 用法: node tools/live-client-test.cjs [gatewayPort]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const ROOT = path.resolve(__dirname, '..');
const gwPort = Number(process.argv[2] || 18121);

const home = path.join(ROOT, 'probe', 'live');
const catalogPath = path.join(home, 'catalog.json');
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });

// 直接用应用模块生成目录，不依赖以前探针留下的文件。
const { createStore } = require('../src/core/store.js');
const { createCatalog } = require('../src/core/catalog.js');
const store = createStore({ configPath: path.join(home, 'config.json') });
store.upsertProvider({
  name: 'Proto', baseUrl: 'http://127.0.0.1:18122', api: 'responses', enabled: true,
  models: [{ id: 'gpt-6.1-sol', label: 'Proto Model (test)', enabled: true }],
});
const proto = createCatalog({
  store, paths: { CATALOG_PATH: catalogPath, CODEX_HOME: home },
}).buildCatalogJson();
proto.models[0].slug = 'p_test__gpt-6.1-sol';
proto.models[0].display_name = 'Proto Model (test)';
fs.writeFileSync(catalogPath, JSON.stringify(proto, null, 2), 'utf8');

const toml = [
  'model = "p_test__gpt-6.1-sol"',
  'model_provider = "gptplus"',
  `model_catalog_json = "${catalogPath.replace(/\\/g, '\\\\')}"`,
  '',
  '[model_providers.gptplus]',
  'name = "gpt++ Gateway"',
  `base_url = "http://127.0.0.1:${gwPort}/v1"`,
  'wire_api = "responses"',
  'requires_openai_auth = false',
  'experimental_bearer_token = "gptplus-local-token"',
  '',
  '[windows]',
  'sandbox = "elevated"',
  '',
].join('\n');
fs.writeFileSync(path.join(home, 'config.toml'), toml, 'utf8');
console.log('isolated CODEX_HOME: ' + home);

// 1) 启动原型网关 + 假上游
const protoGw = spawn(process.execPath, [path.join(ROOT, 'tools', 'proto-gateway.cjs'), String(gwPort), '18122'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
protoGw.stdout.on('data', (d) => process.stdout.write('[proto] ' + d.toString()));
protoGw.stderr.on('data', (d) => process.stderr.write('[proto:err] ' + d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(900);

  const health = await fetch(`http://127.0.0.1:${gwPort}/healthz`).then((r) => r.json()).catch((e) => ({ err: e.message }));
  console.log('healthz:', JSON.stringify(health));
  if (health.err) { protoGw.kill(); process.exit(1); }

  // 2) 用真实客户端发起一次非交互请求
  const outFile = path.join(home, 'last-message.txt');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--color', 'never',
    '-C', home,
    '-o', outFile,
    'Reply with exactly: PING-OK',
  ];
  console.log('\nrunning: codex ' + args.join(' ') + '\n');

  const child = spawn(CODEX, args, {
    env: { ...process.env, CODEX_HOME: home },
    cwd: home,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); process.stdout.write(d); });
  child.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });

  const code = await new Promise((resolve) => child.on('close', resolve));
  console.log('\nclient exit code: ' + code);

  const last = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '(no -o output)';
  console.log('last message: ' + JSON.stringify(last));

  protoGw.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2500);
    protoGw.on('close', () => { clearTimeout(t); resolve(); });
  });
  await sleep(200);

  const ok = code === 0 && /HELLO FROM GATEWAY/.test(last);
  console.log('\nRESULT: ' + (ok ? 'PASS — 真实客户端成功经由本地网关拿到自定义模型的回复' : 'FAIL'));
  if (!ok) {
    console.log('stdout tail:\n' + stdout.slice(-3000));
    console.log('stderr tail:\n' + stderr.slice(-2000));
  }
  process.exit(ok ? 0 : 1);
})();
