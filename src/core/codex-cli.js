'use strict';
/**
 * Codex CLI 定位：显式配置 > 桌面版托管 CLI > ChatGPT 内置 > npm 全局 > PATH。
 * 纯 Node CommonJS，execText 可注入，方便 node --test。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveChatGptExe } = require('./chatgpt-install.js');

function isFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function isWindowsStorePath(value) {
  return /\\Program Files\\WindowsApps\\/i.test(String(value || ''));
}

function execTextImpl(command, args, timeoutMs = 6000) {
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
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(output.trim()); });
  });
}

/** 桌面版维护的 CLI：%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe 或 bin\<hash>\codex.exe。 */
function managedDesktopCodex() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const root = path.join(local, 'OpenAI', 'Codex', 'bin');
  const direct = path.join(root, 'codex.exe');
  if (isFile(direct)) return { path: direct, source: 'desktop' };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'codex.exe'))
    .filter(isFile)
    .map((file) => {
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
      return { path: file, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? { path: candidates[0].path, source: 'desktop' } : null;
}

function chatGptBundledCodex(chatgptExe) {
  if (!chatgptExe) return null;
  const appDir = path.win32.dirname(chatgptExe);
  const pkgDir = path.win32.dirname(appDir);
  for (const candidate of [
    path.win32.join(appDir, 'resources', 'codex.exe'),
    path.win32.join(pkgDir, 'resources', 'codex.exe'),
    path.win32.join(appDir, 'codex.exe'),
  ]) {
    if (isFile(candidate)) return { path: candidate, source: 'chatgpt' };
  }
  return null;
}

function npmGlobalCodex() {
  if (!process.env.APPDATA) return null;
  const candidate = path.join(
    process.env.APPDATA,
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  return isFile(candidate) ? { path: candidate, source: 'npm' } : null;
}

/**
 * @param {{ configuredPath?: string, chatgptPath?: string|null,
 *           execText?: (command:string,args:string[],timeoutMs?:number)=>Promise<string> }} [opts]
 * @returns {Promise<{path:string, source:string}>}
 */
async function resolveCodexCli(opts = {}) {
  const configured = String(opts.configuredPath || '').trim();
  if (configured) {
    if (!isFile(configured)) throw new Error(`配置的 Codex CLI 路径不存在：${configured}`);
    return { path: configured, source: 'config' };
  }

  const npm = npmGlobalCodex();
  if (npm) return npm;

  const execText = typeof opts.execText === 'function' ? opts.execText : execTextImpl;
  const raw = await execText('where.exe', ['codex']);
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const exeHit = lines.find((line) => /\.exe$/i.test(line) && !isWindowsStorePath(line));
  if (exeHit) return { path: exeHit, source: 'path' };
  const shim = lines.find((line) => /\.(cmd|bat)$/i.test(line));
  if (shim) return { path: shim, source: 'path-shim' };

  // 桌面版托管 CLI 会把 app-server 转交给运行中的 ChatGPT 进程；放在独立
  // CLI 之后，保证「停止微信连接」能结束自己拉起的服务。
  const desktop = managedDesktopCodex();
  if (desktop) return desktop;

  let chatgpt = null;
  try {
    const exe = await resolveChatGptExe({ preferredPath: opts.chatgptPath || null });
    chatgpt = chatGptBundledCodex(exe);
    if (chatgpt && isWindowsStorePath(chatgpt.path)) chatgpt = null;
  } catch { /* 继续候选 */ }
  if (chatgpt) return chatgpt;

  throw new Error('找不到可运行的 Codex CLI，请填写 codex.exe 路径或安装 Codex CLI');
}

module.exports = { resolveCodexCli, execTextImpl, managedDesktopCodex };
