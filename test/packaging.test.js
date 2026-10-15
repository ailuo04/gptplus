'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readAuthenticodeSignature } = require('../tools/verify-signature.cjs');

const ROOT = path.resolve(__dirname, '..');

test('Windows 打包配置使用稳定 appId、安全的内部文件名，并且不发布用户数据', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/main/main.js');
  assert.equal(pkg.build.appId, 'com.ailuo.gptplus');
  assert.equal(pkg.build.productName, 'gpt++');
  assert.equal(pkg.build.executableName, 'gpt-plus');
  assert.equal(pkg.build.publish.provider, 'github');
  assert.equal(pkg.build.publish.owner, 'ailuo04');
  assert.equal(pkg.build.publish.repo, 'gptplus');
  assert.equal(pkg.build.asar, true);
  assert.deepEqual(pkg.build.electronLanguages, ['zh-CN', 'en-US']);
  assert.equal(pkg.build.publish.updaterCacheDirName, 'gptplus-updater');
  assert.equal(pkg.build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(pkg.build.win.signExecutable, true);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.equal(pkg.build.files.some((entry) => String(entry).includes('probe')), false);
});

test('release build requires signing and unsigned build is explicit', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.dist, /build-release\.cjs/);
  assert.match(pkg.scripts['dist:unsigned'], /electron-builder/);
  assert.match(pkg.scripts['verify:signature'], /verify-signature\.cjs/);
  assert.equal(pkg.build.win.signExecutable, true);
});

test('signature verifier preserves an explicit NotSigned status', () => {
  const result = readAuthenticodeSignature(path.join(ROOT, 'package.json'), () => ({
    status: 0,
    stdout: '{"Status":"NotSigned","Subject":""}',
    stderr: '',
  }));
  assert.deepEqual(result, { ok: false, status: 'NotSigned', subject: '' });
});

test('NSIS 覆盖安装会递归结束 gpt++ 的 Electron 进程树', () => {
  const script = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  assert.match(script, /StartsWith\('\$INSTDIR'/);
  assert.match(script, /taskkill\.exe \/PID .* \/T \/F/);
  assert.match(script, /taskkill \/IM .* \/T \/F/);
  assert.match(script, /ExecWait .*--quit/);
  assert.match(script, /customCheckAppRunning/);
});

test('NSIS 安装会用程序本体图标重写桌面和开始菜单快捷方式', () => {
  const script = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  assert.match(script, /!macro customInstall/);
  assert.match(script, /\$DESKTOP\\\$\{PRODUCT_NAME\}\.lnk.*\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}.*\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/);
  assert.match(script, /\$SMPROGRAMS\\\$\{PRODUCT_NAME\}\\\$\{PRODUCT_NAME\}\.lnk.*\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}.*\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/);
});

test('安装包图标满足 Windows 打包器的最小尺寸', () => {
  const icon = path.join(ROOT, 'src', 'main', 'assets', 'app-icon-256.png');
  assert.equal(fs.existsSync(icon), true);
  // PNG IHDR：宽度/高度分别位于固定偏移 16/20，避免依赖额外图片库。
  const data = fs.readFileSync(icon);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(data.readUInt32BE(16), 256);
  assert.equal(data.readUInt32BE(20), 256);
});
