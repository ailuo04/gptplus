'use strict';

const REQUEST_MATCH_MS = 15000;
const STALE_MS = 120000;

function formatTokenRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '--';
}

/**
 * 速度和上下文展示最近一次请求，缓存展示当前会话累计值。该函数也被打包进 ChatGPT 页面脚本，
 * 因此必须保持自包含，不能引用模块级变量或 Node API。
 */
function computeUsageSnapshot(events, request, now = Date.now(), cacheTotals) {
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
  const rolloutCache = (event) => {
    const input = value(event?.input_tokens);
    const cached = value(event?.cached_input_tokens);
    const available = event?.cache_usage_available;
    return input > 0 && cached !== null && cached <= input && (available === true || (available !== false && cached > 0))
      ? { input, cached, estimated: available !== true } : null;
  };
  let cacheInput = value(cacheTotals?.inputTokens) ?? 0;
  let cacheHits = value(cacheTotals?.cachedInputTokens) ?? 0;
  let cacheEstimated = false;
  if (!cacheTotals) {
    for (const event of list) {
      const sample = rolloutCache(event);
      if (!sample) continue;
      cacheInput += sample.input;
      cacheHits += sample.cached;
      if (event !== latest) cacheEstimated ||= sample.estimated;
    }
  }
  const latestSample = rolloutCache(latest);
  const requestInput = value(request?.inputTokens);
  const requestCached = value(request?.cachedInputTokens);
  const cacheWrite = request?.cacheWriteTokens === undefined ? 0 : value(request.cacheWriteTokens);
  const requestDuration = value(request?.ms);
  const sameCompletion = matched && latest && requestInput === latestInput
    && value(request?.outputTokens) === value(latest.output_tokens)
    && (requestDuration === null || !(latestTime < requestTime - requestDuration))
    && (!Number.isFinite(requestTime) || !Number.isFinite(latestTime) || Math.abs(requestTime - latestTime) <= 15000);

  // The gateway can arrive before rollout is written. If both describe the
  // same completion, replace its rollout contribution rather than adding it.
  if (matched && request) {
    if (sameCompletion && latestSample) {
      cacheInput -= latestSample.input;
      cacheHits -= latestSample.cached;
    }
    if (request.cacheUsageAvailable !== false && requestInput > 0 && requestCached !== null
      && cacheWrite !== null && requestCached + cacheWrite <= requestInput) {
      cacheInput += requestInput;
      cacheHits += requestCached;
      cacheEstimated ||= request.cacheUsageAvailable !== true || request.estimatedUsage === true;
    }
  }
  if (!cacheTotals && !sameCompletion) cacheEstimated ||= latestSample?.estimated === true;
  const cache = cacheInput > 0 && cacheHits >= 0 && cacheHits <= cacheInput ? cacheHits * 100 / cacheInput : null;

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
  return `#${id}{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px clamp(16px,3vw,28px);box-sizing:border-box;width:100%;margin:6px 0 0;padding:3px 10px;font:inherit;font-size:12px;line-height:17px;color:${textColor};opacity:1!important;user-select:none;cursor:default}`
    + `#${id}[data-hidden="true"]{display:none}`
    + `#${id} .gptplus-usage-item{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;gap:5px;white-space:nowrap;font-variant-numeric:tabular-nums;color:${textColor}!important;opacity:1!important;filter:none!important}`
    + `#${id} .gptplus-usage-value,#${id} .gptplus-usage-item svg{color:${textColor}!important;opacity:1!important;filter:none!important}`
    + `#${id} .gptplus-usage-value{font-weight:500}`
    + `#${id} .gptplus-usage-item svg{flex:0 0 auto}`
    + `#${id} .gptplus-balance-item{position:relative;color:#16803c!important}`
    + `#${id} .gptplus-balance-coin{display:inline-grid;place-items:center;width:13px;height:13px;border:1.4px solid currentColor;border-radius:50%;font-size:9px;line-height:1;font-weight:700;box-sizing:border-box}`
    + `#${id} .gptplus-balance-amount{font-weight:600}`
    + `#${id}-delta{position:fixed;z-index:2147483000;box-sizing:border-box;max-width:calc(100vw - 16px);margin:0;color:#d92d20!important;font-size:12px;line-height:17px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;user-select:none;opacity:1;visibility:visible;transform:translateX(0) scale(1);transform-origin:left center;transition:opacity 180ms ease,transform 220ms cubic-bezier(.2,.8,.2,1),visibility 0s}`
    + `#${id}-delta[data-hidden="true"]{opacity:0;visibility:hidden;transform:translateX(-6px) scale(.85);transition:opacity 180ms ease,transform 180ms ease,visibility 0s 180ms}`
    + `@media(prefers-reduced-motion:reduce){#${id}-delta,#${id}-delta[data-hidden="true"]{transition:none;transform:none}}`
    + `html[data-theme="light"] #${id},html[data-theme="light"] #${id} *{color:#000!important}`;
}

function mergeUsageCacheEntry(previous, events, request, cacheTotals) {
  const hasEvents = Array.isArray(events);
  const hasRequest = request && typeof request === 'object';
  const totals = hasEvents ? cacheTotals : cacheTotals ?? previous?.cacheTotals;
  if (!hasEvents && !hasRequest && !totals && !(previous?.events || []).length) return null;
  return {
    events: hasEvents ? events.slice(-24) : (previous?.events || []),
    request: hasRequest ? request : null,
    cacheTotals: totals,
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
