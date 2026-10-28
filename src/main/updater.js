'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPDATER_CACHE_DIR = 'gptplus-updater';
const RELEASES_API_BASE = 'https://api.github.com/repos/ailuo04/gptplus/releases';
const RELEASES_API = `${RELEASES_API_BASE}?per_page=100`;
const RELEASE_TAG_BASE = 'https://github.com/ailuo04/gptplus/releases/tag';
const RELEASE_DOWNLOAD_BASE = 'https://github.com/ailuo04/gptplus/releases/download';
const INITIAL_CHECK_DELAY_MS = 20 * 1000;
const DEFAULT_CHECK_INTERVAL_MINUTES = 60;
const MIN_CHECK_INTERVAL_MINUTES = 5;
const MAX_CHECK_INTERVAL_MINUTES = 1440;
const MAX_UPDATE_HIGHLIGHTS = 4;
const MAX_UPDATE_HIGHLIGHT_CHARS = 96;
const SUMMARY_HEADING_RE = /^(?:软件内更新摘要|本次更新|更新内容|更新摘要|highlights?)$/i;
const UPDATE_SECTION_RE = /(?:新增|修复|改进|优化|变更|更新|亮点|features?|fix(?:es)?|improvements?|changes?)/i;
const NON_UPDATE_SECTION_RE = /(?:兼容性|验证|测试|安装|校验|发布说明|compatibility|verification|testing|installation|release checks?)/i;

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

function cleanMarkdownText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateUpdateHighlight(value, maxChars = MAX_UPDATE_HIGHLIGHT_CHARS) {
  const text = cleanMarkdownText(value).replace(/[，,；;：:\s]+$/g, '');
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').replace(/[，,；;：:\s]+$/g, '')}…`;
}

function parseHeading(line) {
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(String(line || ''));
  if (!match) return null;
  return { level: match[1].length, title: cleanMarkdownText(match[2]) };
}

function parseBullet(line) {
  const source = String(line || '');
  const markdown = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(source);
  if (markdown) return cleanMarkdownText(markdown[1]);
  const html = /^\s*<li\b[^>]*>(.*?)<\/li>\s*$/i.exec(source);
  return html ? cleanMarkdownText(html[1]) : '';
}

/** 从 Release Markdown 提取软件内显示的精简更新要点。 */
function extractUpdateHighlights(markdown, options = {}) {
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : MAX_UPDATE_HIGHLIGHTS;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : MAX_UPDATE_HIGHLIGHT_CHARS;
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const seen = new Set();
  const add = (line) => {
    const text = truncateUpdateHighlight(parseBullet(line) || line, maxChars);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    output.push(text);
  };

  let summary = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (heading && SUMMARY_HEADING_RE.test(heading.title)) {
      summary = { start: index + 1, level: heading.level };
      break;
    }
  }
  if (summary) {
    for (let index = summary.start; index < lines.length && output.length < maxItems; index += 1) {
      const heading = parseHeading(lines[index]);
      if (heading && heading.level <= summary.level) break;
      if (parseBullet(lines[index])) add(lines[index]);
    }
  }

  if (!output.length) {
    let updateLevel = 0;
    let excludedLevel = 0;
    for (const line of lines) {
      const heading = parseHeading(line);
      if (heading) {
        if (excludedLevel && heading.level <= excludedLevel) excludedLevel = 0;
        if (NON_UPDATE_SECTION_RE.test(heading.title)) {
          excludedLevel = heading.level;
          updateLevel = 0;
        } else if (UPDATE_SECTION_RE.test(heading.title)) {
          updateLevel = heading.level;
        } else if (updateLevel && heading.level <= updateLevel) {
          updateLevel = 0;
        }
        continue;
      }
      if (!excludedLevel && parseBullet(line)) add(line);
      if (output.length >= maxItems) break;
    }
  }
  return output.slice(0, maxItems);
}

function releasePageUrl(version) {
  const parsed = stableVersion(version);
  return parsed ? `${RELEASE_TAG_BASE}/v${parsed.value}` : null;
}

/** 读取某个已发布版本的摘要；失败时由调用方保留更新能力，不阻塞下载。 */
async function fetchReleaseDetails(version, options = {}) {
  const parsed = stableVersion(version);
  if (!parsed) throw new Error('更新版本格式无效');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前环境无法连接 GitHub');
  const response = await fetchImpl(`${RELEASES_API_BASE}/tags/v${parsed.value}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gptplus-updater',
    },
  });
  if (!response.ok) throw new Error(`读取更新说明失败（HTTP ${response.status}）`);
  const release = await response.json();
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('GitHub 返回的更新说明格式无效');
  }
  return {
    highlights: extractUpdateHighlights(release.body),
    releaseNotesUrl: releasePageUrl(parsed.value),
  };
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
    highlights: [],
    notesStatus: 'idle',
    releaseNotesUrl: null,
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
    publish({
      status: 'latest', version: null, rollbackTarget: null, releaseDate: null,
      highlights: [], notesStatus: 'idle', releaseNotesUrl: null,
      percent: 0, error: null, lastCheckedAt: Date.now(),
    });
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
    const version = String(info.version || '');
    publish({
      status: 'available',
      version,
      releaseDate: info.releaseDate || null,
      rollbackTarget,
      highlights: [],
      notesStatus: version ? 'loading' : 'idle',
      releaseNotesUrl: releasePageUrl(version),
      percent: 0,
      error: null,
      lastCheckedAt: Date.now(),
    });
    log('info', `发现新版本 ${version}，等待用户选择更新时机`);
    if (version) {
      void fetchReleaseDetails(version, { fetchImpl }).then((details) => {
        if (state.version !== version || !['available', 'downloading', 'downloaded'].includes(state.status)) return;
        publish({
          highlights: details.highlights,
          releaseNotesUrl: details.releaseNotesUrl,
          notesStatus: 'ready',
        });
      }).catch((error) => {
        if (state.version !== version || !['available', 'downloading', 'downloaded'].includes(state.status)) return;
        publish({ notesStatus: 'error' });
        log('warn', `读取 v${version} 更新摘要失败: ${error.message}`);
      });
    }
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

module.exports = {
  setupAutoUpdater,
  cleanupInstalledUpdateCache,
  listRollbackReleases,
  extractUpdateHighlights,
  fetchReleaseDetails,
  releasePageUrl,
};
