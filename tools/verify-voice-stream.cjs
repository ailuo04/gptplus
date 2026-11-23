'use strict';
// 用真实 SenseVoice 模型验证实时转写：按 128 ms 分块推送 WAV，打印预览、分句、标点与到达延迟。
// 用法: node tools/verify-voice-stream.cjs <16kHz 单声道 PCM16 WAV> [--language zh] [--realtime]
// 说明：--realtime 按录音速度推送，可看到逐字预览；默认尽快推送，只验证分句与标点。
const fs = require('node:fs');
const path = require('node:path');
const { SAMPLE_RATE, parseWave } = require(path.join(__dirname, '..', 'src/core/local-speech-worker.js'));
const { localSpeechStatus, startSpeechStream, stopLocalSpeech } = require(path.join(__dirname, '..', 'src/core/local-speech.js'));

const CHUNK = 2048;

function parseArgs(argv) {
  const options = { file: '', language: 'zh', realtime: false };
  for (const item of argv.slice(2)) {
    if (item === '--realtime') options.realtime = true;
    else if (item === '--language') options.languageNext = true;
    else if (options.languageNext) { options.language = item; options.languageNext = false; }
    else if (!options.file) options.file = item;
  }
  delete options.languageNext;
  return options;
}

function stamp(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.file) {
    console.error('用法: node tools/verify-voice-stream.cjs <16kHz 单声道 PCM16 WAV> [--language zh] [--realtime]');
    process.exit(2);
  }
  const file = path.resolve(options.file);
  if (!fs.existsSync(file)) {
    console.error('找不到音频文件: ' + file);
    process.exit(2);
  }
  const samples = parseWave(fs.readFileSync(file));
  const status = localSpeechStatus();
  if (!status.ready) {
    console.error('本地识别模型未就绪，请先在 gpt++ 里打开一次语音输入完成模型准备。');
    process.exit(2);
  }

  const startedAt = Date.now();
  const events = [];
  const stream = await startSpeechStream({
    language: options.language,
    onEvent: (event) => {
      const elapsed = Date.now() - startedAt;
      if (event.kind === 'partial') {
        events.push({ kind: 'partial', at: elapsed, text: event.text });
        console.log('[预览 ' + stamp(elapsed) + '] ' + event.text);
      } else if (event.kind === 'segment') {
        events.push({ kind: 'segment', at: elapsed, ...event });
        console.log('[分句 ' + stamp(elapsed) + ' 停顿 ' + event.pauseMs + 'ms 语音 ' + event.durationMs + 'ms' + (event.softCut ? ' 软切' : '') + '] ' + event.text);
      } else if (event.kind === 'done') {
        events.push({ kind: 'done', at: elapsed, text: event.text });
      } else if (event.kind === 'error') {
        events.push({ kind: 'error', at: elapsed, error: event.error });
        console.error('[错误] ' + event.error);
      }
    },
  });

  // 模型加载耗时不算进落地延迟：以第一块音频推送时刻为音频时间零点
  const pushStartedAt = Date.now();
  const pushOffset = pushStartedAt - startedAt;
  for (let offset = 0; offset < samples.length; offset += CHUNK) {
    const chunk = samples.subarray(offset, offset + CHUNK);
    const pcm = Buffer.alloc(chunk.length * 2);
    for (let i = 0; i < chunk.length; i += 1) {
      const value = Math.max(-1, Math.min(1, chunk[i]));
      pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
    }
    stream.push(pcm);
    if (options.realtime) await new Promise((resolve) => setTimeout(resolve, Math.round((chunk.length / SAMPLE_RATE) * 1000)));
  }
  stream.end();

  const deadline = Date.now() + 60000;
  while (!events.some((event) => event.kind === 'done' || event.kind === 'error') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stopLocalSpeech();

  const done = events.find((event) => event.kind === 'done');
  const segments = events.filter((event) => event.kind === 'segment');
  const audioMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  console.log('');
  console.log('音频时长: ' + stamp(audioMs) + '，分句: ' + segments.length + '，预览: ' + events.filter((event) => event.kind === 'partial').length);
  if (stream.dropped > 0) {
    console.error('警告: 快速推送丢弃了 ' + stream.dropped + ' 块音频（约 ' + (stream.dropped * 0.128).toFixed(1) + 's），结果不完整；超过 10 秒的样本请加 --realtime。');
  }
  if (done) {
    console.log('最终文本: ' + (done.text || '(空)'));
    const latency = segments.map((event) => Math.max(0, event.at - pushOffset - event.endMs));
    if (latency.length) console.log('分句落地延迟(相对该句语音结束): ' + latency.map((value) => value + 'ms').join(', '));
  }
  if (!done || !done.text) {
    console.error('未得到转写文本：请确认音频包含清晰语音，且为 16 kHz 单声道 PCM16。');
    process.exit(1);
  }
}

main().catch((error) => {
  const message = (error && error.message) || error;
  console.error('验证失败: ' + message);
  if (/16 kHz|WAV/.test(String(message))) {
    console.error('可先用 ffmpeg 转换: ffmpeg -i 输入音频 -ar 16000 -ac 1 -c:a pcm_s16le out.wav');
  }
  process.exit(1);
});
