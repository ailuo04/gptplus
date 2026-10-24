'use strict';

// 提供商配置的字段级加密导入/导出。
// 新格式是可读 JSON，每个提供商的 baseUrl、apiKey、headers 各自使用系统安全存储加密。
// 该模块保持纯 Node CommonJS，方便在没有 Electron 的单元测试中覆盖。
const crypto = require('node:crypto');
const { normalizeConfig } = require('./store.js');
const { slugForProvider } = require('./model-utils.js');

const FILE_FORMAT = 'gptplus-provider-config';
const FILE_EXTENSION = '.gptplus-providers';
const FILE_VERSION = 3;
const PAYLOAD_VERSION = 2;
const SYSTEM_CIPHER = 'electron-safeStorage';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

class ProviderTransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderTransferError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderTransferError(code, message);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function encode(value) {
  // Base64url 仅用于 JSON 传输，密文由 Electron safeStorage 生成。
  return Buffer.from(value).toString('base64url');
}

function decode(value, label) {
  if (typeof value !== 'string' || !value) fail('INVALID_FILE', `配置文件缺少密文字段 ${label}`);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_FILE', '配置文件的密文字段无效');
  let out;
  try {
    out = Buffer.from(value, 'base64url');
  } catch {
    fail('INVALID_FILE', '配置文件的密文字段无效');
  }
  if (!out.length || encode(out) !== value) fail('INVALID_FILE', '配置文件的密文字段无效');
  return out;
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  fail('INVALID_FILE', '没有收到有效的字段加密配置文件');
}

function fileExtension(name) {
  const raw = String(name == null ? '' : name).replace(/\\/g, '/');
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  return base.toLowerCase().endsWith(FILE_EXTENSION);
}

function assertFileName(name) {
  if (!fileExtension(name)) {
    fail('INVALID_FILE_TYPE', `请选择 ${FILE_EXTENSION} 字段加密配置文件`);
  }
}

function assertFileSize(bytes) {
  if (bytes.length === 0) fail('EMPTY_FILE', '配置文件为空');
  if (bytes.length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', '配置文件超过大小限制');
}

function validateModel(model, providerIndex, modelIndex) {
  if (typeof model === 'string') model = { id: model };
  if (!isPlainObject(model)) fail('INVALID_CONFIG', `第 ${providerIndex} 个提供商的第 ${modelIndex} 个模型无效`);
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) fail('INVALID_CONFIG', `第 ${providerIndex} 个提供商缺少模型 ID`);
  if (model.label !== undefined && typeof model.label !== 'string') {
    fail('INVALID_CONFIG', `第 ${providerIndex} 个提供商的模型显示名无效`);
  }
  if (model.enabled !== undefined && typeof model.enabled !== 'boolean') {
    fail('INVALID_CONFIG', `第 ${providerIndex} 个提供商的模型启用状态无效`);
  }
  if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') {
    fail('INVALID_CONFIG', `第 ${providerIndex} 个提供商的模型推理状态无效`);
  }
  return {
    id,
    label: String(model.label == null ? '' : model.label).trim() || id,
    enabled: model.enabled !== false,
    reasoning: model.reasoning === true,
  };
}

function validateProvider(provider, index, { requireModels = true } = {}) {
  if (!isPlainObject(provider)) fail('INVALID_CONFIG', `第 ${index} 个提供商配置无效`);
  const id = typeof provider.id === 'string' ? provider.id.trim() : '';
  const name = typeof provider.name === 'string' ? provider.name.trim() : '';
  const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : '';
  if (!id) fail('INVALID_CONFIG', `第 ${index} 个提供商缺少 ID`);
  if (!name) fail('INVALID_CONFIG', `第 ${index} 个提供商缺少名称`);
  if (!baseUrl) fail('INVALID_CONFIG', `第 ${index} 个提供商缺少 Base URL`);
  let parsedUrl;
  try {
    parsedUrl = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`);
  } catch {
    fail('INVALID_CONFIG', `第 ${index} 个提供商的 Base URL 无效`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
    fail('INVALID_CONFIG', `第 ${index} 个提供商的 Base URL 无效`);
  }
  // Preserve the existing unauthenticated localhost use case, but reject missing
  // credentials for remote providers. Never include the rejected values in errors.
  if (typeof provider.apiKey !== 'string') fail('INVALID_CONFIG', `第 ${index} 个提供商缺少 API Key 字段`);
  if (!provider.apiKey.trim() && !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
    fail('INVALID_CONFIG', `第 ${index} 个提供商缺少 API Key`);
  }
  const api = provider.api === undefined ? 'openai' : provider.api;
  if (!['openai', 'responses', 'anthropic'].includes(api)) {
    fail('INVALID_CONFIG', `第 ${index} 个提供商的接口协议无效`);
  }
  if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') {
    fail('INVALID_CONFIG', `第 ${index} 个提供商的启用状态无效`);
  }
  const headers = provider.headers === undefined ? {} : provider.headers;
  if (!isPlainObject(headers)) fail('INVALID_CONFIG', `第 ${index} 个提供商的请求头无效`);
  for (const [key, value] of Object.entries(headers)) {
    if (!String(key).trim() || typeof value !== 'string') fail('INVALID_CONFIG', `第 ${index} 个提供商的请求头无效`);
  }
  if (!Array.isArray(provider.models)) fail('INVALID_CONFIG', `第 ${index} 个提供商缺少模型列表`);
  if (requireModels && provider.models.length === 0) fail('INVALID_CONFIG', `第 ${index} 个提供商缺少模型`);

  const models = [];
  const seen = new Set();
  for (let modelIndex = 0; modelIndex < provider.models.length; modelIndex += 1) {
    const model = validateModel(provider.models[modelIndex], index, modelIndex + 1);
    if (seen.has(model.id)) fail('INVALID_CONFIG', `第 ${index} 个提供商包含重复模型 ID`);
    seen.add(model.id);
    models.push(model);
  }
  return {
    id,
    name,
    baseUrl,
    apiKey: provider.apiKey,
    api,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).trim(), value])),
    enabled: provider.enabled !== false,
    models,
  };
}

function validatePayloadV1(payload) {
  if (!isPlainObject(payload)) fail('INVALID_CONFIG', '解密后的配置结构无效');
  if (payload.format !== FILE_FORMAT || payload.version !== PAYLOAD_VERSION) {
    fail('UNSUPPORTED_VERSION', '解密后的配置版本不受支持');
  }
  if (!Array.isArray(payload.providers)) fail('INVALID_CONFIG', '解密后的配置缺少提供商列表');
  if (payload.injectEnabled !== undefined && payload.injectEnabled !== null && typeof payload.injectEnabled !== 'boolean') {
    fail('INVALID_CONFIG', '解密后的注入状态无效');
  }

  const providers = [];
  const ids = new Set();
  for (let index = 0; index < payload.providers.length; index += 1) {
    const provider = validateProvider(payload.providers[index], index + 1);
    if (ids.has(provider.id)) fail('INVALID_CONFIG', '解密后的配置包含重复提供商 ID');
    ids.add(provider.id);
    providers.push(provider);
  }

  const modelOrder = [];
  if (payload.modelOrder !== undefined) {
    if (!Array.isArray(payload.modelOrder) || payload.modelOrder.some((key) => typeof key !== 'string')) {
      fail('INVALID_CONFIG', '解密后的模型顺序无效');
    }
    const validKeys = new Set(providers.flatMap((provider) => provider.models.map((model) => `${provider.id}::${model.id}`)));
    const seen = new Set();
    for (const raw of payload.modelOrder) {
      const key = raw.trim();
      if (!key || seen.has(key) || !validKeys.has(key)) continue;
      seen.add(key);
      modelOrder.push(key);
    }
  }

  let defaultModelRef = null;
  if (payload.defaultModelRef !== undefined && payload.defaultModelRef !== null) {
    if (!isPlainObject(payload.defaultModelRef)
      || typeof payload.defaultModelRef.providerId !== 'string'
      || typeof payload.defaultModelRef.modelId !== 'string') {
      fail('INVALID_CONFIG', '默认模型引用无效');
    }
    const provider = providers.find((item) => item.id === payload.defaultModelRef.providerId);
    const model = provider && provider.models.find((item) => item.id === payload.defaultModelRef.modelId);
    if (!provider || !model) fail('INVALID_CONFIG', '默认模型引用不存在');
    defaultModelRef = { providerId: provider.id, modelId: model.id };
  }

  return {
    format: FILE_FORMAT,
    version: PAYLOAD_VERSION,
    providers,
    modelOrder,
    defaultModelRef,
    injectEnabled: typeof payload.injectEnabled === 'boolean' ? payload.injectEnabled : null,
  };
}

// Dispatch by payload version before normalizing defaults. Future migrations must
// be explicitly registered here; unknown/legacy plaintext formats fail closed.
const PAYLOAD_MIGRATIONS = Object.freeze({ [PAYLOAD_VERSION]: validatePayloadV1 });
function validatePayload(payload) {
  if (!isPlainObject(payload)) fail('INVALID_CONFIG', '解密后的配置结构无效');
  const migrate = Object.hasOwn(PAYLOAD_MIGRATIONS, payload.version) && PAYLOAD_MIGRATIONS[payload.version];
  if (!migrate) fail('UNSUPPORTED_VERSION', '解密后的配置版本不受支持');
  return migrate(payload);
}

function buildDefaultModelRef(config, selectedIds, defaultModel) {
  if (!defaultModel || !isPlainObject(config)) return null;
  const allProviders = Array.isArray(config.providers) ? config.providers : [];
  for (const provider of allProviders) {
    if (!selectedIds.has(provider.id)) continue;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (slugForProvider(provider, model.id, allProviders) === defaultModel) {
        return { providerId: provider.id, modelId: model.id };
      }
    }
  }
  return null;
}

function createExportPayload(config, providerIds = null) {
  const current = isPlainObject(config) ? config : {};
  const allProviders = Array.isArray(current.providers) ? current.providers : [];
  const wanted = providerIds == null
    ? null
    : new Set(Array.isArray(providerIds) ? providerIds.map((id) => String(id).trim()).filter(Boolean) : []);
  if (wanted && [...wanted].some((id) => !allProviders.some((provider) => provider && provider.id === id))) {
    fail('INVALID_CONFIG', '选中的提供商不存在');
  }
  const selected = allProviders.filter((provider) => !wanted || wanted.has(provider && provider.id));
  const selectedIds = new Set(selected.map((provider) => provider.id));
  const providers = selected.map((provider, index) => validateProvider(provider, index + 1));
  const validKeys = new Set(providers.flatMap((provider) => provider.models.map((model) => `${provider.id}::${model.id}`)));
  const modelOrder = (Array.isArray(current.modelOrder) ? current.modelOrder : [])
    .filter((key) => typeof key === 'string' && validKeys.has(key));
  const defaultModel = current.inject && typeof current.inject.defaultModel === 'string'
    ? current.inject.defaultModel
    : null;
  return {
    format: FILE_FORMAT,
    version: PAYLOAD_VERSION,
    providers,
    modelOrder,
    defaultModelRef: buildDefaultModelRef(current, selectedIds, defaultModel),
    // 注入开关是全局状态。部分导出只携带选中的提供商，导入时应保持目标环境的开关。
    injectEnabled: wanted ? null : current.inject && current.inject.enabled === true,
  };
}

function requireSystemStorage(secretStorage) {
  if (!secretStorage || typeof secretStorage.encrypt !== 'function' || typeof secretStorage.decrypt !== 'function') {
    fail('SECURE_STORAGE_UNAVAILABLE', '当前环境缺少系统安全存储，无法保护提供商配置');
  }
  if (typeof secretStorage.isAvailable === 'function') {
    let available = false;
    try { available = secretStorage.isAvailable() === true; } catch { available = false; }
    if (!available) fail('SECURE_STORAGE_UNAVAILABLE', '当前系统安全存储不可用，无法保护提供商配置');
  }
}

function encryptSystemField(secretStorage, fieldName, value) {
  const plaintext = Buffer.from(JSON.stringify({ version: 1, field: fieldName, value }), 'utf8');
  try {
    const encrypted = toBuffer(secretStorage.encrypt(plaintext.toString('utf8')));
    if (!encrypted.length) fail('ENCRYPTION_FAILED', '系统安全存储返回了空密文');
    return encode(encrypted);
  } catch (err) {
    if (err instanceof ProviderTransferError) throw err;
    fail('ENCRYPTION_FAILED', '系统安全存储加密失败，未导出配置');
  } finally {
    plaintext.fill(0);
  }
}

function decryptSystemField(secretStorage, fieldName, value) {
  const encrypted = decode(value, `${fieldName}.ciphertext`);
  try {
    const decoded = JSON.parse(String(secretStorage.decrypt(encrypted)));
    if (!isPlainObject(decoded) || decoded.version !== 1 || decoded.field !== fieldName || !Object.hasOwn(decoded, 'value')) {
      fail('INVALID_FILE', '系统安全存储中的字段密文格式无效');
    }
    return decoded.value;
  } catch (err) {
    if (err instanceof ProviderTransferError) throw err;
    fail('DECRYPT_FAILED', '此文件无法由当前系统账户解密，或文件已损坏');
  }
}

function encryptProviderConfigLocal(payload, secretStorage) {
  requireSystemStorage(secretStorage);
  const valid = validatePayload(payload);
  const providers = valid.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    api: provider.api,
    enabled: provider.enabled,
    models: provider.models,
    secrets: {
      baseUrl: encryptSystemField(secretStorage, 'baseUrl', provider.baseUrl),
      apiKey: encryptSystemField(secretStorage, 'apiKey', provider.apiKey),
      headers: encryptSystemField(secretStorage, 'headers', provider.headers),
    },
  }));
  const envelope = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    encryption: SYSTEM_CIPHER,
    scope: 'current-system-user',
    providers,
    modelOrder: valid.modelOrder,
    defaultModelRef: valid.defaultModelRef,
    injectEnabled: valid.injectEnabled,
  };
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  if (bytes.length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', '配置文件超过大小限制');
  return bytes;
}

function decryptProviderConfigV3({ envelope, secretStorage }) {
  requireSystemStorage(secretStorage);
  if (envelope.encryption !== SYSTEM_CIPHER || envelope.scope !== 'current-system-user') {
    fail('UNSUPPORTED_ALGORITHM', '不支持的系统安全存储格式');
  }
  if (!Array.isArray(envelope.providers)) fail('INVALID_FILE', '配置文件缺少提供商列表');
  const providers = envelope.providers.map((item, idx) => {
    if (!isPlainObject(item) || !isPlainObject(item.secrets)) {
      fail('INVALID_FILE', `第 ${idx + 1} 个提供商的密文格式无效`);
    }
    return {
      id: item.id,
      name: item.name,
      api: item.api,
      enabled: item.enabled,
      models: item.models,
      baseUrl: decryptSystemField(secretStorage, 'baseUrl', item.secrets.baseUrl),
      apiKey: decryptSystemField(secretStorage, 'apiKey', item.secrets.apiKey),
      headers: decryptSystemField(secretStorage, 'headers', item.secrets.headers),
    };
  });
  return validatePayload({
    format: FILE_FORMAT,
    version: PAYLOAD_VERSION,
    providers,
    modelOrder: envelope.modelOrder,
    defaultModelRef: envelope.defaultModelRef,
    injectEnabled: envelope.injectEnabled,
  });
}

function decryptProviderConfig({ fileName, bytes, secretStorage } = {}) {
  assertFileName(fileName);
  const raw = toBuffer(bytes);
  assertFileSize(raw);

  let envelope;
  try {
    envelope = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('INVALID_FILE', '配置文件不是有效的 JSON 格式');
  }
  if (!isPlainObject(envelope)) fail('INVALID_FILE', '配置文件结构无效');
  if (envelope.format !== FILE_FORMAT) fail('INVALID_FILE', '不是 gpt++ 提供商配置文件');
  if (envelope.version !== FILE_VERSION) fail('UNSUPPORTED_VERSION', '不支持的配置文件版本');
  return decryptProviderConfigV3({ envelope, secretStorage });
}

function inspectProviderConfigFile({ fileName, bytes } = {}) {
  assertFileName(fileName);
  const raw = toBuffer(bytes);
  assertFileSize(raw);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_FILE', '配置文件不是有效的 JSON 格式'); }
  if (!isPlainObject(envelope)) fail('INVALID_FILE', '配置文件结构无效');
  if (envelope.format !== FILE_FORMAT) fail('INVALID_FILE', '不是 gpt++ 提供商配置文件');
  if (envelope.version !== FILE_VERSION) {
    fail('UNSUPPORTED_VERSION', '不支持的配置文件版本');
  }
  if (envelope.version === FILE_VERSION && envelope.encryption !== SYSTEM_CIPHER) {
    fail('UNSUPPORTED_ALGORITHM', '不支持的系统安全存储格式');
  }
  return {
    format: FILE_FORMAT,
    version: envelope.version,
    cipher: SYSTEM_CIPHER,
    requiresPassword: false,
    portable: false,
    size: raw.length,
  };
}

function providerNameKey(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

function randomProviderId(usedIds) {
  let id;
  do {
    id = `p_${crypto.randomBytes(4).toString('hex')}`;
  } while (usedIds.has(id));
  return id;
}

function uniqueProviderName(baseName, usedNames) {
  const base = String(baseName || '').trim() || '未命名提供商';
  let candidate = `${base}（导入）`;
  let serial = 2;
  while (usedNames.has(providerNameKey(candidate))) {
    candidate = `${base}（导入 ${serial}）`;
    serial += 1;
  }
  return candidate;
}

function findDefaultRef(config, defaultModel) {
  if (!defaultModel) return null;
  const providers = Array.isArray(config.providers) ? config.providers : [];
  for (const provider of providers) {
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (slugForProvider(provider, model.id, providers) === defaultModel) {
        return { providerId: provider.id, modelId: model.id };
      }
    }
  }
  return null;
}

function createImportPlan({ currentConfig, payload, decisions } = {}) {
  const current = normalizeConfig(currentConfig);
  const validPayload = validatePayload(payload);
  const decisionList = Array.isArray(decisions) ? decisions : [];
  const decisionMap = new Map();
  for (const item of decisionList) {
    if (!isPlainObject(item) || typeof item.sourceId !== 'string' || !['add', 'overwrite', 'skip'].includes(item.action)) {
      fail('INVALID_IMPORT', '导入处理选项无效');
    }
    if (decisionMap.has(item.sourceId)) fail('INVALID_IMPORT', '导入处理选项重复');
    decisionMap.set(item.sourceId, item.action);
  }
  for (const provider of validPayload.providers) {
    if (!decisionMap.has(provider.id)) fail('INVALID_IMPORT', '导入处理选项不完整');
  }
  for (const sourceId of decisionMap.keys()) {
    if (!validPayload.providers.some((provider) => provider.id === sourceId)) {
      fail('INVALID_IMPORT', '导入处理选项包含未知提供商');
    }
  }

  // 空配置是合法的导出结果，但导入它不应清空或改变目标环境的现有状态。
  if (validPayload.providers.length === 0) {
    return {
      config: current,
      counts: { added: 0, overwritten: 0, skipped: 0 },
      sourceTargets: new Map(),
    };
  }

  const next = deepCopy(current);
  const usedIds = new Set(next.providers.map((provider) => provider.id));
  const usedNames = new Set(next.providers.map((provider) => providerNameKey(provider.name)));
  const originalDefaultRef = findDefaultRef(current, current.inject && current.inject.defaultModel);
  const sourceTargets = new Map();
  const overwrittenTargets = new Set();
  let added = 0;
  let overwritten = 0;
  let skipped = 0;

  for (const source of validPayload.providers) {
    const action = decisionMap.get(source.id);
    if (action === 'skip') {
      skipped += 1;
      continue;
    }
    const sameName = next.providers.filter((provider) => providerNameKey(provider.name) === providerNameKey(source.name));
    if (action === 'overwrite' && sameName.length > 1) fail('DUPLICATE_PROVIDER', '本机存在多个同名提供商，请先手动区分名称');
    const existing = sameName[0];
    if (action === 'overwrite') {
      if (!existing) fail('INVALID_IMPORT', '覆盖目标不存在，请重新预览导入配置');
      if (overwrittenTargets.has(existing.id)) fail('DUPLICATE_PROVIDER', '多个导入提供商不能覆盖同一个目标');
      overwrittenTargets.add(existing.id);
      const index = next.providers.findIndex((provider) => provider.id === existing.id);
      next.providers[index] = { ...deepCopy(source), id: existing.id };
      sourceTargets.set(source.id, existing.id);
      overwritten += 1;
      usedNames.add(providerNameKey(source.name));
      continue;
    }

    const imported = deepCopy(source);
    imported.id = usedIds.has(imported.id) ? randomProviderId(usedIds) : imported.id;
    if (usedNames.has(providerNameKey(imported.name))) imported.name = uniqueProviderName(imported.name, usedNames);
    usedIds.add(imported.id);
    usedNames.add(providerNameKey(imported.name));
    next.providers.push(imported);
    sourceTargets.set(source.id, imported.id);
    added += 1;
  }

  // 所有条目都被跳过时，导入是纯 no-op；不要顺带整理模型顺序或全局注入状态。
  if (sourceTargets.size === 0) {
    return {
      config: current,
      counts: { added, overwritten, skipped },
      sourceTargets,
    };
  }

  const changedIds = new Set(sourceTargets.values());
  const oldOrder = Array.isArray(next.modelOrder) ? next.modelOrder : [];
  const order = oldOrder.filter((key) => ![...changedIds].some((id) => key.startsWith(`${id}::`)));
  const mappedOrder = new Map();
  for (const source of validPayload.providers) {
    const targetId = sourceTargets.get(source.id);
    if (!targetId) continue;
    for (const model of source.models) mappedOrder.set(`${source.id}::${model.id}`, `${targetId}::${model.id}`);
  }
  const incoming = [...new Set([
    ...validPayload.modelOrder.map((key) => mappedOrder.get(key)).filter(Boolean),
    ...mappedOrder.values(),
  ])];
  const firstChanged = oldOrder.findIndex((key) => [...changedIds].some((id) => key.startsWith(`${id}::`)));
  order.splice(firstChanged < 0 ? order.length : firstChanged, 0, ...incoming);
  const finalModelKeys = new Set(next.providers.flatMap((provider) => provider.models.map((model) => `${provider.id}::${model.id}`)));
  const seenOrder = new Set();
  next.modelOrder = order.filter((key) => finalModelKeys.has(key) && !seenOrder.has(key) && seenOrder.add(key));
  for (const key of finalModelKeys) if (!seenOrder.has(key)) next.modelOrder.push(key);

  let importedDefault = null;
  if (validPayload.defaultModelRef) {
    const targetId = sourceTargets.get(validPayload.defaultModelRef.providerId);
    if (targetId) {
      const target = next.providers.find((provider) => provider.id === targetId);
      if (target && target.models.some((model) => model.id === validPayload.defaultModelRef.modelId)) {
        importedDefault = slugForProvider(target, validPayload.defaultModelRef.modelId, next.providers);
      }
    }
  }
  if (importedDefault) next.inject.defaultModel = importedDefault;
  else if (originalDefaultRef) {
    const target = next.providers.find((provider) => provider.id === originalDefaultRef.providerId);
    if (target && target.models.some((model) => model.id === originalDefaultRef.modelId)) {
      next.inject.defaultModel = slugForProvider(target, originalDefaultRef.modelId, next.providers);
    } else {
      next.inject.defaultModel = null;
    }
  }
  if (typeof validPayload.injectEnabled === 'boolean') next.inject.enabled = validPayload.injectEnabled;

  return {
    config: next,
    counts: { added, overwritten, skipped },
    sourceTargets,
  };
}

function buildImportPreview(payload, existingProviders) {
  const existing = Array.isArray(existingProviders) ? existingProviders : [];
  return {
    version: PAYLOAD_VERSION,
    providers: payload.providers.map((provider) => {
      const sameName = existing.filter((item) => providerNameKey(item.name) === providerNameKey(provider.name));
      return {
        sourceId: provider.id,
        name: provider.name,
        api: provider.api,
        enabled: provider.enabled,
        hasApiKey: provider.apiKey.length > 0,
        models: provider.models.map((model) => ({
          id: model.id,
          label: model.label,
          enabled: model.enabled,
          reasoning: model.reasoning,
        })),
        duplicate: sameName.length === 1
          ? { id: sameName[0].id, name: sameName[0].name }
          : sameName.length > 1
            ? { multiple: true }
            : null,
      };
    }),
    hasDefaultModel: !!payload.defaultModelRef,
  };
}

function newTransferSessionId() {
  return `imp_${crypto.randomBytes(16).toString('hex')}`;
}

module.exports = {
  FILE_FORMAT,
  FILE_EXTENSION,
  FILE_VERSION,
  PAYLOAD_VERSION,
  MAX_FILE_BYTES,
  createExportPayload,
  encryptProviderConfigLocal,
  decryptProviderConfig,
  inspectProviderConfigFile,
  createImportPlan,
  buildImportPreview,
  newTransferSessionId,
  ProviderTransferError,
};
