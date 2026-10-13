'use strict';
// 组装根：把 core 各模块拼成一个上下文对象，供 main.js / ipc.js 使用。
// 接口契约见 spec.md 第 8 节。
const fs = require('node:fs');
const paths = require('./paths.js');
const { createStore } = require('./store.js');
const { createCatalog } = require('./catalog.js');
const { createCodexConfig } = require('./codex-config.js');
const { createProviderClient } = require('./provider-client.js');
const { createLogStore } = require('./log-store.js');
const { createUsageStore } = require('./usage-store.js');
const { createGateway } = require('./gateway/server.js');
const { createSystemProxyFetch } = require('./system-proxy.js');
const { slugForProvider, orderModels, modelKey } = require('./model-utils.js');

/**
 * @param {{ onStatus?: (s:any)=>void, onLog?: (e:any)=>void, appVersion?: string }} [opts]
 */
async function createContext(opts = {}) {
  const { onStatus = () => {}, onLog = () => {}, appVersion = '0.0.0' } = opts;

  paths.ensureDirs();

  const store = createStore({ configPath: paths.CONFIG_PATH });
  const network = createSystemProxyFetch({ mode: store.get().network.proxyMode });
  const catalog = createCatalog({ store, paths });
  const codex = createCodexConfig({ store, catalog, paths });
  const providerClient = createProviderClient({ store, fetchImpl: network });

  // 使用量页的数据源。启动时从磁盘回放，否则每次重进应用统计都会清零。
  const logStore = createLogStore({ logPath: paths.LOG_PATH });
  logStore.load();
  const usageStore = createUsageStore({ usagePath: paths.USAGE_PATH });
  usageStore.load();
  // 兼容升级前的混合日志：把旧日志里的终结请求迁移到独立统计文件。
  usageStore.importLogs(logStore.all());
  const listeners = new Set();

  function log(entry) {
    const full = { at: Date.now(), level: 'info', ...entry };
    logStore.append(full);
    if (full.final === true) usageStore.append(full);
    try {
      onLog(full);
    } catch {
      /* 广播失败不影响主流程 */
    }
    for (const cb of listeners) {
      try {
        cb(full);
      } catch {
        /* ignore */
      }
    }
  }

  const gateway = createGateway({
    store,
    paths,
    fetch: network,
    log: (e) => log(e),
  });

  function models() {
    const out = [];
    const providers = store.providers();
    for (const { provider: p, model: m } of orderModels(providers, store.get().modelOrder)) {
      out.push({
        slug: slugForProvider(p, m.id, providers),
        providerId: p.id,
        providerName: p.name,
        modelId: m.id,
        label: m.label || m.id,
        enabled: m.enabled !== false && p.enabled !== false,
        reasoning: !!m.reasoning,
        providerEnabled: p.enabled !== false,
        orderKey: modelKey(p.id, m.id),
      });
    }
    return out;
  }

  function status() {
    const cfg = store.get();
    const gw = gateway.getState();
    return {
      appVersion,
      theme: cfg.theme,
      network: { proxyMode: cfg.network.proxyMode },
      providers: cfg.providers.length,
      models: models().length,
      // 真正会被写进模型清单的数量（提供商与模型都启用）；status.models 是总数，
      // 渲染层在还没拉到模型列表时要用这个，不能拿总数当「已注入 N 个模型」。
      modelsEnabled: models().filter((m) => m.enabled).length,
      gateway: {
        enabled: !!cfg.gateway.enabled,
        running: !!gw.running,
        port: gw.port,
        url: gw.url,
        startedAt: gw.startedAt || null,
      },
      modelLimits: cfg.modelLimits,
      inject: {
        enabled: !!cfg.inject.enabled,
        catalogPath: cfg.inject.catalogPath || null,
        defaultModel: cfg.inject.defaultModel || null,
      },
      codex: {
        configPath: paths.CODEX_CONFIG_PATH,
        catalogPath: cfg.inject.catalogPath || paths.CATALOG_PATH,
        configExists: fs.existsSync(paths.CODEX_CONFIG_PATH),
        lastWrite: lastWrite,
      },
      paths: {
        configPath: paths.CONFIG_PATH,
        backupDir: paths.BACKUP_DIR,
      },
    };
  }

  /** @type {{at:number, ok:boolean, error?:string}|null} */
  let lastWrite = null;

  function markWrite(ok, error) {
    lastWrite = { at: Date.now(), ok, ...(error ? { error } : {}) };
    emitStatus();
  }

  function emitStatus() {
    try {
      onStatus(status());
    } catch {
      /* ignore */
    }
  }

  /** 把当前 store 状态同步到 Codex 配置（注入开关关闭时只保证不残留我们的段） */
  function syncInjection({ apply = true } = {}) {
    const cfg = store.get();
    if (!apply) return { changed: false };
    if (cfg.inject.enabled) {
      // 空目录比不注入更糟：客户端遇到空 models 数组会静默回退到内置模型列表，
      // 用户会以为"注入没生效"。所以这里拒绝写出空目录，并保留上一次的目录文件。
      const entries = catalog.buildEntries();
      if (entries.length === 0) {
        const err = new Error('没有可注入的模型（所有提供商或模型都被停用了），已保留上一份模型清单');
        markWrite(false, err.message);
        log({ level: 'error', msg: err.message });
        throw err;
      }
      const defaultModel = entries.some((entry) => entry.slug === cfg.inject.defaultModel)
        ? cfg.inject.defaultModel
        : entries[0].slug;
      if (defaultModel !== cfg.inject.defaultModel) {
        store.update((draft) => {
          draft.inject.defaultModel = defaultModel;
        });
      }
      const written = catalog.writeCatalog();
      const res = codex.applyInjection({
        enabled: true,
        catalogPath: written.path,
        defaultModel,
        port: cfg.gateway.port,
        host: cfg.gateway.host,
      });
      markWrite(true);
      log({
        level: 'info',
        msg: `已注入模型目录: ${written.count} 个模型 -> ${written.path}（网关 ${cfg.gateway.host || '127.0.0.1'}:${cfg.gateway.port}）`,
      });
      return { changed: res.changed, ...written };
    }
    const res = codex.applyInjection({ enabled: false });
    markWrite(true);
    return { changed: res.changed };
  }

  return {
    paths,
    store,
    catalog,
    codex,
    providerClient,
    network,
    gateway,
    log,
    logs: () => logStore.all(),
    usage: () => usageStore.all(),
    models,
    status,
    emitStatus,
    markWrite,
    syncInjection,
    onLogEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

module.exports = { createContext };
