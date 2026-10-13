'use strict';

const SEPARATOR = '__';
const MODEL_KEY_SEPARATOR = '::';

function modelIdOf(model) {
  if (typeof model === 'string') return model.trim();
  if (model && typeof model === 'object' && model.id != null) return String(model.id).trim();
  return '';
}

function normalizeSlugPart(value, fallback = 'provider') {
  const text = String(value == null ? '' : value).trim();
  return (text || fallback)
    .replace(/\s+/g, '-')
    .replace(/__+/g, '-')
    .replace(/[\/\\?#%]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function slugify(providerId, modelId, providerName = providerId) {
  return `${normalizeSlugPart(providerName, providerId)}${SEPARATOR}${modelId}`;
}

function modelKey(providerId, modelId) {
  return `${providerId}${MODEL_KEY_SEPARATOR}${modelId}`;
}

function slugPrefix(provider, providers = []) {
  const base = normalizeSlugPart(provider && (provider.name || provider.id), provider && provider.id);
  const duplicate = providers.some((candidate) =>
    candidate && candidate.id !== provider.id &&
    normalizeSlugPart(candidate.name || candidate.id, candidate.id) === base,
  );
  return duplicate ? `${base}-${normalizeSlugPart(provider.id, 'provider')}` : base;
}

function slugForProvider(provider, modelId, providers = []) {
  return `${slugPrefix(provider, providers)}${SEPARATOR}${modelId}`;
}

function parseSlug(slug) {
  if (typeof slug !== 'string') return null;
  const raw = slug.trim();
  const at = raw.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const providerId = raw.slice(0, at);
  const modelId = raw.slice(at + SEPARATOR.length);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function orderModels(providers, order) {
  const all = [];
  const byKey = new Map();
  for (const provider of Array.isArray(providers) ? providers : []) {
    for (const model of Array.isArray(provider && provider.models) ? provider.models : []) {
      const modelId = modelIdOf(model);
      if (!provider || !provider.id || !modelId) continue;
      const item = { provider, model, providerId: provider.id, modelId, key: modelKey(provider.id, modelId) };
      all.push(item);
      byKey.set(item.key, item);
    }
  }
  const out = [];
  const used = new Set();
  for (const key of Array.isArray(order) ? order : []) {
    const item = byKey.get(String(key));
    if (item && !used.has(item.key)) {
      used.add(item.key);
      out.push(item);
    }
  }
  for (const item of all) {
    if (!used.has(item.key)) out.push(item);
  }
  return out;
}

module.exports = {
  SEPARATOR,
  modelIdOf,
  normalizeSlugPart,
  slugify,
  slugPrefix,
  slugForProvider,
  parseSlug,
  modelKey,
  orderModels,
};
