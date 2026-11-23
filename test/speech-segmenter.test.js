'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyPunctuation,
  composeTranscript,
  createSegmentComposer,
  joinClauses,
  normalizeTranscript,
  pickPunctuation,
  stripSpeechTags,
} = require('../src/core/speech-segmenter.js');

test('speech segmenter: 去掉 SenseVoice 标签与中文分词空格', () => {
  assert.equal(stripSpeechTags('<|zh|><|NEUTRAL|><|Speech|><|woitn|>今天天气不错'), '今天天气不错');
  assert.equal(normalizeTranscript('  今天  天气   不错  '), '今天天气不错');
  assert.equal(normalizeTranscript('你好 , 世界'), '你好，世界');
  assert.equal(normalizeTranscript('hello , world'), 'hello, world');
  assert.equal(normalizeTranscript('这是 3.14 和 5,000'), '这是 3.14 和 5,000');
  assert.equal(normalizeTranscript('？。。开头有标点'), '开头有标点');
});

test('speech segmenter: 停顿时长决定分句标点', () => {
  assert.equal(pickPunctuation({ text: '今天天气不错', pauseMs: 120 }), '');
  assert.equal(pickPunctuation({ text: '今天天气不错', pauseMs: 420 }), '，');
  assert.equal(pickPunctuation({ text: '今天天气不错', pauseMs: 1200 }), '。');
  assert.equal(pickPunctuation({ text: '你吃了吗', pauseMs: 900 }), '？');
  assert.equal(pickPunctuation({ text: '我们走吧', pauseMs: 900 }), '。');
  assert.equal(pickPunctuation({ text: '已经结束了。', pauseMs: 1200 }), '', '模型自带句末标点时不重复追加');
  assert.equal(pickPunctuation({ text: '没听清', pauseMs: 0, final: true }), '。');
});

test('speech segmenter: 句中标点在句末被替换，不会出现「，。」', () => {
  assert.equal(applyPunctuation('今天天气不错，', '。'), '今天天气不错。');
  assert.equal(applyPunctuation('今天天气不错', '，'), '今天天气不错，');
  assert.equal(applyPunctuation('今天天气不错。', '，'), '今天天气不错。');
  assert.equal(joinClauses('你好。', '再见'), '你好。再见');
  assert.equal(joinClauses('Hello.', 'World'), 'Hello. World');
});

test('speech segmenter: 分句器等下一段到达后才定标点，已写文字不需要回改', () => {
  const composer = createSegmentComposer({ language: 'zh' });
  assert.deepEqual(composer.push({ text: '今天天气不错', pauseMs: 0, durationMs: 1200 }), []);
  assert.equal(composer.preview(), '今天天气不错');
  const first = composer.push({ text: '我们去公园', pauseMs: 950, durationMs: 900 });
  assert.deepEqual(first.map((item) => item.text), ['今天天气不错。']);
  assert.deepEqual(first.map((item) => item.append), ['今天天气不错。']);
  assert.equal(composer.committed(), '今天天气不错。');
  const last = composer.flush();
  assert.deepEqual(last.map((item) => item.text), ['我们去公园。']);
  assert.equal(composer.committed(), '今天天气不错。我们去公园。');
});

test('speech segmenter: 极短语气词并入下一句而不是单独成句', () => {
  const composer = createSegmentComposer({ language: 'zh' });
  composer.push({ text: '嗯', pauseMs: 0, durationMs: 180 });
  composer.push({ text: '今天天气不错', pauseMs: 140, durationMs: 1000 });
  const events = composer.push({ text: '我们出门吧', pauseMs: 1200, durationMs: 800 });
  assert.deepEqual(events.map((item) => item.text), ['嗯今天天气不错。']);
  assert.deepEqual(composer.flush().map((item) => item.text), ['我们出门吧。']);
});

test('speech segmenter: 批量路径按段间停顿拼句并处理英文大小写', () => {
  const text = composeTranscript([
    { text: '今天天气不错', pauseMs: 0 },
    { text: '我们去公园', pauseMs: 950 },
    { text: '顺便买点水果', pauseMs: 350 },
  ]);
  assert.equal(text, '今天天气不错。我们去公园，顺便买点水果。');

  const english = composeTranscript([
    { text: 'hello there', pauseMs: 0 },
    { text: 'how are you', pauseMs: 0 },
    { text: 'i am fine', pauseMs: 1200 },
  ], { language: 'en' });
  assert.equal(english, 'Hello there how are you? I am fine.');

  const auto = composeTranscript([
    { text: 'good morning', pauseMs: 0 },
    { text: 'is it ready', pauseMs: 520 },
  ]);
  assert.equal(auto, 'Good morning, is it ready?');
});

test('speech segmenter: 软切段去掉模型补的句尾标点，按真实停顿重新断句', () => {
  const composer = createSegmentComposer({ language: 'zh' });
  composer.push({ text: '语音识别让输入变得更加自然，只需要说话。', pauseMs: 0, durationMs: 3580, softCut: true });
  assert.equal(composer.preview(), '语音识别让输入变得更加自然，只需要说话');
  const events = composer.push({ text: '就能把想法变成文字', pauseMs: 0, durationMs: 2000 });
  assert.deepEqual(events.map((item) => item.text), ['语音识别让输入变得更加自然，只需要说话']);
  const last = composer.flush();
  assert.deepEqual(last.map((item) => item.text), ['就能把想法变成文字。']);
  assert.equal(composer.committed(), '语音识别让输入变得更加自然，只需要说话就能把想法变成文字。');
});

test('speech segmenter: 软切后遇到真实停顿仍按停顿补标点', () => {
  const composer = createSegmentComposer({ language: 'zh' });
  composer.push({ text: '今天天气不错。', pauseMs: 0, durationMs: 1500, softCut: true });
  const events = composer.push({ text: '我们出门吧', pauseMs: 1200, durationMs: 900 });
  assert.deepEqual(events.map((item) => item.text), ['今天天气不错。']);
  assert.deepEqual(composer.flush().map((item) => item.text), ['我们出门吧。']);
});

test('speech segmenter: 批量与英文软切同样拼接无缝', () => {
  const text = composeTranscript([
    { text: '随着模型越来越小，离线识别也能在普通。', pauseMs: 0, softCut: true },
    { text: '电脑上流畅运行，又不依赖网络', pauseMs: 0 },
  ]);
  assert.equal(text, '随着模型越来越小，离线识别也能在普通电脑上流畅运行，又不依赖网络。');

  const english = composeTranscript([
    { text: 'the weather is lovely.', pauseMs: 0, softCut: true },
    { text: 'shall we go out', pauseMs: 500 },
  ], { language: 'en' });
  assert.equal(english, 'The weather is lovely, shall we go out?');
});
