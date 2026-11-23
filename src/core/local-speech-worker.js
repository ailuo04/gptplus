'use strict';
// 本地识别工作进程：加载 SenseVoiceSmall 与 Silero VAD。
// 既支持整段 WAV 批量识别，也支持边收音频边出字的流式会话（VAD 边界 + 周期性预解码）。
const fs = require('node:fs');
const { composeTranscript, normalizeTranscript } = require('./speech-segmenter.js');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

const STREAM_DEFAULTS = Object.freeze({
  bufferSeconds: 12,
  partial: true,
  prerollMs: 180,
  headPadMs: 120,
  tailPadMs: 150,
  minSpeechMs: 240,
  maxSegmentMs: 4000,
  minPartialSpeechMs: 700,
  partialBaseIntervalMs: 240,
  partialMaxIntervalMs: 1200,
  partialWindowMs: 5000,
  quietCutWindowMs: 900,
});

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  try { process.send?.({ type: 'fatal', error: message }); } catch { /* ignore */ }
  try { process.stderr.write(message + '\n'); } catch { /* ignore */ }
  process.exit(1);
}

function parseWave(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('音频数据无效');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('音频格式不是 WAV');
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error('WAV 数据块长度无效');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt 块无效');
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = { start, size };
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== 16) {
    throw new Error('音频必须是 16 kHz 单声道 PCM16 WAV');
  }
  const count = Math.floor(data.size / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(data.start + i * 2) / 32768;
  return samples;
}

/** 页面按块上传的 16 kHz PCM16 小端数据。 */
function parsePcm16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return new Float32Array(0);
  const count = Math.floor(buffer.length / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(i * 2) / 32768;
  return samples;
}

/**
 * 采样缓冲：分块保存并记录绝对采样下标，便于按时间区间取音频和回收旧数据。
 */
class SampleBuffer {
  constructor(capacitySamples) {
    this.chunks = [];
    this.start = 0;
    this.end = 0;
    this.capacity = Math.max(SAMPLE_RATE, Number(capacitySamples) || SAMPLE_RATE * 12);
  }

  push(samples) {
    if (!samples || !samples.length) return;
    this.chunks.push(samples);
    this.end += samples.length;
    while (this.end - this.start > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.start += dropped.length;
    }
  }

  /** 取 [from, to) 区间；越界自动收敛到当前可用范围。 */
  read(from, to) {
    const start = Math.max(this.start, Math.floor(Number(from) || 0));
    const end = Math.min(this.end, Math.floor(Number(to) || 0));
    if (end <= start) return new Float32Array(0);
    const output = new Float32Array(end - start);
    let cursor = this.start;
    for (const chunk of this.chunks) {
      const chunkEnd = cursor + chunk.length;
      if (chunkEnd > start && cursor < end) {
        const fromOffset = Math.max(0, start - cursor);
        const toOffset = Math.min(chunk.length, end - cursor);
        output.set(chunk.subarray(fromOffset, toOffset), cursor + fromOffset - start);
      }
      cursor = chunkEnd;
      if (cursor >= end) break;
    }
    return output;
  }

  trimBefore(position) {
    const target = Math.max(0, Math.floor(Number(position) || 0));
    while (this.chunks.length > 1) {
      const next = this.start + this.chunks[0].length;
      if (next > target) break;
      const dropped = this.chunks.shift();
      this.start += dropped.length;
    }
  }

  reset() {
    this.chunks = [];
    this.start = 0;
    this.end = 0;
  }
}

/** 判断一段音频里是否存在足够的有效语音，避免把尾部静音当最后一句。 */
function hasVoicedAudio(samples, { threshold = 0.01, frame = 320, minVoicedMs = 100 } = {}) {
  if (!samples || samples.length < frame * 2) return false;
  const need = Math.max(1, Math.ceil(minVoicedMs / 20));
  let voiced = 0;
  for (let offset = 0; offset + frame <= samples.length; offset += frame) {
    let sum = 0;
    for (let i = 0; i < frame; i += 1) sum += samples[offset + i] * samples[offset + i];
    if (Math.sqrt(sum / frame) > threshold) {
      voiced += 1;
      if (voiced >= need) return true;
    }
  }
  return false;
}

/** 在最近一段语音里找能量最低的 20 ms 帧，作为长语音的软切点。 */
function findQuietCut(samples, { frame = 320, keepTail = 640 } = {}) {
  if (!samples || samples.length < frame * 3 + keepTail) return samples ? samples.length : 0;
  const limit = samples.length - keepTail;
  let bestIndex = limit;
  let bestEnergy = Infinity;
  for (let offset = 0; offset + frame <= limit; offset += frame) {
    let sum = 0;
    for (let i = 0; i < frame; i += 1) sum += samples[offset + i] * samples[offset + i];
    const energy = sum / frame;
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestIndex = offset + frame;
    }
  }
  return bestIndex;
}

let recognizer = null;
let detector = null;
let nativeConfig = null;
let config = null;

function createTranscriber(payload) {
  const sherpa = require('sherpa-onnx-node');
  config = {
    threads: Math.max(1, Number(payload.threads) || 2),
    segmentSeconds: 30,
    vadThreshold: 0.5,
    minSpeechSeconds: 0.25,
    minSilenceSeconds: 0.5,
    maxAudioBytes: 4 * 1024 * 1024,
  };
  nativeConfig = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: payload.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: payload.tokens,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
  };
  recognizer = new sherpa.OfflineRecognizer(nativeConfig);
  detector = new sherpa.Vad({
    sileroVad: {
      model: payload.vad,
      threshold: config.vadThreshold,
      minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds,
      maxSpeechDuration: config.segmentSeconds,
      windowSize: VAD_WINDOW,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: config.threads,
    provider: 'cpu',
    debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1);
}

function recognizeSegments(samples, language) {
  nativeConfig.modelConfig.senseVoice.language = language || 'auto';
  recognizer.setConfig(nativeConfig);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  recognizer.decode(stream);
  return normalizeTranscript(String(recognizer.getResult(stream).text || ''));
}

/**
 * 流式会话：外部持续推入 16 kHz 采样，VAD 判定分句，周期性预解码出字。
 * vad / decode 可注入，便于无模型单测。
 * @param {{
 *   vad: { acceptWaveform(f: Float32Array): void, isEmpty(): boolean, isDetected(): boolean, front(b?: boolean): any, pop(): void, flush(): void, reset(): void },
 *   decode: (samples: Float32Array) => string,
 *   language?: string,
 *   bufferSeconds?: number,
 *   onPartial?: (payload: { text: string }) => void,
 *   onSegment?: (payload: object) => void,
 *   onDone?: (payload: object) => void,
 *   now?: () => number,
 * }} options
 */
function createStreamSession(options = {}) {
  const settings = { ...STREAM_DEFAULTS, ...(options.settings || {}) };
  const vad = options.vad;
  const decode = typeof options.decode === 'function' ? options.decode : () => '';
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const language = options.language || 'auto';
  const buffer = new SampleBuffer(Math.round(settings.bufferSeconds * SAMPLE_RATE));
  const headPad = Math.round((settings.headPadMs / 1000) * SAMPLE_RATE);
  const tailPad = Math.round((settings.tailPadMs / 1000) * SAMPLE_RATE);
  const preroll = Math.round((settings.prerollMs / 1000) * SAMPLE_RATE);
  const minSpeech = Math.round((settings.minSpeechMs / 1000) * SAMPLE_RATE);
  const maxSegment = Math.round((settings.maxSegmentMs / 1000) * SAMPLE_RATE);
  const minPartial = Math.round((settings.minPartialSpeechMs / 1000) * SAMPLE_RATE);
  const partialWindow = Math.round((settings.partialWindowMs / 1000) * SAMPLE_RATE);

  let speaking = false;
  let speechStart = 0;
  let carry = new Float32Array(0);
  let decodedUntil = 0;
  let lastRawEnd = null;
  let finished = false;
  let ended = false;
  let lastPartialAt = 0;
  let partialInterval = settings.partialBaseIntervalMs;
  let lastPartial = '';
  const segments = [];

  function emit(payload) {
    try { options.onSegment?.(payload); } catch { /* 回调失败不能影响识别 */ }
  }

  function decodeText(samples) {
    if (!samples.length) return '';
    try { return normalizeTranscript(decode(samples)); } catch { return ''; }
  }

  function emitSegment(start, end, softCut) {
    const from = Math.max(buffer.start, Math.min(start - headPad, buffer.end), decodedUntil);
    // 软切点后面还是连续语音，不能补尾；只有 VAD 判定收尾（后面是静音）才补
    const to = softCut ? Math.min(buffer.end, end) : Math.min(buffer.end, end + tailPad);
    const rawDuration = Math.max(0, Math.round(((end - start) / SAMPLE_RATE) * 1000));
    // 停顿取上一段原始语音结束到本段开始的静音；软切点前后本就连续，停顿为 0
    const pauseMs = lastRawEnd == null ? 0 : Math.max(0, Math.round(((start - lastRawEnd) / SAMPLE_RATE) * 1000));
    decodedUntil = Math.max(decodedUntil, to);
    lastRawEnd = Math.max(lastRawEnd == null ? end : lastRawEnd, end);
    lastPartial = '';
    if (to - from < minSpeech) return;
    const text = decodeText(buffer.read(from, to));
    if (!text) return;
    const payload = {
      text,
      pauseMs,
      durationMs: rawDuration,
      softCut: softCut === true,
      startMs: Math.round((start / SAMPLE_RATE) * 1000),
      endMs: Math.round((end / SAMPLE_RATE) * 1000),
    };
    segments.push({ text, pauseMs, softCut: softCut === true });
    emit(payload);
  }

  function drainVad(sink) {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      const start = Number(segment && segment.start);
      const count = segment && segment.samples ? segment.samples.length : 0;
      vad.pop();
      if (!Number.isFinite(start) || !count) continue;
      sink(start, start + count);
    }
  }

  function softCut() {
    const window = buffer.read(Math.max(speechStart, buffer.end - Math.round((settings.quietCutWindowMs / 1000) * SAMPLE_RATE)), buffer.end);
    const offset = findQuietCut(window);
    const cut = Math.max(speechStart + Math.round(SAMPLE_RATE * 0.4), buffer.end - window.length + offset);
    emitSegment(speechStart, cut, true);
    speechStart = cut;
  }

  function maybePartial() {
    if (settings.partial === false || !speaking) return;
    const speechSamples = buffer.end - speechStart;
    if (speechSamples < minPartial) return;
    const stamp = now();
    if (stamp - lastPartialAt < partialInterval) return;
    lastPartialAt = stamp;
    const from = Math.max(buffer.start, speechStart - preroll, decodedUntil, buffer.end - partialWindow);
    const started = now();
    const text = decodeText(buffer.read(from, buffer.end));
    const cost = Math.max(1, now() - started);
    partialInterval = Math.min(settings.partialMaxIntervalMs, Math.max(settings.partialBaseIntervalMs, Math.round(cost * 1.6)));
    if (!text || text === lastPartial) return;
    lastPartial = text;
    try { options.onPartial?.({ text }); } catch { /* ignore */ }
  }

  function feed(samples) {
    if (finished || !samples || !samples.length) return;
    let merged = samples;
    if (carry.length) {
      merged = new Float32Array(carry.length + samples.length);
      merged.set(carry, 0);
      merged.set(samples, carry.length);
      carry = new Float32Array(0);
    }
    let offset = 0;
    // VAD 只接受固定窗口长度，不足一窗的尾部留到下一块拼接
    while (merged.length - offset >= VAD_WINDOW) {
      const window = merged.subarray(offset, offset + VAD_WINDOW);
      const wasSpeaking = speaking;
      vad.acceptWaveform(window);
      buffer.push(window);
      offset += VAD_WINDOW;
      drainVad((start, end) => emitSegment(start, end, false));
      speaking = vad.isDetected();
      if (speaking && !wasSpeaking) speechStart = Math.max(0, buffer.end - VAD_WINDOW);
      if (speaking && buffer.end - speechStart >= maxSegment) softCut();
      maybePartial();
    }
    if (offset < merged.length) carry = merged.slice(offset);
    if (decodedUntil > 0) buffer.trimBefore(decodedUntil - SAMPLE_RATE);
  }

  return {
    id: options.id || '',
    language,
    push(samples) {
      const input = samples instanceof Float32Array ? samples : new Float32Array(samples || 0);
      feed(input);
    },
    /** 结束本轮并返回聚合文本（批量路径直接使用）。 */
    end() {
      if (ended) return { text: composeTranscript(segments, { language }), segments };
      if (finished) return { text: '', segments };
      ended = true;
      speaking = false;
      if (carry.length) {
        const tail = new Float32Array(VAD_WINDOW);
        tail.set(carry.subarray(0, Math.min(carry.length, VAD_WINDOW)), 0);
        carry = new Float32Array(0);
        try { vad.acceptWaveform(tail); } catch { /* ignore */ }
        buffer.push(tail);
      }
      try { vad.flush(); } catch { /* ignore */ }
      drainVad((start, end) => emitSegment(start, end, false));
      const rest = buffer.end - decodedUntil;
      if (rest > Math.round(SAMPLE_RATE * 0.25) && hasVoicedAudio(buffer.read(decodedUntil, buffer.end))) {
        emitSegment(decodedUntil, buffer.end, false);
      }
      finished = true;
      const text = composeTranscript(segments, { language });
      try { options.onDone?.({ text, segments, language }); } catch { /* ignore */ }
      return { text, segments };
    },
    cancel() {
      finished = true;
      ended = true;
      try { vad.reset(); } catch { /* ignore */ }
      buffer.reset();
      segments.length = 0;
    },
    get active() {
      return !finished;
    },
  };
}

/** 整段 WAV 批量识别：与流式共用 VAD 分段与分句规则。 */
function transcribeWave(buffer, language) {
  if (buffer.length > config.maxAudioBytes) throw new Error('录音过长，请缩短后重试');
  const samples = parseWave(buffer);
  nativeConfig.modelConfig.senseVoice.language = language || 'auto';
  recognizer.setConfig(nativeConfig);
  detector.reset();
  const session = createStreamSession({
    vad: detector,
    decode: (input) => recognizeSegments(input, language),
    language: language || 'auto',
    settings: { bufferSeconds: Math.max(15, Math.ceil(samples.length / SAMPLE_RATE) + 2), partial: false },
  });
  session.push(samples);
  return session.end().text;
}

let streamSession = null;

process.on('disconnect', () => process.exit(0));

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'transcribe') {
    const id = String(message.id || '');
    try {
      if (!recognizer) throw new Error('识别器尚未初始化');
      const audio = Buffer.from(String(message.audio || ''), 'base64');
      const text = transcribeWave(audio, message.language);
      process.send?.({ type: 'result', id, text });
    } catch (error) {
      process.send?.({ type: 'error', id, error: error && error.message ? error.message : String(error) });
    }
    return;
  }
  if (message.type === 'stream-start') {
    const id = String(message.id || '');
    try {
      if (!recognizer) throw new Error('识别器尚未初始化');
      streamSession?.cancel();
      detector.reset();
      streamSession = createStreamSession({
        id,
        vad: detector,
        decode: (input) => recognizeSegments(input, message.language),
        language: message.language || 'auto',
        onPartial: (payload) => process.send?.({ type: 'partial', id, text: payload.text }),
        onSegment: (payload) => process.send?.({ type: 'segment', id, ...payload }),
        onDone: (payload) => process.send?.({ type: 'stream-done', id, text: payload.text }),
      });
      process.send?.({ type: 'stream-open', id });
    } catch (error) {
      streamSession = null;
      process.send?.({ type: 'stream-error', id, error: error && error.message ? error.message : String(error) });
    }
    return;
  }
  if (message.type === 'stream-audio') {
    const id = String(message.id || '');
    if (!streamSession || streamSession.id !== id) {
      process.send?.({ type: 'ack', id, seq: message.seq });
      return;
    }
    try {
      streamSession.push(parsePcm16(Buffer.from(String(message.pcm || ''), 'base64')));
      process.send?.({ type: 'ack', id, seq: message.seq });
    } catch (error) {
      process.send?.({ type: 'stream-error', id, error: error && error.message ? error.message : String(error) });
      streamSession?.cancel();
      streamSession = null;
    }
    return;
  }
  if (message.type === 'stream-end') {
    const id = String(message.id || '');
    if (!streamSession || streamSession.id !== id) {
      process.send?.({ type: 'stream-done', id, text: '', missing: true });
      return;
    }
    try {
      const result = streamSession.end();
      streamSession = null;
      process.send?.({ type: 'stream-done', id, text: result.text });
    } catch (error) {
      streamSession = null;
      process.send?.({ type: 'stream-error', id, error: error && error.message ? error.message : String(error) });
    }
    return;
  }
  if (message.type === 'stream-cancel') {
    const id = String(message.id || '');
    if (streamSession && (!id || streamSession.id === id)) {
      streamSession.cancel();
      streamSession = null;
    }
    process.send?.({ type: 'stream-closed', id });
  }
});

if (require.main === module) {
  try {
    const raw = String(process.env.GPTPLUS_SENSEVOICE_CONFIG || '');
    if (!raw) throw new Error('缺少识别配置');
    const payload = JSON.parse(raw);
    delete process.env.GPTPLUS_SENSEVOICE_CONFIG;
    for (const key of ['model', 'tokens', 'vad']) {
      if (!payload[key] || !fs.existsSync(payload[key])) throw new Error(`模型文件不存在: ${key}`);
    }
    createTranscriber(payload);
    process.send?.({ type: 'ready' });
  } catch (error) {
    fail(error);
  }
}

module.exports = {
  SAMPLE_RATE,
  SampleBuffer,
  createStreamSession,
  createTranscriber,
  findQuietCut,
  parsePcm16,
  parseWave,
  transcribeWave,
};
