'use strict';
// 本地语音识别：SenseVoiceSmall + Silero VAD。
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
  return {
    model: path.join(MANAGED_ROOT, MODEL_FILES.model.name),
    tokens: path.join(MANAGED_ROOT, MODEL_FILES.tokens.name),
    vad: path.join(MANAGED_ROOT, MODEL_FILES.vad.name),
  };
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
  const candidates = [
    { source: 'gpt++', root: MANAGED_ROOT, files: managedPaths() },
    { source: 'DeepSeek Harness', root: DSH_ROOT, files: dshPaths() },
  ];
  for (const candidate of candidates) {
    const keys = Object.keys(candidate.files);
    const missing = keys.filter((key) => {
      const file = candidate.files[key];
      return verifySize ? !fileMatches(file, MODEL_FILES[key]) : !fs.existsSync(file);
    });
    if (!missing.length) return { ready: true, source: candidate.source, root: candidate.root, files: candidate.files };
  }
  return { ready: false, source: 'gpt++', root: MANAGED_ROOT, files: managedPaths(), missing: Object.keys(MODEL_FILES) };
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
    const files = managedPaths();
    const totalBytes = Object.values(MODEL_FILES).reduce((sum, file) => sum + file.bytes, 0);
    let completedBytes = 0;
    for (const key of Object.keys(MODEL_FILES)) {
      const spec = MODEL_FILES[key];
      const destination = files[key];
      if (fileMatches(destination, spec)) {
        completedBytes += spec.bytes;
        continue;
      }
      await fsp.rm(destination, { force: true }).catch(() => {});
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

function stopWorker(reason) {
  if (!workerState) return;
  const state = workerState;
  workerState = null;
  clearTimeout(state.idleTimer);
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
    threads: Math.max(1, Math.min(4, os.cpus().length)),
  });
  const state = { child: null, ready: false, starting: null, pending: null, stderr: '', idleTimer: 0 };
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
      }
    });
    state.child.on('error', (error) => finish(error));
    state.child.on('exit', (code) => {
      if (state.pending) {
        const pending = state.pending;
        state.pending = null;
        clearTimeout(pending.timer);
        const detail = state.stderr.trim();
        pending.reject(new Error(detail || `本地识别进程退出（代码 ${code}）`));
      }
      if (!state.ready) {
        finish(new Error(state.stderr.trim() || `本地识别进程退出（代码 ${code}）`));
      }
      if (workerState === state) workerState = null;
    });
  });
  return state.starting;
}

function scheduleIdleStop() {
  if (!workerState) return;
  clearTimeout(workerState.idleTimer);
  workerState.idleTimer = setTimeout(() => stopWorker('本地识别进程空闲超时'), IDLE_TIMEOUT_MS);
  if (typeof workerState.idleTimer.unref === 'function') workerState.idleTimer.unref();
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
  stopLocalSpeech,
  transcribeLocal,
};


