// Reproduce the user's REAL current picker state inside an isolated CODEX_HOME copy.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const REAL = 'C:\\Users\\ailuo\\.codex';
const BASE = 'C:\\ailuo_own\\gpt++\\tools\\realhome';

function copyReal(name, extraToml, catalog, opts) {
  opts = opts || {};
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  let toml = fs.readFileSync(path.join(REAL, 'config.toml'), 'utf8');
  if (extraToml) toml = opts.prepend ? extraToml + toml : toml + extraToml;
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  if (fs.existsSync(path.join(REAL, 'models_cache.json'))) {
    fs.copyFileSync(path.join(REAL, 'models_cache.json'), path.join(dir, 'models_cache.json'));
  }
  if (catalog) fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  return dir;
}

function ask(homeDir) {
  return new Promise((resolve) => {
    const child = spawn(CODEX, ['app-server', '--stdio'], { cwd: homeDir, env: { ...process.env, CODEX_HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    }, 300);
    setTimeout(finish, 60000);
  });
}

async function run(label, dir) {
  const { seen, err } = await ask(dir);
  console.log(`\n##### ${label}`);
  const e = (err || '').trim();
  if (e) console.log('  stderr: ' + e.split('\n').slice(0, 3).join(' | ').slice(0, 400));
  for (const id of [2, 3]) {
    const data = seen.get(id)?.result?.data ?? [];
    console.log(`  includeHidden=${id === 2} -> ${data.length}: ` + data.map((m) => `${m.model}[hidden=${m.hidden},def=${m.isDefault}]`).join(' '));
  }
}
function entry(slug, extra) {
  return Object.assign({ slug, support_verbosity: true, truncation_policy: { mode: 'tokens', limit: 10000 }, display_name: slug, supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'medium', description: 'Balanced' }, { effort: 'high', description: 'Deep' }], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, model_messages: { instructions_template: 'You are Codex.' }, experimental_supported_tools: [] }, extra || {});
}

(async () => {
  await run('R0 user real config + real models_cache.json (UNCHANGED)', copyReal('r0'));

  const catPath = 'C:\\ailuo_own\\gpt++\\tools\\realhome\\r1\\catalog.json';
  await run('R1 real config + model_catalog_json (gpt-6.1-sol visible, claude hidden)', copyReal('r1',
    `\nmodel_catalog_json = ${JSON.stringify(catPath)}\n`,
    { models: [entry('gpt-6.1-sol', { display_name: 'GPT-6.1 Sol (relay)', description: 'Third-party model via relay.', priority: 1 }), entry('claude-sonnet-4.5', { display_name: 'Claude Sonnet 4.5', description: 'Third-party model via relay.', priority: 2 })] }));

  const catTrim = { models: [entry('gpt-6.1-sol', { display_name: 'GPT-6.1 Sol (relay)', description: 'Third-party model via relay.', priority: 1 }), entry('claude-hidden', { display_name: 'Claude (hidden)', visibility: 'hide', priority: 2 })] };
  const catPath2 = 'C:\\ailuo_own\\gpt++\\tools\\realhome\\r2\\catalog.json';
  await run('R2 catalog key placed at TOP of config.toml', copyReal('r2',
    `model_catalog_json = ${JSON.stringify(catPath2)}\n`,
    catTrim, { prepend: true }));

  // does the models_cache.json get overwritten / does it matter once a catalog is set?
  console.log('\ncache after R1 run exists:', fs.existsSync('C:\\ailuo_own\\gpt++\\tools\\realhome\\r1\\models_cache.json'));
})();
