'use strict';

const { randomUUID } = require('node:crypto');
const { WebSocket } = require('undici');

const QWEN_SPEECH_BASE = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const QWEN_SPEECH_URL = 'wss://maas.qianwenaiapi.com/api-ws/v1/inference';
const QWEN_SPEECH_MODEL = 'fun-asr-flash-8k-realtime';
const SAMPLE_RATES = new Map([[QWEN_SPEECH_MODEL, 8000], ['paraformer-realtime-v2', 16000]]);
const CONNECT_TIMEOUT_MS = 12000;
const FINISH_TIMEOUT_MS = 10000;

function getQwenSpeechSampleRate(model) {
  const rate = SAMPLE_RATES.get(model);
  if (!rate) throw new Error('不支持的千问实时识别模型');
  return rate;
}

function resolveQwenSpeechUrl(baseUrl) {
  const value = String(baseUrl || QWEN_SPEECH_BASE).trim().replace(/\/+$/, '');
  if (value === QWEN_SPEECH_BASE || value === QWEN_SPEECH_URL) return QWEN_SPEECH_URL;
  throw new Error('千问实时识别仅支持千问 MaaS 官方 API 地址');
}

// 采集桥统一输出 16 kHz 单声道 s16le。合并相邻样本，避免直接抽样丢掉一半样本。
function toPcm8k(pcm) {
  const output = Buffer.allocUnsafe(Math.floor(pcm.length / 4) * 2);
  for (let i = 0; i < output.length; i += 2) {
    output.writeInt16LE(Math.round((pcm.readInt16LE(i * 2) + pcm.readInt16LE(i * 2 + 2)) / 2), i);
  }
  return output;
}

function startQwenSpeechStream({ baseUrl, model = QWEN_SPEECH_MODEL, apiKey, onEvent, connect = (url, options) => new WebSocket(url, options) }) {
  const url = resolveQwenSpeechUrl(baseUrl);
  const sampleRate = getQwenSpeechSampleRate(model);
  const maxQueuedBytes = sampleRate * 2 * 12;
  if (!String(apiKey || '').trim() || /[\r\n]/.test(apiKey)) throw new Error('请在语音输入设置中填写有效的千问 API Key');
  const taskId = randomUUID().replace(/-/g, '');
  let socket;
  try { socket = connect(url, { headers: { Authorization: 'Bearer ' + apiKey } }); }
  catch { throw new Error('无法打开千问实时语音连接'); }
  let ready = false;
  let ending = false;
  let closed = false;
  let queuedBytes = 0;
  const pending = [];
  let timer;

  function close(event) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    pending.length = 0;
    try { socket.close(); } catch { /* already closed */ }
    if (event) onEvent(event);
  }

  function fail(message) { close({ kind: 'error', error: message }); }
  function arm(ms, message) {
    clearTimeout(timer);
    timer = setTimeout(() => fail(message), ms);
    timer.unref?.();
  }
  function send(data) {
    if (closed) return false;
    if (socket.bufferedAmount > maxQueuedBytes) {
      fail('千问实时语音连接过慢，请重试');
      return false;
    }
    try { socket.send(data); return true; }
    catch { fail('向千问发送语音失败，请重试'); return false; }
  }
  function command(action, payload) {
    return send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }));
  }
  function finish() {
    if (command('finish-task', { input: {} })) arm(FINISH_TIMEOUT_MS, '等待千问语音定稿超时');
  }

  arm(CONNECT_TIMEOUT_MS, '连接千问实时语音超时');
  socket.addEventListener('open', () => command('run-task', {
    task_group: 'audio', task: 'asr', function: 'recognition', model,
    parameters: { format: 'pcm', sample_rate: sampleRate }, input: {},
  }));
  socket.addEventListener('message', ({ data }) => {
    if (closed || typeof data !== 'string') return;
    let message;
    try { message = JSON.parse(data); } catch { fail('千问实时语音返回了无效消息'); return; }
    const header = message?.header;
    if (!header || header.task_id !== taskId) return;
    switch (header.event) {
      case 'task-started':
        if (ready) break;
        ready = true;
        clearTimeout(timer);
        for (const pcm of pending) if (!send(pcm)) break;
        pending.length = 0;
        queuedBytes = 0;
        if (ending && !closed) finish();
        break;
      case 'result-generated': {
        if (!ready) break;
        const sentence = message.payload?.output?.sentence;
        const text = typeof sentence?.text === 'string' ? sentence.text.trim() : '';
        if (!text || sentence.heartbeat === true) break;
        onEvent({ kind: sentence.sentence_end === true ? 'final' : 'partial', text });
        break;
      }
      case 'task-finished': close({ kind: 'done' }); break;
      case 'task-failed': {
        const code = String(header.error_code || '');
        const suffix = /^[a-z0-9_.-]{1,64}$/i.test(code) && !code.includes(apiKey) ? '（' + code + '）' : '';
        fail('千问实时语音识别失败' + suffix + '，请检查模型权限和额度');
        break;
      }
    }
  });
  socket.addEventListener('error', () => fail('千问实时语音连接失败，请检查网络或 API Key'));
  socket.addEventListener('close', () => fail('千问实时语音连接已断开'));

  return {
    push(pcm) {
      if (closed || ending || !Buffer.isBuffer(pcm) || pcm.length < (sampleRate === 8000 ? 4 : 2)) return;
      const chunk = sampleRate === 8000 ? toPcm8k(pcm) : pcm.subarray(0, pcm.length - (pcm.length % 2));
      if (ready) send(chunk);
      else if (queuedBytes + chunk.length > maxQueuedBytes) fail('等待千问实时语音就绪超时');
      else { pending.push(chunk); queuedBytes += chunk.length; }
    },
    end() {
      if (closed || ending) return;
      ending = true;
      if (ready) finish();
    },
    cancel: () => close(),
  };
}

module.exports = { QWEN_SPEECH_BASE, QWEN_SPEECH_MODEL, getQwenSpeechSampleRate, resolveQwenSpeechUrl, startQwenSpeechStream };
