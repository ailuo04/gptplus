'use strict';

/**
 * Configure GitHub Release auto-updates.
 * Development, smoke-test, and unpackaged runs skip network update checks.
 * @param {{ app: any, autoUpdater: any, dialog: any, getWindow?: () => any,
 *   isDev?: boolean, isSmoke?: boolean, onLog?: (entry: object) => void }} options
 * @returns {{ enabled: boolean, checkForUpdates: () => Promise<any> }}
 */
function setupAutoUpdater(options = {}) {
  const {
    app,
    autoUpdater,
    dialog,
    getWindow = () => null,
    isDev = false,
    isSmoke = false,
    onLog = () => {},
  } = options;

  const disabled = isDev || isSmoke || !app?.isPackaged || process.platform === 'linux';
  if (disabled) {
    return { enabled: false, checkForUpdates: async () => null };
  }

  let checking = false;
  let downloading = false;

  const log = (level, msg) => {
    onLog({ at: Date.now(), level, msg });
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log('info', '正在检查 gpt++ 更新');
  });

  autoUpdater.on('update-not-available', () => {
    checking = false;
    log('info', '当前已是最新版本');
  });

  autoUpdater.on('update-available', () => {
    checking = false;
    if (downloading) return;
    downloading = true;
    log('info', '发现新版本，正在后台下载');
    Promise.resolve(autoUpdater.downloadUpdate()).catch((err) => {
      downloading = false;
      log('error', `更新下载失败: ${err.message}`);
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent);
    if (Number.isFinite(percent)) {
      log('info', `更新下载进度: ${percent.toFixed(0)}%`);
    }
  });

  autoUpdater.on('update-downloaded', async () => {
    downloading = false;
    log('info', '更新已下载完成');
    const result = await dialog.showMessageBox(getWindow(), {
      type: 'info',
      title: 'gpt++ 有新版本',
      message: '更新已经下载完成，是否现在重启安装？',
      buttons: ['立即重启', '稍后安装'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      app.isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (err) => {
    checking = false;
    downloading = false;
    log('error', `自动更新失败: ${err.message}`);
  });

  return {
    enabled: true,
    async checkForUpdates() {
      if (checking || downloading) return null;
      checking = true;
      try {
        return await autoUpdater.checkForUpdates();
      } catch (err) {
        checking = false;
        log('warn', `检查更新失败: ${err.message}`);
        return null;
      }
    },
  };
}

module.exports = { setupAutoUpdater };
