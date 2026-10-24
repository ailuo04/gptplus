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
const DEFAULT_STARTUP_TARGET = 'gptplus';
const SECURE_SECRET_VERSION = 1;
const MAX_SECURE_SECRET_BYTES = 1024 * 1024;

const DEFAULT_PROXY_MODE = 'system';
const { DEFAULT_SYNC_INTERVAL_MINUTES, MIN_SYNC_INTERVAL_MINUTES, MAX_SYNC_INTERVAL_MINUTES, randomPeerId } = require('./peer-sharing.js');

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

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('系统安全存储返回了无效数据');
}

function secureStorageError(message, cause) {
  const err = new Error(message);
  err.name = 'StoreSecurityError';
  err.code = 'SECURE_STORAGE_ERROR';
  return err;
}

function decodeSecureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw secureStorageError('本机安全存储中的提供商凭据无效');
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch (err) {
    throw secureStorageError('本机安全存储中的提供商凭据无效', err);
  }
  if (!bytes.length || bytes.length > MAX_SECURE_SECRET_BYTES || bytes.toString('base64url') !== value) {
    throw secureStorageError('本机安全存储中的提供商凭据无效');
  }
  return bytes;
}

function normalizeTheme(raw) {
  return raw === 'light' || raw === 'system' ? raw : DEFAULT_THEME;
}

function normalizeStartupTarget(raw) {
  return raw === 'both' ? 'both' : DEFAULT_STARTUP_TARGET;
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

function normalizeSharing(raw) {
  const src = isPlainObject(raw) ? raw : {};
  let sourceId = typeof src.sourceId === 'string' ? src.sourceId.trim() : '';
  if (!sourceId || sourceId.length > 128) sourceId = randomPeerId('share');
  const clients = [];
  const seen = new Set();
  for (const item of Array.isArray(src.clients) ? src.clients : []) {
    if (!isPlainObject(item)) continue;
    const id = String(item.id || '').trim();
    const tokenHash = String(item.tokenHash || '').trim();
    if (!id || seen.has(id) || !/^[A-Za-z0-9_-]{32,64}$/.test(tokenHash)) continue;
    seen.add(id);
    clients.push({ id, name: String(item.name || '未命名客户端').trim().slice(0, 80) || '未命名客户端', tokenHash,
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : 0 });
  }
  const models = [];
  const modelIds = new Set();
  for (const item of Array.isArray(src.models) ? src.models : []) {
    if (!isPlainObject(item)) continue;
    const providerId = String(item.providerId || '').trim();
    const modelId = String(item.modelId || '').trim();
    const key = providerId + '::' + modelId;
    if (!providerId || !modelId || modelId.length > 256 || modelIds.has(key)) continue;
    modelIds.add(key);
    models.push({ providerId, modelId });
  }
  return { enabled: src.enabled === true, sourceId, name: String(src.name || '我的共享端').trim().slice(0, 128) || '我的共享端', clients, models };
}

function normalizeRemoteSync(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const candidate = Number(src.intervalMinutes);
  const intervalMinutes = Number.isInteger(candidate) && candidate >= MIN_SYNC_INTERVAL_MINUTES && candidate <= MAX_SYNC_INTERVAL_MINUTES
    ? candidate : DEFAULT_SYNC_INTERVAL_MINUTES;
  const connections = [];
  const connectionIds = new Set();
  for (const item of Array.isArray(src.connections) ? src.connections : []) {
    if (!isPlainObject(item)) continue;
    const id = String(item.id || '').trim();
    if (!id || connectionIds.has(id)) continue;
    connectionIds.add(id);
    connections.push({
      id, name: String(item.name || '未命名连接').trim().slice(0, 80) || '未命名连接',
      baseUrl: String(item.baseUrl || '').trim(), authToken: String(item.authToken || ''),
      sourceId: typeof item.sourceId === 'string' ? item.sourceId : null,
      enabled: item.enabled !== false,
      lastAttemptAt: item.lastAttemptAt != null && Number.isFinite(Number(item.lastAttemptAt)) ? Number(item.lastAttemptAt) : null,
      lastSuccessAt: item.lastSuccessAt != null && Number.isFinite(Number(item.lastSuccessAt)) ? Number(item.lastSuccessAt) : null,
      lastError: String(item.lastError || '').slice(0, 240),
    });
  }
  const sources = [];
  const sourceIds = new Set();
  for (const item of Array.isArray(src.sources) ? src.sources : []) {
    if (!isPlainObject(item)) continue;
    const id = String(item.id || '').trim();
    if (!id || sourceIds.has(id)) continue;
    sourceIds.add(id);
    const models = [];
    const seen = new Set();
    for (const model of Array.isArray(item.models) ? item.models : []) {
      if (!isPlainObject(model)) continue;
      const providerId = String(model.providerId || '').trim();
      const modelId = String(model.modelId || '').trim();
      const modelKey = providerId + '::' + modelId;
      if (!providerId || !modelId || modelId.length > 256 || seen.has(modelKey)) continue;
      seen.add(modelKey);
      models.push({
        id: modelKey, providerId, modelId,
        providerName: String(model.providerName || providerId).slice(0, 128),
        label: String(model.label || modelId).slice(0, 512) || modelId,
        customLabel: String(model.customLabel || '').slice(0, 512),
        enabled: model.enabled === true, reasoning: model.reasoning === true,
        detected: model.detected !== false, isNew: model.isNew === true, hidden: model.hidden === true,
        addedAt: Number.isFinite(Number(model.addedAt)) ? Number(model.addedAt) : 0,
        lastDetectedAt: model.lastDetectedAt != null && Number.isFinite(Number(model.lastDetectedAt)) ? Number(model.lastDetectedAt) : null,
        missingSince: model.missingSince != null && Number.isFinite(Number(model.missingSince)) ? Number(model.missingSince) : null,
      });
    }
    sources.push({ id, name: String(item.name || '远端来源').slice(0, 128),
      connectionId: typeof item.connectionId === 'string' ? item.connectionId : null,
      revision: String(item.revision || '').slice(0, 256),
      lastSyncedAt: item.lastSyncedAt != null && Number.isFinite(Number(item.lastSyncedAt)) ? Number(item.lastSyncedAt) : null, models });
  }
  return { enabled: src.enabled === true, intervalMinutes, connections, sources };
}

/** QQ 远程助手配置：NapCat(OneBot 11) 地址/令牌、通知与命令白名单 QQ。 */
function normalizeQqBot(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const cleanText = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  let apiUrl = cleanText(src.apiUrl, 300);
  if (apiUrl && !/^https?:\/\//i.test(apiUrl)) apiUrl = 'http://127.0.0.1:3000';
  apiUrl = apiUrl.replace(/\/+$/, '');
  const cleanQq = (value) => {
    const qq = cleanText(value, 16);
    return /^\d{4,14}$/.test(qq) ? qq : '';
  };
  const progressCandidate = Number(src.progressMinutes);
  const progressMinutes = Number.isInteger(progressCandidate) && progressCandidate >= 1 && progressCandidate <= 120
    ? progressCandidate : 5;
  const webuiPort = Number(src.webuiPort);
  return {
    enabled: src.enabled === true,
    apiUrl: apiUrl || 'http://127.0.0.1:3000',
    accessToken: cleanText(src.accessToken, 256),
    eventToken: cleanText(src.eventToken, 256),
    notifyQq: cleanQq(src.notifyQq),
    ownerQq: cleanQq(src.ownerQq),
    progressMinutes,
    codexPath: cleanText(src.codexPath, 1024),
    workspaceDir: cleanText(src.workspaceDir, 1024),
    autoLaunch: src.autoLaunch === true,
    launchCommand: cleanText(src.launchCommand, 2048),
    launchQq: cleanQq(src.launchQq),
    // NapCat WebUI（app 内扫码登录用）；一键安装时自动写入，不进用户表单
    webuiPort: Number.isInteger(webuiPort) && webuiPort >= 1 && webuiPort <= 65535 ? webuiPort : 0,
    webuiToken: cleanText(src.webuiToken, 128),
  };
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
    const normalizedModel = {
      id: mid,
      label,
      enabled: obj.enabled !== false,
      reasoning: obj.reasoning === true,
    };
    if (obj.isNew === true) normalizedModel.isNew = true;
    if (obj.detected === false) normalizedModel.detected = false;
    if (obj.missingSince != null && Number.isFinite(Number(obj.missingSince))) normalizedModel.missingSince = Number(obj.missingSince);
    models.push(normalizedModel);
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
  const startup = isPlainObject(src.startup) ? src.startup : {};
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
    startup: {
      target: normalizeStartupTarget(startup.target),
    },
    sharing: normalizeSharing(src.sharing),
    remoteSync: normalizeRemoteSync(src.remoteSync),
    qqbot: normalizeQqBot(src.qqbot),
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
    startup: { target: DEFAULT_STARTUP_TARGET },
    sharing: normalizeSharing(null),
    remoteSync: normalizeRemoteSync(null),
    qqbot: normalizeQqBot(null),
    providers: [],
  });
}

/**
 * @param {{ configPath: string, secretStorage?: {
 *   isAvailable?: () => boolean,
 *   encrypt: (text: string) => Buffer|Uint8Array,
 *   decrypt: (bytes: Buffer) => string,
 * } }} opts
 */
function createStore({ configPath, secretStorage = null } = {}) {
  if (!configPath || typeof configPath !== 'string') {
    throw new Error('createStore 需要 configPath');
  }
  const dir = path.dirname(configPath);
  const backupDir = path.join(dir, 'backups');

  function requireSecretStorage() {
    if (!secretStorage) return;
    if (typeof secretStorage.encrypt !== 'function' || typeof secretStorage.decrypt !== 'function') {
      throw secureStorageError('系统安全存储接口不可用，无法保存提供商凭据');
    }
    let available = true;
    if (typeof secretStorage.isAvailable === 'function') {
      try {
        available = secretStorage.isAvailable() === true;
      } catch {
        available = false;
      }
    }
    if (!available) throw secureStorageError('系统安全存储不可用，无法保存提供商凭据');
  }

  function encryptProviderSecrets(provider) {
    requireSecretStorage();
    const clear = JSON.stringify({
      version: SECURE_SECRET_VERSION,
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
      apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : '',
      headers: isPlainObject(provider.headers) ? provider.headers : {},
    });
    let encrypted;
    try {
      encrypted = asBytes(secretStorage.encrypt(clear));
    } catch (err) {
      throw secureStorageError('系统安全存储加密失败，未保存提供商凭据', err);
    }
    if (!encrypted.length || encrypted.length > MAX_SECURE_SECRET_BYTES) {
      throw secureStorageError('系统安全存储返回了无效数据');
    }
    return {
      version: SECURE_SECRET_VERSION,
      // safeStorage 已完成加密；base64url 这里只是 JSON 传输编码。
      ciphertext: encrypted.toString('base64url'),
    };
  }

  function encryptPeerConnection(connection) {
    if (!connection.baseUrl && !connection.authToken) return null;
    requireSecretStorage();
    let encrypted;
    try {
      encrypted = asBytes(secretStorage.encrypt(JSON.stringify({
        version: SECURE_SECRET_VERSION,
        baseUrl: connection.baseUrl,
        authToken: connection.authToken,
      })));
    } catch (err) {
      throw secureStorageError('系统安全存储加密失败，未保存远端连接', err);
    }
    if (!encrypted.length || encrypted.length > MAX_SECURE_SECRET_BYTES) throw secureStorageError('系统安全存储返回了无效数据');
    return { version: SECURE_SECRET_VERSION, ciphertext: encrypted.toString('base64url') };
  }

  function serializeForDisk() {
    const disk = deepCopy(cfg);
    const hasPeerCredentials = disk.remoteSync.connections.some((connection) => connection.baseUrl || connection.authToken);
    if (!secretStorage) {
      if (hasPeerCredentials) throw secureStorageError('系统安全存储不可用，无法保存远端连接');
      return disk;
    }
    requireSecretStorage();
    for (const provider of disk.providers) {
      provider.secret = encryptProviderSecrets(provider);
      delete provider.baseUrl;
      delete provider.apiKey;
      delete provider.headers;
    }
    for (const connection of disk.remoteSync.connections) {
      const secret = encryptPeerConnection(connection);
      if (secret) connection.secret = secret;
      delete connection.baseUrl;
      delete connection.authToken;
    }
    return disk;
  }

  function decodeProviderSecrets(rawProvider) {
    if (!isPlainObject(rawProvider)) return { provider: rawProvider, migrated: false };
    const provider = { ...rawProvider };
    if (!Object.prototype.hasOwnProperty.call(provider, 'secret')) {
      const migrated = ['baseUrl', 'apiKey', 'headers'].some((key) => Object.prototype.hasOwnProperty.call(provider, key));
      return { provider, migrated };
    }
    requireSecretStorage();
    const secret = provider.secret;
    if (!isPlainObject(secret) || secret.version !== SECURE_SECRET_VERSION) {
      throw secureStorageError('本机安全存储中的提供商凭据版本无效');
    }
    const encrypted = decodeSecureBytes(secret.ciphertext);
    let clear;
    try {
      clear = secretStorage.decrypt(encrypted);
    } catch (err) {
      throw secureStorageError('本机安全存储无法解密提供商凭据', err);
    }
    let decoded;
    try {
      decoded = JSON.parse(String(clear));
    } catch (err) {
      throw secureStorageError('本机安全存储中的提供商凭据无效', err);
    }
    if (!isPlainObject(decoded)
      || decoded.version !== SECURE_SECRET_VERSION
      || typeof decoded.baseUrl !== 'string'
      || typeof decoded.apiKey !== 'string'
      || !isPlainObject(decoded.headers)
      || Object.values(decoded.headers).some((value) => typeof value !== 'string')) {
      throw secureStorageError('本机安全存储中的提供商凭据无效');
    }
    provider.baseUrl = decoded.baseUrl;
    provider.apiKey = decoded.apiKey;
    provider.headers = decoded.headers;
    delete provider.secret;
    const migrated = ['baseUrl', 'apiKey', 'headers'].some((key) => Object.prototype.hasOwnProperty.call(rawProvider, key));
    return { provider, migrated };
  }

  function decodeForMemory(raw) {
    if (!isPlainObject(raw)) return { config: raw, migrated: false };
    if (!secretStorage) {
      const hasEncryptedProvider = Array.isArray(raw.providers)
        && raw.providers.some((provider) => isPlainObject(provider) && Object.prototype.hasOwnProperty.call(provider, 'secret'));
      const connections = raw.remoteSync && Array.isArray(raw.remoteSync.connections) ? raw.remoteSync.connections : [];
      const hasPeerCredentials = connections.some((connection) => isPlainObject(connection)
        && (Object.prototype.hasOwnProperty.call(connection, 'secret') || connection.baseUrl || connection.authToken));
      if (hasEncryptedProvider || hasPeerCredentials) throw secureStorageError('需要系统安全存储才能读取加密凭据');
      return { config: raw, migrated: false };
    }
    const config = deepCopy(raw);
    let migrated = false;
    if (Array.isArray(config.providers)) {
      config.providers = config.providers.map((provider) => {
        const decoded = decodeProviderSecrets(provider);
        migrated = migrated || decoded.migrated;
        return decoded.provider;
      });
    }
    const connections = config.remoteSync && Array.isArray(config.remoteSync.connections) ? config.remoteSync.connections : [];
    config.remoteSync = isPlainObject(config.remoteSync) ? config.remoteSync : {};
    config.remoteSync.connections = connections.map((rawConnection) => {
      if (!isPlainObject(rawConnection)) return rawConnection;
      const connection = { ...rawConnection };
      if (!Object.prototype.hasOwnProperty.call(connection, 'secret')
        && (Object.prototype.hasOwnProperty.call(connection, 'baseUrl') || Object.prototype.hasOwnProperty.call(connection, 'authToken'))) {
        migrated = true;
      }
      if (Object.prototype.hasOwnProperty.call(connection, 'secret')) {
        requireSecretStorage();
        const secret = connection.secret;
        if (!isPlainObject(secret) || secret.version !== SECURE_SECRET_VERSION) throw secureStorageError('远端连接凭据版本无效');
        const encrypted = decodeSecureBytes(secret.ciphertext);
        let decoded;
        try { decoded = JSON.parse(String(secretStorage.decrypt(encrypted))); }
        catch (err) { throw secureStorageError('本机安全存储无法解密远端连接', err); }
        if (!isPlainObject(decoded) || decoded.version !== SECURE_SECRET_VERSION
          || typeof decoded.baseUrl !== 'string' || typeof decoded.authToken !== 'string') {
          throw secureStorageError('本机安全存储中的远端连接无效');
        }
        connection.baseUrl = decoded.baseUrl;
        connection.authToken = decoded.authToken;
        delete connection.secret;
        if (rawConnection.baseUrl || rawConnection.authToken) migrated = true;
      }
      return connection;
    });
    return { config, migrated };
  }

  /** @type {any} */
  let cfg = defaultConfig();
  let staging = false;

  function persist() {
    if (staging) return;
    const diskConfig = serializeForDisk();
    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(diskConfig, null, 2) + '\n';
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
    } catch (err) {
      if (secretStorage && err.code !== 'ENOENT') throw secureStorageError('无法读取本机配置，原文件未修改');
      text = null;
    }
    if (text === null) {
      // 首次运行：落盘默认配置，保证 gateway.token 在重启后稳定
      cfg = defaultConfig();
      try {
        persist();
      } catch {
        if (secretStorage) throw secureStorageError('无法安全初始化本机配置存储');
        /* 只读环境下降级为内存配置 */
      }
      return get();
    }
    let migrationPending = false;
    try {
      const decoded = decodeForMemory(JSON.parse(text));
      cfg = normalizeConfig(decoded.config);
      const rawConfig = decoded.config;
      const hasPeerSchema = isPlainObject(rawConfig) && Object.prototype.hasOwnProperty.call(rawConfig, 'sharing')
        && Object.prototype.hasOwnProperty.call(rawConfig, 'remoteSync');
      migrationPending = decoded.migrated || !hasPeerSchema;
      if (migrationPending) {
        // 旧版本配置可能含明文凭据；成功读取后立即改写为系统安全存储格式。
        persist();
        migrationPending = false;
      }
      return get();
    } catch (err) {
      if (migrationPending || err?.code === 'SECURE_STORAGE_ERROR') throw err;
      if (secretStorage) throw secureStorageError('本机配置损坏，原文件未修改，请从加密备份恢复');
      try {
        backupBrokenFile();
      } catch {
        /* 备份失败不应阻塞启动 */
      }
      cfg = defaultConfig();
      try {
        persist();
      } catch {
        if (secretStorage) throw secureStorageError('无法安全重建本机配置存储');
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
    const before = cfg;
    cfg = normalizeConfig(next);
    try {
      persist();
    } catch (err) {
      cfg = before;
      throw err;
    }
    return get();
  }

  /** @param {(draft:any)=>any} fn 就地修改 draft @returns {any} */
  function update(fn) {
    if (typeof fn !== 'function') throw new Error('update 需要一个函数');
    const draft = deepCopy(cfg);
    const result = fn(draft);
    return save(isPlainObject(result) ? result : draft);
  }

  function transaction(next, apply) {
    if (staging || typeof apply !== 'function') throw new Error('无效的配置事务');
    const before = cfg;
    cfg = normalizeConfig(next);
    staging = true;
    try {
      // Injection may update the default model. Those nested writes stay in memory
      // until every synchronous validation and side effect has succeeded.
      const result = apply();
      if (result && typeof result.then === 'function') throw new Error('配置事务必须同步完成');
      staging = false;
      persist();
      return result;
    } catch (err) {
      cfg = before;
      staging = false;
      throw err;
    }
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
    const before = cfg;
    const draft = deepCopy(cfg);
    const wantedId = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : '';
    const index = wantedId ? draft.providers.findIndex((p) => p.id === wantedId) : -1;

    const usedIds = new Set(draft.providers.map((p) => p.id));
    if (index >= 0) usedIds.delete(wantedId);
    const provider = normalizeProvider(src, usedIds);

    if (index >= 0) draft.providers[index] = provider;
    else draft.providers.push(provider);

    cfg = draft;
    try {
      persist();
    } catch (err) {
      cfg = before;
      throw err;
    }
    return deepCopy(provider);
  }

  /** @returns {boolean} 是否真的删除了 */
  function removeProvider(id) {
    const before = cfg;
    const draft = deepCopy(cfg);
    const beforeCount = draft.providers.length;
    draft.providers = draft.providers.filter((p) => p.id !== id);
    const removed = draft.providers.length !== beforeCount;
    if (removed) {
      cfg = draft;
      try {
        persist();
      } catch (err) {
        cfg = before;
        throw err;
      }
    }
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
    transaction,
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
  normalizeQqBot,
  DEFAULT_THEME,
  DEFAULT_PROXY_MODE,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_STARTUP_TARGET,
  normalizeStartupTarget,
};
