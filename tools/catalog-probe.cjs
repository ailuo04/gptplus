// Probe the codex engine's model-catalog parser empirically, in an isolated CODEX_HOME.
// Usage:
//   node catalog-probe.cjs <catalogJsonFile>          -> run `debug models`, print ok/err
//   node catalog-probe.cjs --required                 -> remove each key from a reference entry, report required/optional
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const HOME = 'C:\\ailuo_own\\gpt++\\tools\\testhome';
const CATALOG = path.join(HOME, 'catalog.json');
const OUT = 'C:\\ailuo_own\\gpt++\\tools\\out\\probe-out.json';
const ERR = 'C:\\ailuo_own\\gpt++\\tools\\out\\probe-err.txt';
const REF = 'C:\\ailuo_own\\gpt++\\tools\\out\\embedded-catalog.json';

// spawn with file-descriptor stdio (no named pipes -> safe under the DSH sandbox)
function runCodex(args) {
  const outFd = fs.openSync(OUT, 'w');
  const errFd = fs.openSync(ERR, 'w');
  const r = spawnSync(CODEX, args, {
    cwd: HOME,
    env: { ...process.env, CODEX_HOME: HOME },
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd); fs.closeSync(errFd);
  const out = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const err = fs.existsSync(ERR) ? fs.readFileSync(ERR, 'utf8') : '';
  return { status: r.status, out, err };
}

const BUNDLED = process.argv.includes('--bundled');

function probe(entry) {
  fs.writeFileSync(CATALOG, JSON.stringify({ models: [entry] }, null, 2));
  const r = runCodex(BUNDLED ? ['debug', 'models', '--bundled'] : ['debug', 'models']);
  if (r.status === 0) return { ok: true, status: r.status, raw: r.out };
  const msg = (r.err || r.out).trim().split('\n').filter(Boolean).slice(0, 2).join(' | ');
  return { ok: false, status: r.status, err: msg };
}

if (process.argv[2] === '--required') {
  const ref = JSON.parse(fs.readFileSync(REF, 'utf8')).models[0];
  const keys = Object.keys(ref);
  const rows = [];
  for (const k of keys) {
    const e = JSON.parse(JSON.stringify(ref));
    delete e[k];
    const r = probe(e);
    rows.push({ key: k, result: r.ok ? 'OPTIONAL' : 'REQUIRED', err: r.err || '' });
    process.stdout.write(`${k.padEnd(42)} ${rows[rows.length - 1].result}  ${r.err ? r.err.slice(0, 110) : ''}\n`);
  }
  const req = rows.filter((r) => r.result === 'REQUIRED').map((r) => r.key);
  process.stdout.write('\nREQUIRED (' + req.length + '): ' + req.join(', ') + '\n');
  process.stdout.write('OPTIONAL (' + (rows.length - req.length) + '): ' + rows.filter((r) => r.result === 'OPTIONAL').map((r) => r.key).join(', ') + '\n');
} else {
  const r = probe(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).models[0]);
  process.stdout.write(JSON.stringify({ ok: r.ok, status: r.status, err: r.err, rawLen: (r.raw || '').length }, null, 2) + '\n');
}
