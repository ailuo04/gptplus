'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _internal: { splitKeepEol, tableHeaderIndices, topLevelKey, tomlString, normalizeHost, gatewayAuthCommand } } = require('./codex-config.js');
const { resolveChatGptExe } = require('./chatgpt-install.js');
const { resolveCodexCli, chatGptBundledCodex } = require('./codex-cli.js');
const { createCodexAppServer } = require('./codex-app-server.js');

function readValue(lines, key) {
  const candidates = lines.filter((line) => topLevelKey(line) === key);
  return candidates.length === 1 ? candidates[0].slice(candidates[0].indexOf('=') + 1).trim() : '';
}

function readString(lines, key) {
  const value = readValue(lines, key);
  const match = /^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(value);
  if (!match) return null;
  if (match[1].startsWith("'")) return match[1].slice(1, -1);
  try { return JSON.parse(match[1]); } catch { return null; }
}

function samePath(a, b) {
  if (!a || !b || !path.isAbsolute(a)) return false;
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

function checkInjection({ text, gatewayState, catalogPath, expected, readFile, authConfigPath }) {
  const lines = splitKeepEol(text).map((line) => line.trimEnd());
  const headers = tableHeaderIndices(lines);
  const top = lines.slice(0, headers[0] ?? lines.length);
  if (readString(top, 'model_provider') !== 'gptplus') return 'Codex 未选用 gpt++ 网关提供商。';
  if (!samePath(readString(top, 'model_catalog_json'), catalogPath)) return 'Codex 模型目录指向错误或未配置。';
  const providerTable = headers.findIndex((i) => /^\s*\[\s*model_providers\s*\.\s*gptplus\s*\]\s*(?:#.*)?$/.test(lines[i]));
  if (providerTable === -1) return 'Codex 网关提供商段缺失。';
  const section = lines.slice(headers[providerTable] + 1, headers[providerTable + 1] ?? lines.length);
  const host = normalizeHost(gatewayState.host, '127.0.0.1');
  if (readString(section, 'base_url') !== 'http://' + host + ':' + gatewayState.port + '/v1') {
    return 'Codex 中的网关地址与正在运行的网关不一致。';
  }
  if (readString(section, 'wire_api') !== 'responses') return 'Codex 网关协议不是 Responses。';
  if (authConfigPath) {
    const authTable = headers.findIndex((i) => /^\s*\[\s*model_providers\s*\.\s*gptplus\s*\.\s*auth\s*\]\s*(?:#.*)?$/.test(lines[i]));
    const auth = authTable < 0 ? [] : lines.slice(headers[authTable] + 1, headers[authTable + 1] ?? lines.length);
    const expectedAuth = gatewayAuthCommand(authConfigPath);
    const rawArgs = /^(\[.*\])\s*(?:#.*)?$/.exec(readValue(auth, 'args'))?.[1];
    let args;
    try { args = JSON.parse(rawArgs); } catch { /* Missing or unrecognized app-managed auth arguments. */ }
    if (readString(auth, 'command')?.toLowerCase() !== expectedAuth.command ||
        !Array.isArray(args) || args.length !== expectedAuth.args.length ||
        args.some((value, i) => value !== expectedAuth.args[i])) return 'Codex 动态网关认证缺失或已偏离本机配置。';
  }
  if (!expected.has(readString(top, 'model'))) return 'Codex 默认模型不在启用的模型清单中。';
  let catalog;
  try { catalog = JSON.parse(readFile(catalogPath, 'utf8')); } catch { return '无法读取或解析已注入的模型目录。'; }
  if (!Array.isArray(catalog?.models)) return '已注入模型目录缺少模型数组。';
  const actual = new Set(catalog.models.filter((item) => item?.visibility === 'list' && item.supported_in_api === true).map((item) => item.slug));
  if (expected.size !== actual.size || [...expected].some((slug) => !actual.has(slug))) return '磁盘上的注入目录与当前启用模型不一致。';
  return '';
}

async function runHomeDiagnosis({ gateway, codex, injectionEnabled, catalogPath, models, listModels, authConfigPath, readFile = fs.readFileSync }) {
  const steps = [];
  let routableModels = [];
  const enabled = models.filter((model) => model.enabled && model.slug);
  const expected = new Set(enabled.map((model) => model.slug));
  const add = (id, state, detail, action) => steps.push({ id, state, detail, ...(action ? { action } : {}) });
  let probe;
  try { probe = await gateway.probe(); } catch { probe = { ok: false }; }
  if (probe.ok) add('gateway', 'ok', '本地探活通过 · ' + Math.round(probe.latencyMs || 0) + ' ms');
  else add('gateway', 'failed', '本地探活失败。请检查网关是否已启动及端口配置。', 'settings');
  const result = () => ({ steps, routableModels });
  const skipPicker = () => add('picker', 'skipped', '先通过网关和配置检查。');
  if (!probe.ok) {
    add('injection', 'skipped', '网关未通过，暂不检查注入。');
    skipPicker();
    return result();
  }
  const configError = !injectionEnabled ? '模型注入未打开。' : !expected.size ? '没有启用的模型。'
    : checkInjection({ text: codex.readText(), gatewayState: gateway.getState(), catalogPath, expected, readFile, authConfigPath });
  if (configError) {
    add('injection', 'failed', configError + ' 请到模型页检查启用状态或重新注入。', 'models');
    skipPicker();
    return result();
  }
  add('injection', 'ok', '磁盘配置与 ' + expected.size + ' 个启用模型一致。');
  try {
    const visible = await listModels(catalogPath);
    const slugs = new Set(visible.slugs);
    const matches = enabled.filter((model) => slugs.has(model.slug));
    const source = visible.engine === 'desktop' ? '桌面端内置 Codex 验证进程' : '独立 Codex CLI 验证进程（不等同于桌面端）';
    if (matches.length !== enabled.length) {
      add('picker', 'failed', source + '可见 ' + matches.length + '/' + enabled.length + ' 个模型。请检查模型目录。', 'models');
    } else {
      add('picker', visible.engine === 'desktop' ? 'ok' : 'partial', source + '可见 ' + matches.length + '/' + enabled.length + ' 个模型；不代表已打开的窗口已重新加载。');
      routableModels = matches.map(({ slug, label, providerName }) => ({ slug, label, providerName }));
    }
  } catch {
    add('picker', 'unavailable', '无法启动 Codex 验证进程或读取模型列表。请在已安装的客户端中重启并检查模型选择器。');
  }
  return result();
}

// Use an isolated Codex home without the user's auth, MCP, or plugin settings.
// Nothing is injected, restarted, or written to the real Codex home by this check.
async function listCatalogModels(catalogPath, { preferredPath, appVersion } = {}) {
  const desktopPath = await resolveChatGptExe({ preferredPath });
  const desktop = chatGptBundledCodex(desktopPath);
  const root = path.resolve(os.tmpdir());
  const temporary = await fs.promises.mkdtemp(path.join(root, 'gptplus-picker-'));
  try {
    const catalog = path.join(temporary, 'models.json');
    await fs.promises.copyFile(catalogPath, catalog);
    await fs.promises.writeFile(path.join(temporary, 'config.toml'), [
      'model_catalog_json = ' + tomlString(catalog),
      'model_provider = "gptplus"',
      '[model_providers.gptplus]',
      'name = "gpt++ Catalog Diagnosis"',
      'base_url = "http://127.0.0.1:1/v1"',
      'wire_api = "responses"',
      '',
    ].join('\n'), 'utf8');
    const inspect = async (candidate, engine) => {
      const appServer = await createCodexAppServer({
        executable: candidate.path, workDir: root, args: ['app-server', '--stdio'], appVersion,
        env: { CODEX_HOME: temporary, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
        configOverrides: ['features.plugins=false', 'features.remote_plugin=false'],
        clientInfo: { name: 'gptplus-diagnostics', title: 'gpt++ 模型目录诊断' }, initializeTimeoutMs: 8000, gracefulCloseMs: 1200,
      });
      try { return { slugs: await appServer.listModels({ timeoutMs: 5000 }), engine }; }
      finally { await appServer.close(); }
    };
    if (desktop) {
      try { return await inspect(desktop, 'desktop'); } catch { /* Some MSIX installs cannot launch an external child. */ }
    }
    const cli = await resolveCodexCli({ chatgptPath: preferredPath });
    if (cli.source === 'desktop' || cli.source === 'chatgpt' || !/\.exe$/i.test(cli.path)) {
      throw new Error('没有可独立运行的 Codex 验证进程');
    }
    return await inspect(cli, 'standalone');
  } finally {
    if (path.dirname(temporary) === root && path.basename(temporary).startsWith('gptplus-picker-')) {
      await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }
}

module.exports = { runHomeDiagnosis, listCatalogModels };
