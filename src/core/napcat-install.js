'use strict';
/**
 * NapCat 一键安装器：把「装 QQ 桌面版 + 装 NapCat + 配置 + 拉起」串成一个状态机。
 *
 * 流程（phase）：
 *   prepare → qq-check →（未装 QQ 时）qq-download → qq-install →
 *   napcat-download → extract → configure → launch（等扫码/上线）→ done | failed
 *
 * 关键事实（决定实现方式）：
 * - NapCat Shell 版（GitHub NapNeko/NapCatQQ 的 NapCat.Shell.zip，约 36MB）需要本机
 *   已安装 QQ NT 桌面版；launcher-user.bat 从注册表
 *   HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ 找 QQ.exe。
 * - QQ 官网下载按钮的数据源是「彩虹配置」JS（永远返回最新版直链），x64 直链在
 *   ntDownloadX64Url；qqdl.gtimg.cn 不可达时换 dldir1.qq.com（同路径不同 host）。
 * - QQ 安装器是 NSIS，/S 静默安装（会弹一次 UAC）；装完注册表出现 QQ 键。
 * - zip 解压用 Windows 内置 bsdtar（System32\tar.exe，Win10 1803+ 自带），无新依赖。
 * 纯 Node CommonJS，fetch/spawn/注册表查询均可注入，方便 node --test。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createWebUiClient, ensureWebUiConfig } = require('./napcat-webui.js');
const { qrPngDataUrl } = require('./qr-code.js');

// QQ 官网（im.qq.com/pcqq）下载按钮背后的彩虹配置端点：永远返回最新版 Windows 直链。
const QQ_RAINBOW_CONFIG_URL = 'https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/windowsConfig.js';
/** QQ CDN 备用 host：qqdl.gtimg.cn 不可达（地区拦截等）时按顺序换用，路径不变。 */
const QQ_CDN_HOSTS = ['qqdl.gtimg.cn', 'dldir1.qq.com'];
const NAPCAT_ZIP_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip';
/** GitHub 直连不稳时的镜像（前缀拼接，仅用于 release 资产加速）。 */
const NAPCAT_MIRROR_PREFIXES = ['https://ghproxy.net/'];

const DOWNLOAD_TIMEOUT_MS = 120 * 1000;   // 单次下载「无进度」超时：有新数据就续命
const DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 单文件上限 2GB（QQ 安装包约 300MB）
const QQ_INSTALL_WAIT_MS = 10 * 60 * 1000; // QQ 静默安装最长等待（含 UAC 确认时间）
const QQ_REG_POLL_MS = 2000;
const WEBUI_PORT = 6099;                   // NapCat WebUI 默认端口（安装时固定写入）
const WEBUI_BOOT_WAIT_MS = 45 * 1000;      // 拉起后等 WebUI 就绪的窗口
const WEBUI_POLL_MS = 2000;
const QR_POLL_MS = 2000;
const LAUNCH_WAIT_MS = 10 * 60 * 1000;     // 拉起后等扫码登录上线的窗口

const QQ_UNINSTALL_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ';
const NAPCAT_DIR_NAME = 'NapCat';

/** 安装目录：%LOCALAPPDATA%\NapCat（detectNapCatCommand 的候选路径之一）。 */
function defaultInstallDir(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, NAPCAT_DIR_NAME);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 执行命令并收集 stdout（文本），失败/超时返回 ''。reg query / tar 之类的一次性命令用。 */
function execCapture(command, args, { timeoutMs = 15000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (child.stdout) child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/** 运行外部命令直到退出；返回 {code}。spawn 即失败返回 {code: -1, error}。 */
function execWait(command, args, opts, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: false, ...opts });
    } catch (err) {
      resolve({ code: -1, error: err && err.message ? err.message : String(err) });
      return;
    }
    child.on('error', (err) => resolve({ code: -1, error: err && err.message ? err.message : String(err) }));
    child.on('close', (code) => resolve({ code: code == null ? 0 : code }));
  });
}

// ---------------------------------------------------------------------------
// QQ 检测 / 安装
// ---------------------------------------------------------------------------

/** reg query 输出里取 REG_SZ 值：`    UninstallString    REG_SZ    C:\...\Uninstall.exe` */
function parseRegSz(raw, valueName) {
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${valueName}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$`, 'i').exec(line);
    if (match) return match[1].trim();
  }
  return '';
}

/** 读注册表字符串值；键不存在或失败返回 ''。 */
async function readRegistryString({ key, value, execCaptureImpl = execCapture }) {
  const out = await execCaptureImpl('reg.exe', ['query', key, '/v', value]);
  return parseRegSz(out, value);
}

/**
 * 检测本机 QQ NT 安装：优先注册表（NapCat launcher 用同一个键），失败时按常见
 * 安装目录猜。返回 { qqExe } 或 null。
 */
async function findQqInstall({ execCaptureImpl = execCapture, env = process.env } = {}) {
  const uninstall = await readRegistryString({ key: QQ_UNINSTALL_KEY, value: 'UninstallString', execCaptureImpl });
  const fromDir = (dir) => {
    const qqExe = path.join(String(dir || '').trim(), 'QQ.exe');
    return fs.existsSync(qqExe) ? { qqExe } : null;
  };
  if (uninstall) {
    const dir = path.dirname(uninstall.replace(/^"|"$/g, ''));
    const found = fromDir(dir);
    if (found) return found;
  }
  const candidates = env.ProgramFiles
    ? [path.join(env.ProgramFiles, 'Tencent', 'QQNT')]
    : ['C:\\Program Files\\Tencent\\QQNT'];
  for (const dir of candidates) {
    const found = fromDir(dir);
    if (found) return found;
  }
  return null;
}

/** 彩虹配置（JSONP 风格 JS）→ { url, version, fallbacks }；解析失败返回 null。 */
function parseRainbowConfig(text) {
  const raw = String(text || '');
  const pick = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(raw);
    return m ? m[1] : '';
  };
  const url = pick('ntDownloadX64Url');
  if (!/^https?:\/\//i.test(url)) return null;
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  // 只对 QQ 官方 CDN 做备用 host 替换；其它来源（测试/自定义镜像）按原样使用
  const fallbacks = QQ_CDN_HOSTS.includes(host)
    ? QQ_CDN_HOSTS.map((item) => url.replace(/^https?:\/\/[^/]+/i, `https://${item}`))
    : [url];
  return { url, version: pick('version'), fallbacks };
}

/** 取 QQ 最新版安装包下载地址（依次试 host）。configUrl 可注入供测试。 */
async function resolveQqInstallerUrl({ fetchImpl, configUrl = QQ_RAINBOW_CONFIG_URL } = {}) {
  const res = await fetchImpl(configUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`QQ 下载配置请求失败: HTTP ${res.status}`);
  const text = await res.text();
  const parsed = parseRainbowConfig(text);
  if (!parsed) throw new Error('QQ 下载配置格式异常，取不到最新版安装包地址');
  return parsed;
}

// ---------------------------------------------------------------------------
// 下载与解压
// ---------------------------------------------------------------------------

/**
 * 流式下载到文件。带 content-length 时回调进度（0-100）；60/120 秒无新数据视为
 * 卡死中断（NetworkError 场景比硬超时更常见）。返回 { bytes, url }。
 */
async function downloadTo(url, destPath, { fetchImpl, onProgress = () => {} } = {}) {
  // 无进度看门狗：每收到数据 refresh；fetch 挂 signal，卡死的连接能被真正中断
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('下载长时间无进度，已中断')), DOWNLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`下载失败: HTTP ${res.status}（${new URL(url).host}）`);
  }
  const total = Number(res.headers && res.headers.get ? res.headers.get('content-length') : '') || 0;
  try {
    const out = fs.createWriteStream(destPath);
    let received = 0;
    let lastTick = 0;
    try {
      if (!res.body || typeof res.body.getReader !== 'function') {
        // 运行时不支持流式读取（少见）：整体载入内存兜底
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > DOWNLOAD_MAX_BYTES) throw new Error('下载内容超过大小限制');
        out.write(buffer);
        received = buffer.length;
        onProgress(100, received, buffer.length);
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          received += chunk.length;
          if (received > DOWNLOAD_MAX_BYTES) throw new Error('下载内容超过大小限制');
          if (timer) timer.refresh();
          out.write(chunk);
          const now = Date.now();
          if (now - lastTick >= 200) {
            lastTick = now;
            onProgress(total ? Math.min(99, Math.floor((received / total) * 100)) : 0, received, total);
          }
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    onProgress(100, received, total || received);
    return { bytes: received, url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 依次尝试候选 URL 下载（镜像回退），全部失败抛最后一个错误。 */
async function downloadWithFallback(urls, destPath, { fetchImpl, onProgress, describe }) {
  let lastError = null;
  for (const url of urls) {
    try {
      const result = await downloadTo(url, destPath, { fetchImpl, onProgress });
      return { ...result, sourceUrl: url };
    } catch (err) {
      lastError = err;
      try { fs.rmSync(destPath, { force: true }); } catch { /* 忽略清理失败 */ }
    }
  }
  throw new Error(`${describe}全部下载源失败：${lastError && lastError.message ? lastError.message : '未知错误'}`);
}

/**
 * 用 Windows 内置 bsdtar 解压 zip 到目标目录。非 Windows 或 tar 缺失直接报错
 * （提示手动解压），不引入任何新依赖。
 */
async function extractZip(zipPath, destDir, { spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('一键安装目前只支持 Windows；请手动解压 NapCat.Shell.zip');
  }
  const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  fs.mkdirSync(destDir, { recursive: true });
  const { code, error } = await execWait(tarExe, ['-xf', zipPath, '-C', destDir], { windowsHide: true }, { spawnImpl });
  if (error) throw new Error(`解压工具启动失败（缺少 System32\\tar.exe？）：${error}；可手动解压 ${zipPath}`);
  if (code !== 0) throw new Error(`解压失败（tar 退出码 ${code}）；可手动解压 ${zipPath}`);
}

/**
 * 静默安装 QQ（NSIS /S）。等安装器退出后轮询注册表键确认装好。
 * @returns {Promise<{qqExe: string}>}
 */
async function installQqSilently(setupExe, { spawnImpl = spawn, execCaptureImpl = execCapture, waitMs = QQ_INSTALL_WAIT_MS } = {}) {
  const { code, error } = await execWait(setupExe, ['/S'], { windowsHide: false }, { spawnImpl });
  // UAC 被拒绝时安装器以非零退出（常见 1223/1602）；nsis 失败码统一给可读提示
  if (error) throw new Error(`QQ 安装器启动失败: ${error}`);
  if (code !== 0) throw new Error(`QQ 安装器退出码 ${code}（若没点系统确认(UAC)请重试并在弹窗里选「是」）`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await findQqInstall({ execCaptureImpl });
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, QQ_REG_POLL_MS));
  }
  throw new Error('QQ 静默安装超时：请手动完成 QQ 安装后重试');
}

// ---------------------------------------------------------------------------
// 安装状态机
// ---------------------------------------------------------------------------

/** phase → 界面阶段文案（渲染层也有一份，这里供日志与调试）。 */
const PHASE_LABEL = {
  idle: '未开始',
  prepare: '准备安装',
  'qq-check': '检测本机 QQ',
  'qq-download': '下载 QQ 安装包',
  'qq-install': '静默安装 QQ',
  'napcat-download': '下载 NapCat',
  extract: '解压 NapCat',
  configure: '写入配置',
  launch: '启动并等待扫码',
  done: '安装完成',
  failed: '安装失败',
};

/**
 * @param {{ store: any, qqBot: any, log?: (e:any)=>void, onEvent?: (s:any)=>void,
 *           fetchImpl?: typeof fetch, spawnImpl?: Function, execCaptureImpl?: Function,
 *           installDir?: string, webuiPort?: number, webuiToken?: string,
 *           rainbowConfigUrl?: string, napcatZipUrl?: string, now?: ()=>number }} deps
 */
function createNapCatInstaller(deps = {}) {
  const { store, qqBot, log = () => {}, onEvent = () => {} } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const doFetch = deps.fetchImpl == null ? globalThis.fetch : deps.fetchImpl;
  const doSpawn = typeof deps.spawnImpl === 'function' ? deps.spawnImpl : spawn;
  const doExecCapture = typeof deps.execCaptureImpl === 'function' ? deps.execCaptureImpl : execCapture;
  const webuiPollMs = Number.isFinite(deps.webuiPollMs) ? Math.max(1, deps.webuiPollMs) : WEBUI_POLL_MS;
  const qrPollMs = Number.isFinite(deps.qrPollMs) ? Math.max(1, deps.qrPollMs) : QR_POLL_MS;
  const installDir = deps.installDir || defaultInstallDir();
  /** @type {{phase:string, percent:number, detail:string, error:string, at:number, account:string,
   *          qrImage:string, loginPhase:string}} */
  let installState = { phase: 'idle', percent: 0, detail: '', error: '', at: 0, account: '', qrImage: '', loginPhase: '' };
  let installInFlight = null;
  let lastQrcodeUrl = '';
  /** 事件节流：phase/detail/loginPhase/qrImage 变化或 percent 步进 ≥1 才推送。 */
  let lastEmitted = '';

  function setPhase(phase, { percent = 0, detail = '', error = '', account = '', qrImage = '', loginPhase = '' } = {}) {
    installState = {
      phase,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      detail,
      error,
      account,
      qrImage,
      loginPhase,
      at: now(),
    };
    const key = `${installState.phase}|${installState.percent}|${installState.detail}|${installState.loginPhase}|${installState.qrImage ? 1 : 0}`;
    if (key !== lastEmitted) {
      lastEmitted = key;
      try { onEvent({ ...installState }); } catch { /* 推送失败不影响安装 */ }
    }
    return installState;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 下载 QQ 安装包并静默安装，返回 { qqExe }。 */
  async function ensureQqInstalled() {
    setPhase('qq-check', { detail: '检测本机 QQ…' });
    const existing = await findQqInstall({ execCaptureImpl: doExecCapture });
    if (existing) {
      log({ level: 'info', msg: `一键安装：检测到本机 QQ（${existing.qqExe}），跳过 QQ 安装` });
      setPhase('qq-check', { percent: 100, detail: `已检测到 QQ：${existing.qqExe}` });
      return existing;
    }
    setPhase('qq-download', { detail: '获取 QQ 最新版下载地址…' });
    const rainbow = await resolveQqInstallerUrl({ fetchImpl: doFetch, configUrl: deps.rainbowConfigUrl });
    log({ level: 'info', msg: `一键安装：QQ 最新版 ${rainbow.version || '未知版本'}，开始下载` });
    const setupPath = path.join(os.tmpdir(), `gptplus-qq-setup-${Date.now()}.exe`);
    try {
      await downloadWithFallback(rainbow.fallbacks, setupPath, {
        fetchImpl: doFetch,
        describe: 'QQ 安装包',
        onProgress: (percent, received) => setPhase('qq-download', {
          percent,
          detail: `下载 QQ ${rainbow.version || ''}（${(received / 1024 / 1024).toFixed(0)} MB）`,
        }),
      });
      setPhase('qq-install', { percent: 10, detail: '正在静默安装 QQ（请在系统弹窗里点「是」）…' });
      const installed = await installQqSilently(setupPath, { spawnImpl: doSpawn, execCaptureImpl: doExecCapture });
      setPhase('qq-install', { percent: 100, detail: `QQ 已安装：${installed.qqExe}` });
      log({ level: 'info', msg: `一键安装：QQ 静默安装完成（${installed.qqExe}）` });
      return installed;
    } finally {
      try { fs.rmSync(setupPath, { force: true }); } catch { /* 清理失败不影响 */ }
    }
  }

  /** 下载并解压 NapCat 到 installDir，返回启动脚本路径。 */
  async function downloadAndExtractNapCat() {
    const zipUrl = deps.napcatZipUrl || NAPCAT_ZIP_URL;
    // 官方 GitHub 直连不稳才追加镜像前缀；注入的自定义源（测试/内网）原样使用
    const zipSources = zipUrl === NAPCAT_ZIP_URL
      ? [zipUrl, ...NAPCAT_MIRROR_PREFIXES.map((p) => p + zipUrl)]
      : [zipUrl];
    setPhase('napcat-download', { detail: '下载 NapCat（约 36MB）…' });
    const zipPath = path.join(os.tmpdir(), `gptplus-napcat-${Date.now()}.zip`);
    const staged = `${installDir}.new-${crypto.randomBytes(3).toString('hex')}`;
    try {
      await downloadWithFallback(zipSources, zipPath, {
        fetchImpl: doFetch,
        describe: 'NapCat',
        onProgress: (percent, received) => setPhase('napcat-download', {
          percent,
          detail: `下载 NapCat（${(received / 1024 / 1024).toFixed(1)} MB）`,
        }),
      });
      setPhase('extract', { percent: 30, detail: '解压 NapCat…' });
      // 先解压到临时目录再原子替换：避免解压中断留下半成品被 detectNapCatCommand 误识别
      fs.rmSync(staged, { recursive: true, force: true });
      await extractZip(zipPath, staged, { spawnImpl: doSpawn });
      const boot = path.join(staged, 'launcher-user.bat');
      if (!fs.existsSync(boot)) {
        throw new Error('NapCat 包内容异常（缺少 launcher-user.bat），请重试或手动安装');
      }
      setPhase('extract', { percent: 90, detail: '替换旧目录…' });
      if (fs.existsSync(installDir)) {
        fs.rmSync(installDir, { recursive: true, force: true });
      }
      fs.renameSync(staged, installDir);
      log({ level: 'info', msg: `一键安装：NapCat 已解压到 ${installDir}` });
      // staged 目录已 rename 成 installDir，返回最终启动脚本路径
      return path.join(installDir, path.basename(boot));
    } catch (err) {
      try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* ignore */ }
      throw err;
    } finally {
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * NapCat 配置目录：优先按配置的启动命令推导（用户可能装在任意位置，
   * 如 C:\NapCat\Shell），一键安装路径只作兜底。
   */
  function napcatConfigDir() {
    const cmd = String(store.get().qqbot.launchCommand || '');
    return cmd ? path.join(path.dirname(cmd), 'config') : path.join(installDir, 'config');
  }

  /** NapCat 启动前准备 WebUI 配置，确保启动阶段就能读取扫码与登录状态。 */
  function prepareWebUiConfig() {
    const configDir = napcatConfigDir();
    const webuiToken = deps.webuiToken || crypto.randomBytes(12).toString('hex');
    const webuiCfg = ensureWebUiConfig(configDir, {
      port: deps.webuiPort || WEBUI_PORT,
      token: webuiToken,
    });
    if (webuiCfg) {
      store.update((draft) => {
        draft.qqbot.webuiPort = webuiCfg.port;
        draft.qqbot.webuiToken = webuiCfg.token;
      });
    }
    return { configDir, webuiCfg };
  }

  /**
   * 探问已在运行的 NapCat 的登录阶段（经 WebUI）。WebUI 不可达或未在登录流程时返回空。
   * 用于跳过重复拉起：上次拉起的 NapCat 还在等扫码时，再拉一次只会白等。
   */
  async function existingLoginPhase() {
    try {
      const client = createWebUiClient({ configDir: napcatConfigDir(), fetchImpl: doFetch });
      const status = await client.call('CheckLoginStatus');
      return status && status.ok && status.data ? String((status.data).loginPhase || '') : '';
    } catch {
      return '';
    }
  }

  /** 这些阶段意味着 NapCat 已拉起、正卡在登录环节，无需再拉。 */
  function isWaitingLogin(phase) {
    return ['waiting_qrcode', 'qrcode_scanned', 'initializing', 'reconnecting'].includes(phase)
      || phase.includes('expired');
  }

  /**
   * launch 之后的登录等待：优先 WebUI 快速登录（登录过一次的账号免扫码），
   * 否则取二维码推给界面（弹窗扫码），轮询直到上线。返回最终 install 状态。
   */
  async function waitForLogin({ launchWaitMs }) {
    const { configDir, webuiCfg } = prepareWebUiConfig();
    const deadline = now() + launchWaitMs;

    // OneBot 接口通了就是完全体（快速登录/上一次会话直接成功）
    const online = await qqBot.apiTest();
    if (online.ok) return finishLogin(online.account);

    const client = createWebUiClient({ configDir, fetchImpl: doFetch, initial: webuiCfg });
    // NapCat 进程刚拉起时 WebUI 还没监听：重试到窗口结束（不超过整体登录窗口）
    let webuiReady = false;
    const bootDeadline = now() + Math.min(WEBUI_BOOT_WAIT_MS, launchWaitMs);
    while (now() < bootDeadline) {
      try {
        await client.authenticate();
        webuiReady = true;
        break;
      } catch {
        await sleep(webuiPollMs);
      }
    }

    if (webuiReady) {
      // 先出二维码再试快速登录：快速登录失败（会话失效）时用户不用干等
      await pushQrcode(client);
      // 登录过的账号直接快速登录，免扫码（成功则 finishLogin 收尾并关掉弹窗）
      const quick = await client.call('GetQuickLoginListNew').catch(() => null);
      const quickUin = quick && quick.ok && Array.isArray(quick.data)
        ? quick.data.find((item) => item && item.isQuickLogin && item.uin)
        : null;
      if (quickUin) {
        setPhase('launch', { percent: 30, detail: `检测到已登录过的 QQ ${quickUin.uin}，正在快速登录…`, loginPhase: 'quick_login', qrImage: installState.qrImage });
        await client.call('SetQuickLogin', { uin: String(quickUin.uin) }).catch(() => {});
        const quickDeadline = now() + 30 * 1000;
        while (now() < quickDeadline) {
          await sleep(webuiPollMs);
          const probe = await qqBot.apiTest();
          if (probe.ok) return finishLogin(probe.account);
        }
      }
    } else {
      setPhase('launch', { percent: 30, detail: '等待 NapCat 登录服务初始化…' });
      log({ level: 'warn', msg: '一键安装：NapCat WebUI 未就绪，暂时无法在应用内显示二维码' });
    }

    let lastPhase = '';
    let lastLoginError = '';
    let lastStatusKey = '';
    let refreshedExpiredState = '';
    while (now() < deadline) {
      await sleep(qrPollMs);
      const probe = await qqBot.apiTest();
      if (probe.ok) return finishLogin(probe.account);
      if (!webuiReady) continue;
      const status = await client.call('CheckLoginStatus').catch(() => null);
      const info = status && status.ok && isPlainObject(status.data) ? status.data : null;
      const phaseText = String((info && info.loginPhase) || '');
      const rawLoginError = (info && info.loginError)
        || (status && !status.ok ? (status.message || status.error) : '');
      const loginError = formatLoginError(rawLoginError);
      const accepted = info && (info.qrLoginAccepted === true
        || phaseText === 'qrcode_scanned'
        || phaseText === 'initializing');
      const coreReady = info && info.coreReady === true;
      const confirmed = phaseText === 'initializing' || coreReady;
      const phaseChanged = phaseText !== lastPhase;
      const statusKey = `${phaseText}|${loginError}|${accepted ? 1 : 0}|${coreReady ? 1 : 0}`;
      // NapCat 在扫码确认后可能先进入 initializing，再等 OneBot 核心 ready；
      // loginError 也要直接显示，否则用户只能看到二维码一直不变。
      if (statusKey !== lastStatusKey) {
        lastStatusKey = statusKey;
        lastPhase = phaseText;
        lastLoginError = loginError;
        const detail = loginError
          ? `QQ 登录失败：${loginError}`
          : coreReady
            ? 'QQ 已确认登录，正在连接 OneBot…'
            : confirmed
              ? '已扫码并确认，正在初始化 QQ…'
              : accepted
                ? '已扫码，请在手机上确认登录…'
              : phaseText.includes('expired')
                ? '二维码已过期，正在刷新…'
                : '等待扫码（二维码由应用内展示）…';
        setPhase('launch', {
          percent: accepted ? 60 : 40,
          detail,
          loginPhase: loginError ? 'login_error' : coreReady ? 'core_ready' : confirmed ? 'initializing' : phaseText,
          qrImage: installState.qrImage,
        });
        if (loginError) log({ level: 'warn', msg: `NapCat QQ 登录失败: ${loginError}` });
      }
      const expired = phaseText.includes('expired') || /过期|expired/i.test(loginError);
      if (!expired) refreshedExpiredState = '';
      else {
        const expiredState = `${phaseText}|${loginError}`;
        if (expiredState !== refreshedExpiredState) {
          refreshedExpiredState = expiredState;
          await refreshQrcode(client);
        }
      }
    }
    // 没有通过 OneBot get_login_info 验证，就不能把未登录状态标成成功。
    const reason = lastLoginError
      ? `QQ 登录失败：${lastLoginError}`
      : `NapCat 已启动，但 ${Math.round(launchWaitMs / 1000)} 秒内未完成 QQ 登录`;
    setPhase('failed', {
      percent: 100,
      error: reason + '。请重新扫码或检查 QQ 安全验证。',
      detail: reason,
      loginPhase: lastPhase,
      qrImage: installState.qrImage,
    });
    return { ...installState };
  }

  /** 登录成功收尾：标记拉起在线、补全 QQ 配置并置 done。 */
  function finishLogin(account) {
    // 拉起窗口（120 秒）可能已超时置 failed：登录成功即在线，先纠正拉起状态
    try { qqBot.markLaunchOnline?.(account); } catch { /* 标记失败不阻塞完成 */ }
    try { qqBot.adoptLoginAccount?.(account); } catch { /* 补全失败不阻塞完成 */ }
    setPhase('done', {
      percent: 100,
      detail: `登录成功（${account || '未知账号'}），配置已自动补全`,
      account: account || '',
    });
    log({ level: 'info', msg: `一键安装完成：NapCat 登录成功（${account || ''}）` });
    return { ...installState };
  }

  function formatLoginError(value) {
    if (value == null || value === '' || value === false) return '';
    if (typeof value === 'string') return value.trim().slice(0, 600);
    try { return JSON.stringify(value).slice(0, 600); } catch { return String(value).slice(0, 600); }
  }

  /** 从 WebUI 取登录二维码，转 PNG data URL 推给界面弹窗。 */
  async function pushQrcode(client, providedUrl = '') {
    const result = providedUrl
      ? { ok: true, data: { qrcode: providedUrl } }
      : await client.call('GetQQLoginQrcode').catch(() => null);
    const url = result && result.ok && result.data && result.data.qrcode;
    if (!url) {
      const message = result && (result.message || result.error);
      if (message) {
        setPhase('launch', {
          percent: 35,
          detail: `无法获取 QQ 登录二维码：${formatLoginError(message)}`,
          loginPhase: 'login_error',
          qrImage: installState.qrImage,
        });
      }
      return false;
    }
    try {
      lastQrcodeUrl = String(url);
      const qrImage = qrPngDataUrl(String(url));
      setPhase('launch', {
        percent: 35,
        detail: '等待扫码：用手机 QQ 扫弹窗里的二维码…',
        loginPhase: 'waiting_qrcode',
        qrImage,
      });
      return true;
    } catch (err) {
      log({ level: 'warn', msg: `登录二维码生成失败: ${err && err.message}` });
      return false;
    }
  }

  /** 请求 NapCat 刷新二维码，并等待 WebUI 返回新的 URL，避免重复展示过期二维码。 */
  async function refreshQrcode(client) {
    const previous = lastQrcodeUrl;
    const refreshed = await client.call('RefreshQRcode').catch(() => null);
    const directUrl = refreshed && refreshed.ok && refreshed.data
      ? String(refreshed.data.qrcodeurl || refreshed.data.qrcode || '')
      : '';
    if (directUrl && directUrl !== previous) return pushQrcode(client, directUrl);
    const deadline = now() + 10 * 1000;
    while (now() < deadline) {
      await sleep(500);
      const next = await client.call('GetQQLoginQrcode').catch(() => null);
      const nextUrl = next && next.ok && next.data ? String(next.data.qrcode || '') : '';
      if (nextUrl && nextUrl !== previous) return pushQrcode(client, nextUrl);
    }
    log({ level: 'warn', msg: 'NapCat 二维码刷新请求已发送，但 WebUI 尚未返回新的二维码' });
    return false;
  }

  /**
   * 一键安装主流程。任何阶段失败置 failed；并发调用共享同一个 Promise。
   * @param {{ launchWaitMs?: number }} opts 测试可注入更短等待
   */
  function install({ launchWaitMs = LAUNCH_WAIT_MS } = {}) {
    if (installInFlight) return installInFlight;
    const run = (async () => {
      try {
        lastQrcodeUrl = '';
        setPhase('prepare', { detail: '检查环境…' });
        await ensureQqInstalled();
        const bootScript = await downloadAndExtractNapCat();
        setPhase('configure', { percent: 50, detail: '写入启动命令与网络配置…' });
        store.update((draft) => {
          draft.qqbot.launchCommand = bootScript;
          draft.qqbot.autoLaunch = true;
        });
        setPhase('configure', { percent: 100, detail: '配置已写入' });
        // launchNapCat 拉起前会 syncNapCatConfig 写 onebot11 配置，并等待上线
        setPhase('launch', { percent: 5, detail: '启动 NapCat…' });
        // 上次拉起的 NapCat 还在等扫码/确认时跳过拉起，直接进入登录等待（立刻出二维码）
        if (isWaitingLogin(await existingLoginPhase())) {
          return waitForLogin({ launchWaitMs });
        }
        prepareWebUiConfig();
        const launched = await qqBot.launchNapCat({ waitMs: Math.min(launchWaitMs, 120000) });
        if (launched.ok) {
          // 拉起即上线（快速登录直接成功 / 本来就在运行）
          return finishLogin(launched.account);
        }
        // 拉起后进入 WebUI 登录流程（快速登录优先，否则二维码弹窗）
        return waitForLogin({ launchWaitMs });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        setPhase('failed', { error: message });
        log({ level: 'error', msg: `一键安装失败: ${message}` });
        return { ...installState };
      }
    })();
    installInFlight = run.finally(() => { installInFlight = null; });
    return installInFlight;
  }

  /**
   * 独立登录流程（已装 NapCat 的用户点「拉起 NapCat」用）：拉起并等到上线；
   * 快速登录不行就取二维码弹窗扫码。与 install 共享并发去重（安装中则复用）。
   */
  function loginFlow({ launchWaitMs = LAUNCH_WAIT_MS } = {}) {
    if (installInFlight) return installInFlight;
    const run = (async () => {
      try {
        lastQrcodeUrl = '';
        setPhase('launch', { percent: 5, detail: '启动 NapCat…' });
        // 上次拉起的 NapCat 还在等扫码/确认时跳过拉起，直接进入登录等待（立刻出二维码）
        if (isWaitingLogin(await existingLoginPhase())) {
          return waitForLogin({ launchWaitMs });
        }
        prepareWebUiConfig();
        const launched = await qqBot.launchNapCat({ waitMs: Math.min(launchWaitMs, 120000) });
        if (launched.ok) return finishLogin(launched.account);
        return waitForLogin({ launchWaitMs });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        setPhase('failed', { error: message });
        log({ level: 'warn', msg: `NapCat 登录流程失败: ${message}` });
        return { ...installState };
      }
    })();
    installInFlight = run.finally(() => { installInFlight = null; });
    return installInFlight;
  }

  return {
    install,
    loginFlow,
    getState: () => ({ ...installState }),
    installDir,
  };
}

module.exports = {
  createNapCatInstaller,
  // 独立导出便于单测
  defaultInstallDir,
  parseRegSz,
  parseRainbowConfig,
  findQqInstall,
  resolveQqInstallerUrl,
  downloadTo,
  extractZip,
  installQqSilently,
  readRegistryString,
  PHASE_LABEL,
  QQ_RAINBOW_CONFIG_URL,
  NAPCAT_ZIP_URL,
  QQ_UNINSTALL_KEY,
};
