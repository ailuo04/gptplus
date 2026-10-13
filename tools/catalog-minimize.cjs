// Greedily strip keys from a reference catalog entry until nothing else can be removed,
// using the engine itself as the oracle. Then report the minimal entry + smoke-test it.
// Usage: node catalog-minimize.cjs
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const HOME = 'C:\\ailuo_own\\gpt++\\tools\\testhome';
const CATALOG = path.join(HOME, 'catalog.json');
const OUT = 'C:\\ailuo_own\\gpt++\\tools\\out\\min-out.json';
const ERR = 'C:\\ailuo_own\\gpt++\\tools\\out\\min-err.txt';
const REF = 'C:\\ailuo_own\\gpt++\\tools\\out\\embedded-catalog.json';

function probe(entry) {
  fs.writeFileSync(CATALOG, JSON.stringify({ models: [entry] }, null, 2));
  const outFd = fs.openSync(OUT, 'w');
  const errFd = fs.openSync(ERR, 'w');
  const r = spawnSync(CODEX, ['debug', 'models'], {
    cwd: HOME,
    env: { ...process.env, CODEX_HOME: HOME },
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd); fs.closeSync(errFd);
  const err = fs.readFileSync(ERR, 'utf8').trim();
  return { ok: r.status === 0, err };
}

const ref = JSON.parse(fs.readFileSync(REF, 'utf8')).models[0];
ref.slug = 'claude-sonnet-4.5';
ref.display_name = 'Claude Sonnet 4.5';
ref.description = 'Third-party relay model.';
let cur = JSON.parse(JSON.stringify(ref));

// sanity: reference must parse
let base = probe(cur);
console.log('reference entry parses:', base.ok, base.err.slice(0, 200));
if (!base.ok) process.exit(1);

let changed = true;
let pass = 0;
while (changed && pass < 6) {
  changed = false;
  pass++;
  for (const k of Object.keys(cur)) {
    const trial = JSON.parse(JSON.stringify(cur));
    delete trial[k];
    const r = probe(trial);
    if (r.ok) {
      cur = trial;
      changed = true;
      console.log(`pass${pass} removed: ${k}`);
    } else {
      console.log(`pass${pass} kept:    ${k}   (${r.err.split('as JSON: ').pop().slice(0, 90)})`);
    }
  }
}

fs.writeFileSync('C:\\ailuo_own\\gpt++\\tools\\out\\minimal-entry.json', JSON.stringify(cur, null, 2));
console.log('\n=== MINIMAL ENTRY (' + Object.keys(cur).length + ' keys) ===');
console.log(JSON.stringify(cur, null, 2));
const final = probe(cur);
console.log('final parses:', final.ok, final.err.slice(0, 200));
console.log('probe output bytes:', fs.statSync(OUT).size);
