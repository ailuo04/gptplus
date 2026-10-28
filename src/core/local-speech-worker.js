'use strict';
// 本地识别工作进程：加载 SenseVoiceSmall 与 Silero VAD，串行处理主进程发来的 WAV。
const fs = require('node:fs');

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
  if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bitsPerSample !== 16) {
    throw new Error('音频必须是 16 kHz 单声道 PCM16 WAV');
  }
  const count = Math.floor(data.size / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(data.start + i * 2) / 32768;
  return samples;
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
    onsetPaddingSeconds: 0.3,
    maxAudioBytes: 4 * 1024 * 1024,
  };
  nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
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
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: config.threads,
    provider: 'cpu',
    debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1);
}

function recognizeSegment(samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  return String(recognizer.getResult(stream).text || '').trim();
}

function transcribeWave(buffer, language) {
  if (buffer.length > config.maxAudioBytes) throw new Error('录音过长，请缩短后重试');
  const samples = parseWave(buffer);
  nativeConfig.modelConfig.senseVoice.language = language || 'auto';
  recognizer.setConfig(nativeConfig);
  detector.reset();
  const texts = [];
  const onsetPadding = Math.round(config.onsetPaddingSeconds * 16000);
  let firstSegment = true;
  const drain = () => {
    while (!detector.isEmpty()) {
      const segment = detector.front(false);
      let speech = segment.samples;
      if (firstSegment) {
        firstSegment = false;
        const from = Math.max(0, segment.start - onsetPadding);
        if (from < segment.start) {
          const restored = new Float32Array(segment.start - from + speech.length);
          restored.set(samples.subarray(from, segment.start));
          restored.set(speech, segment.start - from);
          speech = restored;
        }
      }
      texts.push(recognizeSegment(speech));
      detector.pop();
    }
  };
  for (let offset = 0; offset < samples.length; offset += 512) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512));
    drain();
  }
  detector.flush();
  drain();
  return texts.filter(Boolean).join(' ').trim();
}

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
  }
});

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
