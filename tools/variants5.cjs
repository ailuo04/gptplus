// Does model_providers.<id>.model_catalog_url feed the picker catalog? Serve a catalog on
// localhost and point a provider at it.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const BASE = 'C:\\ailuo_own\\gpt++\\tools\\variants5';
fs.mkdirSync(BASE, { recursive: true });
const PORT = 8791;

const TRUNC = { mode: 'tokens', limit: 10000 };
function entry(slug, extra) {
  return Object.assign(
    { slug, support_verbosity: true, truncation_policy: TRUNC, display_name: slug, supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, model_messages: { instructions_template: 'You are a helpful coding agent.' }, experimental_supported_tools: [] },
    extra || {}
  );
}

const server = http.createServer((req, res) => {
  console.log('  [server] request: ' + req.method + ' ' + req.url + ' auth=' + (req.headers.authorization || 'none'));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ models: [entry('url-served-model', { display_name: 'URL Served Model' }), entry('url-hidden-model', { visibility: 'hide' })] }));
});

function mk(name, toml) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  return dir;
}

function run(label, dir) {
  const r = spawnSync(CODEX, ['debug', 'models'], { cwd: dir, env: { ...process.env, CODEX_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  console.log(`\n##### ${label} (exit ${r.status})`);
  const err = (r.stderr || '').trim();
  if (err) console.log('  stderr: ' + err.split('\n').slice(0, 2).join(' | ').slice(0, 300));
  try {
    const j = JSON.parse(r.stdout);
    console.log('  models: ' + (j.models || []).map((m) => `${m.slug}(vis=${m.visibility})`).join(', '));
  } catch { console.log('  stdout not JSON: ' + r.stdout.slice(0, 200)); }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('server listening on ' + PORT);

  const dirT1 = mk('t1', `model = "url-served-model"\nmodel_provider = "relay"\n\n[model_providers.relay]\nname = "Relay"\nbase_url = "http://127.0.0.1:${PORT}/v1"\nmodel_catalog_url = "http://127.0.0.1:${PORT}/catalog.json"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  run('T1 provider model_catalog_url only (no model_catalog_json)', dirT1);

  const catFile = path.join(BASE, 't2-local.json');
  fs.writeFileSync(catFile, JSON.stringify({ models: [entry('local-file-model')] }));
  const dirT2 = mk('t2', `model = "local-file-model"\nmodel_provider = "relay"\nmodel_catalog_json = ${JSON.stringify(catFile)}\n\n[model_providers.relay]\nname = "Relay"\nbase_url = "http://127.0.0.1:${PORT}/v1"\nmodel_catalog_url = "http://127.0.0.1:${PORT}/catalog.json"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  run('T2 model_catalog_json + model_catalog_url', dirT2);

  setTimeout(() => { server.close(); process.exit(0); }, 500);
});
