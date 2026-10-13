// Build a set of variant CODEX_HOMEs and interrogate the real app-server `model/list`
// for each, to determine visibility/hidden semantics and the minimal catalog entry.
// Usage: node variants.cjs
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

const CONFIG = (catalogFile, providerExtra) => `model_provider = "relay"
model = "claude-sonnet-4.5"
${catalogFile ? `model_catalog_json = "${catalogFile.replace(/\\/g, '\\\\')}"\n` : ''}
[model_providers.relay]
name = "Relay"
base_url = "https://relay.invalid/v1"
wire_api = "responses"
requires_openai_auth = false
${providerExtra || ''}`;

function setup(name, catalog, config) {
  const home = path.join(BASE, name);
  fs.mkdirSync(home, { recursive: true });
  if (catalog) fs.writeFileSync(path.join(home, 'catalog.json'), JSON.stringify(catalog, null, 2));
  fs.writeFileSync(path.join(home, 'config.toml'), config);
  return home;
}

function modelList(home, label) {
  const reqFile = path.join(home, 'requests.jsonl');
  const outFile = path.join(OUTDIR, `ml-${label}.jsonl`);
  const errFile = path.join(OUTDIR, `ml-${label}.err`);
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } },
    { jsonrpc: '2.0', method: 'initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: true, cursor: null, limit: 100 } },
    { jsonrpc: '2.0', id: 3, method: 'model/list', params: { includeHidden: false, cursor: null, limit: 100 } },
  ];
  fs.writeFileSync(reqFile, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const inFd = fs.openSync(reqFile, 'r');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  spawnSync(CODEX, ['app-server', '--stdio'], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: [inFd, outFd, errFd], timeout: 120000 });
  fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
  const res = {};
  for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2) res.all = m.result?.data ?? [];
    if (m.id === 3) res.visible = m.result?.data ?? [];
  }
  const err = fs.readFileSync(errFile, 'utf8').trim();
  return { res, err };
}

function report(label, { res, err }) {
  console.log(`\n########## ${label} ##########`);
  if (err) console.log('stderr: ' + err.split('\n').slice(0, 3).join(' / ').slice(0, 400));
  const all = res.all || [];
  const vis = new Set((res.visible || []).map((m) => m.model));
  console.log(`includeHidden=true -> ${all.length} models ; includeHidden=false -> ${vis.size} models`);
  for (const m of all) {
    console.log(`  ${m.model.padEnd(24)} hidden=${String(m.hidden).padEnd(5)} visibleInDefaultList=${vis.has(m.model)} default=${m.isDefault} efforts=[${(m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).join(',')}] defaultEffort=${m.defaultReasoningEffort} displayName=${JSON.stringify(m.displayName)}`);
  }
  return { all, vis };
}

// ---------- V1: visibility list vs hide, both in one catalog ----------
{
  const cat = { models: [entry('claude-sonnet-4.5', { priority: 1 }), entry('hidden-relay-model', { visibility: 'hide', priority: 2 })] };
  const home = setup('v1', cat, CONFIG(path.join(BASE, 'v1', 'catalog.json')));
  report('V1 minimal entry: visibility=list vs hide', modelList(home, 'v1'));
}

// ---------- V2: supported_in_api=false ----------
{
  const cat = { models: [entry('api-off-model', { supported_in_api: false })] };
  const home = setup('v2', cat, CONFIG(path.join(BASE, 'v2', 'catalog.json')));
  report('V2 supported_in_api=false', modelList(home, 'v2'));
}

// ---------- V3: no model_catalog_json (custom provider only) ----------
{
  const home = setup('v3', null, CONFIG(null));
  report('V3 custom provider, NO model_catalog_json', modelList(home, 'v3'));
}

// ---------- V4: catalog without model_catalog_json but bundled default ----------
{
  const cat = { models: [entry('claude-sonnet-4.5'), entry('hidden-relay-model', { visibility: 'hide' })] };
  const home = setup('v4', cat, CONFIG(path.join(BASE, 'v4', 'catalog.json')));
  report('V4 same catalog but model_provider omitted', modelList(home, 'v4'));
}

// ---------- V5: top-level base_instructions instead of model_messages ----------
{
  const e = entry('bare-model');
  delete e.model_messages;
  e.base_instructions = 'You are Codex.';
  const cat = { models: [e] };
  const home = setup('v5', cat, CONFIG(path.join(BASE, 'v5', 'catalog.json')));
  report('V5 base_instructions instead of model_messages', modelList(home, 'v5'));
}

// ---------- V6: instructions_template empty string ----------
{
  const cat = { models: [entry('empty-instr', { model_messages: { instructions_template: '' } })] };
  const home = setup('v6', cat, CONFIG(path.join(BASE, 'v6', 'catalog.json')));
  report('V6 model_messages.instructions_template = ""', modelList(home, 'v6'));
}

// ---------- V7: only model_messages {} (no instructions_template) ----------
{
  const cat = { models: [entry('no-instr', { model_messages: {} })] };
  const home = setup('v7', cat, CONFIG(path.join(BASE, 'v7', 'catalog.json')));
  report('V7 model_messages = {}', modelList(home, 'v7'));
}
