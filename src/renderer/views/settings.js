// 设置页：本地网关（开关/端口/探活/令牌）、Codex 配置写入情况与还原注入。

import { createSelectPicker } from '../app.js';

const viewState = {
  portDraft: null,
  portError: '',
  gatewayBusy: false,
  limitsDraft: null,
  limitsError: '',
  limitsBusy: false,
  probe: null,
  probing: false,
  revealedToken: false,
  pendingRestore: false,
  restoreBusy: false,
  rollbackBusy: false,
  pendingRollback: '',
  updateIntervalDraft: null,
  updateIntervalError: '',
  updateIntervalBusy: false,
};

/** 渲染设置页 */
export function renderSettings(root, ctx, actions) {
  const { el, icon, state } = ctx;
  const gateway = state.gateway || (state.status && state.status.gateway) || {};
  const inject = state.inject || (state.status && state.status.inject) || { enabled: false, catalogPath: null, defaultModel: null };
  const modelLimits = state.modelLimits || (state.status && state.status.modelLimits) || { contextWindow: 1_000_000, autoCompactTokenLimit: null };
  const codex = (state.status && state.status.codex) || {};
  const paths = (state.status && state.status.paths) || {};
  const peer = state.peer || { sharing: { enabled: false, clients: [], localModels: [] }, remoteSync: { enabled: false, intervalMinutes: 60, connections: [], sources: [] } };

  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm' + (state.update?.status === 'checking' ? ' is-busy' : ''),
      type: 'button',
      disabled: !ctx.api || state.update?.status === 'checking' || state.update?.status === 'downloading' ? true : null,
      on: { click: () => void ctx.checkForUpdates() },
    }, [icon('refresh', 13), el('span', { text: state.update?.status === 'checking' ? '检查中…' : '检查更新' })]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.reload('settings') },
    }, [icon('refresh', 13), el('span', { text: '刷新状态' })]),
  );

  root.replaceChildren(
    updateCard(ctx),
    modelLimitsCard(ctx, { modelLimits, inject }),
    gatewayCard(ctx, { gateway, codex }),
    peerSummaryCard(ctx, peer),
    injectCard(ctx, { inject, codex }),
    aboutCard(ctx, { gateway, codex, inject, paths }),
  );
}

function peerSummaryCard(ctx, peer) {
  const { el, icon } = ctx;
  const sharing = peer.sharing || {};
  const remote = peer.remoteSync || {};
  const connections = Array.isArray(remote.connections) ? remote.connections : [];
  const sourceCount = Array.isArray(remote.sources) ? remote.sources.length : 0;
  const activeConnections = connections.filter((connection) => connection.enabled !== false).length;
  return el('section', { class: 'card peer-summary-card' }, [
    el('header', { class: 'card-head' }, [
      icon('plug', 14),
      el('span', { class: 'card-title', text: '对等共享' }),
      el('span', { class: 'card-desc', text: '双向发布本机模型或连接另一台 gpt++' }),
    ]),
    el('div', { class: 'card-body peer-summary-body' }, [
      el('div', { class: 'peer-summary-status' }, [
        el('span', { class: 'chip ' + (sharing.enabled ? 'chip-ok' : ''), text: '共享' + (sharing.enabled ? '已开启' : '未开启') }),
        el('span', { class: 'chip ' + (remote.enabled ? 'chip-ok' : ''), text: '自动同步' + (remote.enabled ? '已开启' : '未开启') }),
        el('span', { class: 'hint', text: activeConnections + ' 个启用连接 · ' + sourceCount + ' 个远端来源' }),
      ]),
      el('button', {
        class: 'btn btn-sm btn-accent',
        type: 'button',
        on: { click: () => ctx.openPeerSettings() },
      }, [icon('plug', 13), el('span', { text: '配置对等共享' })]),
    ]),
  ]);
}

export function openPeerSettings(ctx) {
  const peer = ctx.state.peer || {
    sharing: { enabled: false, clients: [], localModels: [] },
    remoteSync: { enabled: false, intervalMinutes: 60, connections: [], sources: [] },
  };
  const gateway = ctx.state.gateway || (ctx.state.status && ctx.state.status.gateway) || {};
  const modalState = { root: null };
  modalState.root = peerCard(ctx, peer, gateway, true, modalState);
  modalState.body = modalState.root.children[1];
  ctx.openModal(modalState.root);
}

// ============ 对等共享与远端同步 ============
function peerCard(ctx, peer, gateway, modal = false, modalState = null) {
  const { el, icon } = ctx;
  const sharing = peer.sharing || {};
  const remote = peer.remoteSync || {};
  const localModels = Array.isArray(sharing.localModels) ? sharing.localModels : [];
  const clients = Array.isArray(sharing.clients) ? sharing.clients : [];
  const connections = Array.isArray(remote.connections) ? remote.connections : [];
  const sourceModels = (remote.sources || []).flatMap((source) => (source.models || []).map((model) => ({ ...model, sourceName: source.name })));
  const hiddenModels = sourceModels.filter((model) => model.hidden);
  const selected = new Set(localModels.filter((model) => model.selected).map((model) => model.providerId + '::' + model.modelId));

  async function refresh() {
    if (!modal) {
      await ctx.reload('settings', { preserveScrollTop: true });
    }
    if (modal && modalState?.root) {
      // 只更新内容区，保留弹窗、标题栏和关闭按钮，避免重播入场动画。
      const next = peerCard(ctx, ctx.state.peer || peer, ctx.state.gateway || gateway, true, modalState);
      const nextBody = next.children && next.children[1];
      if (nextBody && modalState.body) modalState.body.replaceChildren(...Array.from(nextBody.childNodes || []));
    }
  }
  async function saveSharing(enabled) {
    try {
      const result = await ctx.api.setSharing({ enabled, models: [...selected].map((key) => {
        const at = key.indexOf('::');
        return { providerId: key.slice(0, at), modelId: key.slice(at + 2) };
      }) });
      ctx.state.peer = result;
      ctx.toast(enabled ? '已开启本机模型共享' : '已关闭本机模型共享', enabled ? 'ok' : 'warn');
      await refresh();
    } catch (err) { ctx.toastError(err, enabled ? '开启共享失败' : '关闭共享失败'); }
  }
  async function addClient() {
    try {
      const result = await ctx.api.addSharingClient({ name: '新客户端' });
      ctx.state.peer = result.state;
      ctx.toast('授权令牌已生成并复制到剪贴板，只显示这一次', 'ok');
      await refresh();
    } catch (err) { ctx.toastError(err, '生成共享授权失败'); }
  }
  async function revokeClient(id) {
    try { ctx.state.peer = await ctx.api.revokeSharingClient(id); ctx.toast('已撤销该共享客户端', 'warn'); await refresh(); }
    catch (err) { ctx.toastError(err, '撤销授权失败'); }
  }
  async function saveSync(enabled, interval) {
    try { ctx.state.peer = await ctx.api.setRemoteSync({ enabled, intervalMinutes: interval }); ctx.toast(enabled ? '已开启远端模型自动同步' : '已关闭自动同步，仍可手动同步', 'ok'); await refresh(); }
    catch (err) { ctx.toastError(err, '保存同步设置失败'); }
  }
  async function syncNow(id) {
    try {
      const result = await ctx.api.syncRemoteNow(id);
      ctx.state.peer = result.state;
      if (result.result?.ok) ctx.toast('远端模型清单已同步', 'ok');
      else ctx.toast('同步失败：' + (result.result?.error || '未知错误'), 'error');
      await refresh();
    } catch (err) { ctx.toastError(err, '立即同步失败'); }
  }
  async function revokeAllClients() {
    if (!clients.length) return;
    try {
      for (const client of [...clients]) {
        await ctx.api.revokeSharingClient(client.id);
      }
      ctx.state.peer = await ctx.api.getPeerState();
      ctx.toast('已清除全部已授权客户端', 'warn');
      await refresh();
    } catch (err) { ctx.toastError(err, '清除授权失败'); }
  }
  async function saveConnection(nameInput, urlInput, tokenInput) {
    const authToken = String(tokenInput.value || '').trim();
    if (!authToken) { ctx.toast('请输入对端授权令牌', 'warn'); return; }
    try {
      const result = await ctx.api.saveRemoteConnection({ name: nameInput.value, baseUrl: urlInput.value, authToken });
      ctx.state.peer = result;
      tokenInput.value = '';
      ctx.toast('远端连接已保存', 'ok');
      await refresh();
    } catch (err) { ctx.toastError(err, '保存远端连接失败'); }
  }

  const sharingRows = [
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-main' }, [
        el('div', { class: 'setting-title' }, [el('span', { text: '共享本机模型' }), el('span', { class: 'chip ' + (sharing.enabled ? 'chip-ok' : ''), text: sharing.enabled ? '已开启' : '默认关闭' })]),
        el('div', { class: 'setting-desc', text: '只发布你明确选择的本机模型清单；不会发送 Base URL、API Key 或请求头。' }),
      ]),
      el('div', { class: 'setting-ctl' }, [el('button', { class: 'switch', type: 'button', role: 'switch', attrs: { 'aria-checked': sharing.enabled ? 'true' : 'false', 'aria-label': '共享本机模型' }, on: { click: () => void saveSharing(!sharing.enabled) } })]),
    ]),
    el('div', { class: 'peer-local-models' }, localModels.length ? localModels.map((model) => {
      const key = model.providerId + '::' + model.modelId;
      const checkbox = el('input', { class: 'peer-model-checkbox', type: 'checkbox', checked: selected.has(key) ? true : null, disabled: !model.enabled ? true : null, on: { change: (event) => { if (event.target.checked) selected.add(key); else selected.delete(key); } } });
      return el('label', { class: 'peer-model-option' }, [
        checkbox,
        el('span', { class: 'peer-model-option-main' }, [
          el('span', { class: 'peer-model-label', text: model.label }),
          el('span', { class: 'peer-model-provider' }, [el('span', { class: 'peer-model-provider-dot' }), el('span', { text: model.providerName })]),
        ]),
        !model.enabled ? el('span', { class: 'chip chip-warn', text: '本机已停用' }) : null,
      ]);
    }) : [el('div', { class: 'hint', text: '还没有可共享的本机模型，请先添加并启用提供商和模型。' })]),
    el('div', { class: 'toolbar peer-subtoolbar' }, [el('span', { class: 'hint', text: sharing.enabled ? '清单只含已启用且勾选的本机模型。' : '共享开关与远端自动同步互不依赖。' }), el('span', { class: 'right' }), el('button', { class: 'btn btn-sm btn-ghost', type: 'button', on: { click: () => void saveSharing(!!sharing.enabled) } }, [icon('check', 12), el('span', { text: '保存共享模型' })])]),
    el('div', { class: 'peer-client-list' }, [
      el('div', { class: 'toolbar peer-subtoolbar' }, [
        el('div', { class: 'setting-title', text: '已授权客户端' }),
        el('span', { class: 'right' }),
        clients.length ? el('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: () => void revokeAllClients() } }, [icon('trash', 12), el('span', { text: '清除全部' })]) : null,
      ]),
      ...(clients.length
        ? clients.map((client) => el('div', { class: 'peer-client-row' }, [
          el('span', { class: 'grow' }, [
            el('span', { text: client.name }),
            el('span', { class: 'faint mono', text: ' · ' + client.id }),
          ]),
          el('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: () => void revokeClient(client.id) } }, [
            icon('trash', 12),
            el('span', { text: '撤销' }),
          ]),
        ]))
        : [el('div', { class: 'hint', text: '尚未授权其它电脑。' })]),
      el('button', { class: 'btn btn-sm btn-ghost', type: 'button', on: { click: () => void addClient() } }, [icon('plus', 12), el('span', { text: '生成新客户端授权' })]),
    ]),
  ];

  const syncInterval = el('input', { class: 'input mono', type: 'number', value: String(remote.intervalMinutes || 60), attrs: { min: '5', max: '1440', step: '1', 'aria-label': '远端同步间隔（分钟）', style: 'width:100px' } });
  const connectionName = el('input', { class: 'input', placeholder: '连接名称', attrs: { 'aria-label': '连接名称' } });
  const connectionUrl = el('input', { class: 'input mono', placeholder: '对端 Tailscale Serve 主机名或地址', attrs: { 'aria-label': '对端地址', spellcheck: 'false' } });
  const connectionToken = el('input', { class: 'input mono', type: 'password', placeholder: '对端授权令牌', attrs: { 'aria-label': '授权令牌', autocomplete: 'off', spellcheck: 'false' } });
  const connectionRows = connections.length ? connections.map((connection) => el('div', { class: 'peer-connection-row' }, [
    el('div', { class: 'grow' }, [el('div', { class: 'setting-title' }, [el('span', { text: connection.name }), el('span', { class: 'chip ' + (connection.lastError ? 'chip-err' : connection.lastSuccessAt ? 'chip-ok' : ''), text: connection.lastError ? '同步失败' : connection.lastSuccessAt ? '已同步' : '未同步' })]), el('div', { class: 'hint', text: connection.lastSuccessAt ? '上次同步：' + ctx.fmt.dateTime(connection.lastSuccessAt) : '尚未成功同步' }), connection.lastError ? el('div', { class: 'hint-error', text: connection.lastError }) : null]),
    el('button', { class: 'switch switch-table', type: 'button', role: 'switch', attrs: { 'aria-checked': connection.enabled === false ? 'false' : 'true', 'aria-label': '启用远端连接' }, on: { click: async () => { await ctx.api.setRemoteConnectionEnabled({ id: connection.id, enabled: connection.enabled === false }); await refresh(); } } }),
    el('button', { class: 'btn btn-icon', type: 'button', title: '立即同步', attrs: { 'aria-label': '立即同步' }, on: { click: () => void syncNow(connection.id) } }, [icon('refresh', 13)]),
    el('button', { class: 'btn btn-icon btn-danger', type: 'button', title: '删除连接', attrs: { 'aria-label': '删除连接' }, on: { click: async () => { await ctx.api.deleteRemoteConnection(connection.id); await refresh(); } } }, [icon('trash', 13)]),
  ])) : [el('div', { class: 'hint', text: '还没有远端连接。' })];
  const syncRows = [
    el('div', { class: 'setting' }, [el('div', { class: 'setting-main' }, [el('div', { class: 'setting-title' }, [el('span', { text: '自动同步远端模型' }), el('span', { class: 'chip ' + (remote.enabled ? 'chip-ok' : ''), text: remote.enabled ? '已开启' : '默认关闭' })]), el('div', { class: 'setting-desc', text: '后台只读取已连接对端的模型清单，不会访问任何上游提供商的 /models。关闭后仍可手动立即同步。' })]), el('div', { class: 'setting-ctl' }, [el('button', { class: 'switch', type: 'button', role: 'switch', attrs: { 'aria-checked': remote.enabled ? 'true' : 'false', 'aria-label': '自动同步远端模型' }, on: { click: () => void saveSync(!remote.enabled, Number(syncInterval.value) || 60) } })])]),
    el('div', { class: 'setting' }, [el('div', { class: 'setting-main' }, [el('div', { class: 'setting-title', text: '同步间隔' }), el('div', { class: 'setting-desc', text: '允许 5-1440 分钟；第一次同步始终由你点击「立即同步」触发。' })]), el('div', { class: 'setting-ctl' }, [syncInterval, el('button', { class: 'btn btn-sm btn-primary', type: 'button', on: { click: () => void saveSync(remote.enabled, Number(syncInterval.value)) } }, [icon('check', 12), el('span', { text: '保存' })])])]),
    el('div', { class: 'peer-connection-list' }, [el('div', { class: 'setting-title', text: '远端连接' }), ...connectionRows]),
    el('div', { class: 'hint', text: '授权令牌由对端「生成新客户端授权」后，通过可信渠道获取，直接粘贴到下方输入框。' }),
    el('div', { class: 'toolbar peer-connection-add' }, [connectionName, connectionUrl, connectionToken, el('button', { class: 'btn btn-sm btn-ghost', type: 'button', on: { click: () => void saveConnection(connectionName, connectionUrl, connectionToken) } }, [icon('plus', 12), el('span', { text: '保存连接' })])]),
    sourceModels.length ? el('div', { class: 'hint', text: '已缓存 ' + sourceModels.length + ' 个远端模型；同步失败或对端离线时仍保留本机显示和启用决定。' }) : null,
    hiddenModels.length ? el('div', { class: 'peer-hidden-list' }, [
      el('div', { class: 'setting-title', text: '本机已隐藏的远端模型' }),
      ...hiddenModels.map((model) => el('div', { class: 'peer-client-row' }, [
        el('span', { class: 'grow', text: model.customLabel || model.label + ' · ' + model.sourceName }),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', on: { click: async () => {
          try { await ctx.api.restoreRemoteModel({ providerId: model.gatewayProviderId, modelId: model.id }); ctx.toast('已恢复显示，模型仍保持停用', 'ok'); await refresh(); }
          catch (err) { ctx.toastError(err, '恢复远端模型失败'); }
        } } }, [icon('refresh', 12), el('span', { text: '恢复显示' })]),
      ])),
    ]) : null,
  ];
  const serveCommand = 'tailscale serve --bg ' + String(gateway.port || 18120);
  const serveOffCommand = 'tailscale serve off';

  const body = [
    el('div', { class: 'peer-section-title', text: '共享本机模型' }),
    ...sharingRows,
    el('div', { class: 'peer-section-title', text: '远端模型同步' }),
    ...syncRows,
    el('div', { class: 'note note-info' }, [
      icon('info', 14),
      el('div', { class: 'grow' }, [
        el('div', { text: '网络前提：本地 HTTP 网关仍只监听回环地址。请先在 tailnet 启用 HTTPS 证书，再用 PowerShell 手动执行 Serve 命令，将本机网关端口发布到 tailnet；把 Serve 显示的 HTTPS 设备地址填到另一端。' }),
        el('div', { class: 'toolbar peer-serve-command' }, [
          el('code', { class: 'mono', text: serveCommand }),
          el('button', { class: 'btn btn-icon', type: 'button', title: '复制 Serve 命令', attrs: { 'aria-label': '复制 Serve 命令' }, on: { click: () => ctx.copyText(serveCommand, ' Tailscale Serve 命令') } }, [icon('copy', 13)]),
        ]),
        el('div', { class: 'hint', text: '停止 Serve：' + serveOffCommand + '。Serve 仅向 tailnet 提供服务；仍须自行配置 Tailscale ACL。不要使用 Funnel。gpt++ 不会安装、登录或自动重配置 Tailscale。授权令牌请通过可信渠道交接。' }),
      ]),
    ]),
  ];
  const header = modal
    ? el('header', { class: 'modal-head' }, [
        icon('plug', 15),
        el('div', { class: 'grow' }, [
          el('h2', { text: '对等共享网关' }),
          el('div', { class: 'modal-sub', text: '共享本机模型或连接另一台 gpt++，两者可以同时开启' }),
        ]),
        el('button', { class: 'btn btn-icon', type: 'button', title: '关闭', attrs: { 'aria-label': '关闭' }, on: { click: () => ctx.closeModal() } }, [icon('x', 15)]),
      ])
    : el('header', { class: 'card-head' }, [icon('plug', 14), el('span', { class: 'card-title', text: '对等共享网关' }), el('span', { class: 'card-desc', text: '共享本机模型或连接另一台 gpt++，两者可以同时开启' })]);
  const root = el('section', {
    class: modal ? 'modal peer-settings-modal' : 'card peer-card',
    attrs: modal ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': '对等共享网关配置' } : {},
  }, [header, el('div', { class: modal ? 'modal-body peer-settings-body' : 'card-body' }, body)]);
  return root;
}

// ============ 软件更新 ==========
function updateCard(ctx) {
  const { el, icon, state } = ctx;
  const update = state.update || {};
  const current = update.currentVersion || (state.status && state.status.appVersion) || '0.0.0';
  const hasVersion = !!update.version;
  const busy = update.status === 'checking' || update.status === 'downloading';
  const pending = ['available', 'downloaded'].includes(update.status);
  const configuredInterval = Number.isInteger(Number(update.checkIntervalMinutes))
    ? Number(update.checkIntervalMinutes)
    : 60;
  if (viewState.updateIntervalDraft === null) viewState.updateIntervalDraft = String(configuredInterval);
  const intervalInput = el('input', {
    class: 'input mono' + (viewState.updateIntervalError ? ' is-invalid' : ''),
    type: 'number',
    value: viewState.updateIntervalDraft,
    attrs: { min: '5', max: '1440', step: '1', 'aria-label': '自动检查更新间隔（分钟）', style: 'width:110px' },
    on: { input: (event) => { viewState.updateIntervalDraft = event.target.value; viewState.updateIntervalError = ''; } },
  });
  const statusText = update.status === 'checking'
    ? '正在检查 GitHub Release…'
    : update.status === 'latest'
      ? '当前已是最新版本'
      : update.status === 'available'
        ? `检测到新版本 v${update.version}`
        : update.status === 'downloading'
          ? `正在下载新版本 · ${Math.round(update.percent || 0)}%`
          : update.status === 'downloaded'
            ? '更新已下载，正在准备安装'
            : update.status === 'error'
              ? `更新失败：${update.error || '未知错误'}`
              : update.enabled === false ? '当前运行模式不支持自动更新' : '尚未检查更新';
  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('download', 14),
      el('span', { class: 'card-title', text: '软件更新' }),
      el('span', { class: 'chip ' + (pending ? 'chip-warn' : update.status === 'latest' ? 'chip-ok' : ''), text: `当前 v${current}` }),
      el('span', { class: 'card-desc', text: '更新前需要确认，不会自动下载' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title', text: statusText }),
          el('div', { class: 'setting-desc', text: hasVersion && pending
            ? '可以现在更新，也可以稍后从左侧“设置”旁的更新提示进入。暂不更新不会影响当前版本使用。'
            : '手动检查会立即请求 GitHub Release；发现新版本后会先询问是否更新。' }),
        ]),
        el('div', { class: 'setting-ctl' }, [
          pending
            ? el('button', {
                class: 'btn btn-sm btn-warning',
                type: 'button',
                disabled: !ctx.api || busy ? true : null,
                on: { click: () => void ctx.startUpdateDownload() },
              }, [icon('download', 13), el('span', { text: update.status === 'downloaded' ? '继续安装' : '立即更新' })])
            : null,
        ]),
      ]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title', text: '自动检查更新间隔' }),
          el('div', { class: 'setting-desc', text: `启动后 ${update.initialCheckDelayMinutes || 2} 分钟首次检查，之后每隔设定时间检查；范围 5-1440 分钟。` }),
        ]),
        el('div', { class: 'setting-ctl' }, [intervalInput]),
      ]),
      viewState.updateIntervalError ? el('div', { class: 'hint-error', text: viewState.updateIntervalError }) : null,
      el('div', { class: 'toolbar', style: { 'margin-top': '12px' } }, [
        el('button', {
          class: 'btn btn-sm btn-primary' + (viewState.updateIntervalBusy ? ' is-busy' : ''),
          type: 'button',
          disabled: viewState.updateIntervalBusy ? true : null,
          on: { click: () => void saveUpdateInterval(ctx) },
        }, [icon('check', 13), el('span', { text: viewState.updateIntervalBusy ? '保存中…' : '保存检查间隔' })]),
      ]),
      update.status === 'error'
        ? el('div', { class: 'hint-error', text: '请检查网络连接后再次点击“检查更新”。' })
        : null,
      rollbackCard(ctx),
    ]),
  ]);
}

function rollbackCard(ctx) {
  const { el, icon, state } = ctx;
  const update = state.update || {};
  const releases = Array.isArray(update.rollbackReleases) ? update.rollbackReleases : null;
  const busy = viewState.rollbackBusy || update.status === 'checking' || update.status === 'downloading';
  const load = async () => {
    if (!ctx.api || busy) return;
    viewState.rollbackBusy = true;
    try {
      const list = await ctx.api.listRollbackReleases();
      state.update = { ...state.update, rollbackReleases: Array.isArray(list) ? list : [] };
    } catch (err) {
      ctx.toastError(err, '\u8BFB\u53D6\u5386\u53F2\u7248\u672C\u5931\u8D25');
    } finally {
      viewState.rollbackBusy = false;
      ctx.renderCurrent(false, { preserveScrollTop: true });
    }
  };
  const confirm = async () => {
    const version = viewState.pendingRollback;
    if (!version || !ctx.api || busy) return;
    viewState.rollbackBusy = true;
    try {
      const next = await ctx.api.rollbackToVersion(version);
      if (next && typeof next === 'object') state.update = { ...state.update, ...next };
      viewState.pendingRollback = '';
      ctx.toast(`\u5DF2\u5F00\u59CB\u56DE\u9000\u5230 v${version}\uFF0C\u4E0B\u8F7D\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u91CD\u542F\u5B89\u88C5`, 'info');
    } catch (err) {
      ctx.toastError(err, '\u5F00\u59CB\u56DE\u9000\u5931\u8D25');
    } finally {
      viewState.rollbackBusy = false;
      ctx.renderCurrent(false, { preserveScrollTop: true });
    }
  };
  const selected = viewState.pendingRollback;
  const children = [
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-main' }, [
        el('div', { class: 'setting-title', text: '\u56DE\u9000\u5230\u4E4B\u524D\u7684\u7248\u672C' }),
        el('div', { class: 'setting-desc', text: '\u4ECE GitHub Release \u9009\u62E9\u8F83\u65E9\u7684\u7A33\u5B9A\u7248\u672C\uFF1B\u56DE\u9000\u53EA\u66FF\u6362\u7A0B\u5E8F\uFF0C\u4E0D\u4F1A\u5220\u9664\u672C\u5730\u914D\u7F6E\u3002' }),
      ]),
      el('div', { class: 'setting-ctl' }, [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          disabled: !ctx.api || busy ? true : null,
          on: { click: () => void load() },
        }, [icon('refresh', 13), el('span', { text: viewState.rollbackBusy ? '\u8BFB\u53D6\u4E2D\u2026' : releases ? '\u5237\u65B0\u5386\u53F2\u7248\u672C' : '\u67E5\u770B\u5386\u53F2\u7248\u672C' })]),
      ]),
    ]),
  ];
  if (releases && !releases.length) {
    children.push(el('div', { class: 'rollback-empty', text: '\u6CA1\u6709\u53EF\u7528\u7684\u66F4\u65E9\u7A33\u5B9A\u7248\u672C\u3002' }));
  } else if (releases) {
    children.push(el('div', { class: 'rollback-controls' }, [
      createSelectPicker(ctx, {
        className: 'rollback-select',
        value: selected,
        disabled: busy,
        ariaLabel: '\u9009\u62E9\u56DE\u9000\u7248\u672C',
        options: [
          { value: '', label: '\u9009\u62E9\u4E00\u4E2A\u5386\u53F2\u7248\u672C' },
          ...releases.map((release) => ({ value: release.version, label: 'v' + release.version })),
        ],
        onChange: (value) => { viewState.pendingRollback = value; ctx.renderCurrent(true, { preserveScrollTop: true }); },
      }),
      selected
        ? el('button', {
            class: 'btn btn-sm btn-warning',
            type: 'button',
            disabled: busy ? true : null,
            on: { click: () => void confirm() },
          }, [icon('download', 13), el('span', { text: '\u786E\u8BA4\u56DE\u9000\u5230 v' + selected })])
        : null,
    ]));
    if (selected) {
      children.push(el('div', { class: 'hint-warn rollback-warning', text: '\u56DE\u9000\u4F1A\u9000\u51FA gpt++ \u5E76\u8986\u76D6\u5F53\u524D\u7A0B\u5E8F\u7248\u672C\uFF1B\u672C\u5730\u63D0\u4F9B\u5546\u3001API Key \u548C\u7F51\u5173\u914D\u7F6E\u4F1A\u4FDD\u7559\u3002' }));
    }
  }
  return el('div', { class: 'rollback-panel' }, children);
}

// ============ 模型上下文 ============
function modelLimitsCard(ctx, { modelLimits, inject }) {
  const { el, icon } = ctx;
  const needsRelaunch = !!ctx.state.relaunchNeeded;
  if (!viewState.limitsDraft) viewState.limitsDraft = {
    contextWindow: String(modelLimits.contextWindow ?? ''),
    autoCompactTokenLimit: modelLimits.autoCompactTokenLimit == null ? '' : String(modelLimits.autoCompactTokenLimit),
  };
  const draft = viewState.limitsDraft;

  const contextInput = el('input', {
    class: 'input mono',
    type: 'number',
    value: draft.contextWindow,
    attrs: { min: '1024', max: '100000000', step: '1', 'aria-label': '上下文窗口 Token', style: 'width:150px' },
    on: { input: (e) => { draft.contextWindow = e.target.value; viewState.limitsError = ''; } },
  });

  const compactInput = el('input', {
    class: 'input mono',
    type: 'number',
    value: draft.autoCompactTokenLimit,
    attrs: { min: '1024', max: String(draft.contextWindow || 1_000_000), step: '1', placeholder: '留空 = 客户端默认', 'aria-label': '自动压缩阈值 Token', style: 'width:150px' },
    on: { input: (e) => { draft.autoCompactTokenLimit = e.target.value; viewState.limitsError = ''; } },
  });

  const contextValue = Number(draft.contextWindow);
  const compactValue = draft.autoCompactTokenLimit === '' ? null : Number(draft.autoCompactTokenLimit);
  const ratio = Number.isSafeInteger(contextValue) && contextValue > 0 && Number.isSafeInteger(compactValue)
    ? `约 ${Math.round((compactValue / contextValue) * 100)}%`
    : '未启用自动压缩';

  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('box', 14),
      el('span', { class: 'card-title', text: '模型上下文' }),
      el('span', { class: 'card-desc', text: '统一作用于所有注入模型，声明给 ChatGPT 客户端' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title', text: '上下文窗口 Token' }),
          el('div', { class: 'setting-desc', text: '仅声明客户端上下文，不改变模型实际能力。建议不超过最小模型的真实上限。' }),
        ]),
        el('div', { class: 'setting-ctl' }, [contextInput]),
      ]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title', text: '自动压缩阈值 Token' }),
          el('div', { class: 'setting-desc', text: `必须小于上下文窗口；留空使用客户端默认值。当前：${ratio}` }),
        ]),
        el('div', { class: 'setting-ctl' }, [compactInput]),
      ]),
      viewState.limitsError ? el('div', { class: 'hint-error', text: viewState.limitsError }) : null,
      el('div', { class: 'toolbar', style: { 'margin-top': '12px' } }, [
        el('button', {
          class: 'btn btn-sm btn-primary' + (viewState.limitsBusy ? ' is-busy' : ''),
          type: 'button',
          disabled: viewState.limitsBusy ? true : null,
          on: { click: () => void saveModelLimits(ctx) },
        }, [icon('check', 13), el('span', { text: viewState.limitsBusy ? '保存中…' : '保存上下文设置' })]),
        el('span', {
          class: 'hint' + (needsRelaunch ? ' hint-relaunch' : ''),
          text: needsRelaunch
            ? '配置已修改，请点击左侧红色“重启 ChatGPT”使其生效。'
            : inject && inject.enabled
              ? '保存后会立即重写模型目录；重启 ChatGPT 客户端后生效。'
              : '保存后写入配置；开启注入并重启 ChatGPT 客户端后生效。',
        }),
      ]),
    ]),
  ]);
}

// ============ 本地网关 ============
function gatewayCard(ctx, { gateway, codex }) {
  const { el, icon, fmt, maskKey } = ctx;
  const portValue = viewState.portDraft !== null ? viewState.portDraft : String(gateway.port || '');
  const running = !!gateway.running;
  const enabled = !!gateway.enabled;

  const portInput = el('input', {
    class: 'input mono' + (viewState.portError ? ' is-invalid' : ''),
    type: 'number',
    value: portValue,
    attrs: { min: '1024', max: '65535', step: '1', 'aria-label': '网关端口', style: 'width:110px' },
    on: {
      input: (e) => {
        viewState.portDraft = e.target.value;
        viewState.portError = '';
      },
    },
  });

  const probeBox = viewState.probe
    ? el('div', { class: 'probe-result ' + (viewState.probe.ok ? 'probe-ok' : 'probe-bad') }, [
        icon(viewState.probe.ok ? 'check' : 'alert', 13),
        el('span', {
          class: 'probe-text',
          text: viewState.probe.ok
            ? `健康检查通过 · ${fmt.dur(viewState.probe.latencyMs)} · ${fmt.rel(viewState.probe.at)}`
            : `健康检查失败：${viewState.probe.error || '未知错误'}`,
        }),
      ])
    : null;

  const token = gateway.token || '';
  const tokenText = token ? (viewState.revealedToken ? token : maskKey(token)) : '未生成（保存开关时会自动生成）';

  const rows = [
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-main' }, [
        el('div', { class: 'setting-title' }, [
          el('span', { text: '启用本地网关' }),
          el('span', { class: 'chip ' + (running ? 'chip-ok' : enabled ? 'chip-warn' : ''), text: running ? '运行中' : enabled ? '已启用 · 未运行' : '未启用' }),
        ]),
        el('div', {
          class: 'setting-desc',
          text: running
            ? `ChatGPT 通过 ${gateway.url || `127.0.0.1:${gateway.port}`} 访问你的模型${gateway.startedAt ? ` · 已运行 ${fmt.rel(gateway.startedAt)}启动` : ''}`
            : '停用后 ChatGPT 无法访问自定义模型（已注入的模型会请求失败）',
        }),
      ]),
      el('div', { class: 'setting-ctl' }, [
        el('button', {
          class: 'switch',
          type: 'button',
          role: 'switch',
          disabled: viewState.gatewayBusy ? true : null,
          attrs: { 'aria-checked': enabled ? 'true' : 'false', 'aria-label': '启用本地网关' },
          on: { click: () => void toggleGateway(ctx, !enabled) },
        }),
      ]),
    ]),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-main' }, [
        el('div', { class: 'setting-title', text: '监听端口' }),
        el('div', {
          class: 'setting-desc',
          text: '取值范围 1024-65535；端口被占用时会启动失败并在这里提示。改动会重启网关并同步更新 Codex 里的 base_url。',
        }),
        viewState.portError ? el('div', { class: 'hint-error', text: viewState.portError }) : null,
      ]),
      el('div', { class: 'setting-ctl' }, [
        portInput,
        el('button', {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          disabled: viewState.gatewayBusy ? true : null,
          on: { click: () => void savePort(ctx) },
        }, [el('span', { text: '保存端口' })]),
      ]),
    ]),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-main' }, [
        el('div', { class: 'setting-title', text: '网关地址' }),
        el('div', { class: 'setting-desc mono', text: gateway.modelBase || `127.0.0.1:${gateway.port || '?'}` }),
        probeBox,
      ]),
      el('div', { class: 'setting-ctl' }, [
        el('button', {
          class: 'btn btn-sm btn-success' + (viewState.probing ? ' is-busy' : ''),
          type: 'button',
          disabled: viewState.probing ? true : null,
          on: { click: () => void probeGateway(ctx) },
        }, [icon('activity', 13), el('span', { text: viewState.probing ? '检测中…' : '探活' })]),
        el('button', {
          class: 'btn btn-icon',
          type: 'button',
          title: '复制网关地址',
          attrs: { 'aria-label': '复制网关地址' },
          on: { click: () => ctx.copyText(gateway.modelBase || '', ' 网关地址') },
        }, [icon('copy', 14)]),
      ]),
    ]),

    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-main' }, [
        el('div', { class: 'setting-title', text: '访问令牌' }),
        el('div', { class: 'setting-desc', text: '非空时网关要求 Authorization: Bearer <token>；Codex 通过本机认证命令读取令牌，令牌不会写入 Codex 配置文件。' }),
      ]),
      el('div', { class: 'setting-ctl' }, [
        el('span', { class: 'keyval mono ellipsis', style: { 'max-width': '230px' }, title: '默认打码', text: tokenText }),
        token
          ? el('button', {
              class: 'btn btn-icon',
              type: 'button',
              title: viewState.revealedToken ? '隐藏令牌' : '显示令牌',
              attrs: { 'aria-label': '显示或隐藏令牌' },
              on: {
                click: () => {
                  viewState.revealedToken = !viewState.revealedToken;
                  ctx.renderCurrent(true);
                },
              },
            }, [icon(viewState.revealedToken ? 'eyeOff' : 'eye', 14)])
          : null,
        token
          ? el('button', {
              class: 'btn btn-icon',
              type: 'button',
              title: '复制令牌',
              attrs: { 'aria-label': '复制令牌' },
              on: { click: () => ctx.copyText(token, ' 访问令牌') },
            }, [icon('copy', 14)])
          : null,
      ]),
    ]),
  ];

  if (codex.lastWrite) {
    rows.push(
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title' }, [
            el('span', { text: '最近一次写入 Codex 配置' }),
            el('span', {
              class: 'chip ' + (codex.lastWrite.ok ? 'chip-ok' : 'chip-err'),
              text: codex.lastWrite.ok ? '成功' : '失败',
            }),
          ]),
          el('div', {
            class: 'setting-desc',
            text: `${fmt.dateTime(codex.lastWrite.at)}（${fmt.rel(codex.lastWrite.at)}）${codex.lastWrite.error ? ` · ${codex.lastWrite.error}` : ''}`,
          }),
        ]),
      ]),
    );
  }

  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('server', 14),
      el('span', { class: 'card-title', text: '本地网关' }),
      el('span', { class: 'card-desc', text: '把 ChatGPT 的请求转发到你添加的提供商' }),
    ]),
    el('div', {}, rows),
  ]);
}

// ============ ChatGPT 注入 ============
function injectCard(ctx, { inject, codex }) {
  const { el, icon } = ctx;
  const needsRelaunch = !!ctx.state.relaunchNeeded;
  const configPath = codex.configPath || '';
  const catalogPath = codex.catalogPath || inject.catalogPath || '';
  const on = !!inject.enabled;

  const pathList = el('div', { class: 'path-list' }, [
    pathRow(ctx, 'Codex 配置', configPath, '配置文件路径'),
    pathRow(ctx, '模型目录', catalogPath, 'gpt++ 生成的模型清单'),
  ]);

  const foot = el('div', { class: 'toolbar', style: { 'margin-top': '12px' } }, [
    el('button', {
      class: 'btn btn-sm btn-accent',
      type: 'button',
      on: { click: () => void openCodex(ctx) },
    }, [icon('folder', 13), el('span', { text: '打开 Codex 目录' })]),
    el('span', { class: 'right' }),
    viewState.pendingRestore
      ? el('span', { class: 'toolbar' }, [
          el('span', { class: 'hint', text: '会删除 Codex 配置里我们写入的模型清单，官方模型立刻恢复。' }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            on: {
              click: () => {
                viewState.pendingRestore = false;
                ctx.renderCurrent(true);
              },
            },
          }, [el('span', { text: '取消' })]),
          el('button', {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            on: { click: () => void restoreInject(ctx) },
          }, [icon('trash', 13), el('span', { text: '确认还原' })]),
        ])
      : el('button', {
          class: 'btn btn-sm ' + (on ? 'btn-danger' : 'btn-ghost'),
          type: 'button',
          disabled: viewState.restoreBusy || !on ? true : null,
          title: on ? '移除注入，让 ChatGPT 回到官方模型' : '当前没有注入',
          on: {
            click: () => {
              viewState.pendingRestore = true;
              ctx.renderCurrent(true);
            },
          },
        }, [icon('trash', 13), el('span', { text: '还原注入' })]),
  ]);

  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('code', 14),
      el('span', { class: 'card-title', text: 'ChatGPT 注入' }),
      el('span', { class: 'chip ' + (on ? 'chip-codex' : ''), text: on ? '已开启' : '未开启' }),
      el('span', { class: 'card-desc', text: on ? `客户端将看到 ${(ctx.state.models || []).filter((m) => m.enabled).length} 个自建模型` : '客户端仍使用内置官方模型' }),
    ]),
    el('div', { class: 'card-body' }, [
      needsRelaunch
        ? el('div', { class: 'note note-warn relaunch-note', attrs: { role: 'alert' } }, [
            icon('alert', 15),
            el('div', { class: 'grow' }, [
              el('div', { text: '配置已修改，需要重启 ChatGPT 客户端后生效' }),
              el('div', { class: 'faint', text: on ? '模型清单已经写入，当前 ChatGPT 仍在使用旧配置。' : '注入状态已经修改，当前 ChatGPT 仍在使用旧配置。' }),
            ]),
          ])
        : on
        ? el('div', { class: 'note note-ok' }, [
            icon('check', 15),
            el('div', { class: 'grow' }, [
              el('div', { text: '模型清单已写入，重启 ChatGPT 客户端后生效' }),
              el('div', {
                class: 'faint',
                text: `默认模型：${inject.defaultModel || '（未设置，取清单第一个）'} · 写入前会自动备份 ~/.codex/config.toml（保留最近 10 份）`,
              }),
            ]),
          ])
        : el('div', { class: 'note' }, [
            icon('info', 15),
            el('div', { class: 'grow' }, [
              el('div', { text: '当前没有注入：Codex 配置里的自定义模型键已被清理，其它内容原样保留' }),
              el('div', { class: 'faint', text: '到「模型」页打开注入开关即可写入' }),
            ]),
          ]),
      pathList,
      foot,
    ]),
  ]);
}

function pathRow(ctx, label, value, title) {
  const { el, icon } = ctx;
  return el('div', { class: 'path-row' }, [
    el('span', { class: 'path-key', text: label }),
    el('span', { class: 'path-val', title: title || value, text: value || '—' }),
    el('button', {
      class: 'btn btn-icon',
      type: 'button',
      title: `复制${label}`,
      attrs: { 'aria-label': `复制${label}` },
      on: { click: () => ctx.copyText(value, ` ${label}路径`) },
    }, [icon('copy', 13)]),
  ]);
}

// ============ 关于 ============
function aboutCard(ctx, { gateway, codex, inject, paths }) {
  const { el, icon, state } = ctx;
  const version = (state.status && state.status.appVersion) || '0.0.0';
  const modelCount = (state.models || []).length;
  const configPath = paths.configPath || '~/.gptplus/config.json';
  const backupDir = paths.backupDir || '~/.gptplus/backups/';
  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('info', 14),
      el('span', { class: 'card-title', text: '关于与数据位置' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'path-list' }, [
        el('div', { class: 'path-row' }, [
          el('span', { class: 'path-key', text: 'gpt++ 版本' }),
          el('span', { class: 'path-val', text: `v${version}` }),
          el('span', {}),
        ]),
        el('div', { class: 'path-row' }, [
          el('span', { class: 'path-key', text: '配置文件' }),
          el('span', { class: 'path-val', title: configPath, text: configPath }),
          el('span', {}),
        ]),
        el('div', { class: 'path-row' }, [
          el('span', { class: 'path-key', text: '备份目录' }),
          el('span', { class: 'path-val', title: backupDir, text: backupDir }),
          el('span', {}),
        ]),
        el('div', { class: 'path-row' }, [
          el('span', { class: 'path-key', text: '网关地址' }),
          el('span', { class: 'path-val', text: gateway.modelBase || '—' }),
          el('span', {}),
        ]),
      ]),
      el('div', {
        class: 'hint',
        text: `当前：${modelCount} 个模型可注入、注入${inject.enabled ? '已开启' : '未开启'}、网关${gateway.running ? '运行中' : '未运行'}${codex.configExists === false ? ' · 还没找到 ~/.codex/config.toml（首次注入时会创建）' : ''}。API Key 与令牌只保存在本机配置文件里。`,
      }),
    ]),
  ]);
}

// ============ 动作 ============
async function toggleGateway(ctx, next) {
  if (viewState.gatewayBusy) return;
  viewState.gatewayBusy = true;
  try {
    // 端口输入框里改了但还没点保存时，这次开关必须带上草稿端口：
    // 否则界面显示的是新端口，后端却按旧端口起，两边对不上。
    const draft = viewState.portDraft !== null ? String(viewState.portDraft).trim() : '';
    const draftPort = Number(draft);
    const patch = { enabled: next };
    if (draft && Number.isInteger(draftPort) && draftPort >= 1024 && draftPort <= 65535) {
      patch.port = draftPort;
      viewState.portDraft = null;
    }
    const status = await ctx.api.setGateway(patch);
    ctx.state.status = status;
    const port = status && status.gateway ? status.gateway.port : '';
    const msg = next ? `网关已启动：127.0.0.1:${port}` : '网关已停止';
    ctx.toast(msg, next ? 'ok' : 'warn');
    ctx.logLocal(next ? 'info' : 'warn', msg);
  } catch (err) {
    ctx.toastError(err, next ? '启动网关失败' : '停止网关失败');
  } finally {
    viewState.gatewayBusy = false;
    await ctx.reload('settings');
  }
}

async function saveModelLimits(ctx) {
  if (viewState.limitsBusy) return;
  const draft = viewState.limitsDraft || {};
  const contextWindow = Number(String(draft.contextWindow ?? '').trim());
  const compactText = String(draft.autoCompactTokenLimit ?? '').trim();
  const compactLimit = compactText ? Number(compactText) : null;

  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 100_000_000) {
    viewState.limitsError = '上下文窗口必须是 1024-100000000 之间的整数';
    ctx.renderCurrent(true);
    ctx.toast('上下文窗口不合法，未保存', 'warn');
    return;
  }
  if (compactLimit !== null && (!Number.isSafeInteger(compactLimit) || compactLimit < 1024 || compactLimit > contextWindow)) {
    viewState.limitsError = '自动压缩阈值必须是 1024 到上下文窗口（含）之间的整数，或留空使用客户端默认值';
    ctx.renderCurrent(true);
    ctx.toast('自动压缩阈值不合法，未保存', 'warn');
    return;
  }

  viewState.limitsError = '';
  viewState.limitsBusy = true;
  try {
    const status = await ctx.api.setModelLimits({
      contextWindow,
      autoCompactTokenLimit: compactLimit,
    });
    ctx.state.status = status;
    ctx.state.modelLimits = status && status.modelLimits
      ? status.modelLimits
      : { contextWindow, autoCompactTokenLimit: compactLimit };
    viewState.limitsDraft = null;
    const msg = '模型上下文设置已保存；重启 ChatGPT 客户端后生效';
    markRelaunchIfInjected(ctx);
    ctx.toast(msg, 'ok');
    ctx.logLocal('info', msg);
  } catch (err) {
    viewState.limitsError = ctx.describeError(err, '保存模型上下文设置失败');
    ctx.toastError(err, '保存模型上下文设置失败');
  } finally {
    viewState.limitsBusy = false;
    await ctx.reload('settings');
  }
}

async function saveUpdateInterval(ctx) {
  if (viewState.updateIntervalBusy) return;
  const value = Number(String(viewState.updateIntervalDraft ?? '').trim());
  if (!Number.isInteger(value) || value < 5 || value > 1440) {
    viewState.updateIntervalError = '自动检查间隔必须是 5-1440 分钟之间的整数';
    ctx.renderCurrent(true);
    ctx.toast('自动检查间隔不合法，未保存', 'warn');
    return;
  }
  viewState.updateIntervalError = '';
  viewState.updateIntervalBusy = true;
  try {
    const next = await ctx.api.setUpdateCheckInterval({ checkIntervalMinutes: value });
    if (next && typeof next === 'object') ctx.state.update = { ...ctx.state.update, ...next };
    viewState.updateIntervalDraft = null;
    ctx.toast(`自动更新检查间隔已保存：${value} 分钟`, 'ok');
    ctx.logLocal('info', `自动更新检查间隔已设置为 ${value} 分钟`);
  } catch (err) {
    viewState.updateIntervalError = ctx.describeError(err, '保存自动更新检查间隔失败');
    ctx.toastError(err, '保存自动更新检查间隔失败');
  } finally {
    viewState.updateIntervalBusy = false;
    await ctx.reload('settings', { preserveScrollTop: true });
  }
}

/** 只有已开启注入时，模型配置变化才需要立即提醒 ChatGPT 重启。 */
function markRelaunchIfInjected(ctx) {
  const inject = ctx.state.inject || (ctx.state.status && ctx.state.status.inject);
  if (inject && inject.enabled) ctx.markRelaunchNeeded?.();
}

async function savePort(ctx) {
  // 与网关开关共用同一把锁：并发执行 gateway:set 会 stop/start 交叉，
  // 轻则 EADDRINUSE，重则把网关留在「store 说启用、实际没监听」的状态。
  if (viewState.gatewayBusy) return;
  const raw = viewState.portDraft !== null ? String(viewState.portDraft).trim() : '';
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1024 || port > 65535) {
    viewState.portError = '端口必须是 1024-65535 之间的整数';
    ctx.renderCurrent(true);
    ctx.toast('端口不合法，未保存', 'warn');
    return;
  }
  viewState.portError = '';
  viewState.gatewayBusy = true;
  try {
    const status = await ctx.api.setGateway({ port });
    ctx.state.status = status;
    if (status && status.gateway) {
      ctx.state.gateway = { ...(ctx.state.gateway || {}), ...status.gateway };
    }
    viewState.portDraft = null;
    const msg = status && status.gateway && status.gateway.running
      ? `网关已在端口 ${port} 上重新启动`
      : `端口已保存为 ${port}（网关当前未运行）`;
    ctx.toast(msg, 'ok');
    ctx.logLocal('info', msg);
  } catch (err) {
    ctx.toastError(err, '保存端口失败');
  } finally {
    viewState.gatewayBusy = false;
    await ctx.reload('settings');
  }
}

async function probeGateway(ctx) {
  if (viewState.probing) return;
  viewState.probing = true;
  ctx.renderCurrent(true);
  try {
    const res = await ctx.api.probeGateway();
    viewState.probe = { ...res, at: Date.now() };
    const msg = res && res.ok
      ? `网关健康检查通过：${ctx.fmt.dur((res && res.latencyMs) || 0)}`
      : `网关健康检查失败：${(res && res.error) || '未知错误'}`;
    ctx.toast(msg, res && res.ok ? 'ok' : 'error');
    ctx.logLocal(res && res.ok ? 'info' : 'error', msg);
  } catch (err) {
    viewState.probe = { ok: false, error: ctx.describeError(err), latencyMs: 0, at: Date.now() };
    ctx.toastError(err, '探活失败');
  } finally {
    viewState.probing = false;
    ctx.renderCurrent(true);
  }
}

async function openCodex(ctx) {
  try {
    const res = await ctx.api.openCodexFolder();
    if (res && res.ok) {
      ctx.toast('已在资源管理器中打开 Codex 配置目录', 'ok');
    } else {
      ctx.toast(`打开目录失败：${(res && res.error) || '未知错误'}`, 'error');
    }
  } catch (err) {
    ctx.toastError(err, '打开 Codex 目录失败');
  }
}

async function restoreInject(ctx) {
  if (viewState.restoreBusy) return;
  viewState.restoreBusy = true;
  try {
    const status = await ctx.api.setInject({ enabled: false });
    ctx.state.status = status;
    viewState.pendingRestore = false;
    const msg = '已还原注入：Codex 配置里的自定义模型清单已移除，重启客户端后回到官方模型';
    ctx.toast(msg, 'warn');
    ctx.logLocal('warn', msg);
  } catch (err) {
    ctx.toastError(err, '还原注入失败');
  } finally {
    viewState.restoreBusy = false;
    await ctx.reload('settings');
  }
}
