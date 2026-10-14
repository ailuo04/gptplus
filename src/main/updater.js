'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPDATER_CACHE_DIR = 'gptplus-updater';

/**
 * 新版本启动后整理更新缓存，保留差分更新所需的当前版本基准。
 * 已安装版本的安装器和 blockmap 会提升到缓存根目录，pending 副本随后删除。
 */
async function cleanupInstalledUpdateCache(options = {}) {
  const {
    app,
    platform = process.platform,
    env = process.env,
    fileSystem = fs.promises,
    homeDir = os.homedir(),
  } = options;
  if (platform !== 'win32' || !app?.isPackaged || typeof app.getVersion !== 'function') return false;

  const currentVersion = String(app.getVersion() || '');
  const currentParts = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!currentParts) return false;

  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const cacheRoot = path.resolve(localAppData);
  const cacheDir = path.resolve(cacheRoot, UPDATER_CACHE_DIR);
  if (path.dirname(cacheDir) !== cacheRoot || path.basename(cacheDir) !== UPDATER_CACHE_DIR) return false;

  const pendingDir = path.join(cacheDir, 'pending');
  let updateInfo;
  try {
    updateInfo = JSON.parse(await fileSystem.readFile(path.join(pendingDir, 'update-info.json'), 'utf8'));
  } catch {
    return false;
  }

  const cachedVersion = String(updateInfo?.fileName || '').match(/^gpt-plus-(\d+)\.(\d+)\.(\d+)-setup\.exe$/);
  if (!cachedVersion) return false;
  const installed = currentParts.slice(1).map(Number);
  const cached = cachedVersion.slice(1).map(Number);
  let comparison = 0;
  for (let index = 0; index < installed.length; index += 1) {
    if (cached[index] !== installed[index]) {
      comparison = cached[index] > installed[index] ? 1 : -1;
      break;
    }
  }
  if (comparison > 0) return false;

  try {
    if (comparison < 0) {
      await fileSystem.rm(pendingDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      return true;
    }

    const pendingInstaller = path.join(pendingDir, updateInfo.fileName);
    const currentInstaller = path.join(cacheDir, 'installer.exe');
    const pendingBlockMap = path.join(pendingDir, 'current.blockmap');
    const currentBlockMap = path.join(cacheDir, 'current.blockmap');
    await fileSystem.copyFile(pendingInstaller, currentInstaller);
    try {
      await fileSystem.copyFile(pendingBlockMap, currentBlockMap);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fileSystem.rm(currentBlockMap, { force: true });
    }
    await fileSystem.rm(pendingDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 配置 GitHub Release 自动更新。
 * 开发模式、冒烟测试和未打包运行时不执行网络更新检查。
 * @param {{ app: any, autoUpdater: any, isDev?: boolean, isSmoke?: boolean,
 *   onLog?: (entry: object) => void, onState?: (state: object) => void }} options
 * @returns {{ enabled: boolean, getState: () => object, checkForUpdates: () => Promise<any>,
 *   downloadUpdate: () => Promise<object> }} 更新控制器
 */
function setupAutoUpdater(options = {}) {
  const {
    app,
    autoUpdater,
    isDev = false,
    isSmoke = false,
    onLog = () => {},
    onState = () => {},
  } = options;

  const disabled = isDev || isSmoke || !app?.isPackaged || process.platform === 'linux';
  const state = {
    enabled: !disabled,
    status: disabled ? 'disabled' : 'idle',
    currentVersion: String(app?.getVersion?.() || ''),
    version: null,
    releaseDate: null,
    percent: 0,
    error: null,
    lastCheckedAt: null,
  };
  const publish = (patch = {}) => {
    Object.assign(state, patch);
    onState({ ...state });
  };

  if (disabled) {
    return {
      enabled: false,
      getState: () => ({ ...state }),
      checkForUpdates: async () => ({ ...state }),
      downloadUpdate: async () => ({ ...state }),
    };
  }

  let checking = false;
  let downloading = false;
  let installAfterDownload = false;

  const log = (level, msg) => {
    onLog({ at: Date.now(), level, msg });
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // 保留 electron-updater 的 blockmap 差分下载，减少更新时的网络流量。
  autoUpdater.disableDifferentialDownload = false;

  autoUpdater.on('checking-for-update', () => {
    checking = true;
    publish({ status: 'checking', error: null });
    log('info', '正在检查 gpt++ 更新');
  });

  autoUpdater.on('update-not-available', () => {
    checking = false;
    publish({ status: 'latest', version: null, releaseDate: null, percent: 0, error: null, lastCheckedAt: Date.now() });
    log('info', '当前已是最新版本');
  });

  autoUpdater.on('update-available', (info = {}) => {
    checking = false;
    publish({
      status: 'available',
      version: String(info.version || ''),
      releaseDate: info.releaseDate || null,
      percent: 0,
      error: null,
      lastCheckedAt: Date.now(),
    });
    log('info', `发现新版本 ${info.version || ''}，等待用户选择更新时机`);
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent);
    if (Number.isFinite(percent)) {
      publish({ status: 'downloading', percent: Math.max(0, Math.min(100, percent)), error: null });
      log('info', `更新下载进度: ${percent.toFixed(0)}%`);
    }
  });

  autoUpdater.on('update-downloaded', () => {
    downloading = false;
    publish({ status: 'downloaded', percent: 100, error: null });
    log('info', '更新已下载完成');
    if (installAfterDownload) {
      installAfterDownload = false;
      app.isQuitting = true;
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 250);
    }
  });

  autoUpdater.on('error', (err) => {
    checking = false;
    downloading = false;
    installAfterDownload = false;
    publish({ status: 'error', error: err.message, lastCheckedAt: Date.now() });
    log('error', `自动更新失败: ${err.message}`);
  });

  return {
    enabled: true,
    getState: () => ({ ...state }),
    async checkForUpdates() {
      if (checking || downloading) return { ...state };
      checking = true;
      publish({ status: 'checking', error: null });
      try {
        return await autoUpdater.checkForUpdates();
      } catch (err) {
        checking = false;
        publish({ status: 'error', error: err.message, lastCheckedAt: Date.now() });
        log('warn', `检查更新失败: ${err.message}`);
        return { ...state };
      }
    },
    /** 用户明确点击更新后才下载，并在下载完成后重启安装。 */
    async downloadUpdate() {
      if (downloading) return { ...state };
      if (state.status === 'downloaded') {
        app.isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
        return { ...state };
      }
      if (state.status !== 'available') return { ...state };
      downloading = true;
      installAfterDownload = true;
      publish({ status: 'downloading', percent: 0, error: null });
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        downloading = false;
        installAfterDownload = false;
        publish({ status: 'error', error: err.message });
        log('error', `更新下载失败: ${err.message}`);
      }
      return { ...state };
    },
  };
}

module.exports = { setupAutoUpdater, cleanupInstalledUpdateCache };
