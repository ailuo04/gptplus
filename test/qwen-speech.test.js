'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startQwenSpeechStream } = require('../src/core/qwen-speech.js');

const config = { baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', model: 'fun-asr-flash-8k-realtime', apiKey: 'mock-key' };

class FakeSocket extends EventTarget {
  constructor(url, options) {
    super();
    Object.assign(this, { url, options, sent: [], closed: false });
  }
  send(value) { this.sent.push(value); }
  close() { this.closed = true; }
  open() { this.dispatchEvent(new Event('open')); }
  reply(event, payload = {}, fields = {}) {
    const { task_id } = JSON.parse(this.sent[0]).header;
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ header: { event, task_id, ...fields }, payload }) }));
  }
}

function session(options = {}) {
  const sockets = [];
  const events = [];
  const stream = startQwenSpeechStream({ ...config, ...options, language: 'zh', onEvent: (e) => events.push(e), connect: (url, init) => {
    const socket = new FakeSocket(url, init);
    sockets.push(socket);
    return socket;
  } });
  return { stream, socket: sockets[0], events };
}

function result(text, sentenceEnd = false) {
  return { output: { sentence: { begin_time: 100, end_time: sentenceEnd ? 900 : null, text, sentence_end: sentenceEnd } } };
}

test('千问语音：等待服务端就绪，发送 8 kHz PCM，停止录音前返回可修订的结果', () => {
  const { stream, socket, events } = session();
  assert.equal(socket.url, 'wss://maas.qianwenaiapi.com/api-ws/v1/inference');
  assert.equal(socket.options.headers.Authorization, 'Bearer mock-key');
  const pcm = Buffer.alloc(8);
  [100, 300, -600, -200].forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  stream.push(pcm);
  socket.open();
  const start = JSON.parse(socket.sent[0]);
  assert.equal(start.header.action, 'run-task');
  assert.equal(start.header.streaming, 'duplex');
  assert.equal(start.payload.model, config.model);
  assert.equal(start.payload.parameters.format, 'pcm');
  assert.equal(start.payload.parameters.sample_rate, 8000);
  assert.equal(socket.sent.length, 1);
  socket.reply('task-started');
  assert.deepEqual(socket.sent[1], Buffer.from([200, 0, 112, 254]));
  socket.reply('result-generated', result('你好'));
  socket.reply('result-generated', result('你好，今天'));
  socket.reply('result-generated', result('你好，今天。', true));
  socket.reply('result-generated', { output: { sentence: { heartbeat: true, text: '' } } });
  assert.deepEqual(events, [{ kind: 'partial', text: '你好' }, { kind: 'partial', text: '你好，今天' }, { kind: 'final', text: '你好，今天。' }]);
  stream.end();
  assert.equal(JSON.parse(socket.sent[2]).header.action, 'finish-task');
  assert.equal(JSON.parse(socket.sent[2]).header.task_id, start.header.task_id);
  socket.reply('task-finished');
  assert.deepEqual(events.at(-1), { kind: 'done' });
  assert.equal(socket.closed, true);
});

test('Paraformer streams original 16 kHz PCM and emits text before finish', () => {
  const { stream, socket, events } = session({ model: 'paraformer-realtime-v2' });
  const pcm = Buffer.from([20, 10, 30, 40, 50, 60, 70, 80]);
  stream.push(pcm);
  socket.open();
  const { payload } = JSON.parse(socket.sent[0]);
  assert.equal(payload.model, 'paraformer-realtime-v2');
  assert.equal(payload.parameters.sample_rate, 16000);
  socket.reply('task-started');
  assert.deepEqual(socket.sent[1], pcm);
  socket.reply('result-generated', result('live text'));
  assert.deepEqual(events, [{ kind: 'partial', text: 'live text' }]);
  stream.end();
  socket.reply('result-generated', result('live text.', true));
  socket.reply('task-finished');
  assert.deepEqual(events.slice(-2), [{ kind: 'final', text: 'live text.' }, { kind: 'done' }]);
});

test('千问语音：还没连上就结束录音也会先发送已采集音频，再发送结束命令', () => {
  const { stream, socket } = session();
  socket.open();
  stream.push(Buffer.alloc(4));
  stream.end();
  assert.equal(socket.sent.length, 1);
  socket.reply('task-started');
  assert.deepEqual(socket.sent[1], Buffer.alloc(2));
  assert.equal(JSON.parse(socket.sent[2]).header.action, 'finish-task');
  stream.cancel();
  assert.equal(socket.closed, true);
});

test('千问语音：拒绝第三方地址，服务端错误不会回显 Bearer Key', () => {
  assert.throws(() => session({ baseUrl: 'https://maas.qianwenaiapi.com@other.example/compatible-mode/v1' }), /千问/);
  const { socket, events } = session();
  socket.open();
  socket.reply('task-failed', {}, { error_code: 'InvalidParameter', error_message: 'mock-key' });
  assert.match(events[0].error, /InvalidParameter/);
  assert.doesNotMatch(events[0].error, /mock-key/);
  assert.equal(socket.closed, true);
});
