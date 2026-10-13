'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  parseInstallLocations,
  windowsAppsRoots,
  buildChatGptCandidates,
  prioritizePreferredPath,
  resolveChatGptExe,
} = require('../src/core/chatgpt-install.js');

test('ChatGPT 安装目录解析会去重并忽略空行', () => {
  assert.deepEqual(parseInstallLocations(' D:\\Apps\\OpenAI\\\r\n\r\nD:\\Apps\\OpenAI\\\nE:\\Apps\\OpenAI'), [
    'D:\\Apps\\OpenAI',
    'E:\\Apps\\OpenAI',
  ]);
});

test('WindowsApps 根目录使用当前电脑环境，不包含开发机绝对路径', () => {
  const roots = windowsAppsRoots({
    ProgramW6432: 'D:\\Program Files',
    ProgramFiles: 'C:\\Program Files',
    SystemDrive: 'E:',
  });
  assert.deepEqual(roots, [
    path.join('D:\\Program Files', 'WindowsApps'),
    path.join('C:\\Program Files', 'WindowsApps'),
    path.join('E:', 'Program Files', 'WindowsApps'),
  ]);
  assert.equal(roots.some((value) => value.includes('ailuo')), false);
});

test('候选路径覆盖 MSIX 的 app 目录与包根目录，并按版本目录倒序扫描', () => {
  const fakeFs = {
    readdirSync: (root) => root.endsWith('WindowsApps')
      ? ['OpenAI.Codex_1.0.0_x64__publisher', 'OpenAI.Codex_2.0.0_x64__publisher']
      : [],
  };
  const candidates = buildChatGptCandidates(
    ['D:\\Custom\\OpenAI.Codex_9'],
    { ProgramFiles: 'C:\\Program Files' },
    fakeFs,
  );
  assert.equal(candidates[0], path.join('D:\\Custom\\OpenAI.Codex_9', 'app', 'ChatGPT.exe'));
  assert.ok(candidates.includes(path.join('C:\\Program Files', 'WindowsApps', 'OpenAI.Codex_2.0.0_x64__publisher', 'app', 'ChatGPT.exe')));
  assert.ok(candidates.includes(path.join('C:\\Program Files', 'WindowsApps', 'OpenAI.Codex_2.0.0_x64__publisher', 'ChatGPT.exe')));
  assert.equal(candidates.some((value) => value.includes('26.930.2377.0')), false);
});

test('resolveChatGptExe 优先使用系统返回的实际安装位置', async () => {
  const wanted = path.join('Z:\\Apps\\OpenAI.Codex_current', 'app', 'ChatGPT.exe');
  const fakeFs = {
    existsSync: (candidate) => candidate === wanted,
    readdirSync: () => [],
  };
  const resolved = await resolveChatGptExe({
    execText: async () => 'Z:\\Apps\\OpenAI.Codex_current\r\n',
    fsImpl: fakeFs,
    env: { ProgramFiles: 'C:\\Program Files' },
  });
  assert.equal(resolved, wanted);
});

test('resolveChatGptExe 找不到客户端时返回 null，不抛出异常', async () => {
  const resolved = await resolveChatGptExe({
    execText: async () => '',
    fsImpl: { existsSync: () => false, readdirSync: () => { throw new Error('denied'); } },
    env: { ProgramFiles: 'C:\\Program Files' },
  });
  assert.equal(resolved, null);
});

test('手动选择的 ChatGPT.exe 会优先于动态发现结果', () => {
  const preferred = 'D:\\Custom\\ChatGPT.exe';
  const candidates = prioritizePreferredPath(preferred, [
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_2\\app\\ChatGPT.exe',
    preferred,
  ]);
  assert.deepEqual(candidates, [
    preferred,
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_2\\app\\ChatGPT.exe',
  ]);
});
