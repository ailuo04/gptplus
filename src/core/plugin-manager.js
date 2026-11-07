'use strict';
const { normalizeImageBaseUrl } = require('./base-url.js');

// The catalog describes capabilities and configuration boundaries. Plugin code stays
// bundled with the app so the renderer never executes downloaded code.

const DEFAULT_USAGE_METRICS = Object.freeze({
  speed: true,
  cache: true,
  context: true,
});

const DEFAULT_VOICE_SPACE_HOLD_MS = 1000;
const MIN_VOICE_SPACE_HOLD_MS = 300;
const MAX_VOICE_SPACE_HOLD_MS = 5000;

const DEFAULT_VOICE_CONFIG = Object.freeze({
  engine: 'local',
  providerId: '',
  model: 'whisper-1',
  language: '',
  spaceHoldMs: DEFAULT_VOICE_SPACE_HOLD_MS,
});

const DEFAULT_IMAGE_CONFIG = Object.freeze({ baseUrl: '', apiKey: '', model: '', preferDefault: true, resolution: '1K', aspectRatio: '1:1', quality: 'auto', background: 'auto' });
const DEFAULT_BALANCE_CONFIG = Object.freeze({ providers: Object.freeze([]), refreshIntervalSeconds: 60 });
const MIN_BALANCE_REFRESH_SECONDS = 10;
const MAX_BALANCE_REFRESH_SECONDS = 86400;
const BALANCE_ADAPTERS = new Set(['sub2api', 'newapi']);

const BUILTIN_PLUGIN_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'custom-imagegen', name: '自定义生图', version: '1.0.0', author: 'gpt++',
    category: '创作', icon: 'image', builtIn: true, defaultInstalled: false, defaultEnabled: false, configurable: true,
    description: '使用你自己的 URL、API Key 和模型生成图片，配套安装可自动匹配的生图技能。',
    detail: '支持 OpenAI 兼容 Images API。可停用内置 imagegen 技能以自动优先；不代表关闭底层工具或保证模型每次自动选择。执行器固定调用你的服务，失败不回退。',
    defaultConfig: DEFAULT_IMAGE_CONFIG,
  }),
  Object.freeze({
    id: 'weixin',
    name: '微信连接',
    version: '1.0.0',
    author: 'gpt++',
    category: '连接',
    icon: 'wechat',
    description: '通过个人微信连接本机 Codex 会话，在微信里直接处理工作目录中的任务。',
    detail: '支持扫码登录、联系人白名单、独立会话、图片收发和任务进度通知。',
    route: 'weixin',
    builtIn: true,
    defaultInstalled: true,
    defaultEnabled: true,
    configurable: true,
  }),
  Object.freeze({
    id: 'usage-statusline',
    name: 'ChatGPT 用量信息栏',
    version: '1.0.0',
    author: 'gpt++',
    category: '效率',
    icon: 'activity',
    description: '在 ChatGPT 输入框下方显示生成速度、缓存命中率和上下文占用。',
    detail: '数据来自本机 Codex 会话记录，不读取消息正文；可单独选择显示哪些指标。',
    builtIn: true,
    defaultInstalled: true,
    defaultEnabled: true,
    configurable: true,
    defaultConfig: { metrics: DEFAULT_USAGE_METRICS },
  }),
  Object.freeze({
    id: 'provider-balance',
    name: '中转站余额',
    version: '1.0.0',
    author: 'gpt++',
    category: '效率',
    icon: 'activity',
    description: '在 ChatGPT 页面显示当前模型上游的剩余额度。',
    detail: '仅调用 Sub2API / New API 的只读额度接口，不发送生成请求或消耗模型 Token；启用后复用已保存的提供商凭据。',
    builtIn: true,
    defaultInstalled: false,
    defaultEnabled: false,
    configurable: true,
    defaultConfig: DEFAULT_BALANCE_CONFIG,
  }),
  Object.freeze({
    id: 'chatgpt-plugin-catalog',
    name: 'ChatGPT 插件目录修复',
    version: '1.0.0',
    author: 'gpt++',
    category: '工具',
    icon: 'box',
    description: '将 ChatGPT 已同步的插件示例复制为独立本地市场，供你选择安装。',
    detail: '启用时备份并修改 Codex 配置；重启 ChatGPT 后在「个人」中的本地市场选择安装。远程公共目录、原有已安装记录不会恢复，联网插件仍需正常登录授权。',
    builtIn: true,
    defaultInstalled: false,
    defaultEnabled: false,
    configurable: false,
  }),
  Object.freeze({
    id: 'voice-input',
    name: '语音输入',
    version: '1.0.0',
    author: 'gpt++',
    category: '效率',
    icon: 'mic',
    description: '在 ChatGPT 输入框的发送键旁加入麦克风按钮，把语音转成文字。',
    detail: '默认在本机用 SenseVoice 离线识别，不弹出系统语音浮层；在输入框内长按空格或未选中文字处按住鼠标左键 1 秒即可开始录音，松开自动转写，长按时长可调整。也可以改用支持 /audio/transcriptions 的 OpenAI 兼容提供商。',
    builtIn: true,
    defaultInstalled: true,
    defaultEnabled: true,
    configurable: true,
    defaultConfig: DEFAULT_VOICE_CONFIG,
  }),
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizePluginId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) ? id : '';
}

function normalizeUsageConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const metrics = isPlainObject(source.metrics) ? source.metrics : {};
  return {
    metrics: {
      speed: metrics.speed !== false,
      cache: metrics.cache !== false,
      context: metrics.context !== false,
    },
  };
}

function normalizeVoiceSpaceHoldMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_VOICE_SPACE_HOLD_MS;
  var numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VOICE_SPACE_HOLD_MS;
  var rounded = Math.round(numeric / 100) * 100;
  return Math.min(MAX_VOICE_SPACE_HOLD_MS, Math.max(MIN_VOICE_SPACE_HOLD_MS, rounded));
}

function normalizeVoiceConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const language = String(source.language || '').trim().toLowerCase();
  return {
    engine: source.engine === 'provider' ? 'provider' : source.engine === 'system' ? 'system' : 'local',
    providerId: String(source.providerId || '').trim().slice(0, 128),
    model: String(source.model || 'whisper-1').trim().slice(0, 128) || 'whisper-1',
    language: /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language) ? language : '',
    spaceHoldMs: normalizeVoiceSpaceHoldMs(source.spaceHoldMs),
  };
}

function normalizeImageConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    baseUrl: normalizeImageBaseUrl(String(source.baseUrl || '').trim().slice(0, 2048)),
    apiKey: String(source.apiKey || '').trim().slice(0, 8192),
    model: String(source.model || '').trim().slice(0, 256),
    preferDefault: source.preferDefault !== false,
    resolution: ['1K', '2K', '4K'].includes(source.resolution) ? source.resolution : '1K',
    aspectRatio: ['1:1', '4:3', '3:4', '16:9', '9:16'].includes(source.aspectRatio) ? source.aspectRatio : '1:1',
    quality: ['low', 'medium', 'high', 'auto'].includes(source.quality) ? source.quality : 'auto',
    background: ['auto', 'opaque', 'transparent'].includes(source.background) ? source.background : 'auto',
  };
}

function normalizeBalanceConfig(raw, { validProviderIds, strict = false } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const hasProviderAllowlist = validProviderIds instanceof Set || Array.isArray(validProviderIds);
  const allowedProviderIds = validProviderIds instanceof Set ? validProviderIds : new Set(Array.isArray(validProviderIds) ? validProviderIds : []);
  const providers = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.providers) ? source.providers : []) {
    if (!isPlainObject(entry)) continue;
    const providerId = String(entry.providerId || '').trim();
    const adapter = String(entry.adapter || '').trim();
    if (!providerId || !BALANCE_ADAPTERS.has(adapter)) {
      if (strict && providerId && !BALANCE_ADAPTERS.has(adapter)) throw new Error('不支持的 adapter');
      continue;
    }
    if (hasProviderAllowlist && !allowedProviderIds.has(providerId)) continue;
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    providers.push({ providerId, adapter });
  }

  const rawInterval = source.refreshIntervalSeconds;
  const interval = rawInterval == null || String(rawInterval).trim() === '' ? 60 : Number(rawInterval);
  if (!Number.isInteger(interval) || interval < MIN_BALANCE_REFRESH_SECONDS || interval > MAX_BALANCE_REFRESH_SECONDS) {
    if (strict) throw new Error('刷新间隔必须是 10–86400 秒的整数');
    return { providers, refreshIntervalSeconds: 60 };
  }
  return { providers, refreshIntervalSeconds: interval };
}

function normalizePluginConfig(definition, raw, options = {}) {
  if (definition.id === 'custom-imagegen') return normalizeImageConfig(raw);
  if (definition.id === 'usage-statusline') return normalizeUsageConfig(raw);
  if (definition.id === 'voice-input') return normalizeVoiceConfig(raw);
  if (definition.id === 'provider-balance') return normalizeBalanceConfig(raw, options);
  return isPlainObject(raw) ? deepCopy(raw) : {};
}

function defaultPluginState(definition) {
  return {
    installed: definition.defaultInstalled !== false,
    enabled: definition.defaultEnabled !== false,
    config: normalizePluginConfig(definition, definition.defaultConfig),
  };
}

function normalizeStoredPluginState(definition, raw) {
  const defaults = defaultPluginState(definition);
  if (!isPlainObject(raw)) return defaults;
  const installed = raw.installed === true;
  return {
    installed,
    enabled: installed && raw.enabled === true,
    config: normalizePluginConfig(definition, raw.config),
  };
}

function publicPlugin(definition, state) {
  return {
    id: definition.id,
    name: definition.name,
    version: definition.version,
    author: definition.author,
    category: definition.category,
    icon: definition.icon,
    description: definition.description,
    detail: definition.detail,
    route: definition.route || null,
    builtIn: definition.builtIn !== false,
    configurable: definition.configurable === true,
    installed: state.installed,
    enabled: state.enabled,
    active: state.installed && state.enabled,
    config: definition.id === 'custom-imagegen'
      ? { baseUrl: state.config.baseUrl, model: state.config.model, preferDefault: state.config.preferDefault, resolution: state.config.resolution, aspectRatio: state.config.aspectRatio, quality: state.config.quality, background: state.config.background, hasKey: !!state.config.apiKey }
      : deepCopy(state.config),
  };
}

/**
 * @param {{ store: { get:()=>any, update:(fn:(draft:any)=>any)=>any }, definitions?: any[] }} options
 */
function createPluginManager({ store, definitions = BUILTIN_PLUGIN_DEFINITIONS } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') {
    throw new Error('createPluginManager 需要可读写的 store');
  }

  const definitionMap = new Map();
  for (const raw of Array.isArray(definitions) ? definitions : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = normalizePluginId(raw.id);
    if (!id || definitionMap.has(id)) continue;
    definitionMap.set(id, {
      id,
      name: String(raw.name || id).trim() || id,
      version: String(raw.version || '1.0.0').trim() || '1.0.0',
      author: String(raw.author || 'gpt++').trim() || 'gpt++',
      category: String(raw.category || '其它').trim() || '其它',
      icon: String(raw.icon || 'box').trim() || 'box',
      description: String(raw.description || '').trim(),
      detail: String(raw.detail || '').trim(),
      route: raw.route ? String(raw.route).trim() : null,
      builtIn: raw.builtIn !== false,
      defaultInstalled: raw.defaultInstalled !== false,
      defaultEnabled: raw.defaultEnabled !== false,
      configurable: raw.configurable === true,
      defaultConfig: raw.defaultConfig,
    });
  }

  const listeners = new Set();

  function definition(id) {
    const key = normalizePluginId(id);
    const found = definitionMap.get(key);
    if (!found) throw new Error('插件不存在');
    return found;
  }

  function readState(id) {
    const def = definition(id);
    const stored = store.get()?.plugins;
    return normalizeStoredPluginState(def, isPlainObject(stored) ? stored[def.id] : null);
  }

  function get(id) {
    const def = definition(id);
    return publicPlugin(def, readState(def.id));
  }

  function list() {
    return [...definitionMap.values()].map((def) => publicPlugin(def, readState(def.id)));
  }

  function isInstalled(id) {
    return readState(id).installed;
  }

  function isEnabled(id) {
    return readState(id).enabled;
  }

  function isActive(id) {
    const state = readState(id);
    return state.installed && state.enabled;
  }

  function config(id) {
    return deepCopy(readState(id).config);
  }

  function emit(id, action, before) {
    const event = { action, plugin: get(id), before: before ? deepCopy(before) : null };
    for (const listener of listeners) {
      try { listener(event); } catch { /* plugin notifications must not break persistence */ }
    }
    return event;
  }

  function update(id, mutate, action) {
    const def = definition(id);
    const before = get(def.id);
    let nextState;
    store.update((draft) => {
      if (!isPlainObject(draft.plugins)) draft.plugins = {};
      const current = normalizeStoredPluginState(def, draft.plugins[def.id]);
      nextState = mutate(current);
      if (!nextState || typeof nextState !== 'object') throw new Error('插件状态更新无效');
      const installed = nextState.installed === true;
      draft.plugins[def.id] = {
        installed,
        enabled: installed && nextState.enabled === true,
        config: normalizePluginConfig(def, nextState.config),
      };
    });
    return emit(def.id, action, before).plugin;
  }

  function install(id) {
    return update(id, (current) => ({ ...current, installed: true, enabled: false }), 'install');
  }

  function uninstall(id) {
    const def = definition(id);
    // 当前市场插件代码随应用发布，卸载表示移除安装状态并停止运行；
    // 后续第三方插件也复用同一入口，由宿主负责清理其安装目录。
    return update(def.id, (current) => ({ ...current, installed: false, enabled: false }), 'uninstall');
  }

  function setEnabled(id, enabled) {
    const wantEnabled = enabled === true;
    return update(id, (current) => {
      if (!current.installed && wantEnabled) throw new Error('请先安装插件');
      return { ...current, enabled: wantEnabled };
    }, wantEnabled ? 'enable' : 'disable');
  }

  function setConfig(id, rawConfig) {
    const def = definition(id);
    if (def.id === 'custom-imagegen') {
      return update(def.id, (current) => ({
        ...current,
        config: normalizePluginConfig(def, {
          ...rawConfig,
          apiKey: String(rawConfig?.apiKey || '').trim() || current.config.apiKey,
        }),
      }), 'configure');
    }
    const config = normalizePluginConfig(def, rawConfig, {
      strict: def.id === 'provider-balance',
      validProviderIds: store.providers().map((provider) => provider.id),
    });
    return update(def.id, (current) => ({ ...current, config }), 'configure');
  }

  function onChange(callback) {
    if (typeof callback !== 'function') return () => {};
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  return {
    list,
    get,
    install,
    uninstall,
    setEnabled,
    setConfig,
    config,
    isInstalled,
    isEnabled,
    isActive,
    onChange,
    definitions: () => [...definitionMap.values()].map((def) => ({ ...def, defaultConfig: deepCopy(def.defaultConfig) })),
  };
}

module.exports = {
  BUILTIN_PLUGIN_DEFINITIONS,
  DEFAULT_USAGE_METRICS,
  DEFAULT_BALANCE_CONFIG,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_VOICE_SPACE_HOLD_MS,
  MAX_VOICE_SPACE_HOLD_MS,
  MIN_VOICE_SPACE_HOLD_MS,
  createPluginManager,
  normalizePluginConfig,
  normalizeImageConfig,
  DEFAULT_IMAGE_CONFIG,
  normalizeVoiceConfig,
  normalizeVoiceSpaceHoldMs,
  normalizeBalanceConfig,
};

