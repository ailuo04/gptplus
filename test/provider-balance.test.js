'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  buildBalanceUrl,
  createProviderBalanceClient,
  parseSub2ApiUsage,
  parseNewApiUsage,
  parseExactJson,
} = require('../src/core/provider-balance.js');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function response(status, body, headers = {}) {
  return { status, headers, body };
}

function send(res, fixture) {
  res.writeHead(fixture.status ?? 200, { 'content-type': 'application/json', ...fixture.headers });
  if (fixture.body !== undefined) res.end(typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body));
}

test('provider balance URL builder keeps self-hosted prefix and avoids duplicate version path', () => {
  assert.equal(buildBalanceUrl('https://example.test/v1', 'sub2api'), 'https://example.test/v1/usage');
  assert.equal(buildBalanceUrl('https://example.test/relay/v1', 'sub2api'), 'https://example.test/relay/v1/usage');
  assert.equal(buildBalanceUrl('https://example.test/v1', 'newapi'), 'https://example.test/api/usage/token/');
  assert.equal(buildBalanceUrl('https://example.test/relay/v1', 'newapi'), 'https://example.test/relay/api/usage/token/');
  assert.throws(() => buildBalanceUrl('https://example.test/v1', 'arbitrary'), /adapter/);
});

test('provider balance reader sends one fixed GET with the existing key and custom headers', async () => {
  await withServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/relay/v1/usage');
    assert.equal(req.headers.authorization, 'Bearer synthetic-key');
    assert.equal(req.headers['x-tenant'], 'synthetic-tenant');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.equal(body, '');
      send(res, response(200, {
        mode: 'quota_limited', isValid: true, unit: 'USD',
        quota: { limit: '10.00', used: '1.25', remaining: '8.75', unit: 'USD' },
      }));
    });
  }, async (origin) => {
    const client = createProviderBalanceClient({ fetchImpl: fetch });
    const result = await client.read({
      adapter: 'sub2api',
      provider: { baseUrl: `${origin}/relay/v1`, apiKey: 'synthetic-key', headers: { 'X-Tenant': 'synthetic-tenant' } },
    });
    assert.equal(result.balance, '8.75');
    assert.equal(result.totalUsed, '1.25');
    assert.equal(result.currency, 'USD');
  });
});

test('Sub2API parser handles wallet and subscription remaining without inventing total use', () => {
  const wallet = parseSub2ApiUsage({ mode: 'unrestricted', isValid: true, planName: '钱包余额', remaining: '3.125', balance: '3.125', unit: 'USD' });
  assert.equal(wallet.balance, '3.125');
  assert.equal(wallet.totalUsed, null);
  assert.equal(wallet.accountScope, '钱包余额');

  const subscription = parseSub2ApiUsage({ mode: 'unrestricted', isValid: true, planName: 'Pro', remaining: '12.5', unit: 'USD', subscription: { monthly_limit_usd: '20', monthly_usage_usd: '7.5' } });
  assert.equal(subscription.balance, '12.5');
  assert.equal(subscription.totalUsed, null);
  assert.equal(subscription.accountScope, '订阅 · Pro');

  assert.throws(() => parseSub2ApiUsage({ mode: 'unrestricted', isValid: true, planName: '钱包余额', unit: 'USD' }), /余额字段/);
});

test('New API parser preserves quota integer precision and does not label quota units as currency', () => {
  const parsed = parseNewApiUsage(parseExactJson('{"code":true,"data":{"object":"token_usage","total_granted":9007199254740993123,"total_used":123456,"total_available":9007199254740869667,"unlimited_quota":false}}'));
  assert.equal(parsed.balance, '9007199254740869667');
  assert.equal(parsed.totalUsed, '123456');
  assert.equal(parsed.unit, '额度');
  assert.equal(parsed.currency, null);
  assert.equal(parsed.unlimited, false);
  const exponent = parseNewApiUsage(parseExactJson('{"code":true,"data":{"object":"token_usage","total_available":1e-7,"total_used":2e-7,"unlimited_quota":false}}'));
  assert.equal(exponent.balance, '0.0000001');
  assert.equal(exponent.totalUsed, '0.0000002');

  const unlimited = parseNewApiUsage({ code: true, data: { object: 'token_usage', unlimited_quota: true, total_available: 0, total_used: 0 } });
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.balance, null);
});

test('New API quota converts only when the public currency settings provide an exact scale', () => {
  const usage = parseExactJson('{"code":true,"data":{"object":"token_usage","total_available":1500000,"total_used":250000,"unlimited_quota":false}}');
  const cnyStatus = parseExactJson('{"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"CNY","usd_exchange_rate":7}}');
  const cny = parseNewApiUsage(usage, cnyStatus);
  assert.equal(cny.balance, '21');
  assert.equal(cny.totalUsed, '3.5');
  assert.equal(cny.currency, 'CNY');
  assert.equal(cny.unit, 'CNY');

  const tokenStatus = parseExactJson('{"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"TOKENS"}}');
  const tokens = parseNewApiUsage(usage, tokenStatus);
  assert.equal(tokens.balance, '1500000');
  assert.equal(tokens.unit, '额度');
  assert.equal(tokens.currency, null);
});

test('New API reader uses only its fixed usage and public status GET routes', async () => {
  const paths = [];
  await withServer((req, res) => {
    paths.push(req.url);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer synthetic-key');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.equal(body, '');
      if (req.url === '/relay/api/usage/token/') send(res, response(200, { code: true, data: { object: 'token_usage', total_available: 1500000, total_used: 250000, unlimited_quota: false } }));
      else if (req.url === '/relay/api/status') send(res, response(200, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7 } }));
      else send(res, response(404, { message: 'not found' }));
    });
  }, async (origin) => {
    const client = createProviderBalanceClient({ fetchImpl: fetch });
    const result = await client.read({ adapter: 'newapi', provider: { baseUrl: origin + '/relay/v1', apiKey: 'synthetic-key' } });
    assert.equal(result.balance, '21');
    assert.equal(result.totalUsed, '3.5');
    assert.equal(result.currency, 'CNY');
  });
  assert.deepEqual(paths.sort(), ['/relay/api/status', '/relay/api/usage/token/']);
});

test('balance reader rejects malformed responses safely and enforces response limits and timeout', async () => {
  const provider = { baseUrl: '', apiKey: 'synthetic-secret', headers: { 'X-Secret': 'header-secret' } };
  await withServer((_req, res) => send(res, response(401, { message: 'Bearer synthetic-secret header-secret' })), async (origin) => {
    const client = createProviderBalanceClient({ fetchImpl: fetch });
    await assert.rejects(client.read({ adapter: 'newapi', provider: { ...provider, baseUrl: origin } }), /认证失败/);
  });
  await withServer((_req, res) => send(res, response(200, '{not json')), async (origin) => {
    const client = createProviderBalanceClient({ fetchImpl: fetch });
    await assert.rejects(client.read({ adapter: 'newapi', provider: { ...provider, baseUrl: origin } }), /JSON/);
  });
  await withServer((_req, res) => send(res, response(200, { code: true, data: { object: 'token_usage', total_available: '123456789' } })), async (origin) => {
    const client = createProviderBalanceClient({ fetchImpl: fetch, maxResponseBytes: 32 });
    await assert.rejects(client.read({ adapter: 'newapi', provider: { ...provider, baseUrl: origin } }), /过大/);
  });
  await withServer((_req, res) => setTimeout(() => send(res, response(200, {})), 150), async (origin) => {
    const client = createProviderBalanceClient({ fetchImpl: fetch, timeoutMs: 20 });
    await assert.rejects(client.read({ adapter: 'newapi', provider: { ...provider, baseUrl: origin } }), /超时/);
  });
});
