'use strict';

// Windows 上的 ChatGPT 安装位置发现。这里不保存版本号、用户名或固定盘符，
// 每次需要重启客户端时都重新向系统查询，适配 MSIX 自动升级与不同用户环境。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHATGPT_PACKAGE = 'OpenAI.Codex';
const CHATGPT_EXE = 'ChatGPT.exe';

/**
 * 执行一个隐藏的文本命令。
 * @param {string} command 可执行文件名
 * @param {string[]} args 命令参数
 * @param {number} timeoutMs 超时时间（毫秒）
 * @returns {Promise<string>} 标准输出；失败或超时返回空字符串
 */
function execText(command, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 进程已经结束时无需处理 */
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

/**
 * 清理 PowerShell 返回的安装目录列表，去掉空行和重复项。
 * @param {string} raw PowerShell 输出
 * @returns {string[]} 安装目录
 */
function parseInstallLocations(raw) {
  const seen = new Set();
  const locations = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const rawValue = line.trim();
    const value = /^[A-Za-z]:[\\/]$/.test(rawValue)
      ? rawValue
      : rawValue.replace(/[\\/]+$/, '');
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(value);
  }
  return locations;
}

/**
 * 返回 Windows 常见的 WindowsApps 根目录，不依赖当前用户的绝对路径。
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {string[]} 候选根目录
 */
function windowsAppsRoots(env = process.env) {
  const roots = [];
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const root = path.join(raw, 'WindowsApps');
    if (!roots.some((item) => item.toLowerCase() === root.toLowerCase())) roots.push(root);
  };
  add(env.ProgramW6432);
  add(env.ProgramFiles);
  if (env.SystemDrive) add(path.join(env.SystemDrive, 'Program Files'));
  return roots;
}

/**
 * 生成候选 ChatGPT.exe 路径。MSIX 版本目录名只作为扫描结果使用，绝不写死。
 * @param {string[]} installLocations 系统返回的包安装目录
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @param {{readdirSync?: Function}} fsImpl 文件系统实现（供测试注入）
 * @returns {string[]} 候选可执行文件路径
 */
function buildChatGptCandidates(installLocations = [], env = process.env, fsImpl = fs) {
  const locations = [...installLocations];
  for (const root of windowsAppsRoots(env)) {
    try {
      const names = fsImpl
        .readdirSync(root)
        .filter((name) => name.startsWith(`${CHATGPT_PACKAGE}_`))
        .sort()
        .reverse();
      for (const name of names) locations.push(path.join(root, name));
    } catch {
      // WindowsApps 通常拒绝普通用户列目录；系统查询结果仍然可用。
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const location of locations) {
    for (const relative of [path.join('app', CHATGPT_EXE), CHATGPT_EXE]) {
      const candidate = path.join(location, relative);
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

/**
 * 把用户手动选择的可执行文件放在动态发现结果之前。
 * @param {string|null|undefined} preferredPath 用户保存的路径
 * @param {string[]} candidates 动态发现得到的候选路径
 * @returns {string[]} 去重后的候选路径
 */
function prioritizePreferredPath(preferredPath, candidates) {
  const preferred = String(preferredPath || '').trim();
  if (!preferred) return candidates;
  const key = preferred.toLowerCase();
  return [preferred, ...candidates.filter((candidate) => candidate.toLowerCase() !== key)];
}

/**
 * 解析当前电脑上的 ChatGPT.exe。
 * @param {{execText?: Function, fsImpl?: any, env?: NodeJS.ProcessEnv, preferredPath?: string|null}} options
 * @returns {Promise<string|null>} 可执行文件路径；找不到时返回 null
 */
async function resolveChatGptExe(options = {}) {
  const run = options.execText || execText;
  const fsImpl = options.fsImpl || fs;
  const env = options.env || process.env;
  const query =
    `(Get-AppxPackage -Name '${CHATGPT_PACKAGE}' -ErrorAction SilentlyContinue ` +
    '| Select-Object -ExpandProperty InstallLocation)';
  const raw = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    query,
  ]);
  const candidates = prioritizePreferredPath(
    options.preferredPath,
    buildChatGptCandidates(parseInstallLocations(raw), env, fsImpl),
  );
  return candidates.find((candidate) => {
    try {
      return fsImpl.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

module.exports = {
  CHATGPT_PACKAGE,
  CHATGPT_EXE,
  parseInstallLocations,
  windowsAppsRoots,
  buildChatGptCandidates,
  prioritizePreferredPath,
  resolveChatGptExe,
  _internal: { execText },
};
