'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildVoiceInputScript,
  transcribeVoice,
  voiceConfig,
} = require('../src/core/voice-input.js');

test('voice input: 注入脚本包含内联录音条、波形与本地 WAV 编码', () => {
  const script = buildVoiceInputScript({ readyWaitMs: 1234, engine: 'local', localReady: true, language: 'zh', spaceHoldMs: 1800 });
  assert.match(script, /gptplus-voice-input/);
  assert.match(script, /gptplus-voice-panel/);
  assert.match(script, /gptplus-voice-wave/);
  assert.match(script, /__gptplusVoice/);
  assert.match(script, /data-composer-surface-variant/);
  assert.match(script, /div\.ms-2\.flex\.items-center/);
  assert.match(script, /empty:hidden/);
  assert.match(script, /OfflineAudioContext/);
  assert.match(script, /16000/);
  assert.match(script, /"local"/);
  assert.match(script, /PTT_HOLD_MS = Math\.min/);
  assert.match(script, /PTT_HOLD_LABEL/);
  assert.match(script, /, 1800\)$/);
  assert.match(script, /onSpaceDown/);
  assert.match(script, /removeTrailingSpaces/);
  assert.match(script, /position:absolute/);
  assert.match(script, /--color-token-main-surface-primary/);
  assert.match(script, /true/);
  assert.doesNotThrow(() => new Function('return ' + script));
});

test('voice input: provider 脚本仍保留 webm 上传路径', () => {
  const script = buildVoiceInputScript({ readyWaitMs: 1234, engine: 'provider' });
  assert.match(script, /audio\/webm/);
  assert.match(script, /"provider"/);
  assert.doesNotThrow(() => new Function('return ' + script));
});

test('voice input: 插件配置会兜底到本地识别并规范化字段', () => {
  const config = voiceConfig({
    plugins: {
      config: () => ({ engine: 'provider', providerId: ' p_demo ', model: ' ', language: 'EN', spaceHoldMs: '2400' }),
    },
  });
  assert.deepEqual(config, {
    engine: 'provider',
    providerId: 'p_demo',
    model: 'whisper-1',
    language: 'en',
    spaceHoldMs: 2400,
  });
  assert.deepEqual(voiceConfig({ plugins: { config: () => null } }), {
    engine: 'local',
    providerId: '',
    model: 'whisper-1',
    language: '',
    spaceHoldMs: 1000,
  });
  assert.equal(voiceConfig({ plugins: { config: () => ({ spaceHoldMs: 100 }) } }).spaceHoldMs, 300);
  assert.equal(voiceConfig({ plugins: { config: () => ({ spaceHoldMs: 9000 }) } }).spaceHoldMs, 5000);
  assert.equal(voiceConfig({ plugins: { config: () => ({ spaceHoldMs: null }) } }).spaceHoldMs, 1000);
});

test('voice input: 转写走 OpenAI 兼容 /audio/transcriptions 并复用提供商鉴权', async () => {
  const captured = {};
  const fetchImpl = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify({ text: ' 你好 ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = {
    id: 'p_demo',
    name: 'demo',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    api: 'openai',
    headers: { 'X-Test': '1', 'Content-Type': 'application/json' },
  };
  const transcript = await transcribeVoice({
    ctx: { store: { getProvider: (id) => (id === 'p_demo' ? provider : null) } },
    config: { providerId: 'p_demo', model: 'whisper-1', language: 'zh' },
    pending: { data: Buffer.from('fake audio').toString('base64'), mime: 'audio/webm;codecs=opus' },
    fetchImpl,
  });
  assert.equal(transcript, '你好');
  assert.equal(captured.url, 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer secret');
  assert.equal(captured.init.headers['X-Test'], '1');
  assert.equal(captured.init.headers['Content-Type'], undefined);
  assert.equal(captured.init.body.get('model'), 'whisper-1');
  assert.equal(captured.init.body.get('language'), 'zh');
  const file = captured.init.body.get('file');
  assert.equal(file.name, 'voice.webm');
  assert.equal(file.type, 'audio/webm;codecs=opus');
  assert.equal(await file.text(), 'fake audio');
});

test('voice input: 上游错误与未选择提供商都会返回可读错误', async () => {
  await assert.rejects(
    transcribeVoice({
      ctx: { store: { getProvider: () => null } },
      config: { providerId: 'missing' },
      pending: { data: Buffer.from('x').toString('base64'), mime: 'audio/webm' },
      fetchImpl: async () => new Response('{}', { status: 200 }),
    }),
    /提供商不存在/,
  );
  await assert.rejects(
    transcribeVoice({
      ctx: {
        store: {
          getProvider: () => ({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'secret',
            api: 'openai',
          }),
        },
      },
      config: { providerId: 'p_demo', model: 'whisper-1' },
      pending: { data: Buffer.from('x').toString('base64'), mime: 'audio/webm' },
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: '模型不支持音频' } }), { status: 400 }),
    }),
    /模型不支持音频/,
  );
});
