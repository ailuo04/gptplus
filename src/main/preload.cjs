'use strict';
// contextBridge 暴露面。契约见 spec.md 第 7 节。
const { contextBridge, ipcRenderer } = require('electron');

// 在 renderer 解析 CSS 前写入主题属性，避免等待 getStatus() 才从默认深色切换。
function readStartupArgument(name, fallback) {
  const prefix = `--gptplus-${name}=`;
  const value = process.argv.find((arg) => String(arg).startsWith(prefix));
  return value ? String(value).slice(prefix.length) : fallback;
}

const startupTheme = readStartupArgument('theme', 'dark');
const resolvedTheme = readStartupArgument(
  'resolved-theme',
  startupTheme === 'light' ? 'light' : 'dark',
);
if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.dataset.themeMode = ['dark', 'light', 'system'].includes(startupTheme)
    ? startupTheme
    : 'dark';
  document.documentElement.dataset.theme = resolvedTheme === 'light' ? 'light' : 'dark';
}

// 收集渲染层运行期错误，供自动化冒烟测试读取
const runtimeErrors = [];
try {
  window.addEventListener('error', (e) => {
    runtimeErrors.push(String((e && e.message) || e));
  });
  window.addEventListener('unhandledrejection', (e) => {
    runtimeErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || e.reason));
  });
} catch {
  /* 环境不支持时忽略 */
}

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, cb) {
  const handler = (_evt, payload) => {
    try {
      cb(payload);
    } catch {
      /* 渲染层回调异常不应影响主进程 */
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('gptplus', {
  // 状态与提供商
  getStatus: () => invoke('gptplus:status:get'),
  setTheme: (patch) => invoke('gptplus:theme:set', patch),
  setNetwork: (patch) => invoke('gptplus:network:set', patch),
  listProviders: () => invoke('gptplus:provider:list'),
  saveProvider: (input) => invoke('gptplus:provider:save', input),
  deleteProvider: (id) => invoke('gptplus:provider:delete', id),
  testProvider: (id) => invoke('gptplus:provider:test', id),
  fetchRemoteModels: (id) => invoke('gptplus:provider:models:remote', id),

  // 模型与网关
  listModels: () => invoke('gptplus:models:list'),
  setModelEnabled: (patch) => invoke('gptplus:model:enabled:set', patch),
  moveModel: (patch) => invoke('gptplus:model:move', patch),
  reorderModels: (patch) => invoke('gptplus:model:reorder', patch),
  getModelLimits: () => invoke('gptplus:model-limits:get'),
  setModelLimits: (patch) => invoke('gptplus:model-limits:set', patch),
  getGateway: () => invoke('gptplus:gateway:get'),
  setGateway: (patch) => invoke('gptplus:gateway:set', patch),
  probeGateway: () => invoke('gptplus:gateway:probe'),

  // 注入到 ChatGPT 桌面客户端
  getInject: () => invoke('gptplus:inject:get'),
  setInject: (patch) => invoke('gptplus:inject:set', patch),
  openCodexFolder: () => invoke('gptplus:codex:open'),
  relaunchChatGpt: () => invoke('gptplus:chatgpt:relaunch'),
  getLogs: () => invoke('gptplus:logs:get'),
  getUsage: () => invoke('gptplus:usage:get'),

  // 事件
  onStatus: (cb) => subscribe('gptplus:status', cb),
  onLog: (cb) => subscribe('gptplus:log', cb),
  // 首屏已应用正确主题并完成基础页面渲染，通知主进程显示窗口。
  notifyReady: (theme) => {
    // 等主题样式至少经历一次浏览器绘制，再让主进程显示原生窗口。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => ipcRenderer.send('gptplus:renderer-ready', theme));
    });
  },
});

// 只读暴露运行期错误列表，便于自动化验证
contextBridge.exposeInMainWorld('__gptplusErrors', runtimeErrors);
