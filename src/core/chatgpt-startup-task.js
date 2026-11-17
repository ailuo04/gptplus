'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveChatGptExe,
  packageFamilyFromPath,
  _internal: { execText },
} = require('./chatgpt-install.js');

// MSIX 启动任务的用户状态保存在这里；任务管理器“启动应用”改的就是同一个值。
const SYSTEM_APP_DATA_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows'
  + '\\CurrentVersion\\AppModel\\SystemAppData';
const STATE_DISABLED_BY_USER = 1;
const STATE_ENABLED = 2;
const STATE_DISABLED_BY_POLICY = 3;
const STATE_ENABLED_BY_POLICY = 4;
const REG_TIMEOUT_MS = 4000;

const UNSUPPORTED = Object.freeze({ supported: false, enabled: false, locked: false });

/**
 * 从包根目录的 AppxManifest.xml 读出启动任务。
 * @returns {{taskId:string, enabledByDefault:boolean}|null}
 */
function readManifestStartupTask(executablePath, fsImpl = fs) {
  const normalized = path.win32.normalize(String(executablePath || ''));
  const match = /^(.*[\\/]WindowsApps[\\/][^\\/]+)[\\/]/i.exec(normalized);
  if (!match) return null;
  let manifest;
  try {
    manifest = fsImpl.readFileSync(path.win32.join(match[1], 'AppxManifest.xml'), 'utf8');
  } catch {
    return null;
  }
  const tag = /<(?:\w+:)?StartupTask\b[^>]*>/i.exec(String(manifest || ''));
  if (!tag) return null;
  const taskId = /\bTaskId="([^"]+)"/i.exec(tag[0]);
  if (!taskId || /[\\"\r\n]/.test(taskId[1])) return null;
  return {
    taskId: taskId[1],
    enabledByDefault: /\bEnabled="true"/i.test(tag[0]),
  };
}

/** 从 `reg query ... /v State` 的输出里取出 DWORD；没有该值时返回 null。 */
function parseRegState(raw) {
  const match = /^\s*State\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(String(raw || ''));
  return match ? parseInt(match[1], 16) : null;
}

async function locateStartupTask(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const resolveExe = options.resolveExe || resolveChatGptExe;
  let exe = null;
  try {
    exe = await resolveExe({ preferredPath: options.preferredPath || null });
  } catch {
    exe = null;
  }
  const family = exe ? packageFamilyFromPath(exe) : null;
  if (!family) return null;
  const task = readManifestStartupTask(exe, options.fsImpl || fs);
  if (!task) return null;
  return { ...task, key: `${SYSTEM_APP_DATA_KEY}\\${family}\\${task.taskId}` };
}

async function readState(task, run) {
  const raw = await run('reg.exe', ['query', task.key, '/v', 'State'], REG_TIMEOUT_MS);
  return parseRegState(raw);
}

function describeState(task, state) {
  const enabled = state === null
    ? task.enabledByDefault
    : state === STATE_ENABLED || state === STATE_ENABLED_BY_POLICY;
  return {
    supported: true,
    enabled,
    locked: state === STATE_ENABLED_BY_POLICY || state === STATE_DISABLED_BY_POLICY,
  };
}

/**
 * 读取 ChatGPT 客户端自带的开机启动任务状态。
 * 非 Windows、非 MSIX 安装或清单里没有启动任务时返回 supported=false。
 * @returns {Promise<{supported:boolean, enabled:boolean, locked:boolean}>}
 */
async function readChatGptStartupTask(options = {}) {
  const task = await locateStartupTask(options);
  if (!task) return { ...UNSUPPORTED };
  return describeState(task, await readState(task, options.execText || execText));
}

/**
 * 关闭 ChatGPT 自带的开机启动任务（等同于在任务管理器里禁用），并回读确认。
 * @returns {Promise<{supported:boolean, enabled:boolean, locked:boolean}>}
 */
async function disableChatGptStartupTask(options = {}) {
  const run = options.execText || execText;
  const task = await locateStartupTask(options);
  if (!task) throw new Error('没有找到 ChatGPT 自带的开机启动任务');
  const before = describeState(task, await readState(task, run));
  if (!before.enabled) return before;
  if (before.locked) throw new Error('ChatGPT 的开机启动由系统策略强制开启，无法关闭');
  await run('reg.exe', [
    'add', task.key, '/v', 'State', '/t', 'REG_DWORD', '/d', String(STATE_DISABLED_BY_USER), '/f',
  ], REG_TIMEOUT_MS);
  const after = describeState(task, await readState(task, run));
  if (after.enabled) {
    throw new Error('未能关闭 ChatGPT 的开机启动，请在任务管理器的“启动应用”里手动禁用 ChatGPT');
  }
  return after;
}

module.exports = {
  readChatGptStartupTask,
  disableChatGptStartupTask,
  readManifestStartupTask,
  parseRegState,
};
