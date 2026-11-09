'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { NsisScriptGenerator } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator.js');

function cachedTool(cache, prefix, suffix) {
  if (!fs.existsSync(cache)) return null;
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const root = path.join(cache, entry.name);
    for (const child of fs.readdirSync(root, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const candidate = path.join(root, child.name, suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

test('NSIS 接收旧版更新参数时自动静默，手动安装仍可选择目录', { skip: process.platform !== 'win32' }, t => {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const compiler = cachedTool(cache, 'nsis-3.', 'makensis.exe');
  const plugin = cachedTool(cache, 'nsis-resources-', 'plugins/x86-unicode/StdUtils.dll');
  if (!compiler || !plugin) { t.skip('本机没有缓存 NSIS 工具；不下载构建工具'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-nsis-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'update-mode.exe');
  const script = path.join(dir, 'update-mode.nsi');
  const includes = path.resolve(__dirname, '../node_modules/app-builder-lib/templates/nsis/include');
  const generator = new NsisScriptGenerator();
  generator.flags(['updated']);
  // Execute the real custom hook with electron-builder's real argument parser.
  // Quit in .onInit: no files are installed, removed, or registered.
  fs.writeFileSync(script, `Unicode true
RequestExecutionLevel user
Name "gpt++ update mode test"
OutFile "${exe}"
!include "LogicLib.nsh"
!addincludedir "${includes}"
!addplugindir /x86-unicode "${path.dirname(plugin)}"
!include "StdUtils.nsh"
${generator.build()}
!include "${path.resolve(__dirname, '../build/installer.nsh')}"
Function .onInit
  !ifmacrodef customInit
    !insertmacro customInit
  !endif
  \${if} \${Silent}
    SetErrorLevel 42
  \${else}
    SetErrorLevel 43
  \${endif}
  Quit
FunctionEnd
Section
SectionEnd
`);
  const built = spawnSync(compiler, ['/V2', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const updated = spawnSync(exe, ['--updated', '--force-run'], { windowsHide: true, timeout: 5000 });
  assert.equal(updated.status, 42, '旧版没有传 /S 时，更新包也必须自动静默');
  const fresh = spawnSync(exe, [], { windowsHide: true, timeout: 5000 });
  assert.equal(fresh.status, 43, '首次手动安装保留目录选择向导');
});
