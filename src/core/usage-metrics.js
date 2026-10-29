'use strict';

const REQUEST_MATCH_MS = 15000;
const STALE_MS = 120000;

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
      matched = requestTime >= latestTime - 15000;
    } else {
      const requestOutput = value(request.outputTokens);
      const latestOutput = value(latest.output_tokens);
      matched = requestOutput !== null && latestOutput !== null && requestOutput === latestOutput;
    }
  }

  function eventSpeed() {
    if (!list.length) return null;
    let start = list.length - 1;
    const turnId = list[start].turn_id;
    if (typeof turnId === 'string' && turnId) {
      while (start > 0 && list[start - 1].turn_id === turnId) start -= 1;
    }
    const intervals = [];
    for (let index = start + 1; index < list.length; index += 1) {
      const before = list[index - 1];
      const current = list[index];
      const delta = (value(current.turn_output_tokens) || 0) - (value(before.turn_output_tokens) || 0);
      const seconds = (Date.parse(current.t) - Date.parse(before.t)) / 1000;
      if (delta <= 0 || seconds < 0.5 || seconds > 120) continue;
      intervals.push({ delta, seconds });
    }
    const recent = intervals.slice(-3);
    const totalSeconds = recent.reduce((sum, item) => sum + item.seconds, 0);
    return totalSeconds > 0 ? recent.reduce((sum, item) => sum + item.delta, 0) / totalSeconds : null;
  }

  const requestSpeedUnavailable = matched && request?.speedAvailable === false;
  const requestSpeed = matched ? value(request && request.speed) : null;
  const fallbackSpeed = requestSpeed === null && !requestSpeedUnavailable ? eventSpeed() : null;
  const speed = requestSpeed !== null && requestSpeed > 0 ? requestSpeed : fallbackSpeed;
  const speedEstimated = requestSpeed !== null
    ? matched && request?.estimatedUsage === true
    : fallbackSpeed !== null;

  const latestInput = latest ? value(latest.input_tokens) : null;
  const latestCached = latest ? value(latest.cached_input_tokens) : null;
  const requestInput = matched ? value(request && request.inputTokens) : null;
  const requestCached = matched ? value(request && request.cachedInputTokens) : null;
  let cache = null;
  let cacheEstimated = false;
  if (matched && request && request.cacheUsageAvailable === true) {
    if (requestInput > 0 && requestCached !== null) cache = percent(Math.min(requestCached, requestInput), requestInput);
  } else if (!(matched && request && request.cacheUsageAvailable === false)) {
    const input = requestInput > 0 ? requestInput : latestInput;
    const cached = requestInput > 0 ? requestCached : latestCached;
    const explicitlyAvailable = requestInput > 0 || latest?.cache_usage_available === true || (cached || 0) > 0;
    if (input > 0 && cached !== null && explicitlyAvailable) {
      cache = percent(Math.min(cached, input), input);
      cacheEstimated = true;
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
  mergeUsageCacheEntry,
};
