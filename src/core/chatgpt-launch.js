'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  resolveChatGptExe,
  resolveChatGptAppId,
  packageFamilyFromPath,
  _internal: { execText },
} = require('./chatgpt-install.js');

const CHATGPT_IMAGE = 'ChatGPT.exe';
const DEFAULT_POLL_MS = 300;
const DEFAULT_EXIT_TIMEOUT_MS = 8000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15000;
const DEFAULT_TASKLIST_TIMEOUT_MS = 4000;
const DEFAULT_TASKKILL_TIMEOUT_MS = 8000;

/** 从实际可执行文件路径推导进程镜像名，兼容手动指定或改名的 ChatGPT.exe。 */
function imageNameFromPath(filePath) {
  const name = path.win32.basename(String(filePath || '').trim());
  return name || CHATGPT_IMAGE;
}

/**
 * 启动 ChatGPT 客户端。这里不结束已有进程，Windows 的单实例机制会把启动请求交给现有客户端。
 * @param {{ preferredPath?: string|null, resolveExe?: Function, resolveAppId?: Function,
 *           resolvedAppId?: string|null, spawnImpl?: Function, retryDelayMs?: number }} options
 * @returns {Promise<{ok:boolean, exe?:string, appId?:string, error?:string}>}
 */
async function launchChatGpt(options = {}) {
  const resolveExe = options.resolveExe || resolveChatGptExe;
  const resolveAppId = options.resolveAppId || resolveChatGptAppId;
  const spawnImpl = options.spawnImpl || spawn;
  const exe = await resolveExe({ preferredPath: options.preferredPath || null });
  if (!exe) return { ok: false, error: '找不到 ChatGPT.exe' };

  const packaged = !!packageFamilyFromPath(exe);
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 300;

  const start = (command, args, windowsHide, cwd) => new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide,
      ...(cwd ? { cwd } : {}),
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  // Shell activation requests the app's foreground window, including an existing tray instance.
  // 走应用入口而不是直接运行包内 exe：直接运行会丢失 MSIX 包身份，任务栏会显示成
  // 通用“文档”图标，客户端也可能拿不到包内资源。
  const hasResolvedAppId = Object.prototype.hasOwnProperty.call(options, 'resolvedAppId');
  let appId = hasResolvedAppId ? options.resolvedAppId : null;
  const appIdAttempts = hasResolvedAppId ? 0 : (packaged ? 2 : 1);
  for (let attempt = 1; attempt <= appIdAttempts; attempt += 1) {
    try {
      appId = await resolveAppId({ executablePath: exe });
    } catch {
      appId = null;
    }
    if (appId) break;
    // 登录初期开始菜单/AppX 可能还没就绪，给一次短暂的第二次机会。
    if (attempt < appIdAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  if (appId) {
    try {
      await start('explorer.exe', [`shell:AppsFolder\\${appId}`], true);
      return { ok: true, exe, appId };
    } catch (err) {
      // 包安装场景不能退回直接运行 exe：那会丢掉应用身份，正是“文档图标”的来源。
      if (packaged) return { ok: false, error: err.message };
    }
  } else if (packaged) {
    return {
      ok: false,
      error: '无法解析 ChatGPT 的 Windows 应用入口，请确认客户端安装完整后重试',
    };
  }

  try {
    await start(exe, [], false, path.win32.dirname(exe));
    return { ok: true, exe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 从 tasklist 的 CSV 输出里取出 ChatGPT 进程 PID。
 * 只认带引号的 `"ChatGPT.exe","1234",...` 行，避免把本地化提示文本当成进程。
 * @param {string} raw tasklist 输出
 * @param {string} [imageName] 进程镜像名
 * @returns {number[]} PID 列表
 */
function parseTasklistPids(raw, imageName = CHATGPT_IMAGE) {
  const escaped = String(imageName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^"${escaped}","(\\d+)"`, 'i');
  const pids = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * 查询当前正在运行的 ChatGPT 进程。
 * @param {{execText?: Function, imageName?: string}} [options]
 * @returns {Promise<number[]>} PID 列表；查询失败时返回空数组
 */
async function listChatGptPids(options = {}) {
  const run = options.execText || execText;
  const imageName = options.imageName || CHATGPT_IMAGE;
  const raw = await run(
    'tasklist.exe',
    ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
    DEFAULT_TASKLIST_TIMEOUT_MS,
  );
  return parseTasklistPids(raw, imageName);
}

/**
 * 结束所有 ChatGPT 进程（含其子进程）。
 * taskkill 在“没有找到进程”时会返回非零退出码，这里统一忽略。
 * @param {{execText?: Function, imageName?: string}} [options]
 * @returns {Promise<void>}
 */
async function killChatGpt(options = {}) {
  const run = options.execText || execText;
  const imageName = options.imageName || CHATGPT_IMAGE;
  await run(
    'taskkill.exe',
    ['/IM', imageName, '/F', '/T'],
    DEFAULT_TASKKILL_TIMEOUT_MS,
  );
}

/**
 * 轮询直到 check() 为真或超时。
 * now/sleep 可注入，测试里用假时钟即可不等待真实时间。
 */
async function waitFor(check, { timeoutMs, pollMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * 真正“重启” ChatGPT：先结束旧进程，等它退出，再用 Windows 应用入口重新唤起并确认新进程已出现。
 * 只 spawn exe 而不等进程切换，会让界面在客户端还没起来时就报告成功；直接运行包内 exe
 * 又会丢掉应用身份。这里把两件事一起做对。
 *
 * @param {{
 *   executablePath?: string|null,
 *   preferredPath?: string|null,
 *   resolveExe?: Function,
 *   resolveAppId?: Function,
 *   launch?: Function,
 *   listPids?: Function,
 *   kill?: Function,
 *   spawnImpl?: Function,
 *   execText?: Function,
 *   sleep?: Function,
 *   now?: Function,
 *   pollMs?: number,
 *   exitTimeoutMs?: number,
 *   launchTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ok:boolean, exe?:string, pid?:number, error?:string}>}
 */
async function relaunchChatGpt(options = {}) {
  const resolveExe = options.resolveExe || resolveChatGptExe;
  const resolveAppId = options.resolveAppId || resolveChatGptAppId;
  const launch = options.launch || launchChatGpt;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;
  const exitTimeoutMs = Number.isFinite(options.exitTimeoutMs)
    ? options.exitTimeoutMs
    : DEFAULT_EXIT_TIMEOUT_MS;
  const launchTimeoutMs = Number.isFinite(options.launchTimeoutMs)
    ? options.launchTimeoutMs
    : DEFAULT_LAUNCH_TIMEOUT_MS;

  let exe = String(options.executablePath || '').trim() || null;
  if (!exe) exe = await resolveExe({ preferredPath: options.preferredPath || null });
  if (!exe) return { ok: false, error: '找不到 ChatGPT.exe' };

  // 用实际解析到的 exe 名称结束/查找进程：不同电脑、不同安装方式下
  // 可执行文件不一定叫 ChatGPT.exe（手动选择的安装路径尤其如此）。
  const imageName = imageNameFromPath(exe);
  const listPids = options.listPids
    || (() => listChatGptPids({ execText: options.execText, imageName }));
  const kill = options.kill
    || (() => killChatGpt({ execText: options.execText, imageName }));

  // 先确认包安装的客户端有可用的应用入口，再结束旧进程。
  // 否则入口解析失败时会把用户正在用的 ChatGPT 关掉，却拉不起来。
  const packaged = !!packageFamilyFromPath(exe);
  let resolvedAppId;
  if (packaged) {
    try {
      resolvedAppId = await resolveAppId({ executablePath: exe });
    } catch {
      resolvedAppId = null;
    }
    if (!resolvedAppId) {
      return {
        ok: false,
        exe,
        error: '无法解析 ChatGPT 的 Windows 应用入口，未结束当前客户端。请确认客户端安装完整后重试',
      };
    }
  }

  const before = await listPids();
  await kill();

  // 等旧进程真正退出，避免新进程和正在退出的单实例锁撞车。
  const stopped = await waitFor(async () => {
    const current = await listPids();
    return current.every((pid) => !before.includes(pid));
  }, { timeoutMs: exitTimeoutMs, pollMs, sleep, now });
  if (!stopped) {
    return { ok: false, error: 'ChatGPT 没有退出，请手动关闭客户端后重试' };
  }

  const launched = await launch({
    preferredPath: exe,
    resolveExe: async () => exe,
    resolveAppId,
    spawnImpl: options.spawnImpl,
    ...(packaged ? { resolvedAppId } : {}),
  });
  if (!launched || !launched.ok) {
    return { ok: false, error: (launched && launched.error) || '启动 ChatGPT 失败' };
  }

  // explorer.exe 的 shell 激活是异步的：必须确认 ChatGPT.exe 真的起来了，才能算重启成功。
  let pid = null;
  const started = await waitFor(async () => {
    const current = await listPids();
    pid = current.find((item) => !before.includes(item)) || null;
    return pid !== null;
  }, { timeoutMs: launchTimeoutMs, pollMs, sleep, now });
  if (!started) {
    return { ok: false, error: '没有检测到重启后的 ChatGPT 进程，请手动打开客户端' };
  }

  return { ok: true, exe, pid, ...(launched.appId ? { appId: launched.appId } : {}) };
}

/**
 * 启动并确认 ChatGPT 进程真的出现。用于开机自启动这种没有界面反馈的场景：
 * explorer 的应用入口调用成功，并不代表客户端真的起来了。
 * @param {{
 *   executablePath?: string|null,
 *   preferredPath?: string|null,
 *   resolveExe?: Function,
 *   resolveAppId?: Function,
 *   launch?: Function,
 *   spawnImpl?: Function,
 *   listPids?: Function,
 *   execText?: Function,
 *   sleep?: Function,
 *   now?: Function,
 *   pollMs?: number,
 *   launchTimeoutMs?: number,
 *   retryDelayMs?: number,
 *   attempts?: number,
 * }} [options]
 * @returns {Promise<{ok:boolean, exe?:string, pid?:number, error?:string}>}
 */
async function launchChatGptAndVerify(options = {}) {
  const launch = options.launch || launchChatGpt;
  const resolveExe = options.resolveExe || resolveChatGptExe;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : 2;
  const launchTimeoutMs = Number.isFinite(options.launchTimeoutMs)
    ? options.launchTimeoutMs
    : DEFAULT_LAUNCH_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? options.retryDelayMs
    : 1500;

  // 先确定实际 exe，才能按正确的进程名做“是否真的起来了”的校验。
  // 登录初期 AppX/WindowsApps 可能还没就绪，找不到时也重试一次。
  let exe = String(options.executablePath || '').trim() || null;
  if (!exe) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        exe = await resolveExe({ preferredPath: options.preferredPath || null });
      } catch {
        exe = null;
      }
      if (exe) break;
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  if (!exe) return { ok: false, error: '找不到 ChatGPT.exe' };
  const imageName = imageNameFromPath(exe);
  const listPids = options.listPids
    || (() => listChatGptPids({ execText: options.execText, imageName }));

  const before = await listPids();
  let lastError = '启动 ChatGPT 失败';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const launched = await launch({
      preferredPath: exe,
      resolveExe: async () => exe,
      resolveAppId: options.resolveAppId,
      spawnImpl: options.spawnImpl,
    });
    if (!launched || !launched.ok) {
      lastError = (launched && launched.error) || lastError;
    } else {
      const started = await waitFor(async () => {
        const current = await listPids();
        // 已在运行时，应用入口激活会复用现有进程；只要进程还在就算成功。
        if (before.length) return current.length > 0;
        return current.some((pid) => !before.includes(pid));
      }, { timeoutMs: launchTimeoutMs, pollMs, sleep, now });
      if (started) {
        const current = await listPids();
        const pid = current.find((item) => !before.includes(item)) || current[0] || null;
        return { ...launched, exe, pid };
      }
      lastError = '没有检测到 ChatGPT 进程';
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { ok: false, error: lastError };
}

module.exports = {
  launchChatGpt,
  launchChatGptAndVerify,
  relaunchChatGpt,
  parseTasklistPids,
  listChatGptPids,
  killChatGpt,
};
