'use strict';
/**
 * 模型 slug 路由：新格式使用渠道名，旧 providerId 格式继续兼容。
 * 新 slug 只用于人类可读性，真正的上游路由仍然落到稳定 provider.id。
 */
const { slugify, parseSlug, slugForProvider, slugPrefix, orderModels, modelIdOf } = require('../model-utils.js');
const { createRemoteProviders, parseSharedModelId } = require('../peer-sharing.js');

/**
 * 创建网关模型路由表。
 * @param {{ store: any }} deps 配置存储，需提供 providers()/getProvider()。
 * @returns {{slugify:Function,parseSlug:Function,listModels:Function,counts:Function,resolve:Function,getProvider:Function,providers:Function}}
 */
function createRouter({ store } = {}) {
  const providers = () => {
    try {
      const config = typeof store?.get === 'function' ? store.get() : {};
      const list = typeof store?.providers === 'function' ? store.providers() : config?.providers;
      return [...(Array.isArray(list) ? list.filter(Boolean) : []), ...createRemoteProviders(config)];
    } catch {
      return [];
    }
  };

  const localProviders = () => {
    try {
      const list = typeof store?.providers === 'function' ? store.providers() : store?.get?.()?.providers;
      return Array.isArray(list) ? list.filter((provider) => provider && !provider.remote) : [];
    } catch { return []; }
  };

  const getProvider = (id) => {
    if (!id) return undefined;
    try {
      if (typeof store?.getProvider === 'function') {
        const found = store.getProvider(id);
        if (found) return found;
      }
    } catch {
      /* 继续用快照查找 */
    }
    return providers().find((p) => p && p.id === id);
  };

  function listModels() {
    const out = [];
    const list = providers();
    const configuredOrder = store?.get?.()?.modelOrder;
    for (const { provider, model } of orderModels(list, configuredOrder)) {
      const modelId = modelIdOf(model);
      if (!modelId) continue;
      const enabled = provider.enabled !== false && (typeof model === 'string' || model.enabled !== false);
      out.push({
        slug: slugForProvider(provider, modelId, list),
        providerId: provider.id,
        providerName: provider.name || provider.id,
        modelId,
        label: (model && typeof model === 'object' && model.label) || modelId,
        enabled,
        reasoning: !!(model && typeof model === 'object' && model.reasoning),
      });
    }
    return out;
  }

  function counts() {
    const all = providers();
    return { providers: all.length, models: listModels().length };
  }

  /**
   * 解析新渠道名 slug，也兼容旧 providerId slug。
   * 未登记模型仍允许直通，只要左侧能定位到已存在的提供商。
   */
  function resolve(slug) {
    const raw = typeof slug === 'string' ? slug.trim() : slug == null ? '' : String(slug).trim();
    if (!raw) return { ok: false, slug: raw, reason: 'unknown model ' + raw, provider: null };
    const parsed = parseSlug(raw);
    if (!parsed) return { ok: false, slug: raw, reason: 'unknown model ' + raw, provider: null };

    const all = providers();
    let provider = getProvider(parsed.providerId);
    if (!provider) {
      provider = all.find((candidate) => slugPrefix(candidate, all) === parsed.providerId);
    }
    if (!provider) return { ok: false, slug: raw, reason: 'unknown model ' + raw, provider: null };

    const modelId = parsed.modelId;
    const list = Array.isArray(provider.models) ? provider.models : [];
    const declared = list.find((m) => modelIdOf(m) === modelId) || null;
    return {
      ok: true,
      slug: raw,
      provider,
      providerId: provider.id,
      providerName: provider.name || provider.id,
      modelId,
      model: declared,
      declared: !!declared,
      enabled: provider.enabled !== false && (typeof declared === 'string' || !declared || declared.enabled !== false),
    };
  }

  function resolveLocalModelId(remoteModelId) {
    const parsed = parseSharedModelId(remoteModelId);
    if (!parsed) return { ok: false, reason: 'MODEL_NOT_FOUND' };
    const shared = store?.get?.()?.sharing;
    const published = Array.isArray(shared?.models)
      && shared.models.some((item) => item.providerId === parsed.providerId && item.modelId === parsed.modelId);
    if (!published) return { ok: false, reason: 'MODEL_NOT_FOUND' };
    const provider = localProviders().find((item) => item.id === parsed.providerId);
    const model = provider && (provider.models || []).find((item) => modelIdOf(item) === parsed.modelId);
    if (!provider || provider.enabled === false || !model || model.enabled === false) {
      return { ok: false, reason: 'MODEL_NOT_FOUND' };
    }
    const all = localProviders();
    return {
      ok: true,
      slug: slugForProvider(provider, parsed.modelId, all),
      provider,
      providerId: provider.id,
      providerName: provider.name || provider.id,
      modelId: parsed.modelId,
      model,
      declared: true,
      enabled: true,
    };
  }

  return { slugify, parseSlug, listModels, counts, resolve, resolveLocalModelId, getProvider, providers, localProviders };
}

module.exports = { createRouter, slugify, parseSlug, modelIdOf };
