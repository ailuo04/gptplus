'use strict';

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

const BUILTIN_PLUGIN_DEFINITIONS = Object.freeze([
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
    id: 'voice-input',
    name: '语音输入',
    version: '1.0.0',
    author: 'gpt++',
    category: '效率',
    icon: 'mic',
    description: '在 ChatGPT 输入框的发送键旁加入麦克风按钮，把语音转成文字。',
    detail: '默认在本机用 SenseVoice 离线识别，不弹出系统语音浮层；在输入框内长按空格 1 秒即可开始录音，松开自动转写，长按时长可调整。也可以改用支持 /audio/transcriptions 的 OpenAI 兼容提供商。',
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

function normalizePluginConfig(definition, raw) {
  if (definition.id === 'usage-statusline') return normalizeUsageConfig(raw);
  if (definition.id === 'voice-input') return normalizeVoiceConfig(raw);
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
    config: deepCopy(state.config),
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
    return update(id, (current) => ({
      ...current,
      config: normalizePluginConfig(definition(id), rawConfig),
    }), 'configure');
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
  DEFAULT_VOICE_CONFIG,
  DEFAULT_VOICE_SPACE_HOLD_MS,
  MAX_VOICE_SPACE_HOLD_MS,
  MIN_VOICE_SPACE_HOLD_MS,
  createPluginManager,
  normalizePluginConfig,
  normalizeVoiceConfig,
  normalizeVoiceSpaceHoldMs,
};

