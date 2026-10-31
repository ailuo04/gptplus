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
const { createUsageLiveReader } = require('./usage-live.js');
const { createGateway } = require('./gateway/server.js');
const { createSystemProxyFetch } = require('./system-proxy.js');
const { createWeixinConnect } = require('./weixin-connect.js');
const { createTaskMonitor } = require('./task-monitor.js');
const { slugForProvider, orderModels, modelKey } = require('./model-utils.js');
const { redactDiagnostic } = require('./redact.js');
const { createRemoteProviders, createRemoteSync, remoteProviderId } = require('./peer-sharing.js');
const { createPluginManager } = require('./plugin-manager.js');
const { createChatGptPluginRecovery } = require('./chatgpt-plugin-recovery.js');

/**
 * @param {{ onStatus?: (s:any)=>void, onLog?: (e:any)=>void, appVersion?: string,
 *           onWeixinStatus?: (s:any)=>void,
 *           secretStorage?: { isAvailable?: () => boolean, encrypt: (text:string) => Buffer|Uint8Array,
 *             decrypt: (bytes:Buffer) => string } }} [opts]
 */
async function createContext(opts = {}) {
  const {
    onStatus = () => {},
    onLog = () => {},
    onWeixinStatus = () => {},
    appVersion = '0.0.0',
    secretStorage = null,
  } = opts;

  paths.ensureDirs();

  const store = createStore({ configPath: paths.CONFIG_PATH, secretStorage });
  const network = createSystemProxyFetch({ mode: store.get().network.proxyMode });
  const catalog = createCatalog({ store, paths });
  const codex = createCodexConfig({ store, catalog, paths });
  const providerClient = createProviderClient({ store, fetchImpl: network });

  // 使用量页的数据源。启动时从磁盘回放，否则每次重进应用统计都会清零。
  const logStore = createLogStore({ logPath: paths.LOG_PATH });
  logStore.load();
  const usageStore = createUsageStore({ usagePath: paths.USAGE_PATH, trendPath: paths.USAGE_TREND_PATH });
  usageStore.load();
  const usageLive = createUsageLiveReader({ codexHome: paths.CODEX_HOME });
  const plugins = createPluginManager({ store });
  const chatgptPluginRecovery = createChatGptPluginRecovery({
    codexHome: paths.CODEX_HOME, configPath: paths.CODEX_CONFIG_PATH, appDir: paths.APP_DIR, backup: codex.backup,
  });
  // 兼容升级前的混合日志：把旧日志里的终结请求迁移到独立统计文件。
  usageStore.importLogs(logStore.all());
  const listeners = new Set();

  function log(entry) {
    const cfg = store.get();
    const peerSecrets = (cfg.remoteSync.connections || []).map((connection) => ({
      baseUrl: connection.baseUrl, apiKey: connection.authToken, headers: {},
    }));
    const weixinSecrets = cfg.weixin && cfg.weixin.token
      ? [{ baseUrl: cfg.weixin.baseUrl, apiKey: cfg.weixin.token, headers: {} }]
      : [];
    const full = redactDiagnostic({ at: Date.now(), level: 'info', ...entry }, [
      ...store.providers(), ...peerSecrets, ...weixinSecrets,
    ]);
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

  // 微信连接：iLink 长轮询收发消息，每个联系人映射到独立的 Codex app-server thread。
  const weixinConnect = createWeixinConnect({
    store,
    log: (e) => log(e),
    onEvent: onWeixinStatus,
    stateDir: paths.APP_DIR,
    fetchImpl: network,
    appVersion,
  });
  const taskMonitor = createTaskMonitor({
    log: (e) => log(e),
    onNotify: (event) => {
      if (plugins.isActive('weixin')) return weixinConnect.notifyTask(event);
      return null;
    },
  });

  const gateway = createGateway({
    store,
    paths,
    fetch: network,
    log: (e) => log(e),
    usageLive,
    taskObserver: taskMonitor,
  });
  taskMonitor.start();

  function models() {
    const out = [];
    const config = store.get();
    const providers = [...store.providers(), ...createRemoteProviders(config, { includeHidden: true })];
    for (const { provider: p, model: m } of orderModels(providers, store.get().modelOrder)) {
      const modelId = m.id;
      const remote = p.remote === true;
      out.push({
        slug: slugForProvider(p, modelId, providers),
        providerId: p.id,
        providerName: remote ? p.name + ' · ' + (m.providerName || '远端提供商') : p.name,
        modelId,
        remoteModelId: remote ? m.modelId : null,
        originProviderId: remote ? m.providerId : null,
        sourceId: remote ? p.sourceId : null,
        sourceName: remote ? p.name : null,
        remote,
        detected: m.detected !== false,
        isNew: m.isNew === true,
        hidden: remote && m.hidden === true,
        label: m.label || modelId,
        enabled: m.hidden !== true && m.enabled !== false && p.enabled !== false,
        reasoning: !!m.reasoning,
        providerEnabled: p.enabled !== false,
        orderKey: modelKey(p.id, modelId),
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
      sharing: { enabled: cfg.sharing.enabled, clients: cfg.sharing.clients.length, models: cfg.sharing.models.length },
      remoteSync: { enabled: cfg.remoteSync.enabled, intervalMinutes: cfg.remoteSync.intervalMinutes,
        connections: cfg.remoteSync.connections.length, sources: cfg.remoteSync.sources.length },
      plugins: plugins.list(),
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

  function peerState() {
    const cfg = store.get();
    const selected = new Set(cfg.sharing.models.map((item) => item.providerId + '::' + item.modelId));
    const localModels = [];
    for (const provider of cfg.providers) for (const model of provider.models || []) {
      localModels.push({ providerId: provider.id, providerName: provider.name, modelId: model.id,
        label: model.label || model.id, enabled: provider.enabled !== false && model.enabled !== false,
        selected: selected.has(provider.id + '::' + model.id) });
    }
    return {
      sharing: { enabled: cfg.sharing.enabled, sourceId: cfg.sharing.sourceId, name: cfg.sharing.name,
        clients: cfg.sharing.clients.map(({ id, name, createdAt }) => ({ id, name, createdAt })), localModels },
      remoteSync: { enabled: cfg.remoteSync.enabled, intervalMinutes: cfg.remoteSync.intervalMinutes,
        connections: cfg.remoteSync.connections.map(({ id, name, sourceId, lastAttemptAt, lastSuccessAt, lastError }) =>
          ({ id, name, sourceId, lastAttemptAt, lastSuccessAt, lastError })),
        sources: cfg.remoteSync.sources.map((source) => ({ ...source, models: source.models.map((model) =>
          ({ ...model, gatewayProviderId: remoteProviderId(source.id) })) })) },
    };
  }

  const remoteSyncManager = createRemoteSync({
    store,
    fetchImpl: network,
    onChange: () => {
      if (store.get().inject.enabled) {
        try { syncInjection({ apply: true }); }
        catch (err) { log({ level: 'error', msg: '远端清单已保存，但模型目录同步失败: ' + err.message }); }
      }
      try { onStatus({ ...status(), peer: peerState(), models: models() }); } catch { /* ignore notification failures */ }
    },
  });
  remoteSyncManager.start();

  return {
    paths,
    store,
    catalog,
    codex,
    providerClient,
    network,
    gateway,
    weixinConnect,
    taskMonitor,
    log,
    logs: () => logStore.all(),
    usage: () => usageStore.all(),
    usageTrend: () => usageStore.trend(),
    usageLive,
    plugins,
    chatgptPluginRecovery,
    clearUsage: (mode = 'all') => {
      const preserveTrend = mode === 'details';
      if (mode !== 'all' && !preserveTrend) throw new Error('无效的数据清空模式');
      logStore.clear();
      usageStore.clear({ preserveTrend });
      return { mode, usage: usageStore.all(), trend: usageStore.trend() };
    },
    models,
    peerState,
    remoteSync: remoteSyncManager,
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
