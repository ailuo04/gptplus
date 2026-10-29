'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUsageStatuslineStyle, computeUsageSnapshot, mergeUsageCacheEntry } = require('../src/core/usage-metrics.js');

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

test('estimated gateway usage is marked without hiding otherwise usable values', () => {
  const t = '2026-10-29T02:00:00.000Z';
  const value = computeUsageSnapshot([{ t, turn_id: 'turn_1', context_window: 1000 }], {
    at: Date.parse(t), speed: 30, inputTokens: 200, cachedInputTokens: 0,
    outputTokens: 30, totalTokens: 230, cacheUsageAvailable: false, estimatedUsage: true,
  }, Date.parse(t) + 1000);

  assert.equal(value.speed, 30);
  assert.equal(value.cache, null);
  assert.equal(value.context, 23);
  assert.equal(value.speedEstimated, true);
  assert.equal(value.contextEstimated, true);
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
