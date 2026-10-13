// 提供商页：卡片列表 + 编辑表单（含动态模型行、从 /models 拉取）。
//
// 安全：所有用户/接口字符串都经 textContent（el 的 text）或 setAttribute 进入 DOM。

const API_LABELS = { openai: 'OpenAI 兼容', responses: 'Responses 透传', anthropic: 'Anthropic' };

// 视图级临时状态（跨重渲染保留）
const viewState = {
  pendingDelete: null,
  testing: {},
  probe: {},
  revealed: {},
  toggling: {},
};

/**
 * 渲染提供商页。
 * @param {HTMLElement} root 内容容器
 * @param {any} ctx app.js 提供的上下文
 * @param {HTMLElement} actions 标题栏右侧动作槽
 */
export function renderProviders(root, ctx, actions) {
  const { el, icon, state } = ctx;
  const providers = state.providers || [];

  // ---- 标题栏动作 ----
  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.reload('providers') },
    }, [icon('refresh', 13), el('span', { text: '刷新' })]),
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      on: { click: () => openProviderForm(ctx, null) },
    }, [icon('plus', 13), el('span', { text: '添加提供商' })]),
  );

  if (!providers.length) {
    root.replaceChildren(emptyState(ctx));
    return;
  }

  // ---- 概览条 ----
  const modelTotal = providers.reduce((n, p) => n + (p.models || []).length, 0);
  const modelOn = providers.reduce(
    (n, p) => n + (p.models || []).filter((m) => m.enabled !== false).length,
    0,
  );
  const injecting = !!(state.status && state.status.inject && state.status.inject.enabled);
  const quota = el('div', { class: 'toolbar toolbar-sticky' }, [
    el('span', { class: 'muted', text: `共 ${providers.length} 个提供商` }),
    el('span', { class: 'flow-sep', text: '·' }),
    el('span', { class: 'muted', text: `${modelTotal} 个模型（${modelOn} 个已启用）` }),
    el('span', {
      class: 'right chip chip-mono ' + (injecting ? 'chip-codex' : ''),
      text: `注入 ${injecting ? '开启' : '关闭'}`,
    }),
  ]);

  const grid = el('div', { class: 'grid' }, providers.map((p) => providerCard(ctx, p)));
  root.replaceChildren(quota, grid);
}

function emptyState(ctx) {
  const { el, icon } = ctx;
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-glyph' }, [icon('plug', 20)]),
    el('div', { class: 'empty-title', text: '还没有任何提供商' }),
    el('div', {
      class: 'empty-text',
      text: '点击右上角「添加提供商」，填入 Base URL 与 API Key。保存后可以点「从 /models 拉取」自动获取模型列表，再把它们注入 ChatGPT 的模型选择器。',
    }),
    el('div', { class: 'empty-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        on: { click: () => openProviderForm(ctx, null) },
      }, [icon('plus', 13), el('span', { text: '添加提供商' })]),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        on: { click: () => ctx.navigate('settings') },
      }, [icon('server', 13), el('span', { text: '先看网关设置' })]),
    ]),
  ]);
}

// ============ 提供商卡片 ============
function providerCard(ctx, p) {
  const { el, icon, maskKey } = ctx;
  const models = p.models || [];
  const enabledModels = models.filter((m) => m.enabled !== false);
  const reasoning = models.filter((m) => m.reasoning).length;
  const isOn = p.enabled !== false;
  const probe = viewState.probe[p.id];

  // 名称 + Base URL
  const head = el('div', { class: 'pcard-top' }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'pcard-name ellipsis', text: p.name || '(未命名)' }),
      el('div', { class: 'mono faint ellipsis', title: p.baseUrl || '', text: p.baseUrl || '未填写 Base URL' }),
    ]),
    el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      title: isOn ? '点击停用该提供商' : '点击启用该提供商',
      attrs: { 'aria-checked': isOn ? 'true' : 'false', 'aria-label': `${p.name} 启用开关`, 'aria-busy': viewState.toggling[p.id] ? 'true' : null },
      on: { click: () => toggleProvider(ctx, p) },
    }),
  ]);

  // 状态徽标
  const chips = el('div', { class: 'pcard-chips' }, [
    el('span', { class: 'chip', text: API_LABELS[p.api] || p.api || 'OpenAI 兼容' }),
    el('span', {
      class: 'chip ' + (isOn ? 'chip-ok' : ''),
      text: isOn ? '已启用' : '已停用',
    }),
    el('span', { class: 'chip', text: `${models.length} 个模型` }),
    enabledModels.length !== models.length
      ? el('span', { class: 'chip', text: `${models.length - enabledModels.length} 个未启用` })
      : null,
    reasoning ? el('span', { class: 'chip', text: `${reasoning} 个支持推理` }) : null,
    p.hasKey === false ? el('span', { class: 'chip chip-warn', text: '缺少 API Key' }) : null,
  ]);

  // API Key（默认打码，点击眼睛显示）
  const revealed = !!viewState.revealed[p.id];
  const keyValue = p.apiKey
    ? revealed
      ? p.apiKey
      : maskKey(p.apiKey)
    : '未配置';
  const keyLine = el('dd', { class: 'keyline' }, [
    el('span', {
      class: 'keyval' + (revealed ? ' is-revealed' : ''),
      title: revealed ? '当前为明文显示' : '点击右侧图标显示明文',
      text: keyValue,
    }),
    p.apiKey
      ? el('button', {
          class: 'btn btn-icon',
          type: 'button',
          title: revealed ? '隐藏 API Key' : '显示 API Key',
          attrs: { 'aria-label': revealed ? '隐藏 API Key' : '显示 API Key' },
          on: {
            click: () => {
              viewState.revealed[p.id] = !revealed;
              ctx.renderCurrent(true);
            },
          },
        }, [icon(revealed ? 'eyeOff' : 'eye', 13)])
      : null,
    p.apiKey
      ? el('button', {
          class: 'btn btn-icon',
          type: 'button',
          title: '复制 API Key',
          attrs: { 'aria-label': '复制 API Key' },
          on: { click: () => ctx.copyText(p.apiKey, ' API Key') },
        }, [icon('copy', 13)])
      : null,
  ]);

  const headerCount = Object.keys(p.headers || {}).length;
  const kv = el('dl', { class: 'pcard-kv' }, [
    el('dt', { text: 'API Key' }),
    keyLine,
    el('dt', { text: '请求头' }),
    el('dd', {
      class: 'muted',
      text: headerCount ? `${headerCount} 个自定义请求头` : '无（仅用默认头）',
    }),
  ]);

  // 模型预览
  const preview = models.slice(0, 4).map((m) =>
    el('span', {
      class: 'chip' + (m.enabled === false ? ' faint' : ''),
      title: m.id,
      text: m.label || m.id,
    }),
  );
  if (models.length > 4) {
    preview.push(el('span', { class: 'chip chip-more', text: `+${models.length - 4}` }));
  }
  const modelMini = el('div', { class: 'model-mini' }, preview.length ? preview : [
    el('span', { class: 'faint', text: '还没有模型：编辑该提供商后可手动添加或从 /models 拉取' }),
  ]);

  // 底部动作
  const foot = el('div', { class: 'pcard-foot' });
  if (viewState.pendingDelete === p.id) {
    foot.append(
      el('span', { class: 'probe-bad', text: `确认删除「${p.name}」？它的 ${models.length} 个模型会同时从 ChatGPT 清单里移除。` }),
      el('span', { class: 'right' }),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        on: { click: () => { viewState.pendingDelete = null; ctx.renderCurrent(true); } },
      }, [el('span', { text: '取消' })]),
      el('button', {
        class: 'btn btn-sm btn-danger',
        type: 'button',
        on: { click: () => removeProvider(ctx, p) },
      }, [icon('trash', 13), el('span', { text: '确认删除' })]),
    );
  } else {
    foot.append(
      el('button', {
        class: 'btn btn-sm btn-success' + (viewState.testing[p.id] ? ' is-busy' : ''),
        type: 'button',
        disabled: viewState.testing[p.id] ? true : null,
        on: { click: () => testProvider(ctx, p) },
      }, [icon('activity', 13), el('span', { text: viewState.testing[p.id] ? '测试中…' : '测试连接' })]),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        on: { click: () => openProviderForm(ctx, p.id) },
      }, [icon('pencil', 13), el('span', { text: '编辑' })]),
      el('button', {
        class: 'btn btn-sm btn-danger right',
        type: 'button',
        title: '删除该提供商',
        on: { click: () => { viewState.pendingDelete = p.id; ctx.renderCurrent(true); } },
      }, [icon('trash', 13)]),
    );
    if (probe) {
      foot.append(probeResult(ctx, p, probe));
    }
  }

  return el('article', { class: 'card pcard' + (isOn ? '' : ' is-off') }, [
    head,
    chips,
    kv,
    modelMini,
    foot,
  ]);
}

function probeResult(ctx, p, probe) {
  const { el, icon, fmt } = ctx;
  return el('div', {
    class: 'probe-result ' + (probe.ok ? 'probe-ok' : 'probe-bad'),
    title: probe.error || '',
  }, [
    icon(probe.ok ? 'check' : 'alert', 13),
    el('span', {
      class: 'probe-text',
      text: probe.ok
        ? `连接正常 · HTTP ${probe.status ?? 200} · ${fmt.dur(probe.latencyMs)} · ${fmt.rel(probe.at)}`
        : `失败：${probe.error || '未知错误'}（${fmt.dur(probe.latencyMs)}）`,
    }),
  ]);
}

async function toggleProvider(ctx, p) {
  if (viewState.toggling[p.id]) return;
  viewState.toggling[p.id] = true;
  try {
    const next = { ...p, enabled: p.enabled === false };
    const list = await ctx.api.saveProvider(next);
    ctx.state.providers = list;
    markRelaunchIfInjected(ctx);
    ctx.logLocal('info', `提供商「${p.name}」已${next.enabled ? '启用' : '停用'}`);
    ctx.toast(next.enabled ? `已启用「${p.name}」` : `已停用「${p.name}」`, 'ok');
    await ctx.reload('providers');
  } catch (err) {
    ctx.toastError(err, '切换启用状态失败');
  } finally {
    viewState.toggling[p.id] = false;
  }
}

async function testProvider(ctx, p) {
  viewState.testing[p.id] = true;
  viewState.probe[p.id] = null;
  ctx.renderCurrent(true);
  try {
    const res = await ctx.api.testProvider(p.id);
    viewState.probe[p.id] = { ...res, at: Date.now() };
    const summary = res.ok
      ? `「${p.name}」连接正常：HTTP ${res.status ?? 200}，${ctx.fmt.dur(res.latencyMs)}`
      : `「${p.name}」连接失败：${res.error || '未知错误'}`;
    ctx.logLocal(res.ok ? 'info' : 'error', summary);
    ctx.toast(summary, res.ok ? 'ok' : 'error');
  } catch (err) {
    viewState.probe[p.id] = { ok: false, error: ctx.describeError(err), latencyMs: 0, at: Date.now() };
    ctx.toastError(err, '测试连接失败');
  } finally {
    viewState.testing[p.id] = false;
    ctx.renderCurrent(true);
  }
}

async function removeProvider(ctx, p) {
  viewState.pendingDelete = null;
  try {
    const list = await ctx.api.deleteProvider(p.id);
    ctx.state.providers = list;
    delete viewState.probe[p.id];
    delete viewState.revealed[p.id];
    markRelaunchIfInjected(ctx);
    ctx.toast(`已删除「${p.name}」`, 'ok');
    await ctx.reload('providers');
  } catch (err) {
    ctx.toastError(err, '删除失败');
    ctx.renderCurrent(true);
  }
}

// ============ 编辑表单 ============
let activeCtx = null;

export function closeProviderForm() {
  if (activeCtx) activeCtx.closeModal();
}

/**
 * 打开提供商编辑表单（providerId 为空表示新建）。
 * @param {any} ctx
 * @param {string|null} providerId
 */
export function openProviderForm(ctx, providerId = null) {
  const { el, icon } = ctx;
  activeCtx = ctx;
  const existing = providerId ? (ctx.state.providers || []).find((p) => p.id === providerId) : null;

  const draft = {
    id: existing ? existing.id : null,
    name: existing ? existing.name : '',
    baseUrl: existing ? existing.baseUrl : '',
    apiKey: existing ? existing.apiKey || '' : '',
    api: existing && (existing.api === 'anthropic' || existing.api === 'responses') ? existing.api : 'openai',
    enabled: existing ? existing.enabled !== false : true,
    headers: Object.entries((existing && existing.headers) || {}).map(([key, value]) => ({ key, value })),
    models: ((existing && existing.models) || []).map((m) => ({
      id: m.id,
      label: m.label || m.id,
      enabled: m.enabled !== false,
      reasoning: !!m.reasoning,
    })),
    revealed: false,
    busy: false,
    note: null, // { kind, text }
    filter: '',
  };

  const refs = {};

  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    value: draft.name,
    placeholder: '例如：梦幻API',
    attrs: { 'data-autofocus': 'true', autocomplete: 'off' },
    on: { input: (e) => { draft.name = e.target.value; clearError(refs.nameErr); } },
  });
  const baseInput = el('input', {
    class: 'input mono',
    type: 'text',
    value: draft.baseUrl,
    placeholder: 'api.example.com/v1',
    attrs: { autocomplete: 'off', spellcheck: 'false' },
    on: { input: (e) => { draft.baseUrl = e.target.value; clearError(refs.baseErr); } },
  });
  const keyInput = el('input', {
    class: 'input mono',
    type: 'password',
    value: draft.apiKey,
    placeholder: 'sk-…（可留空，读取环境变量或使用无鉴权接口）',
    attrs: { autocomplete: 'off', spellcheck: 'false' },
    on: { input: (e) => { draft.apiKey = e.target.value; } },
  });
  const keyToggle = el('button', {
    class: 'btn btn-icon',
    type: 'button',
    title: '显示 API Key',
    attrs: { 'aria-label': '显示 API Key' },
    on: {
      click: () => {
        draft.revealed = !draft.revealed;
        keyInput.type = draft.revealed ? 'text' : 'password';
        keyToggle.replaceChildren(icon(draft.revealed ? 'eyeOff' : 'eye', 14));
        keyToggle.title = draft.revealed ? '隐藏 API Key' : '显示 API Key';
      },
    },
  }, [icon('eye', 14)]);

  const headersArea = el('textarea', {
    class: 'textarea mono',
    rows: '2',
    placeholder: '一行一个：X-Custom-Header: value',
    attrs: { spellcheck: 'false' },
    on: { input: (e) => { draft.headersText = e.target.value; clearError(refs.headerErr); } },
  });
  headersArea.value = draft.headers.map((h) => `${h.key}: ${h.value}`).join('\n');
  draft.headersText = headersArea.value;

  const enabledCheck = el('input', {
    type: 'checkbox',
    checked: draft.enabled ? true : null,
    on: { change: (e) => { draft.enabled = e.target.checked; } },
  });

  // API 协议分段控件
  const apiSeg = el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': '接口协议' } });
  for (const value of ['openai', 'responses', 'anthropic']) {
    apiSeg.append(
      el('button', {
        class: draft.api === value ? 'is-active' : '',
        type: 'button',
        attrs: { 'aria-pressed': draft.api === value ? 'true' : 'false' },
        on: {
          click: () => {
            draft.api = value;
            for (const btn of apiSeg.querySelectorAll('button')) {
              const on = btn.dataset.api === value;
              btn.classList.toggle('is-active', on);
              btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
          },
        },
        data: { api: value },
      }, [el('span', { text: API_LABELS[value] })]),
    );
  }

  // ---- 模型行 ----
  const rowsBox = el('div', { class: 'model-rows' });
  const rowsSummary = el('span', { class: 'faint' });
  const filterInput = el('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索模型 ID 或显示名',
    attrs: { spellcheck: 'false' },
    on: {
      input: (e) => {
        draft.filter = e.target.value.trim().toLowerCase();
        renderRows();
      },
    },
  });

  function visibleRows() {
    if (!draft.filter) return draft.models;
    return draft.models.filter(
      (m) => m.id.toLowerCase().includes(draft.filter) || String(m.label || '').toLowerCase().includes(draft.filter),
    );
  }

  function updateSummary(visibleCount) {
    const on = draft.models.filter((m) => m.enabled).length;
    rowsSummary.textContent = draft.models.length
      ? `共 ${draft.models.length} 个模型，${on} 个会注入 ChatGPT${
          draft.filter ? `（当前过滤显示 ${visibleCount} 个）` : ''
        }`
      : '清单为空时保存不会报错，但该提供商不会贡献任何模型';
  }

  function renderRows() {
    const list = visibleRows();
    const head = el('div', { class: 'mrow mrow-head' }, [
      el('span', { text: '模型 ID（发给上游的真实名字）' }),
      el('span', { text: '显示名' }),
      el('span', { text: '启用' }),
      el('span', { text: '推理' }),
      el('span', { text: '' }),
    ]);
    const rows = list.map((model) => modelRow(model));
    if (!draft.models.length) {
      rowsBox.replaceChildren(
        el('div', { class: 'model-rows-empty' }, [
          el('div', { text: '还没有模型' }),
          el('div', { class: 'faint', text: '点「添加一行」手动填写，或保存后点「从 /models 拉取」自动填充' }),
        ]),
      );
    } else if (!rows.length) {
      rowsBox.replaceChildren(
        el('div', { class: 'model-rows-empty', text: `没有匹配「${draft.filter}」的模型` }),
      );
    } else {
      rowsBox.replaceChildren(head, ...rows);
    }
    updateSummary(rows.length);
  }

  function modelRow(model) {
    const idInput = el('input', {
      class: 'input mono',
      type: 'text',
      value: model.id,
      attrs: { spellcheck: 'false' },
      on: { input: (e) => { model.id = e.target.value; } },
    });
    const labelInput = el('input', {
      class: 'input',
      type: 'text',
      value: model.label || model.id,
      on: { input: (e) => { model.label = e.target.value; } },
    });
    const onCheck = el('input', {
      type: 'checkbox',
      checked: model.enabled ? true : null,
      attrs: { 'aria-label': '启用该模型' },
      on: {
        change: (e) => {
          // 只更新计数，不重建行：否则复选框会失去焦点，键盘用户很难连续操作
          model.enabled = e.target.checked;
          updateSummary(visibleRows().length);
        },
      },
    });
    const reasonCheck = el('input', {
      type: 'checkbox',
      checked: model.reasoning ? true : null,
      attrs: { 'aria-label': '该模型支持推理' },
      on: { change: (e) => { model.reasoning = e.target.checked; } },
    });
    return el('div', { class: 'mrow' }, [
      idInput,
      labelInput,
      el('label', { class: 'check', title: '取消勾选后该模型不会出现在 ChatGPT 里' }, [onCheck]),
      el('label', { class: 'check', title: '勾选后目录条目会带上推理档位' }, [reasonCheck]),
      el('button', {
        class: 'btn btn-icon btn-danger',
        type: 'button',
        title: '删除这一行',
        attrs: { 'aria-label': '删除这一行' },
        on: {
          click: () => {
            const idx = draft.models.indexOf(model);
            if (idx >= 0) draft.models.splice(idx, 1);
            renderRows();
          },
        },
      }, [icon('x', 13)]),
    ]);
  }

  // ---- 拉取 / 批量 ----
  const pullBtn = el('button', {
    class: 'btn btn-sm btn-accent',
    type: 'button',
    title: '请求该提供商的 /models 并合并进下面的清单',
    on: { click: () => pullModels(ctx, draft, refs, saveBtn, afterRowsChange) },
  }, [icon('refresh', 13), el('span', { text: '从 /models 拉取' })]);

  const noteBox = el('div');

  function setNote(kind, text) {
    if (!kind) {
      noteBox.replaceChildren();
      return;
    }
    noteBox.replaceChildren(
      el('div', { class: `note note-${kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : 'info'}` }, [
        icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert', 14),
        el('div', { class: 'grow' }, [el('div', { text })]),
      ]),
    );
  }

  function afterRowsChange() {
    renderRows();
  }

  function clearError(node) {
    if (node) node.textContent = '';
  }

  // ---- 组装 ----
  refs.nameErr = el('div', { class: 'hint-error' });
  refs.baseErr = el('div', { class: 'hint-error' });
  refs.headerErr = el('div', { class: 'hint-error' });
  refs.nameInput = nameInput;
  refs.baseInput = baseInput;
  refs.note = setNote;

  const body = el('div', { class: 'modal-body' }, [
    noteBox,
    el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label' }, [el('span', { text: '名称' }), el('span', { class: 'req', text: '*' })]),
        nameInput,
        refs.nameErr,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', text: '接口协议' }),
        apiSeg,
        el('div', { class: 'hint', text: 'OpenAI 兼容走 /chat/completions 适配；Responses 透传要求上游原生支持 /v1/responses；Anthropic 走 Messages 适配' }),
      ]),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label' }, [el('span', { text: 'Base URL' }), el('span', { class: 'req', text: '*' })]),
      baseInput,
      el('div', { class: 'hint', text: '只填到版本号即可，例如 api.example.com/v1；缺少协议头或 /v1 时保存会自动补齐' }),
      refs.baseErr,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'API Key' }),
      el('div', { class: 'input-group' }, [keyInput, keyToggle]),
      el('div', { class: 'hint', text: '仅保存在本机 ~/.gptplus/config.json；网关用明文 Bearer 转发，界面里默认打码' }),
    ]),
    el('div', { class: 'modal-sect' }, [
      el('div', { class: 'modal-sect-head' }, [
        el('span', { class: 'modal-sect-title', text: '模型清单' }),
        rowsSummary,
        el('span', { class: 'right' }),
        pullBtn,
      ]),
      el('div', { class: 'toolbar' }, [
        filterInput,
        el('button', {
          class: 'btn btn-sm btn-success',
          type: 'button',
          on: {
            click: () => {
              for (const m of draft.models) m.enabled = true;
              renderRows();
            },
          },
        }, [el('span', { text: '全部启用' })]),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          on: {
            click: () => {
              for (const m of draft.models) m.enabled = false;
              renderRows();
            },
          },
        }, [el('span', { text: '全部停用' })]),
        el('span', { class: 'right' }),
        el('button', {
          class: 'btn btn-sm btn-accent',
          type: 'button',
          on: {
            click: () => {
              draft.models.push({
                id: '',
                label: '',
                enabled: true,
                reasoning: false,
              });
              filterInput.value = '';
              draft.filter = '';
              renderRows();
              const inputs = rowsBox.querySelectorAll('.mrow:last-child .input');
              if (inputs.length) inputs[0].focus();
            },
          },
        }, [icon('plus', 13), el('span', { text: '添加一行' })]),
      ]),
      el('div', { class: 'stack' }, [rowsBox, el('div', { class: 'hint', text: 'slug 规则：<渠道名>__<modelId>，模型 ID 里允许 . - _（不要用双下划线）' })]),
    ]),
    el('div', { class: 'modal-sect' }, [
      el('div', { class: 'modal-sect-head' }, [el('span', { class: 'modal-sect-title', text: '高级' })]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', text: '额外请求头（可选）' }),
        headersArea,
        el('div', { class: 'hint', text: '一行一个，支持 "Key: Value" 或 "Key=Value"；这些头会附加到发往该提供商的请求上' }),
        refs.headerErr,
      ]),
      el('label', { class: 'check', style: { 'margin-top': '10px' } }, [
        enabledCheck,
        el('span', { text: '启用该提供商（停用后它的模型不会出现在 ChatGPT 清单里）' }),
      ]),
    ]),
  ]);

  const cancelBtn = el('button', {
    class: 'btn btn-ghost',
    type: 'button',
    on: { click: () => ctx.closeProviderForm() },
  }, [el('span', { text: '取消' })]);

  const saveBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    on: { click: () => saveDraft(ctx, draft, refs, saveBtn) },
  }, [icon('check', 13), el('span', { text: existing ? '保存修改' : '保存提供商' })]);

  const modal = el('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': existing ? '编辑提供商' : '添加提供商' } }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'grow' }, [
        refs.titleNode = el('h2', { text: existing ? `编辑「${existing.name}」` : '添加提供商' }),
        refs.subNode = el('div', {
          class: 'modal-sub',
          text: existing ? `id: ${existing.id}` : '保存后会立即写入 ~/.gptplus/config.json',
        }),
      ]),
      el('button', {
        class: 'btn btn-icon',
        type: 'button',
        title: '关闭',
        attrs: { 'aria-label': '关闭' },
        on: { click: () => ctx.closeProviderForm() },
      }, [icon('x', 15)]),
    ]),
    body,
    el('div', { class: 'modal-foot' }, [
      el('span', { class: 'hint', text: 'Ctrl+Enter 保存 · Esc 关闭' }),
      el('span', { class: 'right' }),
      cancelBtn,
      saveBtn,
    ]),
  ]);

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveDraft(ctx, draft, refs, saveBtn);
    }
  });

  renderRows();
  if (draft.filter) filterInput.value = draft.filter;
  ctx.openModal(modal, {});
}

// ============ 保存 ============
function parseHeaders(text) {
  const out = {};
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const idxColon = line.indexOf(':');
    const idxEq = line.indexOf('=');
    let idx = -1;
    if (idxColon >= 0 && (idxEq < 0 || idxColon < idxEq)) idx = idxColon;
    else if (idxEq >= 0) idx = idxEq;
    if (idx < 0) {
      errors.push(`第 ${i + 1} 行缺少 ":" 或 "="：${line}`);
      return;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) {
      errors.push(`第 ${i + 1} 行的请求头名为空`);
      return;
    }
    out[key] = value;
  });
  return { headers: out, errors };
}

/**
 * 保存表单。
 * @param {any} ctx
 * @param {any} draft
 * @param {any} refs
 * @param {HTMLElement} saveBtn
 * @param {{ keepOpen?: boolean }} [opts] keepOpen=true 时不关弹窗（用于「保存后继续拉取模型」）
 * @returns {Promise<{ ok: boolean, saved?: any }>}
 */
async function saveDraft(ctx, draft, refs, saveBtn, opts = {}) {
  // 静默 return 会让按钮看起来失灵（busy 期间按钮未必都禁用得干净）
  if (draft.busy) {
    ctx.toast('上一条操作还没完成，请稍候', 'warn');
    return { ok: false };
  }

  // 校验
  let bad = false;
  if (!String(draft.name || '').trim()) {
    if (refs.nameErr) refs.nameErr.textContent = '请填写提供商名称，例如「梦幻API」';
    if (refs.nameInput) refs.nameInput.classList.add('is-invalid');
    bad = true;
  } else if (refs.nameInput) {
    refs.nameInput.classList.remove('is-invalid');
    if (refs.nameErr) refs.nameErr.textContent = '';
  }
  if (!String(draft.baseUrl || '').trim()) {
    if (refs.baseErr) refs.baseErr.textContent = '请填写 Base URL，例如 api.example.com/v1';
    if (refs.baseInput) refs.baseInput.classList.add('is-invalid');
    bad = true;
  } else if (refs.baseInput) {
    refs.baseInput.classList.remove('is-invalid');
    if (refs.baseErr) refs.baseErr.textContent = '';
  }
  const parsedHeaders = parseHeaders(draft.headersText);
  if (refs.headerErr) refs.headerErr.textContent = parsedHeaders.errors.join('；');
  if (parsedHeaders.errors.length) bad = true;
  if (bad) {
    ctx.toast('表单里还有问题，请先修正标红的字段', 'warn');
    return { ok: false };
  }

  const cleanedModels = [];
  for (const m of draft.models) {
    const id = String(m.id || '').trim();
    if (!id) continue;
    cleanedModels.push({
      id,
      label: String(m.label || '').trim() || id,
      enabled: m.enabled !== false,
      reasoning: !!m.reasoning,
    });
  }
  draft.models = cleanedModels;

  const before = new Set((ctx.state.providers || []).map((p) => p.id));
  draft.busy = true;
  if (saveBtn) {
    saveBtn.classList.add('is-busy');
    saveBtn.disabled = true;
  }
  const labelNode = saveBtn ? saveBtn.lastElementChild : null;
  const oldLabel = labelNode ? labelNode.textContent : '';
  if (labelNode) labelNode.textContent = '保存中…';

  try {
    const list = await ctx.api.saveProvider({
      id: draft.id || undefined,
      name: String(draft.name).trim(),
      baseUrl: String(draft.baseUrl).trim(),
      apiKey: draft.apiKey,
      api: draft.api,
      headers: { ...parsedHeaders.headers },
      // 传副本：保存之后还会继续拉取 /models 并修改 draft.models，别让已提交的载荷被后续改动带偏
      models: draft.models.map((m) => ({ ...m })),
      enabled: draft.enabled,
    });
    ctx.state.providers = list;
    markRelaunchIfInjected(ctx);
    // 新建时不能用「不在旧快照里」直接认定第一条就是刚存的：快照可能过期（别处也加过提供商），
    // 那样 draft.id 会绑到错误的提供商上。先筛出新增项，再按名字对齐，取不到用最后一项。
    const fresh = list.filter((p) => p && !before.has(p.id));
    const wantedName = String(draft.name).trim();
    const saved = draft.id
      ? list.find((p) => p.id === draft.id)
      : fresh.find((p) => p.name === wantedName) || fresh[fresh.length - 1];
    if (saved) draft.id = saved.id;
    const name = saved ? saved.name : String(draft.name).trim();
    const modelCount = saved ? (saved.models || []).length : draft.models.length;

    if (opts.keepOpen) {
      // 弹窗留着继续拉取模型：只更新标题与保存按钮文案，页面在后台刷新
      if (refs.titleNode) refs.titleNode.textContent = `编辑「${name}」`;
      if (refs.subNode) refs.subNode.textContent = `id: ${draft.id}`;
      if (labelNode) labelNode.textContent = '保存修改';
      ctx.toast(`已保存「${name}」· ${modelCount} 个模型`, 'ok');
      ctx.logLocal('info', `提供商已保存：${name}（${modelCount} 个模型）`);
      ctx.renderChrome();
      return { ok: true, saved };
    }

    ctx.toast(`已保存「${name}」· ${modelCount} 个模型`, 'ok');
    ctx.logLocal('info', `提供商已保存：${name}（${modelCount} 个模型）`);
    ctx.closeProviderForm();
    await ctx.reload('providers');
    return { ok: true, saved };
  } catch (err) {
    ctx.toastError(err, '保存失败');
    return { ok: false };
  } finally {
    draft.busy = false;
    if (saveBtn) {
      saveBtn.classList.remove('is-busy');
      saveBtn.disabled = false;
    }
    if (labelNode && !opts.keepOpen) labelNode.textContent = oldLabel;
  }
}

/** 提供商配置变化会重写注入目录，已开启注入时提醒客户端重启。 */
function markRelaunchIfInjected(ctx) {
  const inject = ctx.state.inject || (ctx.state.status && ctx.state.status.inject);
  if (inject && inject.enabled) ctx.markRelaunchNeeded?.();
}

// ============ 从 /models 拉取 ============
async function pullModels(ctx, draft, refs, saveBtn, afterRowsChange) {
  if (draft.busy) {
    ctx.toast('上一条操作还没完成，请稍候', 'warn');
    return;
  }

  // 新提供商还没有 id，主进程无法定位它：先在原地保存（不关弹窗），再拉取
  if (!draft.id) {
    const res = await saveDraft(ctx, draft, refs, saveBtn, { keepOpen: true });
    if (!res.ok) return;
    if (refs.note) {
      refs.note('info', `已保存并分配 id ${draft.id}，正在请求 /models …`);
    }
  }
  await doPull(ctx, draft, afterRowsChange);
}

async function doPull(ctx, draft, afterRowsChange) {
  if (!draft.id) {
    ctx.toast('请先保存提供商，再拉取 /models', 'warn');
    return;
  }
  draft.busy = true;
  try {
    const res = await ctx.api.fetchRemoteModels(draft.id);
    if (!res || !res.ok) {
      const why = (res && res.error) || '未知错误';
      ctx.toast(`拉取失败：${why}`, 'error');
      ctx.logLocal('error', `拉取 /models 失败（${draft.name}）：${why}`);
      return;
    }
    const remote = Array.isArray(res.models) ? res.models : [];
    const byId = new Map(draft.models.map((m) => [m.id, m]));
    let added = 0;
    let kept = 0;
    for (const item of remote) {
      const id = String(item && item.id ? item.id : '').trim();
      if (!id) continue;
      const exist = byId.get(id);
      if (exist) {
        kept += 1;
        const label = String((item && item.label) || id).trim();
        if (label && label !== id) exist.label = label;
      } else {
        draft.models.push({
          id,
          label: String((item && item.label) || id).trim() || id,
          enabled: true,
          reasoning: false,
        });
        added += 1;
      }
    }
    afterRowsChange();
    const msg = `拉取到 ${remote.length} 个模型：新增 ${added} 个，已存在 ${kept} 个（原有启用/推理设置已保留）`;
    ctx.toast(msg, 'ok');
    ctx.logLocal('info', msg);
    if (refs.note) refs.note('ok', `已从 /models 合并 ${remote.length} 个模型，记得点「保存修改」把结果写进配置。`);
  } catch (err) {
    ctx.toastError(err, '拉取 /models 失败');
  } finally {
    draft.busy = false;
  }
}
