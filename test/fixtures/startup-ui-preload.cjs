'use strict';
const { contextBridge } = require('electron');
let startup = { supported: true, enabled: true, target: 'gptplus' };
let hold = false;
let pending;
const calls = [];
const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const status = {
  appVersion: '1.2.0', theme: 'light', providers: 0, models: 0,
  network: { proxyMode: 'system' },
  gateway: { enabled: false, running: false, port: 18120 },
  inject: { enabled: false }, codex: {}, paths: {},
};
const demo = process.argv.includes('--visual-demo');
const providers = demo ? [
  { id: 'p_cloud', name: 'Cloud API', baseUrl: 'https://api.example.com/v1', api: 'openai', enabled: true, hasKey: true,
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true }, { id: 'deepseek-v4', label: 'DeepSeek V4', enabled: true, reasoning: true }] },
  { id: 'p_local', name: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai', enabled: true, hasKey: false,
    models: [{ id: 'qwen3', label: 'Qwen3', enabled: true, reasoning: false }] },
] : [];
const models = providers.flatMap((p) => p.models.map((m) => ({ ...m, modelId: m.id, providerId: p.id, providerName: p.name, slug: `${p.id}__${m.id}` })));
const usage = demo ? Array.from({ length: 48 }, (_, i) => ({
  at: Date.now() - i * 3600000, final: true, usageRecord: true,
  providerId: i % 3 ? 'p_cloud' : 'p_local', providerName: i % 3 ? 'Cloud API' : 'Local Ollama',
  model: i % 3 ? 'p_cloud__gpt-6.1-sol' : 'p_local__qwen3', status: i % 11 ? 200 : 502, ms: 450 + i * 27,
  tokens: { input_tokens: 1200 + i * 37, output_tokens: 240 + i * 9, total_tokens: 1440 + i * 46 },
})) : [];
if (demo) {
  status.providers = providers.length;
  status.models = models.length;
  status.gateway = { enabled: true, running: true, port: 18120, url: '127.0.0.1:18120' };
  status.inject = { enabled: true, defaultModel: models[0].slug, catalogPath: 'C:\\Demo\\model-catalog.json' };
}
contextBridge.exposeInMainWorld('gptplus', {
  getStatus: async () => status, getStartup: async () => startup,
  setStartup: async (patch) => {
    calls.push(patch);
    if (hold) {
      hold = false;
      await new Promise((resolve, reject) => { pending = { resolve, reject }; });
    }
    startup = { ...startup, ...patch };
    return startup;
  },
  listProviders: async () => providers, listModels: async () => models,
  getModelLimits: async () => ({ contextWindow: 1000000, autoCompactTokenLimit: null }),
  getGateway: async () => status.gateway, getInject: async () => status.inject,
  getLogs: async () => [], getUsage: async () => usage,
  getUpdateState: async () => ({ enabled: false, status: 'idle' }),
  onStatus: () => () => {}, onLog: () => () => {}, onUpdate: () => () => {},
});
contextBridge.exposeInMainWorld('__startupTest', {
  holdNext: () => { hold = true; },
  finish: (ok) => {
    if (!pending) throw new Error('No save is pending');
    if (ok) pending.resolve();
    else pending.reject(new Error('Test save failure'));
    pending = null;
  },
  calls: () => calls.slice(), errors: () => errors.slice(),
});
