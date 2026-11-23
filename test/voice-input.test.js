'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildVoiceInputScript,
  startVoiceInputBridge,
  stopVoiceInputBridge,
  transcribeVoice,
  voiceConfig,
} = require('../src/core/voice-input.js');

test('voice input: 注入脚本包含内联录音条、波形与本地 WAV 编码', () => {
  const script = buildVoiceInputScript({ readyWaitMs: 1234, engine: 'local', localReady: true, language: 'zh', spaceHoldMs: 1800, streaming: true });
  assert.match(script, /gptplus-voice-input/);
  assert.match(script, /gptplus-voice-panel/);
  assert.match(script, /gptplus-voice-wave/);
  assert.match(script, /gptplus-voice-caption/);
  assert.match(script, /__gptplusVoice/);
  assert.match(script, /data-composer-surface-variant/);
  assert.match(script, /div\.ms-2\.flex\.items-center/);
  assert.match(script, /empty:hidden/);
  assert.match(script, /OfflineAudioContext/);
  assert.match(script, /16000/);
  assert.match(script, /"local"/);
  assert.match(script, /PTT_HOLD_MS = Math\.min/);
  assert.match(script, /PTT_HOLD_LABEL/);
  assert.match(script, /, 1800, true, false, \{\"code\":\"Alt\",\"ctrl\":false,\"shift\":false,\"alt\":false\}\)$/);
  assert.match(script, /onSpaceDown/);
  assert.match(script, /insertSpaceForHold/);
  assert.match(script, /pageHasFocus/);
  assert.match(script, /position:absolute/);
  assert.match(script, /--color-token-main-surface-primary/);
  assert.match(script, /takeOutbox/);
  assert.match(script, /streamAppend/);
  assert.match(script, /pcmToBase64/);
  assert.match(script, /createScriptProcessor/);
  assert.match(script, /true/);
  assert.doesNotThrow(() => new Function('return ' + script));
});

test('voice input: provider 脚本仍保留 webm 上传路径且不启用实时流', () => {
  const script = buildVoiceInputScript({ readyWaitMs: 1234, engine: 'provider', streaming: true });
  assert.match(script, /audio\/webm/);
  assert.match(script, /"provider"/);
  assert.match(script, /, 1000, false, false, \{\"code\":\"Alt\",\"ctrl\":false,\"shift\":false,\"alt\":false\}\)$/);
  assert.doesNotThrow(() => new Function('return ' + script));
});

test('voice input: 回环开关只随本地流式引擎注入，且运行时自包含', () => {
  const script = buildVoiceInputScript({ engine: 'local', streaming: true, loopback: true, spaceHoldMs: 1000 });
  assert.match(script, /, 1000, true, true, \{\"code\":\"Alt\",\"ctrl\":false,\"shift\":false,\"alt\":false\}\)$/);
  assert.match(script, /loopback-start/);
  assert.match(script, /loopbackReady/);
  assert.match(script, /streamLevel/);
  assert.match(script, /gptplus-voice-input-v17/);
  assert.doesNotThrow(() => new Function('return ' + script));
  const provider = buildVoiceInputScript({ engine: 'provider', streaming: true, loopback: true });
  assert.match(provider, /, 1000, false, false, \{\"code\":\"Alt\",\"ctrl\":false,\"shift\":false,\"alt\":false\}\)$/);
  const batch = buildVoiceInputScript({ engine: 'local', streaming: false, loopback: true });
  assert.match(batch, /, 1000, false, false, \{\"code\":\"Alt\",\"ctrl\":false,\"shift\":false,\"alt\":false\}\)$/);
});

test('voice input: 插件配置会兜底到本地识别并规范化字段', () => {
  const config = voiceConfig({
    plugins: {
      config: () => ({ engine: 'provider', providerId: ' p_demo ', model: ' ', language: 'EN', spaceHoldMs: '2400', hotkey: { code: 'KeyV', ctrl: true, shift: true } }),
    },
  });
  assert.deepEqual(config, {
    engine: 'provider',
    providerId: 'p_demo',
    model: 'whisper-1',
    language: 'en',
    spaceHoldMs: 2400,
    hotkey: { code: 'KeyV', ctrl: true, shift: true, alt: false },
  });
  assert.deepEqual(voiceConfig({ plugins: { config: () => null } }), {
    engine: 'local',
    providerId: '',
    model: 'whisper-1',
    language: '',
    spaceHoldMs: 1000,
    hotkey: { code: 'Alt', ctrl: false, shift: false, alt: false },
  });
  assert.deepEqual(voiceConfig({ plugins: { config: () => ({ hotkey: { code: 'KeyV' } }) } }).hotkey, { code: 'Alt', ctrl: false, shift: false, alt: false });
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


test('voice input: 自定义组合键只在输入框内按住触发并在松开时停止', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'KeyV', ctrl: true, shift: true, alt: false } });
  const down = runtime.key('keydown', 'v', { code: 'KeyV', ctrlKey: true, shiftKey: true });
  assert.equal(down.defaultPrevented, true);
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, true);
  const up = runtime.key('keyup', 'v', { code: 'KeyV', ctrlKey: true, shiftKey: true });
  assert.equal(up.defaultPrevented, true);
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();

  const outside = await createVoiceRuntime({ hotkey: { code: 'KeyV', ctrl: true, shift: true, alt: false } });
  outside.document.activeElement = outside.document.body;
  const outsideDown = outside.key('keydown', 'v', { code: 'KeyV', ctrlKey: true, shiftKey: true });
  outside.fireHoldTimer();
  assert.equal(outsideDown.defaultPrevented, false);
  assert.equal(outside.api.context().pttActive, false);
  outside.dispose();
});

test('voice input: 自定义 Ctrl+空格按住期间持续录音，松开停止', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local', hotkey: { code: 'Space', ctrl: true, shift: false, alt: false } });
  const down = runtime.key('keydown', ' ', { ctrlKey: true, code: 'Space' });
  assert.equal(down.defaultPrevented, true);
  runtime.fireHoldTimer();
  await runtime.flush();
  assert.equal(runtime.api.context().status, 'recording');
  assert.equal(runtime.hasTimer(3000), false, '快捷键录音不应设置 3 秒停止计时器');
  runtime.fireTimer(3000);
  assert.equal(runtime.api.context().status, 'recording', '按住期间录音应继续');
  const up = runtime.key('keyup', ' ', { ctrlKey: true, code: 'Space' });
  assert.equal(up.defaultPrevented, true);
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.api.context().status, 'transcribing');
  runtime.dispose();
});

test('voice input: 默认 Alt 长按只在输入框聚焦时启动', async () => {
  const runtime = await createVoiceRuntime();
  runtime.document.activeElement = runtime.document.body;
  const down = runtime.key('keydown', 'Alt', { code: 'AltLeft', altKey: true });
  runtime.fireHoldTimer();
  assert.equal(down.defaultPrevented, false);
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: 默认 Alt 短按不录音，长按期间持续录音并在松开时结束', async () => {
  const hotkey = { code: 'Alt', ctrl: false, shift: false, alt: false };
  const runtime = await createVoiceRuntime({ engine: 'local', hotkey });
  const tapDown = runtime.key('keydown', 'Alt', { code: 'AltLeft', altKey: true });
  assert.equal(tapDown.defaultPrevented, true);
  runtime.key('keyup', 'Alt', { code: 'AltLeft', altKey: false });
  assert.equal(runtime.api.context().pttActive, false);

  runtime.key('keydown', 'Alt', { code: 'AltLeft', altKey: true });
  runtime.fireHoldTimer();
  await runtime.flush();
  assert.equal(runtime.api.context().status, 'recording');
  assert.equal(runtime.api.context().recordMode, 'stream');
  assert.equal(runtime.hasTimer(3000), false, '快捷键录音不应设置 3 秒停止计时器');
  runtime.fireTimer(3000);
  assert.equal(runtime.api.context().status, 'recording', '按住期间录音应继续');
  assert.equal(runtime.api.context().pttActive, true);
  const release = runtime.key('keyup', 'Alt', { code: 'AltLeft', altKey: false });
  assert.equal(release.defaultPrevented, true);
  assert.equal(runtime.api.context().status, 'transcribing');
  assert.equal(runtime.api.context().pttActive, false);
  assert.ok(runtime.outbox().some((item) => item.type === 'end'), '松开时应结束实时识别会话');
  runtime.dispose();
});

test('voice input: 空格短按仅在松开时插入一个空格', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.editor.value = 'hello';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 5;
  const down = runtime.key('keydown', ' ');
  assert.equal(down.defaultPrevented, true);
  assert.equal(runtime.editor.value, 'hello');
  runtime.key('keyup', ' ');
  assert.equal(runtime.editor.value, 'hello ');
  runtime.dispose();
});

test('voice input: 长按启动录音但不写入空格，且重复键被拦截', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.editor.value = 'hello';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 5;
  runtime.key('keydown', ' ');
  assert.equal(runtime.key('keydown', ' ', { repeat: true }).defaultPrevented, true);
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, true);
  runtime.key('keyup', ' ');
  assert.equal(runtime.editor.value, 'hello');
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: 空格按住期间继续打字时先插入分隔空格且不丢字符', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.editor.value = 'hello';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 5;
  runtime.key('keydown', ' ');
  runtime.key('keydown', 'w');
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, false);
  runtime.editor.setRangeText('w', runtime.editor.selectionStart, runtime.editor.selectionEnd, 'end');
  runtime.key('keyup', ' ');
  assert.equal(runtime.editor.value, 'hello w');
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: 页面失焦或隐藏时不启动空格长按', async () => {
  const unfocused = await createVoiceRuntime({ focused: false, hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  const ignored = unfocused.key('keydown', ' ');
  assert.equal(ignored.defaultPrevented, false);
  assert.equal(unfocused.api.context().spaceHeld, false);
  unfocused.dispose();

  const hidden = await createVoiceRuntime({ hidden: true, hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  hidden.key('keydown', ' ');
  hidden.fireHoldTimer();
  assert.equal(hidden.api.context().pttActive, false);
  assert.equal(hidden.editor.value, '');
  hidden.dispose();
});

test('voice input: ChatGPT 窗口失焦会取消待触发的长按', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.key('keydown', ' ');
  runtime.windowEvent('blur', { target: runtime.window });
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().spaceHeld, false);
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 切换离开 ChatGPT 会取消进行中的录音而不触发转写', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.key('keydown', ' ');
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, true);
  runtime.setFocus(false);
  runtime.windowEvent('blur', { target: runtime.window });
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.api.context().status, 'idle');
  runtime.key('keyup', ' ');
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 页面已失焦时松开空格会取消录音，不会转写', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.key('keydown', ' ');
  runtime.fireHoldTimer();
  runtime.setFocus(false);
  runtime.key('keyup', ' ');
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.api.context().status, 'idle');
  runtime.dispose();
});

test('voice input: 选中文字时保留 ChatGPT 原生空格行为', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.editor.value = 'hello';
  runtime.editor.selectionStart = 1;
  runtime.editor.selectionEnd = 4;
  const down = runtime.key('keydown', ' ');
  assert.equal(down.defaultPrevented, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 输入框以外的短按保留原生空格行为', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.document.activeElement = runtime.document.body;
  const down = runtime.key('keydown', ' ');
  const up = runtime.key('keyup', ' ');
  assert.equal(down.defaultPrevented, false);
  assert.equal(up.defaultPrevented, false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 输入焦点移开后不会把短按空格补进原输入框', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.key('keydown', ' ');
  runtime.document.activeElement = runtime.document.body;
  runtime.key('keyup', ' ');
  assert.equal(runtime.editor.value, '');
  assert.equal(runtime.document.activeElement, runtime.document.body);
  runtime.dispose();
});

test('voice input: 输入法组合期间不接管空格', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  const down = runtime.key('keydown', ' ', { isComposing: true });
  assert.equal(down.defaultPrevented, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 空格重复事件没有初始 keydown 时不能启动长按', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  const repeat = runtime.key('keydown', ' ', { repeat: true });
  assert.equal(repeat.defaultPrevented, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 页面变为隐藏时取消待触发长按', async () => {
  const runtime = await createVoiceRuntime({ hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.key('keydown', ' ');
  runtime.setHidden(true);
  runtime.documentEvent('visibilitychange');
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().spaceHeld, false);
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 输入框内鼠标左键短按不拦截原生点击', async () => {
  const runtime = await createVoiceRuntime();
  const down = runtime.pointer('pointerdown');
  const up = runtime.pointer('pointerup');
  assert.equal(down.defaultPrevented, false);
  assert.equal(up.defaultPrevented, false);
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: 鼠标长按录音松开停止', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local' });
  runtime.pointer('pointerdown');
  runtime.fireHoldTimer();
  await runtime.flush();
  assert.equal(runtime.api.context().pttActive, true);
  assert.equal(runtime.api.context().status, 'recording');
  assert.equal(runtime.hasTimer(3000), false);
  runtime.pointer('pointerup');
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: 未选中文字时 contenteditable 输入框也支持鼠标长按', async () => {
  const runtime = await createVoiceRuntime({ contentEditable: true });
  runtime.pointer('pointerdown');
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, true);
  runtime.pointer('pointerup');
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: contenteditable 已有文字选区时不触发鼠标长按', async () => {
  const runtime = await createVoiceRuntime({ contentEditable: true, selected: true });
  runtime.pointer('pointerdown');
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, false);
  runtime.dispose();
});

test('voice input: 右键、中键和输入框外的鼠标长按不触发语音', async () => {
  for (const button of [1, 2]) {
    const runtime = await createVoiceRuntime();
    runtime.pointer('pointerdown', { button });
    runtime.fireHoldTimer();
    assert.equal(runtime.api.context().pttActive, false);
    runtime.dispose();
  }
  const outside = await createVoiceRuntime();
  outside.pointer('pointerdown', { target: outside.document.body });
  outside.fireHoldTimer();
  assert.equal(outside.api.context().pttActive, false);
  outside.dispose();
});

test('voice input: 按下时有选区或按住拖动时不触发鼠标长按语音', async () => {
  const selected = await createVoiceRuntime();
  selected.editor.selectionStart = 1;
  selected.editor.selectionEnd = 4;
  selected.pointer('pointerdown');
  selected.fireHoldTimer();
  assert.equal(selected.api.context().pttActive, false);
  selected.dispose();

  const dragged = await createVoiceRuntime();
  dragged.pointer('pointerdown', { clientX: 10, clientY: 10 });
  dragged.pointer('pointermove', { clientX: 30, clientY: 10 });
  dragged.fireHoldTimer();
  assert.equal(dragged.api.context().pttActive, false);
  dragged.dispose();
});

test('voice input: 鼠标长按候选期间切换离开 ChatGPT 会取消触发', async () => {
  const runtime = await createVoiceRuntime();
  runtime.pointer('pointerdown');
  runtime.setFocus(false);
  runtime.windowEvent('blur', { target: runtime.window });
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 本地引擎边录边把稳定分句写入输入框', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local' });
  runtime.editor.value = '用户原文';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 4;
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  const context = runtime.api.context();
  assert.equal(context.recordMode, 'stream');
  assert.equal(context.status, 'recording');
  const id = context.sessionId;
  assert.ok(id, '录音会话应当有 id');
  assert.equal(runtime.hasTimer(3000), false, '麦克风按钮手动录音不受快捷键计时器影响');

  assert.equal(runtime.api.streamCaption(id, '', '今天我们'), true);
  assert.equal(runtime.findById('gptplus-voice-caption').children[1].textContent, '今天我们');

  assert.equal(runtime.api.streamAppend(id, '今天天气不错。'), true);
  assert.equal(runtime.editor.value, '用户原文今天天气不错。');
  runtime.api.streamAppend(id, '我们去公园。');
  assert.equal(runtime.editor.value, '用户原文今天天气不错。我们去公园。');

  runtime.api.streamDone(id, { ok: true });
  assert.equal(runtime.api.context().status, 'idle');
  assert.equal(runtime.findById('gptplus-voice-caption').children[0].textContent, '');
  runtime.dispose();
});

test('voice input: 取消实时转写只回滚本次插入的文字', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local' });
  runtime.editor.value = '保持原文';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 4;
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  const id = runtime.api.context().sessionId;
  runtime.api.streamAppend(id, '临时文字。');
  assert.equal(runtime.editor.value, '保持原文临时文字。');
  runtime.key('keydown', 'Escape');
  assert.equal(runtime.editor.value, '保持原文');
  assert.equal(runtime.api.context().status, 'idle');
  assert.equal(runtime.api.context().sessionId, '');
  runtime.dispose();
});

test('voice input: 过期会话的流式事件不会写入输入框', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local' });
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  const id = runtime.api.context().sessionId;
  runtime.api.streamDone(id, { ok: true });
  assert.equal(runtime.api.streamAppend(id, '迟到文字'), false);
  assert.equal(runtime.api.streamCaption(id, '迟到', ''), false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 回环模式单击不采麦克风，就绪后进入录音并复用流式写入', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local', loopback: true });
  runtime.editor.value = '原文';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 2;
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  assert.equal(runtime.micCalls.length, 0, '回环模式不应请求麦克风');
  const context = runtime.api.context();
  assert.equal(context.status, 'requesting');
  assert.equal(context.recordMode, 'stream');
  assert.equal(context.loopback, true);
  const items = runtime.outbox();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'loopback-start');
  const id = items[0].id;
  assert.equal(id, context.sessionId);

  assert.equal(runtime.api.loopbackReady('别的会话'), false);
  assert.equal(runtime.api.loopbackReady(id), true);
  assert.equal(runtime.api.context().status, 'recording');
  assert.equal(runtime.api.streamLevel(id, 0.4), true);
  assert.equal(runtime.api.streamCaption(id, '', '今天天气'), true);
  assert.equal(runtime.api.streamAppend(id, '今天天气不错。'), true);
  assert.equal(runtime.editor.value, '原文今天天气不错。');

  runtime.click(runtime.findById('gptplus-voice-input'));
  const end = runtime.outbox();
  assert.equal(end.length, 1);
  assert.equal(end[0].type, 'end');
  assert.equal(end[0].id, id);
  assert.equal(runtime.api.context().status, 'transcribing');
  runtime.api.streamDone(id, { ok: true });
  assert.equal(runtime.api.context().status, 'idle');
  assert.equal(runtime.api.context().loopback, false);
  runtime.dispose();
});

test('voice input: 回环模式长按空格仍走麦克风采集', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local', loopback: true, hotkey: { code: 'Space', ctrl: false, shift: false, alt: false } });
  runtime.key('keydown', ' ');
  runtime.fireHoldTimer();
  await runtime.flush();
  assert.equal(runtime.micCalls.length, 1);
  assert.equal(runtime.api.context().loopback, false);
  assert.equal(runtime.api.context().status, 'recording');
  runtime.key('keyup', ' ');
  runtime.dispose();
});

test('voice input: 回环模式 Esc 只回滚本次插入并发送取消', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local', loopback: true });
  runtime.editor.value = '保持原文';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 4;
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  const id = runtime.api.context().sessionId;
  runtime.api.loopbackReady(id);
  runtime.api.streamAppend(id, '临时文字。');
  assert.equal(runtime.editor.value, '保持原文临时文字。');
  runtime.key('keydown', 'Escape');
  assert.equal(runtime.editor.value, '保持原文');
  assert.equal(runtime.api.context().status, 'idle');
  const items = runtime.outbox();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'cancel');
  assert.equal(items[0].id, id);
  runtime.dispose();
});

test('voice input: 回环连接超时会取消会话并报错', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local', loopback: true });
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  const id = runtime.api.context().sessionId;
  runtime.fireTimer(12000);
  assert.equal(runtime.api.context().status, 'error');
  assert.equal(runtime.api.context().sessionId, '');
  const items = runtime.outbox();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'cancel');
  assert.equal(items[0].id, id);
  assert.equal(runtime.api.loopbackReady(id), false);
  runtime.dispose();
});

test('voice input: 回环采集失败经 streamDone 回滚并展示错误', async () => {
  const runtime = await createVoiceRuntime({ engine: 'local', loopback: true });
  runtime.editor.value = '原文';
  runtime.editor.selectionStart = runtime.editor.selectionEnd = 2;
  runtime.click(runtime.findById('gptplus-voice-input'));
  await runtime.flush();
  const id = runtime.api.context().sessionId;
  runtime.api.loopbackReady(id);
  runtime.api.streamAppend(id, '半句');
  runtime.api.streamDone(id, { ok: false, error: '系统音频采集失败' });
  assert.equal(runtime.editor.value, '原文');
  assert.equal(runtime.api.context().status, 'error');
  runtime.dispose();
});

async function waitUntil(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createFakeBridgeEnv() {
  const evaluations = [];
  const inbox = [];
  const target = { id: 'page-1' };
  const cdpImpl = {
    listTargets: async () => [target],
    pickMainTarget: (targets) => targets[0] || null,
    evaluate: async (page, expression) => {
      evaluations.push(expression);
      if (expression.includes('takeOutbox')) return inbox.shift() || { type: 'idle', context: { status: 'idle', hidden: false } };
      return 1;
    },
  };
  const pushed = [];
  const state = { ended: 0, cancelled: 0, emit: null };
  const startStreamImpl = async ({ onEvent }) => {
    state.emit = onEvent;
    return {
      push: (buffer) => pushed.push(buffer),
      end: () => { state.ended += 1; },
      cancel: () => { state.cancelled += 1; },
    };
  };
  const captures = [];
  const loopbackImpl = (handlers) => {
    const capture = { handlers, stopped: 0, stop() { this.stopped += 1; } };
    captures.push(capture);
    return capture;
  };
  const ctx = { plugins: { config: () => ({ engine: 'local', language: 'zh' }) } };
  return { evaluations, inbox, cdpImpl, pushed, state, startStreamImpl, captures, loopbackImpl, ctx };
}

test('voice input: 桥接把回环采集接入流式会话并转发分句/收尾', async () => {
  const env = createFakeBridgeEnv();
  const bridge = startVoiceInputBridge({
    cdpPort: 9222, ctx: env.ctx, cdpImpl: env.cdpImpl,
    startStreamImpl: env.startStreamImpl, loopbackImpl: env.loopbackImpl, loopbackEnabled: true,
    visibleIntervalMs: 5, hiddenIntervalMs: 5,
  });
  try {
    env.inbox.push({ type: 'stream', items: [{ type: 'loopback-start', id: 's1' }] });
    await waitUntil(() => env.captures.length === 1);
    const capture = env.captures[0];

    capture.handlers.onStarted();
    await waitUntil(() => env.evaluations.some((expression) => expression.includes('loopbackReady("s1")')));

    capture.handlers.onPcm(Buffer.from([1, 2, 3, 4]));
    capture.handlers.onLevel(0.3);
    await waitUntil(() => env.pushed.length === 1);
    assert.deepEqual(env.pushed[0], Buffer.from([1, 2, 3, 4]));
    await waitUntil(() => env.evaluations.some((expression) => expression.includes('streamLevel("s1",0.3)')));

    env.state.emit({ kind: 'segment', text: '你好', pauseMs: 0, durationMs: 1200 });
    env.state.emit({ kind: 'segment', text: '世界', pauseMs: 1500, durationMs: 900 });
    await waitUntil(() => env.evaluations.some((expression) => expression.includes('streamAppend("s1","你好。")')));

    env.inbox.push({ type: 'stream', items: [{ type: 'end', id: 's1' }] });
    await waitUntil(() => env.state.ended === 1);
    assert.equal(capture.stopped, 1, '收尾时应停止回环采集');
    capture.handlers.onPcm(Buffer.from([9, 9]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(env.pushed.length, 1, '收尾后不再接收音频');

    env.state.emit({ kind: 'done', text: '你好。世界' });
    await waitUntil(() => env.evaluations.some((expression) => expression.includes('streamAppend("s1","世界。")')));
    await waitUntil(() => env.evaluations.some((expression) => expression.includes('streamDone("s1",{"ok":true})')));
  } finally {
    bridge.stop();
    stopVoiceInputBridge();
  }
});

test('voice input: 桥接取消回环会话时停止采集并取消识别流', async () => {
  const env = createFakeBridgeEnv();
  const bridge = startVoiceInputBridge({
    cdpPort: 9222, ctx: env.ctx, cdpImpl: env.cdpImpl,
    startStreamImpl: env.startStreamImpl, loopbackImpl: env.loopbackImpl, loopbackEnabled: true,
    visibleIntervalMs: 5, hiddenIntervalMs: 5,
  });
  try {
    env.inbox.push({ type: 'stream', items: [{ type: 'loopback-start', id: 's2' }] });
    await waitUntil(() => env.captures.length === 1 && env.state.emit);
    env.inbox.push({ type: 'stream', items: [{ type: 'cancel', id: 's2' }] });
    await waitUntil(() => env.captures[0].stopped === 1);
    assert.equal(env.state.cancelled, 1);
  } finally {
    bridge.stop();
    stopVoiceInputBridge();
  }
});

test('voice input: 回环采集失败时桥接回传错误并停止采集', async () => {
  const env = createFakeBridgeEnv();
  const bridge = startVoiceInputBridge({
    cdpPort: 9222, ctx: env.ctx, cdpImpl: env.cdpImpl,
    startStreamImpl: env.startStreamImpl, loopbackImpl: env.loopbackImpl, loopbackEnabled: true,
    visibleIntervalMs: 5, hiddenIntervalMs: 5,
  });
  try {
    env.inbox.push({ type: 'stream', items: [{ type: 'loopback-start', id: 's3' }] });
    await waitUntil(() => env.captures.length === 1);
    env.captures[0].handlers.onError('没有采集到系统音频轨道');
    await waitUntil(() => env.evaluations.some((expression) => expression.includes('streamDone("s3",{"ok":false,"error":"没有采集到系统音频轨道"})')));
    assert.equal(env.captures[0].stopped, 1);
  } finally {
    bridge.stop();
    stopVoiceInputBridge();
  }
});

async function createVoiceRuntime({ focused = true, hidden = false, contentEditable = false, selected = false, engine = 'provider', loopback = false, hotkey = { code: 'Alt', ctrl: false, shift: false, alt: false } } = {}) {
  const vm = require('node:vm');
  const nodes = [];
  const timers = [];
  const micCalls = [];
  let isFocused = focused;
  let isHidden = hidden;
  class Node {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.listeners = {};
      this.className = '';
      this.id = '';
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.isConnected = true;
      nodes.push(this);
    }
    appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
    insertBefore(node, reference) {
      const index = this.children.indexOf(reference);
      if (index < 0) return this.appendChild(node);
      this.children.splice(index, 0, node);
      node.parentElement = this;
      return node;
    }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    dispatchEvent(event) { this.lastEvent = event; return true; }
    getBoundingClientRect() { return { width: 100, height: 24 }; }
    contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
    closest(selector) {
      if (selector === 'div.ms-2') return this === send ? sendWrap : null;
      if (selector.startsWith('[') && selector.includes('data-gptplus-voice-input')) return null;
      return null;
    }
    querySelector(selector) {
      if (this === card && selector.includes('div.ms-2.flex.items-center > button')) return send;
      if (this === card && (selector.includes('.ProseMirror') || selector.includes('[role="textbox"]'))) return editor;
      return null;
    }
    querySelectorAll() { return []; }
    setRangeText(text, start, end, selectionMode) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      const cursor = start + text.length;
      this.selectionStart = selectionMode === 'select' ? start : cursor;
      this.selectionEnd = selectionMode === 'select' ? cursor : cursor;
    }
    focus() { document.activeElement = this; }
    remove() {
      this.isConnected = false;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    }
  }
  const editor = new Node(contentEditable ? 'div' : 'textarea');
  editor.isContentEditable = contentEditable;
  const send = new Node('button');
  const sendWrap = new Node('div');
  sendWrap.className = 'ms-2';
  sendWrap.appendChild(send);
  const toolbar = new Node('div');
  toolbar.appendChild(sendWrap);
  const card = new Node('div');
  editor.parentElement = card;
  const selection = { rangeCount: contentEditable ? 1 : 0, isCollapsed: !selected, anchorNode: editor };
  const window = { listeners: {}, addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }, removeEventListener() {}, getSelection: () => selection };
  const document = {
    body: new Node('body'), head: new Node('head'), documentElement: { lang: 'zh-CN' },
    activeElement: editor,
    get hidden() { return isHidden; },
    listeners: {},
    hasFocus: () => isFocused,
    querySelectorAll: () => [card],
    createElement: tag => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    getElementById: id => nodes.find(node => node.id === id && node.isConnected) || null,
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
    removeEventListener() {},
  };
  const sandbox = {
    document, window, navigator: {
      language: 'zh-CN',
      mediaDevices: { getUserMedia: async (constraints) => { micCalls.push(constraints); return { getTracks: () => [] }; } },
    },
    AudioContext: class {
      constructor() {
        this.sampleRate = 16000;
        this.state = 'running';
        this.destination = {};
      }
      createAnalyser() { return { fftSize: 256, getFloatTimeDomainData() {} }; }
      createMediaStreamSource() { return { connect() {} }; }
      createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      close() { this.state = 'closed'; return Promise.resolve(); }
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  };
  const script = buildVoiceInputScript({ engine, readyWaitMs: 500, spaceHoldMs: 1000, streaming: engine === 'local', localReady: engine === 'local', loopback, hotkey });
  await vm.runInNewContext(script, sandbox);
  return {
    editor,
    api: sandbox.__gptplusVoice,
    micCalls,
    outbox() { return sandbox.__gptplusVoice.takeOutbox() || []; },
    findById(id) { return nodes.find(node => node.id === id && node.isConnected) || null; },
    click(node) {
      for (const listener of node.listeners.click || []) listener({ preventDefault() {}, stopPropagation() {} });
    },
    async flush() {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
    pointer(type, extras = {}) {
      const event = { type, target: editor, button: 0, pointerType: 'mouse', pointerId: 1,
        clientX: 0, clientY: 0, ctrlKey: false, metaKey: false, altKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extras };
      for (const listener of document.listeners[type] || []) listener(event);
      return event;
    },
    key(type, key, extras = {}) {
      const event = { type, key, code: key === ' ' ? 'Space' : '', repeat: false, isComposing: false,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extras };
      for (const listener of document.listeners[type] || []) listener(event);
      return event;
    },
    windowEvent(type, event) { for (const listener of window.listeners[type] || []) listener(event); },
    documentEvent(type) { for (const listener of document.listeners[type] || []) listener({ type }); },
    setFocus(value) { isFocused = value; },
    setHidden(value) { isHidden = value; },
    fireHoldTimer() { const timer = timers.findLast(item => item.delay === 1000 && !item.cleared); if (timer) timer.callback(); },
    fireTimer(delay) { const timer = timers.findLast(item => item.delay === delay && !item.cleared); if (timer) { timer.cleared = true; timer.callback(); } },
    hasTimer(delay) { return timers.some(item => item.delay === delay && !item.cleared); },
    dispose() { sandbox.__gptplusVoiceDispose?.(); },
    window,
    document,
  };
}
