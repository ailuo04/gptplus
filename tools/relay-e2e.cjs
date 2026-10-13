// End-to-end: does a custom provider + experimental_bearer_token actually reach base_url,
// and which model slug is sent? Local stub server logs the request head and returns 400.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const HOME = 'C:\\ailuo_own\\gpt++\\tools\\relayhome';
const PORT = 8792;
fs.mkdirSync(HOME, { recursive: true });

const catPath = path.join(HOME, 'catalog.json');
fs.writeFileSync(catPath, JSON.stringify({
  models: [{
    slug: 'claude-sonnet-4.5',
    display_name: 'Claude Sonnet 4.5 (relay)',
    description: 'Third-party relay model.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast' },
      { effort: 'medium', description: 'Balanced' },
      { effort: 'high', description: 'Deep' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    model_messages: { instructions_template: 'You are a helpful coding agent.' },
    experimental_supported_tools: [],
  }],
}, null, 2));

fs.writeFileSync(path.join(HOME, 'config.toml'), `model = "claude-sonnet-4.5"
model_provider = "relay"
model_catalog_json = ${JSON.stringify(catPath)}
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.relay]
name = "Relay"
base_url = "http://127.0.0.1:${PORT}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "sk-relay-test-token"
`);

let captured = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d.toString('utf8'); });
  req.on('end', () => {
    if (!captured) {
      captured = { method: req.method, url: req.url, headers: req.headers, bodyHead: body.slice(0, 600) };
      console.log('=== relay request captured ===');
      console.log('method/url: ' + req.method + ' ' + req.url);
      console.log('authorization: ' + (req.headers.authorization || '(none)'));
      console.log('user-agent: ' + (req.headers['user-agent'] || '(none)'));
      console.log('body head: ' + body.slice(0, 300).replace(/\s+/g, ' '));
      const mm = body.match(/"model"\s*:\s*"([^"]+)"/);
      console.log('model in body: ' + (mm ? mm[1] : '(not found)'));
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stub server', type: 'invalid_request_error' } }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('stub relay on ' + PORT);
  const child = spawn(CODEX, ['exec', '--skip-git-repo-check', '--json', 'say hi'], {
    cwd: HOME,
    env: { ...process.env, CODEX_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });
  child.on('error', (e) => { console.log('spawn error ' + e); });
  setTimeout(() => { try { child.kill(); } catch {} }, 30000);
  child.on('exit', (code) => {
    console.log('\ncodex exec exit=' + code);
    console.log('--- stdout head ---\n' + out.slice(0, 700));
    console.log('--- stderr head ---\n' + err.slice(0, 900));
    server.close();
    process.exit(0);
  });
});
