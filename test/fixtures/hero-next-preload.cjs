'use strict';
// 主页「下一步」黄条的视觉/交互验证夹具，独立于 probe 临时产物：
// 用真实渲染层 + 假 API，模拟「配置已修改，需要重启 ChatGPT」状态，
// 并让 relaunchChatGpt 可被观测（记录调用次数、可控制成功/失败/延迟）。
const { contextBridge } = require('electron');

const calls = [];
const errors = [];
window.addEventListener('error', (e) => errors.push(String((e && e.message) || e)));
window.addEventListener('unhandledrejection', (e) => errors.push(String((e && e.reason && e.reason.message) || e.reason)));

if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.dataset.themeMode = 'light';
  document.documentElement.dataset.theme = 'light';
}

const listeners = { status: [], log: [], update: [] };
const emit = (topic, payload) => {
  for (const fn of listeners[topic]) {
    try { fn(payload); } catch (err) { errors.push(String(err && err.message || err)); }
  }
};

let relaunchMode = 'ok'; // ok | fail | hold
let pendingResolve = null;
let relaunchCount = 0;

const providers = [
  {
    id: 'p_cloud', name: 'Cloud API', baseUrl: 'https://api.example.com/v1', api: 'openai',
    enabled: true, hasKey: true,
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
      { id: 'deepseek-v4', label: 'DeepSeek V4', enabled: true, reasoning: true },
    ],
  },
];
const models = providers.flatMap((p) => p.models.map((m) => ({
  ...m, modelId: m.id, providerId: p.id, providerName: p.name, slug: `${p.id}__${m.id}`,
})));

let status = {
  appVersion: '1.2.6',
  theme: 'light',
  providers: 1,
  models: 2,
  modelsEnabled: 2,
  network: { proxyMode: 'system' },
  gateway: { enabled: true, running: true, port: 18120, url: 'http://127.0.0.1:18120/v1' },
  inject: { enabled: true, defaultModel: models[0].slug, catalogPath: 'C:\\Demo\\model-catalog.json' },
  // 关键：让首页进入「需要重启」分支，但 lastWrite 早于页面加载，避免被 observeCodexWrite 覆盖太多。
  codex: {
    configPath: 'C:\\Users\\demo\\.codex\\config.toml',
    catalogPath: 'C:\\Demo\\model-catalog.json',
    lastWrite: { at: Date.now() - 60000, ok: true },
  },
  paths: { configPath: 'C:\\Demo\\gptplus\\config.json', backupDir: 'C:\\Demo\\gptplus\\backups' },
};

contextBridge.exposeInMainWorld('gptplus', {
  getStatus: async () => status,
  setTheme: async (patch) => {
    status = { ...status, theme: patch.theme };
    return status;
  },
  getStartup: async () => ({ supported: true, enabled: false, target: 'gptplus' }),
  setStartup: async (patch) => ({ supported: true, enabled: false, target: 'gptplus', ...patch }),
  setNetwork: async (patch) => {
    status = { ...status, network: { proxyMode: patch.proxyMode } };
    return status;
  },
  listProviders: async () => providers,
  listModels: async () => models,
  getModelLimits: async () => ({ contextWindow: 1000000, autoCompactTokenLimit: null }),
  setModelLimits: async () => status,
  getGateway: async () => status.gateway,
  setGateway: async () => status,
  probeGateway: async () => ({ ok: true, latencyMs: 4 }),
  getInject: async () => status.inject,
  setInject: async (patch) => {
    status = { ...status, inject: { ...status.inject, ...patch } };
    return status;
  },
  openCodexFolder: async () => ({ ok: true }),
  relaunchChatGpt: async () => {
    relaunchCount += 1;
    calls.push(['relaunchChatGpt']);
    if (relaunchMode === 'hold') {
      await new Promise((resolve) => { pendingResolve = resolve; });
      return { ok: true, pid: 4321 };
    }
    if (relaunchMode === 'fail') return { ok: false, error: '模拟失败：ChatGPT 没有退出' };
    return { ok: true, pid: 4321 };
  },
  getLogs: async () => [],
  getUsage: async () => [],
  getUsageTrend: async () => [],
  getUpdateState: async () => ({ enabled: false, status: 'idle' }),
  checkForUpdates: async () => ({ enabled: false, status: 'idle' }),
  downloadUpdate: async () => ({ enabled: false, status: 'idle' }),
  listRollbackReleases: async () => [],
  rollbackToVersion: async () => ({ enabled: false, status: 'idle' }),
  onStatus: (cb) => { listeners.status.push(cb); return () => {}; },
  onLog: (cb) => { listeners.log.push(cb); return () => {}; },
  onUpdate: (cb) => { listeners.update.push(cb); return () => {}; },
  notifyReady: () => {},
});

contextBridge.exposeInMainWorld('__heroTest', {
  relaunchCount: () => relaunchCount,
  calls: () => calls.slice(),
  errors: () => errors.slice(),
  setRelaunchMode: (mode) => { relaunchMode = mode; },
  releaseRelaunch: () => { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); } },
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = theme;
    status = { ...status, theme };
    emit('status', status);
  },
  // 让页面进入「配置已修改，需要重启」状态：推进一次 codex.lastWrite。
  // 状态广播只重绘 chrome，主页内容要等下一次渲染；这里用切页触发一次真实重绘。
  markRelaunchNeeded: () => {
    status = {
      ...status,
      codex: { ...status.codex, lastWrite: { at: Date.now(), ok: true } },
    };
    emit('status', status);
    const nav = (view) => {
      const btn = document.querySelector(`[data-view="${view}"]`);
      if (btn) btn.click();
    };
    nav('models');
    setTimeout(() => nav('home'), 30);
  },
  relaunchNeeded: () => document.querySelector('.home-next') !== null,
  currentView: () => {
    const active = document.querySelector('.nav-item.is-active');
    return active ? active.dataset.view : null;
  },
});
