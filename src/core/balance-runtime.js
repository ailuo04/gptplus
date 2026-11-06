'use strict';

const crypto = require('node:crypto');
const { redactDiagnostic } = require('./redact.js');

function parseDecimal(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error(`无效十进制数: ${text}`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = (whole + fraction).replace(/^0+(?=\d)/, '') || '0';
  return { coefficient: BigInt(digits) * (negative ? -1n : 1n), scale: fraction.length };
}

function formatDecimal(coefficient, scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    const at = digits.length - scale;
    digits = `${digits.slice(0, at)}.${digits.slice(at)}`;
  }
  let [whole, fraction] = digits.split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  if (fraction) fraction = fraction.replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== '0' ? `-${body}` : body;
}

function align(a, b) {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * (10n ** BigInt(scale - left.scale)),
    right: right.coefficient * (10n ** BigInt(scale - right.scale)),
    scale,
  };
}

function subtractDecimal(a, b) {
  const { left, right, scale } = align(a, b);
  return formatDecimal(left - right, scale);
}

function compareDecimal(a, b) {
  const { left, right } = align(a, b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function computeBalanceDelta(previous, next) {
  if (!previous) return { kind: 'baseline', delta: null };
  if (previous.currency !== next.currency || previous.unit !== next.unit
    || previous.totalUsedUnit !== next.totalUsedUnit || previous.accountScope !== next.accountScope) return { kind: 'reset', delta: null };
  if (previous.totalUsed != null && next.totalUsed != null) {
    const delta = subtractDecimal(next.totalUsed, previous.totalUsed);
    return compareDecimal(delta, '0') < 0 ? { kind: 'reset', delta: null } : { kind: 'cumulative', delta };
  }
  if (previous.balance == null || next.balance == null) return { kind: 'credit-or-unknown', delta: null };
  const net = subtractDecimal(previous.balance, next.balance);
  return compareDecimal(net, '0') > 0 ? { kind: 'net-balance-change', delta: net } : { kind: 'credit-or-unknown', delta: null };
}

function fingerprintProvider(provider, adapter) {
  const safe = JSON.stringify({
    id: String(provider?.id || ''),
    baseUrl: String(provider?.baseUrl || ''),
    apiKey: String(provider?.apiKey || ''),
    headers: provider?.headers || {},
    adapter: String(adapter || ''),
  });
  return crypto.createHash('sha256').update(safe).digest('hex');
}

function createBalanceRuntime({ store, client, now = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onUpdate = () => {} } = {}) {
  if (!store || typeof store.getProvider !== 'function') throw new Error('余额运行时需要 provider store');
  if (!client || typeof client.read !== 'function') throw new Error('余额运行时需要 balance client');
  const mappings = new Map();
  const snapshots = new Map();
  const inFlight = new Map();
  const controllers = new Map();
  const pausedUntil = new Map();
  let currentProviderId = '';
  let refreshIntervalSeconds = 60;
  let timer = null;
  let stopped = false;
  let generation = 0;

  function clearTimer() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  }

  function notify(event) {
    try { onUpdate(event); } catch { /* UI listeners must not break refresh */ }
  }

  function publicSnapshot(snapshot) {
    if (!snapshot) return null;
    const { providerFingerprint, ...safe } = snapshot;
    return { ...safe };
  }

  function abortRequests() {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    inFlight.clear();
  }

  function schedule() {
    clearTimer();
    if (stopped || !currentProviderId || !mappings.has(currentProviderId)) return;
    const waitForRateLimit = Math.max(0, (pausedUntil.get(currentProviderId) || 0) - now());
    const delay = Math.max(refreshIntervalSeconds * 1000, waitForRateLimit);
    timer = setTimeoutImpl(() => {
      timer = null;
      if (stopped) return;
      refresh(currentProviderId, { reason: 'timer' }).finally(() => {
        if (!stopped) schedule();
      });
    }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function configure(config = {}) {
    generation += 1;
    abortRequests();
    clearTimer();
    const previousAdapter = currentProviderId ? mappings.get(currentProviderId) : null;
    mappings.clear();
    for (const item of Array.isArray(config.providers) ? config.providers : []) {
      const providerId = String(item?.providerId || '').trim();
      const adapter = String(item?.adapter || '').trim();
      if (!providerId || !['sub2api', 'newapi'].includes(adapter) || mappings.has(providerId)) continue;
      mappings.set(providerId, adapter);
    }
    const candidate = Number(config.refreshIntervalSeconds);
    refreshIntervalSeconds = Number.isInteger(candidate) && candidate >= 10 && candidate <= 86400 ? candidate : 60;
    for (const id of pausedUntil.keys()) if (!mappings.has(id)) pausedUntil.delete(id);
    if (currentProviderId && (!mappings.has(currentProviderId) || mappings.get(currentProviderId) !== previousAdapter)) currentProviderId = '';
    stopped = false;
    schedule();
    return { providers: [...mappings].map(([providerId, adapter]) => ({ providerId, adapter })), refreshIntervalSeconds };
  }

  function setCurrentProvider(providerId) {
    const candidate = String(providerId || '').trim();
    currentProviderId = mappings.has(candidate) ? candidate : '';
    schedule();
    return currentProviderId && mappings.has(currentProviderId) ? currentProviderId : '';
  }

  function refresh(providerId, { reason = 'manual' } = {}) {
    const id = String(providerId || '').trim();
    const adapter = mappings.get(id);
    if (!id || !adapter) return Promise.resolve({ ok: false, providerId: id, error: '当前模型未关联余额提供商', code: 'UNMAPPED' });
    if (stopped) return Promise.resolve({ ok: false, providerId: id, error: '余额插件已停用', code: 'STOPPED' });
    const pauseMs = (pausedUntil.get(id) || 0) - now();
    if (pauseMs > 0) return Promise.resolve({ ok: false, providerId: id, adapter, error: '上游限流，已暂缓刷新', code: 'RATE_LIMITED', retryAfterMs: pauseMs, isCurrent: id === currentProviderId });
    if (inFlight.has(id)) return inFlight.get(id);
    const provider = store.getProvider(id);
    if (!provider) return Promise.resolve({ ok: false, providerId: id, error: '提供商不存在', code: 'PROVIDER_NOT_FOUND' });
    const requestGeneration = generation;
    const providerFingerprint = fingerprintProvider(provider, adapter);
    const controller = new AbortController();
    controllers.set(id, controller);
    const task = Promise.resolve().then(() => client.read({ provider, adapter, signal: controller.signal })).then((value) => {
      if (stopped || requestGeneration !== generation) return { ok: false, providerId: id, ignored: true, code: 'STALE' };
      const previous = snapshots.get(id);
      const comparablePrevious = previous?.providerFingerprint === providerFingerprint ? previous : null;
      const delta = computeBalanceDelta(comparablePrevious, value);
      const snapshot = { providerId: id, adapter, ...value, at: now(), deltaKind: delta.kind, delta: delta.delta, providerFingerprint };
      snapshots.set(id, snapshot);
      pausedUntil.delete(id);
      const result = { ok: true, providerId: id, adapter, reason, ...publicSnapshot(snapshot), isCurrent: id === currentProviderId };
      notify(result);
      return result;
    }).catch((error) => {
      if (stopped || requestGeneration !== generation) return { ok: false, providerId: id, ignored: true, code: 'STALE' };
      const retryAfter = Number(error?.retryAfterMs);
      if (error?.code === 'RATE_LIMITED' && Number.isFinite(retryAfter) && retryAfter > 0) {
        pausedUntil.set(id, now() + retryAfter);
        if (id === currentProviderId) schedule();
      }
      const safeMessage = redactDiagnostic(String(error?.message || '余额刷新失败'), [provider]).slice(0, 240);
      const result = { ok: false, providerId: id, adapter, error: safeMessage, code: error?.code || 'REFRESH_FAILED', retryAfterMs: error?.retryAfterMs ?? null, isCurrent: id === currentProviderId };
      notify(result);
      return result;
    }).finally(() => {
      if (controllers.get(id) === controller) controllers.delete(id);
      if (inFlight.get(id) === task) inFlight.delete(id);
    });
    inFlight.set(id, task);
    return task;
  }

  function refreshCurrent(options = {}) {
    return currentProviderId ? refresh(currentProviderId, options) : Promise.resolve({ ok: false, providerId: '', error: '当前模型未关联余额提供商', code: 'UNMAPPED' });
  }

  function getSnapshots() {
    const out = {};
    for (const [id, value] of snapshots) {
      const provider = mappings.has(id) ? store.getProvider(id) : null;
      if (!provider || fingerprintProvider(provider, mappings.get(id)) !== value.providerFingerprint) continue;
      out[id] = publicSnapshot(value);
    }
    return out;
  }

  function stop() {
    stopped = true;
    generation += 1;
    currentProviderId = '';
    clearTimer();
    abortRequests();
    snapshots.clear();
    pausedUntil.clear();
  }

  return { configure, setCurrentProvider, refresh, refreshCurrent, getSnapshots, stop };
}

module.exports = { parseDecimal, subtractDecimal, compareDecimal, computeBalanceDelta, createBalanceRuntime };
