'use strict';
// IPC 注册：把渲染层调用映射到 core 模块。契约见 spec.md 第 7 节。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeModelLimits, normalizeTheme, normalizeUpdateSettings } = require('./store.js');
const { normalizeBaseUrl } = require('./base-url.js');
const { slugForProvider } = require('./model-utils.js');
const { resolveChatGptExe } = require('./chatgpt-install.js');
const { relaunchChatGpt } = require('./chatgpt-launch.js');
const { launchChatGptWithUsageStatusline } = require('./chatgpt-statusline.js');
const { redactDiagnostic } = require('./redact.js');
const {
  hashPeerToken,
  normalizePeerBaseUrl,
  randomPeerId,
  createRemoteProviders,
  MIN_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
} = require('./peer-sharing.js');
const {
  FILE_EXTENSION,
  MAX_FILE_BYTES,
  createExportPayload,
  encryptProviderConfigPortable,
  decryptProviderConfig,
  inspectProviderConfigFile,
  createImportPlan,
  buildImportPreview,
  newTransferSessionId,
  ProviderTransferError,
} = require('./provider-transfer.js');

function sanitizeProviderInput(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('缺少提供商数据');
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('提供商名称不能为空');

  let baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim();
  if (!baseUrl) throw new Error('Base URL 不能为空');
  // 用户常直接粘贴完整端点 URL（.../v1/chat/completions），剥成 base，
  // 否则拼上游地址时会变成 .../chat/completions/chat/completions。
  baseUrl = normalizeBaseUrl(baseUrl);

  let apiKey = input.apiKey;
  if (apiKey === undefined || apiKey === null || apiKey === '') apiKey = existing?.apiKey ?? '';
  apiKey = String(apiKey).trim();

  const api = input.api === 'anthropic' || input.api === 'responses' ? input.api : 'openai';

  const headers = {};
  const rawHeaders = input.headers && typeof input.headers === 'object' ? input.headers : existing?.headers || {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = String(k).trim();
    if (!key) continue;
    headers[key] = String(v ?? '');
  }

  const models = [];
  const seen = new Set();
  for (const m of Array.isArray(input.models) ? input.models : existing?.models || []) {
    const id = String(typeof m === 'string' ? m : m?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: String((typeof m === 'object' && m?.label) || id).trim() || id,
      enabled: typeof m === 'object' && m?.enabled === false ? false : true,
      reasoning: typeof m === 'object' && m?.reasoning === true,
      ...(typeof m === 'object' && m?.isNew === true ? { isNew: true } : {}),
      ...(typeof m === 'object' && m?.detected === false ? { detected: false } : {}),
      ...(typeof m === 'object' && Number.isFinite(Number(m?.missingSince)) ? { missingSince: Number(m.missingSince) } : {}),
    });
  }

  return {
    name,
    baseUrl,
    apiKey,
    api,
    headers,
    models,
    enabled: input.enabled === undefined ? existing?.enabled !== false : input.enabled !== false,
  };
}

function withDerived(p) {
  return { ...p, hasKey: !!p.apiKey };
}

function writeBinaryAtomic(targetPath, bytes) {
  const target = String(targetPath || '').trim();
  if (!target) throw new Error('导出路径无效');
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(
    dir,
    `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    // Electron 的保存对话框已经处理了覆盖确认；先准备完整临时文件，再替换目标，
    // 避免写入过程中留下半个明文/密文文件。
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
  }
}

function dateFileStamp(date = new Date()) {
  const p = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

/**
 * @param {{ ipcMain:any, shell:any, dialog:any, ctx:any, updater?:any, startup?:any,
 *           onStatus?:(s:any)=>void, onLog?:(e:any)=>void }} deps
 */
function registerIpc(deps) {
  const { ipcMain, shell, dialog, clipboard, secretStorage, ctx, updater, startup, onStatus = () => {}, onLog = () => {} } = deps;
  const { store } = ctx;
  const plugins = ctx.plugins || null;
  const importSessions = new Map();
  const IMPORT_SESSION_TTL = 5 * 60 * 1000;

  function forgetImportSession(sessionId) {
    const session = importSessions.get(sessionId);
    if (!session) return false;
    if (session.timer) clearTimeout(session.timer);
    importSessions.delete(sessionId);
    return true;
  }

  function rememberImportSession(payload) {
    const sessionId = newTransferSessionId();
    const timer = setTimeout(() => forgetImportSession(sessionId), IMPORT_SESSION_TTL);
    if (typeof timer.unref === 'function') timer.unref();
    importSessions.set(sessionId, { payload, timer, existing: store.providers() });
    return sessionId;
  }

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_evt, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        const transfer = channel === 'gptplus:provider:export' || channel.startsWith('gptplus:provider:import:');
        const message = transfer
          ? err instanceof ProviderTransferError ? err.message : '配置文件操作失败，现有提供商配置未修改'
          : redactDiagnostic(err && err.message ? err.message : String(err), store.providers());
        ctx.log({ level: 'error', msg: `${channel}: ${message}` });
        throw new Error(message);
      }
    });
  };

  const publish = () => {
    const s = ctx.status();
    const peer = typeof ctx.peerState === 'function' ? ctx.peerState() : null;
    const next = peer ? { ...s, peer } : s;
    onStatus(next);
    return next;
  };

  const afterChange = () => {
    const cfg = store.get();
    if (cfg.inject.enabled) {
      try {
        ctx.syncInjection({ apply: true });
      } catch (err) {
        ctx.log({ level: 'error', msg: '同步注入失败: ' + err.message });
        throw err;
      }
    }
    return publish();
  };

  // ---- 状态 ----
  handle('gptplus:status:get', () => ctx.status());
  handle('gptplus:plugin:list', () => plugins ? plugins.list() : []);
  handle('gptplus:plugin:install', (id) => {
    if (!plugins) throw new Error('插件管理器不可用');
    return plugins.install(id);
  });
  handle('gptplus:plugin:uninstall', async (id) => {
    if (!plugins) throw new Error('插件管理器不可用');
    const plugin = plugins.get(id);
    if (plugin.id === 'weixin') await ctx.weixinConnect?.stop?.({ persist: false });
    return plugins.uninstall(id);
  });
  handle('gptplus:plugin:enabled:set', async (patch = {}) => {
    if (!plugins) throw new Error('插件管理器不可用');
    const id = String(patch.id || '').trim();
    const enabled = patch.enabled === true;
    if (!enabled && id === 'weixin') await ctx.weixinConnect?.stop?.({ persist: false });
    return plugins.setEnabled(id, enabled);
  });
  handle('gptplus:plugin:config:set', (patch = {}) => {
    if (!plugins) throw new Error('插件管理器不可用');
    return plugins.setConfig(String(patch.id || '').trim(), patch.config);
  });
  handle('gptplus:update:state', () => updater?.getState?.() || { enabled: false, status: 'disabled' });
  handle('gptplus:update:check', () => updater?.checkForUpdates?.() || { enabled: false, status: 'disabled' });
  handle('gptplus:update:interval:set', (patch = {}) => {
    const raw = patch && typeof patch === 'object' ? patch.checkIntervalMinutes : patch;
    const next = normalizeUpdateSettings({ checkIntervalMinutes: raw }).checkIntervalMinutes;
    if (Number(raw) !== next) throw new Error('自动检查间隔必须是 5-1440 分钟之间的整数');
    store.update((draft) => {
      draft.updates = { ...draft.updates, checkIntervalMinutes: next };
    });
    return updater?.setCheckIntervalMinutes?.(next) || { enabled: false, status: 'disabled', checkIntervalMinutes: next };
  });
  handle('gptplus:update:download', () => updater?.downloadUpdate?.() || { enabled: false, status: 'disabled' });
  handle('gptplus:update:rollbacks', () => updater?.listRollbackReleases?.() || []);
  handle('gptplus:update:rollback', (version) => updater?.rollbackToVersion?.(version) || { enabled: false, status: 'disabled' });
  handle('gptplus:theme:get', () => store.get().theme);
  handle('gptplus:theme:set', (patch = {}) => {
    const raw = typeof patch === 'string' ? patch : patch && patch.theme;
    const theme = normalizeTheme(raw);
    if (raw !== theme) throw new Error('主题必须是 dark、light 或 system');
    store.update((draft) => {
      draft.theme = theme;
    });
    return publish();
  });

  // ---- 开机自启动 ----
  handle('gptplus:startup:get', () => {
    const current = startup?.get?.();
    return current && typeof current === 'object'
      ? {
          supported: current.supported !== false,
          enabled: !!current.enabled,
          target: current.target === 'both' ? 'both' : 'gptplus',
        }
      : { supported: false, enabled: false, target: 'gptplus' };
  });

  handle('gptplus:startup:set', (patch = {}) => {
    const raw = typeof patch === 'boolean' ? patch : patch && patch.enabled;
    if (typeof raw !== 'boolean') throw new Error('开机自启动开关参数无效');
    if (typeof startup?.set !== 'function') throw new Error('当前系统不支持开机自启动');
    const current = startup.get?.();
    const target = typeof patch === 'object' && patch?.target !== undefined
      ? patch.target
      : current?.target;
    if (target !== undefined && target !== 'gptplus' && target !== 'both') {
      throw new Error('开机自启动目标无效');
    }
    const result = startup.set({ enabled: raw, target: target === 'both' ? 'both' : 'gptplus' });
    const next = result && typeof result === 'object'
      ? {
          supported: result.supported !== false,
          enabled: !!result.enabled,
          target: result.target === 'both' ? 'both' : 'gptplus',
        }
      : { supported: true, enabled: raw, target: target === 'both' ? 'both' : 'gptplus' };
    ctx.log({ level: 'info', msg: next.enabled ? '已开启开机自启动' : '已关闭开机自启动' });
    return next;
  });

  // ---- 网络与代理 ----
  handle('gptplus:network:get', () => {
    const cfg = store.get();
    return { proxyMode: cfg.network.proxyMode };
  });

  handle('gptplus:network:set', (patch = {}) => {
    const nextMode = patch.proxyMode === 'direct' ? 'direct' : patch.proxyMode === 'system' ? 'system' : null;
    if (!nextMode) throw new Error('代理模式必须是 system 或 direct');
    const before = store.get();
    try {
      store.update((draft) => {
        draft.network.proxyMode = nextMode;
      });
      if (typeof ctx.network?.setMode === 'function') ctx.network.setMode(nextMode);
    } catch (err) {
      store.save(before);
      throw err;
    }
    ctx.log({ level: 'info', msg: nextMode === 'system' ? '网络模式已切换为跟随系统代理' : '网络模式已切换为直连' });
    return publish();
  });

  // ---- 提供商 ----
  handle('gptplus:provider:list', () => store.providers().map(withDerived));

  handle('gptplus:provider:save', (input) => {
    const before = store.get();
    const existing = input && input.id ? store.getProvider(input.id) : undefined;
    const clean = sanitizeProviderInput(input, existing);
    store.upsertProvider({ id: existing?.id, ...clean });
    try {
      afterChange();
    } catch (err) {
      store.save(before);
      if (before.inject.enabled) {
        try {
          ctx.syncInjection({ apply: true });
        } catch (restoreErr) {
          ctx.log({ level: 'error', msg: '提供商保存已回滚，但注入状态恢复失败: ' + restoreErr.message });
        }
      }
      throw err;
    }
    ctx.log({ level: 'info', msg: `已保存提供商「${clean.name}」，模型 ${clean.models.length} 个` });
    return store.providers().map(withDerived);
  });

  handle('gptplus:provider:delete', (id) => {
    const before = store.get();
    const p = store.getProvider(id);
    const ok = store.removeProvider(id);
    try {
      afterChange();
    } catch (err) {
      store.save(before);
      if (before.inject.enabled) {
        try {
          ctx.syncInjection({ apply: true });
        } catch (restoreErr) {
          ctx.log({ level: 'error', msg: '提供商删除已回滚，但注入状态恢复失败: ' + restoreErr.message });
        }
      }
      throw err;
    }
    if (ok && p) ctx.log({ level: 'warn', msg: `已删除提供商「${p.name}」` });
    return store.providers().map(withDerived);
  });

  // ---- 提供商配置安全导入/导出 ----
  handle('gptplus:provider:export', async (input = {}) => {
    const providerIds = input && Array.isArray(input.providerIds) ? input.providerIds : null;
    const payload = createExportPayload(store.get(), providerIds);
    const encrypted = encryptProviderConfigPortable(payload);
    if (typeof dialog?.showSaveDialog !== 'function') throw new ProviderTransferError('UNAVAILABLE', '当前环境不支持导出配置文件');

    const defaultPath = path.join(
      ctx.paths.APP_DIR || path.dirname(ctx.paths.CONFIG_PATH || process.cwd()),
      `gptplus-providers-${dateFileStamp()}.${FILE_EXTENSION.slice(1)}`,
    );
    const picked = await dialog.showSaveDialog({
      title: '导出便携提供商配置',
      defaultPath,
      filters: [{ name: 'gpt++ 提供商配置', extensions: [FILE_EXTENSION.slice(1)] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (!picked || picked.canceled || !picked.filePath) return { canceled: true };

    let target = String(picked.filePath);
    if (!target.toLowerCase().endsWith(FILE_EXTENSION)) target += FILE_EXTENSION;
    writeBinaryAtomic(target, encrypted);
    ctx.log({ level: 'info', msg: `已导出提供商配置（便携加密，${payload.providers.length} 个）` });
    return { canceled: false, fileName: path.basename(target), count: payload.providers.length };
  });

  handle('gptplus:provider:import:pick', async () => {
    if (typeof dialog?.showOpenDialog !== 'function') throw new ProviderTransferError('UNAVAILABLE', '当前环境不支持选择配置文件');
    const picked = await dialog.showOpenDialog({
      title: '选择便携加密提供商配置',
      properties: ['openFile'],
      filters: [{ name: 'gpt++ 便携加密提供商配置', extensions: [FILE_EXTENSION.slice(1)] }],
    });
    if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths[0]) {
      return { canceled: true };
    }
    const filePath = picked.filePaths[0];
    if (!String(filePath).toLowerCase().endsWith(FILE_EXTENSION)) {
      throw new ProviderTransferError('INVALID_FILE_TYPE', `请选择 ${FILE_EXTENSION} 便携加密配置文件`);
    }
    let bytes;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not-file');
      if (stat.size === 0) throw new ProviderTransferError('EMPTY_FILE', '配置文件为空');
      if (stat.size > MAX_FILE_BYTES) throw new ProviderTransferError('FILE_TOO_LARGE', '配置文件超过大小限制');
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      if (err instanceof ProviderTransferError) throw err;
      throw new ProviderTransferError('READ_FAILED', '读取配置文件失败');
    }
    return {
      canceled: false,
      fileName: path.basename(filePath),
      bytes,
    };
  });

  handle('gptplus:provider:import:inspect', (input = {}) => inspectProviderConfigFile({
    fileName: input && input.fileName,
    bytes: input && input.bytes,
  }));

  handle('gptplus:provider:import:prepare', (input = {}) => {
    const payload = decryptProviderConfig({
      fileName: input && input.fileName,
      bytes: input && input.bytes,
    });
    const sessionId = rememberImportSession(payload);
    return {
      sessionId,
      preview: buildImportPreview(payload, store.providers()),
    };
  });

  handle('gptplus:provider:import:cancel', (sessionId) => {
    forgetImportSession(String(sessionId || ''));
    return { canceled: true };
  });

  handle('gptplus:provider:import:apply', (input = {}) => {
    const sessionId = String(input && input.sessionId || '');
    const session = importSessions.get(sessionId);
    if (!session) throw new ProviderTransferError('SESSION_EXPIRED', '导入预览已过期，请重新选择配置文件');

    const before = store.get();
    if (Array.isArray(input.decisions) && input.decisions.some((item) => item?.action === 'overwrite')) {
      if (input.overwriteConfirmed !== true) {
        throw new ProviderTransferError('CONFIRM_OVERWRITE', '请再次确认覆盖同名提供商');
      }
      for (const decision of input.decisions.filter((item) => item?.action === 'overwrite')) {
        const source = session.payload.providers.find((provider) => provider.id === decision.sourceId);
        const matches = session.existing.filter((provider) => source && provider.name.trim().toLowerCase() === source.name.trim().toLowerCase());
        if (matches.length !== 1 || JSON.stringify(store.getProvider(matches[0].id)) !== JSON.stringify(matches[0])) {
          throw new ProviderTransferError('STALE_PREVIEW', '覆盖目标已变化，请重新预览导入配置');
        }
      }
    }
    const plan = createImportPlan({
      currentConfig: before,
      payload: session.payload,
      decisions: input && input.decisions,
    });
    if (plan.sourceTargets.size === 0) {
      forgetImportSession(sessionId);
      return { providers: store.providers().map(withDerived), counts: plan.counts, status: ctx.status() };
    }
    let result;
    try {
      result = store.transaction(plan.config, () => {
        // 全量导入也可能关闭注入，必须同步关闭状态，不能只处理 enabled=true。
        if (before.inject.enabled || plan.config.inject.enabled) ctx.syncInjection({ apply: true });
        return { providers: store.providers().map(withDerived), counts: plan.counts, status: ctx.status() };
      });
    } catch (err) {
      if (before.inject.enabled || plan.config.inject.enabled) {
        try {
          ctx.syncInjection({ apply: true });
        } catch {
          ctx.log({ level: 'error', msg: '提供商导入已回滚，但注入状态恢复失败' });
        }
      }
      throw new ProviderTransferError('IMPORT_FAILED', '导入失败，提供商配置已回滚');
    }
    forgetImportSession(sessionId);
    ctx.log({
      level: 'info',
      msg: `已导入提供商配置（新增 ${plan.counts.added} 个，覆盖 ${plan.counts.overwritten} 个，跳过 ${plan.counts.skipped} 个）`,
    });
    onStatus(result.status);
    return result;
  });

  handle('gptplus:provider:test', (id) => ctx.providerClient.testProvider(id));
  handle('gptplus:provider:models:test', (patch = {}) => {
    const providerId = String(patch.providerId || '').trim();
    const modelIds = Array.isArray(patch.modelIds) ? patch.modelIds : [];
    return ctx.providerClient.testProviderModels(providerId, modelIds);
  });
  handle('gptplus:provider:models:remote', (id) => ctx.providerClient.fetchRemoteModels(id));

  // ---- 对等共享与远端同步 ----
  handle('gptplus:peer:state:get', () => ctx.peerState());

  handle('gptplus:sharing:set', async (patch = {}) => {
    const before = store.get();
    const enabled = patch.enabled === undefined ? before.sharing.enabled : !!patch.enabled;
    const selected = Array.isArray(patch.models) ? patch.models : before.sharing.models;
    const valid = [];
    const seen = new Set();
    for (const item of selected) {
      const providerId = String(item?.providerId || '').trim();
      const modelId = String(item?.modelId || '').trim();
      const key = providerId + '::' + modelId;
      const provider = store.getProvider(providerId);
      const model = provider?.models?.find((candidate) => candidate.id === modelId);
      if (!provider || provider.remote || !model || seen.has(key)) continue;
      seen.add(key);
      valid.push({ providerId, modelId });
    }
    if (enabled && !valid.some((item) => {
      const provider = store.getProvider(item.providerId);
      const model = provider?.models?.find((candidate) => candidate.id === item.modelId);
      return provider?.enabled !== false && model?.enabled !== false;
    })) throw new Error('请至少选择一个已启用的本机模型');
    if (enabled && !store.get().gateway.enabled) throw new Error('请先启用本地网关');
    if (enabled && !ctx.gateway.getState().running) {
      await ctx.gateway.start({ port: before.gateway.port, host: before.gateway.host || '127.0.0.1', token: before.gateway.token });
    }
    store.update((draft) => {
      draft.sharing.enabled = enabled;
      if (patch.name !== undefined) draft.sharing.name = String(patch.name || '').trim().slice(0, 128) || '我的共享端';
      draft.sharing.models = valid;
    });
    ctx.log({ level: 'info', msg: enabled ? '已开启本机模型共享（' + valid.length + ' 个模型）' : '已关闭本机模型共享' });
    return { ...ctx.peerState(), status: publish() };
  });

  handle('gptplus:sharing:client:add', (patch = {}) => {
    if (typeof clipboard?.writeText !== 'function') throw new Error('当前环境不能安全复制共享授权令牌');
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const id = randomPeerId('client');
    const name = String(patch.name || '新客户端').trim().slice(0, 80) || '新客户端';
    const createdAt = Date.now();
    store.update((draft) => {
      draft.sharing.clients.push({ id, name, createdAt, tokenHash: hashPeerToken(rawToken) });
    });
    try {
      clipboard.writeText(rawToken);
    } catch (error) {
      store.update((draft) => { draft.sharing.clients = draft.sharing.clients.filter((client) => client.id !== id); });
      throw new Error('复制授权令牌失败，未创建客户端授权');
    }
    ctx.log({ level: 'info', msg: '已添加共享客户端「' + name + '」' });
    publish();
    return { id, name, createdAt, copied: true, state: ctx.peerState() };
  });

  handle('gptplus:sharing:client:revoke', (id) => {
    const clientId = String(id || '').trim();
    let removed = false;
    store.update((draft) => {
      const beforeCount = draft.sharing.clients.length;
      draft.sharing.clients = draft.sharing.clients.filter((client) => client.id !== clientId);
      removed = beforeCount !== draft.sharing.clients.length;
    });
    if (removed) ctx.log({ level: 'warn', msg: '已撤销一个共享客户端授权' });
    publish();
    return { ...ctx.peerState(), removed };
  });

  handle('gptplus:remote:sync:set', (patch = {}) => {
    const current = store.get().remoteSync;
    const enabled = patch.enabled === undefined ? current.enabled : !!patch.enabled;
    const interval = patch.intervalMinutes === undefined ? current.intervalMinutes : Number(patch.intervalMinutes);
    if (!Number.isInteger(interval) || interval < MIN_SYNC_INTERVAL_MINUTES || interval > MAX_SYNC_INTERVAL_MINUTES) {
      throw new Error('同步间隔必须是 ' + MIN_SYNC_INTERVAL_MINUTES + '-' + MAX_SYNC_INTERVAL_MINUTES + ' 分钟之间的整数');
    }
    store.update((draft) => { draft.remoteSync.enabled = enabled; draft.remoteSync.intervalMinutes = interval; });
    ctx.remoteSync.configure();
    return { ...ctx.peerState(), status: publish() };
  });

  handle('gptplus:remote:connection:save', (patch = {}) => {
    const existing = patch.id ? store.get().remoteSync.connections.find((item) => item.id === patch.id) : null;
    const id = existing?.id || randomPeerId('conn');
    const name = String(patch.name || existing?.name || '远端连接').trim().slice(0, 80) || '远端连接';
    const baseUrl = normalizePeerBaseUrl(patch.baseUrl === undefined ? existing?.baseUrl : patch.baseUrl);
    // 优先使用 renderer 直接传入的令牌；兼容旧版剪贴板流程作为备用。
    const authToken = String(patch.authToken || clipboard?.readText?.() || '').trim();
    if (!authToken) throw new Error('请输入对端授权令牌');
    if (!patch.authToken) { try { clipboard.clear?.(); } catch { /* The token remains protected by OS clipboard permissions. */ } }
    store.update((draft) => {
      const item = draft.remoteSync.connections.find((connection) => connection.id === id);
      const next = { id, name, baseUrl, authToken, enabled: patch.enabled === undefined ? item?.enabled !== false : patch.enabled !== false,
        sourceId: item?.sourceId || null, lastAttemptAt: item?.lastAttemptAt || null, lastSuccessAt: item?.lastSuccessAt || null, lastError: item?.lastError || '' };
      if (item) Object.assign(item, next);
      else draft.remoteSync.connections.push(next);
    });
    ctx.remoteSync.configure();
    ctx.log({ level: 'info', msg: '已保存远端连接「' + name + '」' });
    publish();
    return { ...ctx.peerState(), connection: { id, name } };
  });

  handle('gptplus:remote:connection:set-enabled', (patch = {}) => {
    const id = String(patch.id || '').trim();
    const enabled = patch.enabled !== false;
    store.update((draft) => {
      const connection = draft.remoteSync.connections.find((item) => item.id === id);
      if (!connection) throw new Error('远端连接不存在');
      connection.enabled = enabled;
    });
    ctx.remoteSync.configure();
    publish();
    return { ...ctx.peerState(), enabled };
  });

  handle('gptplus:remote:connection:delete', (id) => {
    const connectionId = String(id || '').trim();
    store.update((draft) => {
      draft.remoteSync.connections = draft.remoteSync.connections.filter((connection) => connection.id !== connectionId);
      for (const source of draft.remoteSync.sources) if (source.connectionId === connectionId) source.connectionId = null;
    });
    ctx.remoteSync.configure();
    publish();
    return ctx.peerState();
  });

  handle('gptplus:remote:sync:now', async (id) => {
    const result = await ctx.remoteSync.syncConnection(String(id || '').trim());
    return { result, state: ctx.peerState(), status: publish() };
  });

  function findRemoteModel(providerId, modelId, draft) {
    const { createRemoteProviders } = require('./peer-sharing.js');
    const provider = createRemoteProviders(draft, { includeHidden: true }).find((item) => item.id === providerId);
    if (!provider) throw new Error('远端来源不存在');
    const model = provider.models.find((item) => item.id === modelId);
    if (!model) throw new Error('远端模型不存在');
    const source = draft.remoteSync.sources.find((item) => item.id === provider.sourceId);
    if (!source) throw new Error('远端清单不存在');
    const stored = source.models.find((item) => item.id === modelId);
    if (!stored) throw new Error('远端模型不存在');
    return { provider, source, stored };
  }

  function updateRemoteModel(providerId, modelId, mutate) {
    const before = store.get();
    const key = providerId + '::' + modelId;
    const remoteProviders = createRemoteProviders(before, { includeHidden: true });
    const remoteProvider = remoteProviders.find((item) => item.id === providerId);
    if (!remoteProvider) throw new Error('远端来源不存在');
    const model = remoteProvider.models.find((item) => item.id === modelId);
    if (!model) throw new Error('远端模型不存在');
    try {
      store.update((draft) => {
        const found = findRemoteModel(providerId, modelId, draft);
        mutate(found.stored, draft, found);
      });
      if (store.get().inject.enabled && !ctx.models().some((item) => item.enabled)) {
        store.update((draft) => {
          draft.inject.enabled = false;
          draft.inject.catalogPath = null;
          draft.inject.defaultModel = null;
        });
        ctx.codex.applyInjection({ enabled: false });
        ctx.markWrite(true);
        ctx.log({ level: 'warn', msg: '没有剩余启用模型，已还原 ChatGPT 官方模型' });
        return publish();
      }
      if (store.get().inject.enabled) ctx.syncInjection({ apply: true });
      return publish();
    } catch (error) {
      store.save(before);
      if (before.inject.enabled) {
        try { ctx.syncInjection({ apply: true }); }
        catch (restoreError) { ctx.log({ level: 'error', msg: '远端模型操作已回滚，但目录恢复失败: ' + restoreError.message }); }
      }
      throw error;
    }
  }

  handle('gptplus:remote:model:enabled:set', ({ providerId, modelId, enabled } = {}) => {
    return updateRemoteModel(providerId, modelId, (model) => { model.enabled = !!enabled; });
  });

  handle('gptplus:remote:model:delete', ({ providerId, modelId } = {}) => {
    return updateRemoteModel(providerId, modelId, (model, draft) => {
      model.hidden = true;
      model.enabled = false;
      draft.modelOrder = (draft.modelOrder || []).filter((item) => item !== providerId + '::' + modelId);
      if (draft.inject.defaultModel === slugForProvider(
        createRemoteProviders(draft, { includeHidden: true }).find((item) => item.id === providerId),
        modelId,
        [...store.providers(), ...createRemoteProviders(draft, { includeHidden: true })],
      )) draft.inject.defaultModel = null;
    });
  });

  handle('gptplus:remote:model:restore', ({ providerId, modelId } = {}) => {
    return updateRemoteModel(providerId, modelId, (model, draft) => {
      model.hidden = false;
      const key = providerId + '::' + modelId;
      if (!draft.modelOrder.includes(key)) draft.modelOrder.push(key);
    });
  });

  handle('gptplus:remote:model:label:set', ({ providerId, modelId, label } = {}) => {
    const next = String(label || '').trim();
    if (!next || next.length > 512) throw new Error('显示名不能为空且不能超过 512 个字符');
    return updateRemoteModel(providerId, modelId, (model) => { model.label = next; model.customLabel = next; });
  });

  // ---- 微信连接（iLink） ----
  function requireWeixinPlugin() {
    if (plugins && !plugins.isActive('weixin')) throw new Error('微信连接插件未启用');
  }

  function weixinView() {
    const cfg = store.get().weixin;
    return {
      ...cfg,
      status: ctx.weixinConnect.getStatus(),
    };
  }

  handle('gptplus:weixin:get', () => weixinView());
  handle('gptplus:weixin:status', () => ctx.weixinConnect.getStatus());

  handle('gptplus:weixin:set', (patch = {}) => {
    const current = store.get().weixin;
    const next = { ...current };
    for (const key of ['baseUrl', 'token', 'accountId', 'allowFrom', 'routeTag', 'workDir', 'model', 'codexPath']) {
      if (patch[key] !== undefined) next[key] = String(patch[key] ?? '').trim();
    }
    if (patch.sandbox !== undefined) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(patch.sandbox)) {
        throw new Error('无效的沙箱权限');
      }
      next.sandbox = patch.sandbox;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
    if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) throw new Error('iLink API 地址必须是 http(s) URL');
    next.baseUrl = next.baseUrl.replace(/\/+$/, '');
    if (next.enabled && !next.token) throw new Error('请先扫码登录微信');

    store.update((draft) => {
      draft.weixin = next;
    });
    ctx.log({ level: 'info', msg: '微信连接设置已保存' });
    return weixinView();
  });

  handle('gptplus:weixin:start', async () => {
    requireWeixinPlugin();
    const result = await ctx.weixinConnect.start();
    ctx.log(result.ok
      ? { level: 'info', msg: '微信连接已启动' }
      : { level: 'warn', msg: `微信连接启动失败: ${result.error}` });
    return result;
  });

  handle('gptplus:weixin:stop', async () => {
    const result = await ctx.weixinConnect.stop();
    ctx.log({ level: 'warn', msg: '微信连接已停止' });
    return result;
  });

  handle('gptplus:weixin:qr:start', (patch = {}) => {
    requireWeixinPlugin();
    return ctx.weixinConnect.qrStart({
      baseUrl: patch.baseUrl,
      routeTag: patch.routeTag,
    });
  });
  handle('gptplus:weixin:qr:status', () => ctx.weixinConnect.qrStatus());

  handle('gptplus:weixin:pick-workdir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择微信连接工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  handle('gptplus:weixin:pick-codex', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Codex CLI',
      properties: ['openFile'],
      filters: [{ name: 'Codex CLI', extensions: ['exe', 'cmd', 'bat'] }],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  handle('gptplus:weixin:detect-codex', async () => {
    const { resolveCodexCli } = require('./codex-cli.js');
    return resolveCodexCli({ chatgptPath: store.get().chatgpt?.executablePath || null });
  });

  handle('gptplus:weixin:open-link', async (url) => {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) throw new Error('只允许打开 http(s) 链接');
    await shell.openExternal(value);
    return true;
  });

  // ---- 模型与网关 ----
  handle('gptplus:models:list', () => ctx.models());
  handle('gptplus:model:enabled:set', ({ providerId, modelId, enabled } = {}) => {
    const next = !!enabled;
    const before = store.get();
    const remoteProvider = createRemoteProviders(before, { includeHidden: true }).find((item) => item.id === providerId);
    if (remoteProvider) {
      return updateRemoteModel(providerId, modelId, (model) => {
        if (model.hidden) throw new Error('远端模型不存在或已删除');
        model.enabled = next;
      });
    }
    let changed = false;
    store.update((draft) => {
      const provider = (draft.providers || []).find((item) => item.id === providerId);
      const model = provider && (provider.models || []).find((item) => item.id === modelId);
      if (!model) throw new Error('模型不存在');
      if (model.enabled !== next) { model.enabled = next; changed = true; }
    });
    try {
      if (changed) ctx.log({ level: 'info', msg: '模型已' + (next ? '启用' : '停用') + ': ' + providerId + '__' + modelId, providerId, model: modelId });
      return afterChange();
    } catch (err) {
      store.save(before);
      throw err;
    }
  });

  handle('gptplus:model:delete', ({ providerId, modelId } = {}) => {
    const before = store.get();
    const remoteProvider = createRemoteProviders(before, { includeHidden: true }).find((item) => item.id === providerId);
    if (remoteProvider) {
      return updateRemoteModel(providerId, modelId, (model) => {
        model.hidden = true;
        model.enabled = false;
      });
    }
    const provider = store.getProvider(providerId);
    if (!provider) throw new Error('提供商不存在');
    const target = (provider.models || []).find((item) => item.id === modelId);
    if (!target) throw new Error('模型不存在');

    const key = providerId + '::' + modelId;
    const deletedSlug = slugForProvider(provider, modelId, store.providers());
    const remainingEnabled = ctx.models().filter((model) => model.orderKey !== key && model.enabled);

    store.update((draft) => {
      const item = (draft.providers || []).find((p) => p.id === providerId);
      if (!item) throw new Error('提供商不存在');
      item.models = (item.models || []).filter((model) => model.id !== modelId);
      draft.modelOrder = (draft.modelOrder || []).filter((orderKey) => orderKey !== key);
      if (draft.inject.defaultModel === deletedSlug) draft.inject.defaultModel = null;
    });

    try {
      // 删掉最后一个启用模型时目录会变空，客户端遇到空目录会静默回退，
      // 同步注入也必然失败。与其把删除回滚回去，不如像手动关闭注入一样
      // 还原官方模型，让用户想删的模型真的被删掉。
      if (before.inject.enabled && remainingEnabled.length === 0) {
        store.update((draft) => {
          draft.inject.enabled = false;
          draft.inject.catalogPath = null;
          draft.inject.defaultModel = null;
        });
        ctx.codex.applyInjection({ enabled: false });
        ctx.markWrite(true);
        ctx.log({
          level: 'warn',
          msg: `已删除模型「${target.label || modelId}」；没有剩余启用模型，已还原 ChatGPT 官方模型`,
          providerId,
          model: modelId,
        });
        return publish();
      }
      const status = afterChange();
      ctx.log({
        level: 'warn',
        msg: `已删除模型「${target.label || modelId}」: ${key}`,
        providerId,
        model: modelId,
      });
      return status;
    } catch (err) {
      store.save(before);
      if (before.inject.enabled) {
        try {
          ctx.syncInjection({ apply: true });
        } catch (restoreErr) {
          ctx.log({ level: 'error', msg: '模型删除已回滚，但注入状态恢复失败: ' + restoreErr.message });
        }
      }
      throw err;
    }
  });

  handle('gptplus:model:move', ({ providerId, modelId, direction } = {}) => {
    const sign = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (!sign) throw new Error('无效的排序方向');
    const cfg = store.get();
    const models = [];
    for (const provider of cfg.providers || []) {
      for (const model of provider.models || []) {
        if (model && model.id) models.push({ key: provider.id + '::' + model.id });
      }
    }
    for (const model of ctx.models().filter((item) => item.remote)) models.push({ key: model.orderKey });
    const current = Array.isArray(cfg.modelOrder) ? cfg.modelOrder.filter((key) => models.some((item) => item.key === key)) : [];
    for (const item of models) if (!current.includes(item.key)) current.push(item.key);
    const key = providerId + '::' + modelId;
    const index = current.indexOf(key);
    const target = index + sign;
    if (index < 0 || target < 0 || target >= current.length) return afterChange();
    [current[index], current[target]] = [current[target], current[index]];
    store.update((draft) => { draft.modelOrder = current; });
    ctx.log({ level: 'info', msg: '模型顺序已调整: ' + key, providerId, model: modelId });
    return afterChange();
  });

  handle('gptplus:model:reorder', ({ orderKeys } = {}) => {
    if (!Array.isArray(orderKeys) || orderKeys.some((key) => typeof key !== 'string')) {
      throw new Error('orderKeys 必须是字符串数组');
    }
    const cfg = store.get();
    const modelKeys = [];
    for (const provider of cfg.providers || []) {
      for (const model of provider.models || []) {
        if (model && model.id) modelKeys.push(provider.id + '::' + model.id);
      }
    }
    for (const model of ctx.models().filter((item) => item.remote)) if (model.orderKey) modelKeys.push(model.orderKey);
    const validKeys = new Set(modelKeys);
    const next = [];
    for (const key of orderKeys) {
      if (validKeys.has(key) && !next.includes(key)) next.push(key);
    }
    for (const key of modelKeys) if (!next.includes(key)) next.push(key);
    store.update((draft) => { draft.modelOrder = next; });
    ctx.log({ level: 'info', msg: '模型顺序已批量更新' });
    return afterChange();
  });


  handle('gptplus:model-limits:get', () => store.get().modelLimits);

  handle('gptplus:model-limits:set', (patch = {}) => {
    const current = store.get().modelLimits;
    const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    const contextWindow = Number(next.contextWindow);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 100_000_000) {
      throw new Error('上下文窗口必须是 1024-100000000 之间的整数');
    }
    const compactRaw = next.autoCompactTokenLimit;
    if (compactRaw !== null && compactRaw !== undefined && String(compactRaw).trim() !== '') {
      const compact = Number(compactRaw);
      // 与 store.normalizeModelLimits 同一套边界：允许等于窗口（= 满了才压缩）
      if (!Number.isSafeInteger(compact) || compact < 1024 || compact > contextWindow) {
        throw new Error('自动压缩阈值必须是 1024 到上下文窗口（含）之间的整数，或留空关闭');
      }
    }
    store.update((d) => {
      d.modelLimits = normalizeModelLimits(next);
    });
    return afterChange();
  });

  handle('gptplus:gateway:get', () => {
    const cfg = store.get();
    const st = ctx.gateway.getState();
    return {
      enabled: !!cfg.gateway.enabled,
      running: !!st.running,
      port: st.port,
      url: st.url,
      host: st.host,
      modelBase: st.url ? st.url.replace(/\/$/, '') : `http://${st.host || cfg.gateway.host || '127.0.0.1'}:${st.port}`,
      token: cfg.gateway.token || '',
      startedAt: st.startedAt || null,
    };
  });

  handle('gptplus:gateway:set', async (patch = {}) => {
    const cfg = store.get();
    const wantEnabled = patch.enabled === undefined ? cfg.gateway.enabled : !!patch.enabled;
    const port = patch.port === undefined ? cfg.gateway.port : Number(patch.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('端口必须是 1024-65535 之间的整数');
    }

    store.update((d) => {
      d.gateway.enabled = wantEnabled;
      d.gateway.port = port;
      if (patch.host !== undefined) d.gateway.host = String(patch.host || '').trim() || '127.0.0.1';
      if (!d.gateway.token) d.gateway.token = store.newGatewayToken();
    });

    const st = ctx.gateway.getState();
    if (wantEnabled) {
      await ctx.gateway.stop().catch(() => {});
      try {
        const started = await ctx.gateway.start({
          port,
          host: store.get().gateway.host || '127.0.0.1',
          token: store.get().gateway.token,
        });
        ctx.log({ level: 'info', msg: `网关已启动: ${started.url}` });
      } catch (err) {
        // 起不来就别把 store 留在「已启用」：否则界面显示已启用但实际没运行，
        // 注入还会把客户端指向一个没人监听的端口。回滚到改动前并原样报错。
        store.update((d) => {
          d.gateway.enabled = cfg.gateway.enabled;
          d.gateway.port = cfg.gateway.port;
          d.gateway.host = cfg.gateway.host;
        });
        ctx.log({ level: 'error', msg: `网关启动失败，已回滚设置: ${err.message}` });
        throw err;
      }
    } else if (st.running) {
      await ctx.gateway.stop();
      ctx.log({ level: 'warn', msg: '网关已停止' });
    }

    if (store.get().inject.enabled) {
      // 端口变了要同步 base_url
      try {
        ctx.syncInjection({ apply: true });
      } catch (err) {
        ctx.log({ level: 'error', msg: '同步注入失败: ' + err.message });
        throw err;
      }
    }
    return publish();
  });

  handle('gptplus:gateway:probe', () => ctx.gateway.probe());

  // ---- 注入 ----
  handle('gptplus:inject:get', () => {
    const cfg = store.get();
    return {
      enabled: !!cfg.inject.enabled,
      catalogPath: cfg.inject.catalogPath || null,
      defaultModel: cfg.inject.defaultModel || null,
    };
  });

  handle('gptplus:inject:set', async (patch = {}) => {
    const cfg = store.get();
    const enabled = patch.enabled === undefined ? cfg.inject.enabled : !!patch.enabled;

    let defaultModel = patch.defaultModel === undefined ? cfg.inject.defaultModel : patch.defaultModel;
    const all = ctx.models();
    const enabledModels = all.filter((model) => model.enabled !== false);
    if (defaultModel && !enabledModels.some((m) => m.slug === defaultModel)) defaultModel = null;
    if (!defaultModel && enabledModels.length) defaultModel = enabledModels[0].slug;

    if (enabled && !enabledModels.length) throw new Error('还没有启用的模型，请先启用至少一个提供商和模型');
    if (enabled && !store.get().gateway.enabled) {
      throw new Error('注入前请先启用本地网关');
    }
    if (enabled && !ctx.gateway.getState().running) {
      await ctx.gateway.start({
        port: store.get().gateway.port,
        host: store.get().gateway.host || '127.0.0.1',
        token: store.get().gateway.token,
      });
    }

    store.update((d) => {
      d.inject.enabled = enabled;
      d.inject.defaultModel = defaultModel || null;
      d.inject.catalogPath = enabled ? ctx.paths.CATALOG_PATH : null;
    });

    try {
      if (enabled) {
        const res = ctx.syncInjection({ apply: true });
        ctx.log({
          level: 'info',
          msg: `注入完成：${res.count ?? 0} 个自定义模型已写入 ChatGPT 模型清单，重启 ChatGPT 后生效`,
        });
      } else {
        ctx.codex.applyInjection({ enabled: false });
        ctx.markWrite(true);
        ctx.log({ level: 'warn', msg: '已还原 ChatGPT 模型清单（注入关闭）' });
      }
    } catch (err) {
      // 关键：开关状态必须以「Codex 配置真的写成/还原成功」为准。
      // 不回滚的话 store 说已注入、config.toml 其实没动，界面会一直显示已注入，
      // 用户重启客户端后什么模型都看不到。applyInjection 只在 atomicWrite 失败时
      // 抛错，此时文件仍是原样，所以只需回滚 store。
      store.update((d) => {
        d.inject.enabled = cfg.inject.enabled;
        d.inject.defaultModel = cfg.inject.defaultModel;
        d.inject.catalogPath = cfg.inject.catalogPath;
      });
      ctx.markWrite(false, err.message);
      ctx.log({ level: 'error', msg: `写入 Codex 配置失败，注入开关已回滚: ${err.message}` });
      throw err;
    }
    return publish();
  });

  // ---- 工具 ----
  handle('gptplus:codex:open', async () => {
    const dir = ctx.paths.CODEX_HOME;
    if (!fs.existsSync(dir)) return { ok: false, error: `目录不存在: ${dir}` };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  handle('gptplus:codex:open-config', async () => {
    const file = ctx.paths.CODEX_CONFIG_PATH;
    if (!fs.existsSync(file)) return { ok: false, error: `配置文件不存在: ${file}` };
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });

  handle('gptplus:chatgpt:relaunch', async () => {
    // 结束正在运行的 ChatGPT 客户端，再通过 Windows 应用入口重新拉起，使其重新读取配置。
    // 不能直接 spawn 包内 exe：那样会丢掉 MSIX 应用身份，任务栏显示成通用图标，
    // 客户端也未必能正常加载资源。
    const savedPath = store.get().chatgpt?.executablePath || null;
    let exe = await resolveChatGptExe({ preferredPath: savedPath });
    if (!exe) {
      if (typeof dialog?.showOpenDialog === 'function') {
        const picked = await dialog.showOpenDialog({
          title: '选择 ChatGPT.exe',
          properties: ['openFile'],
          filters: [{ name: 'ChatGPT', extensions: ['exe'] }],
        });
        const selected = picked && !picked.canceled && Array.isArray(picked.filePaths)
          ? picked.filePaths[0]
          : '';
        if (selected && fs.existsSync(selected)) {
          exe = selected;
          store.update((draft) => {
            draft.chatgpt.executablePath = exe;
          });
        }
      }
    }
    if (!exe) {
      return { ok: false, error: '找不到 ChatGPT.exe，请选择客户端可执行文件后重试' };
    }

    let result;
    try {
      const usageStatuslineEnabled = ctx.plugins?.isActive?.('usage-statusline') !== false;
      if (usageStatuslineEnabled) {
        result = await launchChatGptWithUsageStatusline({
          ctx,
          launchOptions: { executablePath: exe },
          wrapperDir: path.join(ctx.paths.APP_DIR, 'cdp'),
          launch: ({ cdpPort, wrapperDir }) => relaunchChatGpt({
            executablePath: exe,
            cdpPort,
            wrapperDir,
          }),
        });
      } else {
        result = await relaunchChatGpt({ executablePath: exe });
      }
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result.ok) {
      ctx.log({
        level: 'info',
        msg: `已重启 ChatGPT 客户端（PID ${result.pid ?? '未知'}`
          + `${result.appId ? `，应用入口 ${result.appId}` : ''}）: ${result.exe}`,
      });
    } else {
      ctx.log({
        level: 'warn',
        msg: `重启 ChatGPT 客户端失败（${exe}）: ${result.error || '未知错误'}`,
      });
    }
    return result;
  });

  handle('gptplus:logs:get', () => ctx.logs());
  handle('gptplus:usage:get', () => ctx.usage());
  handle('gptplus:usage:trend:get', () => ctx.usageTrend?.() || []);
  handle('gptplus:usage:clear', ({ mode } = {}) => ctx.clearUsage(mode));

  ctx.onLogEvent((entry) => onLog(entry));
  return { publish };
}

module.exports = { registerIpc, sanitizeProviderInput };
