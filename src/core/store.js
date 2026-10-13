'use strict';
// 用户配置读写：~/.gptplus/config.json（磁盘契约见 spec.md 第 4 节）。
// 纯 Node CommonJS，所有路径可注入，方便 node --test 在隔离目录里运行。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const DEFAULT_PORT = 18120;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_THEME = 'dark';
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = null;
const KEEP_BACKUPS = 10;

const DEFAULT_PROXY_MODE = 'system';

function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 32 位 URL 安全随机串 */
function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** p_ + 8 位十六进制 */
function randomProviderId() {
  return 'p_' + crypto.randomBytes(4).toString('hex');
}

/** YYYYMMDD-HHmmss（本地时间） */
function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeTheme(raw) {
  return raw === 'light' || raw === 'system' ? raw : DEFAULT_THEME;
}

function normalizeModelLimits(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const contextCandidate = Number(src.contextWindow);
  const contextWindow = Number.isSafeInteger(contextCandidate) && contextCandidate >= 1024 && contextCandidate <= 100_000_000
    ? contextCandidate
    : DEFAULT_CONTEXT_WINDOW;

  let autoCompactTokenLimit = DEFAULT_AUTO_COMPACT_TOKEN_LIMIT;
  if (src.autoCompactTokenLimit !== null && src.autoCompactTokenLimit !== undefined && String(src.autoCompactTokenLimit).trim() !== '') {
    const compactCandidate = Number(src.autoCompactTokenLimit);
    if (Number.isSafeInteger(compactCandidate) && compactCandidate >= 1024 && compactCandidate <= contextWindow) {
      autoCompactTokenLimit = compactCandidate;
    }
  }

  return { contextWindow, autoCompactTokenLimit };
}

function normalizeModelOrder(raw) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    const key = String(value == null ? '' : value).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeProvider(raw, usedIds) {
  const src = isPlainObject(raw) ? raw : {};
  let id = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : '';
  if (!id || (usedIds && usedIds.has(id))) {
    let candidate = '';
    do {
      candidate = randomProviderId();
    } while (usedIds && usedIds.has(candidate));
    id = candidate;
  }
  if (usedIds) usedIds.add(id);

  const models = [];
  const seen = new Set();
  for (const m of Array.isArray(src.models) ? src.models : []) {
    const mid = String(typeof m === 'string' ? m : (m && m.id) != null ? m.id : '').trim();
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    const obj = isPlainObject(m) ? m : {};
    const label = String(obj.label == null ? '' : obj.label).trim() || mid;
    models.push({
      id: mid,
      label,
      enabled: obj.enabled !== false,
      reasoning: obj.reasoning === true,
    });
  }

  const headers = {};
  if (isPlainObject(src.headers)) {
    for (const [k, v] of Object.entries(src.headers)) {
      const key = String(k).trim();
      if (!key) continue;
      headers[key] = v == null ? '' : String(v);
    }
  }

  return {
    id,
    name: String(src.name == null ? '' : src.name).trim() || '未命名提供商',
    baseUrl: String(src.baseUrl == null ? '' : src.baseUrl).trim(),
    apiKey: src.apiKey == null ? '' : String(src.apiKey),
    api: src.api === 'anthropic' || src.api === 'responses' ? src.api : 'openai',
    headers,
    enabled: src.enabled !== false,
    models,
  };
}

function normalizeConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const g = isPlainObject(src.gateway) ? src.gateway : {};
  const inj = isPlainObject(src.inject) ? src.inject : {};
  const chatgpt = isPlainObject(src.chatgpt) ? src.chatgpt : {};
  const network = isPlainObject(src.network) ? src.network : {};

  let port = Number(g.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULT_PORT;

  const usedIds = new Set();
  const providers = [];
  for (const p of Array.isArray(src.providers) ? src.providers : []) {
    providers.push(normalizeProvider(p, usedIds));
  }

  const version = Number(src.version);
  return {
    version: Number.isFinite(version) && version > 0 ? version : CONFIG_VERSION,
    theme: normalizeTheme(src.theme),
    network: {
      proxyMode: network.proxyMode === 'direct' ? 'direct' : DEFAULT_PROXY_MODE,
    },
    gateway: {
      enabled: g.enabled !== false,
      port,
      host: String(g.host == null ? '' : g.host).trim() || DEFAULT_HOST,
      token: typeof g.token === 'string' ? g.token : randomToken(),
    },
    modelLimits: normalizeModelLimits(src.modelLimits),
    modelOrder: normalizeModelOrder(src.modelOrder),
    inject: {
      enabled: inj.enabled === true,
      catalogPath:
        typeof inj.catalogPath === 'string' && inj.catalogPath.trim() ? inj.catalogPath.trim() : null,
      defaultModel:
        typeof inj.defaultModel === 'string' && inj.defaultModel.trim() ? inj.defaultModel.trim() : null,
    },
    chatgpt: {
      executablePath:
        typeof chatgpt.executablePath === 'string' && chatgpt.executablePath.trim()
          ? chatgpt.executablePath.trim()
          : null,
    },
    providers,
  };
}

function defaultConfig() {
  return normalizeConfig({
    version: CONFIG_VERSION,
    theme: DEFAULT_THEME,
    network: { proxyMode: DEFAULT_PROXY_MODE },
    gateway: { enabled: true, port: DEFAULT_PORT, host: DEFAULT_HOST, token: randomToken() },
    modelLimits: { contextWindow: DEFAULT_CONTEXT_WINDOW, autoCompactTokenLimit: DEFAULT_AUTO_COMPACT_TOKEN_LIMIT },
    modelOrder: [],
    inject: { enabled: false, catalogPath: null, defaultModel: null },
    chatgpt: { executablePath: null },
    providers: [],
  });
}

/**
 * @param {{ configPath: string }} opts
 */
function createStore({ configPath } = {}) {
  if (!configPath || typeof configPath !== 'string') {
    throw new Error('createStore 需要 configPath');
  }
  const dir = path.dirname(configPath);
  const backupDir = path.join(dir, 'backups');

  /** @type {any} */
  let cfg = defaultConfig();

  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(cfg, null, 2) + '\n';
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, configPath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * 选一个"比目录里所有备份都新"的文件名（同一秒内多次备份用补零后缀，
   * 保证按文件名排序 == 按时间排序）。
   */
  function nextBackupTarget(base) {
    let names = [];
    try {
      names = fs.readdirSync(backupDir).filter((n) => n.startsWith('config.json.'));
    } catch {
      names = [];
    }
    const max = names.length ? names.slice().sort()[names.length - 1] : '';
    if (base > max) return path.join(backupDir, base);
    for (let n = 1; ; n += 1) {
      const candidate = `${base}-${String(n).padStart(2, '0')}`;
      if (candidate > max && !fs.existsSync(path.join(backupDir, candidate))) {
        return path.join(backupDir, candidate);
      }
    }
  }

  /** 备份损坏的配置文件（config.json.<stamp>），保留最近 10 份 */
  function backupBrokenFile() {
    const text = fs.readFileSync(configPath, 'utf8');
    fs.mkdirSync(backupDir, { recursive: true });
    const target = nextBackupTarget(`config.json.${stamp()}`);
    fs.writeFileSync(target, text, 'utf8');
    pruneBackups();
    return target;
  }

  function pruneBackups() {
    let names;
    try {
      names = fs.readdirSync(backupDir);
    } catch {
      return;
    }
    const files = names
      .filter((n) => n.startsWith('config.json.'))
      .filter((n) => {
        try {
          return fs.statSync(path.join(backupDir, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      try {
        fs.rmSync(path.join(backupDir, name), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 读取磁盘配置。缺失/损坏时返回默认值；损坏文件先备份再替换。
   * @returns {any} 配置深拷贝
   */
  function load() {
    let text = null;
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      // 首次运行：落盘默认配置，保证 gateway.token 在重启后稳定
      cfg = defaultConfig();
      try {
        persist();
      } catch {
        /* 只读环境下降级为内存配置 */
      }
      return get();
    }
    try {
      cfg = normalizeConfig(JSON.parse(text));
      return get();
    } catch {
      try {
        backupBrokenFile();
      } catch {
        /* 备份失败不应阻塞启动 */
      }
      cfg = defaultConfig();
      try {
        persist();
      } catch {
        /* ignore */
      }
      return get();
    }
  }

  /** @returns {any} 内存快照（深拷贝） */
  function get() {
    return deepCopy(cfg);
  }

  /** @param {any} next @returns {any} */
  function save(next) {
    cfg = normalizeConfig(next);
    persist();
    return get();
  }

  /** @param {(draft:any)=>any} fn 就地修改 draft @returns {any} */
  function update(fn) {
    if (typeof fn !== 'function') throw new Error('update 需要一个函数');
    const draft = deepCopy(cfg);
    const result = fn(draft);
    return save(isPlainObject(result) ? result : draft);
  }

  /** @returns {any[]} */
  function providers() {
    return deepCopy(cfg.providers);
  }

  /** @returns {any|undefined} */
  function getProvider(id) {
    const found = cfg.providers.find((p) => p.id === id);
    return found ? deepCopy(found) : undefined;
  }

  /**
   * 新增或更新提供商。input.id 命中已有条目时更新，否则新增（无 id 时生成 p_<8位>）。
   * @returns {any} 保存后的提供商
   */
  function upsertProvider(input) {
    const src = isPlainObject(input) ? input : {};
    const wantedId = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : '';
    const index = wantedId ? cfg.providers.findIndex((p) => p.id === wantedId) : -1;

    const usedIds = new Set(cfg.providers.map((p) => p.id));
    if (index >= 0) usedIds.delete(wantedId);
    const provider = normalizeProvider(src, usedIds);

    if (index >= 0) cfg.providers[index] = provider;
    else cfg.providers.push(provider);

    persist();
    return deepCopy(provider);
  }

  /** @returns {boolean} 是否真的删除了 */
  function removeProvider(id) {
    const before = cfg.providers.length;
    cfg.providers = cfg.providers.filter((p) => p.id !== id);
    const removed = cfg.providers.length !== before;
    if (removed) persist();
    return removed;
  }

  /** @returns {string} 新的网关 token（不写入，由调用方决定何时保存） */
  function newGatewayToken() {
    return randomToken();
  }

  // 构造即加载：context.js / ipc.js 拿到 store 后可直接 get()/providers()
  load();

  return {
    load,
    get,
    save,
    update,
    providers,
    getProvider,
    upsertProvider,
    removeProvider,
    newGatewayToken,
    // 附加只读信息（非契约字段，方便测试/排障）
    configPath,
    backupDir,
  };
}

module.exports = {
  createStore,
  normalizeConfig,
  normalizeProvider,
  normalizeTheme,
  normalizeModelLimits,
  normalizeModelOrder,
  DEFAULT_THEME,
  DEFAULT_PROXY_MODE,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
};
