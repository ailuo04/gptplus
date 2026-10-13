'use strict';
// 为冒烟测试准备隔离的 App 数据（probe/appdata 下），让界面渲染出有内容的形态。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const storePath = path.join(ROOT, 'probe', 'appdata', 'gptplus', 'config.json');
fs.mkdirSync(path.dirname(storePath), { recursive: true });

const { createStore } = require(path.join(ROOT, 'src/core/store.js'));
const store = createStore({ configPath: storePath });
store.update((d) => {
  d.gateway.enabled = true;
  d.gateway.port = 18120;
});
store.upsertProvider({
  name: '梦幻API', baseUrl: 'https://mhapi.net', apiKey: 'sk-demo-1234567890abcdef', api: 'openai',
  headers: {}, enabled: true,
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', enabled: true },
    { id: 'deepseek-v4', label: 'DeepSeek V4', enabled: true, reasoning: true },
  ],
});
store.upsertProvider({
  name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', api: 'openai',
  headers: {}, enabled: true,
  models: [{ id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', enabled: true }],
});
console.log('seeded app data -> ' + storePath);
console.log('providers=' + store.providers().length + ' models=' + store.providers().reduce((n, p) => n + p.models.length, 0));
