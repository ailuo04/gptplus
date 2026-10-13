// Probe script: does a custom model_catalog_json show up in `codex debug models`?
// Usage: node probe-catalog.cjs <codexHomeDir> <label>
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const home = process.argv[2];
const label = process.argv[3] || path.basename(home);

const r = spawnSync(CODEX, ['debug', 'models'], {
  env: { ...process.env, CODEX_HOME: home },
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  windowsHide: true,
});
if (r.error) { console.log('spawn error:', r.error.message); process.exit(1); }
const out = (r.stdout || '').trim();
if (!out.startsWith('{')) {
  console.log('non-JSON output (first 400):');
  console.log(out.slice(0, 400));
  console.log('stderr:', (r.stderr || '').slice(0, 600));
  process.exit(1);
}
const data = JSON.parse(out);
console.log(`[${label}] exit=${r.status} models=${data.models.length}`);
for (const m of data.models) {
  const name = m.display_name || m.name;
  console.log(`  - ${m.slug}  | ${name}  | visibility=${m.visibility} | provider=${m.model_provider ?? '-'} | inApi=${m.supported_in_api} | prio=${m.priority ?? '-'}`);
}
if (r.stderr && r.stderr.trim()) console.log('stderr:', r.stderr.trim().slice(0, 500));
