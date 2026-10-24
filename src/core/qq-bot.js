'use strict';
/**
 * QQ 远程助手：通过 OneBot 11（NapCat）收发 QQ 私聊消息。
 *
 * 发送：POST {apiUrl}/send_private_msg（携带可选 Bearer 令牌）。
 * 接收：NapCat 的「HTTP 上报」把事件 POST 到本地网关的 /onebot/event，
 *       由 gateway/server.js 转交本模块（不依赖 WebSocket，无新增依赖）。
 *
 * 只有 ownerQq 发来的私聊会被当作命令；通知统一发到 notifyQq。
 * 消息里的图片段（OneBot image / CQ:image）会下载成 data URL，随问题
 * 一起经本地网关以 input_image 发给模型（多轮上下文保留最近几条的图片）。
 * 任务事件由 task-center emit('notify')，本模块只负责格式化与发送。
 * 纯 Node CommonJS，不依赖 Electron；fetchImpl 可注入，方便 node --test。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sendJson } = require('./gateway/responses.js');
const { createWebUiClient } = require('./napcat-webui.js');

const REQUEST_TIMEOUT_MS = 10 * 1000;
const CHAT_TIMEOUT_MS = 120 * 1000;  // 手机问答经本地网关请求模型，留足推理时间
const CHAT_IDLE_RESET_MS = 30 * 60 * 1000; // 对话上下文闲置超时自动清空
const CHAT_HISTORY_LIMIT = 12;       // 保留的最近对话轮数（user+assistant 各算一条）
const MODEL_PICK_TIMEOUT_MS = 5 * 60 * 1000; // 「回复序号选模型」的等待窗口
const LAUNCH_WAIT_MS = 120 * 1000;   // 拉起后等待 NapCat 上线的最长时间
const LAUNCH_POLL_MS = 2500;         // 上线轮询间隔
const WEBUI_HINT_AFTER_MS = 30 * 1000; // 等这么久仍离线就探一次 WebUI 登录阶段（等扫码则提前收场）
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30 * 1000; // QQ 图床下载超时（rkey 直链需尽快取）
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;     // 单张图上限（对齐 Anthropic 的 5MB 限制）
const IMAGES_PER_MESSAGE = 4;        // 单条消息最多带的图片数
const IMAGE_HISTORY_TURNS = 2;       // 多轮上下文里保留图片的最近消息条数

// ---------------------------------------------------------------------------
// NapCat 启动命令自动识别（配置的 launchCommand 优先；留空时找常见安装位置）
// ---------------------------------------------------------------------------

/** 已知启动脚本名，按优先级排列（user 版免管理员 UAC，优先于需要提权的 launcher.bat）。 */
const NAPCAT_LAUNCHER_PRIORITY = [
  /^NapCatWinBootMain\.bat$/i,
  /^launcher-user\.bat$/i,
  /^launcher\.bat$/i,
  /^launcher-win10-user\.bat$/i,
  /^launcher-win10\.bat$/i,
  /^NapCatShellMain\.bat$/i,
  /^napcat\.cmd$/i,
];

// NapCat onebot11 配置里 gpt++ 自建条目的名字；只创建/同步这两个条目，不碰用户其它配置。
const NAPCAT_HTTP_SERVER_NAME = 'gptplus-api';
const NAPCAT_HTTP_CLIENT_NAME = 'gptplus-report';

/** 候选安装目录：各盘根、用户目录、桌面/下载里解压出来的 NapCat* 文件夹、npm 全局。 */
function defaultNapCatRoots() {
  const home = process.env.USERPROFILE || os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = [];
  for (const drive of ['C', 'D', 'E']) roots.push(`${drive}:\\NapCat`);
  roots.push(
    path.join(home, 'NapCat'),
    path.join(home, 'Desktop', 'NapCat'),
    path.join(home, 'Downloads', 'NapCat'),
    path.join(local, 'NapCat'),
    path.join(local, 'napcat'),
    path.join(local, 'Programs', 'NapCat'),
    path.join(local, 'Programs', 'napcat'),
    path.join(roaming, 'npm'),
  );
  for (const parent of [home, path.join(home, 'Desktop'), path.join(home, 'Downloads')]) {
    try {
      for (const name of fs.readdirSync(parent)) {
        if (/^napcat/i.test(name)) roots.push(path.join(parent, name));
      }
    } catch { /* 目录不存在则跳过 */ }
  }
  return roots;
}

/**
 * 在候选目录里找 NapCat 启动脚本（已知入口名优先，兜底 NapCat/launcher 开头的
 * .bat/.cmd/.exe）。目录不存在或无匹配则跳过；全都没找到返回 null。
 * @param {{ roots?: string[] }} opts 测试可注入候选目录
 */
function detectNapCatCommand(opts = {}) {
  const roots = Array.isArray(opts.roots) ? opts.roots : defaultNapCatRoots();
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    const scripts = names.filter((name) => /\.(bat|cmd|exe)$/i.test(name)
      && (/^napcat/i.test(name) || /^launcher/i.test(name)));
    if (!scripts.length) continue;
    let pick = null;
    for (const pattern of NAPCAT_LAUNCHER_PRIORITY) {
      pick = scripts.find((name) => pattern.test(name));
      if (pick) break;
    }
    if (!pick) pick = scripts.sort((a, b) => a.localeCompare(b))[0];
    return { command: path.join(root, pick), source: root };
  }
  return null;
}

// ---------------------------------------------------------------------------
// NapCat onebot11 网络配置（首次拉起前写入，登录后 HTTP 服务与上报即生效；
// schema 对齐 NapCat 4.x packages/napcat-onebot/config/config.ts）
// ---------------------------------------------------------------------------

/** 全新安装时写入的默认模板；NapCat 登录后会把它复制成 onebot11_<QQ>.json。 */
function napcatHttpServerEntry({ port, token }) {
  return {
    name: NAPCAT_HTTP_SERVER_NAME,
    enable: true,
    port,
    host: '127.0.0.1',
    enableCors: true,
    enableWebsocket: false,
    messagePostFormat: 'array',
    token: String(token || ''),
    debug: false,
  };
}

function napcatHttpClientEntry({ webhook, eventToken }) {
  return {
    name: NAPCAT_HTTP_CLIENT_NAME,
    enable: true,
    url: webhook,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    token: String(eventToken || ''),
    debug: false,
  };
}

function onebot11Template({ port, token, webhook, eventToken }) {
  return {
    network: {
      httpServers: [napcatHttpServerEntry({ port, token })],
      httpSseServers: [],
      httpClients: [napcatHttpClientEntry({ webhook, eventToken })],
      websocketServers: [],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
  };
}

/**
 * 把 gpt++ 需要的网络配置写进 NapCat 的 config/onebot11*.json：
 * - 没有任何 onebot11 配置 → 创建默认模板（NapCat 对新账号按模板生成）；
 * - 已有配置 → 只同步 gptplus-api / gptplus-report 两个条目的端口/令牌/地址。
 * 配置目录不存在（非 Shell 目录布局）时静默跳过。返回做了什么，便于日志。
 */
function syncNapCatConfig({ configDir, port, token, webhook, eventToken, qq }) {
  let names;
  try {
    names = fs.readdirSync(configDir);
  } catch {
    return { ok: true, action: 'skipped' };
  }
  const baseFile = 'onebot11.json';
  const accountFile = qq ? `onebot11_${qq}.json` : null;
  const writeJson = (file, data) => fs.writeFileSync(path.join(configDir, file), JSON.stringify(data, null, 2));
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf-8'));

  if (!names.includes(baseFile) && !(accountFile && names.includes(accountFile))) {
    writeJson(baseFile, onebot11Template({ port, token, webhook, eventToken }));
    return { ok: true, action: 'created', file: baseFile };
  }
  const touched = [];
  for (const name of [baseFile, accountFile].filter(Boolean)) {
    if (!names.includes(name)) continue;
    let data;
    try {
      data = readJson(name);
    } catch {
      continue; // 单个文件损坏不碰，避免覆盖用户配置
    }
    let changed = false;
    const net = isPlainObject(data.network) ? data.network : (data.network = {});
    const servers = Array.isArray(net.httpServers) ? net.httpServers : (net.httpServers = []);
    const server = servers.find((item) => isPlainObject(item) && item.name === NAPCAT_HTTP_SERVER_NAME);
    if (server) {
      if (server.port !== port) { server.port = port; changed = true; }
      if ((server.token || '') !== String(token || '')) { server.token = String(token || ''); changed = true; }
      if (server.enable !== true) { server.enable = true; changed = true; }
    }
    const clients = Array.isArray(net.httpClients) ? net.httpClients : (net.httpClients = []);
    const client = clients.find((item) => isPlainObject(item) && item.name === NAPCAT_HTTP_CLIENT_NAME);
    if (client) {
      if (client.url !== webhook) { client.url = webhook; changed = true; }
      if ((client.token || '') !== String(eventToken || '')) { client.token = String(eventToken || ''); changed = true; }
      if (client.enable !== true) { client.enable = true; changed = true; }
    }
    // 自有条目只剩一半时补齐另一半（自愈），完全没有时不动（尊重用户自己的配置）
    if (server && !client) { clients.push(napcatHttpClientEntry({ webhook, eventToken })); changed = true; }
    if (client && !server) { servers.push(napcatHttpServerEntry({ port, token })); changed = true; }
    if (changed) {
      writeJson(name, data);
      touched.push(name);
    }
  }
  return { ok: true, action: touched.length ? 'synced' : 'noop', files: touched };
}

// ---------------------------------------------------------------------------
// 图片消息：OneBot image 段（或 CQ 码）→ 可下载的图床直链/本地缓存文件
// ---------------------------------------------------------------------------

/** CQ 码转义还原（&#91;/&#93;/&#44; 先解，&amp; 最后，避免二次解码）。 */
const CQ_UNESCAPE = [['&#91;', '['], ['&#93;', ']'], ['&#44;', ','], ['&amp;', '&']];

function cqDecode(value) {
  let text = String(value);
  for (const [from, to] of CQ_UNESCAPE) text = text.split(from).join(to);
  return text;
}

/** image 段 data（或已解码的 CQ 参数）→ 可拉取的图片来源：QQ 图床 URL 或 NapCat 本地缓存文件。 */
function imageSourceFromData(data) {
  if (!isPlainObject(data)) return null;
  const url = String(data.url || '').trim();
  if (/^https?:\/\//i.test(url)) return { url };
  const file = String(data.file || '').trim();
  if (/^[a-z]:[\\/]|^\\\\|^\/[^/]/i.test(file)) {
    try {
      if (fs.statSync(file).isFile()) return { path: file };
    } catch { /* 不是本地文件则忽略 */ }
  }
  return null;
}

/** 从 CQ 码字符串消息里解析图片来源（message 为字符串格式时兜底）。 */
function cqImageSources(raw) {
  const sources = [];
  for (const code of String(raw || '').match(/\[CQ:image[^\]]*\]/g) || []) {
    const params = {};
    for (const kv of code.slice(1, -1).split(',')) {
      const eq = kv.indexOf('=');
      if (eq > 0) params[kv.slice(0, eq).trim()] = cqDecode(kv.slice(eq + 1));
    }
    const source = imageSourceFromData(params);
    if (source) sources.push(source);
  }
  return sources;
}

/** 取出一条 OneBot 消息里的所有图片来源（array 段优先，CQ 字符串兜底），封顶单条条数。 */
function extractImages(event) {
  const sources = [];
  if (Array.isArray(event.message)) {
    for (const segment of event.message) {
      if (segment && segment.type === 'image') {
        const source = imageSourceFromData(segment.data);
        if (source) sources.push(source);
      }
    }
  }
  if (!sources.length) {
    const raw = typeof event.raw_message === 'string' ? event.raw_message
      : (typeof event.message === 'string' ? event.message : '');
    sources.push(...cqImageSources(raw));
  }
  return sources.slice(0, IMAGES_PER_MESSAGE);
}

/** 判定图片真实类型：响应头优先，魔数兜底，再退回 URL/路径扩展名。 */
function sniffImageType(buffer, contentType, url) {
  const header = String(contentType || '').toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(header)) return header;
  if (buffer.length >= 12) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45) return 'image/webp';
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  }
  const ext = /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.exec(String(url || ''));
  return ext ? `image/${ext[1].toLowerCase() === 'jpg' ? 'jpeg' : ext[1].toLowerCase()}` : 'image/jpeg';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 秒/分级别的可读耗时。 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function elapsedText(task, at) {
  const end = task.endedAt || at || Date.now();
  return formatDuration(end - task.startedAt);
}

const STATUS_BADGE = { done: '✅', failed: '❌', stopped: '🛑', stale: '💤', running: '▶️' };
const STATUS_LABEL = { done: '已完成', failed: '失败', stopped: '已停止', stale: '已结束', running: '进行中' };

/**
 * @param {{ store: any, taskCenter: any, log?: (e:any)=>void,
 *           fetchImpl?: typeof fetch, now?: ()=>number, spawnImpl?: Function,
 *           detectImpl?: typeof detectNapCatCommand,
 *           onEvent?: (s:any)=>void }} deps
 */
function createQqBot(deps = {}) {
  const { store, taskCenter, log = () => {}, onEvent = () => {} } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const doFetch = deps.fetchImpl == null ? globalThis.fetch : deps.fetchImpl;
  const doSpawn = typeof deps.spawnImpl === 'function' ? deps.spawnImpl : spawn;
  const doDetect = typeof deps.detectImpl === 'function' ? deps.detectImpl : detectNapCatCommand;
  if (typeof doFetch !== 'function') {
    throw new Error('当前 Node 运行时没有可用的 fetch，请升级到 Node 18+');
  }
  /** 网关实例由 context.js 在创建后绑定（qq-bot 先于 gateway 构造）。 */
  let gateway = null;
  /** 拉起状态（渲染层经 qqbot:get 读取展示，变化时经 onEvent 推送）；launchInFlight 做并发去重。 */
  let launchState = { phase: 'idle', at: 0, error: '', account: '' };
  let launchInFlight = null;
  let lastLaunchEvent = '';

  /** 写拉起状态并推送渲染层；phase/account/error 都没变时不重复推送。 */
  function setLaunch(next) {
    launchState = { phase: 'idle', at: 0, error: '', account: '', ...next, at: now() };
    const key = `${launchState.phase}|${launchState.account}|${launchState.error}`;
    if (key !== lastLaunchEvent) {
      lastLaunchEvent = key;
      try { onEvent({ ...launchState }); } catch { /* 推送失败不影响拉起 */ }
    }
    return launchState;
  }

  /** 安装器宽限轮询探到登录成功时调用：无论拉起窗口是否已超时，都标记在线。 */
  function markLaunchOnline(account) {
    return setLaunch({ phase: 'online', error: '', account: String(account || '') });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function config() {
    const cfg = store.get();
    return cfg && isPlainObject(cfg.qqbot) ? cfg.qqbot : {};
  }

  function webhookUrl() {
    const state = gateway ? gateway.getState() : null;
    const port = state && state.running ? state.port : Number(store.get().gateway?.port) || 18120;
    return `http://127.0.0.1:${port}/onebot/event`;
  }

  async function onebotCall(action, params, { method = 'POST' } = {}) {
    const cfg = config();
    const base = String(cfg.apiUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: '未配置 NapCat 服务地址' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('NapCat 请求超时')), REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const headers = {};
      if (cfg.accessToken) headers.Authorization = `Bearer ${cfg.accessToken}`;
      let body;
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(params || {});
      }
      const res = await doFetch(`${base}/${action}`, { method, headers, body, signal: controller.signal });
      if (!res.ok) return { ok: false, error: `NapCat HTTP ${res.status}` };
      const json = await res.json().catch(() => null);
      if (!json
        || (json.status !== undefined && json.status !== 'ok')
        || (json.retcode !== undefined && Number(json.retcode) !== 0)) {
        return { ok: false, error: `NapCat 返回失败: ${JSON.stringify(json).slice(0, 200)}` };
      }
      return { ok: true, data: json.data };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 给 notifyQq 发一条私聊消息。 */
  async function sendPrivate(text) {
    const cfg = config();
    if (!cfg.notifyQq) return { ok: false, error: '未配置通知 QQ' };
    const result = await onebotCall('send_private_msg', {
      user_id: Number(cfg.notifyQq),
      message: String(text || '').slice(0, 4500),
    });
    return result.ok ? { ok: true } : result;
  }

  /** 探测 NapCat 连通性，返回登录账号信息。 */
  async function apiTest() {
    const result = await onebotCall('get_login_info', {}, { method: 'GET' });
    if (!result.ok) return result;
    return {
      ok: true,
      account: result.data && result.data.user_id != null ? String(result.data.user_id) : '',
      nickname: (result.data && result.data.nickname) || '',
    };
  }

  /** 下载一张 QQ 图片成 data URL（喂给模型的 input_image 直接可用）。 */
  async function downloadImage(source) {
    let buffer;
    let contentType = '';
    if (source.path) {
      const stat = await fs.promises.stat(source.path);
      if (stat.size > IMAGE_MAX_BYTES) {
        throw new Error(`图片过大（${(stat.size / 1024 / 1024).toFixed(1)} MB，上限 ${IMAGE_MAX_BYTES / 1024 / 1024} MB）`);
      }
      buffer = await fs.promises.readFile(source.path);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('图片下载超时')), IMAGE_DOWNLOAD_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const res = await doFetch(source.url, { signal: controller.signal });
        if (!res.ok) throw new Error(`图床返回 HTTP ${res.status}`);
        contentType = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > IMAGE_MAX_BYTES) {
          throw new Error(`图片过大（${(bytes.length / 1024 / 1024).toFixed(1)} MB，上限 ${IMAGE_MAX_BYTES / 1024 / 1024} MB）`);
        }
        buffer = bytes;
      } finally {
        clearTimeout(timer);
      }
    }
    return `data:${sniffImageType(buffer, contentType, source.url || source.path)};base64,${buffer.toString('base64')}`;
  }

  /** 批量下载图片（单张失败整条报错，原因直接回复给主人）。 */
  async function downloadImages(sources) {
    if (!Array.isArray(sources) || !sources.length) return [];
    return Promise.all(sources.map((source) => downloadImage(source)));
  }

  // -----------------------------------------------------------------------
  // 自动拉起 NapCat（配置了 launchCommand 或能自动识别时；离线才拉，在线直接复用）
  // -----------------------------------------------------------------------

  /** 启动命令解析：配置的 launchCommand 优先，留空时自动识别本机 NapCat。 */
  function resolveLaunchCommand(cfg) {
    const command = String(cfg.launchCommand || '').trim();
    if (command) return { command, detected: false };
    try {
      const found = doDetect();
      return found && found.command ? { command: String(found.command), detected: true } : null;
    } catch {
      return null;
    }
  }

  /** 首次扫码登录成功后按登录账号自动补全：快速登录 QQ / 通知 QQ / 主人 QQ / 顺带开启助手。 */
  function applyFirstLogin(account) {
    if (!account) return;
    const filled = [];
    try {
      store.update((draft) => {
        for (const key of ['launchQq', 'notifyQq', 'ownerQq']) {
          if (!String(draft.qqbot[key] || '').trim()) {
            draft.qqbot[key] = account;
            filled.push(key);
          }
        }
        if (draft.qqbot.autoLaunch === true && draft.qqbot.enabled !== true
          && draft.gateway && draft.gateway.enabled === true) {
          draft.qqbot.enabled = true;
          filled.push('enabled');
        }
      });
      if (filled.length) log({ level: 'info', msg: `已按首次登录账号 ${account} 自动补全 QQ 配置: ${filled.join(', ')}` });
    } catch { /* 补全失败不影响主流程 */ }
  }

  /** 从配置的 apiUrl 里取 NapCat HTTP 端口（写 NapCat onebot11 配置用）。 */
  function apiUrlPort(apiUrl) {
    try {
      const port = Number(new URL(apiUrl).port);
      return port > 0 ? port : 3000;
    } catch {
      return 3000;
    }
  }

  /** 向 NapCat WebUI 探问登录阶段（WebUI 不可用或非登录流程时返回空）。 */
  async function probeNapcatLoginPhase(command) {
    try {
      const client = createWebUiClient({ configDir: path.join(path.dirname(command), 'config'), fetchImpl: doFetch });
      const status = await client.call('CheckLoginStatus');
      return status && status.ok && status.data ? String((status.data).loginPhase || '') : '';
    } catch {
      return '';
    }
  }

  /** 登录阶段的可读提示（写进失败原因，让用户知道卡在哪）。 */
  function loginPhaseHint(phase) {
    if (phase === 'waiting_qrcode') return 'NapCat 正在等待扫码登录（快速登录未生效），点「拉起 NapCat」可在应用内扫码';
    if (phase === 'qrcode_scanned') return '已扫码，等待手机确认登录';
    if (phase === 'initializing') return 'QQ 已确认登录，NapCat 正在初始化';
    if (phase === 'reconnecting') return 'NapCat 正在重新连接 QQ';
    if (phase.includes('expired')) return '登录二维码已过期，点「拉起 NapCat」刷新并重新扫码';
    return phase ? `NapCat 登录阶段：${phase}` : '';
  }

  function isLoginPending(phase) {
    return ['waiting_qrcode', 'qrcode_scanned', 'initializing', 'reconnecting'].includes(phase)
      || phase.includes('expired');
  }

  /**
   * 拉起 NapCat 并轮询 get_login_info 等它上线。
   * 同一时间只允许一次拉起（并发调用共享同一个 Promise）。
   * @param {{ waitMs?: number, intervalMs?: number, hintAfterMs?: number }} opts 测试可注入更小的间隔
   */
  function launchNapCat({ waitMs = LAUNCH_WAIT_MS, intervalMs = LAUNCH_POLL_MS, hintAfterMs = WEBUI_HINT_AFTER_MS } = {}) {
    if (launchInFlight) return launchInFlight;
    const run = (async () => {
      const cfg = config();
      const resolved = resolveLaunchCommand(cfg);
      if (!resolved) {
        setLaunch({
          phase: 'failed',
          error: '未找到 NapCat 启动命令：请先安装 NapCat，或在设置里填写启动脚本的完整路径',
          account: '',
        });
        return { ok: false, error: launchState.error };
      }
      const { command, detected } = resolved;
      const online = await apiTest();
      if (online.ok) {
        applyFirstLogin(online.account);
        setLaunch({ phase: 'online', error: '', account: online.account });
        return { ok: true, alreadyRunning: true, account: online.account, nickname: online.nickname };
      }
      const qq = String(cfg.launchQq || '');
      // NapCat 核心解析 -q/--qq 标志实现快速登录（napcat.mjs 读 process.argv）
      const cmdline = /^\d{4,14}$/.test(qq) ? `${command} -q ${qq}` : command;
      // 拉起前把 gpt++ 需要的网络配置写进 NapCat（只在 Shell 目录布局下生效）
      try {
        const sync = syncNapCatConfig({
          configDir: path.join(path.dirname(command), 'config'),
          port: apiUrlPort(cfg.apiUrl),
          token: cfg.accessToken,
          webhook: webhookUrl(),
          eventToken: cfg.eventToken,
          qq: /^\d{4,14}$/.test(qq) ? qq : '',
        });
        if (sync.action === 'created' || sync.action === 'synced') {
          log({ level: 'info', msg: `已${sync.action === 'created' ? '创建' : '同步'} NapCat 网络配置（${(sync.files || [sync.file]).join(', ')}）` });
        }
      } catch (err) {
        log({ level: 'warn', msg: `写入 NapCat 网络配置失败: ${err && err.message}` });
      }
      try {
        // 经 cmd/sh 执行以兼容 .bat/.cmd 启动器；NapCat 独立运行且不创建前台控制台，
        // 登录二维码与错误状态由应用内 WebUI 流程展示。
        const isWin = process.platform === 'win32';
        const child = isWin
          ? doSpawn('cmd.exe', ['/d', '/s', '/c', cmdline], { windowsHide: true, detached: true, stdio: 'ignore' })
          : doSpawn('/bin/sh', ['-c', cmdline], { detached: true, stdio: 'ignore' });
        if (typeof child.unref === 'function') child.unref();
        // cmd.exe 一定存在，error 事件只会在异常场景出现；必须挂监听避免进程崩溃。
        if (typeof child.on === 'function') {
          child.on('error', (err) => {
            log({ level: 'warn', msg: `NapCat 启动进程异常: ${err && err.message}` });
          });
        }
      } catch (err) {
        setLaunch({ phase: 'failed', error: `启动命令执行失败: ${err && err.message}`, account: '' });
        return { ok: false, error: launchState.error };
      }
      setLaunch({ phase: 'launching', error: '', account: '' });
      log({ level: 'info', msg: `正在拉起 NapCat: ${cmdline}${detected ? '（自动识别）' : ''}` });
      const deadline = now() + waitMs;
      const waitStart = now();
      let lastError = '';
      let loginPhase = '';
      let quickLoginStuck = false;
      while (now() < deadline && !quickLoginStuck) {
        await sleep(intervalMs);
        const probe = await apiTest();
        if (probe.ok) {
          applyFirstLogin(probe.account);
          setLaunch({ phase: 'online', error: '', account: probe.account });
          log({ level: 'info', msg: `NapCat 已上线（${probe.account}${probe.nickname ? ' · ' + probe.nickname : ''}）` });
          return { ok: true, detected, account: probe.account, nickname: probe.nickname };
        }
        lastError = probe.error || '';
        // 等 WebUI 起来后探一次登录阶段：已停在等扫码说明快速登录失败，继续等也不会上线
        if (!loginPhase && now() - waitStart >= hintAfterMs) {
          loginPhase = await probeNapcatLoginPhase(command);
          if (isLoginPending(loginPhase)) quickLoginStuck = true;
        }
      }
      const loginHint = loginPhaseHint(loginPhase);
      const waitedSeconds = Math.round((now() - waitStart) / 1000);
      setLaunch({
        phase: 'failed',
        error: quickLoginStuck
          ? `NapCat 已启动（${waitedSeconds} 秒）但快速登录未生效，${loginHint || '正在等待扫码登录'}。`
          : `NapCat 已启动但 ${Math.round(waitMs / 1000)} 秒内未上线（${lastError || '无响应'}）。`
            + (loginHint || '请重试登录或检查 NapCat 状态。'),
        account: '',
      });
      log({ level: 'warn', msg: `NapCat 拉起超时: ${lastError || loginHint}` });
      return { ok: false, detected, error: launchState.error };
    })();
    launchInFlight = run.finally(() => { launchInFlight = null; });
    return launchInFlight;
  }

  /** 应用启动 / 开关打开时调用：enabled 且配置了自动拉起（或能识别到命令）才执行；永不 reject。 */
  function maybeAutoLaunch() {
    const cfg = config();
    if (!cfg.enabled || !cfg.autoLaunch) return Promise.resolve(null);
    if (!resolveLaunchCommand(cfg)) return Promise.resolve(null);
    return launchNapCat().then(
      (result) => result,
      (err) => {
        log({ level: 'warn', msg: `NapCat 自动拉起失败: ${err && err.message}` });
        return { ok: false, error: err && err.message ? err.message : String(err) };
      },
    );
  }

  // -----------------------------------------------------------------------
  // 通知格式化（task-center emit('notify') -> QQ 消息）
  // -----------------------------------------------------------------------

  function formatNotification(kind, task) {
    if (!task) return '';
    const duration = elapsedText(task, now());
    switch (kind) {
      // 通知只保留：任务名 + 耗时 +（完成时）回答 /（失败时）原因。
      case 'done':
        return `✅「${task.title}」· ${duration}\n${task.lastText || ''}`.trim();
      case 'failed':
        return `❌「${task.title}」失败 · ${duration}${task.lastError ? `\n${task.lastError}` : ''}`;
      case 'stopped':
        return `🛑「${task.title}」已停止 · ${duration}`;
      case 'stale':
        return `💤「${task.title}」已结束 · ${duration}`;
      case 'progress': {
        const rounds = task.rounds > 1 ? `，已 ${task.rounds} 轮` : '';
        return `⏳「${task.title}」进行中 · ${duration}${rounds}`;
      }
      default:
        return '';
    }
  }

  function wireNotifications() {
    taskCenter.on('notify', ({ kind, task } = {}) => {
      if (!config().enabled) return;
      const text = formatNotification(kind, task);
      if (!text) return;
      void sendPrivate(text).then((result) => {
        if (!result.ok) log({ level: 'warn', msg: `QQ 通知发送失败: ${result.error}` });
      }).catch(() => {});
    });
  }

  // -----------------------------------------------------------------------
  // 命令与手机问答（机器人只通报 Codex 状态，不创建/干预任何任务）
  // -----------------------------------------------------------------------

  function helpText() {
    return [
      '📋 QQ 远程助手（只通报，不干预 Codex）',
      '直接发问题 —— 机器人先列出模型让你回序号选择，之后连续追问直接回答',
      '发图片（可配文字）—— 识别图片内容并回答，多轮里可继续追问',
      '模型 —— 重新选择回答模型',
      '新对话 —— 清空对话与模型选择',
      '任务 —— 查看 Codex 任务列表',
      '状态 —— 查看助手运行状态',
      '帮助 —— 显示本帮助',
      '说明：g_ 是 Codex 桌面端会话，这里只展示状态；任务完成/失败会自动推送通知。',
    ].join('\n');
  }

  function taskLine(task, at) {
    const badge = STATUS_BADGE[task.status] || '·';
    const label = STATUS_LABEL[task.status] || task.status;
    const duration = elapsedText(task, at);
    const detail = [];
    if (task.model) detail.push(task.model);
    if (task.kind === 'exec' && task.cwd) detail.push(task.cwd);
    return `${badge} ${task.id} ${label} · ${duration}${detail.length ? ` · ${detail.join(' @ ')}` : ''}\n   ${task.title}`;
  }

  function tasksText() {
    const { running, recent } = taskCenter.listTasks();
    const at = now();
    if (!running.length && !recent.length) return '当前没有任务。发送「新任务 <描述>」发布一个。';
    const parts = [];
    if (running.length) {
      parts.push(`进行中（${running.length}）：`);
      for (const task of running) parts.push(taskLine(task, at));
    } else {
      parts.push('当前没有进行中的任务。');
    }
    if (recent.length) {
      parts.push('');
      parts.push('最近结束：');
      for (const task of recent.slice(0, 5)) parts.push(taskLine(task, at));
    }
    return parts.join('\n');
  }

  async function statusText() {
    const lines = [];
    const api = await apiTest();
    if (api.ok) {
      lines.push(`🤖 NapCat 已连接${api.account ? `（${api.account}${api.nickname ? ' · ' + api.nickname : ''}）` : ''}`);
    } else {
      lines.push(`🤖 NapCat 不可用: ${api.error}`);
    }
    try {
      const codex = await taskCenter.resolveCodex();
      lines.push(`🧠 codex: ${codex.path}（${codex.source}）`);
    } catch (err) {
      lines.push(`🧠 codex 不可用: ${err.message}`);
    }
    const state = gateway ? gateway.getState() : null;
    lines.push(state && state.running ? `🌐 网关运行中: ${state.url}` : '🌐 网关未运行');
    const count = taskCenter.listTasks().running.length;
    lines.push(count ? `📋 ${count} 个任务进行中，回复「任务」查看` : '📋 当前没有进行中的任务');
    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // 手机问答：直连本地网关 /v1/responses（不经过、不影响 codex）
  // -----------------------------------------------------------------------

  /** 手机对话上下文（内存态）；闲置 30 分钟自动清空。 */
  let chatHistory = [];
  let chatAt = 0;

  function gatewayBase() {
    const state = gateway ? gateway.getState() : null;
    const port = state && state.running ? state.port : Number(store.get().gateway?.port) || 18120;
    return `http://127.0.0.1:${port}`;
  }

  /** 调本地网关（带令牌与超时），失败抛错由调用方兜底。X-Gptplus-Qq-Chat 标记
   *  让网关任务观察跳过本轮（手机问答不是 Codex 任务，不能触发完成通知）。 */
  async function gatewayJson(pathname, init = {}) {
    const token = String(store.get().gateway?.token || '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), CHAT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await doFetch(gatewayBase() + pathname, {
        ...init,
        headers: {
          ...(init.headers || {}),
          'Content-Type': 'application/json',
          'X-Gptplus-Qq-Chat': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`网关 HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  let chatModels = [];         // [{id, owner}] 最近一次拉取的可选模型
  let chatModelsAt = 0;
  let chatModel = '';          // 当前选定的模型 id；空 = 还没选
  /** 选模型等待态：{question, at}。question 为空表示只换模型没有待答问题。 */
  let modelPicking = null;

  /** 网关可用模型列表（缓存 10 分钟；最多列 30 个）。 */
  async function fetchChatModels(force = false) {
    if (!force && chatModels.length && now() - chatModelsAt < 10 * 60 * 1000) return chatModels;
    const json = await gatewayJson('/v1/models');
    const data = Array.isArray(json && json.data) ? json.data : [];
    chatModels = data
      .filter((item) => item && item.id)
      .map((item) => ({ id: String(item.id), owner: String(item.owned_by || '') }))
      .slice(0, 30);
    chatModelsAt = now();
    return chatModels;
  }

  function modelListText(models) {
    const lines = ['🤖 请选择回答用的模型（回复序号）：'];
    models.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.id}${item.owner ? `（${item.owner}）` : ''}`);
    });
    lines.push('选一次后连续追问不再重问；发「模型」随时重选。');
    return lines.join('\n');
  }

  /**
   * 把一段对话补进上下文（Responses 契约：user 用 input_text，assistant 用
   * output_text；用户消息里带的图片用 input_image(data URL)，网关两类适配器都支持）。
   */
  function chatInput() {
    return chatHistory.map((item) => {
      if (item.role !== 'user' || !item.images || !item.images.length) {
        return {
          type: 'message',
          role: item.role,
          content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }],
        };
      }
      const content = [{ type: 'input_text', text: item.text }];
      for (const url of item.images) content.push({ type: 'input_image', image_url: url });
      return { type: 'message', role: item.role, content };
    });
  }

  /** 多轮上下文只保留最近几条消息的图片，控制请求体与内存占用。 */
  function trimHistoryImages() {
    let kept = 0;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const item = chatHistory[i];
      if (item.role !== 'user' || !item.images || !item.images.length) continue;
      kept += 1;
      if (kept > IMAGE_HISTORY_TURNS) item.images = [];
    }
  }

  /** 用指定模型回答（上下文多轮，可带图片），返回回答文本。 */
  async function chatReply(text, model, images = []) {
    ensureGatewayOnline();
    if (now() - chatAt > CHAT_IDLE_RESET_MS) chatHistory = [];
    chatAt = now();
    chatHistory.push({ role: 'user', text, images: images.slice(0, IMAGES_PER_MESSAGE) });
    trimHistoryImages();
    chatHistory = chatHistory.slice(-CHAT_HISTORY_LIMIT);
    const json = await gatewayJson('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model, input: chatInput(), stream: false }),
    });
    const output = Array.isArray(json && json.output) ? json.output : [];
    const texts = [];
    for (const item of output) {
      if (!item || item.type !== 'message' || item.role !== 'assistant') continue;
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part && typeof part.text === 'string') texts.push(part.text);
      }
    }
    const answer = texts.join('\n').trim();
    if (!answer) throw new Error('模型没有返回文本');
    chatHistory.push({ role: 'assistant', text: answer.slice(0, 4000) });
    chatHistory = chatHistory.slice(-CHAT_HISTORY_LIMIT);
    return answer;
  }

  /** 手机问答前检查本地网关在线（问答、列模型都依赖它）。 */
  function ensureGatewayOnline() {
    const state = gateway ? gateway.getState() : null;
    if (!state || !state.running) throw new Error('本地网关未运行，暂时无法回答；请先打开 gpt++ 再试');
  }

  /** 普通消息入口：先走「选模型」流程，选好后直接问答（图片随待答问题一起暂存）。 */
  async function handleMessage(body, images = []) {
    ensureGatewayOnline();
    const models = await fetchChatModels();
    if (!models.length) throw new Error('网关没有可用模型，请先在模型页启用至少一个');
    // 正在等序号：纯数字 = 选模型（带图片的数字消息一定是在问图，不当序号处理）
    if (modelPicking && now() - modelPicking.at <= MODEL_PICK_TIMEOUT_MS) {
      const index = Number(body);
      if (!images.length && Number.isInteger(index) && index >= 1 && index <= models.length) {
        chatModel = models[index - 1].id;
        const { question, images: pending } = modelPicking;
        modelPicking = null;
        return question || (pending && pending.length)
          ? chatReply(question, chatModel, pending || [])
          : `✅ 已切换模型：${chatModel}`;
      }
      // 不是序号：当作新问题，重新出列表等选择
      modelPicking = { question: body, images, at: now() };
      return modelListText(models);
    }
    modelPicking = null;
    if (!chatModel) {
      modelPicking = { question: body, images, at: now() };
      return modelListText(models);
    }
    return chatReply(body, chatModel, images);
  }

  /** 把一条主人消息解析成回复文本；images 为已下载好的 data URL；异常向上抛由调用方兜底。 */
  async function runCommand(rawText, images = []) {
    let body = String(rawText || '').replace(/^\//, '').replace(/｜/g, '|').trim();
    const imageList = images
      .filter((item) => typeof item === 'string' && item.startsWith('data:image/'))
      .slice(0, IMAGES_PER_MESSAGE);
    // 只发图片没配文字：用默认提问让模型直接描述图片
    if (!body && imageList.length) body = '请描述这张图片的内容';
    if (!body) return '空的命令。回复「帮助」查看用法。';
    if (body === '帮助' || body === 'help' || body === '?') return helpText();
    if (body === '任务' || body === 'tasks' || body === '列表') return tasksText();
    if (body === '状态' || body === 'status') return statusText();
    if (body === '模型' || body === 'model') {
      ensureGatewayOnline();
      const models = await fetchChatModels(true);
      if (!models.length) throw new Error('网关没有可用模型，请先在模型页启用至少一个');
      modelPicking = { question: '', at: now() };
      return modelListText(models);
    }
    if (body === '新对话' || body === '重置') {
      chatHistory = [];
      chatModel = '';
      modelPicking = null;
      return '🧹 已清空对话与模型选择，直接发消息开始新对话。';
    }
    // 其余一切文本都当作对模型的提问（不创建、不干预 Codex 任务）。
    return handleMessage(body, imageList);
  }

  // -----------------------------------------------------------------------
  // OneBot 事件入口（gateway /onebot/event）
  // -----------------------------------------------------------------------

  function webhookAuthorized(req, url) {
    const token = String(config().eventToken || '');
    if (!token) return true;
    const header = (name) => String(req.headers?.[name] || '').trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(header('authorization'));
    const candidates = [
      bearer ? bearer[1] : '',
      header('access-token'),
      header('x-access-token'),
      url.searchParams ? url.searchParams.get('access_token') : '',
    ];
    return candidates.some((value) => value && safeEqual(value, token));
  }

  /** 从 OneBot 消息事件里取出纯文本（去掉 CQ 码）。 */
  function extractText(event) {
    const strip = (value) => String(value || '').replace(/\[CQ:[^\]]*\]/g, '').trim();
    if (typeof event.raw_message === 'string') {
      const text = strip(event.raw_message);
      if (text) return text;
    }
    if (Array.isArray(event.message)) {
      const text = event.message
        .filter((segment) => segment && segment.type === 'text')
        .map((segment) => (segment.data && segment.data.text) || '')
        .join('')
        .trim();
      if (text) return text;
    }
    if (typeof event.message === 'string') return strip(event.message);
    return '';
  }

  /** 只把「主人发来的私聊消息」当命令（文本 + 图片来源）；其它事件一律忽略。 */
  function commandFromEvent(event) {
    if (!isPlainObject(event) || event.post_type !== 'message') return null;
    if (event.message_type !== 'private') return null;
    const cfg = config();
    if (!cfg.ownerQq) return null;
    const senderId = String(
      (event.sender && event.sender.user_id) != null ? event.sender.user_id : event.user_id,
    );
    if (senderId !== String(cfg.ownerQq)) return null;
    return { text: extractText(event), images: extractImages(event) };
  }

  /**
   * 处理一条上报事件。命令在后台执行并经 send_private_msg 回复；
   * HTTP 响应立即返回 200，避免 NapCat 上报超时。
   */
  async function handleWebhook(req, res, body) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!webhookAuthorized(req, url)) {
      sendJson(res, 401, { error: { message: '无效的事件上报令牌' } });
      return;
    }
    const command = commandFromEvent(body);
    if (command && (command.text || command.images.length)) {
      void (async () => {
        try {
          const images = await downloadImages(command.images);
          const reply = await runCommand(command.text, images);
          if (reply) await sendPrivate(reply);
        } catch (err) {
          log({ level: 'warn', msg: `QQ 命令执行失败: ${err && err.message}` });
          await sendPrivate(`⚠ 命令执行失败: ${err && err.message ? err.message : err}`).catch(() => {});
        }
      })();
    }
    if (!res.writableEnded && !res.headersSent) sendJson(res, 200, {});
  }

  wireNotifications();

  return {
    bindGateway: (instance) => { gateway = instance; },
    handleWebhook,
    sendPrivate,
    apiTest,
    webhookUrl,
    runCommand,
    launchNapCat,
    maybeAutoLaunch,
    detectNapCatCommand: () => doDetect(),
    getLaunchState: () => ({ ...launchState }),
    // 一键安装器在宽限轮询探到登录时调用：拉起窗口可能已超时，直接标记在线并推送
    markLaunchOnline,
    adoptLoginAccount: applyFirstLogin,
    // 诊断/测试
    _formatNotification: formatNotification,
    _formatDuration: formatDuration,
    _commandFromEvent: commandFromEvent,
  };
}

module.exports = { createQqBot, detectNapCatCommand, syncNapCatConfig, formatDuration };
