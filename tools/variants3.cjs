// Round 3: defaults resolution + enum acceptance for shell_type / visibility / truncation_policy.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const BASE = 'C:\\ailuo_own\\gpt++\\tools\\variants';

const TRUNC = { mode: 'tokens', limit: 10000 };
const LEVELS = [
  { effort: 'low', description: 'Fast' },
  { effort: 'medium', description: 'Balanced' },
  { effort: 'high', description: 'Deep' },
];
function entry(slug, extra) {
  return Object.assign(
    {
      slug,
      support_verbosity: true,
      truncation_policy: TRUNC,
      display_name: slug,
      supported_reasoning_levels: LEVELS,
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      model_messages: { instructions_template: 'You are a helpful coding agent.' },
      experimental_supported_tools: [],
    },
    extra || {}
  );
}
function configText(catalogAbs, model) {
  const lines = [];
  if (model !== null) lines.push(`model = ${JSON.stringify(model)}`);
  lines.push('model_provider = "relay"');
  lines.push(`model_catalog_json = ${JSON.stringify(catalogAbs)}`);
  lines.push('', '[model_providers.relay]', 'name = "Relay"', 'base_url = "https://relay.invalid/v1"', 'wire_api = "responses"', 'requires_openai_auth = false');
  return lines.join('\n') + '\n';
}
function setup(name, catalog, model) {
  const home = path.join(BASE, name);
  fs.mkdirSync(home, { recursive: true });
  const catAbs = path.join(home, 'catalog.json');
  fs.writeFileSync(catAbs, JSON.stringify(catalog, null, 2));
  fs.writeFileSync(path.join(home, 'config.toml'), configText(catAbs, model));
  return home;
}
function ask(home) {
  return new Promise((resolve) => {
    const child = spawn(CODEX, ['app-server', '--stdio'], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', err = ''; const seen = new Map(); let done = false;
    const finish = () => { if (done) return; done = true; try { child.kill(); } catch {} resolve({ seen, err }); };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8'); let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id) seen.set(m.id, m);
        if (seen.has(2) && seen.has(3)) return finish();
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { err += 'SPAWN ERROR ' + String(e); finish(); });
    setTimeout(() => {
      for (const m of [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } },
        { jsonrpc: '2.0', method: 'initialized', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: true, cursor: null, limit: 100 } },
        { jsonrpc: '2.0', id: 3, method: 'model/list', params: { includeHidden: false, cursor: null, limit: 100 } },
      ]) child.stdin.write(JSON.stringify(m) + '\n');
    }, 250);
    setTimeout(finish, 60000);
  });
}
async function run(label, home) {
  const { seen, err } = await ask(home);
  console.log(`\n##### ${label}`);
  const e = (err || '').trim();
  if (e) console.log('  stderr: ' + e.split('\n').slice(0, 2).join(' / ').slice(0, 240));
  const data = seen.get(2)?.result?.data ?? [];
  if (seen.get(2)?.error) console.log('  RPC ERROR ' + JSON.stringify(seen.get(2).error).slice(0, 240));
  console.log(`  includeHidden=true -> ${data.length}`);
  for (const mo of data) console.log(`    ${String(mo.model).padEnd(20)} hidden=${String(mo.hidden).padEnd(5)} default=${String(mo.isDefault).padEnd(5)} display=${JSON.stringify(mo.displayName)}`);
}

(async () => {
  await run('V13 config.model selects the default (middle entry)',
    setup('v13', { models: [entry('aaa-model', { priority: 1 }), entry('claude-sonnet-4.5', { priority: 2 }), entry('zzz-model', { priority: 3 })] }, 'claude-sonnet-4.5'));

  await run('V14 shell_type = unified_exec',
    setup('v14', { models: [entry('unified-exec-model', { shell_type: 'unified_exec' })] }, 'unified-exec-model'));

  await run('V15 shell_type = bogus',
    setup('v15', { models: [entry('bogus-shell', { shell_type: 'bogus' })] }, 'bogus-shell'));

  await run('V16 visibility = hidden (unknown variant)',
    setup('v16', { models: [entry('bogus-vis', { visibility: 'hidden' })] }, 'bogus-vis'));

  await run('V17 no model key in config',
    setup('v17', { models: [entry('first-model'), entry('second-model', { priority: 5 })] }, null));

  await run('V18 truncation_policy minimal',
    setup('v18', { models: [entry('trunc-model', { truncation_policy: { mode: 'tokens', limit: 1 } })] }, 'trunc-model'));

  await run('V19 exact user-style recipe: two custom models, hide+list',
    setup('v19', {
      models: [
        entry('claude-sonnet-4.5', { display_name: 'Claude Sonnet 4.5', description: 'Relay-served Claude.', priority: 1, default_reasoning_level: 'medium' }),
        entry('gpt-6.1-sol', { display_name: 'GPT-6.1 Sol', description: 'Relay-served GPT.', priority: 2 }),
      ],
    }, 'claude-sonnet-4.5'));

  await run('V20 supported_reasoning_levels = [] (empty)',
    setup('v20', { models: [entry('no-efforts', { supported_reasoning_levels: [] })] }, 'no-efforts'));
})();
