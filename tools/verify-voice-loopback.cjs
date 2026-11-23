'use strict';
// 真机验证系统音频回环链路：gpt++ 隐藏窗口采集系统声音 → 16 kHz PCM → 真实 SenseVoice 流式识别。
// 用法: npx electron tools/verify-voice-loopback.cjs [样本.wav] [--language zh] [--seconds 8]
//   给定 WAV 时通过系统默认输出设备播放（PowerShell SoundPlayer），同时回环采集并转写，
//   用于验证「播放听力素材」场景；不给定则采集 --seconds 秒环境声。
// 采集到的原始音频保存在 probe/loopback-capture.wav，可用 verify-voice-stream.cjs 复核。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { createLoopbackCapture, loopbackAvailable } = require('../src/core/voice-loopback.js');
const { localSpeechStatus, startSpeechStream, stopLocalSpeech } = require('../src/core/local-speech.js');

const CHUNK_BYTES = 4096; // 2048 采样 = 128 ms

function parseArgs(argv) {
  const options = { file: '', language: 'zh', seconds: 8 };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--language') options.language = argv[++i] || 'zh';
    else if (item === '--seconds') options.seconds = Math.max(1, Number(argv[++i]) || 8);
    else if (!options.file) options.file = item;
  }
  return options;
}

function stamp(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

function writeWav(file, pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

function playWav(file) {
  const literal = file.replace(/'/g, "''");
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      `(New-Object System.Media.SoundPlayer '${literal}').PlaySync()`,
    ], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('播放失败（退出码 ' + code + '）'))));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv);
  if (!loopbackAvailable()) {
    console.error('当前环境不支持系统音频回环（需要 Windows + Electron 主进程）。');
    app.exit(2);
    return;
  }
  const status = localSpeechStatus();
  if (!status.ready) {
    console.error('本地识别模型未就绪，请先在 gpt++ 里打开一次语音输入完成模型准备。');
    app.exit(2);
    return;
  }
  if (options.file && !fs.existsSync(options.file)) {
    console.error('找不到音频文件: ' + options.file);
    app.exit(2);
    return;
  }

  const chunks = [];
  let levels = 0;
  let peakLevel = 0;
  let startedResolve;
  let startedReject;
  const started = new Promise((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
  const capture = createLoopbackCapture({
    onStarted: () => startedResolve(),
    onPcm: (buffer) => chunks.push(buffer),
    onLevel: (value) => { levels += 1; peakLevel = Math.max(peakLevel, value); },
    onError: (error) => startedReject(new Error(error)),
  });

  try {
    await started;
  } catch (error) {
    console.error('回环采集启动失败: ' + error.message);
    capture.stop();
    app.exit(1);
    return;
  }
  console.log('回环采集已就绪，开始采集系统声音…');

  if (options.file) {
    console.log('播放样本: ' + path.resolve(options.file));
    await playWav(path.resolve(options.file));
    await sleep(1500); // 收尾静音，保证最后一句被 VAD 释放
  } else {
    await sleep(options.seconds * 1000);
  }
  capture.stop();
  await sleep(450);

  const pcm = Buffer.concat(chunks);
  const captureFile = path.join(__dirname, '..', 'probe', 'loopback-capture.wav');
  writeWav(captureFile, pcm);
  const seconds = pcm.length / 32000;
  let voiced = 0;
  let frames = 0;
  for (let offset = 0; offset + 640 <= pcm.length; offset += 640) {
    let sum = 0;
    for (let i = 0; i < 320; i += 1) {
      const sample = pcm.readInt16LE(offset + i * 2) / 32768;
      sum += sample * sample;
    }
    frames += 1;
    if (Math.sqrt(sum / 320) > 0.01) voiced += 1;
  }
  console.log('采集时长: ' + stamp(seconds * 1000) + '，电平回调: ' + levels + ' 次，峰值 ' + peakLevel.toFixed(3)
    + '，有声帧占比 ' + (frames ? Math.round((voiced / frames) * 100) : 0) + '%');
  console.log('原始音频: ' + captureFile);
  if (!pcm.length || (frames && voiced / frames < 0.02)) {
    console.error('几乎没有采到声音：请确认系统未静音、默认输出设备正确，且样本正在播放。');
    app.exit(1);
    return;
  }

  const startedAt = Date.now();
  const events = [];
  const stream = await startSpeechStream({
    language: options.language,
    onEvent: (event) => {
      const elapsed = Date.now() - startedAt;
      if (event.kind === 'partial') {
        events.push(event);
        console.log('[预览 ' + stamp(elapsed) + '] ' + event.text);
      } else if (event.kind === 'segment') {
        events.push(event);
        console.log('[分句 ' + stamp(elapsed) + ' 停顿 ' + event.pauseMs + 'ms 语音 ' + event.durationMs + 'ms] ' + event.text);
      } else if (event.kind === 'done') {
        events.push(event);
      } else if (event.kind === 'error') {
        events.push(event);
        console.error('[错误] ' + event.error);
      }
    },
  });
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    stream.push(pcm.subarray(offset, Math.min(pcm.length, offset + CHUNK_BYTES)));
  }
  stream.end();
  const deadline = Date.now() + 60000;
  while (!events.some((event) => event.kind === 'done' || event.kind === 'error') && Date.now() < deadline) {
    await sleep(100);
  }
  stopLocalSpeech();

  const done = events.find((event) => event.kind === 'done');
  console.log('');
  console.log('最终文本: ' + ((done && done.text) || '(空)'));
  if (!done || !done.text) {
    console.error('回环采集成功但未识别到语音。');
    app.exit(1);
    return;
  }
  console.log('回环链路验证通过。');
  app.exit(0);
}

app.whenReady().then(() => {
  app.setPath('userData', path.join(os.tmpdir(), 'gptplus-loopback-probe'));
  // 采集窗口可能是唯一窗口：销毁它不应触发 Electron 默认的 window-all-closed 退出，
  // 否则主流程还没写完结果进程就没了。
  app.on('window-all-closed', () => {});
  main().catch((error) => {
    console.error('验证失败: ' + ((error && error.message) || error));
    app.exit(1);
  });
});