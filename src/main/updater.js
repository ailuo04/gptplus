'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPDATER_CACHE_DIR = 'gptplus-updater';
const RELEASES_API = 'https://api.github.com/repos/ailuo04/gptplus/releases?per_page=100';
const RELEASE_DOWNLOAD_BASE = 'https://github.com/ailuo04/gptplus/releases/download';
const INITIAL_CHECK_DELAY_MS = 20 * 1000;
const DEFAULT_CHECK_INTERVAL_MINUTES = 60;
const MIN_CHECK_INTERVAL_MINUTES = 5;
const MAX_CHECK_INTERVAL_MINUTES = 1440;

function stableVersion(value) {
  const match = String(value || '').replace(/^v/i, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? { value: match[0], parts: match.slice(1).map(Number) } : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1;
  }
  return 0;
}

function normalizeCheckIntervalMinutes(value) {
  const candidate = Number(value);
  return Number.isInteger(candidate)
    && candidate >= MIN_CHECK_INTERVAL_MINUTES
    && candidate <= MAX_CHECK_INTERVAL_MINUTES
    ? candidate
    : DEFAULT_CHECK_INTERVAL_MINUTES;
}

async function listRollbackReleases({ currentVersion, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境无法连接 GitHub');
  const current = stableVersion(currentVersion);
  if (!current) throw new Error('当前应用版本格式无效');
  const url = new URL(RELEASES_API);
  const releases = [];
  for (let page = 1; page <= 3; page += 1) {
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`读取 GitHub 历史版本失败（HTTP ${response.status}）`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub 返回的版本列表格式无效');
    for (const release of batch) {
      const parsedVersion = stableVersion(release.tag_name);
      if (!parsedVersion || release.draft || release.prerelease || compareVersions(parsedVersion, current) >= 0) continue;
      const assets = new Set((release.assets || []).map((asset) => asset.name));
      if (!assets.has(`gpt-plus-${parsedVersion.value}-setup.exe`) || !assets.has('latest.yml')) continue;
      releases.push({ version: parsedVersion.value, name: String(release.name || `v${parsedVersion.value}`), publishedAt: release.published_at || null });
    }
    if (batch.length < 100) break;
  }
  return releases.sort((a, b) => compareVersions(stableVersion(b.version), stableVersion(a.version)));
}

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
 *   onLog?: (entry: object) => void, onState?: (state: object) => void,
 *   checkIntervalMinutes?: number, initialCheckDelayMs?: number, timers?: object }} options
 * @returns {{ enabled: boolean, getState: () => object, checkForUpdates: () => Promise<any>,
 *   setCheckIntervalMinutes: (value: number) => object, stopAutomaticChecks: () => void,
 *   downloadUpdate: () => Promise<object> }} 更新控制器
 */
function setupAutoUpdater(options = {}) {
  const {
    app,
    autoUpdater,
    isDev = false,
    isSmoke = false,
    fetchImpl = globalThis.fetch,
    onLog = () => {},
    onState = () => {},
    checkIntervalMinutes = DEFAULT_CHECK_INTERVAL_MINUTES,
    initialCheckDelayMs = INITIAL_CHECK_DELAY_MS,
    timers = globalThis,
  } = options;

  const disabled = isDev || isSmoke || !app?.isPackaged || process.platform === 'linux';
  const state = {
    enabled: !disabled,
    status: disabled ? 'disabled' : 'idle',
    currentVersion: String(app?.getVersion?.() || ''),
    version: null,
    rollbackTarget: null,
    releaseDate: null,
    percent: 0,
    error: null,
    lastCheckedAt: null,
    checkIntervalMinutes: normalizeCheckIntervalMinutes(checkIntervalMinutes),
    initialCheckDelaySeconds: INITIAL_CHECK_DELAY_MS / 1000,
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
      setCheckIntervalMinutes: (value) => {
        const next = normalizeCheckIntervalMinutes(value);
        if (next !== state.checkIntervalMinutes) publish({ checkIntervalMinutes: next });
        return { ...state };
      },
      stopAutomaticChecks: () => {},
      downloadUpdate: async () => ({ ...state }),
      listRollbackReleases: async () => [],
      rollbackToVersion: async () => ({ ...state }),
    };
  }

  let checking = false;
  let downloading = false;
  let installAfterDownload = false;
  let rollbackTarget = null;
  let initialCheckTimer = null;
  let intervalTimer = null;

  const log = (level, msg) => {
    onLog({ at: Date.now(), level, msg });
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // 保留 electron-updater 的 blockmap 差分下载，减少更新时的网络流量。
  autoUpdater.disableDifferentialDownload = false;

  const clearTimer = (timer) => {
    if (timer !== null && typeof timers.clearTimeout === 'function') timers.clearTimeout(timer);
  };
  const clearIntervalTimer = (timer) => {
    if (timer !== null && typeof timers.clearInterval === 'function') timers.clearInterval(timer);
  };
  const unrefTimer = (timer) => {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };

  const resetRollbackFeed = () => {
    rollbackTarget = null;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.setFeedURL({ provider: 'github', owner: 'ailuo04', repo: 'gptplus' });
  };

  const beginDownload = async () => {
    if (downloading || state.status !== 'available') return { ...state };
    downloading = true;
    installAfterDownload = true;
    publish({ status: 'downloading', percent: 0, error: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      downloading = false;
      installAfterDownload = false;
      if (rollbackTarget) resetRollbackFeed();
      publish({ status: 'error', rollbackTarget: null, error: err.message });
      log('error', `更新下载失败: ${err.message}`);
    }
    return { ...state };
  };

  autoUpdater.on('checking-for-update', () => {
    checking = true;
    publish({ status: 'checking', error: null });
    log('info', '正在检查 gpt++ 更新');
  });

  autoUpdater.on('update-not-available', () => {
    checking = false;
    if (rollbackTarget) {
      const version = rollbackTarget;
      resetRollbackFeed();
      publish({ status: 'error', version: null, rollbackTarget: null, error: `无法回退到 v${version}，请确认该版本仍可用` });
      return;
    }
    publish({ status: 'latest', version: null, rollbackTarget: null, releaseDate: null, percent: 0, error: null, lastCheckedAt: Date.now() });
    log('info', '当前已是最新版本');
  });

  autoUpdater.on('update-available', (info = {}) => {
    checking = false;
    if (rollbackTarget && String(info.version) !== rollbackTarget) {
      const requested = rollbackTarget;
      resetRollbackFeed();
      publish({ status: 'error', version: null, rollbackTarget: null, error: `版本校验不匹配：请求 v${requested}，服务器返回 v${info.version}` });
      return;
    }
    publish({
      status: 'available',
      version: String(info.version || ''),
      releaseDate: info.releaseDate || null,
      rollbackTarget,
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
    if (rollbackTarget) resetRollbackFeed();
    publish({ status: 'error', rollbackTarget: null, error: err.message, lastCheckedAt: Date.now() });
    log('error', `自动更新失败: ${err.message}`);
  });

  const checkForUpdates = async () => {
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
  };

  const scheduleIntervalCheck = () => {
    clearIntervalTimer(intervalTimer);
    intervalTimer = null;
    if (typeof timers.setInterval !== 'function') return;
    intervalTimer = unrefTimer(timers.setInterval(
      () => { void checkForUpdates(); },
      state.checkIntervalMinutes * 60 * 1000,
    ));
  };

  const scheduleAutomaticChecks = () => {
    clearTimer(initialCheckTimer);
    initialCheckTimer = null;
    if (typeof timers.setTimeout !== 'function') return;
    initialCheckTimer = unrefTimer(timers.setTimeout(async () => {
      initialCheckTimer = null;
      await checkForUpdates();
      scheduleIntervalCheck();
    }, Math.max(0, Number(initialCheckDelayMs) || 0)));
  };

  const stopAutomaticChecks = () => {
    clearTimer(initialCheckTimer);
    clearIntervalTimer(intervalTimer);
    initialCheckTimer = null;
    intervalTimer = null;
  };

  const setCheckIntervalMinutes = (value) => {
    const next = normalizeCheckIntervalMinutes(value);
    if (next !== state.checkIntervalMinutes) {
      publish({ checkIntervalMinutes: next });
      if (intervalTimer !== null) scheduleIntervalCheck();
    }
    return { ...state };
  };

  scheduleAutomaticChecks();

  return {
    enabled: true,
    getState: () => ({ ...state }),
    checkForUpdates,
    setCheckIntervalMinutes,
    stopAutomaticChecks,
    async listRollbackReleases() {
      if (checking || downloading) return [];
      return listRollbackReleases({ currentVersion: state.currentVersion, fetchImpl });
    },
    async rollbackToVersion(requestedVersion) {
      if (checking || downloading) return { ...state };
      const parsedVersion = stableVersion(requestedVersion);
      const currentVersion = stableVersion(state.currentVersion);
      if (!parsedVersion || !currentVersion || compareVersions(parsedVersion, currentVersion) >= 0) throw new Error('只能回退到有效的较早版本');
      const version = parsedVersion.value;
      const releases = await listRollbackReleases({ currentVersion: state.currentVersion, fetchImpl });
      if (!releases.some((release) => release.version === version)) throw new Error('所选版本不存在、已撤回，或缺少有效安装文件');
      rollbackTarget = version;
      checking = true;
      autoUpdater.allowDowngrade = true;
      autoUpdater.disableDifferentialDownload = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: `${RELEASE_DOWNLOAD_BASE}/v${version}/` });
      publish({ status: 'checking', version, rollbackTarget: version, error: null, percent: 0 });
      log('warn', `用户请求回退到 v${version}`);
      try {
        const result = await autoUpdater.checkForUpdates();
        const resultVersion = String(result?.updateInfo?.version || result?.versionInfo?.version || '');
        if (result?.isUpdateAvailable === false || (resultVersion && resultVersion !== version)) {
          checking = false;
          resetRollbackFeed();
          publish({ status: 'error', version: null, rollbackTarget: null, error: `版本 v${version} 当前不可安装` });
          return { ...state };
        }
        if (state.status !== 'available' || state.version !== version) {
          checking = false;
          resetRollbackFeed();
          publish({ status: 'error', version: null, rollbackTarget: null, error: `版本 v${version} 当前不可安装` });
          return { ...state };
        }
        checking = false;
        return beginDownload();
      } catch (err) {
        checking = false;
        resetRollbackFeed();
        publish({ status: 'error', version: null, rollbackTarget: null, error: err.message });
        log('error', `回退到 v${version} 失败: ${err.message}`);
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
      return beginDownload();
    },
  };
}

module.exports = { setupAutoUpdater, cleanupInstalledUpdateCache, listRollbackReleases };
