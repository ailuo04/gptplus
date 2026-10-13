// End-to-end validation: build a catalog + config, then ask codex to render its model catalog.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const home = 'C:\\ailuo_own\\gpt++\\probe\\custom';
const catalogPath = path.join(home, 'my-catalog.json');

const cache = JSON.parse(fs.readFileSync('C:\\Users\\ailuo\\.codex\\models_cache.json', 'utf8'));
const donor = cache.models.find((m) => m.slug === 'gpt-5.5') || cache.models[0];
const base = donor.base_instructions || donor.model_messages.instructions_template;
console.log('donor=' + donor.slug + ' base_instructions=' + base.length + ' chars');

const entry = {
  slug: 'dsv4-pro',
  display_name: 'DSv4 Pro (Custom)',
  description: 'Custom model served by a third-party relay',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast' },
    { effort: 'medium', description: 'Balanced' },
    { effort: 'high', description: 'Deep' },
  ],
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
  support_verbosity: true,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  experimental_supported_tools: [],
  base_instructions: base,
};

fs.writeFileSync(catalogPath, JSON.stringify({ models: [entry] }, null, 2), 'utf8');
console.log('catalog: ' + catalogPath + ' (' + fs.statSync(catalogPath).size + ' bytes)');

const r = spawnSync(CODEX, ['debug', 'models'], {
  env: { ...process.env, CODEX_HOME: home },
  encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
});
const out = (r.stdout || '').trim();
const err = (r.stderr || '').trim();
if (!out.startsWith('{')) {
  console.log('FAILED:\n' + out.slice(0, 400) + '\n' + err.slice(0, 700));
  process.exit(1);
}
const data = JSON.parse(out);
console.log('\nVALID. models=' + data.models.length);
for (const m of data.models) {
  console.log(`  ${m.slug.padEnd(26)} | ${(m.display_name || '').padEnd(22)} | visibility=${String(m.visibility).padEnd(5)} | prio=${m.priority}`);
}
const mine = data.models.find((m) => m.slug === 'dsv4-pro');
console.log('\ncustom resolved keys: ' + Object.keys(mine).join(', '));
