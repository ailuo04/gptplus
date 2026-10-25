'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function runUnsignedBuild({ env = process.env, spawn = spawnSync } = {}) {
  const tempDir = path.join(ROOT, 'build', `nsis-temp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const electronBuilderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const result = spawn(process.execPath, [
    electronBuilderCli,
    '--win',
    'nsis',
    '--publish',
    'never',
    '--config.win.signExecutable=false',
  ], {
    cwd: ROOT,
    env: { ...env, TEMP: tempDir, TMP: tempDir },
    stdio: 'inherit',
    windowsHide: true,
  });

  try {
    if (result.error) {
      console.error(`[unsigned-build] 构建命令启动失败：${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 构建失败时保留主错误；临时目录可在下次构建前清理。
    }
  }
}

if (require.main === module) process.exitCode = runUnsignedBuild();

module.exports = { runUnsignedBuild };
