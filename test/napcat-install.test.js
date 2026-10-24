'use strict';
// NapCat 一键安装器测试：QQ 检测/彩虹配置解析、下载（本地 http stub）、
// 解压（Windows tar 集成）、静默安装、安装状态机端到端、WebUI 客户端、QR PNG。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const { createStore } = require('../src/core/store.js');
const {
  createNapCatInstaller,
  parseRegSz,
  parseRainbowConfig,
  findQqInstall,
  downloadTo,
  extractZip,
  installQqSilently,
  defaultInstallDir,
  NAPCAT_ZIP_URL,
} = require('../src/core/napcat-install.js');

// 非 Windows 无 tar 集成时，NapCat zip 用官方地址兜底（对应用例会因解压失败/网络不可达而 skip 或 failed）
const NAPCAT_ZIP_FALLBACK = NAPCAT_ZIP_URL;
const { createWebUiClient, webuiPasswordHash, ensureWebUiConfig } = require('../src/core/napcat-webui.js');
const { qrPng, crc32 } = require('../src/core/qr-code.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class FakeChild extends EventEmitter {
  constructor() { super(); }
  kill() { /* no-op */ }
}

// ---- 基础解析 ----

test('parseRegSz 解析 reg query 输出', () => {
  const out = ['\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\...\\QQ\r\n',
    '    UninstallString    REG_SZ    "C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"\r\n',
    '\r\n'].join('');
  assert.equal(parseRegSz(out, 'UninstallString'), '"C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"');
  assert.equal(parseRegSz('系统找不到指定的注册表项或值', 'UninstallString'), '');
});

test('parseRainbowConfig：官方 CDN 生成备用 host，其它来源原样使用', () => {
  const rainbow = 'var params= {"version":"9.9.36","ntDownloadX64Url":"https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e/QQ_9.9.36_x64_01.exe"};';
  const parsed = parseRainbowConfig(rainbow);
  assert.equal(parsed.version, '9.9.36');
  assert.equal(parsed.fallbacks[0], 'https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e/QQ_9.9.36_x64_01.exe');
  assert.ok(parsed.fallbacks.some((u) => u.startsWith('https://dldir1.qq.com/')), '备用 dldir1');

  const local = parseRainbowConfig('{"ntDownloadX64Url":"http://127.0.0.1:1/qq.exe"}');
  assert.deepEqual(local.fallbacks, ['http://127.0.0.1:1/qq.exe']);
  assert.equal(parseRainbowConfig('{"foo":1}'), null);
});

test('findQqInstall：注册表命中 / 兜底目录 / 找不到', async () => {
  const dir = tmpdir('gptplus-qqfind-');
  try {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const qqExe = path.join(dir, 'bin', 'QQ.exe');
    fs.writeFileSync(qqExe, '');
    const regOut = `\r\n    UninstallString    REG_SZ    "${path.join(dir, 'bin', 'Uninstall.exe')}"\r\n`;
    const found = await findQqInstall({
      execCaptureImpl: async (command) => (command === 'reg.exe' ? regOut : ''),
    });
    assert.equal(path.normalize(found.qqExe), path.normalize(qqExe));

    const none = await findQqInstall({
      execCaptureImpl: async () => '',
      env: { ProgramFiles: path.join(dir, 'missing') },
    });
    assert.equal(none, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 下载 ----

test('downloadTo：流式下载到文件并回调进度', async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  const port = await listen(server);
  const dest = path.join(tmpdir('gptplus-dl-'), 'qq.exe');
  try {
    const progress = [];
    const result = await downloadTo(`http://127.0.0.1:${port}/qq.exe`, dest, {
      fetchImpl: fetch,
      onProgress: (percent) => progress.push(percent),
    });
    assert.equal(result.bytes, payload.length);
    assert.equal(fs.statSync(dest).size, payload.length);
    assert.equal(progress[progress.length - 1], 100, '最后一次进度是 100');
  } finally {
    await closeServer(server);
  }
});

test('downloadTo：HTTP 404 抛出可读错误', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => downloadTo(`http://127.0.0.1:${port}/nope`, path.join(tmpdir('gptplus-dl2-'), 'x'), { fetchImpl: fetch }),
      /HTTP 404/,
    );
  } finally {
    await closeServer(server);
  }
});

// ---- 解压（Windows tar 集成） ----

/** 用 PowerShell Compress-Archive 造一个 NapCat 风格 zip。 */
function makeNapCatZip(dir) {
  const src = path.join(dir, 'payload');
  fs.mkdirSync(path.join(src, 'config'), { recursive: true });
  fs.writeFileSync(path.join(src, 'launcher-user.bat'), '@echo off\r\n');
  fs.writeFileSync(path.join(src, 'napcat.mjs'), 'console.log(1)\n');
  fs.writeFileSync(path.join(src, 'config', 'napcat.json'), '{}');
  const zip = path.join(dir, 'napcat.zip');
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path "${path.join(src, '*')}" -DestinationPath "${zip}" -Force`,
  ], { timeout: 60_000 });
  assert.equal(run.status, 0, 'Compress-Archive 失败: ' + String(run.stderr));
  return zip;
}

test('extractZip：System32 tar 解压 NapCat 包（Windows 集成）', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmpdir('gptplus-unzip-');
  try {
    const zip = makeNapCatZip(dir);
    const dest = path.join(dir, 'out');
    await extractZip(zip, dest);
    assert.ok(fs.existsSync(path.join(dest, 'launcher-user.bat')));
    assert.ok(fs.existsSync(path.join(dest, 'config', 'napcat.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- QQ 静默安装 ----

test('installQqSilently：/S 成功后轮询注册表；非零退出报错', async () => {
  const dir = tmpdir('gptplus-qqins-');
  try {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const qqExe = path.join(dir, 'bin', 'QQ.exe');
    const regOut = `\r\n    UninstallString    REG_SZ    "${path.join(dir, 'bin', 'Uninstall.exe')}"\r\n`;
    let asked = 0;
    const spawns = [];
    const installer = await installQqSilently(path.join(dir, 'setup.exe'), {
      spawnImpl: (command, args, opts) => {
        spawns.push({ command, args: args.slice(), opts });
        const child = new FakeChild();
        setImmediate(() => child.emit('close', 0));
        return child;
      },
      execCaptureImpl: async (command, args) => {
        asked += 1;
        if (asked === 0) return '';
        fs.writeFileSync(qqExe, ''); // 第二次轮询前 QQ 就位
        return regOut;
      },
    });
    assert.equal(path.normalize(installer.qqExe), path.normalize(qqExe));
    assert.deepEqual(spawns[0].args, ['/S'], 'NSIS 静默参数');

    await assert.rejects(
      () => installQqSilently(path.join(dir, 'setup.exe'), {
        spawnImpl: () => { const c = new FakeChild(); setImmediate(() => c.emit('close', 1223)); return c; },
        execCaptureImpl: async () => regOut,
      }),
      /退出码 1223/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 安装状态机端到端 ----

/** 一键安装端到端替身：本地 http 提供彩虹配置/QQ 包/NapCat zip/WebUI，spawn/qqBot 全 stub。 */
async function makeInstallHarness({ qqInstalled = false, loginAfterQrcode = true, withWebUi = false, qrPollMs = 2000 } = {}) {
  const dir = tmpdir('gptplus-install-');
  const zip = process.platform === 'win32' ? makeNapCatZip(dir) : null;
  const qqPayload = Buffer.alloc(4096, 1);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/rainbow.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`var params= {"version":"9.9.36","ntDownloadX64Url":"http://127.0.0.1:${server.address().port}/qq.exe"};`);
    } else if (req.url === '/qq.exe') {
      res.writeHead(200, { 'Content-Length': String(qqPayload.length) });
      res.end(qqPayload);
    } else if (req.url === '/napcat.zip' && zip) {
      const bytes = fs.readFileSync(zip);
      res.writeHead(200, { 'Content-Length': String(bytes.length) });
      res.end(bytes);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const port = await listen(server);
  // WebUI 替身：固定端口/令牌经 deps 注入（解压会清空安装目录，预写文件无效）
  const webui = withWebUi ? await startWebUiStub({ onAuth: () => 'testwebui-token' }) : null;
  const store = createStore({ configPath: path.join(dir, 'config.json') });

  let qqOnDisk = qqInstalled;
  const spawns = [];
  const spawnImpl = (command, args, opts) => {
    spawns.push({ command, args: args.slice() });
    // tar 解压必须真执行（stub 无法产生解压产物）
    if (/tar\.exe$/i.test(String(command))) return require('node:child_process').spawn(command, args, opts);
    if (args.includes('/S')) qqOnDisk = true; // QQ 安装器跑完即视为装好（reg 轮询能看到）
    const child = new FakeChild();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const execCaptureImpl = async (command) => {
    if (command !== 'reg.exe') return '';
    if (!qqOnDisk) return '';
    fs.mkdirSync(path.join(dir, 'QQNT'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'QQNT', 'QQ.exe'), '');
    return `\r\n    UninstallString    REG_SZ    "${path.join(dir, 'QQNT', 'Uninstall.exe')}"\r\n`;
  };

  const events = [];
  const adopted = [];
  const markedOnline = [];
  let launchCalls = 0;
  let webuiConfigAtLaunch = false;
  let apiTestOk = false; // 扫码完成后上线
  let apiTestCalls = 0;
  const qqBot = {
    apiTest: async () => {
      apiTestCalls += 1;
      if (!apiTestOk) return { ok: false, error: 'offline' };
      return { ok: true, account: '777000', nickname: '装机机器人' };
    },
    launchNapCat: async () => {
      launchCalls += 1;
      const command = String(store.get().qqbot.launchCommand || '');
      webuiConfigAtLaunch = !!command && fs.existsSync(path.join(path.dirname(command), 'config', 'webui.json'));
      apiTestOk = loginAfterQrcode ? true : apiTestOk;
      return { ok: false, error: '等待扫码' };
    },
    adoptLoginAccount: (account) => adopted.push(account),
    markLaunchOnline: (account) => markedOnline.push(account),
  };

  const installer = createNapCatInstaller({
    store,
    qqBot,
    log: () => {},
    onEvent: (s) => events.push(s),
    fetchImpl: fetch,
    spawnImpl,
    execCaptureImpl,
    installDir: path.join(dir, 'NapCat'),
    rainbowConfigUrl: `http://127.0.0.1:${port}/rainbow.js`,
    napcatZipUrl: zip ? `http://127.0.0.1:${port}/napcat.zip` : NAPCAT_ZIP_FALLBACK,
    ...(webui ? { webuiPort: webui.port, webuiToken: 'testwebui-token' } : {}),
    qrPollMs,
    now: () => Date.now(),
  });
  return {
    dir, store, installer, events, adopted, markedOnline, launchCalls,
    get webuiConfigAtLaunch() { return webuiConfigAtLaunch; },
    spawns, requests, port, webui,
    markOnline: () => { apiTestOk = true; },
    close: async () => {
      await closeServer(server);
      if (webui) await webui.close();
    },
  };
}

test('install：全流程（装 QQ → 装 NapCat → 配置 → 拉起登录）', { skip: process.platform !== 'win32' }, async () => {
  const h = await makeInstallHarness({ qqInstalled: false });
  try {
    const result = await h.installer.install({ launchWaitMs: 4000 });
    assert.equal(result.phase, 'done', JSON.stringify(result));
    assert.equal(result.account, '777000');
    // QQ 静默安装（/S）+ NapCat 解压（tar）都执行过
    assert.ok(h.spawns.some((s) => s.args.join(' ').includes('/S')), 'QQ 静默安装');
    assert.ok(h.spawns.some((s) => String(s.command).endsWith('tar.exe')), 'tar 解压');
    // 安装目录与启动脚本就位，store 已写入
    assert.ok(fs.existsSync(path.join(h.installer.installDir, 'launcher-user.bat')));
    const cfg = h.store.get().qqbot;
    assert.equal(path.normalize(cfg.launchCommand), path.normalize(path.join(h.installer.installDir, 'launcher-user.bat')));
    assert.equal(cfg.autoLaunch, true);
    // 登录账号被收养 + 拉起状态被标记在线 + 事件按 phase 推进
    assert.deepEqual(h.adopted, ['777000']);
    assert.deepEqual(h.markedOnline, ['777000']);
    const phases = h.events.map((e) => e.phase);
    assert.ok(phases.includes('qq-download'));
    assert.ok(phases.includes('napcat-download'));
    assert.ok(phases.includes('extract'));
    assert.ok(phases.includes('configure'));
    assert.ok(phases.indexOf('qq-download') < phases.indexOf('napcat-download'));
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('install：本机已有 QQ 时跳过 QQ 下载', { skip: process.platform !== 'win32' }, async () => {
  const h = await makeInstallHarness({ qqInstalled: true });
  try {
    const result = await h.installer.install({ launchWaitMs: 4000 });
    assert.equal(result.phase, 'done');
    assert.equal(h.requests.includes('/qq.exe'), false, 'QQ 安装包未被下载');
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('install：扫码路径——WebUI 出二维码，确认并上线后 done 且收养账号', { skip: process.platform !== 'win32' }, async () => {
  const h = await makeInstallHarness({ qqInstalled: true, loginAfterQrcode: false, withWebUi: true, qrPollMs: 10 });
  try {
    const pending = h.installer.install({ launchWaitMs: 8000 });
    // 等到带二维码的事件（WebUI 认证 + 无快速登录账号 → 出码）
    const deadline = Date.now() + 15000;
    while (!h.events.some((e) => e.qrImage) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const qrEvent = h.events.find((e) => e.qrImage);
    assert.ok(qrEvent, '推送了二维码事件');
    assert.match(qrEvent.qrImage, /^data:image\/png;base64,/);
    assert.equal(qrEvent.loginPhase, 'waiting_qrcode');
    // 扫码确认后 WebUI 进入初始化；OneBot 在线后才应标记成功。
    h.webui.setLoginStatus({ isLogin: false, loginPhase: 'initializing', qrLoginAccepted: true, coreReady: false });
    const confirmingDeadline = Date.now() + 3000;
    while (!h.events.some((e) => e.loginPhase === 'initializing') && Date.now() < confirmingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(h.events.some((e) => e.loginPhase === 'initializing' && /已扫码并确认/.test(e.detail)));
    h.markOnline();
    const result = await pending;
    assert.equal(result.phase, 'done');
    assert.equal(result.account, '777000');
    assert.deepEqual(h.adopted, ['777000']);
    // 宽限窗口内登录成功也要把拉起状态纠正为在线（拉起窗口可能已超时置 failed）
    assert.deepEqual(h.markedOnline, ['777000']);
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('install：并发调用去重；失败置 failed', { skip: process.platform !== 'win32' }, async () => {
  const h = await makeInstallHarness({ qqInstalled: false, loginAfterQrcode: false });
  try {
    const [a, b] = await Promise.all([
      h.installer.install({ launchWaitMs: 1500 }),
      h.installer.install({ launchWaitMs: 1500 }),
    ]);
    assert.equal(a.phase, 'failed'); // NapCat 已装好，但未登录不得报告完成
    assert.equal(a.phase, b.phase);
    assert.equal(h.events.filter((e) => e.phase === 'qq-download').length > 0, true);
    assert.equal(h.store.get().qqbot.autoLaunch, true);
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('install：下载源全挂时置 failed 且不写 store', async () => {
  const dir = tmpdir('gptplus-fail-');
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  const server = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  const port = await listen(server);
  try {
    // QQ 已在盘上（注册表命中），让流程停在 NapCat 下载阶段
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'QQ.exe'), '');
    const regOut = `\r\n    UninstallString    REG_SZ    "${path.join(dir, 'bin', 'Uninstall.exe')}"\r\n`;
    const installer = createNapCatInstaller({
      store,
      qqBot: { apiTest: async () => ({ ok: false }), launchNapCat: async () => ({ ok: false }), adoptLoginAccount: () => {} },
      log: () => {},
      fetchImpl: fetch,
      spawnImpl: () => new FakeChild(),
      execCaptureImpl: async (command) => (command === 'reg.exe' ? regOut : ''),
      installDir: path.join(dir, 'NapCat'),
      rainbowConfigUrl: `http://127.0.0.1:${port}/rainbow.js`,
      napcatZipUrl: `http://127.0.0.1:${port}/napcat.zip`,
    });
    const result = await installer.install({ launchWaitMs: 100 });
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /NapCat/);
    assert.equal(store.get().qqbot.launchCommand, '', '失败不写启动命令');
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultInstallDir 指向 LOCALAPPDATA\\NapCat（detectNapCatCommand 候选）', () => {
  const dir = defaultInstallDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
  assert.equal(path.normalize(dir), path.normalize('C:\\Users\\u\\AppData\\Local\\NapCat'));
});

test('loginFlow：独立登录（已装 NapCat 场景），webui.json 写到启动命令同级目录', { skip: process.platform !== 'win32' }, async () => {
  const h = await makeInstallHarness({ qqInstalled: true, loginAfterQrcode: false, withWebUi: true });
  try {
    // 模拟已装 NapCat：launchCommand 指向另一个目录（不在 installDir 下）
    const otherDir = path.join(h.dir, 'Existing');
    fs.mkdirSync(path.join(otherDir, 'config'), { recursive: true });
    const boot = path.join(otherDir, 'launcher-user.bat');
    fs.writeFileSync(boot, '@echo off\r\n');
    h.store.update((draft) => { draft.qqbot.launchCommand = boot; });

    const pending = h.installer.loginFlow({ launchWaitMs: 8000 });
    const deadline = Date.now() + 15000;
    while (!h.events.some((e) => e.qrImage) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(h.events.some((e) => e.qrImage), '登录流程推送了二维码');
    // webui.json 必须写到启动命令所在的 Existing/config（用户可装在任意位置）
    assert.ok(fs.existsSync(path.join(otherDir, 'config', 'webui.json')), 'webui.json 跟随 launchCommand');
    assert.equal(h.webuiConfigAtLaunch, true, 'NapCat 启动前已准备好 WebUI 配置');
    h.markOnline();
    const result = await pending;
    assert.equal(result.phase, 'done');
    assert.equal(result.account, '777000');
    // 宽限窗口内登录成功也要把拉起状态纠正为在线（拉起窗口可能已超时置 failed）
    assert.deepEqual(h.markedOnline, ['777000']);
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('loginFlow：NapCat 已在等扫码时跳过拉起直接出二维码', { skip: process.platform !== 'win32' }, async () => {
  const h = await makeInstallHarness({ qqInstalled: true, loginAfterQrcode: false, withWebUi: true });
  try {
    const otherDir = path.join(h.dir, 'Existing');
    fs.mkdirSync(path.join(otherDir, 'config'), { recursive: true });
    const boot = path.join(otherDir, 'launcher-user.bat');
    fs.writeFileSync(boot, '@echo off\r\n');
    h.store.update((draft) => { draft.qqbot.launchCommand = boot; });
    // 预置 webui.json 指向替身：模拟「上次拉起的 NapCat 还开着、停在等扫码」
    fs.writeFileSync(path.join(otherDir, 'config', 'webui.json'), JSON.stringify({
      host: '127.0.0.1', port: h.webui.port, token: 'testwebui-token',
    }));

    const result = await h.installer.loginFlow({ launchWaitMs: 1500 });
    assert.equal(result.phase, 'failed');
    assert.equal(h.launchCalls, 0, '不应重复拉起已等待扫码的 NapCat');
    assert.ok(h.events.some((e) => e.qrImage), '直接推送了二维码');
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// ---- WebUI 客户端 ----

test('webuiPasswordHash：sha256(token.napcat)', () => {
  const expect = crypto.createHash('sha256').update('tok.napcat').digest('hex');
  assert.equal(webuiPasswordHash('tok'), expect);
});

test('ensureWebUiConfig：不存在时创建；已存在时读真实值', () => {
  const dir = tmpdir('gptplus-webui-');
  try {
    const configDir = path.join(dir, 'config');
    const created = ensureWebUiConfig(configDir, { port: 6099, token: 'abc' });
    assert.deepEqual(created, { host: '127.0.0.1', port: 6099, token: 'abc', loginRate: 3 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'webui.json'), 'utf8'));
    assert.equal(onDisk.token, 'abc');

    // 已有配置（NapCat 登录后刷新了 token）→ 读回真实值，不覆盖
    onDisk.token = 'refreshed';
    onDisk.port = 6100;
    fs.writeFileSync(path.join(configDir, 'webui.json'), JSON.stringify(onDisk));
    const readBack = ensureWebUiConfig(configDir, { port: 6099, token: 'abc' });
    assert.equal(readBack.token, 'refreshed');
    assert.equal(readBack.port, 6100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 本地 NapCat WebUI 替身：认证 + QQLogin 端点。 */
async function startWebUiStub({ onAuth } = {}) {
  const requests = [];
  let credential = 'cred-1';
  let loginStatus = { isLogin: false, loginPhase: 'waiting_qrcode' };
  let qrcodeUrl = 'https://qq.example/login?sig=1';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON */ }
      requests.push({ url: req.url, body, auth: req.headers.authorization || '' });
      const send = (code, json) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.url === '/api/auth/login') {
        const ok = body && body.hash === webuiPasswordHash(onAuth());
        return ok ? send(200, { code: 0, data: { Credential: credential } }) : send(200, { code: 1, message: 'token error' });
      }
      if (!req.headers.authorization || req.headers.authorization !== `Bearer ${credential}`) {
        return send(401, { message: '凭证无效' });
      }
      if (req.url === '/api/QQLogin/GetQQLoginQrcode') {
        return send(200, { code: 0, data: { qrcode: qrcodeUrl } });
      }
      if (req.url === '/api/QQLogin/CheckLoginStatus') {
        return send(200, { code: 0, data: loginStatus });
      }
      if (req.url === '/api/QQLogin/RefreshQRcode') {
        qrcodeUrl = 'https://qq.example/login?sig=2';
        return send(200, { code: 0, data: { qrcodeurl: qrcodeUrl } });
      }
      if (req.url === '/api/QQLogin/TestBusinessError') {
        return send(200, { code: 168, message: 'QQ Login Error: serverErrorCode 168' });
      }
      if (req.url === '/api/QQLogin/GetQuickLoginListNew') {
        return send(200, { code: 0, data: [] });
      }
      send(404, { message: 'not found' });
    });
  });
  const port = await listen(server);
  return {
    port,
    requests,
    setLoginStatus: (next) => { loginStatus = next; },
    close: () => closeServer(server),
  };
}

test('createWebUiClient：认证 → 调端点；token 被刷新后 401 自动重认证', async () => {
  const dir = tmpdir('gptplus-webuic-');
  const configDir = path.join(dir, 'config');
  ensureWebUiConfig(configDir, { port: 0, token: 't1' });
  let liveToken = 't1';
  const stub = await startWebUiStub({ onAuth: () => liveToken });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'webui.json'), 'utf8'));
    cfg.port = stub.port;
    fs.writeFileSync(path.join(configDir, 'webui.json'), JSON.stringify(cfg));

    const client = createWebUiClient({ configDir, fetchImpl: fetch });
    const qr = await client.call('GetQQLoginQrcode');
    assert.equal(qr.ok, true);
    assert.equal(qr.data.qrcode, 'https://qq.example/login?sig=1');

    const refresh = await client.call('RefreshQRcode');
    assert.equal(refresh.ok, true);
    assert.equal(refresh.data.qrcodeurl, 'https://qq.example/login?sig=2');
    const businessError = await client.call('TestBusinessError');
    assert.equal(businessError.ok, false);
    assert.equal(businessError.code, 168);
    assert.match(businessError.error, /serverErrorCode 168/);

    // NapCat 登录成功后刷新了 token：下一次调用 401 → 重读 webui.json 重认证
    liveToken = 't2';
    cfg.token = 't2';
    fs.writeFileSync(path.join(configDir, 'webui.json'), JSON.stringify(cfg));
    const status = await client.call('CheckLoginStatus');
    assert.equal(status.ok, true);
    assert.equal(status.data.loginPhase, 'waiting_qrcode');
    assert.ok(stub.requests.some((r) => r.url === '/api/auth/login'), '重新认证过');
  } finally {
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loginFlow：展示 NapCat 返回的 QQ 登录错误且不假报成功', async () => {
  const h = await makeInstallHarness({ qqInstalled: true, loginAfterQrcode: false, withWebUi: true, qrPollMs: 5 });
  try {
    h.webui.setLoginStatus({
      isLogin: false,
      loginPhase: 'qrcode_scanned',
      qrLoginAccepted: true,
      coreReady: false,
      loginError: 'QQ Login Error: serverErrorCode 168',
    });
    const result = await h.installer.loginFlow({ launchWaitMs: 100 });
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /serverErrorCode 168/);
    assert.ok(result.qrImage, '保留二维码供用户重试');
    assert.ok(h.events.some((event) => event.loginPhase === 'login_error' && /serverErrorCode 168/.test(event.detail)));
    assert.deepEqual(h.markedOnline, [], '没有 OneBot 在线证明时不得标记已登录');
    assert.deepEqual(h.adopted, [], '登录失败时不得收养账号配置');
  } finally {
    await h.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// ---- QR PNG ----

test('crc32 已知向量', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('qrPng：PNG 结构可解析、zlib 可回环、四周有静区', () => {
  const { png, size, moduleCount } = qrPng('https://qq.example/verify/abc?k=1');
  assert.ok(png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 签名');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  assert.equal(png[24], 1, '1-bit');
  assert.equal(png[25], 0, '灰度');
  // 解析 IDAT 并解压：行数与每行位数对得上
  const chunks = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.slice(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') chunks.push(png.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const bytesPerRow = Math.ceil(size / 8);
  assert.equal(raw.length, (bytesPerRow + 1) * size);
  // 第 0 行整行是静区（上边距 4 模块 ×6px = 24px）→ 全白
  const row0 = raw.slice(1, 1 + bytesPerRow);
  assert.ok(row0.every((b) => b === 0), '首行静区全白');
  // 第 24px 行是 finder pattern 顶行：像素 24 起连续深色
  const row24 = raw.slice(24 * (bytesPerRow + 1) + 1, 24 * (bytesPerRow + 1) + 1 + bytesPerRow);
  assert.equal(row24[0], 0, '行首仍是左侧静区');
  const finderByte = row24[3]; // 像素 24-31：第 24 像素 = finder 边框起点
  assert.equal(finderByte & 0x80, 0x80, 'finder pattern 起始为深色');
  assert.ok(moduleCount >= 21);
});
