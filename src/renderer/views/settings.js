// 设置页：本地网关（开关/端口/探活/令牌）、Codex 配置写入情况与还原注入。

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
};

/** 渲染设置页 */
export function renderSettings(root, ctx, actions) {
  const { el, icon, state } = ctx;
  const gateway = state.gateway || (state.status && state.status.gateway) || {};
  const inject = state.inject || (state.status && state.status.inject) || { enabled: false, catalogPath: null, defaultModel: null };
  const modelLimits = state.modelLimits || (state.status && state.status.modelLimits) || { contextWindow: 1_000_000, autoCompactTokenLimit: null };
  const codex = (state.status && state.status.codex) || {};
  const paths = (state.status && state.status.paths) || {};

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
    injectCard(ctx, { inject, codex }),
    aboutCard(ctx, { gateway, codex, inject, paths }),
  );
}

// ============ 软件更新 ==========
function updateCard(ctx) {
  const { el, icon, state } = ctx;
  const update = state.update || {};
  const current = update.currentVersion || (state.status && state.status.appVersion) || '0.0.0';
  const hasVersion = !!update.version;
  const busy = update.status === 'checking' || update.status === 'downloading';
  const pending = ['available', 'downloaded'].includes(update.status);
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
      el('span', { class: 'card-desc', text: '启动时只检查，不会自动下载；更新由你确认后开始' }),
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
      update.status === 'error'
        ? el('div', { class: 'hint-error', text: '请检查网络连接后再次点击“检查更新”。' })
        : null,
    ]),
  ]);
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
          el('div', { class: 'setting-desc', text: '写入模型的 context_window / max_context_window；这是客户端展示与压缩计算的声明值，不会改变上游模型的真实上下文能力，建议按最小模型的真实上限填写。' }),
        ]),
        el('div', { class: 'setting-ctl' }, [contextInput]),
      ]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title', text: '自动压缩阈值 Token' }),
          el('div', { class: 'setting-desc', text: `达到该用量后客户端触发自动压缩；必须小于上下文窗口，留空表示交给客户端默认处理。当前：${ratio}` }),
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
        el('div', { class: 'setting-desc', text: '非空时网关要求 Authorization: Bearer <token>；它会作为 experimental_bearer_token 写进 Codex 配置。' }),
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
