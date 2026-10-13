// Round 4: remaining schema questions (visibility "none", unknown keys, wrong top-level shape,
// reasoning-effort value freedom, truncation_policy mode).
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const BASE = 'C:\\ailuo_own\\gpt++\\tools\\variants4';
fs.mkdirSync(BASE, { recursive: true });

const TRUNC = { mode: 'tokens', limit: 10000 };
const LEVELS = [
  { effort: 'low', description: 'Fast' },
  { effort: 'medium', description: 'Balanced' },
  { effort: 'high', description: 'Deep' },
];
function entry(slug, extra) {
  return Object.assign(
    { slug, support_verbosity: true, truncation_policy: TRUNC, display_name: slug, supported_reasoning_levels: LEVELS, shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, model_messages: { instructions_template: 'You are a helpful coding agent.' }, experimental_supported_tools: [] },
    extra || {}
  );
}
function home(name, catalogRaw, model) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), typeof catalogRaw === 'string' ? catalogRaw : JSON.stringify(catalogRaw, null, 2));
  fs.writeFileSync(path.join(dir, 'config.toml'), `model = ${JSON.stringify(model || 'claude-sonnet-4.5')}\nmodel_provider = "relay"\nmodel_catalog_json = ${JSON.stringify(path.join(dir, 'catalog.json'))}\n\n[model_providers.relay]\nname = "Relay"\nbase_url = "https://relay.invalid/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  return dir;
}
function parseCheck(name, catalogRaw, model) {
  const dir = home(name, catalogRaw, model);
  const r = spawnSync(CODEX, ['debug', 'models'], { cwd: dir, env: { ...process.env, CODEX_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const ok = r.status === 0;
  const msg = (r.stderr || '').trim().split('\n').pop() || '';
  console.log(`${name.padEnd(34)} parse=${ok ? 'OK  ' : 'FAIL'}  ${msg.replace(/^.*as JSON: /, '').slice(0, 150)}`);
}
function ask(homeDir) {
  return new Promise((resolve) => {
    const child = spawn(CODEX, ['app-server', '--stdio'], { cwd: homeDir, env: { ...process.env, CODEX_HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = ''; const seen = new Map(); let done = false;
    const finish = () => { if (done) return; done = true; try { child.kill(); } catch {} resolve(seen); };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8'); let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id) seen.set(m.id, m);
        if (seen.has(2) && seen.has(3)) return finish();
      }
    });
    child.on('error', finish);
    setTimeout(() => {
      for (const m of [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'p', version: '1' } } },
        { jsonrpc: '2.0', method: 'initialized', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: true, cursor: null, limit: 100 } },
        { jsonrpc: '2.0', id: 3, method: 'model/list', params: { includeHidden: false, cursor: null, limit: 100 } },
      ]) child.stdin.write(JSON.stringify(m) + '\n');
    }, 250);
    setTimeout(finish, 60000);
  });
}

(async () => {
  console.log('--- parse acceptance ---');
  parseCheck('W2 extra unknown key', { models: [entry('extra-key', { totally_bogus_key: 42 })] });
  parseCheck('W3 top-level JSON array', JSON.stringify([entry('arr-model')]));
  parseCheck('W4 effort persistent + max', { models: [entry('eff-model', { supported_reasoning_levels: [{ effort: 'none', description: 'n' }, { effort: 'persistent', description: 'p' }, { effort: 'max', description: 'm' }], default_reasoning_level: 'max' })] });
  parseCheck('W5 effort bogus', { models: [entry('bogus-effort', { supported_reasoning_levels: [{ effort: 'bogus', description: 'b' }] })] });
  parseCheck('W6 truncation mode bogus', { models: [entry('bogus-trunc', { truncation_policy: { mode: 'bogus', limit: 10 } })] });
  parseCheck('w7-data-key', { data: [entry('data-model')] });
  parseCheck('w8-bytes', { models: [entry('bytes-trunc', { truncation_policy: { mode: 'bytes', limit: 10 } })] });

  console.log('\n--- app-server: visibility = none ---');
  const h = home('w1', { models: [entry('vis-none', { visibility: 'none' }), entry('vis-list', { visibility: 'list' })] });
  const seen = await ask(h);
  for (const id of [2, 3]) {
    const data = seen.get(id)?.result?.data ?? [];
    console.log(`includeHidden=${id === 2} -> ${data.length}: ` + data.map((m) => `${m.model}(hidden=${m.hidden})`).join(', '));
  }
})();

