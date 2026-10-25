'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  launchChatGpt,
  launchChatGptAndVerify,
  relaunchChatGpt,
  parseTasklistPids,
  listChatGptPids,
  killChatGpt,
  findChatGptDebugPort,
} = require('../src/core/chatgpt-launch.js');

function launcher(options = {}) {
  const calls = [];
  return {
    calls,
    options: {
      resolveExe: async () => 'C:\\Apps\\ChatGPT.exe',
      resolveAppId: async () => options.appId || null,
      spawnImpl: (command, args, settings) => {
        calls.push({ command, args, settings });
        const child = new EventEmitter();
        child.on('error', () => {});
        child.unref = () => calls.push('unref');
        process.nextTick(() => {
          if (options.failAll || (options.failShell && command === 'explorer.exe')) {
            child.emit('error', new Error('spawn failed'));
          } else {
            child.emit('spawn');
          }
        });
        return child;
      },
    },
  };
}

test('registered ChatGPT is activated through Windows shell instead of only spawning its executable', async () => {
  const { calls, options } = launcher({ appId: 'OpenAI.Codex_publisher!App' });
  assert.deepEqual(await launchChatGpt(options), {
    ok: true,
    exe: 'C:\\Apps\\ChatGPT.exe',
    appId: 'OpenAI.Codex_publisher!App',
  });
  assert.equal(calls[0].command, 'explorer.exe');
  assert.deepEqual(calls[0].args, ['shell:AppsFolder\\OpenAI.Codex_publisher!App']);
  assert.equal(calls[0].settings.windowsHide, true);
  assert.equal(calls[0].settings.detached, true);
  assert.deepEqual(calls.slice(1), ['unref']);
});

test('a manually selected non-package executable still launches directly', async () => {
  const { calls, options } = launcher();
  assert.equal((await launchChatGpt(options)).ok, true);
  assert.equal(calls[0].command, 'C:\\Apps\\ChatGPT.exe');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].settings.windowsHide, false);
});

test('failed Windows shell activation falls back to the executable without killing any client', async () => {
  const { calls, options } = launcher({ appId: 'OpenAI.Codex_publisher!App', failShell: true });
  assert.equal((await launchChatGpt(options)).ok, true);
  assert.deepEqual(calls.filter((call) => call !== 'unref').map((call) => call.command), [
    'explorer.exe', 'C:\\Apps\\ChatGPT.exe',
  ]);
});

test('asynchronous spawn errors are returned as a failure instead of logging a successful launch', async () => {
  const { options } = launcher({ failAll: true });
  assert.deepEqual(await launchChatGpt(options), { ok: false, error: 'spawn failed' });
});

test('package discovery failure does not prevent launching a valid executable', async () => {
  const { calls, options } = launcher();
  options.resolveAppId = async () => { throw new Error('package unavailable'); };
  assert.equal((await launchChatGpt(options)).ok, true);
  assert.equal(calls[0].command, 'C:\\Apps\\ChatGPT.exe');
});

test('包安装路径解析不到应用入口时宁可报错，也不直接运行包内 exe', async () => {
  const { calls, options } = launcher();
  options.resolveExe = async () => 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\app\\ChatGPT.exe';
  options.retryDelayMs = 0;
  assert.deepEqual(await launchChatGpt(options), {
    ok: false,
    error: '无法解析 ChatGPT 的 Windows 应用入口，请确认客户端安装完整后重试',
  });
  assert.deepEqual(calls, [], '不能退回直接启动 exe，否则又会丢包身份');
});

test('包安装场景的应用入口启动失败时也不退回直接运行 exe', async () => {
  const { calls, options } = launcher({ appId: 'OpenAI.Codex_pub!App', failShell: true });
  options.resolveExe = async () => 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\app\\ChatGPT.exe';
  options.retryDelayMs = 0;
  const result = await launchChatGpt(options);
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn failed/);
  assert.equal(calls.filter((call) => call !== 'unref').length, 1, '只应尝试应用入口一次');
});

test('已解析出应用入口时不再重复查询包信息', async () => {
  const { calls, options } = launcher();
  options.resolvedAppId = 'OpenAI.Codex_pub!App';
  options.resolveAppId = async () => {
    throw new Error('不应再次查询');
  };
  const result = await launchChatGpt(options);
  assert.equal(result.ok, true);
  assert.equal(result.appId, 'OpenAI.Codex_pub!App');
  assert.equal(calls[0].command, 'explorer.exe');
});

test('重启前先确认应用入口；解析失败时不会先杀掉 ChatGPT', async () => {
  const calls = [];
  const result = await relaunchChatGpt({
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\app\\ChatGPT.exe',
    resolveAppId: async () => null,
    listPids: async () => { calls.push('list'); return [101]; },
    kill: async () => { calls.push('kill'); },
    launch: async () => { calls.push('launch'); return { ok: true }; },
    retryDelayMs: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /未结束当前客户端/);
  assert.deepEqual(calls, [], '入口解析失败时不应查询或结束正在运行的客户端');
});

test('重启把预解析的应用入口传给启动逻辑，避免第二次解析', async () => {
  let running = [101];
  let launchOptions = null;
  const result = await relaunchChatGpt({
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\app\\ChatGPT.exe',
    resolveAppId: async () => 'OpenAI.Codex_pub!App',
    listPids: async () => running.slice(),
    kill: async () => { running = []; },
    launch: async (options) => {
      launchOptions = options;
      running = [202];
      return { ok: true, exe: options.preferredPath, appId: options.resolvedAppId };
    },
    sleep: async () => {},
    pollMs: 0,
    exitTimeoutMs: 100,
    launchTimeoutMs: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(launchOptions.resolvedAppId, 'OpenAI.Codex_pub!App');
  assert.deepEqual(result, {
    ok: true,
    exe: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\app\\ChatGPT.exe',
    pid: 202,
    appId: 'OpenAI.Codex_pub!App',
  });
});

// ============================================================
// 重启：结束旧进程 -> 等退出 -> 应用入口唤起 -> 确认新进程
// ============================================================

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function relaunchOptions(overrides = {}) {
  const clock = fakeClock();
  const calls = [];
  return {
    calls,
    options: {
      executablePath: 'C:\\Apps\\ChatGPT.exe',
      listPids: async () => [101],
      kill: async () => { calls.push('kill'); },
      launch: async (opts) => {
        calls.push(['launch', opts]);
        return { ok: true };
      },
      sleep: clock.sleep,
      now: clock.now,
      pollMs: 100,
      exitTimeoutMs: 1000,
      launchTimeoutMs: 1000,
      ...overrides,
    },
  };
}

test('重启会先等旧进程退出，再通过应用入口唤起并确认新进程', async () => {
  const { calls, options } = relaunchOptions();
  let running = [101];
  options.listPids = async () => running.slice();
  options.kill = async () => {
    calls.push('kill');
    running = [];
  };
  options.launch = async (launchOptions) => {
    calls.push(['launch', launchOptions]);
    running = [202];
    return { ok: true };
  };

  const result = await relaunchChatGpt(options);
  assert.deepEqual(result, { ok: true, exe: 'C:\\Apps\\ChatGPT.exe', pid: 202 });
  assert.deepEqual(calls.map((call) => (Array.isArray(call) ? call[0] : call)), ['kill', 'launch']);
  assert.equal(calls[1][1].preferredPath, 'C:\\Apps\\ChatGPT.exe', '必须让启动逻辑使用刚解析出的 exe');
  assert.equal(
    await calls[1][1].resolveExe({}),
    'C:\\Apps\\ChatGPT.exe',
    '重启路径不能再重新解析到别的可执行文件',
  );
});

test('找不到 ChatGPT.exe 时直接报错，不会结束任何进程', async () => {
  const { calls, options } = relaunchOptions({
    executablePath: null,
    resolveExe: async () => null,
  });
  assert.deepEqual(await relaunchChatGpt(options), { ok: false, error: '找不到 ChatGPT.exe' });
  assert.deepEqual(calls, []);
});

test('旧进程没有退出时报告失败，不会继续拉起新客户端', async () => {
  const { calls, options } = relaunchOptions({
    listPids: async () => [101],
    kill: async () => { calls.push('kill'); },
  });
  assert.deepEqual(await relaunchChatGpt(options), {
    ok: false,
    error: 'ChatGPT 没有退出，请手动关闭客户端后重试',
  });
  assert.deepEqual(calls, ['kill']);
});

test('启动失败时把错误原样返回', async () => {
  const { options } = relaunchOptions();
  let running = [101];
  options.listPids = async () => running.slice();
  options.kill = async () => { running = []; };
  options.launch = async () => ({ ok: false, error: 'spawn failed' });
  assert.deepEqual(await relaunchChatGpt(options), { ok: false, error: 'spawn failed' });
});

test('启动后没有检测到新进程时报告失败，避免界面误报重启完成', async () => {
  const { options } = relaunchOptions();
  let running = [101];
  options.listPids = async () => running.slice();
  options.kill = async () => { running = []; };
  options.launch = async () => ({ ok: true });
  assert.deepEqual(await relaunchChatGpt(options), {
    ok: false,
    error: '没有检测到重启后的 ChatGPT 进程，请手动打开客户端',
  });
});

test('重启默认通过 Windows 应用入口唤起 ChatGPT，而不是直接 spawn 包内 exe', async () => {
  let running = [101];
  const calls = [];
  const options = {
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    resolveAppId: async () => 'OpenAI.Codex_2p2nqsd0c76g0!App',
    listPids: async () => running.slice(),
    kill: async () => { running = []; },
    spawnImpl: (command, args, settings) => {
      calls.push({ command, args, settings });
      const child = new EventEmitter();
      child.on('error', () => {});
      child.unref = () => {};
      process.nextTick(() => {
        if (command === 'explorer.exe') running = [202];
        child.emit('spawn');
      });
      return child;
    },
    sleep: async () => {},
    pollMs: 0,
    exitTimeoutMs: 100,
    launchTimeoutMs: 100,
  };
  assert.deepEqual(await relaunchChatGpt(options), {
    ok: true,
    exe: 'C:\\Apps\\ChatGPT.exe',
    pid: 202,
    appId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
  });
  assert.equal(calls.length, 1, '包安装场景不应再直接启动 exe');
  assert.equal(calls[0].command, 'explorer.exe');
  assert.deepEqual(calls[0].args, ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App']);
  assert.equal(calls[0].settings.windowsHide, true);
});

test('tasklist 输出解析只认 ChatGPT.exe 的进程行', () => {
  const raw = [
    '"ChatGPT.exe","101","Console","1","100,000 K"',
    '"ChatGPT.exe","202","Console","1","90,000 K"',
    '信息: 没有运行的任务匹配指定标准。',
    '',
  ].join('\r\n');
  assert.deepEqual(parseTasklistPids(raw), [101, 202]);
  assert.deepEqual(parseTasklistPids(''), []);
  assert.deepEqual(parseTasklistPids('"chatgpt.exe","7","Console","1","1 K"'), [7]);
});

test('进程查询与结束使用 tasklist/taskkill 的 ChatGPT 镜像名', async () => {
  const calls = [];
  const execText = async (command, args) => {
    calls.push([command, args]);
    return '';
  };
  assert.deepEqual(await listChatGptPids({ execText }), []);
  await killChatGpt({ execText });
  assert.deepEqual(calls, [
    ['tasklist.exe', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH']],
    ['taskkill.exe', ['/IM', 'ChatGPT.exe', '/F', '/T']],
  ]);
});

test('进程查询与结束会跟随实际 exe 名称，而不是写死 ChatGPT.exe', async () => {
  const calls = [];
  const execText = async (command, args) => {
    calls.push([command, args]);
    return '"MyChatGPT.exe","321","Console","1","1 K"';
  };
  assert.deepEqual(await listChatGptPids({ execText, imageName: 'MyChatGPT.exe' }), [321]);
  await killChatGpt({ execText, imageName: 'MyChatGPT.exe' });
  assert.deepEqual(calls, [
    ['tasklist.exe', ['/FI', 'IMAGENAME eq MyChatGPT.exe', '/FO', 'CSV', '/NH']],
    ['taskkill.exe', ['/IM', 'MyChatGPT.exe', '/F', '/T']],
  ]);
  assert.deepEqual(parseTasklistPids(
    '"ChatGPT.exe","101","Console","1","1 K"\r\n"MyChatGPT.exe","202","Console","1","1 K"',
    'MyChatGPT.exe',
  ), [202]);
});

test('重启流程用解析到的 exe 名称结束旧进程', async () => {
  const calls = [];
  const execText = async (command, args) => {
    calls.push([command, args]);
    return '';
  };
  const result = await relaunchChatGpt({
    executablePath: 'D:\\Portable\\MyChatGPT.exe',
    execText,
    launch: async () => ({ ok: false, error: 'stop here' }),
    sleep: async () => {},
    pollMs: 0,
    exitTimeoutMs: 0,
    launchTimeoutMs: 0,
  });
  assert.deepEqual(result, { ok: false, error: 'stop here' });
  assert.deepEqual(calls[0], [
    'tasklist.exe',
    ['/FI', 'IMAGENAME eq MyChatGPT.exe', '/FO', 'CSV', '/NH'],
  ]);
  assert.deepEqual(calls[1], ['taskkill.exe', ['/IM', 'MyChatGPT.exe', '/F', '/T']]);
});

test('开机自启动校验同样使用配置里实际 exe 的进程名', async () => {
  const calls = [];
  const execText = async (command, args) => {
    calls.push([command, args]);
    return '';
  };
  const result = await launchChatGptAndVerify({
    preferredPath: 'D:\\Portable\\MyChatGPT.exe',
    resolveExe: async () => 'D:\\Portable\\MyChatGPT.exe',
    execText,
    launch: async () => ({ ok: true, exe: 'D:\\Portable\\MyChatGPT.exe' }),
    sleep: async () => {},
    pollMs: 0,
    launchTimeoutMs: 0,
    attempts: 1,
  });
  assert.deepEqual(result, { ok: false, error: '没有检测到 ChatGPT 进程' });
  assert.deepEqual(calls[0], [
    'tasklist.exe',
    ['/FI', 'IMAGENAME eq MyChatGPT.exe', '/FO', 'CSV', '/NH'],
  ]);
});

test('开机自启动将 CDP 端口和包装器目录传给 ChatGPT 启动器', async () => {
  let running = [];
  let launchOptions = null;
  const result = await launchChatGptAndVerify({
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    cdpPort: 9334,
    wrapperDir: 'C:\\gptplus\\cdp',
    launch: async (options) => {
      launchOptions = options;
      running = [303];
      return { ok: true, exe: 'C:\\Apps\\ChatGPT.exe' };
    },
    listPids: async () => running.slice(),
    sleep: async () => {},
    pollMs: 0,
    launchTimeoutMs: 0,
    attempts: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(launchOptions.cdpPort, 9334);
  assert.equal(launchOptions.wrapperDir, 'C:\\gptplus\\cdp');
});

// ============================================================
// 开机自启动：应用入口调用成功之外，还要确认进程真的出现
// ============================================================

test('开机自启动会确认 ChatGPT 进程出现后才报告成功', async () => {
  let running = [];
  const clock = fakeClock();
  const options = {
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    preferredPath: 'C:\\Apps\\ChatGPT.exe',
    launch: async () => {
      running = [202];
      return { ok: true, exe: 'C:\\Apps\\ChatGPT.exe' };
    },
    listPids: async () => running.slice(),
    sleep: clock.sleep,
    now: clock.now,
    pollMs: 100,
    launchTimeoutMs: 500,
  };
  assert.deepEqual(await launchChatGptAndVerify(options), {
    ok: true,
    exe: 'C:\\Apps\\ChatGPT.exe',
    pid: 202,
  });
});

test('开机自启动没等到进程时会重试一次', async () => {
  const clock = fakeClock();
  let attempts = 0;
  let running = [];
  const options = {
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    launch: async () => {
      attempts += 1;
      if (attempts === 2) running = [303];
      return { ok: true, exe: 'C:\\Apps\\ChatGPT.exe' };
    },
    listPids: async () => running.slice(),
    sleep: clock.sleep,
    now: clock.now,
    pollMs: 100,
    launchTimeoutMs: 300,
    retryDelayMs: 100,
    attempts: 2,
  };
  assert.deepEqual(await launchChatGptAndVerify(options), {
    ok: true,
    exe: 'C:\\Apps\\ChatGPT.exe',
    pid: 303,
  });
  assert.equal(attempts, 2, '第一次没有进程时必须重试');
});

test('开机自启动重试后仍没有进程时返回明确错误', async () => {
  const clock = fakeClock();
  const options = {
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    launch: async () => ({ ok: true, exe: 'C:\\Apps\\ChatGPT.exe' }),
    listPids: async () => [],
    sleep: clock.sleep,
    now: clock.now,
    pollMs: 100,
    launchTimeoutMs: 200,
    retryDelayMs: 100,
    attempts: 2,
  };
  assert.deepEqual(await launchChatGptAndVerify(options), {
    ok: false,
    error: '没有检测到 ChatGPT 进程',
  });
});

test('ChatGPT 已在运行时，应用入口激活即可视为成功', async () => {
  const clock = fakeClock();
  const options = {
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    launch: async () => ({ ok: true, exe: 'C:\\Apps\\ChatGPT.exe' }),
    listPids: async () => [101],
    sleep: clock.sleep,
    now: clock.now,
    pollMs: 100,
    launchTimeoutMs: 200,
  };
  assert.deepEqual(await launchChatGptAndVerify(options), {
    ok: true,
    exe: 'C:\\Apps\\ChatGPT.exe',
    pid: 101,
  });
});

test('开机自启动找不到 exe 时会重试解析一次', async () => {
  let resolveCalls = 0;
  const result = await launchChatGptAndVerify({
    resolveExe: async () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? null : 'C:\\Apps\\ChatGPT.exe';
    },
    launch: async () => ({ ok: true, exe: 'C:\\Apps\\ChatGPT.exe' }),
    listPids: async () => [101],
    sleep: async () => {},
    retryDelayMs: 0,
    attempts: 2,
    launchTimeoutMs: 100,
    pollMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exe, 'C:\\Apps\\ChatGPT.exe');
  assert.equal(resolveCalls, 2, '第一次找不到 exe 时必须重试解析');
});

test('开机自启动在包安装场景走应用入口并确认新进程', async () => {
  let running = [];
  const commands = [];
  const result = await launchChatGptAndVerify({
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__pub\\app\\ChatGPT.exe',
    resolveAppId: async () => 'OpenAI.Codex_pub!App',
    listPids: async () => running.slice(),
    spawnImpl: (command) => {
      commands.push(command);
      const child = new EventEmitter();
      child.on('error', () => {});
      child.unref = () => {};
      process.nextTick(() => {
        if (command === 'explorer.exe') running = [404];
        child.emit('spawn');
      });
      return child;
    },
    sleep: async () => {},
    pollMs: 0,
    launchTimeoutMs: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 404);
  assert.equal(result.appId, 'OpenAI.Codex_pub!App');
  assert.deepEqual(commands, ['explorer.exe'], '包安装必须通过应用入口启动');
});

test('开机自启动的启动错误会保留并在重试后返回', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const options = {
    executablePath: 'C:\\Apps\\ChatGPT.exe',
    launch: async () => {
      attempts += 1;
      return { ok: false, error: 'spawn failed' };
    },
    listPids: async () => [],
    sleep: clock.sleep,
    now: clock.now,
    pollMs: 100,
    launchTimeoutMs: 200,
    retryDelayMs: 100,
    attempts: 2,
  };
  assert.deepEqual(await launchChatGptAndVerify(options), { ok: false, error: 'spawn failed' });
  assert.equal(attempts, 2);
});

test('findChatGptDebugPort extracts the debug port from the running client command line', async () => {
  const calls = [];
  const execText = async (command, args) => {
    calls.push({ command, args });
    return '"C:\Apps\ChatGPT.exe" --remote-debugging-port=9444 --remote-allow-origins=http://127.0.0.1:9444';
  };
  assert.equal(await findChatGptDebugPort({ execText }), 9444);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.join(' '), /remote-debugging-port/);
  assert.equal(await findChatGptDebugPort({ execText: async () => '' }), null);
  assert.equal(await findChatGptDebugPort({ execText: async () => '--remote-debugging-port=0' }), null);
});
