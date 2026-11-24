'use strict';
// 语音文本整形与断句：把识别结果和 VAD 停顿时长变成自然的分句与标点。
// 纯函数 + 有状态分句器，主进程与识别工作进程共用；页面运行时不能引用本文件（注入脚本必须自包含）。

/** 中日韩表意文字与假名 */
const CJK_CLASS = '\\u3005\\u3007\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK_RE = new RegExp('[' + CJK_CLASS + ']');
const CJK_EDGE_RE = new RegExp('[' + CJK_CLASS + ']');

/** 句末标点：出现后不再追加新标点 */
const TERMINAL_PUNCT = new Set(['。', '！', '？', '.', '!', '?', '…', '；', ';']);
/** 句中标点：句末时应被替换掉，避免出现「，。」 */
const SOFT_PUNCT = new Set(['，', ',', '、', '：', ':']);

/** 停顿达到该时长判为句末 */
const PERIOD_PAUSE_MS = 1200;
/** 停顿达到该时长判为分句 */
const CLAUSE_PAUSE_MS = 650;
/** 极短片段（字数、时长同时满足）并入下一句，避免「嗯。」这类碎句 */
const FRAGMENT_CHARS = 4;
const FRAGMENT_MS = 900;

/** SenseVoice 可能把语言/情绪/事件标签留在文本里 */
function stripSpeechTags(value) {
  return String(value == null ? '' : value).replace(/<\|[^|>]*\|>/g, ' ').trim();
}

function isCjkChar(ch) {
  return !!ch && CJK_RE.test(ch);
}

function hasCjk(value) {
  return CJK_RE.test(String(value || ''));
}

/**
 * 清理识别文本：去标签、压缩空白、去掉中文之间的空格、统一中文旁的半角标点。
 * 只做显示层的规范化，不改变识别内容本身。
 */
function normalizeTranscript(value) {
  let text = stripSpeechTags(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  // 紧贴中文的半角标点先转全角，避免中英标点混用
  text = text.replace(new RegExp('([' + CJK_CLASS + '])\\s*([,;:?!])', 'g'), (all, ch, punct) => ch + asciiToFullWidth(punct));
  text = text.replace(new RegExp('([,;:?!])\\s*(?=[' + CJK_CLASS + '])', 'g'), (all, punct) => asciiToFullWidth(punct));
  // 全角标点两侧不留空格
  text = text.replace(/\s+([，。！？；：、])/g, '$1');
  text = text.replace(/([，。！？；：、])\s+/g, '$1');
  // 中文分词空格：两侧都是中日韩字符时合并
  text = text.replace(new RegExp('([' + CJK_CLASS + '])\\s+(?=[' + CJK_CLASS + '])', 'g'), '$1');
  // 英文标点前不留空格，逗号/问号/叹号后补一个空格
  text = text.replace(/\s+([,;:?!])/g, '$1');
  text = text.replace(/([,;:?!])(?=[A-Za-z])/g, '$1 ');
  // 重复标点压成一个
  text = text.replace(/([，。！？；：])\1+/g, '$1');
  // 去掉开头的悬空标点
  text = text.replace(/^[，,、：:；;。.！!？?]+/, '');
  return text.trim();
}

function asciiToFullWidth(punct) {
  return { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！' }[punct] || punct;
}

function endsWithTerminal(value) {
  const text = String(value || '').trim().replace(/[”’」』）)\]\"']+$/, '');
  return !!text && TERMINAL_PUNCT.has(text.slice(-1));
}

function isQuestionClause(value) {
  const text = String(value || '').replace(/[\s，,、：:]+$/, '');
  if (!text) return false;
  if (/[?？]$/.test(text)) return true;
  if (/(吗|呢|么|嘛)$/.test(text)) return true;
  if (/(什么|怎么|怎样|为什么|为啥|哪儿|哪里|哪个|哪些|谁|多少|多久|多大|多远|是否|有没有|能不能|可不可以|是不是|对不对|好不好|行不行|要不要|会不会|该不该|有没有在)$/.test(text)) return true;
  return /^(what|why|how|when|where|who|whom|whose|which|do|does|did|is|are|am|was|were|can|could|would|should|shall|will|have|has|may|might)\b/i.test(text);
}

/**
 * 依据停顿与语义线索决定句末标点。
 * @param {{ text: string, pauseMs?: number, final?: boolean }} options
 * @returns {'。'|'，'|'？'|''}
 */
function pickPunctuation({ text, pauseMs = 0, final = false } = {}) {
  const value = String(text || '');
  if (!value) return '';
  if (endsWithTerminal(value)) return '';
  const pause = Number.isFinite(Number(pauseMs)) ? Number(pauseMs) : 0;
  if (isQuestionClause(value) && (final || pause >= CLAUSE_PAUSE_MS)) return '？';
  if (final) return '。';
  if (pause >= PERIOD_PAUSE_MS) return '。';
  if (pause >= CLAUSE_PAUSE_MS) return '，';
  return '';
}

/** 去掉悬空的句中标点后再补标点；已有句末标点时保持原样。 */
function applyPunctuation(value, punct) {
  let text = normalizeTranscript(value);
  if (!text) return '';
  if (endsWithTerminal(text) || (!punct && SOFT_PUNCT.has(text.slice(-1)))) return text;
  text = text.replace(/[，,、：:]+$/, '');
  if (!text) return '';
  if (endsWithTerminal(text)) return text;
  return text + (punct || '');
}

/** 软切点不是真实句尾：去掉模型在截断处补的标点，交回停顿规则决定。 */
function stripTrailingPunct(value) {
  return String(value || '').replace(/[\s，,、：:；;。.！!？?…]+$/, '');
}

/** 两个分句之间是否需要空格：中文与全角标点相邻时不需要。 */
function needsSpace(prev, next) {
  if (!prev || !next) return false;
  if (/\s$/.test(prev) || /^\s/.test(next)) return false;
  const last = prev.slice(-1);
  const first = next.charAt(0);
  if (CJK_EDGE_RE.test(last) || CJK_EDGE_RE.test(first)) return false;
  if ('，。！？；：、'.includes(last) || '，。！？；：、'.includes(first)) return false;
  return true;
}

function joinClauses(prev, next) {
  const left = String(prev || '');
  const right = String(next || '');
  if (!left) return right;
  if (!right) return left;
  return needsSpace(left, right) ? left + ' ' + right : left + right;
}

/**
 * 把一组已分段结果拼成最终文本（批量识别路径）。
 * @param {Array<{text: string, pauseMs?: number, final?: boolean}>} segments
 * @param {{ language?: string }} options
 */
function composeTranscript(segments, { language = '' } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  let output = '';
  list.forEach((segment, index) => {
    const final = index === list.length - 1;
    // pauseMs 记录的是本段之前的静音，因此本段的句末标点取决于下一段之前的静音
    const next = list[index + 1];
    const clause = formatClause(
      { text: segment && segment.text, pauseMs: next ? next.pauseMs : 0, softCut: segment && segment.softCut },
      { language, prev: output, final },
    );
    if (clause) output = joinClauses(output, clause);
  });
  return output;
}

function punctuateForLanguage(value, language) {
  if (!isLatinLanguage(language)) return value;
  return String(value || '')
    .replace(/。/g, '.')
    .replace(/，/g, ',')
    .replace(/？/g, '?')
    .replace(/！/g, '!')
    .replace(/；/g, ';')
    .replace(/：/g, ':');
}

function formatClause(segment, { language = '', prev = '', final = false } = {}) {
  let text = normalizeTranscript(segment && segment.text);
  if (segment && segment.softCut) text = stripTrailingPunct(text);
  if (!text) return '';
  // 自动识别语言时按本句文字判断，避免英文句子被补上中文标点
  const latin = isLatinLanguage(language) || (!hasCjk(text) && /[A-Za-z]/.test(text));
  const punct = pickPunctuation({ text, pauseMs: segment && segment.pauseMs, final });
  let value = applyPunctuation(text, punct);
  if (latin) value = punctuateForLanguage(value, 'en');
  if (!value) return '';
  if (latin && (!prev || /[.!?]$/.test(prev)) && /^[a-z]/.test(value)) {
    value = value.charAt(0).toUpperCase() + value.slice(1);
  }
  return value;
}

function isLatinLanguage(language) {
  const lang = String(language || '').trim().toLowerCase();
  return lang === 'en' || lang.startsWith('en-');
}

/**
 * 流式分句器：识别出的分段先挂起一段，等下一段的起始时间到达后再定标点。
 * 这样标点由真实停顿决定，且已写入输入框的文字永远不需要回改。
 */
function createSegmentComposer({ language = '', onEmit = null } = {}) {
  let pending = null;
  let carry = '';
  let emitted = '';

  function isFragment(segment) {
    if (!segment) return false;
    const chars = normalizeTranscript(segment.text).replace(/[\s，。！？；：、]/g, '').length;
    const duration = Number(segment.durationMs) || 0;
    return chars <= FRAGMENT_CHARS && duration > 0 && duration < FRAGMENT_MS;
  }

  function makeEvent(text, pauseMs, final) {
    const clause = formatClause({ text, pauseMs }, { language, prev: emitted, final });
    if (!clause) return null;
    const lead = needsSpace(emitted, clause) ? ' ' : '';
    emitted = joinClauses(emitted, clause);
    const event = { text: clause, append: lead + clause, full: emitted };
    if (typeof onEmit === 'function') {
      try { onEmit(event); } catch { /* 渲染失败不能影响识别 */ }
    }
    return event;
  }

  return {
    /** @param {{text: string, pauseMs?: number, durationMs?: number}} segment */
    push(segment) {
      let text = normalizeTranscript(segment && segment.text);
      if (segment && segment.softCut) text = stripTrailingPunct(text);
      if (!text) return [];
      const current = {
        text,
        pauseMs: Math.max(0, Number(segment && segment.pauseMs) || 0),
        durationMs: Math.max(0, Number(segment && segment.durationMs) || 0),
      };
      if (!pending) {
        pending = current;
        return [];
      }
      if (isFragment(pending) && current.pauseMs < CLAUSE_PAUSE_MS && !endsWithTerminal(pending.text)) {
        carry = joinClauses(carry, pending.text);
        pending = current;
        return [];
      }
      const event = makeEvent(joinClauses(carry, pending.text), current.pauseMs, false);
      carry = '';
      pending = current;
      return event ? [event] : [];
    },
    /** 结束本轮：把挂起的一段收尾成句。 */
    flush() {
      if (!pending) {
        carry = '';
        return [];
      }
      const event = makeEvent(joinClauses(carry, pending.text), 0, true);
      pending = null;
      carry = '';
      return event ? [event] : [];
    },
    /** 尚未写入输入框的文字，用于实时字幕。 */
    preview() {
      return joinClauses(carry, pending ? pending.text : '');
    },
    /** 已写入输入框的文字。 */
    committed() {
      return emitted;
    },
    reset() {
      pending = null;
      carry = '';
      emitted = '';
    },
  };
}

module.exports = {
  CLAUSE_PAUSE_MS,
  PERIOD_PAUSE_MS,
  applyPunctuation,
  composeTranscript,
  createSegmentComposer,
  endsWithTerminal,
  hasCjk,
  isCjkChar,
  isQuestionClause,
  joinClauses,
  needsSpace,
  normalizeTranscript,
  pickPunctuation,
  stripSpeechTags,
  stripTrailingPunct,
};
