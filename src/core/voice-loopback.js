'use strict';
// 系统音频回环采集（仅 Windows）：在 gpt++ 自己的 Electron 主进程里开一个隐藏采集窗口，
// 用 setDisplayMediaRequestHandler 自动批准屏幕源并返回系统回环音频（audio: 'loopback'），
// 窗口内重采样成 16 kHz PCM16 后经 IPC 推给现有流式识别通道。
// 不在 ChatGPT 页面里调 getDisplayMedia：那个请求由 ChatGPT 自己的主进程处理，
// gpt++ 无法为它设置 handler，也无法保证它返回回环音频。
// 本文件只在主进程使用；electron 采用惰性 require，普通 Node（单测）下可安全加载。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const START_TIMEOUT_MS = 12000;
const STOP_GRACE_MS = 300;
const PCM_RATE = 16000;
const PCM_CHUNK = 2048;

let captureSeq = 0;

/** 只有运行在 Electron 主进程且为 Windows 时才支持系统音频回环。 */
function electronApi() {
  try {
    const api = require('electron');
    if (api && typeof api === 'object' && api.BrowserWindow && api.desktopCapturer && api.session && api.ipcMain) return api;
  } catch { /* 普通 Node 下 require('electron') 返回可执行文件路径 */ }
  return null;
}

function loopbackAvailable() {
  return process.platform === 'win32' && !!electronApi();
}

/** 隐藏采集窗口的页面：自包含，nodeIntegration 下用 ipcRenderer 回传 PCM。 */
function capturePageHtml(channel) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>gpt++ voice loopback</title></head><body><script>'
    + '(function () {\n'
    + "'use strict';\n"
    + 'var ipcRenderer = require("electron").ipcRenderer;\n'
    + 'var CHANNEL = ' + JSON.stringify(channel) + ';\n'
    + 'var RATE = ' + PCM_RATE + ', CHUNK = ' + PCM_CHUNK + ';\n'
    + 'var media = null, context = null, processor = null, mute = null;\n'
    + 'var carry = new Float32Array(0), lastLevelAt = 0, closed = false;\n'
    + 'function send(message) { try { ipcRenderer.send(CHANNEL, message); } catch (e) {} }\n'
    + 'function cleanup() {\n'
    + '  if (closed) return;\n'
    + '  closed = true;\n'
    + '  if (processor) { try { processor.onaudioprocess = null; } catch (e) {} try { processor.disconnect(); } catch (e) {} processor = null; }\n'
    + '  if (mute) { try { mute.disconnect(); } catch (e) {} mute = null; }\n'
    + '  if (media) { try { media.getTracks().forEach(function (track) { track.stop(); }); } catch (e) {} media = null; }\n'
    + '  if (context) { try { context.close().catch(function () {}); } catch (e) {} context = null; }\n'
    + '}\n'
    + 'ipcRenderer.on(CHANNEL + ":stop", function () { cleanup(); });\n'
    + 'function toBase64(bytes) {\n'
    + '  var text = "";\n'
    + '  for (var i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));\n'
    + '  return btoa(text);\n'
    + '}\n'
    + 'function feed(input) {\n'
    + '  var total = carry.length + input.length;\n'
    + '  var merged = new Float32Array(total);\n'
    + '  merged.set(carry, 0);\n'
    + '  merged.set(input, carry.length);\n'
    + '  var offset = 0;\n'
    + '  while (total - offset >= CHUNK) {\n'
    + '    var samples = merged.subarray(offset, offset + CHUNK);\n'
    + '    var bytes = new Uint8Array(samples.length * 2);\n'
    + '    var view = new DataView(bytes.buffer);\n'
    + '    var sum = 0;\n'
    + '    for (var i = 0; i < samples.length; i += 1) {\n'
    + '      var sample = samples[i];\n'
    + '      if (sample > 1) sample = 1; else if (sample < -1) sample = -1;\n'
    + '      sum += sample * sample;\n'
    + '      view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);\n'
    + '    }\n'
    + '    send({ type: "pcm", data: toBase64(bytes) });\n'
    + '    var now = Date.now();\n'
    + '    if (now - lastLevelAt >= 100) { lastLevelAt = now; send({ type: "level", value: Math.sqrt(sum / samples.length) }); }\n'
    + '    offset += CHUNK;\n'
    + '  }\n'
    + '  carry = offset < total ? merged.slice(offset) : new Float32Array(0);\n'
    + '}\n'
    + '(async function () {\n'
    + '  try {\n'
    + '    media = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 } });\n'
    + '    if (closed) { cleanup(); return; }\n'
    + '    if (!media.getAudioTracks().length) throw new Error("没有采集到系统音频轨道");\n'
    + '    media.getAudioTracks()[0].addEventListener("ended", function () {\n'
    + '      if (!closed) send({ type: "error", error: "系统音频采集已结束" });\n'
    + '    });\n'
    + '    context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });\n'
    + '    if (Math.round(context.sampleRate) !== RATE) throw new Error("16 kHz 采集不可用");\n'
    + '    if (context.state === "suspended") { try { await context.resume(); } catch (e) {} }\n'
    + '    var source = context.createMediaStreamSource(media);\n'
    + '    processor = context.createScriptProcessor(CHUNK, 1, 1);\n'
    + '    mute = context.createGain();\n'
    + '    mute.gain.value = 0;\n'
    + '    source.connect(processor);\n'
    + '    processor.connect(mute);\n'
    + '    mute.connect(context.destination);\n'
    + '    processor.onaudioprocess = function (event) {\n'
    + '      if (closed) return;\n'
    + '      try { feed(event.inputBuffer.getChannelData(0)); } catch (e) {}\n'
    + '    };\n'
    + '    send({ type: "started" });\n'
    + '  } catch (error) {\n'
    + '    cleanup();\n'
    + '    send({ type: "error", error: String((error && error.message) || error) });\n'
    + '  }\n'
    + '})();\n'
    + '})();\n'
    + '</script></body></html>';
}

/**
 * 开启一次系统音频回环采集。返回 { stop() }。
 * 回调：onStarted()（采集就绪）、onPcm(Buffer)（16 kHz PCM16）、onLevel(number)（波形电平）、onError(string)。
 * electronImpl / startTimeoutMs / stopGraceMs 可注入用于测试。
 */
function createLoopbackCapture(options = {}) {
  const api = options.electronImpl || electronApi();
  if (!api) throw new Error('系统音频回环需要 gpt++ 桌面运行时');
  if (process.platform !== 'win32' && !options.electronImpl) throw new Error('系统音频回环仅支持 Windows');
  const { BrowserWindow, desktopCapturer, session, ipcMain } = api;
  const onPcm = typeof options.onPcm === 'function' ? options.onPcm : () => {};
  const onStarted = typeof options.onStarted === 'function' ? options.onStarted : () => {};
  const onLevel = typeof options.onLevel === 'function' ? options.onLevel : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) ? options.startTimeoutMs : START_TIMEOUT_MS;
  const stopGraceMs = Number.isFinite(options.stopGraceMs) ? options.stopGraceMs : STOP_GRACE_MS;

  const channel = 'gptplus-voice-loopback-' + String(++captureSeq) + '-' + String(Date.now());
  let win = null;
  let pageFile = '';
  let stopped = false;
  let started = false;
  let startTimer = 0;
  let destroyTimer = 0;

  // 自动批准采集请求：返回第一块屏幕 + 系统回环音频，不弹选择器。
  // 标记挂在 session 对象上，重复调用不会覆盖已注册的 handler。
  const defaultSession = session.defaultSession;
  if (!defaultSession.__gptplusLoopbackHandler) {
    defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources && sources.length ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    }, { useSystemPicker: false });
    defaultSession.__gptplusLoopbackHandler = true;
  }

  function destroyWindow() {
    clearTimeout(destroyTimer);
    destroyTimer = 0;
    const current = win;
    win = null;
    if (current && !current.isDestroyed()) {
      try { current.destroy(); } catch { /* 窗口可能已退出 */ }
    }
    try { if (pageFile) fs.rmSync(pageFile, { force: true }); } catch { /* 临时页面清理失败不影响采集 */ }
  }

  function cleanup() {
    stopped = true;
    clearTimeout(startTimer);
    startTimer = 0;
    try { ipcMain.removeListener(channel, onMessage); } catch { /* ignore */ }
    destroyWindow();
  }

  function fail(message) {
    if (stopped) return;
    cleanup();
    try { onError(String(message || '系统音频采集失败')); } catch { /* 回调失败不影响清理 */ }
  }

  function onMessage(event, message) {
    if (stopped || !win || !event || event.sender !== win.webContents) return;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'started') {
      if (started) return;
      started = true;
      clearTimeout(startTimer);
      startTimer = 0;
      try { onStarted(); } catch { /* ignore */ }
      return;
    }
    if (message.type === 'pcm') {
      if (!started) return;
      let buffer = null;
      try { buffer = Buffer.from(String(message.data || ''), 'base64'); } catch { buffer = null; }
      if (buffer && buffer.length) {
        try { onPcm(buffer); } catch { /* ignore */ }
      }
      return;
    }
    if (message.type === 'level') {
      try { onLevel(Math.max(0, Number(message.value) || 0)); } catch { /* ignore */ }
      return;
    }
    if (message.type === 'error') {
      fail(message.error || '系统音频采集失败');
    }
  }

  ipcMain.on(channel, onMessage);

  // 采集页面必须从 file:// 加载：data: URL 在 Chromium 里不是安全上下文，
  // navigator.mediaDevices 不会暴露，getDisplayMedia 无从谈起。
  // 隐藏窗口只加载这里生成的静态页面，不访问任何远程内容，
  // 因此启用 nodeIntegration 供 ipcRenderer 回传 PCM，不引入远程代码风险。
  try {
    const pageDir = path.join(os.tmpdir(), 'gptplus-voice-loopback');
    pageFile = path.join(pageDir, channel + '.html');
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(pageFile, capturePageHtml(channel), 'utf8');
    win = new BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  win.once('closed', () => {
    win = null;
    if (!stopped) fail('系统音频采集窗口已关闭');
  });
  win.webContents.once('render-process-gone', () => {
    if (!stopped) fail('系统音频采集进程已退出');
  });
  startTimer = setTimeout(() => fail('系统音频采集超时'), startTimeoutMs);
  if (typeof startTimer.unref === 'function') startTimer.unref();
  win.loadFile(pageFile)
    .catch((error) => fail((error && error.message) || '系统音频采集页面加载失败'));

  return {
    channel,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(startTimer);
      startTimer = 0;
      try { ipcMain.removeListener(channel, onMessage); } catch { /* ignore */ }
      const current = win;
      if (current && !current.isDestroyed()) {
        // 先通知页面停掉轨道与 AudioContext，再兜底销毁窗口，确保回环采集被释放。
        try { current.webContents.send(channel + ':stop'); } catch { /* ignore */ }
        destroyTimer = setTimeout(destroyWindow, stopGraceMs);
        if (typeof destroyTimer.unref === 'function') destroyTimer.unref();
      } else {
        win = null;
      }
    },
  };
}

module.exports = {
  PCM_RATE,
  PCM_CHUNK,
  capturePageHtml,
  createLoopbackCapture,
  loopbackAvailable,
};