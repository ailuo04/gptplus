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
  getStartup: () => invoke('gptplus:startup:get'),
  setStartup: (patch) => invoke('gptplus:startup:set', patch),
  setNetwork: (patch) => invoke('gptplus:network:set', patch),
  listProviders: () => invoke('gptplus:provider:list'),
  saveProvider: (input) => invoke('gptplus:provider:save', input),
  deleteProvider: (id) => invoke('gptplus:provider:delete', id),
  exportProviderConfig: (input) => invoke('gptplus:provider:export', input),
  pickProviderImportFile: () => invoke('gptplus:provider:import:pick'),
  inspectProviderImport: (input) => invoke('gptplus:provider:import:inspect', input),
  prepareProviderImport: (input) => invoke('gptplus:provider:import:prepare', input),
  applyProviderImport: (input) => invoke('gptplus:provider:import:apply', input),
  cancelProviderImport: (sessionId) => invoke('gptplus:provider:import:cancel', sessionId),
  testProvider: (id) => invoke('gptplus:provider:test', id),
  testProviderModels: (patch) => invoke('gptplus:provider:models:test', patch),
  fetchRemoteModels: (id) => invoke('gptplus:provider:models:remote', id),

  // 对等共享只在主进程处理连接授权；令牌通过系统剪贴板交接，不返回渲染层。
  getPeerState: () => invoke('gptplus:peer:state:get'),
  setSharing: (patch) => invoke('gptplus:sharing:set', patch),
  addSharingClient: (patch) => invoke('gptplus:sharing:client:add', patch),
  revokeSharingClient: (id) => invoke('gptplus:sharing:client:revoke', id),
  setRemoteSync: (patch) => invoke('gptplus:remote:sync:set', patch),
  saveRemoteConnection: (patch) => invoke('gptplus:remote:connection:save', patch),
  setRemoteConnectionEnabled: (patch) => invoke('gptplus:remote:connection:set-enabled', patch),
  deleteRemoteConnection: (id) => invoke('gptplus:remote:connection:delete', id),
  syncRemoteNow: (id) => invoke('gptplus:remote:sync:now', id),
  setRemoteModelEnabled: (patch) => invoke('gptplus:remote:model:enabled:set', patch),
  deleteRemoteModel: (patch) => invoke('gptplus:remote:model:delete', patch),
  restoreRemoteModel: (patch) => invoke('gptplus:remote:model:restore', patch),
  setRemoteModelLabel: (patch) => invoke('gptplus:remote:model:label:set', patch),

  // 微信连接（iLink 长轮询 + 每联系人独立 Codex 会话）
  getWeixin: () => invoke('gptplus:weixin:get'),
  getWeixinStatus: () => invoke('gptplus:weixin:status'),
  setWeixin: (patch) => invoke('gptplus:weixin:set', patch),
  startWeixin: () => invoke('gptplus:weixin:start'),
  stopWeixin: () => invoke('gptplus:weixin:stop'),
  startWeixinQr: (patch) => invoke('gptplus:weixin:qr:start', patch),
  getWeixinQrStatus: () => invoke('gptplus:weixin:qr:status'),
  pickWeixinWorkDir: () => invoke('gptplus:weixin:pick-workdir'),
  pickWeixinCodex: () => invoke('gptplus:weixin:pick-codex'),
  detectWeixinCodex: () => invoke('gptplus:weixin:detect-codex'),
  openWeixinLink: (url) => invoke('gptplus:weixin:open-link', url),
  onWeixinStatus: (cb) => subscribe('gptplus:weixin:status', cb),

  // 插件市场与插件生命周期
  listPlugins: () => invoke('gptplus:plugin:list'),
  installPlugin: (id) => invoke('gptplus:plugin:install', id),
  uninstallPlugin: (id) => invoke('gptplus:plugin:uninstall', id),
  setPluginEnabled: (patch) => invoke('gptplus:plugin:enabled:set', patch),
  setPluginConfig: (patch) => invoke('gptplus:plugin:config:set', patch),
  onPluginChange: (cb) => subscribe('gptplus:plugin:change', cb),

  // 模型与网关
  listModels: () => invoke('gptplus:models:list'),
  setModelEnabled: (patch) => invoke('gptplus:model:enabled:set', patch),
  deleteModel: (patch) => invoke('gptplus:model:delete', patch),
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
  openCodexConfig: () => invoke('gptplus:codex:open-config'),
  relaunchChatGpt: () => invoke('gptplus:chatgpt:relaunch'),
  getLogs: () => invoke('gptplus:logs:get'),
  getUsage: () => invoke('gptplus:usage:get'),
  getUsageTrend: () => invoke('gptplus:usage:trend:get'),
  clearUsage: (patch) => invoke('gptplus:usage:clear', patch),

  // 软件更新
  getUpdateState: () => invoke('gptplus:update:state'),
  checkForUpdates: () => invoke('gptplus:update:check'),
  downloadUpdate: () => invoke('gptplus:update:download'),
  listRollbackReleases: () => invoke('gptplus:update:rollbacks'),
  rollbackToVersion: (version) => invoke('gptplus:update:rollback', version),

  // 事件
  onStatus: (cb) => subscribe('gptplus:status', cb),
  onLog: (cb) => subscribe('gptplus:log', cb),
  onUpdate: (cb) => subscribe('gptplus:update', cb),
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
