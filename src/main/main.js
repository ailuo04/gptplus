'use strict';
// Electron 主进程：窗口、IPC 注册、网关生命周期。实现细节委托给 src/core。
const path = require('node:path');
const fs = require('node:fs');

// 环境里若设了 ELECTRON_RUN_AS_NODE=1（某些终端/IDE 会继承），Electron 会退化成普通 Node，
// `require('electron')` 返回的是可执行文件路径而不是 API，应用根本起不来。这里自动纠正。
if (process.env.ELECTRON_RUN_AS_NODE && !process.env.GPTPLUS_RELAUNCHED) {
  const exe = process.execPath;
  // 在 Node 或 Electron 运行时中，require('electron') 会返回 Electron 可执行文件路径。
  // 只要确认拿到的是路径，就重新以 Electron 模式启动；不能只依赖 execPath 是否为 node.exe，
  // 因为 Electron 自身也可能继承 ELECTRON_RUN_AS_NODE=1。
  try {
    // eslint-disable-next-line global-require
    const electronExe = require('electron');
    if (typeof electronExe === 'string' && fs.existsSync(electronExe)) {
      // eslint-disable-next-line global-require
      const { spawn } = require('node:child_process');
      const env = { ...process.env, GPTPLUS_RELAUNCHED: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      spawn(electronExe, [path.resolve(__dirname, '..', '..'), ...process.argv.slice(2)], {
        env, detached: true, stdio: 'ignore', windowsHide: false,
      }).unref();
      console.error('[gpt++] 检测到 ELECTRON_RUN_AS_NODE，已用正确的 Electron 运行时重新启动');
      process.exit(0);
    }
  } catch (err) {
    console.error('[gpt++] 无法自动纠正 ELECTRON_RUN_AS_NODE: ' + err.message);
    console.error('       请先执行: Remove-Item Env:ELECTRON_RUN_AS_NODE  然后 npm start');
    process.exit(1);
  }
  console.error('[gpt++] 请先执行: Remove-Item Env:ELECTRON_RUN_AS_NODE  然后 npm start');
  process.exit(1);
}

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  safeStorage,
  clipboard,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
} = require('electron');

// 固定 Windows 应用身份，保证安装后的快捷方式、任务栏和托盘身份不随安装目录变化。
if (process.platform === 'win32') app.setAppUserModelId('com.ailuo.gptplus');

const { createWindowLifecycle } = require('./window-lifecycle.js');
const { TRAY_ICON_DATA_URL } = require('./tray-icon.js');
const { setupAutoUpdater, cleanupInstalledUpdateCache } = require('./updater.js');
const { autoUpdater } = require('electron-updater');
const { launchChatGptAndVerify } = require('../core/chatgpt-launch.js');

const isDev = process.argv.includes('--dev');
const isQuitRequest = process.argv.includes('--quit');
// 自动化验证入口：--smoke-dump <文件> 渲染完成后把 DOM 写到文件；--smoke-shot <png> 截图。
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const smokeDump = argValue('--smoke-dump');
const smokeShot = argValue('--smoke-shot');
const isSmoke = !!(smokeDump || smokeShot);

// 冒烟测试时把数据目录隔离到临时目录，避免污染真实 ~/.gptplus，
// 也避免打包后从只读的 app.asar 内部写入测试数据。
if (isSmoke) {
  const sandbox = process.env.GPTPLUS_SMOKE_DIR
    ? path.resolve(process.env.GPTPLUS_SMOKE_DIR)
    : path.join(require('node:os').tmpdir(), 'gptplus-smoke');
  fs.mkdirSync(path.join(sandbox, 'gptplus'), { recursive: true });
  app.setPath('userData', sandbox);
  // core/paths.js 读这个变量决定数据目录（纯 Node 模块，不依赖 electron）
  process.env.GPTPLUS_HOME = path.join(sandbox, 'gptplus');
}

// 单实例（冒烟测试允许多开）
if (!isSmoke && !app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// 安装器通过第二实例传递退出请求；没有旧实例时，新进程也应立即结束。
if (!isSmoke && isQuitRequest) {
  app.whenReady().then(() => app.quit());
  return;
}

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
let isQuitting = false;
let windowReady = false;
/** @type {any} */
let ctx = null; // { store, gateway, injector, codex, catalog, providerClient }

function showWindow() {
  if (!win || win.isDestroyed()) {
    if (!isSmoke) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!windowReady) return;
  win.show();
  win.focus();
}

function refreshTrayMenu() {
  if (!tray || !ctx?.gateway) return;
  const running = !!ctx.gateway.getState().running;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 gpt++', click: showWindow },
    { type: 'separator' },
    {
      label: running ? '停止本地网关' : '启动本地网关',
      click: () => { void toggleGatewayFromTray(); },
    },
    { type: 'separator' },
    { label: '退出 gpt++', click: quitApplication },
  ]));
}

async function toggleGatewayFromTray() {
  if (!ctx?.gateway || !ctx?.store) return;
  try {
    if (ctx.gateway.getState().running) {
      await ctx.gateway.stop();
      ctx.log({ level: 'warn', msg: '已从托盘停止本地网关' });
    } else {
      const cfg = ctx.store.get();
      const started = await ctx.gateway.start({
        port: cfg.gateway.port,
        host: cfg.gateway.host || '127.0.0.1',
        token: cfg.gateway.token,
      });
      ctx.log({ level: 'info', msg: `已从托盘启动本地网关: ${started.url}` });
    }
    ctx.emitStatus?.();
    refreshTrayMenu();
  } catch (err) {
    ctx.log({ level: 'error', msg: `托盘切换网关失败: ${err.message}` });
    refreshTrayMenu();
  }
}

function quitApplication() {
  isQuitting = true;
  app.quit();
}

function readStartupSettings() {
  if (typeof app.getLoginItemSettings !== 'function') {
    return { supported: false, enabled: false };
  }
  try {
    let settings = app.getLoginItemSettings(
      process.platform === 'win32' ? { args: ['--gptplus-startup'] } : {},
    );
    if (process.platform === 'win32' && !settings.openAtLogin) {
      settings = app.getLoginItemSettings({ args: [] });
    }
    const target = ctx?.store?.get?.()?.startup?.target === 'both' ? 'both' : 'gptplus';
    const enabled = !!settings.openAtLogin
      && (process.platform !== 'win32' || settings.executableWillLaunchAtLogin !== false);
    return { supported: true, enabled, target };
  } catch {
    return { supported: false, enabled: false, target: 'gptplus' };
  }
}

function writeStartupSettings(patch) {
  if (typeof app.setLoginItemSettings !== 'function') {
    throw new Error('当前系统不支持开机自启动');
  }
  const current = ctx?.store?.get?.()?.startup?.target;
  const enabled = typeof patch === 'boolean' ? patch : !!patch?.enabled;
  const target = typeof patch === 'object' && patch?.target !== undefined
    ? patch.target
    : current;
  if (target !== 'gptplus' && target !== 'both') throw new Error('开机自启动目标无效');
  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(process.platform === 'win32' ? { args: ['--gptplus-startup'] } : {}),
  });
  ctx?.store?.update?.((draft) => {
    draft.startup.target = target;
  });
  return readStartupSettings();
}

function migrateStartupSettings() {
  if (isDev || isSmoke || process.platform !== 'win32' || !readStartupSettings().enabled) return;
  try {
    if (!app.getLoginItemSettings({ args: ['--gptplus-startup'] }).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, args: ['--gptplus-startup'] });
    }
  } catch (err) {
    ctx?.log?.({ level: 'warn', msg: `迁移开机自启动设置失败: ${err.message}` });
  }
}

let loginChatGptLaunchRequested = false;

async function launchChatGptAtLogin(commandLine = process.argv) {
  if (isDev || isSmoke || typeof app.getLoginItemSettings !== 'function') return;
  let openedAtLogin = commandLine.includes('--gptplus-startup');
  try {
    // wasOpenedAtLogin is macOS-only; Windows login entries carry an explicit marker.
    if (process.platform === 'darwin') openedAtLogin = !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return;
  }
  const startup = readStartupSettings();
  if (!openedAtLogin || !startup.enabled || startup.target !== 'both' || loginChatGptLaunchRequested) return;
  loginChatGptLaunchRequested = true;

  const preferredPath = ctx?.store?.get?.()?.chatgpt?.executablePath || null;
  try {
    // 日志里必须区分“已请求唤起”和“客户端真的起来了”：登录时没有界面反馈，
    // 只 spawn explorer 成功并不代表 ChatGPT 主窗口出现。
    const result = await launchChatGptAndVerify({ preferredPath });
    if (result.ok) {
      ctx?.log?.({
        level: 'info',
        msg: `已按开机自启动设置启动 ChatGPT 客户端（PID ${result.pid ?? '未知'}`
          + `${result.appId ? `，应用入口 ${result.appId}` : ''}）: ${result.exe}`,
      });
    } else {
      ctx?.log?.({ level: 'warn', msg: `开机自启动 ChatGPT 失败: ${result.error}` });
    }
  } catch (err) {
    ctx?.log?.({ level: 'warn', msg: `开机自启动 ChatGPT 失败: ${err.message}` });
  }
}

function createTray() {
  if (isSmoke || tray) return;
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip('gpt++');
  tray.on('click', () => {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    else showWindow();
  });
  refreshTrayMenu();
}

function createWindow() {
  windowReady = false;
  const savedTheme = ctx?.store?.get?.()?.theme || 'dark';
  const resolvedTheme = savedTheme === 'system'
    ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    : savedTheme === 'light' ? 'light' : 'dark';
  let rendererReady = false;
  let readyFallback = null;

  const showWhenReady = (rendererTheme = resolvedTheme) => {
    if (rendererReady || !win || win.isDestroyed()) return;
    const visibleTheme = rendererTheme === 'light' ? 'light' : 'dark';
    // renderer 已完成首帧主题计算后，再同步原生窗口底色，避免两套主题短暂不一致。
    win.setBackgroundColor(visibleTheme === 'light' ? '#e9edf2' : '#07080a');
    rendererReady = true;
    windowReady = true;
    if (readyFallback) {
      clearTimeout(readyFallback);
      readyFallback = null;
    }
    win.setOpacity(1);
    win.show();
  };

  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    // 原生窗口先用已保存主题的底色，避免页面加载期间出现黑色首帧。
    backgroundColor: resolvedTheme === 'light' ? '#e9edf2' : '#07080a',
    show: false,
    // Windows 合成器在隐藏窗口首次提交 surface 时可能短暂使用黑色；透明度归零可以把这次提交隔离在不可见状态。
    opacity: 0,
    title: 'gpt++',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // preload 在样式表计算前同步注入主题，renderer 不必等待异步 IPC。
      additionalArguments: [
        `--gptplus-theme=${savedTheme}`,
        `--gptplus-resolved-theme=${resolvedTheme}`,
      ],
    },
  });

  const onRendererReady = (event, rendererTheme) => {
    if (event.sender === win?.webContents) showWhenReady(rendererTheme);
  };
  ipcMain.on('gptplus:renderer-ready', onRendererReady);
  // 渲染脚本异常时也不要让窗口永久隐藏；此时至少仍然是正确主题的窗口。
  readyFallback = setTimeout(showWhenReady, 4000);

  const lifecycle = createWindowLifecycle({
    isSmoke,
    isQuitting: () => isQuitting,
    hideWindow: () => win?.hide(),
  });
  win.on('close', (event) => lifecycle.handleClose(event));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: {
      theme: savedTheme,
      resolvedTheme,
    },
  });
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  if (isSmoke) {
    win.webContents.on('did-finish-load', async () => {
      try {
        // 给渲染层的初始数据加载留出时间
        await new Promise((r) => setTimeout(r, 2500));
        // --smoke-view models|settings|providers 切换页面后再抓取
        const smokeView = argValue('--smoke-view');
        if (smokeView) {
          await win.webContents.executeJavaScript(`(() => {
            const byData = document.querySelector('[data-view="${smokeView}"]');
            if (byData) { byData.click(); return 'data-view'; }
            const nav = Array.from(document.querySelectorAll('nav button, nav a, aside button'));
            const hit = nav.find((b) => (b.textContent || '').includes(${JSON.stringify(smokeView)}));
            if (hit) { hit.click(); return 'text'; }
            return 'not-found';
          })()`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        // --smoke-open log|form：展开日志抽屉 / 打开提供商表单，用于截图核对覆盖层
        const smokeOpen = argValue('--smoke-open');
        if (smokeOpen) {
          await win.webContents.executeJavaScript(`(() => {
            const want = ${JSON.stringify(smokeOpen)};
            const btn = want === 'log'
              ? document.getElementById('log-toggle')
              : Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('添加提供商'));
            if (btn) btn.click();
            return btn ? 'ok' : 'not-found';
          })()`);
          await new Promise((r) => setTimeout(r, 900));
        }
        const report = await win.webContents.executeJavaScript(`(() => {
          const app = document.querySelector('#app') || document.body;
          return {
            title: document.title,
            navItems: Array.from(document.querySelectorAll('[data-nav], .nav-item, nav a, nav button')).map(e => (e.textContent||'').trim()).filter(Boolean),
            textLength: (app.innerText || '').length,
            text: (app.innerText || '').slice(0, 4000),
            buttons: Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 60),
            errors: Array.from(window.__gptplusErrors || []),
            hasApi: typeof window.gptplus === 'object' && window.gptplus !== null,
            apiKeys: window.gptplus ? Object.keys(window.gptplus) : [],
          };
        })()`);
        if (smokeDump) fs.writeFileSync(smokeDump, JSON.stringify(report, null, 2), 'utf8');
        if (smokeShot) {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(smokeShot, img.toPNG());
        }
        console.log('[smoke] ok ' + JSON.stringify({ title: report.title, hasApi: report.hasApi, textLength: report.textLength, errors: report.errors.length }));
      } catch (err) {
        console.error('[smoke] failed: ' + (err && err.message ? err.message : String(err)));
        process.exitCode = 1;
      } finally {
        setTimeout(() => app.quit(), 300);
      }
    });
  }

  win.on('closed', () => {
    ipcMain.removeListener('gptplus:renderer-ready', onRendererReady);
    if (readyFallback) clearTimeout(readyFallback);
    windowReady = false;
    win = null;
  });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

async function boot() {
  const { createContext } = require('../core/context.js');
  const secretStorage = {
    isAvailable: () => safeStorage.isEncryptionAvailable()
      && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (bytes) => safeStorage.decryptString(bytes),
  };
  ctx = await createContext({
    onStatus: (s) => broadcast('gptplus:status', s),
    onQqInstall: (s) => broadcast('gptplus:qqbot:install', s),
    onQqLaunch: (s) => broadcast('gptplus:qqbot:launch', s),
    appVersion: app.getVersion(),
    secretStorage,
  });

  // 更新只在收到用户明确操作后下载；启动检测本身只广播可用版本。
  const updater = setupAutoUpdater({
    app,
    autoUpdater,
    isDev,
    isSmoke,
    fetchImpl: ctx.network,
    onState: (state) => broadcast('gptplus:update', state),
    onLog: (entry) => {
      ctx.log?.(entry);
      broadcast('gptplus:log', entry);
    },
  });

  void cleanupInstalledUpdateCache({ app }).then((cleaned) => {
    if (cleaned) ctx.log?.({ at: Date.now(), level: 'info', msg: '已清理已安装版本的更新缓存' });
  });

  const { registerIpc } = require('../core/ipc.js');
  registerIpc({
    ipcMain,
    shell,
    dialog,
    clipboard,
    secretStorage,
    ctx,
    updater,
    startup: { get: readStartupSettings, set: writeStartupSettings },
    onStatus: (s) => broadcast('gptplus:status', s),
    onLog: (e) => broadcast('gptplus:log', e),
  });

  migrateStartupSettings();
  createWindow();
  createTray();
  if (updater.enabled) {
    // 启动即检测：checkForUpdates 是纯异步网络请求，不会拖慢首屏；
    // 窗口尚未加载完时渲染层会在 boot 里通过 getUpdateState 补读最新状态。
    void updater.checkForUpdates();
  }

  // 网关启动需要等待端口监听，不应阻塞窗口和首屏；完成后再广播最新状态。
  const gatewayReady = (async () => {
    try {
      await ctx.gateway.autoStart();
    } catch (err) {
      broadcast('gptplus:log', {
        at: Date.now(), level: 'error', msg: '网关自动启动失败: ' + err.message,
      });
    } finally {
      // QQ 助手开启且配置了启动命令时，后台拉起 NapCat（离线才拉，不阻塞启动）。
      void ctx.qqBot.maybeAutoLaunch();
      ctx.emitStatus?.();
      refreshTrayMenu();
    }
  })();
  void gatewayReady.then(() => launchChatGptAtLogin());

  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--quit')) {
      quitApplication();
      return;
    }
    showWindow();
    void gatewayReady.then(() => launchChatGptAtLogin(commandLine));
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await boot();

  app.on('activate', () => {
    showWindow();
  });
}).catch((err) => {
  dialog.showErrorBox('无法启动 gpt++', err?.code === 'SECURE_STORAGE_ERROR'
    ? err.message
    : '无法安全加载本机配置，请检查配置文件和系统安全存储后重试');
  process.exitCode = 1;
  app.quit();
});

app.on('window-all-closed', () => {
  if (isSmoke) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  try {
    ctx?.remoteSync?.stop?.();
    ctx?.taskCenter?.stop?.();
    ctx?.gateway?.stopSync?.();
  } catch {
    /* 退出阶段尽力而为 */
  }
});

process.on('uncaughtException', (err) => {
  const cfg = ctx?.store?.get?.() || {};
  const peerSecrets = (cfg.remoteSync?.connections || []).map((connection) => ({
    baseUrl: connection.baseUrl, apiKey: connection.authToken, headers: {},
  }));
  const diagnostic = require('../core/redact.js').redactDiagnostic(
    err && err.stack ? err.stack : String(err), [...(cfg.providers || []), ...peerSecrets],
  );
  broadcast('gptplus:log', {
    at: Date.now(), level: 'error', msg: '未捕获异常: ' + diagnostic,
  });
});
