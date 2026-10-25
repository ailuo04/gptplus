'use strict';
/**
 * 微信连接：通过微信官方 iLink Bot API 长轮询收发消息，并把每个联系人
 * 映射到一个独立的 Codex app-server thread。
 *
 * 协议与行为对齐 Codex++（crates/codex-plus-core/src/connect）：
 * - GET  ilink/bot/get_bot_qrcode?bot_type=3       扫码登录
 * - GET  ilink/bot/get_qrcode_status?qrcode=...    扫码状态
 * - POST ilink/bot/getupdates                      长轮询（get_updates_buf 游标）
 * - POST ilink/bot/sendmessage                     回复（必须带 context_token）
 *
 * 纯 Node CommonJS，不依赖 Electron；fetch/spawn 均可注入，方便 node --test。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCodexAppServer } = require('./codex-app-server.js');
const { resolveCodexCli } = require('./codex-cli.js');
const { qrPngDataUrl } = require('./qr-code.js');

const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = 'gptplus-weixin/1.0';
const DEFAULT_LONG_POLL_MS = 35_000;
const MAX_REPLY_CHARS = 3800;
const MAX_INBOUND_AGE_MS = 5 * 60 * 1000;
const MAX_PROCESSED_KEYS = 512;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 40_000;
const RETRY_DELAY_MS = 2_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_IMAGES = 3;
const OUTPUT_IMAGE_SCAN_LIMIT = 4000;
const OUTPUT_IMAGE_MAX_DEPTH = 6;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const OUTPUT_SCAN_SKIP_DIRS = new Set([
  '.git', '.gptplus', '.codex', 'node_modules', 'dist', 'build', 'out',
  '.cache', 'AppData', 'venv', '.venv', '__pycache__', 'target', '.next',
  'coverage', '.idea', '.vscode',
]);

function normalizeBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  return url || DEFAULT_WEIXIN_BASE_URL;
}

function randomWechatUin() {
  const number = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((Number(plaintextSize) + 1) / 16) * 16;
}

/** CDNMedia.aes_key 是 base64(16 字节) 或 base64(32 位 hex 字符串)。 */
function parseMediaAesKey(value) {
  const decoded = Buffer.from(String(value || ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`微信图片密钥无效（${decoded.length} 字节）`);
}

/** image_item.aeskey 有时是 32 位 hex 字符串。 */
function parseHexAesKey(value) {
  const text = String(value || '').trim();
  if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex');
  return null;
}

function imageMimeFromBuffer(buffer, fallbackName = '') {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  const ext = path.extname(String(fallbackName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

function imageExtensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/bmp') return '.bmp';
  return '.jpg';
}

function isFileInside(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  const relative = path.relative(base, full);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 回合结束后只回传工作目录内、本次新写入的图片，避免把无关文件发出去。 */
function findRecentOutputImages(root, sinceMs, {
  limit = MAX_OUTPUT_IMAGES,
  exclude = [],
} = {}) {
  const found = [];
  const excluded = exclude.filter(Boolean).map((item) => path.resolve(item));
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  while (queue.length && visited < OUTPUT_IMAGE_SCAN_LIMIT) {
    const { directory, depth } = queue.shift();
    if (excluded.some((item) => directory === item || isFileInside(item, directory))) continue;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= OUTPUT_IMAGE_SCAN_LIMIT) break;
      const full = path.join(directory, entry.name);
      if (excluded.some((item) => full === item || isFileInside(item, full))) continue;
      if (entry.isDirectory()) {
        if (depth < OUTPUT_IMAGE_MAX_DEPTH && !OUTPUT_SCAN_SKIP_DIRS.has(entry.name)) {
          queue.push({ directory: full, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OUTBOUND_IMAGE_BYTES) continue;
      if (stat.mtimeMs < sinceMs) continue;
      found.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return found.slice(0, Math.max(0, limit)).map((item) => item.path);
}

function chunkText(text, maxChars = MAX_REPLY_CHARS) {
  if (!maxChars || !text) return [];
  const chars = Array.from(String(text));
  const chunks = [];
  for (let i = 0; i < chars.length; i += maxChars) {
    chunks.push(chars.slice(i, i + maxChars).join(''));
  }
  return chunks;
}

function messageDedupKey(message) {
  return [
    String(message.from_user_id || '').trim(),
    message.message_id ?? 0,
    message.seq ?? 0,
    message.create_time_ms ?? 0,
    String(message.client_id || '').trim(),
  ].join('|');
}

function isFinishedUserMessage(message) {
  return !!message
    && Number(message.message_type) === 1
    && Number(message.message_state) === 2
    && !!String(message.from_user_id || '').trim();
}

function isOlderThan(message, nowMs, maxAgeMs = MAX_INBOUND_AGE_MS) {
  const created = Number(message && message.create_time_ms);
  return Number.isFinite(created) && created > 0 && nowMs - created > maxAgeMs;
}

function isAllowedPeer(allowFrom, peer) {
  const allowed = String(allowFrom || '').trim();
  if (!allowed || allowed === '*') return true;
  return allowed.split(',').map((item) => item.trim()).some((item) => item && item === peer);
}

function messageItemText(item) {
  if (!item || typeof item !== 'object') return null;
  const type = Number(item.type);
  let body = '';
  if (type === 1 && item.text_item) body = String(item.text_item.text || '').trim();
  else if (type === 3 && item.voice_item) body = String(item.voice_item.text || '').trim();
  if (!body) return null;
  const reference = item.ref_msg;
  if (!reference) return body;
  const parts = [];
  if (String(reference.title || '').trim()) parts.push(String(reference.title).trim());
  const referenced = messageItemText(reference.message_item);
  if (referenced) parts.push(referenced);
  return parts.length ? `[引用: ${parts.join(' | ')}]\n${body}` : body;
}

function extractMessageText(message) {
  const items = Array.isArray(message && message.item_list) ? message.item_list : [];
  for (const item of items) {
    const text = messageItemText(item);
    if (text) return text;
  }
  return '';
}

function extractImageSources(message) {
  const items = Array.isArray(message && message.item_list) ? message.item_list : [];
  const sources = [];
  for (const item of items) {
    if (!item || Number(item.type) !== 2) continue;
    const image = item.image_item;
    if (!isPlainObject(image)) continue;
    const media = isPlainObject(image.media) ? image.media : null;
    if (media && String(media.encrypt_query_param || '').trim()) {
      sources.push({
        encryptedQueryParam: String(media.encrypt_query_param).trim(),
        aesKeyBase64: String(media.aes_key || '').trim(),
        aesKeyHex: String(image.aeskey || '').trim(),
        size: Number(image.mid_size || 0),
      });
    } else if (/^https?:\/\//i.test(String(image.url || ''))) {
      sources.push({ url: String(image.url).trim() });
    }
    if (sources.length >= MAX_IMAGES_PER_MESSAGE) break;
  }
  return sources;
}

function extractMessageContent(message) {
  return {
    text: extractMessageText(message),
    images: extractImageSources(message),
  };
}

const WEIXIN_COMMANDS_HELP = [
  '📋 微信连接指令',
  '帮助 / 指令 —— 显示本帮助',
  '新对话 / 新会话 —— 清空当前联系人的上下文，下一条消息开始新会话',
  '状态 —— 查看连接、账号、工作目录、模型、沙箱和当前会话',
  '',
  '也支持 /help、/new、/status。',
  '说明：只有以上指令会被拦截，其它消息都会发给 Codex。每个微信联系人独立会话；指令按顺序处理，当前 Codex 任务结束后才会执行。',
  '任务通知：ChatGPT 任务开始/完成即时推送，运行中每 5 分钟提醒一次；通知不进入 Codex 上下文。',
  '图片：直接发图片（可带文字）即可让 Codex 查看/修改；本次回合在工作目录内新生成或修改的图片会自动回传，最多 3 张（需要工作目录可写）。',
].join('\n');

const SANDBOX_LABELS = {
  'read-only': '只读',
  'workspace-write': '允许修改工作目录',
  'danger-full-access': '完全访问',
};

const COMMAND_STATUS_MESSAGES = {
  help: '已发送指令帮助。',
  new: '已清空上下文，下一条消息开始新会话。',
  status: '已发送连接状态。',
};

function sandboxLabel(value) {
  return SANDBOX_LABELS[value] || '只读';
}

/** 微信指令只认整条消息，避免“帮助我改代码”这类正常提问被拦截。 */
function parseWeixinCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw === '?' || raw === '？') return 'help';
  let body = raw.replace(/^\/+/, '').trim();
  body = body.replace(/[。.!！?？]+$/, '').trim();
  if (!body) return null;
  const value = body.toLowerCase();
  if (['帮助', 'help', '指令', '菜单', 'commands'].includes(value)) return 'help';
  if (['新对话', '新会话', '清空上下文', '重置', 'new', 'reset', 'clear'].includes(value)) return 'new';
  if (['状态', 'status', '当前会话'].includes(value)) return 'status';
  return null;
}

function compactWorkDir(workDir) {
  const value = String(workDir || '');
  const home = os.homedir();
  if (!home) return value;
  if (value === home) return '~';
  const relative = path.relative(home, value);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.replace(/\\/g, '/')}`;
  }
  return value;
}

function appendReplyFooter(reply, turn, workDir) {
  const model = String((turn && turn.model) || '').trim() || 'Codex';
  const usage = (turn && turn.usage) || {};
  let context = 'ctx --';
  if (Number.isFinite(usage.contextUsed) && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
    const percent = Math.min(100, Math.round((usage.contextUsed / usage.contextWindow) * 100));
    context = `ctx ${percent}%`;
  }
  return `${String(reply || '').trim()}\n\n${model} · ${context}\n${compactWorkDir(workDir)}`;
}

function formatTaskDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** ChatGPT 任务通知：直接走微信发送，不进入 Codex 对话上下文。 */
function formatTaskNotification(event) {
  const kind = event && event.kind;
  const task = (event && event.task) || {};
  const title = String(task.title || '未命名任务');
  const endedAt = Number(task.endedAt) || Date.now();
  const startedAt = Number(task.startedAt) || endedAt;
  const duration = formatTaskDuration(Math.max(0, endedAt - startedAt));
  switch (kind) {
    case 'started':
      return `▶️ ChatGPT 任务开始\n${title}${task.model ? `\n模型：${task.model}` : ''}`;
    case 'progress': {
      const rounds = Number(task.rounds) > 1 ? ` · 第 ${Number(task.rounds)} 轮` : '';
      return `⏳ ChatGPT 任务进行中 · 已 ${duration}${rounds}\n${title}`;
    }
    case 'done':
      return `✅ ChatGPT 任务完成 · ${duration}\n${title}${task.lastText ? `\n\n${task.lastText}` : ''}`;
    case 'failed':
      return `❌ ChatGPT 任务失败 · ${duration}\n${title}${task.lastError ? `\n${task.lastError}` : ''}`;
    case 'stopped':
      return `🛑 ChatGPT 任务已停止 · ${duration}\n${title}`;
    case 'stale':
      return `💤 ChatGPT 任务已结束 · ${duration}\n${title}`;
    default:
      return '';
  }
}

function weixinFailureReply(error) {
  const first = String(error || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  let reason = first;
  for (const key of ['USERPROFILE', 'HOME']) {
    const value = process.env[key];
    if (value && value.length > 1) reason = reason.split(value).join('~');
  }
  if (Array.from(reason).length > 160) reason = Array.from(reason).slice(0, 160).join('') + '…';
  if (!reason) return 'Codex 处理失败，请在 gpt++ 中查看连接状态。';
  return `Codex 处理失败：${reason}\n详情请在 gpt++ 中查看连接状态。`;
}

function sanitizeAccountId(value) {
  const account = String(value || '').trim();
  if (!account) return 'default';
  return account.replace(/[\\/:]/g, '_').replace(/\0/g, '_');
}

function stateFilePath(dir, accountId) {
  const account = sanitizeAccountId(accountId);
  const name = account === 'default' ? 'weixin-connect-state.json' : `weixin-connect-state-${account}.json`;
  return path.join(dir, name);
}

function normalizeState(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const toObject = (value) => {
    const out = {};
    if (!isPlainObject(value)) return out;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && key) out[key] = item;
    }
    return out;
  };
  return {
    getUpdatesBuf: typeof src.getUpdatesBuf === 'string' ? src.getUpdatesBuf : '',
    threadIds: toObject(src.threadIds),
    contextTokens: toObject(src.contextTokens),
    processedMessageKeys: Array.isArray(src.processedMessageKeys)
      ? src.processedMessageKeys.filter((item) => typeof item === 'string').slice(-MAX_PROCESSED_KEYS)
      : [],
  };
}

function createStateStore({ dir, accountId }) {
  const file = stateFilePath(dir, accountId);

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return normalizeState(null);
      throw new Error(`无法读取微信连接状态 ${file}: ${err.message}`);
    }
    try {
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      throw new Error(`无法解析微信连接状态 ${file}: ${err.message}`);
    }
  }

  function save(state) {
    const payload = normalizeState(state);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    }
  }

  function isProcessed(state, key) {
    return !!key && state.processedMessageKeys.includes(key);
  }

  function markProcessed(state, key) {
    if (!key || state.processedMessageKeys.includes(key)) return;
    state.processedMessageKeys.push(key);
    while (state.processedMessageKeys.length > MAX_PROCESSED_KEYS) state.processedMessageKeys.shift();
  }

  return { file, load, save, isProcessed, markProcessed };
}

function buildHeaders({ token, routeTag, qrStatus, body = null }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routeTag) headers.skroutetag = routeTag;
  if (qrStatus) headers['iLink-App-ClientVersion'] = '1';
  if (body != null) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
  return headers;
}

function createWeixinClient({
  baseUrl,
  token = '',
  routeTag = '',
  cdnBaseUrl = WEIXIN_CDN_BASE_URL,
  fetchImpl = globalThis.fetch,
  signal = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有可用的 fetch，请升级到 Node 18+');
  const base = normalizeBaseUrl(baseUrl);
  const cdnBase = String(cdnBaseUrl || WEIXIN_CDN_BASE_URL).replace(/\/+$/, '');
  const authToken = String(token || '').trim();
  const tag = String(routeTag || '').trim();

  async function request({ method = 'POST', endpoint, query = null, body = null, auth = false,
    qrStatus = false, timeoutMs = API_TIMEOUT_MS, allowEmpty = false } = {}) {
    const url = new URL(endpoint, `${base}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('微信请求超时')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = () => controller.abort(signal.reason || new Error('微信连接已停止'));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new Error('微信连接已停止');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url.toString(), {
        method,
        headers: buildHeaders({ token: auth ? authToken : '', routeTag: tag, qrStatus, body }),
        body: body == null ? undefined : body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      if (!text.trim()) {
        if (allowEmpty) return {};
        throw new Error('响应为空');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('响应格式无效');
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** CDN 请求不走 iLink 鉴权头，单独处理绝对 URL 与超时。 */
  async function fetchRaw(url, { method = 'GET', headers = {}, body = null, timeoutMs = API_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('微信 CDN 请求超时')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = () => controller.abort(signal.reason || new Error('微信连接已停止'));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new Error('微信连接已停止');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetchImpl(url, {
        method,
        headers,
        body: body == null ? undefined : body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function downloadImageSource(source) {
    let buffer;
    if (source && source.url) {
      const res = await fetchRaw(source.url, { timeoutMs: 30_000 });
      if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } else if (source && source.encryptedQueryParam) {
      let key = null;
      if (source.aesKeyHex) key = parseHexAesKey(source.aesKeyHex);
      if (!key && source.aesKeyBase64) key = parseMediaAesKey(source.aesKeyBase64);
      const url = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(source.encryptedQueryParam)}`;
      const res = await fetchRaw(url, { timeoutMs: 30_000 });
      if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`);
      const encrypted = Buffer.from(await res.arrayBuffer());
      buffer = key ? decryptAesEcb(encrypted, key) : encrypted;
    } else {
      throw new Error('微信图片消息缺少下载参数');
    }
    if (!buffer.length) throw new Error('微信图片内容为空');
    if (buffer.length > MAX_INBOUND_IMAGE_BYTES) {
      throw new Error(`图片过大（${(buffer.length / 1024 / 1024).toFixed(1)} MB，上限 ${MAX_INBOUND_IMAGE_BYTES / 1024 / 1024} MB）`);
    }
    return { buffer, mime: imageMimeFromBuffer(buffer, source.url || '') };
  }

  async function getUploadUrl({ filekey, toUserId, rawsize, rawfilemd5, filesize, aeskey }) {
    const json = await request({
      method: 'POST',
      endpoint: 'ilink/bot/getuploadurl',
      auth: true,
      body: JSON.stringify({
        filekey,
        media_type: 1,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey,
      }),
      timeoutMs: API_TIMEOUT_MS,
    });
    const ret = Number(json && json.ret || 0);
    const errcode = Number(json && json.errcode || 0);
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`获取图片上传地址失败：ret=${ret} errcode=${errcode} ${String(json && json.errmsg || '')}`);
    }
    const uploadFullUrl = String(json && json.upload_full_url || '').trim();
    const uploadParam = String(json && json.upload_param || '').trim();
    if (!uploadFullUrl && !uploadParam) {
      throw new Error('获取图片上传地址失败：响应缺少 upload_full_url/upload_param');
    }
    return { uploadFullUrl, uploadParam };
  }

  async function sendImage(toUserId, filePath, contextToken) {
    const tokenValue = String(contextToken || '').trim();
    if (!tokenValue) throw new Error('微信回复缺少 context_token');
    const plaintext = await fs.promises.readFile(filePath);
    if (!plaintext.length) throw new Error('图片内容为空');
    if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      throw new Error('不是可发送的图片文件');
    }
    if (plaintext.length > MAX_OUTBOUND_IMAGE_BYTES) {
      throw new Error(`图片过大（${(plaintext.length / 1024 / 1024).toFixed(1)} MB，上限 ${MAX_OUTBOUND_IMAGE_BYTES / 1024 / 1024} MB）`);
    }
    const mime = imageMimeFromBuffer(plaintext, filePath);
    if (!mime.startsWith('image/')) throw new Error('不是可发送的图片文件');

    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);
    const upload = await getUploadUrl({
      filekey,
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString('hex'),
    });
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const uploadUrl = upload.uploadFullUrl
      ? new URL(upload.uploadFullUrl, `${base}/`).toString()
      : `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(upload.uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    let downloadParam = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await fetchRaw(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        timeoutMs: 60_000,
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`图片上传失败：HTTP ${res.status}`);
      }
      await res.arrayBuffer().catch(() => null);
      if (res.status === 200) {
        downloadParam = String(res.headers.get('x-encrypted-param') || '').trim();
        if (downloadParam) break;
      }
    }
    if (!downloadParam) throw new Error('图片上传失败：CDN 未返回加密参数');

    const clientId = crypto.randomUUID();
    const body = JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: downloadParam,
              // 协议要求 base64(hex ASCII)，不是 base64(16 字节密钥)。
              aes_key: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
              encrypt_type: 1,
            },
            mid_size: filesize,
          },
        }],
        context_token: tokenValue,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const json = await request({
      method: 'POST',
      endpoint: 'ilink/bot/sendmessage',
      auth: true,
      body,
      timeoutMs: API_TIMEOUT_MS,
      allowEmpty: true,
    });
    const ret = Number(json && json.ret || 0);
    const errcode = Number(json && json.errcode || 0);
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`发送微信图片被拒绝：ret=${ret} errcode=${errcode} ${String(json && json.errmsg || '')}`);
    }
    return clientId;
  }

  async function fetchQrCode() {
    const json = await request({
      method: 'GET',
      endpoint: 'ilink/bot/get_bot_qrcode',
      query: { bot_type: '3' },
      timeoutMs: QR_TIMEOUT_MS,
    });
    const qrCode = String(json && json.qrcode || '').trim();
    const qrContent = String(json && json.qrcode_img_content || '').trim();
    if (!qrCode || !qrContent) throw new Error('微信二维码响应缺少必要字段');
    return { qrcode: qrCode, qrcode_img_content: qrContent };
  }

  async function pollQrStatus(qrCode) {
    try {
      const json = await request({
        method: 'GET',
        endpoint: 'ilink/bot/get_qrcode_status',
        query: { qrcode: qrCode },
        qrStatus: true,
        timeoutMs: QR_TIMEOUT_MS,
      });
      return {
        status: String(json && json.status || 'wait'),
        botToken: String(json && json.bot_token || ''),
        ilinkBotId: String(json && json.ilink_bot_id || ''),
        baseUrl: String(json && json.baseurl || ''),
        ilinkUserId: String(json && json.ilink_user_id || ''),
      };
    } catch (err) {
      if (err && (err.name === 'AbortError' || /微信请求超时/.test(err.message))) {
        return { status: 'wait', botToken: '', ilinkBotId: '', baseUrl: '', ilinkUserId: '' };
      }
      throw err;
    }
  }

  async function getUpdates(getUpdatesBuf, timeoutMs = DEFAULT_LONG_POLL_MS) {
    const wait = Math.max(1000, Math.min(60_000, Number(timeoutMs) || DEFAULT_LONG_POLL_MS));
    let json;
    try {
      json = await request({
        method: 'POST',
        endpoint: 'ilink/bot/getupdates',
        auth: true,
        body: JSON.stringify({
          get_updates_buf: String(getUpdatesBuf || ''),
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        timeoutMs: wait + 5000,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || /微信请求超时/.test(err.message))) {
        return {
          ret: 0,
          errcode: 0,
          errmsg: '',
          msgs: [],
          get_updates_buf: String(getUpdatesBuf || ''),
          longpolling_timeout_ms: wait,
        };
      }
      throw err;
    }
    const ret = Number(json && json.ret || 0);
    const errcode = Number(json && json.errcode || 0);
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`微信长轮询被拒绝：ret=${ret} errcode=${errcode} ${String(json && json.errmsg || '')}`);
    }
    return {
      ret,
      errcode,
      errmsg: String(json && json.errmsg || ''),
      msgs: Array.isArray(json && json.msgs) ? json.msgs : [],
      get_updates_buf: String(json && json.get_updates_buf || ''),
      longpolling_timeout_ms: Number(json && json.longpolling_timeout_ms || 0),
    };
  }

  async function sendText(toUserId, text, contextToken) {
    const tokenValue = String(contextToken || '').trim();
    if (!tokenValue) throw new Error('微信回复缺少 context_token');
    const body = JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: String(text || '') } }],
        context_token: tokenValue,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const json = await request({
      method: 'POST',
      endpoint: 'ilink/bot/sendmessage',
      auth: true,
      body,
      timeoutMs: API_TIMEOUT_MS,
      allowEmpty: true,
    });
    const ret = Number(json && json.ret || 0);
    const errcode = Number(json && json.errcode || 0);
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`发送微信回复被拒绝：ret=${ret} errcode=${errcode} ${String(json && json.errmsg || '')}`);
    }
  }

  async function sendTextChunks(toUserId, text, contextToken, options = {}) {
    const chunks = chunkText(text, MAX_REPLY_CHARS);
    for (const chunk of chunks) {
      if (signal && signal.aborted) throw new Error('微信连接已停止');
      await sendText(toUserId, chunk, contextToken);
      await sleep(100, options.signal || signal);
    }
  }

  return {
    fetchQrCode,
    pollQrStatus,
    getUpdates,
    sendText,
    sendTextChunks,
    downloadImageSource,
    sendImage,
  };
}

/**
 * @param {{ store:any, log?:(e:any)=>void, onEvent?:(s:any)=>void, stateDir:string,
 *           fetchImpl?:typeof fetch, now?:()=>number,
 *           appServerFactory?:Function, resolveCli?:Function,
 *           qrRenderer?:(content:string)=>string, appVersion?:string }} deps
 */
function createWeixinConnect(deps = {}) {
  const { store, log = () => {}, onEvent = () => {}, stateDir } = deps;
  if (!store) throw new Error('createWeixinConnect 需要 store');
  if (!stateDir) throw new Error('createWeixinConnect 需要 stateDir');
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const fetchImpl = deps.fetchImpl == null ? globalThis.fetch : deps.fetchImpl;
  const appServerFactory = typeof deps.appServerFactory === 'function'
    ? deps.appServerFactory : createCodexAppServer;
  const resolveCli = typeof deps.resolveCli === 'function' ? deps.resolveCli : resolveCodexCli;
  const qrRenderer = typeof deps.qrRenderer === 'function' ? deps.qrRenderer : qrPngDataUrl;

  let status = {
    state: 'stopped',
    message: '微信连接未启动。',
    accountId: '',
    lastPeerId: '',
    lastMessageAtMs: 0,
    processedMessages: 0,
  };
  let runtime = null;
  let qrSession = null;
  let noNotifyTargetLogged = false;

  function config() {
    return store.get().weixin || {};
  }

  function getStatus() {
    return { ...status, hasToken: !!String(config().token || '').trim() };
  }

  function setStatus(patch) {
    const next = { ...status, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(status);
    status = next;
    if (changed) {
      try { onEvent(getStatus()); } catch { /* 推送失败不影响连接 */ }
    }
    return getStatus();
  }

  async function closeAppServer(rt) {
    const server = rt.appServer;
    rt.appServer = null;
    if (!server) return;
    try { await server.close(); } catch { /* ignore */ }
  }

  function notificationTarget(rt) {
    const allowed = String(rt.allowFrom || config().allowFrom || '').trim();
    const allowedIds = allowed && allowed !== '*'
      ? allowed.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    const candidates = allowedIds.length
      ? [...allowedIds]
      : [status.lastPeerId, ...Object.keys(rt.state.contextTokens)];
    for (const id of candidates) {
      if (!id || !rt.state.contextTokens[id]) continue;
      if (isAllowedPeer(allowed, id)) return id;
    }
    return '';
  }

  /** 任务通知直接走 iLink 发送，不写入 Codex 对话上下文。 */
  async function sendNotification(text) {
    const message = String(text || '').trim();
    if (!message) return { ok: false, error: '通知内容为空' };
    const rt = runtime;
    if (!rt || rt.stop) return { ok: false, error: '微信连接未运行' };
    const target = notificationTarget(rt);
    if (!target) {
      if (!noNotifyTargetLogged) {
        noNotifyTargetLogged = true;
        log({ level: 'warn', msg: 'ChatGPT 任务通知未发送：请先给机器人发一条微信消息以建立回复通道' });
      }
      return { ok: false, error: '没有可回复的微信联系人' };
    }
    noNotifyTargetLogged = false;
    const client = rt.client || createWeixinClient({
      baseUrl: rt.config.baseUrl,
      token: rt.config.token,
      routeTag: rt.config.routeTag,
      fetchImpl,
      signal: rt.controller.signal,
    });
    try {
      await client.sendTextChunks(
        target,
        message,
        rt.state.contextTokens[target],
        { signal: rt.controller.signal },
      );
      return { ok: true, target };
    } catch (err) {
      log({ level: 'warn', msg: `ChatGPT 任务通知发送失败: ${err && err.message ? err.message : err}` });
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function notifyTask(event) {
    const text = formatTaskNotification(event);
    if (!text) return;
    void sendNotification(text).catch(() => {});
  }

  async function qrStart({ baseUrl, routeTag } = {}) {
    const cfg = config();
    const base = normalizeBaseUrl(baseUrl || cfg.baseUrl);
    const tag = String(routeTag == null ? cfg.routeTag || '' : routeTag).trim();
    const client = createWeixinClient({ baseUrl: base, token: '', routeTag: tag, fetchImpl });
    const qr = await client.fetchQrCode();
    qrSession = {
      baseUrl: base,
      routeTag: tag,
      qrCode: qr.qrcode,
      qrContent: qr.qrcode_img_content,
      qrImage: qrRenderer(qr.qrcode_img_content),
    };
    return {
      qrStatus: 'wait',
      qrContent: qrSession.qrContent,
      qrImage: qrSession.qrImage,
      accountId: '',
      linkedUserId: '',
      hasToken: false,
    };
  }

  async function qrStatus() {
    if (!qrSession) throw new Error('当前没有待确认的微信二维码。');
    const session = qrSession;
    const client = createWeixinClient({
      baseUrl: session.baseUrl,
      token: '',
      routeTag: session.routeTag,
      fetchImpl,
    });
    const result = await client.pollQrStatus(session.qrCode);
    if (result.status === 'confirmed') {
      if (!result.botToken.trim() || !result.ilinkBotId.trim()) {
        throw new Error('微信已确认登录，但网关未返回完整凭据。');
      }
      const patch = {
        token: result.botToken.trim(),
        accountId: result.ilinkBotId.trim(),
        baseUrl: normalizeBaseUrl(result.baseUrl || session.baseUrl),
        routeTag: session.routeTag,
      };
      if (!String(config().allowFrom || '').trim() && result.ilinkUserId.trim()) {
        patch.allowFrom = result.ilinkUserId.trim();
      }
      store.update((draft) => {
        draft.weixin = { ...draft.weixin, ...patch };
      });
      qrSession = null;
      setStatus({ accountId: patch.accountId });
      return {
        qrStatus: 'confirmed',
        qrContent: '',
        qrImage: '',
        accountId: patch.accountId,
        linkedUserId: result.ilinkUserId,
        hasToken: true,
      };
    }
    if (result.status === 'expired') qrSession = null;
    return {
      qrStatus: result.status,
      qrContent: session.qrContent,
      qrImage: session.qrImage,
      accountId: '',
      linkedUserId: '',
      hasToken: false,
    };
  }

  function commandStatusText(rt, from) {
    const cfg = config();
    const threadId = rt.state.threadIds[from];
    const stateLabel = {
      stopped: '已停止',
      starting: '正在启动',
      running: '运行中',
      retrying: '正在重试',
      stopping: '正在停止',
      error: '异常',
    }[status.state] || status.state;
    return [
      `🤖 微信连接：${stateLabel}`,
      `账号：${cfg.accountId || '未登录'}`,
      `联系人：${from}`,
      `工作目录：${rt.workDir}`,
      `模型：${rt.model || 'Codex 当前默认模型'}`,
      `沙箱：${sandboxLabel(rt.sandbox)}`,
      `会话：${threadId ? `${threadId.slice(0, 8)}…` : '未创建（下一条消息新建）'}`,
      `已处理消息：${status.processedMessages}`,
    ].join('\n');
  }

  function commandReply(rt, command, from) {
    if (command === 'help') return WEIXIN_COMMANDS_HELP;
    if (command === 'status') return commandStatusText(rt, from);
    delete rt.state.threadIds[from];
    return '🧹 已清空当前联系人的对话上下文，下一条消息会开始新的 Codex 会话。';
  }

  function saveInboundImage(rt, buffer, mime) {
    fs.mkdirSync(rt.mediaDir, { recursive: true });
    const file = path.join(
      rt.mediaDir,
      `in-${now()}-${crypto.randomBytes(4).toString('hex')}${imageExtensionForMime(mime)}`,
    );
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return { path: file, url: pathToFileURL(file).href, mime };
  }

  async function downloadInboundImages(rt, client, sources) {
    const images = [];
    const errors = [];
    for (const source of sources) {
      try {
        const downloaded = await client.downloadImageSource(source);
        images.push(saveInboundImage(rt, downloaded.buffer, downloaded.mime));
      } catch (err) {
        errors.push(err && err.message ? err.message : String(err));
      }
    }
    return { images, errors };
  }

  async function processMessage(rt, client, message, text, images = []) {
    const configuredPath = String((config().codexPath) || '').trim();
    if (rt.appServer && !rt.appServer.isRunning()) await closeAppServer(rt);
    if (rt.appServer && rt.appServerPath !== configuredPath) {
      await closeAppServer(rt);
    }
    if (!rt.appServer) {
      let resolved = rt.resolvedCli;
      if (!resolved || configuredPath !== rt.resolvedFor) {
        resolved = await resolveCli({
          configuredPath,
          chatgptPath: store.get().chatgpt?.executablePath || null,
        });
        rt.resolvedCli = resolved;
        rt.resolvedFor = configuredPath;
      }
      rt.appServer = await appServerFactory({
        executable: resolved.path,
        workDir: rt.workDir,
        model: rt.model,
        sandbox: rt.sandbox,
        appVersion: rt.appVersion,
        // 让网关识别微信自己的 Codex 请求，避免把它们当成 ChatGPT 任务发通知。
        configOverrides: ['model_providers.gptplus.http_headers.X-Gptplus-Source=weixin'],
      });
      rt.appServerPath = configuredPath;
    }

    const from = String(message.from_user_id);
    const savedThread = rt.state.threadIds[from];
    let threadId;
    try {
      threadId = await rt.appServer.prepareThread(savedThread);
    } catch (err) {
      if (!savedThread) throw err;
      delete rt.state.threadIds[from];
      threadId = await rt.appServer.prepareThread(null);
    }
    rt.state.threadIds[from] = threadId;

    const turnStartedAt = now();
    const turn = await rt.appServer.runTurn(threadId, text, {
      images: images.map((image) => image.url).slice(0, MAX_IMAGES_PER_MESSAGE),
    });
    if (rt.stop) return;
    const reply = String(turn.reply || '').trim() || 'Codex 已完成处理，但没有返回文字内容。';
    await client.sendTextChunks(
      from,
      appendReplyFooter(reply, turn, rt.workDir),
      message.context_token,
      { signal: rt.controller.signal },
    );
    if (rt.stop) return;

    const outputImages = findRecentOutputImages(rt.workDir, turnStartedAt - 2000, {
      limit: MAX_OUTPUT_IMAGES,
      exclude: [stateDir, rt.mediaDir],
    });
    const failed = [];
    for (const file of outputImages) {
      try {
        await client.sendImage(from, file, message.context_token);
      } catch (err) {
        failed.push(`${path.basename(file)}: ${err && err.message ? err.message : err}`);
      }
    }
    if (failed.length && !rt.stop) {
      try {
        await client.sendTextChunks(
          from,
          `⚠ 有 ${failed.length} 张图片发送失败：${failed[0].slice(0, 160)}`,
          message.context_token,
          { signal: rt.controller.signal },
        );
      } catch { /* 失败提示发不出去时只记日志 */ }
      log({ level: 'warn', msg: `微信图片回传失败: ${failed.join('; ')}` });
    }
  }

  function saveState(rt) {
    try {
      rt.stateStore.save(rt.state);
    } catch (err) {
      log({ level: 'warn', msg: `保存微信连接状态失败: ${err.message}` });
    }
  }

  async function runLoop(rt) {
    const client = createWeixinClient({
      baseUrl: rt.config.baseUrl,
      token: rt.config.token,
      routeTag: rt.config.routeTag,
      fetchImpl,
      signal: rt.controller.signal,
    });
    rt.client = client;
    let timeoutMs = DEFAULT_LONG_POLL_MS;
    let failures = 0;
    setStatus({ state: 'running', message: '微信连接正在运行。' });

    while (!rt.stop) {
      const pollStartedAt = now();
      let updates;
      try {
        updates = await client.getUpdates(rt.state.getUpdatesBuf, timeoutMs);
        failures = 0;
      } catch (err) {
        if (rt.stop) break;
        failures += 1;
        setStatus({
          state: 'retrying',
          message: `微信长轮询失败，稍后重试：${err.message}`,
        });
        log({ level: 'warn', msg: `微信长轮询失败: ${err.message}` });
        const delay = failures >= 3 ? 30_000 : RETRY_DELAY_MS;
        if (failures >= 3) failures = 0;
        await sleep(delay, rt.controller.signal);
        continue;
      }

      if (updates.get_updates_buf) rt.state.getUpdatesBuf = updates.get_updates_buf;
      if (updates.longpolling_timeout_ms > 0) timeoutMs = updates.longpolling_timeout_ms;

      for (const message of updates.msgs) {
        if (rt.stop) break;
        const key = messageDedupKey(message);
        if (!isFinishedUserMessage(message)
          || isOlderThan(message, now())
          || rt.stateStore.isProcessed(rt.state, key)) {
          continue;
        }
        const from = String(message.from_user_id || '').trim();
        if (!isAllowedPeer(rt.allowFrom, from)) {
          setStatus({
            state: 'running',
            message: `已忽略来自非白名单发送方的消息：${from}`,
          });
          continue;
        }
        const content = extractMessageContent(message);
        const text = content.text;
        const imageSources = content.images;
        if (!text && !imageSources.length) {
          rt.stateStore.markProcessed(rt.state, key);
          continue;
        }
        const contextToken = String(message.context_token || '').trim();
        if (!contextToken) {
          setStatus({
            state: 'running',
            message: '收到缺少 context_token 的微信消息，已忽略。',
          });
          rt.stateStore.markProcessed(rt.state, key);
          continue;
        }
        rt.state.contextTokens[from] = contextToken;
        const command = imageSources.length ? null : parseWeixinCommand(text);
        if (command) {
          try {
            const reply = commandReply(rt, command, from);
            await client.sendTextChunks(
              from,
              reply,
              contextToken,
              { signal: rt.controller.signal },
            );
            if (rt.stop) break;
            rt.stateStore.markProcessed(rt.state, key);
            setStatus({
              state: 'running',
              message: COMMAND_STATUS_MESSAGES[command],
              lastPeerId: from,
              lastMessageAtMs: now(),
              processedMessages: status.processedMessages + 1,
            });
          } catch (err) {
            if (rt.stop) break;
            rt.stateStore.markProcessed(rt.state, key);
            setStatus({
              state: 'retrying',
              message: `处理微信指令失败：${err && err.message ? err.message : err}`,
              lastPeerId: from,
              lastMessageAtMs: now(),
            });
            log({ level: 'warn', msg: `处理微信指令失败: ${err && err.message ? err.message : err}` });
          }
          saveState(rt);
          continue;
        }

        let images = [];
        if (imageSources.length) {
          const downloaded = await downloadInboundImages(rt, client, imageSources);
          images = downloaded.images;
          if (downloaded.errors.length) {
            log({ level: 'warn', msg: `微信图片下载失败: ${downloaded.errors.join('; ')}` });
          }
          if (!images.length && !text) {
            rt.stateStore.markProcessed(rt.state, key);
            setStatus({
              state: 'running',
              message: `图片下载失败：${downloaded.errors[0] || '未知错误'}`,
              lastPeerId: from,
              lastMessageAtMs: now(),
            });
            try {
              await client.sendTextChunks(
                from,
                `⚠ 图片下载失败：${downloaded.errors[0] || '未知错误'}`,
                contextToken,
                { signal: rt.controller.signal },
              );
            } catch { /* 失败提示发不出去时只记日志 */ }
            saveState(rt);
            continue;
          }
        }

        try {
          await processMessage(rt, client, message, text || '请描述这张图片的内容', images);
          if (rt.stop) break;
          rt.stateStore.markProcessed(rt.state, key);
          setStatus({
            state: 'running',
            message: '最近一条微信消息已处理。',
            lastPeerId: from,
            lastMessageAtMs: now(),
            processedMessages: status.processedMessages + 1,
          });
        } catch (err) {
          if (rt.stop) break;
          await closeAppServer(rt);
          rt.stateStore.markProcessed(rt.state, key);
          try {
            await client.sendTextChunks(
              from,
              weixinFailureReply(err && err.message ? err.message : err),
              contextToken,
              { signal: rt.controller.signal },
            );
          } catch { /* 失败回复发不出去时只记日志 */ }
          setStatus({
            state: 'retrying',
            message: `处理微信消息失败，等待下一条消息重试：${err && err.message ? err.message : err}`,
            lastPeerId: from,
            lastMessageAtMs: now(),
          });
          log({ level: 'warn', msg: `处理微信消息失败: ${err && err.message ? err.message : err}` });
        }
        saveState(rt);
      }
      saveState(rt);
      // 网关偶尔立即返回（包括立即返回待忽略消息）时不要空转，给状态轮询和 IPC 留出事件循环时间。
      if (!rt.stop) {
        const elapsed = now() - pollStartedAt;
        if (elapsed < 250) await sleep(250 - elapsed, rt.controller.signal);
      }
    }
    await closeAppServer(rt);
  }

  let startInFlight = null;

  function start() {
    if (runtime) {
      return Promise.resolve({ ok: false, error: '微信连接已在运行或正在停止', status: getStatus() });
    }
    if (startInFlight) return startInFlight;
    startInFlight = startInternal().finally(() => { startInFlight = null; });
    return startInFlight;
  }

  async function startInternal() {
    const cfg = config();
    if (!String(cfg.token || '').trim()) {
      setStatus({ state: 'error', message: '请先扫码登录微信。' });
      return { ok: false, error: '请先扫码登录微信。', status: getStatus() };
    }
    const workDir = String(cfg.workDir || '').trim() || os.homedir();
    let stat;
    try {
      stat = fs.statSync(workDir);
    } catch {
      const error = `工作目录不存在：${workDir}`;
      setStatus({ state: 'error', message: error });
      return { ok: false, error, status: getStatus() };
    }
    if (!stat.isDirectory()) {
      const error = `工作目录不是文件夹：${workDir}`;
      setStatus({ state: 'error', message: error });
      return { ok: false, error, status: getStatus() };
    }

    let resolvedCli;
    try {
      setStatus({
        state: 'starting',
        message: '正在查找 Codex CLI 并启动微信连接...',
        accountId: String(cfg.accountId || ''),
      });
      resolvedCli = await resolveCli({
        configuredPath: cfg.codexPath,
        chatgptPath: store.get().chatgpt?.executablePath || null,
      });
    } catch (err) {
      setStatus({ state: 'error', message: err.message });
      return { ok: false, error: err.message, status: getStatus() };
    }

    const stateStore = createStateStore({ dir: stateDir, accountId: cfg.accountId });
    let state;
    try {
      state = stateStore.load();
    } catch (err) {
      setStatus({ state: 'error', message: err.message });
      return { ok: false, error: err.message, status: getStatus() };
    }

    const controller = new AbortController();
    const rt = {
      stop: false,
      controller,
      appServer: null,
      appServerPath: '',
      resolvedCli,
      resolvedFor: String(cfg.codexPath || '').trim(),
      stateStore,
      state,
      workDir,
      mediaDir: path.join(stateDir, 'weixin-media'),
      model: String(cfg.model || '').trim(),
      sandbox: cfg.sandbox,
      allowFrom: String(cfg.allowFrom || '').trim(),
      config: {
        baseUrl: normalizeBaseUrl(cfg.baseUrl),
        token: String(cfg.token || '').trim(),
        routeTag: String(cfg.routeTag || '').trim(),
        codexPath: String(cfg.codexPath || '').trim(),
      },
      appVersion: String(deps.appVersion || '0.0.0'),
      promise: null,
    };
    runtime = rt;
    try {
      store.update((draft) => { draft.weixin = { ...draft.weixin, enabled: true }; });
    } catch { /* 配置写失败不阻止本次启动 */ }
    setStatus({
      state: 'starting',
      message: '正在启动微信连接...',
      accountId: String(cfg.accountId || ''),
    });
    rt.promise = runLoop(rt).then(
      () => null,
      (err) => {
        if (!rt.stop && runtime === rt) {
          setStatus({
            state: 'error',
            message: `微信连接已停止：${err && err.message ? err.message : err}`,
          });
        }
        log({ level: 'warn', msg: `微信连接已停止: ${err && err.message ? err.message : err}` });
      },
    ).finally(() => {
      void closeAppServer(rt);
      if (runtime === rt) runtime = null;
      if (rt.stop && status.state !== 'stopped') {
        setStatus({ state: 'stopped', message: '微信连接已停止。' });
      }
    });
    return { ok: true, status: getStatus() };
  }

  async function stop(options = {}) {
    if (options.persist !== false) {
      try {
        store.update((draft) => { draft.weixin = { ...draft.weixin, enabled: false }; });
      } catch { /* 配置写失败不阻止停止 */ }
    }
    if (!runtime) {
      return { ok: true, status: setStatus({ state: 'stopped', message: '微信连接已停止。' }) };
    }
    const rt = runtime;
    if (rt.stop) {
      return { ok: true, status: setStatus({ state: 'stopping', message: '正在停止微信连接，当前长轮询结束后生效。' }) };
    }
    rt.stop = true;
    setStatus({ state: 'stopping', message: '正在停止微信连接，当前长轮询结束后生效。' });
    try { rt.controller.abort(new Error('微信连接已停止')); } catch { /* ignore */ }
    await closeAppServer(rt);
    await Promise.race([
      rt.promise || Promise.resolve(),
      sleep(3000),
    ]);
    if (runtime === rt) runtime = null;
    return { ok: true, status: setStatus({ state: 'stopped', message: '微信连接已停止。' }) };
  }

  async function autoStart() {
    const cfg = config();
    if (cfg.enabled !== true || !String(cfg.token || '').trim()) return null;
    return start();
  }

  function isRunning() {
    return !!runtime && !runtime.stop;
  }

  return {
    start,
    stop,
    shutdown: () => stop({ persist: false }),
    autoStart,
    isRunning,
    getStatus,
    notifyTask,
    qrStart,
    qrStatus,
    _stateFilePath: (accountId) => stateFilePath(stateDir, accountId),
  };
}

module.exports = {
  DEFAULT_WEIXIN_BASE_URL,
  MAX_REPLY_CHARS,
  createWeixinConnect,
  createWeixinClient,
  createStateStore,
  stateFilePath,
  normalizeBaseUrl,
  normalizeState,
  chunkText,
  messageDedupKey,
  isFinishedUserMessage,
  isOlderThan,
  isAllowedPeer,
  extractMessageText,
  extractMessageContent,
  extractImageSources,
  parseWeixinCommand,
  sandboxLabel,
  WEIXIN_COMMANDS_HELP,
  appendReplyFooter,
  formatTaskDuration,
  formatTaskNotification,
  weixinFailureReply,
  compactWorkDir,
  findRecentOutputImages,
  encryptAesEcb,
  decryptAesEcb,
  parseMediaAesKey,
  MAX_INBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_IMAGE_BYTES,
};
