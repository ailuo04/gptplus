'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readChatGptStartupTask,
  disableChatGptStartupTask,
  readManifestStartupTask,
  parseRegState,
} = require('../src/core/chatgpt-startup-task.js');

const EXE = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion'
  + '\\AppModel\\SystemAppData\\OpenAI.Codex_2p2nqsd0c76g0\\App';
const manifest = (enabled = 'false') => `<Package><Extensions>
  <uap5:Extension Category="windows.startupTask" Executable="app/ChatGPT.exe">
    <uap5:StartupTask TaskId="App" Enabled="${enabled}" DisplayName="ChatGPT" />
  </uap5:Extension></Extensions></Package>`;

function setup({ state = null, manifestXml = manifest(), exe = EXE, writable = true } = {}) {
  const calls = [];
  let current = state;
  return {
    calls,
    options: {
      platform: 'win32',
      resolveExe: async () => exe,
      fsImpl: {
        readFileSync: (file) => {
          calls.push(['read', file]);
          if (manifestXml === null) throw new Error('ENOENT');
          return manifestXml;
        },
      },
      execText: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'add') {
          if (writable) current = Number(args[args.indexOf('/d') + 1]);
          return '';
        }
        return current === null ? '' : `\r\n${args[1]}\r\n    State    REG_DWORD    0x${current.toString(16)}\r\n`;
      },
    },
  };
}

test('注册表 State 解析只认 REG_DWORD 行', () => {
  assert.equal(parseRegState('\r\nHKEY...\\App\r\n    State    REG_DWORD    0x2\r\n'), 2);
  assert.equal(parseRegState('    UserEnabledStartupOnce    REG_DWORD    0x0'), null);
  assert.equal(parseRegState(''), null);
});

test('从包根目录清单读取启动任务 ID 和默认状态', () => {
  const files = [];
  const task = readManifestStartupTask(EXE, {
    readFileSync: (file) => { files.push(file); return manifest('true'); },
  });
  assert.deepEqual(task, { taskId: 'App', enabledByDefault: true });
  assert.match(files[0], /OpenAI\.Codex_26\.1111\.2228\.0_x64__2p2nqsd0c76g0\\AppxManifest\.xml$/);
  assert.equal(readManifestStartupTask('D:\\Apps\\ChatGPT.exe'), null);
});

test('用户开启的 ChatGPT 启动任务被识别为开启', async () => {
  const { options, calls } = setup({ state: 2 });
  assert.deepEqual(await readChatGptStartupTask(options), { supported: true, enabled: true, locked: false });
  assert.deepEqual(calls.at(-1), ['reg.exe', 'query', KEY, '/v', 'State']);
});

test('没有注册表状态时按清单默认值判断，禁用状态不算开启', async () => {
  assert.equal((await readChatGptStartupTask(setup().options)).enabled, false);
  assert.equal((await readChatGptStartupTask(setup({ manifestXml: manifest('true') }).options)).enabled, true);
  for (const state of [0, 1, 3]) {
    assert.equal((await readChatGptStartupTask(setup({ state }).options)).enabled, false, String(state));
  }
  assert.deepEqual(await readChatGptStartupTask(setup({ state: 4 }).options), {
    supported: true, enabled: true, locked: true,
  });
});

test('非 Windows、非包安装或没有启动任务时不支持', async () => {
  const unsupported = { supported: false, enabled: false, locked: false };
  assert.deepEqual(await readChatGptStartupTask({ ...setup({ state: 2 }).options, platform: 'darwin' }), unsupported);
  assert.deepEqual(await readChatGptStartupTask(setup({ state: 2, exe: 'D:\\Apps\\ChatGPT.exe' }).options), unsupported);
  assert.deepEqual(await readChatGptStartupTask(setup({ state: 2, exe: null }).options), unsupported);
  assert.deepEqual(await readChatGptStartupTask(setup({ state: 2, manifestXml: '<Package/>' }).options), unsupported);
  assert.deepEqual(await readChatGptStartupTask(setup({ state: 2, manifestXml: null }).options), unsupported);
});

test('关闭启动任务写入“用户禁用”并回读确认', async () => {
  const { options, calls } = setup({ state: 2 });
  assert.deepEqual(await disableChatGptStartupTask(options), { supported: true, enabled: false, locked: false });
  assert.deepEqual(
    calls.find((call) => call[1] === 'add'),
    ['reg.exe', 'add', KEY, '/v', 'State', '/t', 'REG_DWORD', '/d', '1', '/f'],
  );
});

test('已关闭时不写注册表；策略锁定或写入无效时明确报错', async () => {
  const off = setup({ state: 1 });
  await disableChatGptStartupTask(off.options);
  assert.equal(off.calls.some((call) => call[1] === 'add'), false);

  const locked = setup({ state: 4 });
  await assert.rejects(() => disableChatGptStartupTask(locked.options), /系统策略/);
  assert.equal(locked.calls.some((call) => call[1] === 'add'), false);

  await assert.rejects(() => disableChatGptStartupTask(setup({ state: 2, writable: false }).options), /任务管理器/);
  await assert.rejects(
    () => disableChatGptStartupTask(setup({ exe: 'D:\\Apps\\ChatGPT.exe' }).options),
    /没有找到 ChatGPT 自带的开机启动任务/,
  );
});
