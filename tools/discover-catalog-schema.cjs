// Discover the required-field set for model_catalog_json by iterating on validation errors.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CODEX = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
const home = 'C:\\ailuo_own\\gpt++\\probe\\custom';
const catalogPath = path.join(home, 'my-catalog.json');

// Candidate defaults for fields the validator asks for.
const DEFAULTS = {
  support_verbosity: true,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  default_verbosity: 'low',
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text_and_image',
  supports_image_detail_original: true,
  context_window: 128000,
  max_context_window: 128000,
  comp_hash: '3000',
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ['text'],
  supports_search_tool: false,
  supports_experimental_context: false,
  use_responses_lite: true,
  supports_reasoning_effort_updates: true,
  node_repl_auto_review_required: false,
  node_repl_disabled: true,
  tool_mode: 'code_mode_only',
  multi_agent_version: 'v1',
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  default_reasoning_summary: 'none',
  availability_nux: null,
  upgrade: null,
  model_messages: null,
  service_tiers: [],
  additional_speed_tiers: [],
  supported_in_api: true,
  visibility: 'list',
  priority: 1,
  shell_type: 'unified_exec',
};

const model = {
  slug: 'dsv4-pro',
  display_name: 'DSv4 Pro (Custom)',
  description: 'Custom model served by a third-party relay',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast' },
    { effort: 'medium', description: 'Balanced' },
    { effort: 'high', description: 'Deep' },
  ],
};

function run() {
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [model] }, null, 2), 'utf8');
  const r = spawnSync(CODEX, ['debug', 'models'], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  return (r.stdout || '').trim() + '\n' + (r.stderr || '').trim();
}

const added = [];
for (let i = 0; i < 40; i++) {
  const out = run();
  const miss = out.match(/missing field `([^`]+)`/);
  if (miss) {
    const f = miss[1];
    if (!(f in DEFAULTS)) { console.log('NO DEFAULT KNOWN for required field: ' + f); console.log(out.slice(0, 400)); break; }
    model[f] = DEFAULTS[f];
    added.push(f);
    console.log('+ ' + f + ' = ' + JSON.stringify(DEFAULTS[f]));
    continue;
  }
  const unk = out.match(/unknown field `([^`]+)`/);
  if (unk) { console.log('unknown field: ' + unk[1]); }
  if (out.startsWith('{')) {
    const data = JSON.parse(out.split('\n')[0]);
    console.log('\n=== VALID after adding: ' + added.join(', ') + ' ===');
    console.log('models: ' + data.models.length);
    for (const m of data.models) {
      console.log(`  ${m.slug} | ${m.display_name} | visibility=${m.visibility} | prio=${m.priority}`);
    }
    fs.writeFileSync('C:\\ailuo_own\\gpt++\\probe\\minimal-catalog.json', JSON.stringify({ models: [model] }, null, 2), 'utf8');
    console.log('\nminimal model entry written to probe\\minimal-catalog.json');
    break;
  }
  console.log('other error:\n' + out.slice(0, 500));
  break;
}
