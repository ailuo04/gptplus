'use strict';
// 语音输入插件：把麦克风按钮注入 ChatGPT 输入框工具条，位于推理强度与发送键之间。
// 页面内只负责录音/插入文本；音频通过 CDP 桥交给主进程，再由主进程按插件配置转写。
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  findAvailablePort,
  listTargets,
  pickMainTarget,
  evaluate,
  addScriptOnNewDocument,
  removeScriptOnNewDocument,
} = require('./cdp.js');
const { findChatGptDebugPort } = require('./chatgpt-launch.js');
const { stripEndpoint } = require('./base-url.js');
const { createSystemProxyFetch } = require('./system-proxy.js');
const { localSpeechStatus, prepareSpeechModel, transcribeLocal } = require('./local-speech.js');

const DEFAULT_INJECT_TIMEOUT_MS = 30000;
const SCRIPT_READY_WAIT_MS = 15000;
const PROBE_READY_WAIT_MS = 2000;
const RETRY_INTERVAL_MS = 400;
const VOICE_POLL_MS = 350;
const VOICE_HIDDEN_POLL_MS = 1800;
const COMMAND_TIMEOUT_MS = 5000;
const ERROR_LOG_INTERVAL_MS = 60000;
const TRANSCRIBE_TIMEOUT_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 页面内运行时。这个函数会被 toString() 后注入 ChatGPT 页面，必须完全自包含。
 * @param {'system'|'provider'} engine
 * @param {number} readyWaitMs
 */
function voicePageRuntime(engine, readyWaitMs, localReady, language) {
  'use strict';
  var READY_WAIT_MS = Math.max(500, Number(readyWaitMs) || 15000);
  var ENGINE = engine === 'provider' ? 'provider' : engine === 'system' ? 'system' : 'local';
  var LOCAL_READY = localReady === true;
  var ID = 'gptplus-voice-input';
  var WRAP_ID = 'gptplus-voice-input-wrap';
  var PANEL_ID = 'gptplus-voice-panel';
  var STYLE_ID = 'gptplus-voice-input-style';
  var EXT_ATTR = 'data-gptplus-voice-input';
  var RUNTIME_KEY = 'gptplus-voice-input-v10';
  var MAX_RECORD_MS = 120000;
  var PTT_HOLD_MS = 1500;
  var state = {
    wrap: null,
    button: null,
    panel: null,
    message: null,
    timerLabel: null,
    actionButton: null,
    waveform: null,
    status: 'idle',
    recorder: null,
    stream: null,
    chunks: [],
    audioContext: null,
    analyser: null,
    levelSamples: null,
    waveformFrame: 0,
    startedAt: 0,
    timer: 0,
    observer: null,
    pending: null,
    request: null,
    activeId: '',
    requestId: 0,
    disposed: false,
    discard: false,
    toast: null,
    toastTimer: 0,
    syncTimer: 0,
    syncInterval: 0,
    transcribeTimer: 0,
    lastError: '',
    lastBridgeAt: Date.now(),
    card: null,
    localReady: LOCAL_READY,
    prepareText: '',
    savedRange: null,
    savedSelection: null,
    spaceHold: null,
    pttActive: false,
    lastSpace: null,
  };
  var NS = 'http://www.w3.org/2000/svg';

  if (globalThis.__gptplusVoiceRuntime === RUNTIME_KEY && globalThis.__gptplusVoice) {
    return { ok: true, installed: true, reused: true };
  }
  globalThis.__gptplusVoiceDispose?.();
  globalThis.__gptplusVoiceRuntime = RUNTIME_KEY;

  function isZh() {
    var lang = String(document.documentElement?.lang || navigator.language || '').toLowerCase();
    return lang.indexOf('zh') === 0;
  }

  function text() {
    var zh = isZh();
    return {
      idle: zh ? (ENGINE === 'local' ? '语音输入（本地识别，长按空格 1.5 秒）' : ENGINE === 'provider' ? '语音输入（提供商转写，长按空格 1.5 秒）' : '语音输入（Windows 系统听写）') : 'Voice input (hold Space for 1.5s)',
      requesting: zh ? '请允许使用麦克风…' : 'Allow microphone access…',
      preparing: zh ? '正在准备本地识别' : 'Preparing local speech',
      downloading: zh ? '正在下载识别模型' : 'Downloading speech model',
      loading: zh ? '正在加载识别模型' : 'Loading speech model',
      recording: zh ? '停止并识别' : 'Stop and transcribe',
      transcribing: zh ? '正在识别…' : 'Transcribing…',
      retry: zh ? '重试' : 'Retry',
      cancel: zh ? '取消' : 'Cancel',
      empty: zh ? '未识别到语音' : 'No speech detected',
      error: zh ? '语音输入失败' : 'Voice input failed',
      external: zh ? 'Windows 系统听写会弹出系统浮层' : 'Windows dictation opens a system overlay',
      noProvider: zh ? '请先在插件设置中选择转写提供商' : 'Choose a transcription provider in plugin settings',
    };
  }

  function svgIcon(kind) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (kind === 'stop') {
      var square = document.createElementNS(NS, 'rect');
      square.setAttribute('x', '5');
      square.setAttribute('y', '5');
      square.setAttribute('width', '6');
      square.setAttribute('height', '6');
      square.setAttribute('rx', '1.4');
      square.setAttribute('fill', 'currentColor');
      square.setAttribute('stroke', 'none');
      svg.appendChild(square);
      return svg;
    }
    if (kind === 'close') {
      var first = document.createElementNS(NS, 'path');
      first.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
      svg.appendChild(first);
      return svg;
    }
    if (kind === 'spinner') {
      svg.setAttribute('class', 'gptplus-voice-spin');
      var arc = document.createElementNS(NS, 'path');
      arc.setAttribute('d', 'M8 1.9a6.1 6.1 0 1 1-6.1 6.1');
      arc.setAttribute('stroke-opacity', '0.9');
      svg.appendChild(arc);
      return svg;
    }
    var mic = document.createElementNS(NS, 'path');
    mic.setAttribute('d', 'M8 2.6a2.2 2.2 0 0 1 2.2 2.2v2.7a2.2 2.2 0 0 1-4.4 0V4.8A2.2 2.2 0 0 1 8 2.6Z');
    svg.appendChild(mic);
    var stem = document.createElementNS(NS, 'path');
    stem.setAttribute('d', 'M3.9 7.5v.4a4.1 4.1 0 0 0 8.2 0v-.4M8 12v1.5');
    svg.appendChild(stem);
    return svg;
  }

  function buildWaveform() {
    var svg = document.createElementNS(NS, 'svg');
    svg.id = 'gptplus-voice-wave';
    svg.setAttribute('viewBox', '0 0 512 32');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 64; i += 1) {
      var line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(i * 8 + 4));
      line.setAttribute('x2', String(i * 8 + 4));
      line.setAttribute('y1', '15');
      line.setAttribute('y2', '17');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('opacity', String(0.25 + i / 120));
      svg.appendChild(line);
    }
    return svg;
  }

  function visible(node) {
    if (!node || !node.isConnected) return false;
    var rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function composerCard() {
    var cards = document.querySelectorAll('[data-composer-surface-variant]');
    var fallback = null;
    for (var i = 0; i < cards.length; i += 1) {
      var card = cards[i];
      if (!visible(card) || card.closest('[' + EXT_ATTR + ']')) continue;
      fallback = card;
      if (card.querySelector('.ProseMirror[contenteditable="true"], textarea:not(:disabled):not([readonly]), [role="textbox"][contenteditable="true"]')) return card;
    }
    return fallback;
  }

  function editorNode() {
    var card = state.card || composerCard();
    if (!card) return null;
    return card.querySelector('.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea:not(:disabled):not([readonly])');
  }

  function sendButton(card) {
    var direct = card.querySelector('div.ms-2.flex.items-center > button');
    if (direct && visible(direct)) return direct;
    var buttons = card.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) {
      var label = String(buttons[i].getAttribute('aria-label') || '').trim();
      if (/^(发送|发送消息|停止|send|send message|stop)$/i.test(label) && visible(buttons[i])) return buttons[i];
    }
    return null;
  }

  function showToast(message, kind) {
    if (!message || state.disposed) return;
    if (state.toast) {
      state.toast.remove();
      state.toast = null;
    }
    clearTimeout(state.toastTimer);
    var toast = document.createElement('div');
    toast.setAttribute(EXT_ATTR, 'true');
    toast.textContent = String(message);
    toast.style.cssText = 'position:fixed;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));padding:7px 10px;border:1px solid rgba(127,127,127,.28);border-radius:9px;background:var(--color-token-menu-background,#2f2f2f);color:var(--color-token-text-primary,#f4f4f4);font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;white-space:normal;word-break:break-word;';
    if (kind === 'error') toast.style.borderColor = 'rgba(239,68,68,.55)';
    if (kind === 'ok') toast.style.borderColor = 'rgba(34,197,94,.45)';
    document.body.appendChild(toast);
    state.toast = toast;
    var rect = state.wrap ? state.wrap.getBoundingClientRect() : null;
    var left = rect ? rect.left + rect.width / 2 : window.innerWidth - 48;
    var top = rect ? rect.top - 8 : window.innerHeight - 80;
    var width = toast.offsetWidth || 220;
    if (left - width / 2 < 12) left = width / 2 + 12;
    if (left + width / 2 > window.innerWidth - 12) left = window.innerWidth - width / 2 - 12;
    toast.style.left = left + 'px';
    toast.style.top = Math.max(12, top) + 'px';
    toast.style.transform = 'translate(-50%,-100%)';
    state.toastTimer = setTimeout(function () {
      if (state.toast === toast) state.toast = null;
      toast.remove();
    }, 4200);
  }

  function clearStatusTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = 0;
    }
  }

  function updateRecordingLabel() {
    if (state.status !== 'recording') return;
    var elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    var minutes = Math.floor(elapsed / 60);
    var seconds = String(elapsed % 60).padStart(2, '0');
    if (state.timerLabel) state.timerLabel.textContent = minutes + ':' + seconds;
    if (state.button) {
      state.button.title = text().recording + ' ' + minutes + ':' + seconds;
      state.button.setAttribute('aria-label', text().recording);
    }
  }

  function messageForStatus() {
    var labels = text();
    if (state.status === 'preparing') return state.prepareText || labels.preparing;
    if (state.status === 'downloading') return state.prepareText || labels.downloading;
    if (state.status === 'loading') return state.prepareText || labels.loading;
    if (state.status === 'requesting') return labels.requesting;
    if (state.status === 'transcribing') return labels.transcribing;
    if (state.status === 'error') return state.lastError || labels.error;
    if (state.status === 'feedback') return state.lastError || labels.empty;
    return '';
  }

  function render() {
    if (!state.wrap || !state.panel) return;
    var labels = text();
    var active = state.status !== 'idle';
    state.wrap.dataset.active = active ? 'true' : 'false';
    state.panel.dataset.phase = state.status;
    if (state.button) {
      state.button.replaceChildren(svgIcon('mic'));
      state.button.title = labels.idle;
      state.button.setAttribute('aria-label', labels.idle);
    }
    if (state.message) {
      var message = messageForStatus();
      state.message.textContent = message;
      state.message.title = message;
      state.message.style.display = state.status === 'recording' ? 'none' : 'flex';
    }
    var wave = state.panel.querySelector('#gptplus-voice-wave');
    if (wave) wave.style.display = state.status === 'recording' ? 'block' : 'none';
    if (state.timerLabel) state.timerLabel.style.display = state.status === 'recording' ? 'inline-block' : 'none';
    if (state.actionButton) {
      if (state.status === 'recording') {
        state.actionButton.style.display = 'inline-flex';
        state.actionButton.replaceChildren(svgIcon('stop'));
        state.actionButton.title = labels.recording;
        state.actionButton.setAttribute('aria-label', labels.recording);
      } else if (state.status === 'error' || state.status === 'feedback') {
        state.actionButton.style.display = 'inline-flex';
        state.actionButton.replaceChildren(svgIcon('mic'));
        state.actionButton.title = labels.retry;
        state.actionButton.setAttribute('aria-label', labels.retry);
      } else {
        state.actionButton.style.display = 'none';
      }
    }
    if (state.status === 'recording') updateRecordingLabel();
  }

  function setStatus(next) {
    state.status = next;
    if (next !== 'recording') clearStatusTimer();
    render();
  }

  function closeAudioContext() {
    cancelAnimationFrame(state.waveformFrame);
    state.waveformFrame = 0;
    state.analyser = null;
    state.levelSamples = null;
    var context = state.audioContext;
    state.audioContext = null;
    if (context && context.state !== 'closed') {
      try { context.close().catch(function () {}); } catch (e) {}
    }
  }

  function stopStream(stream) {
    if (!stream) return;
    try {
      var tracks = stream.getTracks();
      for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
    } catch (e) {}
  }

  function fail(message) {
    clearTimeout(state.transcribeTimer);
    state.lastError = String(message || text().error);
    setStatus('error');
  }

  function emptyResult() {
    state.lastError = text().empty;
    setStatus('feedback');
  }

  function captureSelection() {
    var editor = editorNode();
    if (!editor) {
      state.savedRange = null;
      state.savedSelection = null;
      return;
    }
    if (editor.tagName === 'TEXTAREA') {
      state.savedSelection = { start: editor.selectionStart, end: editor.selectionEnd };
      state.savedRange = null;
      return;
    }
    state.savedSelection = null;
    var selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      state.savedRange = selection.getRangeAt(0).cloneRange();
    } else {
      state.savedRange = null;
    }
  }

  function focusEditor() {
    var editor = editorNode();
    if (!editor) return null;
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      var saved = state.savedSelection;
      var start = saved && saved.start != null ? saved.start : editor.value.length;
      var end = saved && saved.end != null ? saved.end : start;
      try { editor.setSelectionRange(start, end); } catch (e) {}
      return editor;
    }
    var selection = window.getSelection();
    if (!selection) return editor;
    if (state.savedRange && editor.contains(state.savedRange.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(state.savedRange);
      return editor;
    }
    var range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return editor;
  }

  function insertText(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return false;
    var editor = focusEditor();
    if (!editor) {
      showToast(isZh() ? '找不到输入框，转写结果未插入' : 'Composer not found; transcript not inserted', 'error');
      return false;
    }
    if (editor.tagName === 'TEXTAREA') {
      var start = editor.selectionStart == null ? editor.value.length : editor.selectionStart;
      var end = editor.selectionEnd == null ? start : editor.selectionEnd;
      var before = start > 0 ? editor.value.charAt(start - 1) : '';
      var prefix = before && !/\s/.test(before) ? ' ' : '';
      var payload = prefix + value;
      editor.setRangeText(payload, start, end, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      state.savedSelection = null;
      return true;
    }
    var selection = window.getSelection();
    var leading = '';
    if (selection && selection.rangeCount > 0) {
      var range = selection.getRangeAt(0);
      var pre = range.cloneRange();
      pre.selectNodeContents(editor);
      pre.setEnd(range.startContainer, range.startOffset);
      var beforeText = pre.toString();
      if (beforeText && !/[\s\n]$/.test(beforeText)) leading = ' ';
    }
    var full = leading + value;
    var ok = false;
    try { ok = document.execCommand('insertText', false, full); } catch (e) { ok = false; }
    if (!ok) {
      try {
        var sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          var r = sel.getRangeAt(0);
          r.deleteContents();
          var node = document.createTextNode(full);
          r.insertNode(node);
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: full }));
      } catch (e) {
        return false;
      }
    }
    state.savedRange = null;
    return true;
  }

  function encodeWave(samples) {
    var bytes = new Uint8Array(44 + samples.length * 2);
    var view = new DataView(bytes.buffer);
    var marker = function (at, value) {
      for (var i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i);
    };
    marker(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    marker(8, 'WAVE');
    marker(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    marker(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i += 1) {
      var sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(text);
  }

  async function decodeLocalAudio(chunks, mime) {
    if (!state.audioContext) throw new Error(isZh() ? '音频上下文已关闭' : 'Audio context closed');
    var blob = new Blob(chunks, { type: mime || 'audio/webm' });
    if (!blob.size) throw new Error(text().empty);
    var decoded = await state.audioContext.decodeAudioData(await blob.arrayBuffer());
    var seconds = Math.min(decoded.duration, MAX_RECORD_MS / 1000);
    var offline = new OfflineAudioContext(1, Math.max(1, Math.floor(seconds * 16000)), 16000);
    var source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    var rendered = await offline.startRendering();
    return encodeWave(rendered.getChannelData(0));
  }

  function uploadProvider(blob) {
    if (!blob || !blob.size) {
      emptyResult();
      return;
    }
    setStatus('transcribing');
    clearTimeout(state.transcribeTimer);
    state.transcribeTimer = setTimeout(function () {
      if (!state.disposed && state.status === 'transcribing') fail(isZh() ? '识别超时，请重试' : 'Transcription timed out; try again');
    }, 95000);
    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result || '');
      var comma = data.indexOf(',');
      if (comma < 0) {
        fail(isZh() ? '音频编码失败' : 'Audio encoding failed');
        return;
      }
      var id = String(++state.requestId);
      state.activeId = id;
      state.pending = {
        id: id,
        mime: blob.type || 'audio/webm',
        data: data.slice(comma + 1),
        durationMs: Math.max(0, Date.now() - state.startedAt),
        engine: ENGINE,
      };
    };
    reader.onerror = function () {
      fail(isZh() ? '音频编码失败' : 'Audio encoding failed');
    };
    reader.readAsDataURL(blob);
  }

  async function uploadLocal(chunks, mime) {
    setStatus('transcribing');
    clearTimeout(state.transcribeTimer);
    state.transcribeTimer = setTimeout(function () {
      if (!state.disposed && state.status === 'transcribing') fail(isZh() ? '识别超时，请重试' : 'Transcription timed out; try again');
    }, 95000);
    try {
      var bytes = await decodeLocalAudio(chunks, mime);
      if (state.disposed) return;
      var id = String(++state.requestId);
      state.activeId = id;
      state.pending = {
        id: id,
        mime: 'audio/wav',
        data: bytesToBase64(bytes),
        durationMs: Math.max(0, Date.now() - state.startedAt),
        engine: ENGINE,
      };
    } catch (error) {
      fail((error && error.message) || (isZh() ? '音频处理失败' : 'Audio processing failed'));
    }
  }

  function stopRecording(send) {
    if (!state.recorder) return;
    state.discard = send !== true;
    clearStatusTimer();
    try {
      state.recorder.stop();
    } catch (e) {
      state.recorder = null;
      stopStream(state.stream);
      state.stream = null;
      closeAudioContext();
      setStatus('idle');
      return;
    }
    if (send === true) setStatus('transcribing');
    else setStatus('idle');
  }

  function startWaveform() {
    if (!state.waveform || !state.analyser || !state.levelSamples) return;
    var bars = [];
    var lines = state.waveform.querySelectorAll('line');
    for (var i = lines.length - 1; i >= 0; i -= 1) bars.push({ element: lines[i], level: 0 });
    var previous = -Infinity;
    function draw(now) {
      if (now - previous >= 50) {
        previous = now;
        var next = 0;
        try {
          state.analyser.getFloatTimeDomainData(state.levelSamples);
          var sum = 0;
          for (var i = 0; i < state.levelSamples.length; i += 1) sum += state.levelSamples[i] * state.levelSamples[i];
          next = Math.sqrt(sum / state.levelSamples.length);
        } catch (e) {
          next = 0;
        }
        for (var j = 0; j < bars.length; j += 1) {
          var bar = bars[j];
          var carried = bar.level;
          bar.level = next;
          next = carried;
          var height = 1 + Math.min(1, bar.level * 6) * 14;
          bar.element.setAttribute('y1', String(16 - height));
          bar.element.setAttribute('y2', String(16 + height));
        }
      }
      state.waveformFrame = requestAnimationFrame(draw);
    }
    state.waveformFrame = requestAnimationFrame(draw);
  }

  async function startRecording() {
    if (state.disposed || state.recorder || state.status === 'recording' || state.status === 'transcribing') return;
    if (!bridgeReady()) {
      fail(isZh() ? 'gpt++ 未连接，请先启动 gpt++' : 'gpt++ is not connected');
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof MediaRecorder !== 'function') {
      fail(isZh() ? '当前页面不支持录音' : 'Recording is not supported here');
      return;
    }
    captureSelection();
    setStatus('requesting');
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (state.disposed || state.status === 'idle') {
        stopStream(stream);
        return;
      }
      state.stream = stream;
      var context = new AudioContext();
      var analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      state.audioContext = context;
      state.analyser = analyser;
      state.levelSamples = new Float32Array(analyser.fftSize);
      var mime = '';
      var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      for (var i = 0; i < candidates.length; i += 1) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) {
          mime = candidates[i];
          break;
        }
      }
      var options = mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : {};
      var recorder = new MediaRecorder(stream, options);
      state.chunks = [];
      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) state.chunks.push(event.data);
      };
      recorder.onerror = function (event) {
        state.discard = true;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
        fail((event && event.error && event.error.message) || (isZh() ? '录音失败' : 'Recording failed'));
      };
      recorder.onstop = function () {
        if (state.disposed) return;
        var chunks = state.chunks;
        var type = recorder.mimeType || mime || 'audio/webm';
        state.chunks = [];
        state.recorder = null;
        stopStream(stream);
        if (state.stream === stream) state.stream = null;
        if (state.discard) {
          state.discard = false;
          closeAudioContext();
          setStatus('idle');
          return;
        }
        if (ENGINE === 'local') {
          uploadLocal(chunks, type).finally(closeAudioContext);
        } else {
          closeAudioContext();
          uploadProvider(new Blob(chunks, { type: type }));
        }
      };
      state.recorder = recorder;
      state.startedAt = Date.now();
      state.discard = false;
      recorder.start(250);
      setStatus('recording');
      startWaveform();
      clearStatusTimer();
      state.timer = setInterval(updateRecordingLabel, 500);
      updateRecordingLabel();
      setTimeout(function () {
        if (!state.disposed && state.status === 'recording') stopRecording(true);
      }, MAX_RECORD_MS);
    } catch (error) {
      stopStream(state.stream);
      state.stream = null;
      closeAudioContext();
      var message = error && error.name === 'NotAllowedError'
        ? (isZh() ? '麦克风权限被拒绝' : 'Microphone permission denied')
        : (isZh() ? '无法开始录音: ' : 'Could not start recording: ') + ((error && error.message) || error);
      fail(message);
    }
  }

  function requestPreparation() {
    if (state.request || state.status === 'preparing' || state.status === 'downloading' || state.status === 'loading') return;
    var id = String(++state.requestId);
    state.activeId = id;
    state.request = { id: id, type: 'prepare-local', engine: ENGINE };
    state.prepareText = isZh() ? '正在准备本地识别…' : 'Preparing local speech…';
    setStatus('preparing');
  }

  function cancelActive() {
    var had = state.status !== 'idle';
    state.pttActive = false;
    if (state.wrap) state.wrap.dataset.holding = 'false';
    if (state.spaceHold) {
      clearTimeout(state.spaceHold.timer);
      state.spaceHold = null;
    }
    state.activeId = '';
    state.pending = null;
    state.request = null;
    state.discard = true;
    clearTimeout(state.transcribeTimer);
    clearStatusTimer();
    if (state.recorder) {
      try { state.recorder.stop(); } catch (e) {}
      state.recorder = null;
    }
    stopStream(state.stream);
    state.stream = null;
    closeAudioContext();
    state.chunks = [];
    state.lastError = '';
    state.prepareText = '';
    state.savedRange = null;
    state.savedSelection = null;
    if (had) setStatus('idle');
  }

  function composerFocused() {
    var editor = editorNode();
    return !!(editor && (document.activeElement === editor || editor.contains(document.activeElement)));
  }

  function editorSelectionCollapsed() {
    var editor = editorNode();
    if (!editor) return false;
    if (editor.tagName === 'TEXTAREA') return editor.selectionStart === editor.selectionEnd;
    var selection = window.getSelection();
    return !!(selection && selection.rangeCount > 0 && selection.isCollapsed && editor.contains(selection.anchorNode));
  }

  function trailingSpaceCount() {
    var editor = editorNode();
    if (!editor) return 0;
    if (editor.tagName === 'TEXTAREA') {
      var position = editor.selectionStart == null ? editor.value.length : editor.selectionStart;
      var total = 0;
      while (position - total > 0 && /[ \u00a0]/.test(editor.value.charAt(position - total - 1))) total += 1;
      return total;
    }
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount) return 0;
    var range = selection.getRangeAt(0);
    var pre = range.cloneRange();
    pre.selectNodeContents(editor);
    pre.setEnd(range.startContainer, range.startOffset);
    var before = pre.toString();
    var count = 0;
    for (var i = before.length - 1; i >= 0 && /[ \u00a0]/.test(before.charAt(i)); i -= 1) count += 1;
    return count;
  }

  function removeTrailingSpaces(count) {
    if (!count) return;
    var editor = editorNode();
    if (!editor) return;
    if (editor.tagName === 'TEXTAREA') {
      var position = editor.selectionStart == null ? editor.value.length : editor.selectionStart;
      var from = Math.max(0, position - count);
      editor.setRangeText('', from, position, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    for (var i = 0; i < count; i += 1) {
      try { document.execCommand('delete', false, null); } catch (e) { break; }
    }
  }

  function beginPushToTalk() {
    if (state.disposed || state.pttActive) return;
    if (ENGINE === 'system') return;
    if (state.status !== 'idle' && state.status !== 'error' && state.status !== 'feedback') return;
    if (!bridgeReady()) {
      fail(isZh() ? 'gpt++ 未连接，请先启动 gpt++' : 'gpt++ is not connected');
      return;
    }
    state.pttActive = true;
    state.lastError = '';
    if (state.status === 'error' || state.status === 'feedback') setStatus('idle');
    if (ENGINE === 'local' && !state.localReady) {
      requestPreparation();
      return;
    }
    void startRecording();
  }

  function endPushToTalk() {
    if (!state.pttActive) return;
    state.pttActive = false;
    if (state.status === 'recording') {
      stopRecording(true);
      return;
    }
    if (state.status === 'requesting' || state.status === 'preparing' || state.status === 'downloading' || state.status === 'loading') {
      cancelActive();
    }
  }

  function pageSpaceAllowed() {
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return true;
    var tag = String(active.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return false;
    if (active.isContentEditable) return false;
    if (active.closest && active.closest('button,[role="button"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"]')) return false;
    return true;
  }

  function activateSpaceHold(hold) {
    if (state.disposed || state.spaceHold !== hold || hold.active) return;
    hold.active = true;
    clearTimeout(hold.timer);
    hold.timer = 0;
    if (state.wrap) state.wrap.dataset.holding = 'false';
    if (hold.inEditor) {
      var spaces = Math.min(trailingSpaceCount(), hold.count);
      if (spaces > 0) removeTrailingSpaces(spaces);
    }
    beginPushToTalk();
  }

  function onSpaceDown(event) {
    if (ENGINE === 'system') return;
    if (event.key === ' ' || event.code === 'Space') {
      state.lastSpace = {
        at: Date.now(),
        repeat: event.repeat === true,
        composing: event.isComposing === true,
        hasFocus: document.hasFocus() === true,
        activeElement: String(document.activeElement?.className || document.activeElement?.tagName || '').slice(0, 80),
        status: state.status,
      };
    }
    if (event.key !== ' ' && event.code !== 'Space') return;
    if (event.isComposing === true) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (state.spaceHold) {
      if (state.spaceHold.active) {
        event.preventDefault();
        return;
      }
      state.spaceHold.count += 1;
      if (Date.now() - state.spaceHold.startedAt >= PTT_HOLD_MS) {
        event.preventDefault();
        activateSpaceHold(state.spaceHold);
      }
      return;
    }
    var inEditor = composerFocused();
    if (!inEditor && !pageSpaceAllowed()) return;
    if (inEditor && !editorSelectionCollapsed()) return;
    if (state.status !== 'idle' && state.status !== 'error' && state.status !== 'feedback') return;
    var hold = { count: 1, active: false, timer: 0, startedAt: Date.now(), inEditor: inEditor };
    hold.timer = setTimeout(function () {
      activateSpaceHold(hold);
    }, PTT_HOLD_MS);
    state.spaceHold = hold;
    if (state.lastSpace) {
      state.lastSpace.armed = true;
      state.lastSpace.inEditor = inEditor;
    }
    if (state.wrap) state.wrap.dataset.holding = 'true';
  }

  function onSpaceUp(event) {
    if (event.key !== ' ' && event.code !== 'Space') return;
    var hold = state.spaceHold;
    if (!hold) {
      if (state.pttActive) {
        event.preventDefault();
        endPushToTalk();
      }
      return;
    }
    state.spaceHold = null;
    if (state.wrap) state.wrap.dataset.holding = 'false';
    clearTimeout(hold.timer);
    if (!hold.active) return;
    event.preventDefault();
    endPushToTalk();
  }

  function bridgeReady() {
    return state.lastBridgeAt > 0 && Date.now() - state.lastBridgeAt < 5000;
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (state.status === 'recording') {
      stopRecording(true);
      return;
    }
    if (state.status === 'transcribing' || state.status === 'preparing' || state.status === 'downloading' || state.status === 'loading') {
      return;
    }
    if (state.status === 'requesting') return;
    if (state.status === 'error' || state.status === 'feedback') {
      state.lastError = '';
      setStatus('idle');
    }
    if (!bridgeReady()) {
      fail(isZh() ? 'gpt++ 未连接，请先启动 gpt++' : 'gpt++ is not connected');
      return;
    }
    if (ENGINE === 'system') {
      focusEditor();
      var id = String(++state.requestId);
      state.activeId = id;
      state.request = { id: id, type: 'system-dictation', engine: ENGINE };
      setStatus('idle');
      showToast(text().external, 'info');
      setTimeout(function () { if (!state.disposed) focusEditor(); }, 0);
      return;
    }
    if (ENGINE === 'local' && !state.localReady) {
      requestPreparation();
      return;
    }
    void startRecording();
  }

  function buildButton() {
    var wrap = document.createElement('span');
    wrap.id = WRAP_ID;
    wrap.setAttribute(EXT_ATTR, 'true');
    wrap.dataset.active = 'false';
    var button = document.createElement('button');
    button.id = ID;
    button.type = 'button';
    button.tabIndex = -1;
    button.setAttribute(EXT_ATTR, 'true');
    button.addEventListener('mousedown', function (event) { event.preventDefault(); });
    button.addEventListener('click', onClick);
    wrap.appendChild(button);

    var panel = document.createElement('span');
    panel.id = PANEL_ID;
    panel.setAttribute(EXT_ATTR, 'true');
    panel.dataset.phase = 'idle';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'gptplus-voice-round';
    cancel.setAttribute(EXT_ATTR, 'true');
    cancel.title = text().cancel;
    cancel.setAttribute('aria-label', text().cancel);
    cancel.addEventListener('mousedown', function (event) { event.preventDefault(); });
    cancel.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      cancelActive();
    });
    cancel.replaceChildren(svgIcon('close'));
    panel.appendChild(cancel);

    var body = document.createElement('span');
    body.className = 'gptplus-voice-body';
    var waveform = buildWaveform();
    body.appendChild(waveform);
    var message = document.createElement('span');
    message.className = 'gptplus-voice-message';
    message.setAttribute('role', 'status');
    body.appendChild(message);
    var timerLabel = document.createElement('span');
    timerLabel.className = 'gptplus-voice-timer';
    body.appendChild(timerLabel);
    panel.appendChild(body);

    var action = document.createElement('button');
    action.type = 'button';
    action.className = 'gptplus-voice-round';
    action.setAttribute(EXT_ATTR, 'true');
    action.addEventListener('mousedown', function (event) { event.preventDefault(); });
    action.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (state.status === 'recording') stopRecording(true);
      else if (state.status === 'error' || state.status === 'feedback') {
        state.lastError = '';
        setStatus('idle');
        void startRecording();
      }
    });
    panel.appendChild(action);
    wrap.appendChild(panel);

    state.wrap = wrap;
    state.button = button;
    state.panel = panel;
    state.message = message;
    state.timerLabel = timerLabel;
    state.actionButton = action;
    state.waveform = waveform;
    render();
    return wrap;
  }

  function hide() {
    if (state.wrap && state.wrap.isConnected) state.wrap.style.display = 'none';
  }

  function sync() {
    if (state.disposed) return;
    var card = composerCard();
    if (!card) {
      hide();
      return;
    }
    state.card = card;
    var send = sendButton(card);
    if (!send) {
      hide();
      return;
    }
    var sendWrap = send.closest('div.ms-2') || send.parentElement;
    if (!sendWrap || !sendWrap.parentElement) {
      hide();
      return;
    }
    if (!state.wrap) buildButton();
    var slot = sendWrap.previousElementSibling;
    var useSlot = slot && slot !== state.wrap && slot.classList && slot.classList.contains('empty:hidden');
    if (useSlot) {
      if (state.wrap.parentElement !== slot) slot.appendChild(state.wrap);
    } else if (state.wrap.parentElement !== sendWrap.parentElement || state.wrap.nextElementSibling !== sendWrap) {
      sendWrap.parentElement.insertBefore(state.wrap, sendWrap);
    }
    state.wrap.style.display = 'inline-flex';
  }

  function scheduleSync() {
    if (state.disposed || state.syncTimer) return;
    state.syncTimer = setTimeout(function () {
      state.syncTimer = 0;
      sync();
    }, 60);
  }

  function install() {
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute(EXT_ATTR, 'true');
      style.textContent = '@property --gptplus-hold{syntax:"<angle>";inherits:false;initial-value:0deg}'
        + '#gptplus-voice-input{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 66%,transparent);cursor:pointer;transition:background-color .15s,color .15s,opacity .15s,box-shadow .15s;outline:none}'
        + '#gptplus-voice-input:hover{background:color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 10%,transparent);color:var(--color-token-text-primary,#dfdfdf)}'
        + '#gptplus-voice-input:focus-visible{outline:2px solid color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 45%,transparent);outline-offset:1px}'
        + '#gptplus-voice-input-wrap[data-holding="true"] #gptplus-voice-input{color:var(--color-token-text-primary,#1a1c1f);background:color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 10%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 8%,transparent)}'
        + '#gptplus-voice-input-wrap[data-holding="true"] #gptplus-voice-input::after{content:"";position:absolute;inset:-2px;border-radius:999px;padding:2px;background:conic-gradient(currentColor var(--gptplus-hold,0deg),transparent 0);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;animation:gptplus-voice-hold 1.5s linear forwards}'
        + '@keyframes gptplus-voice-hold{from{--gptplus-hold:0deg}to{--gptplus-hold:360deg}}'
        + '#gptplus-voice-input svg{width:16px;height:16px;display:block}'
        + '#gptplus-voice-input-wrap{display:inline-flex;align-items:center;position:relative;margin-inline-start:4px;margin-inline-end:2px;min-width:0}'
        + '#gptplus-voice-panel{display:none;position:absolute;right:0;bottom:calc(100% + 8px);z-index:2147483000;box-sizing:border-box;align-items:center;gap:8px;width:min(320px,44vw);min-width:250px;height:44px;padding:6px 8px;border:1px solid color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 18%,transparent);border-radius:14px;background:var(--color-token-main-surface-primary,#fff);color:var(--color-token-text-primary,#1a1c1f);box-shadow:0 16px 40px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.07);pointer-events:auto}'
        + '#gptplus-voice-input-wrap[data-active="true"] #gptplus-voice-panel{display:inline-flex;animation:gptplus-voice-pop .14s ease-out}'
        + '#gptplus-voice-input-wrap[data-active="true"] #gptplus-voice-input{visibility:hidden;pointer-events:none}'
        + '.gptplus-voice-round{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:30px;height:30px;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 9%,transparent);color:color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 82%,transparent);cursor:pointer;transition:background-color .15s,color .15s;outline:none}'
        + '.gptplus-voice-round:hover{background:color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 16%,transparent);color:var(--color-token-text-primary,#dfdfdf)}'
        + '.gptplus-voice-round:focus-visible{outline:2px solid color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 45%,transparent);outline-offset:1px}'
        + '.gptplus-voice-round svg{width:14px;height:14px;display:block}'
        + '.gptplus-voice-body{display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden}'
        + '#gptplus-voice-wave{display:none;flex:1;min-width:36px;height:24px;color:color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 70%,transparent)}'
        + '.gptplus-voice-message{display:none;align-items:center;flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:1.2;color:color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 68%,transparent)}'
        + '.gptplus-voice-timer{display:none;flex:0 0 auto;font-size:11px;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 55%,transparent)}'
        + '#gptplus-voice-panel[data-phase="error"] .gptplus-voice-message{color:#ef4444}'
        + '#gptplus-voice-panel[data-phase="feedback"] .gptplus-voice-message{color:color-mix(in srgb,var(--color-token-text-primary,#1a1c1f) 55%,transparent)}'
        + '.gptplus-voice-spin{animation:gptplus-voice-spin .85s linear infinite;transform-origin:center}'
        + '@keyframes gptplus-voice-spin{to{transform:rotate(360deg)}}'
        + '@keyframes gptplus-voice-pop{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}';
      document.head?.appendChild(style);
    }
    document.getElementById(WRAP_ID)?.remove();
    state.wrap = null;
    state.button = null;
    state.panel = null;
    state.message = null;
    state.timerLabel = null;
    state.actionButton = null;
    state.waveform = null;
    state.observer = new MutationObserver(function (records) {
      var relevant = false;
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.target && record.target.closest && record.target.closest('[' + EXT_ATTR + ']')) continue;
        if (record.type === 'attributes') {
          relevant = true;
          break;
        }
        var nodes = record.addedNodes;
        for (var j = 0; j < nodes.length; j += 1) {
          var node = nodes[j];
          if (node.nodeType === 1 && !node.matches?.('[' + EXT_ATTR + ']') && (node.matches?.('[data-composer-surface-variant]') || node.querySelector?.('[data-composer-surface-variant]'))) {
            relevant = true;
            break;
          }
        }
        var removed = record.removedNodes;
        for (var k = 0; k < removed.length; k += 1) {
          var gone = removed[k];
          if (gone.nodeType === 1 && gone.matches?.('[' + EXT_ATTR + ']')) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
      if (relevant) scheduleSync();
    });
    state.observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-composer-surface-variant', 'data-state', 'aria-label'],
    });
    state.lastBridgeAt = Date.now();
    state.keydown = function (event) {
      if (event.key === 'Escape' && state.status !== 'idle') {
        event.preventDefault();
        event.stopPropagation();
        cancelActive();
        return;
      }
      onSpaceDown(event);
    };
    state.keyup = function (event) {
      onSpaceUp(event);
    };
    state.blur = function (event) {
      if (event && event.target && event.target !== window) return;
      if (state.wrap) state.wrap.dataset.holding = 'false';
      if (state.spaceHold) {
        clearTimeout(state.spaceHold.timer);
        state.spaceHold = null;
      }
      if (state.pttActive) {
        state.pttActive = false;
        cancelActive();
      }
    };
    state.visibility = function () {
      if (document.hidden && (state.status === 'recording' || state.status === 'requesting')) cancelActive();
    };
    document.addEventListener('keydown', state.keydown, true);
    document.addEventListener('keyup', state.keyup, true);
    document.addEventListener('visibilitychange', state.visibility);
    window.addEventListener('blur', state.blur, true);
    sync();
    state.syncInterval = setInterval(sync, 2000);
    globalThis.__gptplusVoice = {
      context: function () {
        return {
          mounted: !!(state.wrap && state.wrap.isConnected),
          status: state.status,
          hidden: document.hidden === true,
          engine: ENGINE,
          localReady: state.localReady,
          spaceHeld: !!state.spaceHold,
          spaceActive: !!(state.spaceHold && state.spaceHold.active),
          pttActive: state.pttActive,
          lastSpace: state.lastSpace,
        };
      },
      touch: function () {
        state.lastBridgeAt = Date.now();
      },
      takePending: function () {
        var pending = state.pending;
        state.pending = null;
        return pending;
      },
      takeRequest: function () {
        var request = state.request;
        state.request = null;
        return request;
      },
      prepareProgress: function (id, progress) {
        if (state.disposed || String(id) !== String(state.activeId)) return false;
        var phase = progress && progress.phase;
        var percent = progress && Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
        state.prepareText = phase === 'load' || phase === 'ready'
          ? text().loading
          : (phase === 'download' ? text().downloading + ' ' + percent + '%' : text().preparing);
        if (phase === 'download') setStatus('downloading');
        else if (phase === 'load') setStatus('loading');
        else setStatus('preparing');
        return true;
      },
      prepared: function (id) {
        if (state.disposed || String(id) !== String(state.activeId)) return false;
        state.localReady = true;
        state.activeId = '';
        state.request = null;
        state.prepareText = '';
        setStatus('idle');
        void startRecording();
        return true;
      },
      complete: function (id, result) {
        if (state.disposed) return false;
        if (String(id) !== String(state.activeId)) return false;
        state.activeId = '';
        clearTimeout(state.transcribeTimer);
        state.lastBridgeAt = Date.now();
        if (result && result.ok === true) {
          if (result.text) {
            var inserted = insertText(result.text);
            if (!inserted) {
              fail(isZh() ? '转写结果插入失败' : 'Could not insert transcript');
              return true;
            }
            setStatus('idle');
            if (result.notice) showToast(result.notice, 'ok');
            return true;
          }
          emptyResult();
          return true;
        }
        fail((result && result.error) || (isZh() ? '识别失败' : 'Transcription failed'));
        return true;
      },
    };
    globalThis.__gptplusVoiceReady = true;
    globalThis.__gptplusVoiceDispose = function () {
      state.disposed = true;
      clearStatusTimer();
      clearTimeout(state.syncTimer);
      clearInterval(state.syncInterval);
      clearTimeout(state.toastTimer);
      clearTimeout(state.transcribeTimer);
      try { state.recorder && state.recorder.stop(); } catch (e) {}
      state.recorder = null;
      stopStream(state.stream);
      state.stream = null;
      closeAudioContext();
      state.observer?.disconnect();
      if (state.spaceHold) {
        clearTimeout(state.spaceHold.timer);
        state.spaceHold = null;
      }
      state.pttActive = false;
      if (state.wrap) state.wrap.dataset.holding = 'false';
      if (state.keydown) document.removeEventListener('keydown', state.keydown, true);
      if (state.keyup) document.removeEventListener('keyup', state.keyup, true);
      if (state.visibility) document.removeEventListener('visibilitychange', state.visibility);
      if (state.blur) window.removeEventListener('blur', state.blur, true);
      state.wrap?.remove();
      state.toast?.remove();
      document.getElementById(STYLE_ID)?.remove();
      globalThis.__gptplusVoiceReady = false;
      if (globalThis.__gptplusVoiceRuntime === RUNTIME_KEY) globalThis.__gptplusVoiceRuntime = '';
      delete globalThis.__gptplusVoice;
    };
  }

  return new Promise(function (resolve) {
    var deadline = Date.now() + READY_WAIT_MS;
    function boot() {
      if (state.disposed) {
        resolve({ ok: true, installed: false, disposed: true });
        return;
      }
      if (!document.body) {
        if (Date.now() >= deadline) {
          resolve({ ok: true, installed: false, pending: true });
          return;
        }
        setTimeout(boot, 100);
        return;
      }
      try {
        install();
        resolve({ ok: true, installed: true });
      } catch (error) {
        globalThis.__gptplusVoiceReady = false;
        if (globalThis.__gptplusVoiceRuntime === RUNTIME_KEY) globalThis.__gptplusVoiceRuntime = '';
        resolve({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    }
    boot();
  });
}

function buildVoiceInputScript({ readyWaitMs, engine, localReady, language } = {}) {
  var wait = Math.max(500, Number(readyWaitMs) || SCRIPT_READY_WAIT_MS);
  var mode = engine === 'provider' ? 'provider' : engine === 'system' ? 'system' : 'local';
  return '(' + voicePageRuntime.toString() + ')(' + JSON.stringify(mode) + ', ' + wait + ', ' + JSON.stringify(localReady === true) + ', ' + JSON.stringify(String(language || '')) + ')';
}

function voiceConfig(ctx) {
  var config = ctx?.plugins?.config?.('voice-input');
  var source = config && typeof config === 'object' ? config : {};
  return {
    engine: source.engine === 'provider' ? 'provider' : source.engine === 'system' ? 'system' : 'local',
    providerId: String(source.providerId || '').trim().slice(0, 128),
    model: String(source.model || 'whisper-1').trim().slice(0, 128) || 'whisper-1',
    language: String(source.language || '').trim().toLowerCase(),
  };
}

function buildScriptSources(config, localReady) {
  return {
    add: buildVoiceInputScript({ readyWaitMs: SCRIPT_READY_WAIT_MS, engine: config.engine, localReady: localReady, language: config.language }),
    probe: buildVoiceInputScript({ readyWaitMs: PROBE_READY_WAIT_MS, engine: config.engine, localReady: localReady, language: config.language }),
  };
}

var injectedScriptIds = new Map();

async function ensurePageScript(page, scripts, prepared) {
  if (!prepared.has(page.id)) {
    var registered = await addScriptOnNewDocument(page, scripts.add, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (registered?.identifier) injectedScriptIds.set(page.id, { page: page, identifier: registered.identifier });
    prepared.add(page.id);
  }
  return evaluate(page, scripts.probe, { timeoutMs: PROBE_READY_WAIT_MS + 5000 });
}

async function injectVoiceInput({ cdpPort, target = null, timeoutMs = DEFAULT_INJECT_TIMEOUT_MS, pause = sleep, engine, localReady = false, language = '' } = {}) {
  var port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  var config = { engine: engine === 'provider' ? 'provider' : engine === 'system' ? 'system' : 'local', language: language };
  var scripts = buildScriptSources(config, localReady === true);
  var prepared = new Set();
  var deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_INJECT_TIMEOUT_MS);
  var lastError = null;
  while (Date.now() < deadline) {
    var page = target;
    if (!page) {
      try { page = pickMainTarget(await listTargets(port)); }
      catch (error) { lastError = error; page = null; }
    }
    if (page) {
      try {
        var result = await ensurePageScript(page, scripts, prepared);
        if (result?.installed === true) return { ok: true, installed: true, target: page };
        if (result?.ok === false) lastError = new Error(result.error || 'ChatGPT 语音输入脚本未成功执行');
        else lastError = new Error('ChatGPT 页面尚未就绪');
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() >= deadline) break;
    await pause(RETRY_INTERVAL_MS);
  }
  throw new Error(lastError ? '注入语音输入失败: ' + lastError.message : '等待 ChatGPT 页面就绪超时');
}

async function disposeVoiceInput({ cdpPort, target = null, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  var port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  var page = target || pickMainTarget(await listTargets(port));
  if (!page) return { ok: false, skipped: true };
  await evaluate(page, 'globalThis.__gptplusVoiceDispose?.(); ({ ok: true })', { timeoutMs: timeoutMs });
  var registered = injectedScriptIds.get(page.id);
  if (registered?.identifier) {
    try { await removeScriptOnNewDocument(page, registered.identifier, { timeoutMs: timeoutMs }); }
    finally { injectedScriptIds.delete(page.id); }
  }
  return { ok: true, target: page };
}

function requestHeaders(provider) {
  var headers = {};
  if (provider.api === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.apiKey) {
    headers.Authorization = 'Bearer ' + provider.apiKey;
  }
  var extra = provider.headers && typeof provider.headers === 'object' ? provider.headers : {};
  for (var key of Object.keys(extra)) {
    var name = String(key || '').trim();
    if (!name || name.toLowerCase() === 'content-type') continue;
    headers[name] = String(extra[key] == null ? '' : extra[key]);
  }
  return headers;
}

function upstreamError(status, json, text) {
  var message = json && typeof json === 'object'
    ? json.error?.message || json.error?.error?.message || json.message || (typeof json.error === 'string' ? json.error : '')
    : '';
  if (message) return String(message).slice(0, 400);
  if (text) return String(text).slice(0, 400);
  return 'HTTP ' + status;
}

/**
 * 把页面录制的音频发给提供商 /audio/transcriptions。
 * fetchImpl 可注入用于测试；音频只在内存中停留。
 */
async function transcribeVoice({ ctx, config, pending, fetchImpl } = {}) {
  var providerId = String(config?.providerId || '').trim();
  if (!providerId) throw new Error('请先在语音输入插件设置中选择提供商');
  var provider = ctx?.store?.getProvider?.(providerId);
  if (!provider) throw new Error('提供商不存在，请在语音输入插件设置中重新选择');
  if (provider.enabled === false) throw new Error('提供商已停用，请在语音输入插件设置中重新选择');
  if (provider.api === 'anthropic') throw new Error('Anthropic 提供商不支持音频转写，请选择 OpenAI 兼容提供商');
  var base = stripEndpoint(provider.baseUrl);
  if (!base) throw new Error('提供商缺少 Base URL');
  var model = String(config?.model || 'whisper-1').trim() || 'whisper-1';
  var language = String(config?.language || '').trim();
  var data = String(pending?.data || '');
  if (!data) throw new Error('音频数据为空');
  var buffer;
  try { buffer = Buffer.from(data, 'base64'); }
  catch (error) { throw new Error('音频数据无效'); }
  if (!buffer.length) throw new Error('音频数据为空');
  var mime = String(pending?.mime || 'audio/webm');
  var ext = mime.indexOf('mp4') >= 0 ? 'm4a' : mime.indexOf('wav') >= 0 ? 'wav' : mime.indexOf('mpeg') >= 0 ? 'mp3' : 'webm';
  var form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), 'voice.' + ext);
  form.append('model', model);
  if (language) form.append('language', language);
  var doFetch = typeof fetchImpl === 'function' ? fetchImpl : (ctx?.network || createSystemProxyFetch());
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TRANSCRIBE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  var response;
  try {
    response = await doFetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: requestHeaders(provider),
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error('转写超时（90 秒）');
    }
    throw new Error('转写请求失败: ' + ((error && error.message) || error));
  } finally {
    clearTimeout(timer);
  }
  var text = '';
  try { text = await response.text(); } catch (error) { text = ''; }
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (error) { json = null; }
  if (!response.ok) throw new Error('转写失败: ' + upstreamError(response.status, json, text));
  var transcript = json && typeof json === 'object'
    ? (typeof json.text === 'string' ? json.text : typeof json.transcription === 'string' ? json.transcription : '')
    : '';
  if (!transcript && text && !json) transcript = text;
  var trimmed = String(transcript || '').trim();
  if (!trimmed) throw new Error('提供商没有返回转写文本');
  return trimmed;
}

function pressWindowsVoiceTyping({ spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('系统语音输入仅支持 Windows'));
  var script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class GptPlusKbd { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'",
    '[GptPlusKbd]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 40',
    '[GptPlusKbd]::keybd_event(0x48,0,0,[UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 40',
    '[GptPlusKbd]::keybd_event(0x48,0,2,[UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 40',
    '[GptPlusKbd]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)',
  ].join('; ');
  var encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(function (resolve, reject) {
    var child;
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      reject(error);
      return;
    }
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (error) {}
      reject(new Error('调用 Windows 语音输入超时'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('error', function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else reject(new Error('调用 Windows 语音输入失败（退出码 ' + code + '）'));
    });
  });
}

var activeBridge = null;

function stopVoiceInputBridge() {
  if (!activeBridge) return;
  activeBridge.stop();
  activeBridge = null;
}

function takeVoiceEventExpression() {
  return "(() => { const voice = globalThis.__gptplusVoice; if (!voice) return { missing: true }; voice.touch?.(); const pending = voice.takePending?.(); if (pending) return { type: 'audio', pending }; const request = voice.takeRequest?.(); if (request) return { type: 'request', request }; const context = voice.context?.(); return { type: 'idle', context: context || null }; })()";
}

function startVoiceInputBridge({ cdpPort, ctx, log, visibleIntervalMs = VOICE_POLL_MS, hiddenIntervalMs = VOICE_HIDDEN_POLL_MS } = {}) {
  var port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  stopVoiceInputBridge();
  var config = voiceConfig(ctx);
  var localReady = config.engine === 'local' ? localSpeechStatus().ready : false;
  var scripts = buildScriptSources(config, localReady);
  var prepared = new Set();
  var stopped = false;
  var target = null;
  var lastErrorAt = 0;
  var busy = false;

  async function run() {
    while (!stopped) {
      var delay = visibleIntervalMs;
      try {
        if (!target) target = pickMainTarget(await listTargets(port));
        if (!target) {
          delay = 2000;
        } else {
          var event = await evaluate(target, takeVoiceEventExpression(), { timeoutMs: COMMAND_TIMEOUT_MS });
          if (event && event.missing === true) {
            var installed = await ensurePageScript(target, scripts, prepared);
            if (installed?.installed !== true) {
              target = null;
              prepared.clear();
            }
            delay = 600;
          } else if (event && event.type === 'audio' && event.pending && !busy) {
            busy = true;
            var pending = event.pending;
            try {
              var transcript = pending.engine === 'local'
                ? await transcribeLocal({ audio: Buffer.from(String(pending.data || ''), 'base64'), language: config.language })
                : await transcribeVoice({ ctx: ctx, config: voiceConfig(ctx), pending: pending });
              await evaluate(target, 'globalThis.__gptplusVoice?.complete?.(' + JSON.stringify(String(pending.id)) + ', ' + JSON.stringify({ ok: true, text: String(transcript || '') }) + ')', { timeoutMs: COMMAND_TIMEOUT_MS });
            } catch (error) {
              await evaluate(target, 'globalThis.__gptplusVoice?.complete?.(' + JSON.stringify(String(pending.id)) + ', ' + JSON.stringify({ ok: false, error: error.message }) + ')', { timeoutMs: COMMAND_TIMEOUT_MS }).catch(function () {});
            } finally {
              busy = false;
            }
          } else if (event && event.type === 'request' && event.request && !busy) {
            busy = true;
            var request = event.request;
            try {
              if (request.type === 'system-dictation') {
                await pressWindowsVoiceTyping();
                await evaluate(target, 'globalThis.__gptplusVoice?.complete?.(' + JSON.stringify(String(request.id)) + ', ' + JSON.stringify({ ok: true }) + ')', { timeoutMs: COMMAND_TIMEOUT_MS });
              } else if (request.type === 'prepare-local') {
                var lastProgressAt = 0;
                var lastProgressPercent = -1;
                await prepareSpeechModel(function (progress) {
                  var now = Date.now();
                  if (now - lastProgressAt < 200 && progress.percent === lastProgressPercent) return;
                  lastProgressAt = now;
                  lastProgressPercent = progress.percent;
                  var payload = JSON.stringify({ phase: progress.phase, percent: progress.percent });
                  void evaluate(target, 'globalThis.__gptplusVoice?.prepareProgress?.(' + JSON.stringify(String(request.id)) + ', ' + payload + ')', { timeoutMs: COMMAND_TIMEOUT_MS }).catch(function () {});
                });
                await evaluate(target, 'globalThis.__gptplusVoice?.prepared?.(' + JSON.stringify(String(request.id)) + ')', { timeoutMs: COMMAND_TIMEOUT_MS });
              } else {
                throw new Error('未知的语音输入请求');
              }
            } catch (error) {
              await evaluate(target, 'globalThis.__gptplusVoice?.complete?.(' + JSON.stringify(String(request.id)) + ', ' + JSON.stringify({ ok: false, error: error.message }) + ')', { timeoutMs: COMMAND_TIMEOUT_MS }).catch(function () {});
            } finally {
              busy = false;
            }
          } else if (event && event.context && event.context.hidden === true) {
            delay = hiddenIntervalMs;
          }
        }
      } catch (error) {
        target = null;
        prepared.clear();
        delay = 2000;
        var now = Date.now();
        if (typeof log === 'function' && now - lastErrorAt >= ERROR_LOG_INTERVAL_MS) {
          lastErrorAt = now;
          log({ level: 'warn', msg: '语音输入桥接暂不可用: ' + error.message });
        }
      }
      if (stopped) break;
      await sleep(delay);
    }
  }

  var bridge = { stop: function () { stopped = true; }, cdpPort: port };
  activeBridge = bridge;
  void run();
  return bridge;
}

async function startVoiceInputOnPort({ ctx, cdpPort, target = null, timeoutMs = DEFAULT_INJECT_TIMEOUT_MS } = {}) {
  if (ctx?.plugins?.isActive && !ctx.plugins.isActive('voice-input')) return { ok: false, skipped: true, disabled: true };
  stopVoiceInputBridge();
  var config = voiceConfig(ctx);
  var localReady = config.engine === 'local' ? localSpeechStatus().ready : false;
  await injectVoiceInput({ cdpPort: cdpPort, target: target, timeoutMs: timeoutMs, engine: config.engine, localReady: localReady, language: config.language });
  var bridge = startVoiceInputBridge({ cdpPort: cdpPort, ctx: ctx, log: ctx?.log });
  return { ok: true, cdpPort: cdpPort, bridge: !!bridge };
}

async function resumeVoiceInput({ ctx, timeoutMs = 10000, findPort = findChatGptDebugPort, listTargetsImpl = listTargets } = {}) {
  if (ctx?.plugins?.isActive && !ctx.plugins.isActive('voice-input')) {
    stopVoiceInputBridge();
    return { ok: false, skipped: true, disabled: true };
  }
  if (activeBridge) return { ok: true, resumed: false, active: true };
  var port = null;
  try {
    var executablePath = ctx?.store?.get?.()?.chatgpt?.executablePath || '';
    var imageName = executablePath ? path.win32.basename(executablePath) : '';
    port = await findPort(imageName ? { imageName: imageName } : {});
  } catch (error) {
    port = null;
  }
  if (!port) return { ok: false, skipped: true };
  var target = null;
  try { target = pickMainTarget(await listTargetsImpl(port)); }
  catch (error) { return { ok: false, skipped: true }; }
  if (!target) return { ok: false, skipped: true };
  try {
    var result = await startVoiceInputOnPort({ ctx: ctx, cdpPort: port, target: target, timeoutMs: timeoutMs });
    if (result?.ok !== true) return result;
    ctx?.log?.({ level: 'info', msg: '已恢复 ChatGPT 输入框语音输入按钮（调试端口 ' + port + '）' });
    return { ok: true, cdpPort: port, bridge: !!result.bridge };
  } catch (error) {
    ctx?.log?.({ level: 'warn', msg: '恢复输入框语音输入失败: ' + error.message });
    return { ok: false, error: error.message };
  }
}

async function launchChatGptWithVoiceInput({ ctx, launch, launchOptions = {}, wrapperDir, findPort = findAvailablePort } = {}) {
  if (typeof launch !== 'function') throw new Error('ChatGPT 启动函数不可用');
  if (ctx?.plugins?.isActive && !ctx.plugins.isActive('voice-input')) throw new Error('语音输入插件未启用');
  stopVoiceInputBridge();
  var cdpPort = await findPort(9229);
  var launched = await launch({
    ...launchOptions,
    cdpPort: cdpPort,
    ...(wrapperDir ? { wrapperDir: wrapperDir } : {}),
  });
  if (!launched?.ok) return launched || { ok: false, error: '启动 ChatGPT 失败' };
  try {
    var result = await startVoiceInputOnPort({ ctx: ctx, cdpPort: cdpPort });
    ctx.log?.({ level: 'info', msg: '已将语音输入按钮注入 ChatGPT 输入框' });
    return { ...launched, voiceInjected: true, cdpPort: cdpPort, bridge: !!result.bridge };
  } catch (error) {
    ctx.log?.({ level: 'warn', msg: 'ChatGPT 已启动，但语音输入注入失败: ' + error.message });
    return { ...launched, voiceInjected: false, cdpPort: cdpPort, injectError: error.message };
  }
}

module.exports = {
  buildVoiceInputScript,
  disposeVoiceInput,
  injectVoiceInput,
  launchChatGptWithVoiceInput,
  pressWindowsVoiceTyping,
  resumeVoiceInput,
  startVoiceInputBridge,
  startVoiceInputOnPort,
  stopVoiceInputBridge,
  transcribeVoice,
  voiceConfig,
};




