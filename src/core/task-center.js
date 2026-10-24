'use strict';
/**
 * 任务中心：统一跟踪两类「Codex 任务」，供 QQ 远程助手查询、通知与控制。
 *
 *  - gateway 任务：ChatGPT 桌面端经本地网关的一次对话轮。只能观察和停止：
 *    每个请求都携带全量 transcript（见 spec 2.4，客户端从不发 previous_response_id），
 *    「最后一项是新的 user 消息」= 新任务开始；响应完成且不含工具调用 = 任务完成；
 *    HTTP 499 = 用户在客户端手动中断；失败后客户端会原样重试，重试归并为同一任务。
 *  - exec 任务：本模块用 `codex exec --json` 拉起的真实 Codex 运行，完全可控：
 *    可停止（结束进程树）、插入新要求（运行中排队，结束后用 `codex exec resume` 续跑）、
 *    发布新任务。
 *
 * 纯 Node CommonJS，不依赖 Electron；now/spawnImpl 可注入，方便 node --test。
 * 通知不在这里发：任务中心只 emit('notify', {kind, task})，由 qq-bot 负责格式化与发送。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveChatGptExe } = require('./chatgpt-install.js');

const TICK_MS = 30 * 1000;
/** 运行中的 gateway 任务超过该时长没有新请求：按已结束处理并通知。 */
const STALE_RUNNING_MS = 10 * 60 * 1000;
/** 失败后客户端放弃重试的判定窗口：超过该时长没有新请求按失败收口。 */
const STALE_FAILING_MS = 3 * 60 * 1000;
/** 手动停止后同一轮次的冷却窗口：窗口内客户端的重试不再重新建任务。 */
const STOP_COOLDOWN_MS = 90 * 1000;
const HISTORY_LIMIT = 60;
const TITLE_LIMIT = 60;
const TEXT_LIMIT = 400;

function shortId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  const value = oneLine(text);
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** 取 Responses 请求里最后一条 user 消息文本（即最新输入的提示词）。 */
function lastUserText(body) {
  const input = Array.isArray(body && body.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || item.type !== 'message' || item.role !== 'user') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

/** 一轮对话的稳定 key：instructions 前缀 + 最后一条 user 消息。重试/工具轮回合同 key。 */
function turnKeyOf(body) {
  const instructions = String((body && body.instructions) || '').slice(0, 4000);
  return sha1(instructions + '\u001f' + lastUserText(body));
}

/**
 * 识别客户端自动发起的「会话标题生成」请求：不算任务、不通知。
 * 客户端把起名指令（以 "You are a helpful assistant." 开头并要求输出 title JSON）
 * 作为最后一条 user 消息或 instructions 发来，与真人提问混在一起，只能按内容区分。
 */
function isTitleGenBody(body) {
  const texts = [
    String((body && body.instructions) || ''),
    lastUserText(body),
  ];
  return texts.some((text) => /^you are a helpful assistant\./i.test(text) && /\btitle\b/i.test(text));
}

/** 隐藏执行一个文本命令，超时返回空字符串。 */
function execTextImpl(command, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(output.trim()); });
  });
}

/**
 * @param {{ store: any, log?: (e:any)=>void, now?: ()=>number,
 *           spawnImpl?: Function, execText?: Function }} deps
 */
function createTaskCenter(deps = {}) {
  const { store, log = () => {} } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const spawnImpl = typeof deps.spawnImpl === 'function' ? deps.spawnImpl : spawn;
  const execText = typeof deps.execText === 'function' ? deps.execText : execTextImpl;

  /** @type {Map<string, any>} id -> 运行中任务 */
  const running = new Map();
  /** @type {any[]} 最近结束的任务（含被 resume 续跑过的 exec 任务快照前仍保留对象） */
  const history = [];
  const allById = new Map();
  /** @type {Map<string, {turnKey:string, abort:()=>void}>} requestId -> 在途请求的断开句柄 */
  const activeRequests = new Map();
  /** @type {Map<string, number>} turnKey -> 停止时间（冷却窗口内忽略同 key 重试） */
  const stoppedCooldown = new Map();
  const listeners = new Set();
  let ticker = null;
  let codexCache = null;
  let codexCacheAt = 0;

  function emit(type, payload) {
    for (const cb of listeners) {
      try { cb(type, payload); } catch { /* 订阅方异常不影响任务中心 */ }
    }
  }

  function snapshot(task) {
    return {
      id: task.id,
      kind: task.kind,
      title: task.title,
      model: task.model,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt || null,
      lastSeenAt: task.lastSeenAt || null,
      rounds: task.rounds,
      tokens: task.tokens || null,
      cwd: task.cwd || null,
      sessionId: task.sessionId || null,
      pid: task.pid || null,
      queued: task.kind === 'exec' ? (task.queue || []).length : 0,
      lastText: task.lastText || '',
      lastError: task.lastError || null,
    };
  }

  function finish(task, status, error) {
    if (!running.has(task.id)) return;
    running.delete(task.id);
    task.status = status;
    task.endedAt = now();
    if (error) task.lastError = String(error).slice(0, 300);
    history.push(task);
    if (history.length > HISTORY_LIMIT) {
      const dropped = history.splice(0, history.length - HISTORY_LIMIT);
      for (const old of dropped) allById.delete(old.id);
    }
    if (status === 'stopped' && task.kind === 'gateway') {
      stoppedCooldown.set(task.turnKey, now());
      if (stoppedCooldown.size > 200) {
        const cutoff = now() - STOP_COOLDOWN_MS;
        for (const [key, at] of stoppedCooldown) if (at < cutoff) stoppedCooldown.delete(key);
      }
    }
    emit('notify', { kind: status, task: snapshot(task) });
  }

  // -----------------------------------------------------------------------
  // gateway 侧观察（由 gateway/server.js 调用）
  // -----------------------------------------------------------------------

  /** 新的 /responses 请求。返回 { turnKey } 供 requestStarted/turnResponse 使用。 */
  function turnRequest({ body, slug } = {}) {
    if (!body || !Array.isArray(body.input) || body.input.length === 0) return null;
    if (isTitleGenBody(body)) return null;
    const turnKey = turnKeyOf(body);
    const stoppedAt = stoppedCooldown.get(turnKey);
    if (stoppedAt != null && now() - stoppedAt < STOP_COOLDOWN_MS) return null;
    for (const task of running.values()) {
      if (task.kind !== 'gateway' || task.turnKey !== turnKey) continue;
      task.rounds += 1;
      task.lastSeenAt = now();
      task.failing = false;
      return { turnKey };
    }
    const task = {
      id: shortId('g'),
      kind: 'gateway',
      turnKey,
      title: truncate(lastUserText(body), TITLE_LIMIT) || '未命名任务',
      model: String(slug || ''),
      status: 'running',
      startedAt: now(),
      lastSeenAt: now(),
      lastNotifyAt: now(),
      rounds: 1,
      tokens: 0,
      lastText: '',
      lastError: null,
    };
    running.set(task.id, task);
    allById.set(task.id, task);
    return { turnKey };
  }

  /** 一次 /responses 的终结结果（ok/status 取自网关的 final 日志）。 */
  function turnResponse({ body, slug, ok, status, hasToolCalls, text } = {}) {
    if (!body) return;
    const turnKey = turnKeyOf(body);
    let task = null;
    for (const item of running.values()) {
      if (item.kind === 'gateway' && item.turnKey === turnKey) { task = item; break; }
    }
    if (!task) return;
    task.lastSeenAt = now();
    if (text) task.lastText = truncate(text, TEXT_LIMIT);
    if (slug && !task.model) task.model = String(slug);
    const statusCode = Number(status);
    if (Number.isFinite(statusCode) && statusCode === 200) task.failing = false;
    if (ok === true && statusCode === 200) {
      if (!hasToolCalls) {
        finish(task, 'done', null);
      }
      return; // 含工具调用：客户端执行完工具还会发下一条请求，任务继续
    }
    if (statusCode === 499 || task.stopRequested) {
      finish(task, 'stopped', null);
      return;
    }
    // 其它失败：客户端可能原样重试（spec 2.4），不立即收口，交给 stale sweep。
    task.failing = true;
    task.lastError = `HTTP ${statusCode || '???'}`;
  }

  /** 网关在途请求注册（用于「停止」时断开上游流）。 */
  function requestStarted({ turnKey, requestId, abort } = {}) {
    if (!turnKey || !requestId || typeof abort !== 'function') return;
    activeRequests.set(requestId, { turnKey, abort });
  }

  function requestFinished({ requestId } = {}) {
    activeRequests.delete(requestId);
  }

  function stopGatewayTask(task) {
    task.stopRequested = true;
    let aborted = 0;
    for (const [, entry] of activeRequests) {
      if (entry.turnKey !== task.turnKey) continue;
      aborted += 1;
      try { entry.abort(); } catch { /* ignore */ }
    }
    if (aborted === 0) {
      // 请求间隙（工具执行中）：直接按停止收口，不再等下一轮请求。
      finish(task, 'stopped', null);
    }
    // 断开的请求会以失败走 turnResponse，并因 stopRequested 立即标记为 stopped。
  }

  // -----------------------------------------------------------------------
  // exec 任务（codex exec）
  // -----------------------------------------------------------------------

  /**
   * 解析可用的 codex 可执行文件：配置显式路径 > ChatGPT 内置 > npm 全局 > PATH。
   * @returns {Promise<{path:string, source:string}>}
   */
  async function resolveCodex() {
    const cfg = store.get();
    const configured = String(cfg.qqbot?.codexPath || '').trim();
    if (configured) {
      if (fs.existsSync(configured)) return { path: configured, source: 'config' };
      throw new Error(`配置的 codex 路径不存在: ${configured}`);
    }
    if (codexCache && now() - codexCacheAt < 60 * 1000) return codexCache;

    let found = null;
    try {
      const exe = await resolveChatGptExe({ preferredPath: cfg.chatgpt?.executablePath || null });
      if (exe) {
        const appDir = path.win32.dirname(exe);
        const pkgDir = path.win32.dirname(appDir);
        for (const candidate of [
          path.win32.join(appDir, 'resources', 'codex.exe'),
          path.win32.join(pkgDir, 'resources', 'codex.exe'),
          path.win32.join(appDir, 'codex.exe'),
        ]) {
          if (fs.existsSync(candidate)) { found = { path: candidate, source: 'chatgpt' }; break; }
        }
      }
    } catch { /* 继续候选 */ }
    if (!found && process.env.APPDATA) {
      const candidate = path.join(
        process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex',
        'node_modules', '@openai', 'codex-win32-x64',
        'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
      );
      if (fs.existsSync(candidate)) found = { path: candidate, source: 'npm' };
    }
    if (!found) {
      const raw = await execText('where.exe', ['codex']);
      const lines = String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const exeHit = lines.find((line) => /\.exe$/i.test(line));
      if (exeHit) found = { path: exeHit, source: 'path' };
      else {
        const shim = lines.find((line) => /\.(cmd|bat)$/i.test(line));
        if (shim) found = { path: shim, source: 'path-shim' };
      }
    }
    if (!found) throw new Error('找不到 codex 可执行文件，请在设置里手动指定 codex.exe 路径');
    codexCache = found;
    codexCacheAt = now();
    return found;
  }

  function handleExecEvent(task, event) {
    if (!event || typeof event !== 'object') return;
    if (typeof event.thread_id === 'string' && event.thread_id) task.sessionId = event.thread_id;
    if (typeof event.session_id === 'string' && event.session_id && !task.sessionId) task.sessionId = event.session_id;
    const type = String(event.type || '');
    if (type === 'item.completed' && event.item && event.item.type === 'agent_message') {
      task.lastText = truncate(event.item.text, TEXT_LIMIT);
    } else if (type === 'turn.completed') {
      task.turnDone = true;
      const total = Number(event.usage && event.usage.total_tokens);
      if (Number.isFinite(total) && total > 0) task.tokens = (task.tokens || 0) + total;
    } else if (type === 'turn.failed') {
      task.turnError = (event.error && event.error.message) || 'codex 报告 turn.failed';
    } else if (type === 'error') {
      task.lastError = truncate((event.error && event.error.message) || event.message, 300);
    }
  }

  function killTree(pid) {
    if (process.platform === 'win32') {
      try {
        const killer = spawnImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        if (killer && typeof killer.unref === 'function') killer.unref();
      } catch { /* ignore */ }
      return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }

  /**
   * 拉起（或续跑）一个 exec 任务。prompt 追加为最后一轮的用户输入。
   * @param {any} task
   * @param {{ prompt: string, resume: boolean, cwd: string }} options
   */
  async function spawnExecTurn(task, { prompt, resume, cwd }) {
    const resolved = await resolveCodex();
    const args = ['exec'];
    if (resume) {
      args.push('resume');
      if (task.sessionId) args.push(task.sessionId);
      else args.push('--last');
    }
    args.push('--json', '--skip-git-repo-check', '--sandbox', 'workspace-write');
    args.push(String(prompt));

    task.status = 'running';
    task.startedAt = now();
    task.lastSeenAt = now();
    task.lastNotifyAt = now();
    task.rounds += 1;
    task.turnDone = false;
    task.turnError = null;
    task.lastError = null;
    task.lastText = '';
    running.set(task.id, task);

    let child;
    // stdin 必须是 ignore：codex exec 见到未关闭的管道 stdin 会一直等输入，
    // 任务就永远停在「进行中」（stdio 缺省三路全 pipe，stdin 无人写也不关）。
    const spawnOpts = { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (/\.(cmd|bat)$/i.test(resolved.path)) {
      child = spawnImpl('cmd.exe', ['/d', '/s', '/c', resolved.path, ...args], spawnOpts);
    } else {
      child = spawnImpl(resolved.path, args, spawnOpts);
    }
    task.pid = child.pid || null;
    task.execPath = resolved.path;

    let stdoutBuffer = '';
    let stderrTail = '';
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (!line) continue;
        try { handleExecEvent(task, JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-600);
    });
    child.on('error', (err) => {
      task.turnError = `无法启动 codex: ${err.message}`;
    });
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        try { handleExecEvent(task, JSON.parse(stdoutBuffer.trim())); } catch { /* 尾行残缺 */ }
      }
      if (task.status !== 'running') return; // 已被 stop 收口
      if (task.stopRequested) {
        task.queue = [];
        finish(task, 'stopped', null);
        return;
      }
      if (task.turnError) {
        finish(task, 'failed', task.turnError);
        return;
      }
      if (task.turnDone) {
        finish(task, 'done', null);
        drainQueue(task);
        return;
      }
      finish(task, 'failed', `codex 进程退出（代码 ${code ?? '?'}）${stderrTail ? ': ' + oneLine(stderrTail).slice(0, 200) : ''}`);
    });
    log({ level: 'info', msg: `QQ 远程任务 ${task.id} 已${resume ? '续跑' : '启动'}: ${truncate(prompt, 80)}（${resolved.source}）` });
    return task;
  }

  function drainQueue(task) {
    if (!task.queue || task.queue.length === 0 || task.stopRequested) return;
    const next = task.queue.shift();
    spawnExecTurn(task, { prompt: next, resume: true, cwd: task.cwd })
      .catch((err) => log({ level: 'error', msg: `QQ 远程任务 ${task.id} 续跑失败: ${err.message}` }));
  }

  /** 发布新的 codex exec 任务。 */
  async function startExecTask({ prompt, cwd } = {}) {
    const text = String(prompt || '').trim();
    if (!text) throw new Error('任务描述不能为空');
    const cfg = store.get();
    const dir = String(cwd || cfg.qqbot?.workspaceDir || '').trim() || require('node:os').homedir();
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw new Error(`工作目录不存在: ${dir}`);
    }
    if (!stat.isDirectory()) throw new Error(`工作目录不是文件夹: ${dir}`);

    const task = {
      id: shortId('e'),
      kind: 'exec',
      title: truncate(text, TITLE_LIMIT),
      model: 'codex exec',
      status: 'running',
      startedAt: now(),
      lastSeenAt: now(),
      rounds: 0,
      tokens: 0,
      queue: [],
      cwd: dir,
      sessionId: null,
      pid: null,
      lastText: '',
      lastError: null,
    };
    running.set(task.id, task);
    allById.set(task.id, task);
    await spawnExecTurn(task, { prompt: text, resume: false, cwd: dir });
    return { task: snapshot(task) };
  }

  /** 给任务插入新要求：运行中排队，已结束则用 exec resume 续跑。 */
  async function followUp(id, text) {
    const task = allById.get(String(id || '').trim());
    if (!task) throw new Error(`任务不存在: ${id}`);
    const message = String(text || '').trim();
    if (!message) throw new Error('插入的内容不能为空');
    if (task.kind === 'gateway') {
      throw new Error('桌面端会话只能查看或停止，不能插入新要求；插入请针对 e_ 开头的 QQ 任务');
    }
    if (running.has(task.id)) {
      task.queue.push(message);
      return { queued: true, position: task.queue.length, task: snapshot(task) };
    }
    await spawnExecTurn(task, { prompt: message, resume: true, cwd: task.cwd });
    return { queued: false, task: snapshot(task) };
  }

  /** 停止任务：gateway 任务断开在途请求；exec 任务结束进程树。 */
  function stopTask(id) {
    const task = allById.get(String(id || '').trim());
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (!running.has(task.id)) throw new Error('任务已结束');
    if (task.kind === 'gateway') {
      stopGatewayTask(task);
      return { task: snapshot(task), status: 'stopped' };
    }
    task.stopRequested = true;
    task.queue = [];
    if (task.pid) killTree(task.pid);
    finish(task, 'stopped', null);
    return { task: snapshot(task), status: 'stopped' };
  }

  // -----------------------------------------------------------------------
  // 查询 / 定时器
  // -----------------------------------------------------------------------

  function listTasks() {
    const runningList = [...running.values()].map(snapshot);
    const recent = history.slice(-8).reverse().map(snapshot);
    return { running: runningList, recent, at: now() };
  }

  function tick() {
    const t = now();
    const cfg = store.get();
    const intervalMs = Math.max(1, Number(cfg.qqbot?.progressMinutes) || 5) * 60 * 1000;
    for (const task of [...running.values()]) {
      if (t - task.startedAt >= intervalMs && t - (task.lastNotifyAt || task.startedAt) >= intervalMs) {
        task.lastNotifyAt = t;
        emit('notify', { kind: 'progress', task: snapshot(task) });
      }
      if (task.kind === 'gateway') {
        const idle = t - (task.lastSeenAt || task.startedAt);
        if (task.failing && idle > STALE_FAILING_MS) {
          finish(task, 'failed', task.lastError || '上游连续失败');
        } else if (idle > STALE_RUNNING_MS) {
          finish(task, 'stale', null);
        }
      }
    }
  }

  function start() {
    if (ticker) return;
    ticker = setInterval(() => {
      try { tick(); } catch (err) { log({ level: 'error', msg: `任务中心 tick 失败: ${err.message}` }); }
    }, TICK_MS);
    if (typeof ticker.unref === 'function') ticker.unref();
  }

  /** 应用退出时调用：结束所有 exec 子进程，停定时器（不发通知）。 */
  function stop() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    for (const task of [...running.values()]) {
      if (task.kind === 'exec' && task.pid) killTree(task.pid);
      running.delete(task.id);
    }
    activeRequests.clear();
  }

  function on(type, cb) {
    if (typeof cb !== 'function') return () => {};
    const wrapped = (t, payload) => { if (t === type) cb(payload); };
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  }

  return {
    turnRequest,
    turnResponse,
    requestStarted,
    requestFinished,
    resolveCodex,
    startExecTask,
    followUp,
    stopTask,
    listTasks,
    start,
    stop,
    tick,
    on,
    // 诊断用
    _activeRequestCount: () => activeRequests.size,
  };
}

module.exports = { createTaskCenter, lastUserText, turnKeyOf, isTitleGenBody };
