'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real startup functions without booting Electron or touching the Windows registry.
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const startupSource = mainSource.slice(
  mainSource.indexOf('function readStartupSettings()'),
  mainSource.indexOf('function createTray()'),
);

function setup(options = {}) {
  const calls = [];
  const logs = [];
  const config = { startup: { target: options.target || 'both' }, chatgpt: { executablePath: null } };
  let registeredArgs = options.legacy ? [] : ['--gptplus-startup'];
  let registered = options.enabled !== false;
  const app = {
    getLoginItemSettings: (query = {}) => {
      const matches = JSON.stringify(query.args || []) === JSON.stringify(registeredArgs);
      return {
        openAtLogin: registered && matches,
        executableWillLaunchAtLogin: registered && options.taskManagerDisabled !== true,
        wasOpenedAtLogin: options.macLogin === true,
      };
    },
    setLoginItemSettings: (settings) => {
      calls.push({ type: 'register', enabled: settings.openAtLogin, args: Array.from(settings.args || []) });
      registered = settings.openAtLogin;
      registeredArgs = Array.from(settings.args || []);
    },
  };
  const sandbox = {
    app,
    process: { platform: options.platform || 'win32', argv: options.argv || ['gpt-plus.exe', '--gptplus-startup'] },
    isDev: options.isDev === true,
    isSmoke: options.isSmoke === true,
    ctx: {
      store: { get: () => config, update: (fn) => fn(config) },
      log: (entry) => logs.push(entry),
    },
    launchChatGptAndVerify: async (launchOptions) => {
      calls.push({ type: 'launch', preferredPath: launchOptions.preferredPath });
      if (options.launchError) throw new Error(options.launchError);
      return options.launchResult || { ok: true, exe: 'C:\\ChatGPT.exe', pid: 1234 };
    },
  };
  const api = vm.runInNewContext(`${startupSource}\n({
    get: readStartupSettings, set: writeStartupSettings, launch: launchChatGptAtLogin,
    migrate: typeof migrateStartupSettings === 'function' ? migrateStartupSettings : () => {},
  })`, sandbox);
  return { api, app, calls, logs, config };
}

test('Windows login marker launches ChatGPT even though wasOpenedAtLogin is false', async () => {
  const { api, calls } = setup();
  await api.launch();
  assert.deepEqual(calls, [{ type: 'launch', preferredPath: null }]);
});

test('registering startup writes the Windows login marker and reads the same arguments', () => {
  const { api, calls, config } = setup({ enabled: false, target: 'gptplus' });
  const saved = api.set({ enabled: true, target: 'both' });
  assert.deepEqual(calls, [{ type: 'register', enabled: true, args: ['--gptplus-startup'] }]);
  assert.equal(saved.enabled, true);
  assert.equal(saved.target, 'both');
  assert.equal(config.startup.target, 'both');
});

test('enabled legacy login entry is migrated without changing the selected target', () => {
  const { api, calls, config } = setup({ legacy: true });
  assert.equal(api.get().enabled, true);
  api.migrate();
  assert.deepEqual(calls, [{ type: 'register', enabled: true, args: ['--gptplus-startup'] }]);
  assert.equal(api.get().enabled, true);
  assert.equal(config.startup.target, 'both');
});

test('migration leaves disabled login entries and Task Manager overrides untouched', () => {
  for (const options of [{ enabled: false }, { legacy: true, taskManagerDisabled: true }]) {
    const { api, calls } = setup(options);
    api.migrate();
    assert.equal(api.get().enabled, false);
    assert.deepEqual(calls, []);
  }
});

test('ordinary Windows launches never use the macOS-only login flag', async () => {
  const { api, calls } = setup({ argv: ['gpt-plus.exe'], macLogin: true });
  await api.launch();
  assert.deepEqual(calls, []);
});

test('login launch respects the selected application, disabled state and test modes', async () => {
  for (const options of [
    { target: 'gptplus' }, { enabled: false }, { taskManagerDisabled: true },
    { isDev: true }, { isSmoke: true },
  ]) {
    const { api, calls } = setup(options);
    await api.launch();
    assert.deepEqual(calls, [], JSON.stringify(options));
  }
});

test('login second-instance command launches ChatGPT only once', async () => {
  const { api, calls, config } = setup({ argv: ['gpt-plus.exe'] });
  config.chatgpt.executablePath = 'D:\\Apps\\ChatGPT.exe';
  await Promise.all([
    api.launch(['gpt-plus.exe', '--gptplus-startup']),
    api.launch(['gpt-plus.exe', '--gptplus-startup']),
  ]);
  assert.deepEqual(calls, [{ type: 'launch', preferredPath: 'D:\\Apps\\ChatGPT.exe' }]);
});

test('startup logs launch failures instead of rejecting the background boot task', async () => {
  const { api, logs } = setup({ launchError: 'client unavailable' });
  await api.launch();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].msg, /client unavailable/);
});

test('macOS login still uses the platform login flag', async () => {
  const { api, calls } = setup({ platform: 'darwin', macLogin: true, legacy: true, argv: ['gpt-plus'] });
  await api.launch();
  assert.deepEqual(calls, [{ type: 'launch', preferredPath: null }]);
});
