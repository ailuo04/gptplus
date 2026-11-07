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
  assert.match(script, /insertSpaceForHold/);
  assert.match(script, /pageHasFocus/);
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


test('voice input: 空格短按仅在松开时插入一个空格', async () => {
  const runtime = await createVoiceRuntime();
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
  const runtime = await createVoiceRuntime();
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
  const runtime = await createVoiceRuntime();
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
  const unfocused = await createVoiceRuntime({ focused: false });
  const ignored = unfocused.key('keydown', ' ');
  assert.equal(ignored.defaultPrevented, false);
  assert.equal(unfocused.api.context().spaceHeld, false);
  unfocused.dispose();

  const hidden = await createVoiceRuntime({ hidden: true });
  hidden.key('keydown', ' ');
  hidden.fireHoldTimer();
  assert.equal(hidden.api.context().pttActive, false);
  assert.equal(hidden.editor.value, '');
  hidden.dispose();
});

test('voice input: ChatGPT 窗口失焦会取消待触发的长按', async () => {
  const runtime = await createVoiceRuntime();
  runtime.key('keydown', ' ');
  runtime.windowEvent('blur', { target: runtime.window });
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().spaceHeld, false);
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 切换离开 ChatGPT 会取消进行中的录音而不触发转写', async () => {
  const runtime = await createVoiceRuntime();
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
  const runtime = await createVoiceRuntime();
  runtime.key('keydown', ' ');
  runtime.fireHoldTimer();
  runtime.setFocus(false);
  runtime.key('keyup', ' ');
  assert.equal(runtime.api.context().pttActive, false);
  assert.equal(runtime.api.context().status, 'idle');
  runtime.dispose();
});

test('voice input: 选中文字时保留 ChatGPT 原生空格行为', async () => {
  const runtime = await createVoiceRuntime();
  runtime.editor.value = 'hello';
  runtime.editor.selectionStart = 1;
  runtime.editor.selectionEnd = 4;
  const down = runtime.key('keydown', ' ');
  assert.equal(down.defaultPrevented, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 输入框以外的短按保留原生空格行为', async () => {
  const runtime = await createVoiceRuntime();
  runtime.document.activeElement = runtime.document.body;
  const down = runtime.key('keydown', ' ');
  const up = runtime.key('keyup', ' ');
  assert.equal(down.defaultPrevented, false);
  assert.equal(up.defaultPrevented, false);
  assert.equal(runtime.editor.value, '');
  runtime.dispose();
});

test('voice input: 输入焦点移开后不会把短按空格补进原输入框', async () => {
  const runtime = await createVoiceRuntime();
  runtime.key('keydown', ' ');
  runtime.document.activeElement = runtime.document.body;
  runtime.key('keyup', ' ');
  assert.equal(runtime.editor.value, '');
  assert.equal(runtime.document.activeElement, runtime.document.body);
  runtime.dispose();
});

test('voice input: 输入法组合期间不接管空格', async () => {
  const runtime = await createVoiceRuntime();
  const down = runtime.key('keydown', ' ', { isComposing: true });
  assert.equal(down.defaultPrevented, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 空格重复事件没有初始 keydown 时不能启动长按', async () => {
  const runtime = await createVoiceRuntime();
  const repeat = runtime.key('keydown', ' ', { repeat: true });
  assert.equal(repeat.defaultPrevented, false);
  assert.equal(runtime.api.context().spaceHeld, false);
  runtime.dispose();
});

test('voice input: 页面变为隐藏时取消待触发长按', async () => {
  const runtime = await createVoiceRuntime();
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

test('voice input: 输入框内鼠标左键长按启动语音，松开停止', async () => {
  const runtime = await createVoiceRuntime();
  runtime.pointer('pointerdown');
  runtime.fireHoldTimer();
  assert.equal(runtime.api.context().pttActive, true);
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

async function createVoiceRuntime({ focused = true, hidden = false, contentEditable = false, selected = false } = {}) {
  const vm = require('node:vm');
  const nodes = [];
  const timers = [];
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
    document, window, navigator: { language: 'zh-CN' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  };
  const script = buildVoiceInputScript({ engine: 'provider', readyWaitMs: 500, spaceHoldMs: 1000 });
  await vm.runInNewContext(script, sandbox);
  return {
    editor,
    api: sandbox.__gptplusVoice,
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
    dispose() { sandbox.__gptplusVoiceDispose?.(); },
    window,
    document,
  };
}
