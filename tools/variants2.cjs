// Variant matrix for the model catalog: build a CODEX_HOME per variant, ask the real
// app-server for model/list (includeHidden true/false), print the resulting picker payload.
// Usage: node variants2.cjs
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const BASE = 'C:\\ailuo_own\\gpt++\\tools\\variants';
const OUTDIR = 'C:\\ailuo_own\\gpt++\\tools\\out';

const TRUNC = { mode: 'tokens', limit: 10000 };
const LEVELS = [
  { effort: 'low', description: 'Fast' },
  { effort: 'medium', description: 'Balanced' },
  { effort: 'high', description: 'Deep' },
];
const MSGS = { instructions_template: 'You are a helpful coding agent.' };

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
      model_messages: MSGS,
      experimental_supported_tools: [],
    },
    extra || {}
  );
}

function configText(catalogAbs, opts) {
  opts = opts || {};
  const lines = [`model = ${JSON.stringify(opts.model || 'claude-sonnet-4.5')}`];
  if (opts.provider !== false) lines.push('model_provider = "relay"');
  if (catalogAbs) lines.push(`model_catalog_json = ${JSON.stringify(catalogAbs)}`);
  if (opts.provider !== false) {
    lines.push('', '[model_providers.relay]', 'name = "Relay"', 'base_url = "https://relay.invalid/v1"', 'wire_api = "responses"', 'requires_openai_auth = false');
  }
  return lines.join('\n') + '\n';
}

function setup(name, catalog, opts) {
  const home = path.join(BASE, name);
  fs.mkdirSync(home, { recursive: true });
  let catAbs = null;
  if (catalog) {
    catAbs = path.join(home, 'catalog.json');
    fs.writeFileSync(catAbs, JSON.stringify(catalog, null, 2));
  }
  fs.writeFileSync(path.join(home, 'config.toml'), configText(catAbs, opts));
  return home;
}

function ask(home, label) {
  return new Promise((resolve) => {
    const child = spawn(CODEX, ['app-server', '--stdio'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '', err = '';
    const seen = new Map();
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { child.kill(); } catch {}
      resolve({ seen, err });
    };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
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
    setTimeout(finish, 90000);
  });
}

async function run(label, home) {
  const { seen, err } = await ask(home, label);
  console.log(`\n########## ${label} ##########`);
  const e = (err || '').trim();
  if (e) console.log('stderr: ' + e.split('\n').slice(0, 2).join(' / ').slice(0, 300));
  for (const id of [2, 3]) {
    const m = seen.get(id);
    const data = m?.result?.data ?? [];
    console.log(`includeHidden=${id === 2} -> ${data.length} models`);
    if (m?.error) console.log('   ERROR ' + JSON.stringify(m.error).slice(0, 300));
    for (const mo of data) {
      console.log(`   ${String(mo.model).padEnd(26)} hidden=${String(mo.hidden).padEnd(5)} default=${String(mo.isDefault).padEnd(5)} display=${JSON.stringify(mo.displayName)} efforts=[${(mo.supportedReasoningEfforts || []).map((x) => x.reasoningEffort).join(',')}] defaultEffort=${mo.defaultReasoningEffort} desc=${JSON.stringify((mo.description || '').slice(0, 40))}`);
    }
  }
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });

  await run('V2 supported_in_api=false', setup('v2', { models: [entry('api-off-model', { supported_in_api: false })] }));

  await run('V3 custom provider, NO model_catalog_json', setup('v3', null));

  await run('V4 model_provider omitted + catalog', setup('v4', { models: [entry('claude-sonnet-4.5'), entry('hidden-relay-model', { visibility: 'hide' })] }, { provider: false }));

  await run('V5 base_instructions instead of model_messages', setup('v5', { models: [Object.assign((() => { const e = entry('bare-model'); delete e.model_messages; return e; })(), { base_instructions: 'You are Codex.' })] }));

  await run('V6 instructions_template = ""', setup('v6', { models: [entry('empty-instr', { model_messages: { instructions_template: '' } })] }));

  await run('V8 priority order (99,1,50)', setup('v8', { models: [entry('m-99', { priority: 99 }), entry('m-1', { priority: 1 }), entry('m-50', { priority: 50 })] }));

  await run('V9 config model not in catalog', setup('v9', { models: [entry('other-model')] }));

  await run('V10 description + default_reasoning_level present', setup('v10', { models: [entry('pretty-model', { display_name: 'Pretty Model', description: 'A friendly description.', default_reasoning_level: 'high' })] }));

  await run('V11 empty models array', setup('v11', { models: [] }));

  await run('V12 catalog with top-level extra key', setup('v12', { models: [entry('extra-key-model')], version: 3, note: 'hi' }));
})();
