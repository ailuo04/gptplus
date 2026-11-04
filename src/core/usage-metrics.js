'use strict';

const REQUEST_MATCH_MS = 15000;
const STALE_MS = 120000;

function formatTokenRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '--';
}

/**
 * 状态栏只展示最近一次完整请求的数据。该函数同时被打包进 ChatGPT 页面脚本，
 * 因此必须保持自包含，不能引用模块级变量或 Node API。
 */
function computeUsageSnapshot(events, request, now = Date.now()) {
  const list = Array.isArray(events) ? events.filter((event) => event && typeof event === 'object') : [];
  const latest = list.length ? list[list.length - 1] : null;
  const value = (input) => {
    if (input === null || input === undefined || input === '') return null;
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const percent = (numerator, denominator) => {
    if (!(denominator > 0) || !(numerator >= 0)) return null;
    return Math.min(100, Math.max(0, numerator / denominator * 100));
  };

  const latestTime = latest ? Date.parse(latest.t) : NaN;
  const requestTime = request ? Number(request.at) : NaN;
  let matched = false;
  if (request) {
    if (!latest) matched = true;
    else if (Number.isFinite(latestTime) && Number.isFinite(requestTime)) {
      const sameUsage = value(request.inputTokens) === value(latest.input_tokens)
        && value(request.outputTokens) === value(latest.output_tokens);
      matched = requestTime >= latestTime || (requestTime >= latestTime - 15000 && sameUsage);
    } else {
      const requestOutput = value(request.outputTokens);
      const latestOutput = value(latest.output_tokens);
      matched = requestOutput !== null && latestOutput !== null && requestOutput === latestOutput;
    }
  }

  // token_count is a request-completion snapshot, not per-token telemetry.
  // Inter-request time includes tools/queue/prefill and cannot measure decoding speed.
  const requestSpeed = matched && request?.speedAvailable !== false && request?.estimatedUsage !== true
    ? value(request && request.speed) : null;
  const speed = requestSpeed !== null && requestSpeed > 0 ? requestSpeed : null;
  const speedEstimated = false;

  const latestInput = latest ? value(latest.input_tokens) : null;
  const latestCached = latest ? value(latest.cached_input_tokens) : null;
  const requestInput = matched ? value(request && request.inputTokens) : null;
  const requestCached = matched ? value(request && request.cachedInputTokens) : null;
  let cache = null;
  let cacheEstimated = false;
  if (matched && request && request.cacheUsageAvailable !== false) {
    const cacheWrite = request.cacheWriteTokens === undefined ? 0 : value(request.cacheWriteTokens);
    if (requestInput > 0 && requestCached !== null && cacheWrite !== null && requestCached + cacheWrite <= requestInput) {
      cache = percent(requestCached, requestInput);
      cacheEstimated = request.cacheUsageAvailable !== true || request.estimatedUsage === true;
    }
  } else if (!matched && latest?.cache_usage_available !== false) {
    const available = latest?.cache_usage_available === true || (latestCached || 0) > 0;
    if (latestInput > 0 && latestCached !== null && latestCached <= latestInput && available) {
      cache = percent(latestCached, latestInput);
      cacheEstimated = latest?.cache_usage_available !== true;
    }
  }

  const latestOutput = latest ? value(latest.output_tokens) : null;
  const requestTotal = matched ? value(request && request.totalTokens) : null;
  const latestTotal = latest ? value(latest.total_tokens) : null;
  const inferredTotal = latestInput !== null && latestOutput !== null ? latestInput + latestOutput : null;
  const total = requestTotal > 0 ? requestTotal : latestTotal > 0 ? latestTotal : inferredTotal;
  const window = latest ? value(latest.context_window) || 0 : 0;
  const contextEstimated = total > 0 && matched && request?.estimatedUsage === true;
  const estimated = speedEstimated || cacheEstimated || contextEstimated;

  return {
    speed,
    cache,
    context: percent(total, window),
    stale: Number.isFinite(latestTime) ? now - latestTime > 120000 : false,
    window,
    estimated,
    speedEstimated,
    cacheEstimated,
    contextEstimated,
  };
}

function buildUsageStatuslineStyle() {
  const id = 'gptplus-codex-usage-statusline';
  const textColor = 'var(--color-token-text-primary,#000)';
  return `#${id}{display:flex;align-items:center;justify-content:center;gap:24px;box-sizing:border-box;width:100%;margin:6px 0 0;padding:0 10px;font:inherit;font-size:12px;line-height:17px;color:${textColor};opacity:1!important;user-select:none;cursor:default}`
    + `#${id}[data-hidden="true"]{display:none}`
    + `#${id} .gptplus-usage-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-variant-numeric:tabular-nums;color:${textColor}!important;opacity:1!important;filter:none!important}`
    + `#${id} .gptplus-usage-value,#${id} .gptplus-usage-item svg{color:${textColor}!important;opacity:1!important;filter:none!important}`
    + `#${id} .gptplus-usage-value{font-weight:500}`
    + `#${id} .gptplus-usage-item svg{flex:0 0 auto}`
    + `html[data-theme="light"] #${id},html[data-theme="light"] #${id} *{color:#000!important}`;
}

function mergeUsageCacheEntry(previous, events, request) {
  const hasEvents = Array.isArray(events);
  const hasRequest = request && typeof request === 'object';
  if (!hasEvents && !hasRequest && !(previous?.events || []).length) return null;
  return {
    events: hasEvents ? events.slice(-24) : (previous?.events || []),
    request: hasRequest ? request : null,
  };
}

module.exports = {
  REQUEST_MATCH_MS,
  STALE_MS,
  buildUsageStatuslineStyle,
  computeUsageSnapshot,
  formatTokenRate,
  mergeUsageCacheEntry,
};
