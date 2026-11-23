'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  capturePageHtml,
  createLoopbackCapture,
  loopbackAvailable,
} = require('../src/core/voice-loopback.js');

function createFakeElectron() {
  const listeners = new Map();
  const sent = [];
  const windows = [];
  const handlerState = { handler: null, opts: null };
  class FakeWebContents {
    constructor(win) { this.win = win; this.onceEvents = {}; }
    send(channel, message) { sent.push({ channel, message }); }
    once(name, listener) { (this.onceEvents[name] ||= []).push(listener); }
  }
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents(this);
      this.destroyed = false;
      this.url = '';
      this.onceEvents = {};
      windows.push(this);
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; for (const listener of this.onceEvents.closed || []) listener(); }
    once(name, listener) { (this.onceEvents[name] ||= []).push(listener); }
  }
  const api = {
    BrowserWindow: FakeBrowserWindow,
    desktopCapturer: { getSources: async () => [{ id: 'screen:0:0', name: 'Screen 1' }] },
    session: {
      defaultSession: {
        setDisplayMediaRequestHandler(handler, opts) { handlerState.handler = handler; handlerState.opts = opts; },
      },
    },
    ipcMain: {
      on(channel, listener) { const list = listeners.get(channel) || []; list.push(listener); listeners.set(channel, list); },
      removeListener(channel, listener) {
        const list = listeners.get(channel) || [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      },
    },
  };
  return {
    api, windows, sent, handlerState,
    emit(channel, message, win) {
      for (const listener of [...(listeners.get(channel) || [])]) listener({ sender: win.webContents }, message);
    },
    listenerCount(channel) { return (listeners.get(channel) || []).length; },
  };
}

test('voice loopback: 普通 Node 环境不支持系统音频回环', () => {
  assert.equal(loopbackAvailable(), false);
  assert.throws(() => createLoopbackCapture({}), /桌面运行时/);
});

test('voice loopback: 采集页面自包含且按 16 kHz PCM16 回传', () => {
  const html = capturePageHtml('chan-1');
  assert.match(html, /getDisplayMedia/);
  assert.match(html, /audio: true/);
  assert.match(html, /var RATE = 16000, CHUNK = 2048/);
  assert.match(html, /sampleRate: RATE/);
  assert.match(html, /createScriptProcessor\(CHUNK, 1, 1\)/);
  assert.match(html, /setInt16/);
  assert.match(html, /"chan-1"/);
  assert.match(html, /mute\.gain\.value = 0/);
  assert.match(html, /CHANNEL \+ ":stop"/);
  assert.doesNotMatch(html, /require\(["'](?!\.\/|electron)/);
});

test('voice loopback: 自动批准屏幕源并返回系统回环音频', async () => {
  const fake = createFakeElectron();
  const capture = createLoopbackCapture({ electronImpl: fake.api, stopGraceMs: 5 });
  try {
    assert.equal(typeof fake.handlerState.handler, 'function');
    assert.deepEqual(fake.handlerState.opts, { useSystemPicker: false });
    let approved = null;
    await fake.handlerState.handler({}, (value) => { approved = value; });
    assert.equal(approved.audio, 'loopback');
    assert.equal(approved.video.id, 'screen:0:0');

    const win = fake.windows[0];
    assert.equal(win.options.show, false);
    assert.equal(win.options.webPreferences.backgroundThrottling, false);
    assert.equal(win.options.webPreferences.nodeIntegration, true);
    assert.ok(win.file, '采集页面应通过 file:// 加载（data: 不是安全上下文）');
    assert.match(fs.readFileSync(win.file, 'utf8'), /getDisplayMedia/);

    // 重复创建不会覆盖已注册的 handler
    const second = createLoopbackCapture({ electronImpl: fake.api, stopGraceMs: 5 });
    second.stop();
    assert.equal(fake.handlerState.opts.useSystemPicker, false);
  } finally {
    capture.stop();
  }
});

test('voice loopback: started/pcm/level 事件转发，stop 释放窗口', async () => {
  const fake = createFakeElectron();
  const events = { started: 0, pcm: [], level: [], error: [] };
  const capture = createLoopbackCapture({
    electronImpl: fake.api,
    stopGraceMs: 5,
    onStarted: () => { events.started += 1; },
    onPcm: (buffer) => events.pcm.push(buffer),
    onLevel: (value) => events.level.push(value),
    onError: (error) => events.error.push(error),
  });
  const win = fake.windows[0];
  const channel = capture.channel;

  fake.emit(channel, { type: 'pcm', data: Buffer.from([7, 7]).toString('base64') }, win);
  assert.equal(events.pcm.length, 0, '就绪前的音频应被丢弃');

  fake.emit(channel, { type: 'started' }, win);
  fake.emit(channel, { type: 'started' }, win);
  assert.equal(events.started, 1);

  const pcm = Buffer.from([1, 2, 3, 4]);
  fake.emit(channel, { type: 'pcm', data: pcm.toString('base64') }, win);
  assert.deepEqual(events.pcm, [pcm]);
  fake.emit(channel, { type: 'level', value: 0.25 }, win);
  assert.deepEqual(events.level, [0.25]);

  // 其它窗口发来的消息不能进入本会话
  const other = new fake.api.BrowserWindow({});
  fake.emit(channel, { type: 'pcm', data: pcm.toString('base64') }, other);
  assert.equal(events.pcm.length, 1);
  other.destroy();

  capture.stop();
  assert.ok(fake.sent.some((item) => item.channel === channel + ':stop'));
  assert.equal(fake.listenerCount(channel), 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(win.destroyed, true);
  assert.deepEqual(events.error, []);
});

test('voice loopback: 页面错误与启动超时都会清理并回调', async () => {
  const fake = createFakeElectron();
  const errors = [];
  const capture = createLoopbackCapture({
    electronImpl: fake.api, stopGraceMs: 5, onError: (error) => errors.push(error),
  });
  fake.emit(capture.channel, { type: 'error', error: '没有采集到系统音频轨道' }, fake.windows[0]);
  assert.deepEqual(errors, ['没有采集到系统音频轨道']);
  assert.equal(fake.windows[0].destroyed, true);
  assert.equal(fake.listenerCount(capture.channel), 0);

  const slow = createFakeElectron();
  const timeoutErrors = [];
  createLoopbackCapture({
    electronImpl: slow.api, startTimeoutMs: 10, stopGraceMs: 5, onError: (error) => timeoutErrors.push(error),
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(timeoutErrors, ['系统音频采集超时']);
  assert.equal(slow.windows[0].destroyed, true);
});