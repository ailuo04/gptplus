'use strict';
// 生成 model_catalog_json（codex / ChatGPT 桌面端模型目录）。
// 契约见 spec.md 第 2、5、8 节：字段集来自实测（tools/validate-catalog.cjs）。
const fs = require('node:fs');
const path = require('node:path');
const { slugify, parseSlug, slugForProvider, orderModels } = require('./model-utils.js');
const { createRemoteProviders } = require('./peer-sharing.js');

/** 官方 gpt-5.5 的推理档位（~/.codex/models_cache.json 实测值） */
const REASONING_LEVELS_FULL = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
];

/** 非推理模型给一个保守的三档集合 */
const REASONING_LEVELS_BASIC = [
  { effort: 'low', description: 'Fast' },
  { effort: 'medium', description: 'Balanced' },
  { effort: 'high', description: 'Deep' },
];

const TRUNCATION_POLICY = { mode: 'tokens', limit: 10000 };
const CONTEXT_WINDOW = 1_000_000;
const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 100;

/** ~/.codex/models_cache.json 不可用时的内置精简版提示词 */
const FALLBACK_BASE_INSTRUCTIONS = [
  'You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.',
  '',
  '# General',
  '- Understand the request before acting; ask only when genuinely blocked.',
  '- Prefer editing existing files, and keep changes minimal and consistent with the surrounding code.',
  '- Verify your work by running the relevant tests or commands; never claim a result you did not check.',
  '- Report results concisely and say clearly when something could not be verified.',
].join('\n');

/** cachePath -> base_instructions（models_cache.json 有 350KB，避免重复解析） */
const baseInstructionsCache = new Map();

function resolvePaths(injected) {
  const fallback = require('./paths.js');
  const p = injected && typeof injected === 'object' ? injected : {};
  return {
    CATALOG_PATH: p.CATALOG_PATH || fallback.CATALOG_PATH,
    CODEX_HOME: p.CODEX_HOME || fallback.CODEX_HOME,
  };
}

function readBaseInstructionsFromCache(cachePath) {
  const raw = fs.readFileSync(cachePath, 'utf8');
  const data = JSON.parse(raw);
  const models = Array.isArray(data && data.models) ? data.models : [];
  const usable = models.filter(
    (m) => m && typeof m.base_instructions === 'string' && m.base_instructions.trim(),
  );
  const preferred = usable.find((m) => m.slug === 'gpt-5.5') || usable[0];
  return preferred ? preferred.base_instructions : null;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * @param {{ store:any, paths?:any }} deps
 */
function createCatalog({ store, paths } = {}) {
  if (!store || typeof store.providers !== 'function') {
    throw new Error('createCatalog 需要 store');
  }
  const p = resolvePaths(paths);

  /**
   * 优先复用官方 gpt-5.5 的 base_instructions，失败时退回内置精简版。
   * @returns {string}
   */
  function seedBaseInstructions() {
    const cachePath = path.join(p.CODEX_HOME, 'models_cache.json');
    if (baseInstructionsCache.has(cachePath)) return baseInstructionsCache.get(cachePath);
    let value = FALLBACK_BASE_INSTRUCTIONS;
    try {
      const found = readBaseInstructionsFromCache(cachePath);
      if (found) value = found;
    } catch {
      value = FALLBACK_BASE_INSTRUCTIONS;
    }
    baseInstructionsCache.set(cachePath, value);
    return value;
  }

  function buildEntry(provider, model, priority, limits, providers) {
    const label = (model && model.label) || (model && model.id) || '';
    // 与 store.normalizeProvider 保持一致：reasoning 默认 false，只有显式开启才给全六档。
    const reasoning = !!(model && model.reasoning === true);
    return {
      // 必填字段（缺一个 codex debug models 就会报 missing field）
      slug: slugForProvider(provider, model.id, providers),
      display_name: `${label} (${provider.name})`,
      description: `Custom model ${label} served by ${provider.name} through the gpt++ local gateway.`,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: (reasoning ? REASONING_LEVELS_FULL : REASONING_LEVELS_BASIC).map(
        (l) => ({ ...l }),
      ),
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority,
      support_verbosity: true,
      truncation_policy: { ...TRUNCATION_POLICY },
      experimental_supported_tools: [],
      // Context metadata is required for the client to render context usage.
      context_window: limits.contextWindow,
      max_context_window: limits.contextWindow,
      effective_context_window_percent: EFFECTIVE_CONTEXT_WINDOW_PERCENT,
      auto_compact_token_limit: limits.autoCompactTokenLimit,
      base_instructions: seedBaseInstructions(),
    };
  }

  /**
   * 生成目录条目（只包含启用中的 provider / model）。
   * @returns {{slug:string, entry:any}[]}
   */
  function buildEntries() {
    const out = [];
    const configured = store.get().modelLimits || {};
    const contextCandidate = Number(configured.contextWindow);
    const limits = {
      contextWindow: Number.isSafeInteger(contextCandidate) && contextCandidate >= 1024 ? contextCandidate : CONTEXT_WINDOW,
      autoCompactTokenLimit: configured.autoCompactTokenLimit == null ? null : Number(configured.autoCompactTokenLimit),
    };
    if (!Number.isSafeInteger(limits.autoCompactTokenLimit) || limits.autoCompactTokenLimit < 1024 || limits.autoCompactTokenLimit > limits.contextWindow) {
      limits.autoCompactTokenLimit = null;
    }
    const config = store.get();
    const providers = [...store.providers(), ...createRemoteProviders(config)];
    let priority = 1;
    for (const { provider, model } of orderModels(providers, store.get().modelOrder)) {
      if (!provider || provider.enabled === false || !model || !model.id || model.enabled === false) continue;
      const slug = slugForProvider(provider, model.id, providers);
      out.push({ slug, entry: buildEntry(provider, model, priority, limits, providers) });
      priority += 1;
    }
    return out;
  }

  /** @returns {{models:any[]}} 可直接 JSON.stringify 落盘 */
  function buildCatalogJson() {
    return { models: buildEntries().map((e) => e.entry) };
  }

  /** @returns {{path:string, count:number, bytes:number}} */
  function writeCatalog() {
    const json = buildCatalogJson();
    const text = JSON.stringify(json, null, 2) + '\n';
    atomicWrite(p.CATALOG_PATH, text);
    return { path: p.CATALOG_PATH, count: json.models.length, bytes: Buffer.byteLength(text, 'utf8') };
  }

  return {
    buildEntries,
    buildCatalogJson,
    writeCatalog,
    seedBaseInstructions,
    slugify,
    parseSlug,
    slugForProvider,
    catalogPath: p.CATALOG_PATH,
  };
}

module.exports = {
  createCatalog,
  slugify,
  parseSlug,
  slugForProvider,
  FALLBACK_BASE_INSTRUCTIONS,
  REASONING_LEVELS_FULL,
  REASONING_LEVELS_BASIC,
};
