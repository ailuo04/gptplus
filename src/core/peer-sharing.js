'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const PEER_PROTOCOL_VERSION = 1;
const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 1440;
const PEER_TIMEOUT_MS = 15000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function randomPeerId(prefix) { return String(prefix) + '_' + crypto.randomBytes(12).toString('hex'); }
function hashPeerToken(token) { return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('base64url'); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function peerError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

function normalizePeerBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw peerError('INVALID_URL', '对端地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw peerError('INVALID_URL', '对端地址必须是无凭据的 HTTP 或 HTTPS 地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (net.isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !loopback) throw peerError('INSECURE_URL', '远端连接必须使用 HTTPS；HTTP 仅允许本机回环地址');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/v1') throw peerError('INVALID_URL', '对端地址只能包含主机名或本地网关的 /v1 地址');
  return url.protocol + '//' + url.host;
}

function peerEndpoint(baseUrl, path) { return String(baseUrl).replace(/\/+$/, '') + '/peer/v1/' + path; }
function remoteProviderId(sourceId) {
  const suffix = crypto.createHash('sha256').update(String(sourceId), 'utf8').digest('hex').slice(0, 24);
  return 'remote_' + suffix;
}

function parseSharedModelId(id) {
  const at = String(id || '').indexOf('::');
  return at > 0 && at < String(id).length - 2 ? { providerId: String(id).slice(0, at), modelId: String(id).slice(at + 2) } : null;
}

function createRemoteProviders(config, { includeHidden = false } = {}) {
  const sync = config && config.remoteSync || {};
  const connections = Array.isArray(sync.connections) ? sync.connections : [];
  return (Array.isArray(sync.sources) ? sync.sources : []).map((source) => {
    const connection = connections.find((item) => item.id === source.connectionId);
    return {
      id: remoteProviderId(source.id), name: source.name || '远端来源',
      enabled: true, remote: true,
      sourceId: source.id, connectionId: source.connectionId,
      baseUrl: connection && connection.baseUrl || '', apiKey: '', headers: {}, api: 'responses',
      remoteConnection: connection || null,
      models: (source.models || []).filter((model) => includeHidden || !model.hidden).map((model) => ({
        ...model, id: String(model.providerId) + '::' + String(model.modelId),
        label: model.customLabel || model.label || model.modelId,
        enabled: model.enabled === true, reasoning: model.reasoning === true,
      })),
    };
  });
}

function createPeerManifest(config, providers, now = Date.now()) {
  const sharing = config && config.sharing || {};
  const selected = new Set((sharing.models || []).map((item) => String(item.providerId) + '::' + String(item.modelId)));
  const models = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!provider || provider.remote || provider.enabled === false) continue;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || typeof model.id !== 'string' || model.enabled === false) continue;
      const id = provider.id + '::' + model.id;
      if (!selected.has(id)) continue;
      models.push({ id, providerId: provider.id, modelId: model.id,
        providerName: String(provider.name || provider.id), label: String(model.label || model.id),
        capabilities: { responses: true, streaming: true, reasoning: model.reasoning === true } });
    }
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  const revision = crypto.createHash('sha256').update(JSON.stringify(models), 'utf8').digest('hex');
  return { protocolVersion: PEER_PROTOCOL_VERSION, complete: true,
    source: { id: String(sharing.sourceId || ''), name: String(sharing.name || '我的共享端'), revision, updatedAt: now }, models };
}

function validatePeerManifest(raw) {
  if (!isObject(raw) || raw.protocolVersion !== PEER_PROTOCOL_VERSION || raw.complete !== true
    || !isObject(raw.source) || !Array.isArray(raw.models)) throw peerError('INVALID_MANIFEST', '对端清单无效或不完整');
  const source = raw.source;
  if (typeof source.id !== 'string' || !source.id.trim() || source.id.length > 128
    || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 128
    || typeof source.revision !== 'string' || !source.revision.trim() || source.revision.length > 256
    || !Number.isFinite(Number(source.updatedAt)) || raw.models.length > 10000) {
    throw peerError('INVALID_MANIFEST', '对端来源信息无效');
  }
  const seen = new Set();
  const models = raw.models.map((item) => {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 512
      || typeof item.providerId !== 'string' || !item.providerId.trim() || item.providerId.length > 128
      || typeof item.modelId !== 'string' || !item.modelId.trim() || item.modelId.length > 256
      || typeof item.providerName !== 'string' || item.providerName.length > 128
      || typeof item.label !== 'string' || item.label.length > 512 || !isObject(item.capabilities)) {
      throw peerError('INVALID_MANIFEST', '对端模型清单含无效条目');
    }
    const id = item.providerId + '::' + item.modelId;
    if (item.id !== id || seen.has(id)) throw peerError('INVALID_MANIFEST', '对端模型 ID 重复或不一致');
    const caps = item.capabilities;
    if (Object.keys(caps).some((key) => !['responses', 'streaming', 'reasoning'].includes(key))
      || caps.responses !== true || caps.streaming !== true || typeof caps.reasoning !== 'boolean') {
      throw peerError('INVALID_MANIFEST', '对端模型能力标记无效');
    }
    seen.add(id);
    return { id, providerId: item.providerId, modelId: item.modelId, providerName: item.providerName,
      label: item.label.trim() || item.modelId,
      capabilities: { responses: true, streaming: true, reasoning: caps.reasoning } };
  });
  return { protocolVersion: PEER_PROTOCOL_VERSION, complete: true,
    source: { id: source.id.trim(), name: source.name.trim(), revision: source.revision, updatedAt: Number(source.updatedAt) }, models };
}

function parsePeerFailure(status, body) {
  const code = String(body && body.error && body.error.code || '');
  if (status === 401 || code === 'UNAUTHORIZED') return peerError('UNAUTHORIZED', '对端授权失败或已撤销', 401);
  if (status === 403 || code === 'SHARING_DISABLED') return peerError('SHARING_DISABLED', '对端未开启模型共享', 403);
  if (status === 404) return peerError(code || 'PEER_NOT_FOUND', '对端接口或模型不存在', 404);
  if (status === 426 || code === 'VERSION_UNSUPPORTED') return peerError('VERSION_UNSUPPORTED', '对端协议版本不兼容', 426);
  return peerError(code || 'PEER_REQUEST_FAILED', '对端请求失败（HTTP ' + status + '）', status >= 400 && status < 500 ? status : 502);
}

function createRemoteSync({ store, fetchImpl = globalThis.fetch, onChange = () => {}, timeoutMs = PEER_TIMEOUT_MS } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.update !== 'function' || typeof fetchImpl !== 'function') {
    throw new Error('createRemoteSync 需要 store 和 fetch');
  }
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : PEER_TIMEOUT_MS;
  let timer = null;
  let stopped = false;
  let inFlight = false;

  function saveFailure(connectionId, error) {
    const now = Date.now();
    try {
      store.update((draft) => {
        const connection = draft.remoteSync.connections.find((item) => item.id === connectionId);
        if (connection) { connection.lastAttemptAt = now; connection.lastError = String(error && error.message || '同步失败').slice(0, 240); }
      });
    } catch { /* 保留旧模型清单 */ }
    try { onChange({ connectionId, failed: true }); } catch { /* UI notification only */ }
    return { ok: false, connectionId, error: String(error && error.message || '同步失败').slice(0, 240) };
  }

  async function syncConnection(connectionId) {
    const connection = (store.get().remoteSync.connections || []).find((item) => item.id === connectionId);
    if (!connection) return { ok: false, connectionId, error: '远端连接不存在' };
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), timeout);
    if (typeof requestTimer.unref === 'function') requestTimer.unref();
    let manifest;
    try {
      const response = await fetchImpl(peerEndpoint(connection.baseUrl, 'models'), {
        method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + connection.authToken }, signal: controller.signal,
      });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw peerError('INVALID_MANIFEST', '对端清单超过大小限制');
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!response.ok) throw parsePeerFailure(response.status, body);
      manifest = validatePeerManifest(body);
    } catch (error) {
      const knownCodes = new Set(['INVALID_MANIFEST', 'UNAUTHORIZED', 'SHARING_DISABLED', 'PEER_NOT_FOUND',
        'VERSION_UNSUPPORTED', 'PEER_REQUEST_FAILED', 'INVALID_URL', 'INSECURE_URL', 'TIMEOUT']);
      const safe = error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? peerError('TIMEOUT', '读取对端模型清单超时', 504)
        : error && knownCodes.has(error.code) ? error : peerError('NETWORK_ERROR', '无法连接对端，请检查地址、网络和权限', 502);
      return saveFailure(connectionId, safe);
    } finally { clearTimeout(requestTimer); }

    const now = Date.now();
    const prior = store.get().remoteSync.sources.find((source) => source.id === manifest.source.id);
    const oldIds = new Set((prior && prior.models || []).map((model) => model.id));
    try {
      store.update((draft) => {
        const sync = draft.remoteSync;
        const currentConnection = sync.connections.find((item) => item.id === connectionId);
        if (!currentConnection) throw peerError('CONNECTION_REMOVED', '同步期间连接已删除');
        let source = sync.sources.find((item) => item.id === manifest.source.id);
        if (!source) {
          source = { id: manifest.source.id, name: manifest.source.name, connectionId, revision: '', lastSyncedAt: null, models: [] };
          sync.sources.push(source);
        }
        source.name = manifest.source.name;
        source.connectionId = connectionId;
        source.revision = manifest.source.revision;
        source.lastSyncedAt = now;
        const incoming = new Map(manifest.models.map((model) => [model.id, model]));
        const previous = new Map(source.models.map((model) => [model.id, model]));
        source.models = manifest.models.map((remote) => {
          const local = previous.get(remote.id);
          if (!local) return { id: remote.id, providerId: remote.providerId, modelId: remote.modelId,
            providerName: remote.providerName, label: remote.label, customLabel: '', enabled: false,
            reasoning: remote.capabilities.reasoning, detected: true, isNew: true, hidden: false,
            addedAt: now, lastDetectedAt: now, missingSince: null };
          return { ...local, providerName: remote.providerName,
            label: local.customLabel ? local.label : remote.label, reasoning: remote.capabilities.reasoning,
            detected: true, isNew: false, lastDetectedAt: now, missingSince: null };
        });
        for (const [id, old] of previous) if (!incoming.has(id)) source.models.push({
          ...old, detected: false, isNew: false, missingSince: old.missingSince || now,
        });
        currentConnection.sourceId = source.id;
        currentConnection.lastAttemptAt = now;
        currentConnection.lastSuccessAt = now;
        currentConnection.lastError = '';
      });
      try { onChange({ connectionId, sourceId: manifest.source.id }); } catch { /* ignore listener failures */ }
      return { ok: true, connectionId, sourceId: manifest.source.id, sourceName: manifest.source.name,
        added: manifest.models.filter((model) => !oldIds.has(model.id)).length, count: manifest.models.length, syncedAt: now };
    } catch (error) { return saveFailure(connectionId, error); }
  }

  async function syncAll() {
    if (inFlight) return [];
    inFlight = true;
    try {
      const ids = (store.get().remoteSync.connections || []).filter((connection) => connection.enabled !== false).map((connection) => connection.id);
      const results = [];
      for (const id of ids) results.push(await syncConnection(id));
      return results;
    } finally { inFlight = false; }
  }
  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    const cfg = store.get().remoteSync;
    if (stopped || !cfg.enabled || !cfg.connections.length) return;
    const minutes = Number(cfg.intervalMinutes) || DEFAULT_SYNC_INTERVAL_MINUTES;
    timer = setInterval(() => { void syncAll(); }, minutes * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function start() { stopped = false; schedule(); }
  function configure() { schedule(); }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; }
  return { syncConnection, syncAll, start, configure, stop };
}

module.exports = { PEER_PROTOCOL_VERSION, DEFAULT_SYNC_INTERVAL_MINUTES, MIN_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES, PEER_TIMEOUT_MS, MAX_MANIFEST_BYTES, randomPeerId, hashPeerToken,
  safeEqual, peerError, normalizePeerBaseUrl, peerEndpoint, remoteProviderId, parseSharedModelId, createRemoteProviders,
  createPeerManifest, validatePeerManifest, parsePeerFailure, createRemoteSync };
