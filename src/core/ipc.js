'use strict';
// IPC 注册：把渲染层调用映射到 core 模块。契约见 spec.md 第 7 节。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeModelLimits, normalizeTheme } = require('./store.js');
const { normalizeBaseUrl } = require('./base-url.js');
const { resolveChatGptExe } = require('./chatgpt-install.js');

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

/**
 * @param {{ ipcMain:any, shell:any, dialog:any, ctx:any, updater?:any,
 *           onStatus?:(s:any)=>void, onLog?:(e:any)=>void }} deps
 */
function registerIpc(deps) {
  const { ipcMain, shell, dialog, ctx, updater, onStatus = () => {}, onLog = () => {} } = deps;
  const { store } = ctx;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_evt, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        ctx.log({ level: 'error', msg: `${channel}: ${message}` });
        throw new Error(message);
      }
    });
  };

  const publish = () => {
    const s = ctx.status();
    onStatus(s);
    return s;
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
  handle('gptplus:update:state', () => updater?.getState?.() || { enabled: false, status: 'disabled' });
  handle('gptplus:update:check', () => updater?.checkForUpdates?.() || { enabled: false, status: 'disabled' });
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

  handle('gptplus:provider:test', (id) => ctx.providerClient.testProvider(id));
  handle('gptplus:provider:models:remote', (id) => ctx.providerClient.fetchRemoteModels(id));

  // ---- 模型与网关 ----
  handle('gptplus:models:list', () => ctx.models());
  handle('gptplus:model:enabled:set', ({ providerId, modelId, enabled } = {}) => {
    const next = !!enabled;
    const before = store.get();
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

  handle('gptplus:chatgpt:relaunch', async () => {
    // 结束正在运行的 ChatGPT 客户端，再重新拉起，使其重新读取配置。
    try {
      await new Promise((resolve) => {
        const ps = spawn(
          'taskkill',
          ['/IM', 'ChatGPT.exe', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        ps.on('close', resolve);
        ps.on('error', resolve);
      });
    } catch {
      /* 没在运行也无所谓 */
    }
    await new Promise((r) => setTimeout(r, 1200));
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
        if (selected) {
          exe = await resolveChatGptExe({
            preferredPath: selected,
            execText: async () => '',
          });
          if (exe) {
            store.update((draft) => {
              draft.chatgpt.executablePath = exe;
            });
          }
        }
      }
    }
    if (!exe) {
      return { ok: false, error: '找不到 ChatGPT.exe，请选择客户端可执行文件后重试' };
    }
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      ctx.log({ level: 'info', msg: '正在重启 ChatGPT 客户端以加载新的模型清单' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('gptplus:logs:get', () => ctx.logs());
  handle('gptplus:usage:get', () => ctx.usage());

  ctx.onLogEvent((entry) => onLog(entry));
  return { publish };
}

module.exports = { registerIpc, sanitizeProviderInput };
