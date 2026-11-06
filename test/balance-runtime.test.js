'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBalanceDelta, subtractDecimal, compareDecimal, createBalanceRuntime } = require('../src/core/balance-runtime.js');

test('balance interval delta uses exact decimal arithmetic and resets unsafe baselines', () => {
  assert.equal(subtractDecimal('1.0000001', '1'), '0.0000001');
  assert.equal(compareDecimal('0.0000001', '0'), 1);
  assert.deepEqual(computeBalanceDelta(null, { balance: '9.99', currency: 'USD', unit: 'USD' }), { kind: 'baseline', delta: null });
  assert.deepEqual(computeBalanceDelta(
    { balance: '9.99', totalUsed: '1.0000001', currency: 'USD', unit: 'USD' },
    { balance: '9.88', totalUsed: '1.0000002', currency: 'USD', unit: 'USD' },
  ), { kind: 'cumulative', delta: '0.0000001' });
  assert.deepEqual(computeBalanceDelta(
    { balance: '9.99', totalUsed: '2', currency: 'USD', unit: 'USD' },
    { balance: '9.88', totalUsed: '1', currency: 'USD', unit: 'USD' },
  ), { kind: 'reset', delta: null });
  assert.deepEqual(computeBalanceDelta(
    { balance: '9.99', totalUsed: null, currency: 'USD', unit: 'USD' },
    { balance: '9.88', totalUsed: null, currency: 'USD', unit: 'USD' },
  ), { kind: 'net-balance-change', delta: '0.11' });
  assert.deepEqual(computeBalanceDelta(
    { balance: '9.99', totalUsed: null, currency: 'USD', unit: 'USD' },
    { balance: '10.10', totalUsed: null, currency: 'USD', unit: 'USD' },
  ), { kind: 'credit-or-unknown', delta: null });
  assert.deepEqual(computeBalanceDelta(
    { balance: '9.99', totalUsed: '1', currency: 'USD', unit: 'USD' },
    { balance: '9.88', totalUsed: '2', currency: '额度', unit: '额度' },
  ), { kind: 'reset', delta: null });
  assert.deepEqual(computeBalanceDelta(
    { balance: '9.99', totalUsed: '1', totalUsedUnit: '额度', accountScope: 'key A', currency: 'USD', unit: 'USD' },
    { balance: '9.88', totalUsed: '2', totalUsedUnit: '额度', accountScope: 'key B', currency: 'USD', unit: 'USD' },
  ), { kind: 'reset', delta: null });
});

test('balance refresh runtime isolates providers, merges concurrent reads, and keeps secrets out of snapshots', async () => {
  const providers = new Map([
    ['a', { id: 'a', baseUrl: 'https://a/v1', apiKey: 'key-a', models: [] }],
    ['b', { id: 'b', baseUrl: 'https://b/v1', apiKey: 'key-b', models: [] }],
  ]);
  const store = { getProvider: (id) => providers.get(id) };
  const calls = [];
  const responses = new Map([
    ['a', [{ balance: '10', currency: 'USD', unit: 'USD', totalUsed: '1' }, { balance: '9.5', currency: 'USD', unit: 'USD', totalUsed: '1.5' }]],
    ['b', [{ balance: '20', currency: 'USD', unit: 'USD', totalUsed: '4' }]],
  ]);
  const pending = new Map();
  const client = { read: ({ provider, adapter }) => {
    calls.push({ providerId: provider.id, adapter });
    return new Promise((resolve) => pending.set(provider.id, () => resolve(responses.get(provider.id).shift())));
  } };
  const updates = [];
  const runtime = createBalanceRuntime({ store, client, now: () => 1000, onUpdate: (event) => updates.push(event) });
  runtime.configure({ providers: [{ providerId: 'a', adapter: 'sub2api' }, { providerId: 'b', adapter: 'newapi' }], refreshIntervalSeconds: 60 });
  runtime.setCurrentProvider('a');
  const firstA = runtime.refresh('a', { reason: 'manual' });
  const coalesced = runtime.refresh('a', { reason: 'timer' });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  pending.get('a')();
  const [baselineA, mergedA] = await Promise.all([firstA, coalesced]);
  assert.equal(mergedA, baselineA);
  assert.equal(baselineA.delta, null);

  const firstB = runtime.refresh('b', { reason: 'manual' });
  await Promise.resolve();
  pending.get('b')();
  await firstB;
  const secondA = runtime.refresh('a', { reason: 'timer' });
  await Promise.resolve();
  pending.get('a')();
  const resultA = await secondA;
  assert.equal(resultA.delta, '0.5');
  assert.equal(resultA.deltaKind, 'cumulative');
  const snapshots = runtime.getSnapshots();
  assert.equal(snapshots.a.balance, '9.5');
  assert.equal(snapshots.b.balance, '20');
  assert.equal(JSON.stringify(snapshots).includes('key-a'), false);
  assert.equal(JSON.stringify(snapshots).includes('baseUrl'), false);
  assert.equal(updates.filter((event) => event.providerId === 'a').length, 2);
  runtime.stop();
});

test('balance runtime resets baseline when provider credentials change and hides the old snapshot', async () => {
  const provider = { id: 'a', baseUrl: 'https://a/v1', apiKey: 'first-key', headers: {} };
  const values = [
    { balance: '10', currency: 'USD', unit: 'USD', totalUsed: '1' },
    { balance: '9', currency: 'USD', unit: 'USD', totalUsed: '9' },
  ];
  const runtime = createBalanceRuntime({ store: { getProvider: () => provider }, client: { read: async () => values.shift() } });
  runtime.configure({ providers: [{ providerId: 'a', adapter: 'sub2api' }], refreshIntervalSeconds: 60 });
  runtime.setCurrentProvider('a');
  await runtime.refresh('a');
  provider.apiKey = 'second-key';
  assert.equal(runtime.getSnapshots().a, undefined, 'do not expose a snapshot for credentials that are no longer current');
  const changed = await runtime.refresh('a');
  assert.equal(changed.deltaKind, 'baseline');
  assert.equal(changed.delta, null);
  runtime.stop();
});

test('balance runtime honors Retry-After and aborts in-flight reads on stop', async () => {
  let clock = 1000;
  const timers = [];
  const cleared = [];
  let calls = 0;
  let rejectRead;
  const runtime = createBalanceRuntime({
    store: { getProvider: () => ({ id: 'a', baseUrl: 'https://a/v1', apiKey: 'secret' }) },
    client: { read: ({ signal }) => {
      calls += 1;
      if (calls === 1) return Promise.reject(Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', retryAfterMs: 120000 }));
      return new Promise((_resolve, reject) => {
        rejectRead = reject;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    } },
    now: () => clock,
    setTimeoutImpl: (fn, ms) => { const token = { fn, ms }; timers.push(token); return token; },
    clearTimeoutImpl: (token) => cleared.push(token),
  });
  runtime.configure({ providers: [{ providerId: 'a', adapter: 'sub2api' }], refreshIntervalSeconds: 60 });
  runtime.setCurrentProvider('a');
  const limited = await runtime.refresh('a');
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(timers.at(-1).ms, 120000);
  const paused = await runtime.refresh('a');
  assert.equal(paused.code, 'RATE_LIMITED');
  assert.equal(calls, 1);
  clock += 120000;
  const pending = runtime.refresh('a');
  await Promise.resolve();
  assert.equal(calls, 2);
  runtime.stop();
  const late = await pending;
  assert.equal(late.code, 'STALE');
  assert.equal(runtime.getSnapshots().a, undefined);
  void rejectRead;
});

test('balance runtime schedules only the selected provider and stop cancels timer', async () => {
  const timers = [];
  const cleared = [];
  const runtime = createBalanceRuntime({
    store: { getProvider: () => ({ id: 'a', apiKey: 'secret' }) },
    client: { read: async () => ({ balance: '1', currency: 'USD', unit: 'USD', totalUsed: '0' }) },
    setTimeoutImpl: (fn, ms) => { const token = { fn, ms }; timers.push(token); return token; },
    clearTimeoutImpl: (token) => cleared.push(token),
  });
  runtime.configure({ providers: [{ providerId: 'a', adapter: 'sub2api' }, { providerId: 'b', adapter: 'newapi' }], refreshIntervalSeconds: 60 });
  assert.equal(timers.length, 0);
  runtime.setCurrentProvider('a');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  runtime.stop();
  assert.equal(cleared.length, 1);
  assert.deepEqual(runtime.getSnapshots(), {}, '停用后清除旧快照，重新启用时重新建立基线');
});
