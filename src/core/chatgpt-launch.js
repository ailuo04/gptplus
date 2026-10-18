'use strict';

const { spawn } = require('node:child_process');
const { resolveChatGptExe } = require('./chatgpt-install.js');

/**
 * 启动 ChatGPT 客户端。这里不结束已有进程，Windows 的单实例机制会把启动请求交给现有客户端。
 * @param {{ preferredPath?: string|null, resolveExe?: Function, spawnImpl?: Function }} options
 * @returns {Promise<{ok:boolean, exe?:string, error?:string}>}
 */
async function launchChatGpt(options = {}) {
  const resolveExe = options.resolveExe || resolveChatGptExe;
  const spawnImpl = options.spawnImpl || spawn;
  const exe = await resolveExe({ preferredPath: options.preferredPath || null });
  if (!exe) return { ok: false, error: '找不到 ChatGPT.exe' };

  try {
    const child = spawnImpl(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, exe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { launchChatGpt };
