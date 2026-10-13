'use strict';
// 终局验证：真实客户端 → 成品网关(src/core/gateway) → 假上游提供商。
// 三种场景：纯文本、工具调用往返、鉴权失败。
// 全程隔离在 probe/final 下，不碰用户的 ~/.codex 与 ~/.gptplus。
// 用法: node tools/verify-final.cjs
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const ROOT = path.resolve(__dirname, '..');
const sandbox = path.join(ROOT, 'probe', 'final');
const codexHome = path.join(sandbox, 'codex-home');
const catalogPath = path.join(sandbox, 'model-catalog.json');
const GW_PORT = 18140;
const UP_PORT = 18141;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -- ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(codexHome, { recursive: true });

// ---------------------------------------------------------------- 假上游提供商
const upstreamSeen = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    upstreamSeen.push({ url: req.url, auth: req.headers.authorization || null, body: parsed });
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    const wantsTool = JSON.stringify(msgs).includes('USE_TOOL');

    const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const chunk = (delta, finish) => sse({
      id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: parsed.model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    if (wantsTool && !hasToolResult) {
      // 第一轮：要求执行工具
      chunk({ role: 'assistant', content: '' });
      chunk({ tool_calls: [{ index: 0, id: 'call_up_1', type: 'function', function: { name: 'exec_command', arguments: '' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ cmd: 'echo TOOL-OK' }) } }] });
      chunk({}, 'tool_calls');
    } else if (hasToolResult) {
      // 第二轮：工具已执行，给出最终答复
      for (const c of ['TOOL', '-DONE']) chunk({ content: c });
      chunk({}, 'stop');
    } else {
      for (const c of ['FINAL', '-OK']) chunk({ content: c });
      chunk({}, 'stop');
    }
    sse({ id: 'chatcmpl-x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ---------------------------------------------------------------- 真实 store / catalog / 配置
const { createStore } = require(path.join(ROOT, 'src/core/store.js'));
const { createCatalog } = require(path.join(ROOT, 'src/core/catalog.js'));
const { createCodexConfig } = require(path.join(ROOT, 'src/core/codex-config.js'));
const { createGateway } = require(path.join(ROOT, 'src/core/gateway/server.js'));

const store = createStore({ configPath: path.join(sandbox, 'config.json') });
store.update((d) => { d.gateway.enabled = true; d.gateway.port = GW_PORT; d.gateway.host = '127.0.0.1'; });
store.upsertProvider({
  name: '假上游', baseUrl: `http://127.0.0.1:${UP_PORT}/v1`, apiKey: 'sk-upstream-secret',
  api: 'openai', headers: {}, enabled: true,
  models: [{ id: 'demo-model', label: 'Demo Model', enabled: true, reasoning: false }],
});

const pathsShim = {
  CATALOG_PATH: catalogPath,
  CODEX_HOME: codexHome,
  CODEX_CONFIG_PATH: path.join(codexHome, 'config.toml'),
  BACKUP_DIR: path.join(sandbox, 'backups'),
};
const catalog = createCatalog({ store, paths: pathsShim });
const codex = createCodexConfig({ store, catalog, paths: pathsShim });

const slug = catalog.slugForProvider(store.providers()[0], 'demo-model', store.providers());
const written = catalog.writeCatalog();
codex.applyInjection({ enabled: true, catalogPath: written.path, defaultModel: slug, port: GW_PORT, host: '127.0.0.1' });

const logs = [];
const gateway = createGateway({ store, paths: pathsShim, log: (e) => logs.push(e) });

function runCodex(prompt) {
  return new Promise((resolve) => {
    const child = spawn(CODEX, [
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
      '-C', codexHome, prompt,
    ], {
      cwd: codexHome, env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdin.end();
    let out = '', err = '';
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => finish({ code, out, err }));
    child.on('error', (error) => finish({ code: -1, out, err: err + '\n' + error.message }));
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: -1, out, err: err + '\n[TIMEOUT]' });
    }, 120000);
  });
}

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  const started = await gateway.start({ port: GW_PORT, host: '127.0.0.1', token: store.get().gateway.token });
  console.log('gateway: ' + started.url + '   upstream: http://127.0.0.1:' + UP_PORT + '/v1');
  console.log('slug: ' + slug + '\n');

  // ---- 1) 网关自检
  const probe = await gateway.probe();
  check('gateway.probe() ok', probe.ok, JSON.stringify(probe));

  const modelsResp = await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`, {
    headers: { authorization: 'Bearer ' + store.get().gateway.token },
  }).then((r) => r.json());
  check('GET /v1/models 返回 slug 列表', (modelsResp.data || []).some((m) => m.id === slug),
    JSON.stringify(modelsResp.data || modelsResp));

  const noAuth = await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`);
  check('缺少 token 时 /v1/models 返回 401', noAuth.status === 401, 'status=' + noAuth.status);

  // ---- 2) 真实客户端：纯文本
  const r1 = await runCodex('Reply with exactly: FINAL-OK');
  check('真实客户端经成品网关拿到纯文本回复（exit 0 且输出正确）',
    r1.code === 0 && /FINAL-OK/.test(r1.out), 'exit=' + r1.code + ' out=' + JSON.stringify(r1.out.trim().slice(-120)));
  if (r1.code !== 0) console.log('  stderr tail: ' + r1.err.slice(-600));

  const up1 = upstreamSeen[0];
  check('上游收到的是 /chat/completions', !!up1 && /chat\/completions$/.test(up1.url), up1 ? up1.url : 'none');
  check('上游收到的是真实 modelId（不是 slug）', !!up1 && up1.body.model === 'demo-model',
    up1 ? String(up1.body.model) : 'none');
  check('上游收到提供商自己的 API Key', !!up1 && up1.auth === 'Bearer sk-upstream-secret',
    up1 ? String(up1.auth) : 'none');
  check('instructions 被转成 system/developer 消息', !!up1 && (up1.body.messages || []).some((m) => m.role === 'system' || m.role === 'developer'),
    up1 ? (up1.body.messages || []).map((m) => m.role).join(',') : 'none');

  // ---- 3) 真实客户端：工具调用往返
  const before = upstreamSeen.length;
  const r2 = await runCodex('USE_TOOL please run echo TOOL-OK');
  const rounds = upstreamSeen.slice(before);
  check('工具调用：客户端执行工具并回灌第二轮请求', rounds.length >= 2, 'upstream rounds=' + rounds.length);
  check('工具调用：网关把 function_call 转成了上游 tool_calls',
    rounds.length >= 1 && JSON.stringify(rounds[0].body).includes('tool_calls'),
    rounds.length ? JSON.stringify(rounds[0].body).slice(0, 200) : 'none');
  check('工具调用：第二轮把工具结果以 role=tool 回灌',
    rounds.length >= 2 && (rounds[1].body.messages || []).some((m) => m.role === 'tool'),
    rounds.length >= 2 ? (rounds[1].body.messages || []).map((m) => m.role).join(',') : 'none');
  check('工具调用：客户端最终拿到 TOOL-DONE', /TOOL-DONE/.test(r2.out),
    'exit=' + r2.code + ' out=' + JSON.stringify(r2.out.trim().slice(-160)));

  // ---- 4) 未知模型
  const unknown = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + store.get().gateway.token },
    body: JSON.stringify({ model: 'nope__nope', stream: true, input: [] }),
  });
  const unknownBody = await unknown.json().catch(() => ({}));
  check('未知模型返回 404 + invalid_request_error',
    unknown.status === 404 && unknownBody?.error?.type === 'invalid_request_error',
    'status=' + unknown.status + ' body=' + JSON.stringify(unknownBody).slice(0, 120));

  // ---- 5) 环形日志
  check('网关记录了请求日志', logs.some((l) => l.model || l.providerId),
    logs.slice(-3).map((l) => JSON.stringify(l)).join(' | ').slice(0, 300));

  // ---- 6) 还原
  // 注意：本场景里 config.toml 是注入时才创建的（用户原本没有这个文件），
  // 因此关闭注入后文件会被删除——这是正确行为，不是失败。
  codex.applyInjection({ enabled: false });
  const cfgExists = fs.existsSync(pathsShim.CODEX_CONFIG_PATH);
  const restored = cfgExists ? fs.readFileSync(pathsShim.CODEX_CONFIG_PATH, 'utf8') : '';
  check('关闭注入后配置里不再有 gptplus 段',
    !/model_providers\.gptplus/.test(restored),
    cfgExists ? 'config.toml 仍存在且已清理' : 'config.toml 是注入时新建的，已随还原删除');
  check('关闭注入后不再有 model_catalog_json', !/model_catalog_json/.test(restored));

  await gateway.stop();
  upstream.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
  console.log('FINAL E2E OK — 真实客户端经成品网关完成纯文本与工具调用往返');
})();
