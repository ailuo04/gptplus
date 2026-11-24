'use strict';
// 本地语音识别：SenseVoice 预览、Silero 检测停顿、Qwen3-ASR 0.6B 定稿。
// 模型首次使用时下载；如果机器上已有 DeepSeek Harness 的模型缓存，直接复用。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { APP_DIR, HOME } = require('./paths.js');
const { createSystemProxyFetch } = require('./system-proxy.js');

const MANAGED_ROOT = path.join(APP_DIR, 'voice-models', 'sensevoice');
const DSH_ROOT = path.join(HOME, '.dsh', 'speech-to-text', 'sensevoice', 'models');
const WORKER_READY_TIMEOUT_MS = 45000;
const TRANSCRIBE_TIMEOUT_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SUPPORTED_LANGUAGES = new Set(['auto', 'zh', 'en', 'yue', 'ja', 'ko']);

const QWEN_ROOT = path.join(APP_DIR, 'voice-models', 'qwen3-asr-0.6b-int8');
const QWEN_URL = 'https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/68818b2313fe77bd06f6a7c5068ff3ef59d02b8a';
function qwenFile(name, bytes, sha256) {
  return Object.freeze({ name, bytes, sha256, url: `${QWEN_URL}/${name}` });
}

const MODEL_FILES = Object.freeze({
  model: Object.freeze({
    name: 'model.int8.onnx',
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
  }),
  tokens: Object.freeze({
    name: 'tokens.txt',
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
  }),
  vad: Object.freeze({
    name: 'silero_vad.onnx',
    bytes: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  }),
  convFrontend: qwenFile('conv_frontend.onnx', 44148281, 'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e'),
  encoder: qwenFile('encoder.int8.onnx', 182491662, '60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9'),
  decoder: qwenFile('decoder.int8.onnx', 755914231, '4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771'),
  merges: qwenFile('tokenizer/merges.txt', 1671853, '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5'),
  vocab: qwenFile('tokenizer/vocab.json', 2776833, 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'),
  tokenizerConfig: qwenFile('tokenizer/tokenizer_config.json', 12487, '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c'),
});

function unpacked(file) {
  const marker = `${path.sep}app.asar${path.sep}`;
  return file.includes(marker) ? file.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : file;
}

const WORKER_PATH = unpacked(path.join(__dirname, 'local-speech-worker.js'));

function normalizeLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(language) ? language : 'auto';
}

function managedPaths() {
  const files = {};
  for (const [key, spec] of Object.entries(MODEL_FILES)) {
    files[key] = path.join(['model', 'tokens', 'vad'].includes(key) ? MANAGED_ROOT : QWEN_ROOT, spec.name);
  }
  return files;
}

function dshPaths() {
  return {
    model: path.join(DSH_ROOT, 'sensevoice-onnx', MODEL_FILES.model.name),
    tokens: path.join(DSH_ROOT, 'sensevoice-onnx', MODEL_FILES.tokens.name),
    vad: path.join(DSH_ROOT, 'silero', MODEL_FILES.vad.name),
  };
}

function fileMatches(file, expected) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size === expected.bytes;
  } catch {
    return false;
  }
}

/** 查找可用的模型：优先 gpt++ 自己的缓存，其次复用 DeepSeek Harness 的缓存。 */
function resolveSpeechModel(options = {}) {
  const verifySize = options.verifySize !== false;
  const files = managedPaths();
  const shared = dshPaths();
  let source = 'gpt++';
  const missing = [];
  for (const [key, spec] of Object.entries(MODEL_FILES)) {
    const available = file => verifySize ? fileMatches(file, spec) : fs.existsSync(file);
    if (available(files[key])) continue;
    if (shared[key] && available(shared[key])) {
      files[key] = shared[key];
      source = 'DeepSeek Harness';
    } else {
      missing.push(key);
    }
  }
  return { ready: !missing.length, source, root: MANAGED_ROOT, files, missing };
}

function localSpeechStatus() {
  const resolved = resolveSpeechModel();
  return {
    ready: resolved.ready === true,
    source: resolved.ready ? resolved.source : '',
    root: resolved.root,
    files: resolved.files,
  };
}

let progressState = null;
const progressListeners = new Set();

function publishProgress(next) {
  progressState = next;
  for (const listener of [...progressListeners]) {
    try { listener(next); } catch { /* 进度回调不能影响准备流程 */ }
  }
}

function subscribeProgress(listener) {
  if (typeof listener !== 'function') return () => {};
  progressListeners.add(listener);
  if (progressState) {
    try { listener(progressState); } catch { /* ignore */ }
  }
  return () => progressListeners.delete(listener);
}

function downloadSources(file) {
  const sources = [file.url];
  if (file.url.includes('https://huggingface.co/')) {
    sources.push(file.url.replace('https://huggingface.co/', 'https://hf-mirror.com/'));
  }
  return sources;
}

async function downloadFile(file, destination, onProgress) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.part`;
  let lastError = null;
  for (const url of downloadSources(file)) {
    let received = 0;
    const hash = crypto.createHash('sha256');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const doFetch = createSystemProxyFetch();
    try {
      const response = await doFetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'gpt++/1.6.1' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('响应没有内容');
      const total = Number(response.headers.get('content-length')) || file.bytes;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          hash.update(chunk);
          onProgress?.({ file: file.name, received, total });
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary));
      if (received !== file.bytes) throw new Error(`文件大小不符（${received} / ${file.bytes}）`);
      const digest = hash.digest('hex');
      if (digest !== file.sha256) throw new Error('SHA-256 校验失败');
      await fsp.rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true }).catch(() => {});
    } finally {
      clearTimeout(timer);
      try { await doFetch.close?.(); } catch { /* 代理连接清理失败不影响下载结果 */ }
    }
  }
  throw new Error(`下载 ${file.name} 失败: ${lastError && lastError.message ? lastError.message : '网络错误'}`);
}

let preparePromise = null;

async function runPreparation() {
  let resolved = resolveSpeechModel();
  if (!resolved.ready) {
    const files = resolved.files;
    const totalBytes = resolved.missing.reduce((sum, key) => sum + MODEL_FILES[key].bytes, 0);
    let completedBytes = 0;
    for (const key of resolved.missing) {
      const spec = MODEL_FILES[key];
      const destination = files[key];
      publishProgress({ phase: 'download', percent: Math.floor((completedBytes / totalBytes) * 100), file: spec.name, received: 0, total: spec.bytes });
      await downloadFile(spec, destination, (update) => {
        const percent = Math.min(99, Math.floor(((completedBytes + update.received) / totalBytes) * 100));
        publishProgress({ phase: 'download', percent, file: spec.name, received: update.received, total: update.total });
      });
      completedBytes += spec.bytes;
    }
    resolved = resolveSpeechModel();
    if (!resolved.ready) throw new Error('本地识别模型文件不完整');
  }
  publishProgress({ phase: 'load', percent: 100, file: '', received: 0, total: 0 });
  await ensureWorker();
  publishProgress({ phase: 'ready', percent: 100, file: '', received: 0, total: 0 });
  return resolved;
}

/** 准备模型并预热识别进程；并发调用共享同一个任务。 */
function prepareSpeechModel(listener) {
  const unsubscribe = subscribeProgress(listener);
  if (!preparePromise) {
    preparePromise = runPreparation().finally(() => {
      preparePromise = null;
    });
  }
  return preparePromise.then((result) => {
    unsubscribe();
    return result;
  }, (error) => {
    unsubscribe();
    throw error;
  });
}

let workerState = null;

/** 流式识别：页面每 128 ms 推一块 16 kHz PCM16，最多允许 4 块在途，避免解码积压。 */
const STREAM_INFLIGHT_LIMIT = 4;
const STREAM_QUEUE_LIMIT = 80;
const STREAM_END_TIMEOUT_MS = 30000;

function emitStream(state, payload) {
  const session = state && state.stream;
  if (!session || session.closed) return;
  try { session.onEvent?.(payload); } catch { /* 页面桥接失败不能影响识别 */ }
}

function closeStream(state, payload) {
  const session = state && state.stream;
  if (!session) return;
  state.stream = null;
  session.closed = true;
  clearTimeout(session.endTimer);
  session.queue.length = 0;
  try { session.onEvent?.(payload); } catch { /* ignore */ }
  scheduleIdleStop();
}

function pumpStream(state, session) {
  while (!session.closed && session.inflight < STREAM_INFLIGHT_LIMIT && session.queue.length) {
    const item = session.queue.shift();
    try {
      state.child.send({ type: 'stream-audio', id: session.id, seq: item.seq, pcm: item.pcm });
      session.inflight += 1;
    } catch (error) {
      closeStream(state, { kind: 'error', error: (error && error.message) || '音频发送失败' });
      return;
    }
  }
  if (session.ending && !session.closed && !session.queue.length && session.inflight === 0) finishStream(state, session);
}

function finishStream(state, session) {
  if (session.closed || session.endSent) return;
  session.endSent = true;
  try {
    state.child.send({ type: 'stream-end', id: session.id });
  } catch (error) {
    closeStream(state, { kind: 'error', error: (error && error.message) || '结束识别失败' });
  }
}

function stopWorker(reason) {
  if (!workerState) return;
  const state = workerState;
  workerState = null;
  clearTimeout(state.idleTimer);
  closeStream(state, { kind: 'error', error: reason || '本地识别已停止' });
  if (state.pending) {
    clearTimeout(state.pending.timer);
    state.pending.reject(new Error(reason || '本地识别已停止'));
    state.pending = null;
  }
  try { state.child.kill(); } catch { /* 进程可能已经退出 */ }
}

function ensureWorker() {
  if (workerState && workerState.ready) return Promise.resolve(workerState);
  if (workerState && workerState.starting) return workerState.starting;
  const resolved = resolveSpeechModel();
  if (!resolved.ready) return Promise.reject(new Error('本地识别模型尚未准备'));
  const workerConfig = JSON.stringify({
    model: resolved.files.model,
    tokens: resolved.files.tokens,
    vad: resolved.files.vad,
    qwen: {
      convFrontend: resolved.files.convFrontend,
      encoder: resolved.files.encoder,
      decoder: resolved.files.decoder,
      tokenizer: path.dirname(resolved.files.tokenizerConfig),
    },
    threads: Math.max(1, Math.min(4, os.cpus().length)),
  });
  const state = { child: null, ready: false, starting: null, pending: null, stream: null, stderr: '', idleTimer: 0 };
  workerState = state;
  state.starting = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        state.starting = null;
        if (workerState === state) workerState = null;
        try { state.child?.kill(); } catch { /* ignore */ }
        reject(error);
        return;
      }
      state.ready = true;
      state.starting = null;
      resolve(state);
    };
    const timer = setTimeout(() => finish(new Error('本地识别进程启动超时')), WORKER_READY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      state.child = fork(WORKER_PATH, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GPTPLUS_SENSEVOICE_CONFIG: workerConfig },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    } catch (error) {
      finish(error);
      return;
    }
    state.child.stderr?.on('data', (chunk) => {
      state.stderr = (state.stderr + chunk.toString()).slice(-8192);
    });
    state.child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        finish(null);
        return;
      }
      if (message.type === 'fatal') {
        finish(new Error(message.error || '本地识别进程加载失败'));
        return;
      }
      if (message.type === 'result' || message.type === 'error') {
        const pending = state.pending;
        if (!pending || pending.id !== message.id) return;
        state.pending = null;
        clearTimeout(pending.timer);
        if (message.type === 'result') pending.resolve(message.text || '');
        else pending.reject(new Error(message.error || '本地识别失败'));
        return;
      }
      if (message.type === 'stream-open' || message.type === 'partial' || message.type === 'segment' || message.type === 'boundary'
        || message.type === 'stream-done' || message.type === 'stream-error' || message.type === 'ack' || message.type === 'stream-closed') {
        const session = state.stream;
        if (!session || String(message.id || '') !== session.id) return;
        if (message.type === 'ack') {
          session.inflight = Math.max(0, session.inflight - 1);
          pumpStream(state, session);
          return;
        }
        if (message.type === 'stream-open') {
          session.opened = true;
          return;
        }
        if (message.type === 'partial') {
          if (message.text) emitStream(state, { kind: 'partial', text: message.text });
          return;
        }
        if (message.type === 'boundary') {
          emitStream(state, { kind: 'boundary' });
          return;
        }
        if (message.type === 'segment') {
          emitStream(state, {
            kind: 'segment',
            text: message.text,
            pauseMs: Number(message.pauseMs) || 0,
            durationMs: Number(message.durationMs) || 0,
            softCut: message.softCut === true,
            startMs: Number(message.startMs) || 0,
            endMs: Number(message.endMs) || 0,
          });
          return;
        }
        if (message.type === 'stream-error') {
          closeStream(state, { kind: 'error', error: message.error || '本地识别失败' });
          return;
        }
        if (message.type === 'stream-done') {
          closeStream(state, { kind: 'done', text: message.text || '' });
        }
      }
    });
    state.child.on('error', (error) => finish(error));
    state.child.on('exit', (code) => {
      const detail = state.stderr.trim();
      if (state.pending) {
        const pending = state.pending;
        state.pending = null;
        clearTimeout(pending.timer);
        pending.reject(new Error(detail || `本地识别进程退出（代码 ${code}）`));
      }
      if (!state.ready) {
        finish(new Error(detail || `本地识别进程退出（代码 ${code}）`));
      }
      if (workerState === state) workerState = null;
      closeStream(state, { kind: 'error', error: detail || `本地识别进程退出（代码 ${code}）` });
    });
  });
  return state.starting;
}

function scheduleIdleStop() {
  if (!workerState) return;
  clearTimeout(workerState.idleTimer);
  if (workerState.stream) return;
  workerState.idleTimer = setTimeout(() => stopWorker('本地识别进程空闲超时'), IDLE_TIMEOUT_MS);
  if (typeof workerState.idleTimer.unref === 'function') workerState.idleTimer.unref();
}

let streamId = 0;

/**
 * 开启一次流式识别。返回的控制器由调用方按实时节奏推入 16 kHz 单声道 PCM16。
 * 事件：partial（未定稿预览）、segment（一个停顿分句）、done、error。
 * @param {{ language?: string, onEvent?: (event: object) => void }} options
 */
async function startSpeechStream({ language, onEvent } = {}) {
  await prepareSpeechModel();
  const state = await ensureWorker();
  if (state.stream) closeStream(state, { kind: 'error', error: '上一次识别尚未结束' });
  const id = String(++streamId);
  const session = {
    id,
    onEvent,
    queue: [],
    inflight: 0,
    seq: 0,
    opened: false,
    ending: false,
    endSent: false,
    closed: false,
    endTimer: 0,
    dropped: 0,
  };
  state.stream = session;
  clearTimeout(state.idleTimer);
  try {
    state.child.send({ type: 'stream-start', id, language: normalizeLanguage(language) });
  } catch (error) {
    state.stream = null;
    throw new Error('无法开始本地识别: ' + ((error && error.message) || error));
  }
  return {
    id,
    /** @param {Buffer} buffer 16 kHz 单声道 PCM16 小端数据 */
    push(buffer) {
      if (session.closed || !Buffer.isBuffer(buffer) || !buffer.length) return;
      session.queue.push({ seq: ++session.seq, pcm: buffer.toString('base64') });
      if (session.queue.length > STREAM_QUEUE_LIMIT) {
        session.queue.shift();
        session.dropped += 1;
      }
      pumpStream(state, session);
    },
    end() {
      if (session.closed || session.ending) return;
      session.ending = true;
      session.endTimer = setTimeout(() => {
        closeStream(state, { kind: 'error', error: '本地识别收尾超时' });
      }, STREAM_END_TIMEOUT_MS);
      if (typeof session.endTimer.unref === 'function') session.endTimer.unref();
      pumpStream(state, session);
    },
    cancel() {
      if (session.closed) return;
      try { state.child.send({ type: 'stream-cancel', id }); } catch { /* ignore */ }
      closeStream(state, { kind: 'cancelled' });
    },
    get dropped() {
      return session.dropped;
    },
  };
}

let transcriptionQueue = Promise.resolve();
let requestId = 0;

async function runTranscription(audio, language) {
  await prepareSpeechModel();
  const state = await ensureWorker();
  const id = String(++requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (state.pending && state.pending.id === id) state.pending = null;
      reject(new Error('本地识别超时（120 秒）'));
    }, TRANSCRIBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    state.pending = { id, resolve, reject, timer };
    try {
      state.child.send({ type: 'transcribe', id, audio: audio.toString('base64'), language });
    } catch (error) {
      clearTimeout(timer);
      state.pending = null;
      reject(error);
    }
  }).then((text) => {
    scheduleIdleStop();
    return text;
  });
}

/**
 * 转写一段 16 kHz 单声道 PCM16 WAV。
 * @param {{ audio: Buffer, language?: string, onProgress?: Function }} options
 */
function transcribeLocal({ audio, language, onProgress } = {}) {
  if (!Buffer.isBuffer(audio) || !audio.length) return Promise.reject(new Error('音频数据为空'));
  const run = transcriptionQueue.then(() => runTranscription(audio, normalizeLanguage(language)));
  transcriptionQueue = run.catch(() => {});
  if (typeof onProgress === 'function') {
    const unsubscribe = subscribeProgress(onProgress);
    return run.finally(unsubscribe);
  }
  return run;
}

function stopLocalSpeech() {
  stopWorker('本地语音识别已停止');
}

module.exports = {
  MODEL_FILES,
  MANAGED_ROOT,
  DSH_ROOT,
  localSpeechStatus,
  normalizeLanguage,
  prepareSpeechModel,
  resolveSpeechModel,
  startSpeechStream,
  stopLocalSpeech,
  transcribeLocal,
};


