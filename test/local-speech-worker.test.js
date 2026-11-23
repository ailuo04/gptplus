'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SAMPLE_RATE,
  SampleBuffer,
  createStreamSession,
  findQuietCut,
  parsePcm16,
  parseWave,
} = require('../src/core/local-speech-worker.js');

/** 按固定区间产生语音的假 VAD：区间结束后再过一小段静音才判定收尾。 */
class ScriptedVad {
  constructor(ranges = [], { silenceAfterSamples = 3200 } = {}) {
    this.ranges = ranges.map((range) => ({ ...range, done: false }));
    this.silenceAfterSamples = silenceAfterSamples;
    this.position = 0;
    this.ready = [];
    this.detected = false;
  }

  acceptWaveform(window) {
    const start = this.position;
    const end = this.position + window.length;
    this.position = end;
    this.detected = this.ranges.some((range) => !range.done && start < range.end && end > range.start);
    for (const range of this.ranges) {
      if (!range.done && end >= range.end + this.silenceAfterSamples) {
        range.done = true;
        this.ready.push({ start: range.start, end: range.end });
      }
    }
  }

  isEmpty() { return this.ready.length === 0; }
  isDetected() { return this.detected; }
  front() {
    const segment = this.ready[0];
    return { start: segment.start, samples: new Float32Array(segment.end - segment.start) };
  }
  pop() { this.ready.shift(); }
  flush() {
    for (const range of this.ranges) {
      if (!range.done) {
        range.done = true;
        this.ready.push({ start: range.start, end: range.end });
      }
    }
  }
  reset() {
    this.position = 0;
    this.ready = [];
    this.detected = false;
    for (const range of this.ranges) range.done = false;
  }
}

function feed(session, seconds, { pace = 2048, value = 0.2, ranges = null } = {}) {
  const total = Math.round(seconds * SAMPLE_RATE);
  for (let offset = 0; offset < total; offset += pace) {
    const size = Math.min(pace, total - offset);
    const chunk = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
      const position = offset + i;
      const voiced = !ranges || ranges.some((range) => position >= range.start && position < range.end);
      chunk[i] = voiced ? value : 0;
    }
    session.push(chunk);
  }
}

test('local speech worker: 分块缓冲支持按绝对位置取音频并回收旧数据', () => {
  const buffer = new SampleBuffer(16);
  buffer.push(new Float32Array([1, 2, 3, 4]));
  buffer.push(new Float32Array([5, 6, 7, 8]));
  assert.deepEqual(Array.from(buffer.read(2, 6)), [3, 4, 5, 6]);
  buffer.push(new Float32Array([9, 10, 11, 12]));
  assert.equal(buffer.end, 12);
  buffer.trimBefore(5);
  assert.equal(buffer.start, 4);
  assert.deepEqual(Array.from(buffer.read(4, 6)), [5, 6]);
});

test('local speech worker: 解析 PCM16 与 WAV 校验', () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(16384, 2);
  assert.deepEqual(Array.from(parsePcm16(pcm)), [-1, 0.5]);
  assert.throws(() => parseWave(Buffer.alloc(10)), /音频数据无效/);
});

test('local speech worker: 长语音在能量最低处软切，避免固定 30 秒硬切', () => {
  const samples = new Float32Array(SAMPLE_RATE);
  samples.fill(0.5);
  samples.fill(0.01, 8000, 8320);
  const cut = findQuietCut(samples);
  assert.ok(cut >= 8320, `切点应落在低能量帧之后，实际 ${cut}`);
  assert.ok(cut <= samples.length, '切点不能越界');
});

test('local speech worker: 流式会话按停顿输出分句并带上两端补白', () => {
  const ranges = [
    { start: Math.round(0.2 * SAMPLE_RATE), end: Math.round(0.7 * SAMPLE_RATE) },
    { start: Math.round(1.1 * SAMPLE_RATE), end: Math.round(1.6 * SAMPLE_RATE) },
  ];
  const vad = new ScriptedVad(ranges);
  const decoded = [];
  const segments = [];
  let partials = 0;
  const session = createStreamSession({
    vad,
    language: 'zh',
    decode: (input) => {
      decoded.push(input.length);
      return '第' + decoded.length + '句';
    },
    onPartial: () => { partials += 1; },
    onSegment: (payload) => segments.push(payload),
    settings: { minPartialSpeechMs: 700 },
  });
  feed(session, 2.2, { ranges });
  const result = session.end();

  assert.equal(segments.length, 2);
  assert.equal(segments[0].pauseMs, 0);
  assert.equal(segments[1].pauseMs, 400);
  assert.equal(segments[0].durationMs, 500);
  // 首段补白：前 120 ms + 后 150 ms
  assert.equal(decoded[0], Math.round(0.5 * SAMPLE_RATE) + Math.round(0.27 * SAMPLE_RATE));
  assert.equal(partials, 0, '短语音不产生预览解码');
  assert.equal(result.text, '第1句，第2句。');
});

test('local speech worker: 连续说话时按间隔输出预览，且不重复已定稿内容', () => {
  const vad = new ScriptedVad([{ start: 0, end: Math.round(2 * SAMPLE_RATE) }], { silenceAfterSamples: 999999 });
  let clock = 0;
  const partials = [];
  const session = createStreamSession({
    vad,
    language: 'zh',
    now: () => { clock += 300; return clock; },
    decode: (input) => '预览' + input.length,
    onPartial: (payload) => partials.push(payload.text),
    settings: { minPartialSpeechMs: 600, partialBaseIntervalMs: 100, partialMaxIntervalMs: 100 },
  });
  feed(session, 1.8, { pace: 2048 });
  assert.ok(partials.length >= 2, '应有多次预览');
  session.cancel();
});

test('local speech worker: 结束会话会把未收尾的语音补成最后一句', () => {
  const vad = new ScriptedVad([{ start: 0, end: Math.round(1 * SAMPLE_RATE) }], { silenceAfterSamples: 999999 });
  const segments = [];
  const session = createStreamSession({
    vad,
    language: 'zh',
    decode: () => '最后一句',
    onSegment: (payload) => segments.push(payload),
  });
  feed(session, 1.2);
  assert.equal(segments.length, 0, '静音不足时 VAD 尚未收尾');
  const result = session.end();
  assert.equal(segments.length, 1);
  assert.equal(result.text, '最后一句。');
});
