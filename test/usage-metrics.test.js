'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUsageStatuslineStyle, computeUsageSnapshot, formatTokenRate, mergeUsageCacheEntry } = require('../src/core/usage-metrics.js');

test('token rate is displayed with one decimal place without rounding the measured value early', () => {
  assert.equal(formatTokenRate(null), '--');
  assert.equal(formatTokenRate(42.36), '42.4');
  assert.equal(formatTokenRate(0.04), '0.0');
});

test('usage snapshot uses the latest request instead of mixing a whole turn', () => {
  const t = '2026-10-29T02:00:00.000Z';
  const events = [
    { t: '2026-10-29T01:59:58.000Z', turn_id: 'turn_1', turn_output_tokens: 10, input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110, context_window: 1000 },
    { t, turn_id: 'turn_1', turn_output_tokens: 30, input_tokens: 300, cached_input_tokens: 150, output_tokens: 20, total_tokens: 320, context_window: 1000 },
  ];
  const request = {
    at: Date.parse(t) + 500,
    speed: 42,
    inputTokens: 300,
    cachedInputTokens: 150,
    outputTokens: 20,
    totalTokens: 320,
    cacheUsageAvailable: true,
    estimatedUsage: false,
  };

  const value = computeUsageSnapshot(events, request, Date.parse(t) + 1000);
  assert.equal(value.speed, 42);
  assert.equal(value.cache, 50);
  assert.equal(value.context, 32);
  assert.equal(value.window, 1000);
  assert.equal(value.speedEstimated, false);
  assert.equal(value.cacheEstimated, false);
  assert.equal(value.contextEstimated, false);
});

test('usage snapshot keeps unavailable cache data unavailable instead of reporting zero', () => {
  const t = '2026-10-29T02:00:00.000Z';
  const events = [{
    t, turn_id: 'turn_1', turn_output_tokens: 20, input_tokens: 300,
    cached_input_tokens: 0, output_tokens: 20, total_tokens: 320, context_window: 1000,
  }];
  const request = {
    at: Date.parse(t), speed: 10, inputTokens: 300, cachedInputTokens: 0,
    outputTokens: 20, totalTokens: 320, cacheUsageAvailable: false,
  };

  const value = computeUsageSnapshot(events, request, Date.parse(t) + 1000);
  assert.equal(value.cache, null);
  assert.equal(value.context, 32);
});

test('usage snapshot includes cache writes in total input and rejects inconsistent counts', () => {
  const t = '2026-10-29T02:00:00.000Z';
  const valid = computeUsageSnapshot([], {
    at: Date.parse(t), speed: 12.34, speedAvailable: true,
    inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 10,
    cacheUsageAvailable: true,
  }, Date.parse(t));
  assert.equal(valid.cache, 30);
  assert.equal(valid.speed, 12.34);

  const invalid = computeUsageSnapshot([], {
    at: Date.parse(t), inputTokens: 100, cachedInputTokens: 95,
    cacheWriteTokens: 10, cacheUsageAvailable: true,
  }, Date.parse(t));
  assert.equal(invalid.cache, null, '缓存读取与写入之和超过输入时不能伪造命中率');
});

test('usage snapshot derives context total when rollout omits total_tokens', () => {
  const t = '2026-10-29T02:00:00.000Z';
  const value = computeUsageSnapshot([{
    t, turn_id: 'turn_1', turn_output_tokens: 20, input_tokens: 100,
    cached_input_tokens: 40, output_tokens: 20, total_tokens: 0, context_window: 1000,
  }], null, Date.parse(t) + 1000);

  assert.equal(value.context, 12);
  assert.equal(value.cache, 40);
  assert.equal(value.cacheEstimated, true);
});

test('estimated gateway usage retains context but cannot supply a precise token rate', () => {
  const t = '2026-10-29T02:00:00.000Z';
  const value = computeUsageSnapshot([{ t, turn_id: 'turn_1', context_window: 1000 }], {
    at: Date.parse(t), speed: 30, inputTokens: 200, cachedInputTokens: 0,
    outputTokens: 30, totalTokens: 230, cacheUsageAvailable: false, estimatedUsage: true,
  }, Date.parse(t) + 1000);

  assert.equal(value.speed, null);
  assert.equal(value.cache, null);
  assert.equal(value.context, 23);
  assert.equal(value.speedEstimated, false);
  assert.equal(value.contextEstimated, true);
});

test('an explicitly unavailable request speed does not fall back to rollout estimates', () => {
  const start = Date.parse('2026-10-29T02:00:00.000Z');
  const events = [
    { t: new Date(start).toISOString(), turn_id: 'turn_1', turn_output_tokens: 10, input_tokens: 100, output_tokens: 10, total_tokens: 110, context_window: 1000 },
    { t: new Date(start + 1000).toISOString(), turn_id: 'turn_1', turn_output_tokens: 20, input_tokens: 100, output_tokens: 20, total_tokens: 120, context_window: 1000 },
  ];
  const request = {
    at: start + 1500,
    speed: null,
    speedAvailable: false,
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 20,
    totalTokens: 120,
    cacheUsageAvailable: false,
  };

  const value = computeUsageSnapshot(events, request, start + 2000);
  assert.equal(value.speed, null, '明确不可用的网关速度不能回退到误导性的估算值');
});

test('a newly completed request is shown before its rollout event is written', () => {
  const stale = '2026-10-29T02:00:00.000Z';
  const events = [{
    t: stale, turn_id: 'turn_1', turn_output_tokens: 10, input_tokens: 100,
    cached_input_tokens: 40, output_tokens: 10, total_tokens: 110, context_window: 1000,
  }];
  const request = {
    at: Date.parse(stale) + 30000,
    speed: 25,
    inputTokens: 400,
    cachedInputTokens: 300,
    outputTokens: 50,
    totalTokens: 450,
    cacheUsageAvailable: true,
  };

  const value = computeUsageSnapshot(events, request, Date.parse(stale) + 31000);
  assert.equal(value.speed, 25);
  assert.equal(value.cache, 75);
  assert.equal(value.context, 45);
});

test('usage statusline style never dims stale or empty state', () => {
  const css = buildUsageStatuslineStyle();
  assert.match(css, /opacity:1!important/);
  assert.match(css, /color:var\(--color-token-text-primary,#000\)!important/);
  assert.match(css, /html\[data-theme="light"\] #gptplus-codex-usage-statusline.*color:#000!important/);
  assert.doesNotMatch(css, /opacity:\.55/);
  assert.doesNotMatch(css, /color-mix/);
});

test('usage statusline reserves stable columns while balance deltas pop out beside the value', () => {
  const css = buildUsageStatuslineStyle(4);
  assert.match(css, /display:grid/);
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /justify-self:center/);
  assert.match(css, /gptplus-balance-delta\{position:absolute;left:100%/);
});

test('request-only bridge updates preserve the last rollout events', () => {
  const previous = { events: [{ t: '2026-10-29T02:00:00.000Z', input_tokens: 100 }], request: { speed: 10 } };
  const nextRequest = { speed: 25, at: Date.now() };
  const merged = mergeUsageCacheEntry(previous, null, nextRequest);
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].input_tokens, 100);
  assert.equal(merged.request, nextRequest);

  const first = mergeUsageCacheEntry(undefined, null, nextRequest);
  assert.deepEqual(first.events, []);
  assert.equal(first.request, nextRequest);
});


test('a newer rollout request cannot borrow speed or cache from a nearby older request', () => {
  const at = Date.parse('2026-11-04T02:00:00Z');
  const events = [{ t: new Date(at + 1000).toISOString(), input_tokens: 200,
    cached_input_tokens: 50, cache_usage_available: true, output_tokens: 40,
    total_tokens: 240, context_window: 1000 }];
  const result = computeUsageSnapshot(events, {
    at, speed: 72.35, inputTokens: 100, cachedInputTokens: 90,
    outputTokens: 20, totalTokens: 120, cacheUsageAvailable: true,
  }, at + 2000);
  assert.equal(result.speed, null);
  assert.equal(result.cache, 25);
  assert.equal(result.context, 24);
});

test('request-completion intervals are not token generation intervals', () => {
  const events = [
    { t: '2026-11-04T02:00:00Z', turn_id: 'turn_1', turn_output_tokens: 10, output_tokens: 10 },
    { t: '2026-11-04T02:00:01Z', turn_id: 'turn_1', turn_output_tokens: 110, output_tokens: 100 },
  ];
  assert.equal(computeUsageSnapshot(events, null).speed, null,
    'rollout only contains completed requests and includes tool/queue/prefill time');
});

test('a contradictory unavailable speed flag wins over a populated speed value', () => {
  assert.equal(computeUsageSnapshot([], { speed: 42.35, speedAvailable: false }).speed, null);
});

test('rollout explicit zero cache hits are valid but unavailable data stays unknown', () => {
  const event = { t: '2026-11-04T02:00:00Z', input_tokens: 100,
    cached_input_tokens: 0, output_tokens: 10, cache_usage_available: true };
  const zero = computeUsageSnapshot([event], null);
  assert.equal(zero.cache, 0);
  assert.equal(zero.cacheEstimated, false);
  assert.equal(computeUsageSnapshot([{ ...event, cached_input_tokens: 10, cache_usage_available: false }], null).cache, null);
});
