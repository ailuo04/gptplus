'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODEL_FILES,
  localSpeechStatus,
  normalizeLanguage,
  resolveSpeechModel,
} = require('../src/core/local-speech.js');

test('local speech: 语言提示只接受 SenseVoice 支持的值', () => {
  assert.equal(normalizeLanguage('ZH'), 'zh');
  assert.equal(normalizeLanguage('yue'), 'yue');
  assert.equal(normalizeLanguage('ko'), 'ko');
  assert.equal(normalizeLanguage('fr'), 'auto');
  assert.equal(normalizeLanguage(''), 'auto');
});

test('local speech: 模型元数据固定到可校验的版本', () => {
  assert.equal(MODEL_FILES.model.bytes, 239233841);
  assert.match(MODEL_FILES.model.sha256, /^[a-f0-9]{64}$/);
  assert.match(MODEL_FILES.tokens.url, /sense-voice-zh-en-ja-ko-yue/);
  assert.match(MODEL_FILES.vad.url, /silero_vad\.onnx$/);
});

test('local speech: 状态包含可用性和模型来源', () => {
  const status = localSpeechStatus();
  assert.equal(typeof status.ready, 'boolean');
  assert.equal(typeof status.root, 'string');
  assert.equal(typeof status.files.model, 'string');
  const resolved = resolveSpeechModel();
  assert.equal(typeof resolved.ready, 'boolean');
  if (resolved.ready) assert.ok(resolved.source === 'gpt++' || resolved.source === 'DeepSeek Harness');
});
