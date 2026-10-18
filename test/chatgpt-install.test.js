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
  resolveChatGptAppId,
  packageFamilyFromPath,
  resolveChatGptAppIdFromPackageFiles,
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

test('非 MSIX 的常见安装目录也会作为候选自动发现', () => {
  const candidates = buildChatGptCandidates([], {
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  }, { readdirSync: () => [] });
  assert.ok(candidates.includes(path.join(
    'C:\\Users\\x\\AppData\\Local', 'Programs', 'ChatGPT', 'ChatGPT.exe',
  )));
  assert.ok(candidates.includes(path.join('C:\\Program Files', 'ChatGPT', 'app', 'ChatGPT.exe')));
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

test('package activation resolves the registered application ID only for the chosen executable', async () => {
  const entries = [
    { appId: 'OpenAI.Codex_publisher!App', executablePath: 'C:\\Apps\\app/ChatGPT.exe' },
  ];
  const options = { execText: async () => JSON.stringify(entries) };
  assert.equal(await resolveChatGptAppId({ ...options, executablePath: 'c:\\apps\\app\\ChatGPT.exe' }), 'OpenAI.Codex_publisher!App');
  assert.equal(await resolveChatGptAppId({ ...options, executablePath: 'D:\\Custom\\ChatGPT.exe' }), null);
});

test('package activation tolerates a single JSON object and unavailable package metadata', async () => {
  const executablePath = 'C:\\Apps\\ChatGPT.exe';
  assert.equal(await resolveChatGptAppId({
    executablePath,
    execText: async () => JSON.stringify({ appId: 'OpenAI.Codex_publisher!App', executablePath }),
  }), 'OpenAI.Codex_publisher!App');
  for (const raw of ['', 'not json', 'null', '{}']) {
    assert.equal(await resolveChatGptAppId({ executablePath, execText: async () => raw }), null);
  }
});

test('包清单查询失败时直接从安装目录的 AppxManifest 解析应用 ID', async () => {
  const executablePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  const manifest = '<Package><Applications>'
    + '<Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" />'
    + '</Applications></Package>';
  const fsImpl = {
    readFileSync: (filePath) => {
      assert.match(filePath, /AppxManifest\.xml$/);
      return manifest;
    },
  };
  assert.equal(
    resolveChatGptAppIdFromPackageFiles(executablePath, fsImpl),
    'OpenAI.Codex_2p2nqsd0c76g0!App',
  );

  let calls = 0;
  const execText = async () => {
    calls += 1;
    return '';
  };
  assert.equal(
    await resolveChatGptAppId({ executablePath, execText, fsImpl }),
    'OpenAI.Codex_2p2nqsd0c76g0!App',
  );
  assert.equal(calls, 1, '本地清单可用时不应再查询开始菜单');
});

test('本地清单不可用时继续回退，非包路径直接放弃应用身份', () => {
  const executablePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__publisher\\app\\ChatGPT.exe';
  assert.equal(
    resolveChatGptAppIdFromPackageFiles(executablePath, {
      readFileSync: () => { throw new Error('access denied'); },
    }),
    null,
  );
  assert.equal(resolveChatGptAppIdFromPackageFiles('D:\\Custom\\ChatGPT.exe', {
    readFileSync: () => '',
  }), null);
});

test('包身份解析不依赖固定安装盘符、包名或 exe 名称', () => {
  const executablePath = 'E:\\Program Files\\WindowsApps\\Foo.Bar_1.2.3.4_x64__pub\\app\\MyChatGPT.exe';
  const manifest = '<Applications>'
    + '<Application Id="Main" Executable="app/MyChatGPT.exe" />'
    + '</Applications>';
  assert.equal(packageFamilyFromPath(executablePath), 'Foo.Bar_pub');
  assert.equal(
    resolveChatGptAppIdFromPackageFiles(executablePath, { readFileSync: () => manifest }),
    'Foo.Bar_pub!Main',
  );
  assert.equal(packageFamilyFromPath('D:\\Portable\\ChatGPT.exe'), null);
});

test('exe 位于包根目录时也能从同一份 AppxManifest 解析应用 ID', () => {
  const executablePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\ChatGPT.exe';
  const manifest = '<Applications>'
    + '<Application Id="App" Executable="ChatGPT.exe" />'
    + '</Applications>';
  assert.equal(
    resolveChatGptAppIdFromPackageFiles(executablePath, { readFileSync: () => manifest }),
    'OpenAI.Codex_pub!App',
  );
});

test('开始菜单兜底优先选择与安装路径同包族的入口', async () => {
  const executablePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__publisher\\app\\ChatGPT.exe';
  const execText = async (command, args) => {
    assert.match(command, /powershell\.exe/);
    if (String(args[args.length - 1]).includes('Get-StartApps')) {
      return JSON.stringify([
        'Other.App_other!App',
        'OpenAI.Codex_other!App',
        'OpenAI.Codex_publisher!App',
      ]);
    }
    return '';
  };
  assert.equal(
    await resolveChatGptAppId({
      executablePath,
      execText,
      fsImpl: { readFileSync: () => { throw new Error('access denied'); } },
    }),
    'OpenAI.Codex_publisher!App',
  );
});

test('包清单查询失败时从开始菜单的注册入口兜底解析应用 ID', async () => {
  const executablePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1_x64__publisher\\app\\ChatGPT.exe';
  const calls = [];
  const execText = async (command, args) => {
    calls.push(args[args.length - 1]);
    if (calls.length === 1) return ''; // Get-AppxPackage/清单查询失败
    return JSON.stringify(['com.openai.codex', 'OpenAI.Codex_publisher!App']);
  };
  assert.equal(
    await resolveChatGptAppId({ executablePath, execText }),
    'OpenAI.Codex_publisher!App',
    '应只接受包名前缀正确且带应用 ID 的注册入口',
  );
  assert.equal(calls.length, 2, '清单查询无结果后才查询开始菜单');
  assert.match(calls[1], /Get-StartApps/);
});

test('手动选择的外部 exe 不会套用系统里已注册的 ChatGPT 应用身份', async () => {
  let calls = 0;
  const execText = async () => {
    calls += 1;
    return JSON.stringify(['OpenAI.Codex_publisher!App']);
  };
  assert.equal(await resolveChatGptAppId({ executablePath: 'D:\\Custom\\ChatGPT.exe', execText }), null);
  assert.equal(calls, 1, '非 WindowsApps 路径不应再查询开始菜单');
});
