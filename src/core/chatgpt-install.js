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
 * 非 MSIX 安装的常见目录。官方客户端也可能通过普通安装器装到用户目录；
 * 这些路径只作为候选，仍然会检查文件是否真实存在。
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {string[]} 候选安装目录
 */
function conventionalInstallLocations(env = process.env) {
  const roots = [
    [env.LOCALAPPDATA, 'Programs', 'ChatGPT'],
    [env.LOCALAPPDATA, 'Programs', 'OpenAI', 'ChatGPT'],
    [env.LOCALAPPDATA, 'ChatGPT'],
    [env.ProgramFiles, 'ChatGPT'],
    [env['ProgramFiles(x86)'], 'ChatGPT'],
  ];
  const locations = [];
  const seen = new Set();
  for (const parts of roots) {
    const [root, ...rest] = parts;
    const raw = String(root || '').trim();
    if (!raw) continue;
    const location = path.join(raw, ...rest.filter(Boolean));
    const key = location.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(location);
  }
  return locations;
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
  // 非 MSIX 的常见目录放在最后：优先使用系统注册的包安装位置，
  // 避免用户目录里遗留的旧 ChatGPT.exe 抢在真正的应用包前面。
  locations.push(...conventionalInstallLocations(env));

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

/**
 * 从 WindowsApps 下的安装目录推导 PackageFamilyName。
 * 安装目录形如 `<包名>_<版本>_<架构>__<发布者ID>`，PackageFamilyName 为 `<包名>_<发布者ID>`。
 * @param {string} executablePath 包内可执行文件路径
 * @returns {string|null} 包族名；不是 WindowsApps 安装路径时返回 null
 */
function packageFamilyFromPath(executablePath) {
  const normalized = path.win32.normalize(String(executablePath || ''));
  const folderMatch = /[\\/]WindowsApps[\\/]([^\\/]+)[\\/]/i.exec(normalized);
  if (!folderMatch) return null;
  const familyMatch = /^(.+?)_\d+(?:\.\d+){1,3}_[^_]+__(.+)$/.exec(folderMatch[1]);
  if (!familyMatch) return null;
  return `${familyMatch[1]}_${familyMatch[2]}`;
}

/**
 * 直接从 MSIX 安装目录读取应用身份：包目录名给出 PackageFamilyName，
 * AppxManifest.xml 给出 Application Id。用于 Get-AppxPackage 不可用或在登录初期超时的场景。
 * @param {string} executablePath 包内可执行文件路径
 * @param {{readFileSync?: Function}} [fsImpl] 文件系统实现（供测试注入）
 * @returns {string|null} 应用 ID；不是包安装路径或读取失败时返回 null
 */
function resolveChatGptAppIdFromPackageFiles(executablePath, fsImpl = fs) {
  const normalized = path.win32.normalize(String(executablePath || ''));
  const family = packageFamilyFromPath(normalized);
  if (!family) return null;

  // exe 可能在 <包目录>\app\ChatGPT.exe，也可能直接在 <包目录>\ChatGPT.exe。
  const packageRootMatch = /^(.*[\\/]WindowsApps[\\/][^\\/]+)[\\/]/i.exec(normalized);
  if (!packageRootMatch) return null;
  const packageRoot = packageRootMatch[1];
  let xml = '';
  try {
    xml = fsImpl.readFileSync(path.win32.join(packageRoot, 'AppxManifest.xml'), 'utf8');
  } catch {
    return null;
  }

  const executableName = path.win32.basename(normalized).toLowerCase();
  for (const tag of String(xml).match(/<Application\b[^>]*>/gi) || []) {
    const executable = /\bExecutable="([^"]+)"/i.exec(tag);
    if (!executable) continue;
    if (path.win32.basename(executable[1]).toLowerCase() !== executableName) continue;
    const id = /\bId="([^"]+)"/i.exec(tag);
    if (id && id[1]) return `${family}!${id[1]}`;
  }
  return null;
}

/**
 * 从开始菜单注册的应用入口里找 ChatGPT 的应用 ID。
 * 这是 `Get-AppxPackage` / 清单查询失败时的兜底：开始菜单仍会列出已注册的 MSIX 应用，
 * 只要 AppID 形如 `<包名>_<发布者ID>!<应用ID>` 就能直接用于 shell 激活。
 * @param {{execText?: Function, family?: string|null}} [options]
 * @returns {Promise<string|null>} 应用 ID；找不到时返回 null
 */
async function resolveChatGptAppIdFromStartApps(options = {}) {
  const run = options.execText || execText;
  const query = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-StartApps | Select-Object -ExpandProperty AppID | ConvertTo-Json -Compress
`;
  try {
    const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query]);
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const candidates = entries.filter((appId) => typeof appId === 'string' && appId.includes('!'));
    const family = String(options.family || '').trim();
    if (family) {
      // 已知安装路径对应的包族时，不能退而求其次去激活另一个版本的 ChatGPT。
      return candidates.find((appId) => appId.startsWith(`${family}!`)) || null;
    }
    return candidates.find((appId) => appId.startsWith(`${CHATGPT_PACKAGE}_`)) || null;
  } catch {
    return null;
  }
}

/** Resolve the Windows application identity without overriding a manually selected executable. */
async function resolveChatGptAppId(options = {}) {
  if (!options.executablePath) return null;
  const run = options.execText || execText;
  const executableName = path.win32.basename(path.win32.normalize(String(options.executablePath)));
  const safeExecutableName = String(executableName || CHATGPT_EXE).replace(/'/g, "''");
  const query = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-AppxPackage -Name '${CHATGPT_PACKAGE}' -ErrorAction SilentlyContinue | ForEach-Object {
  $package = $_
  $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction SilentlyContinue
  foreach ($application in $manifest.Package.Applications.Application) {
    if ((Split-Path $application.Executable -Leaf) -eq '${safeExecutableName}') {
      [PSCustomObject]@{
        appId = $package.PackageFamilyName + '!' + $application.Id
        executablePath = Join-Path $package.InstallLocation $application.Executable
      }
    }
  }
} | ConvertTo-Json -Compress
`;
  let entries = [];
  try {
    const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query]);
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = [];
  }
  const selectedPath = path.win32.normalize(options.executablePath).toLowerCase();
  const match = entries.find((entry) => typeof entry?.appId === 'string'
    && entry.appId.startsWith(`${CHATGPT_PACKAGE}_`) && entry.appId.includes('!')
    && typeof entry.executablePath === 'string'
    && path.win32.normalize(entry.executablePath).toLowerCase() === selectedPath);
  if (match) return match.appId;

  // 只有 WindowsApps 包安装目录里的 exe 才能套用包身份；
  // 用户手动选择的外部 exe 直接启动即可，不能套用系统里另一个 ChatGPT 安装的入口。
  const family = packageFamilyFromPath(options.executablePath);
  if (!family) return null;

  // 登录初期 AppX/开始菜单可能还没就绪：先直接读包目录里的清单，避免掉回直接运行 exe
  // （那会丢失包身份，任务栏显示成通用文档图标）。
  const localAppId = resolveChatGptAppIdFromPackageFiles(
    options.executablePath,
    options.fsImpl || fs,
  );
  if (localAppId) return localAppId;

  return resolveChatGptAppIdFromStartApps({ execText: run, family });
}

module.exports = {
  CHATGPT_PACKAGE,
  CHATGPT_EXE,
  parseInstallLocations,
  windowsAppsRoots,
  conventionalInstallLocations,
  buildChatGptCandidates,
  prioritizePreferredPath,
  resolveChatGptExe,
  resolveChatGptAppId,
  packageFamilyFromPath,
  resolveChatGptAppIdFromPackageFiles,
  resolveChatGptAppIdFromStartApps,
  _internal: { execText },
};
