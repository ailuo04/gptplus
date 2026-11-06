'use strict';

const { stripEndpoint } = require('./base-url.js');
const { createSystemProxyFetch } = require('./system-proxy.js');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const ENDPOINTS = Object.freeze({
  sub2api: '/v1/usage',
  newapi: '/api/usage/token/',
});
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function balanceError(message, code, extra = {}) {
  const error = new Error(message);
  error.name = 'ProviderBalanceError';
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function parseExactJson(text) {
  const source = String(text);
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] || '')) index += 1; };
  const fail = () => { throw balanceError('上游返回的 JSON 格式无效', 'INVALID_JSON'); };

  function parseString() {
    if (source[index] !== '"') fail();
    const start = index++;
    while (index < source.length) {
      const ch = source[index++];
      if (ch === '"') {
        try { return JSON.parse(source.slice(start, index)); } catch { fail(); }
      }
      if (ch === '\\') {
        if (index >= source.length) fail();
        index += 1;
      } else if (ch.charCodeAt(0) < 0x20) fail();
    }
    fail();
  }

  function parseValue(depth = 0) {
    if (depth > 128) fail();
    whitespace();
    const ch = source[index];
    if (ch === '"') return parseString();
    if (ch === '{') {
      index += 1;
      const object = Object.create(null);
      whitespace();
      if (source[index] === '}') { index += 1; return object; }
      while (index < source.length) {
        whitespace();
        const key = parseString();
        whitespace();
        if (source[index++] !== ':') fail();
        object[key] = parseValue(depth + 1);
        whitespace();
        if (source[index] === '}') { index += 1; return object; }
        if (source[index++] !== ',') fail();
      }
      fail();
    }
    if (ch === '[') {
      index += 1;
      const array = [];
      whitespace();
      if (source[index] === ']') { index += 1; return array; }
      while (index < source.length) {
        array.push(parseValue(depth + 1));
        whitespace();
        if (source[index] === ']') { index += 1; return array; }
        if (source[index++] !== ',') fail();
      }
      fail();
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, index)) { index += literal.length; return value; }
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) { index += number[0].length; return number[0]; }
    fail();
  }

  const value = parseValue();
  whitespace();
  if (index !== source.length) fail();
  return value;
}

function decimalString(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  const text = String(value).trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let digits = (match[2] + fraction).replace(/^0+(?=\d)/, '') || '0';
  const scale = fraction.length - exponent;
  if (scale < 0) digits += '0'.repeat(-scale);
  else if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  }
  let [whole, decimals] = digits.split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  if (decimals) decimals = decimals.replace(/0+$/, '');
  const normalized = decimals ? whole + '.' + decimals : whole;
  return match[1] && normalized !== '0' ? '-' + normalized : normalized;
}

function unitInfo(value) {
  const unit = String(value == null ? '' : value).trim();
  if (!unit) return { currency: null, unit: '额度' };
  if (/^[A-Z]{3}$/.test(unit)) return { currency: unit, unit };
  return { currency: null, unit };
}

function sub2ApiTotalUsed(payload, currency) {
  const totalActual = decimalString(payload?.usage?.total?.actual_cost);
  if (totalActual != null) return { value: totalActual, unit: currency || 'USD', accountScope: 'API Key 总计实际费用' };
  const quotaUsed = decimalString(payload?.quota?.used);
  if (quotaUsed != null) return { value: quotaUsed, unit: currency || String(payload?.quota?.unit || payload?.unit || '额度'), accountScope: 'API Key 总额度已用' };
  const totalCost = decimalString(payload?.usage?.total?.cost);
  if (totalCost != null) return { value: totalCost, unit: currency || 'USD', accountScope: 'API Key 总计费用' };
  return { value: null, unit: currency || String(payload?.unit || '额度'), accountScope: '' };
}

function parseSub2ApiUsage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw balanceError('Sub2API 余额响应格式不受支持', 'UNSUPPORTED_RESPONSE');
  if (payload.isValid === false) throw balanceError('Sub2API API Key 当前不可用', 'INVALID_CREDENTIAL');

  const mode = String(payload.mode || '').trim();
  const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota : null;
  const rawBalance = decimalString(quota?.remaining) ?? decimalString(payload.remaining) ?? decimalString(payload.balance);
  if (rawBalance == null) throw balanceError('Sub2API 余额字段缺失或格式不受支持', 'UNSUPPORTED_RESPONSE');

  const info = unitInfo(quota?.unit || payload.unit);
  if (info.unit === '额度') throw balanceError('Sub2API 响应未提供余额单位', 'UNSUPPORTED_RESPONSE');
  const total = sub2ApiTotalUsed(payload, info.currency);
  const scope = mode === 'quota_limited'
    ? 'API Key 额度'
    : String(payload.planName || '').trim() === '钱包余额'
      ? '钱包余额'
      : payload.subscription
        ? `订阅 · ${String(payload.planName || '套餐').trim()}`
        : String(payload.planName || '账户余额').trim();
  return {
    balance: rawBalance,
    currency: info.currency,
    unit: info.unit,
    unlimited: false,
    totalUsed: total.value,
    totalUsedUnit: total.unit,
    accountScope: total.accountScope || scope,
  };
}

function decimalRational(value) {
  const text = decimalString(value);
  if (text == null) return null;
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const fraction = match[3] || '';
  let coefficient = BigInt((match[2] + fraction).replace(/^0+(?=\d)/, '') || '0');
  if (match[1]) coefficient = -coefficient;
  let scale = fraction.length - Number(match[4] || 0);
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

function gcd(a, b) {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right) [left, right] = [right, left % right];
  return left || 1n;
}

function rationalToDecimal(numerator, denominator) {
  if (denominator === 0n) return null;
  const negative = (numerator < 0n) !== (denominator < 0n);
  let num = numerator < 0n ? -numerator : numerator;
  let den = denominator < 0n ? -denominator : denominator;
  const divisor = gcd(num, den);
  num /= divisor;
  den /= divisor;
  let twos = 0;
  let fives = 0;
  while (den % 2n === 0n) { den /= 2n; twos += 1; }
  while (den % 5n === 0n) { den /= 5n; fives += 1; }
  if (den !== 1n) return null;
  const scale = Math.max(twos, fives);
  const scaled = num * (2n ** BigInt(scale - twos)) * (5n ** BigInt(scale - fives));
  let digits = (negative ? -scaled : scaled).toString();
  const isNegative = digits.startsWith('-');
  if (isNegative) digits = digits.slice(1);
  if (scale) { digits = digits.padStart(scale + 1, '0'); digits = digits.slice(0, -scale) + '.' + digits.slice(-scale); }
  let [whole, fraction] = digits.split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  if (fraction) fraction = fraction.replace(/0+$/, '');
  const value = fraction ? whole + '.' + fraction : whole;
  return isNegative && value !== '0' ? '-' + value : value;
}

function convertQuota(value, settings) {
  const raw = decimalString(value);
  if (raw == null) return null;
  const type = String(settings?.quota_display_type || '').toUpperCase();
  const perUnit = decimalRational(settings?.quota_per_unit);
  if (!perUnit || perUnit.coefficient <= 0n || type === 'TOKENS' || !['USD', 'CNY', 'CUSTOM'].includes(type)) return { value: raw, currency: null, unit: '额度' };
  let rate = { coefficient: 1n, scale: 0 };
  let currency = 'USD';
  let unit = 'USD';
  if (type === 'CNY') { rate = decimalRational(settings.usd_exchange_rate); currency = 'CNY'; unit = 'CNY'; }
  else if (type === 'CUSTOM') { rate = decimalRational(settings.custom_currency_exchange_rate); currency = null; unit = String(settings.custom_currency_symbol || '').trim() || '额度'; }
  if (!rate || rate.coefficient <= 0n) return { value: raw, currency: null, unit: '额度' };
  const amount = decimalRational(raw);
  const numerator = amount.coefficient * rate.coefficient * (10n ** BigInt(perUnit.scale));
  const denominator = perUnit.coefficient * (10n ** BigInt(amount.scale + rate.scale));
  const converted = rationalToDecimal(numerator, denominator);
  return converted == null ? { value: raw, currency: null, unit: '额度' } : { value: converted, currency, unit };
}

function parseNewApiUsage(payload, statusPayload = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw balanceError('New API 余额响应格式不受支持', 'UNSUPPORTED_RESPONSE');
  if (payload.code === false) throw balanceError('New API 拒绝了余额查询', 'UPSTREAM_REJECTED');
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  if (data.object && data.object !== 'token_usage') throw balanceError('New API 响应不是 Token 额度信息', 'UNSUPPORTED_RESPONSE');
  const settings = statusPayload?.data && typeof statusPayload.data === 'object' ? statusPayload.data : statusPayload;
  const userQuota = data.user_quota && typeof data.user_quota === 'object' ? data.user_quota : null;
  const rawBalance = decimalString(userQuota?.total_available) ?? decimalString(data.total_available);
  const rawUsed = decimalString(userQuota?.total_used) ?? decimalString(data.total_used);
  const tokenUnlimited = data.unlimited_quota === true;
  if (rawBalance == null && !tokenUnlimited) throw balanceError('New API Token 余额字段缺失或格式不受支持', 'UNSUPPORTED_RESPONSE');
  if (tokenUnlimited) return { balance: null, currency: null, unit: '额度', unlimited: true, totalUsed: null, totalUsedUnit: '额度', accountScope: '不限额 API Key' };
  const balance = convertQuota(rawBalance, settings);
  const used = rawUsed == null ? null : convertQuota(rawUsed, settings);
  const sameUnit = used && balance.currency === used.currency && balance.unit === used.unit;
  return {
    balance: balance.value, currency: balance.currency, unit: balance.unit, unlimited: false,
    totalUsed: sameUnit ? used.value : rawUsed,
    totalUsedUnit: sameUnit ? used.unit : '额度',
    accountScope: userQuota ? '用户额度' : 'API Token',
  };
}

function buildFixedApiPath(baseUrl, path) {
  const clean = stripEndpoint(String(baseUrl == null ? '' : baseUrl).trim()).replace(/\/+$/, '');
  if (!clean) throw balanceError('未配置 Base URL', 'INVALID_BASE_URL');
  let url;
  try { url = new URL(clean); } catch { throw balanceError('Base URL 格式无效', 'INVALID_BASE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw balanceError('Base URL 必须是有效的 HTTP(S) 地址', 'INVALID_BASE_URL');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v\d+(?:[A-Za-z0-9._-]*)?$/i, '');
  url.pathname = url.pathname.replace(/\/+$/, '') + path;
  return url.toString();
}

function buildBalanceUrl(baseUrl, adapter) {
  const endpoint = ENDPOINTS[adapter];
  if (!endpoint) throw balanceError('不支持的 adapter', 'UNSUPPORTED_ADAPTER');
  return buildFixedApiPath(baseUrl, endpoint);
}

function setHeader(headers, name, value) {
  const old = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (old) delete headers[old];
  headers[name] = value;
}

function requestHeaders(provider) {
  const headers = {};
  setHeader(headers, 'Accept', 'application/json');
  if (provider.apiKey) setHeader(headers, 'Authorization', `Bearer ${provider.apiKey}`);
  for (const [rawName, rawValue] of Object.entries(provider.headers || {})) {
    const name = String(rawName).trim();
    if (!name || /[\r\n]/.test(name)) continue;
    const value = String(rawValue == null ? '' : rawValue);
    if (/[\r\n]/.test(value)) continue;
    setHeader(headers, name, value);
  }
  return headers;
}

function retryAfterMs(value, now = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(raw) * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, date - now)) : null;
}

function httpError(response) {
  const status = Number(response.status) || 0;
  const retry = status === 429 ? retryAfterMs(response.headers?.get?.('retry-after')) : null;
  if (status === 401 || status === 403) return balanceError('认证失败，请检查 API Key', 'AUTH_FAILED', { status, retryAfterMs: retry });
  if (status === 404) return balanceError('余额接口不存在，请检查 Base URL 或接口版本', 'ENDPOINT_NOT_FOUND', { status, retryAfterMs: retry });
  if (status === 429) return balanceError('上游限流，已暂缓刷新', 'RATE_LIMITED', { status, retryAfterMs: retry });
  if (status >= 500) return balanceError('上游服务暂时不可用', 'UPSTREAM_ERROR', { status, retryAfterMs: retry });
  return balanceError(`余额查询失败（HTTP ${status || '未知'}）`, 'HTTP_ERROR', { status, retryAfterMs: retry });
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw balanceError('余额响应体过大', 'RESPONSE_TOO_LARGE');
  const chunks = [];
  let total = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        try { await response.body.cancel?.(); } catch { /* response already locked by iterator */ }
        throw balanceError('余额响应体过大', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  } else if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        total += bytes.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw balanceError('余额响应体过大', 'RESPONSE_TOO_LARGE');
        }
        chunks.push(bytes);
      }
    } finally { reader.releaseLock?.(); }
  } else if (typeof response.text === 'function') {
    const text = await response.text();
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > maxBytes) throw balanceError('余额响应体过大', 'RESPONSE_TOO_LARGE');
    return text;
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/** A fixed-route, read-only client. The renderer never supplies a URL or method. */
function createProviderBalanceClient({ fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : createSystemProxyFetch();
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isInteger(Number(maxResponseBytes)) && Number(maxResponseBytes) > 0 ? Number(maxResponseBytes) : DEFAULT_MAX_RESPONSE_BYTES;

  async function read({ provider, adapter, signal: externalSignal } = {}) {
    if (!provider || typeof provider !== 'object') throw balanceError('提供商不存在', 'PROVIDER_NOT_FOUND');
    const url = buildBalanceUrl(provider.baseUrl, adapter);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const fetchJson = async (targetUrl) => {
        const response = await doFetch(targetUrl, { method: 'GET', headers: requestHeaders(provider), signal: controller.signal, redirect: 'error' });
        if (!response?.ok) throw httpError(response || {});
        const text = await readLimitedBody(response, maxBytes);
        try { return parseExactJson(text); }
        catch (error) { if (error?.code === 'INVALID_JSON') throw balanceError('上游返回的 JSON 格式无效', 'INVALID_JSON'); throw error; }
      };
      if (adapter === 'sub2api') return parseSub2ApiUsage(await fetchJson(url));
      const statusUrl = buildFixedApiPath(provider.baseUrl, '/api/status');
      const [payload, statusResult] = await Promise.allSettled([fetchJson(url), fetchJson(statusUrl)]);
      if (payload.status === 'rejected') throw payload.reason;
      return parseNewApiUsage(payload.value, statusResult.status === 'fulfilled' ? statusResult.value : null);
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || controller.signal.aborted) {
        throw balanceError(`余额查询超时（${Math.ceil(timeout / 1000)} 秒）`, 'TIMEOUT');
      }
      if (error?.code) throw error;
      throw balanceError('无法连接中转站，请检查网络或代理设置', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', abortFromCaller);
    }
  }
  return { read };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  buildBalanceUrl,
  buildFixedApiPath,
  createProviderBalanceClient,
  parseExactJson,
  parseSub2ApiUsage,
  parseNewApiUsage,
};
