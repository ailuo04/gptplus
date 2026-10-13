// Drive the real codex app-server over stdio JSON-RPC and capture the `model/list`
// response -- i.e. exactly what the desktop model picker receives.
// Usage: node appserver-probe.cjs <codexHome> [label]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const home = process.argv[2];
const label = process.argv[3] || 'run';
const reqFile = path.join(home, 'requests.jsonl');
const outFile = `C:\\ailuo_own\\gpt++\\tools\\out\\appserver-${label}.jsonl`;
const errFile = `C:\\ailuo_own\\gpt++\\tools\\out\\appserver-${label}.err`;

const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', title: 'probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } },
  { jsonrpc: '2.0', method: 'initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: true, cursor: null, limit: 100 } },
  { jsonrpc: '2.0', id: 3, method: 'model/list', params: { includeHidden: false, cursor: null, limit: 100 } },
];
fs.writeFileSync(reqFile, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');

const inFd = fs.openSync(reqFile, 'r');
const outFd = fs.openSync(outFile, 'w');
const errFd = fs.openSync(errFile, 'w');
const r = spawnSync(CODEX, ['app-server', '--stdio'], {
  cwd: home,
  env: { ...process.env, CODEX_HOME: home },
  stdio: [inFd, outFd, errFd],
  timeout: 90000,
});
fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
console.log('exit=', r.status, r.error ? String(r.error) : '');

const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  if (m.id === 2 || m.id === 3) {
    const incl = m.id === 2;
    const data = m.result?.data ?? [];
    console.log(`\n=== model/list includeHidden=${incl} -> ${data.length} models ===`);
    for (const mo of data) {
      console.log(`  model=${mo.model}  displayName=${JSON.stringify(mo.displayName)}  hidden=${mo.hidden}  id=${mo.id}  default=${mo.isDefault}  efforts=[${(mo.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).join(',')}]  defaultEffort=${mo.defaultReasoningEffort}`);
    }
    if (!incl) fs.writeFileSync(`C:/ailuo_own/gpt++/tools/out/modellist-${label}.json`, JSON.stringify(m.result, null, 2));
  }
}
const err = fs.readFileSync(errFile, 'utf8');
if (err.trim()) console.log('\n--- stderr ---\n' + err.slice(0, 2000));
