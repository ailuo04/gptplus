'use strict';

const { spawn } = require('node:child_process');
const { resolveChatGptExe, resolveChatGptAppId } = require('./chatgpt-install.js');

/**
 * 启动 ChatGPT 客户端。这里不结束已有进程，Windows 的单实例机制会把启动请求交给现有客户端。
 * @param {{ preferredPath?: string|null, resolveExe?: Function, resolveAppId?: Function, spawnImpl?: Function }} options
 * @returns {Promise<{ok:boolean, exe?:string, error?:string}>}
 */
async function launchChatGpt(options = {}) {
  const resolveExe = options.resolveExe || resolveChatGptExe;
  const resolveAppId = options.resolveAppId || resolveChatGptAppId;
  const spawnImpl = options.spawnImpl || spawn;
  const exe = await resolveExe({ preferredPath: options.preferredPath || null });
  if (!exe) return { ok: false, error: '找不到 ChatGPT.exe' };

  const start = (command, args, windowsHide) => new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  // Shell activation requests the app's foreground window, including an existing tray instance.
  try {
    const appId = await resolveAppId({ executablePath: exe });
    if (appId) {
      await start('explorer.exe', [`shell:AppsFolder\\${appId}`], true);
      return { ok: true, exe };
    }
  } catch {
    // Non-package installs and unavailable shell activation still support direct launch.
  }

  try {
    await start(exe, [], false);
    return { ok: true, exe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { launchChatGpt };
