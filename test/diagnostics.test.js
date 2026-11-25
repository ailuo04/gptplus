'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const catalogPath = path.resolve('test-model-catalog.json');
const slugs = ['channel__m1', 'channel__m2'];
const config = [
  'model = "channel__m1"',
  'model_provider = "gptplus"',
  'model_catalog_json = ' + JSON.stringify(catalogPath),
  '[model_providers.gptplus]',
  'base_url = "http://127.0.0.1:18120/v1" # inline comment',
  'wire_api = "responses"',
].join('\n');

function fixture(overrides = {}) {
  return {
    gateway: { getState: () => ({ port: 18120, host: '127.0.0.1' }), probe: async () => ({ ok: true, latencyMs: 4 }) },
    codex: { readText: () => config }, catalogPath, injectionEnabled: true,
    models: slugs.map((slug) => ({ slug, label: slug, enabled: true })),
    readFile: (file) => {
      assert.equal(file, catalogPath);
      return JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: 'list', supported_in_api: true })) });
    },
    listModels: async () => ({ slugs, engine: 'desktop' }),
    ...overrides,
  };
}

test('首页诊断比较配置、网关地址与 Codex 客户端可见模型', async () => {
  const { runHomeDiagnosis } = require('../src/core/diagnostics.js');
  const result = await runHomeDiagnosis(fixture({ listModels: async () => ({ slugs: [slugs[0]], engine: 'desktop' }) }));
  assert.deepEqual(result.steps.map(({ id, state }) => [id, state]), [
    ['gateway', 'ok'], ['injection', 'ok'], ['picker', 'failed'],
  ]);
  assert.match(result.steps[2].detail, /1\/2/);
  assert.deepEqual(result.routableModels, []);
  const healthy = await runHomeDiagnosis(fixture());
  assert.deepEqual(healthy.steps.map((step) => step.state), ['ok', 'ok', 'ok']);
  assert.deepEqual(healthy.routableModels.map((model) => model.slug), slugs);
});

test('首页诊断不会在注入配置指错端口时启动验证进程', async () => {
  const { runHomeDiagnosis } = require('../src/core/diagnostics.js');
  const result = await runHomeDiagnosis(fixture({
    codex: { readText: () => config.replace('18120', '18121') },
    listModels: async () => assert.fail('不应验证过期配置'),
  }));
  assert.equal(result.steps[1].state, 'failed');
  assert.match(result.steps[1].detail, /地址/);
  assert.equal(result.steps[2].state, 'skipped');
});

test('首页诊断不把缺少动态网关认证的配置判为通过', async () => {
  const { runHomeDiagnosis } = require('../src/core/diagnostics.js');
  const result = await runHomeDiagnosis(fixture({
    authConfigPath: path.resolve('app-settings.json'),
    listModels: async () => assert.fail('不应验证缺少认证的配置'),
  }));
  assert.match(result.steps[1].detail, /认证/);
  assert.equal(result.steps[1].state, 'failed');
  assert.equal(result.steps[2].state, 'skipped');
});
