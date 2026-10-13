// Async app-server driver: keeps stdin open until all responses arrive.
// Usage: node appserver-drive.cjs <codexHome> <label>
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const home = process.argv[2];
const label = process.argv[3] || 'drive';
const outFile = `C:\\ailuo_own\\gpt++\\tools\\out\\drive-${label}.jsonl`;

const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', title: 'probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } },
  { jsonrpc: '2.0', method: 'initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: true, cursor: null, limit: 100 } },
  { jsonrpc: '2.0', id: 3, method: 'model/list', params: { includeHidden: false, cursor: null, limit: 100 } },
];

const child = spawn(CODEX, ['app-server', '--stdio'], {
  cwd: home,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buf = '';
const seen = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    fs.appendFileSync(outFile, line + '\n');
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id) seen.set(m.id, m);
    if (seen.has(2) && seen.has(3)) finish();
  }
});
child.stderr.on('data', (d) => fs.appendFileSync(outFile.replace('.jsonl', '.err'), d));
child.on('error', (e) => { console.log('SPAWN ERROR:', String(e)); process.exit(3); });

let done = false;
function finish() {
  if (done) return;
  done = true;
  const out = [];
  for (const id of [2, 3]) {
    const m = seen.get(id);
    const data = m?.result?.data ?? [];
    out.push(`--- model/list includeHidden=${id === 2} -> ${data.length} models (raw keys: ${m ? Object.keys(m).join(',') : 'NO RESPONSE'})`);
    if (m?.error) out.push('   error: ' + JSON.stringify(m.error).slice(0, 400));
    for (const mo of data) {
      out.push(`   ${String(mo.model).padEnd(26)} hidden=${String(mo.hidden).padEnd(5)} default=${String(mo.isDefault).padEnd(5)} display=${JSON.stringify(mo.displayName)} efforts=[${(mo.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).join(',')}] defaultEffort=${mo.defaultReasoningEffort} id=${mo.id}`);
    }
    if (id === 3) fs.writeFileSync(`C:/ailuo_own/gpt++/tools/out/visible-${label}.json`, JSON.stringify(m?.result ?? null, null, 2));
  }
  console.log(out.join('\n'));
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} process.exit(0); }, 500);
}

setTimeout(() => {
  for (const m of msgs) child.stdin.write(JSON.stringify(m) + '\n');
}, 300);

setTimeout(() => { if (!done) { done = true; console.log('TIMEOUT; seen ids: ' + [...seen.keys()].join(',')); try { child.kill(); } catch {} process.exit(2); } }, 60000);
