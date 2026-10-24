// 模型页：把「提供商 → 本地网关 → ChatGPT 模型选择器」这条链路摆在一个界面里，
// 链路末端的开关就是注入总开关；下面的选择器决定客户端默认用哪个模型。

const viewState = {
  filter: '',
  onlyEnabled: false,
  busy: false,
  warn: null, // { text, action: 'providers' | 'settings' }
};

const dragState = {
  row: null,
  rowsBox: null,
  rows: [],
  startIndex: -1,
  targetIndex: -1,
  startY: 0,
  rowHeight: 0,
  rowTops: [],
  grabOffsetY: 0,
  moveFrame: 0,
  lastY: 0,
  pointerId: null,
  finish: null,
  onBlur: null,
};

/** 渲染模型页 */
export function renderModels(root, ctx, actions) {
  // 页面重绘会销毁当前的拖拽行。先收尾，避免模块里的拖拽状态继续指向已移除的节点，
  // 导致之后每次按下都在入口被静默忽略（界面表现为“拖不动、也没有报错”）。
  if (dragState.row) cancelModelDrag();
  const { el, icon, state } = ctx;
  const models = state.models || [];
  const inject = state.inject || (state.status && state.status.inject) || { enabled: false, defaultModel: null };
  const gateway = state.gateway || (state.status && state.status.gateway) || {};
  const providerCount = (state.status && state.status.providers) || (state.providers || []).length || 0;

  // ---- 标题栏动作 ----
  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.reload('models') },
    }, [icon('refresh', 13), el('span', { text: '刷新' })]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      title: '在资源管理器中打开 ~/.codex',
      on: { click: () => openCodexFolder(ctx) },
    }, [icon('folder', 13), el('span', { text: '打开 Codex 目录' })]),
  );

  if (!models.length) {
    root.replaceChildren(emptyState(ctx));
    return;
  }

  const enabledModels = models.filter((m) => m.enabled);

  // ---- 接线三节点（本页的记忆点：一眼看清链路断在哪一环） ----
  const wiring = el('div', { class: 'wiring' }, [
    wireNode(ctx, {
      step: '1 · 提供商',
      value: `${providerCount} 个`,
      detail: `提供 ${models.length} 个模型`,
      tone: providerCount ? 'on' : 'off',
    }),
    el('div', { class: 'wire-link' + (gateway.running && inject.enabled ? ' is-live' : '') }, [icon('chevronDown', 14)]),
    wireNode(ctx, {
      step: '2 · 本地网关',
      value: gateway.running ? `运行中 :${gateway.port}` : gateway.enabled ? '已启用 · 未运行' : '未启用',
      detail: gateway.running ? gateway.url || `127.0.0.1:${gateway.port}` : 'ChatGPT 通过它访问你的模型',
      tone: gateway.running ? 'on' : gateway.enabled ? 'warn' : 'off',
    }),
    el('div', { class: 'wire-link' + (inject.enabled ? ' is-live' : '') }, [icon('chevronDown', 14)]),
    injectNode(ctx, { inject, gateway, enabledModels }),
  ]);

  // ---- 注入状态说明（具体、有信息量的一句话） ----
  const summary = inject.enabled
    ? el('div', { class: 'note note-ok' }, [
        icon('check', 15),
        el('div', { class: 'grow' }, [
          el('div', { text: `已注入 ${enabledModels.length} 个模型 · 重启 ChatGPT 客户端后可在模型选择器中看到` }),
          el('div', {
            class: 'faint',
            text: inject.catalogPath
              ? `模型目录：${ctx.shortPath(inject.catalogPath)} · 写入 Codex 配置前会自动备份`
              : '模型目录已写入 Codex 配置',
          }),
        ]),
      ])
    : el('div', { class: 'note' }, [
        icon('info', 15),
        el('div', { class: 'grow' }, [
          el('div', { text: `未注入 · ChatGPT 仍显示内置的官方模型，这里有 ${models.length} 个自建模型等着接入` }),
          el('div', { class: 'faint', text: '打开上面第三个节点的开关，gpt++ 会把模型目录写进 Codex 配置并指向本地网关' }),
        ]),
      ]);

  const warnBox = viewState.warn ? warningNote(ctx) : null;

  // ---- 默认模型 ----
  // store 里真正写进 Codex `model` 键的值；没设过就是空。
  const storedDefault = inject.defaultModel || '';
  // 下拉框只是「预选」：后端在注入时会自动取第一个启用的模型，这里保持一致，
  // 不能拿 models[0]（可能是停用模型）当默认值去标「当前默认」。
  const defaultModel =
    storedDefault || (models.find((m) => m.enabled !== false) || {}).slug || '';
  const select = modelPicker(ctx, models, defaultModel, setDefaultModel);

  const defaultCard = el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('zap', 14),
      el('span', { class: 'card-title', text: '默认模型' }),
      el('span', { class: 'card-desc', text: 'ChatGPT 新建对话时默认选中它' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'toolbar' }, [
        el('span', { class: 'grow', style: { 'max-width': '460px' } }, [select]),
        el('span', { class: 'chip chip-mono', title: '写入 Codex 配置的 model 键', text: storedDefault || '未设置' }),
      ]),
      el('details', { class: 'technical-details' }, [
        el('summary', { text: '配置说明' }),
        el('div', { class: 'hint', text: '写入 Codex 的 model 字段；客户端内手动选择的模型优先。' }),
      ]),
    ]),
  ]);

  // replaceChildren 会把 null 当成文本节点插入（渲染出字面量 "null"），这里显式过滤
  root.replaceChildren(...[wiring, warnBox, summary, defaultCard, modelTable(ctx, models, storedDefault)].filter(Boolean));
}

/**
 * 自绘默认模型选择器：保留原生选择器的键盘语义，但让展开面板跟随应用主题。
 * @param {{el:Function, icon:Function}} ctx 渲染上下文
 * @param {Array<{slug:string,label:string,providerName:string,enabled?:boolean}>} models 模型列表
 * @param {string} selectedSlug 当前模型 slug
 * @param {(ctx:any, slug:string) => Promise<void>} onChange 选中后的保存回调
 * @returns {HTMLElement}
 */
function modelPicker(ctx, models, selectedSlug, onChange) {
  const { el, icon } = ctx;
  const pickerId = 'default-model-options';
  const selectedIndex = Math.max(0, models.findIndex((model) => model.slug === selectedSlug));
  let activeIndex = selectedIndex;
  let open = false;

  const button = el('button', {
    class: 'model-picker-trigger',
    type: 'button',
    attrs: {
      role: 'combobox',
      'aria-label': '默认模型',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': pickerId,
    },
  });
  const value = el('span', { class: 'model-picker-value' });
  const valueLabel = el('strong', { class: 'model-picker-label' });
  const valueProvider = el('span', { class: 'model-picker-provider' });
  const chevron = el('span', { class: 'model-picker-chevron' }, [icon('chevronDown', 15)]);
  value.append(valueLabel, valueProvider);
  button.append(value, chevron);

  const menu = el('div', {
    class: 'model-picker-menu',
    id: pickerId,
    attrs: { role: 'listbox', 'aria-label': '可用模型' },
  });
  const wrapper = el('div', { class: 'model-picker' }, [button, menu]);

  function updateValue(index) {
    const model = models[index] || models[0] || {};
    valueLabel.textContent = model.label || model.slug || '未选择模型';
    valueProvider.textContent = model.providerName || '';
    button.setAttribute('aria-activedescendant', `${pickerId}-${index}`);
  }

  function updateActive(index) {
    activeIndex = Math.max(0, Math.min(models.length - 1, index));
    for (const option of menu.children) {
      const isActive = Number(option.dataset.index) === activeIndex;
      option.classList.toggle('is-active', isActive);
      if (isActive) option.scrollIntoView?.({ block: 'nearest' });
    }
    button.setAttribute('aria-activedescendant', `${pickerId}-${activeIndex}`);
  }

  function close() {
    if (!open) return;
    open = false;
    wrapper.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener?.('pointerdown', onDocumentPointerDown, true);
  }

  function choose(index) {
    const model = models[index];
    if (!model) return;
    close();
    button.focus();
    void onChange(ctx, model.slug);
  }

  function openMenu() {
    if (open || !models.length) return;
    open = true;
    wrapper.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    updateActive(selectedIndex);
    document.addEventListener?.('pointerdown', onDocumentPointerDown, true);
  }

  function onDocumentPointerDown(event) {
    if (!wrapper.contains?.(event.target)) close();
  }

  models.forEach((model, index) => {
    const option = el('button', {
      class: 'model-picker-option',
      type: 'button',
      id: `${pickerId}-${index}`,
      data: { index },
      attrs: { role: 'option', 'aria-selected': model.slug === selectedSlug ? 'true' : 'false' },
      on: {
        click: () => choose(index),
        pointerenter: () => updateActive(index),
      },
    }, [
      el('span', { class: 'model-picker-option-main' }, [
        el('span', { class: 'model-picker-option-label', text: model.label || model.slug }),
        el('span', { class: 'model-picker-option-provider', text: model.providerName || '未标记提供商' }),
      ]),
      model.enabled === false
        ? el('span', { class: 'model-picker-option-state', text: '已停用' })
        : el('span', {
            class: `model-picker-option-check${model.slug === selectedSlug ? ' is-selected' : ''}`,
          }, [icon('check', 14)]),
    ]);
    menu.appendChild(option);
  });

  button.addEventListener('click', () => (open ? close() : openMenu()));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      updateActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
      return;
    }
    if (event.key === 'Escape') close();
    if (event.key === 'Home' && open) {
      event.preventDefault();
      updateActive(0);
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      updateActive(models.length - 1);
    }
  });

  updateValue(selectedIndex);
  updateActive(selectedIndex);
  return wrapper;
}

function wireNode(ctx, { step, value, detail, tone }) {
  const { el } = ctx;
  return el('div', { class: 'wire-node' }, [
    el('div', { class: 'wire-eyebrow', text: step }),
    el('div', { class: 'wire-value' }, [
      el('span', { class: 'dot ' + (tone === 'on' ? 'dot-ok' : tone === 'warn' ? 'dot-warn' : 'dot-off') }),
      el('span', { class: 'wire-num ellipsis', text: value }),
    ]),
    el('div', { class: 'wire-detail ellipsis', title: detail, text: detail }),
  ]);
}

/** 第三个节点：ChatGPT 客户端 + 注入总开关 */
function injectNode(ctx, { inject, gateway, enabledModels }) {
  const { el } = ctx;
  const on = !!inject.enabled;
  const switchBtn = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    disabled: viewState.busy ? true : null,
    attrs: {
      'aria-checked': on ? 'true' : 'false',
      'aria-label': '注入到 ChatGPT 模型选择器',
      'aria-busy': viewState.busy ? 'true' : null,
    },
    on: { click: () => void toggleInject(ctx, !on) },
  });
  return el('div', { class: 'wire-node is-codex' + (on ? ' is-on' : '') }, [
    el('div', { class: 'wire-eyebrow', text: '3 · ChatGPT 客户端' }),
    el('div', { class: 'wire-value' }, [
      el('span', { class: 'dot ' + (on ? 'dot-warn' : 'dot-off') }),
      el('span', { class: 'ellipsis', text: on ? `已注入 ${enabledModels.length} 个模型` : '未注入' }),
      el('span', { class: 'right' }),
      switchBtn,
    ]),
    !on ? el('div', {
      class: 'wire-detail ellipsis',
      text: gateway.running
          ? '打开开关即可写入模型清单'
          : '需要先让本地网关运行起来',
    }) : null,
  ]);
}

function warningNote(ctx) {
  const { el, icon } = ctx;
  const warn = viewState.warn;
  const to = warn.action === 'settings' ? 'settings' : 'providers';
  return el('div', { class: 'note note-warn' }, [
    icon('alert', 15),
    el('div', { class: 'grow' }, [
      el('div', { text: warn.text }),
      el('div', { class: 'note-actions' }, [
        el('button', {
          class: 'btn btn-sm btn-warning',
          type: 'button',
          on: {
            click: () => {
              viewState.warn = null;
              ctx.navigate(to);
            },
          },
        }, [el('span', { text: to === 'settings' ? '去设置' : '去添加提供商' })]),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          on: {
            click: () => {
              viewState.warn = null;
              ctx.renderCurrent(true);
            },
          },
        }, [el('span', { text: '知道了' })]),
      ]),
    ]),
  ]);
}

function modelTable(ctx, models, defaultModel) {
  const { el, icon } = ctx;
  const rowsBox = el('div', { class: 'table' });
  const countLabel = el('span', { class: 'card-desc' });

  function refresh() {
    const visible = models.filter((m) => {
      if (viewState.onlyEnabled && !m.enabled) return false;
      if (!viewState.filter) return true;
      return (
        String(m.label || '').toLowerCase().includes(viewState.filter) ||
        String(m.slug || '').toLowerCase().includes(viewState.filter) ||
        String(m.modelId || '').toLowerCase().includes(viewState.filter) ||
        String(m.providerName || '').toLowerCase().includes(viewState.filter)
      );
    });
    countLabel.textContent = `显示 ${visible.length} / ${models.length} 个`;

    const head = el('div', { class: 'trow thead' }, [
      el('span', { text: '显示名' }),
      el('span', { text: '模型 ID', title: 'slug：写进 ChatGPT 的模型 ID' }),
      el('span', { text: '来源提供商' }),
      el('span', { text: '状态' }),
      el('span', { text: '推理' }),
      el('span', { text: '默认' }),
      el('span', { text: '操作' }),
    ]);

    const rows = visible.map((m, index) => {
      const isDefault = m.slug === defaultModel;
      const row = el('div', {
        class: 'trow tbody-row' + (m.enabled ? '' : ' is-off') + (isDefault ? ' is-default' : ''),
        data: { orderKey: m.orderKey || `${m.providerId}::${m.modelId}` },
      }, [
        el('div', { class: 'cell-label', title: m.label || m.modelId, text: m.label || m.modelId }),
        el('div', { class: 'cell-slug' }, [
          el('span', { class: 'slug-text', title: m.slug, text: m.slug }),
          el('button', {
            class: 'btn btn-icon',
            type: 'button',
            title: '复制 slug',
            attrs: { 'aria-label': '复制 slug' },
            on: { click: () => ctx.copyText(m.slug, ' slug') },
          }, [icon('copy', 12)]),
        ]),
        el('div', { class: 'cell-provider', title: m.providerName, text: m.providerName }),
        el('div', {}, [modelSwitch(ctx, m)]),
        el('div', {}, [
          m.remote ? el('span', { class: 'chip chip-codex', text: '远端' }) : null,
          m.isNew ? el('span', { class: 'chip chip-warn', text: '新增' }) : null,
          m.remote && !m.detected ? el('span', { class: 'chip chip-err', text: '未检测到' }) : null,
          m.remote && m.hidden ? el('span', { class: 'chip chip-warn', text: '本机已删除' }) : null,
          m.reasoning
            ? el('span', { class: 'chip chip-accent', text: '推理' })
            : !m.remote ? el('span', { class: 'faint', text: '—' }) : null,
        ]),
        el('div', {}, [
          isDefault
            ? el('span', { class: 'chip chip-accent', text: '当前默认' })
            : el('button', {
                class: 'btn btn-sm btn-accent',
                type: 'button',
                // 停用模型当默认会被后端静默换成别的 slug，界面提示与实际写入不符；
                // 这里直接不给按钮。
                disabled: viewState.busy || !m.enabled ? true : null,
                title: m.enabled ? '设为默认' : '该模型已停用，不能设为默认',
                on: { click: () => void setDefaultModel(ctx, m.slug) },
              }, [el('span', { text: '设为默认' })]),
        ]),
        el('div', { class: 'model-order-actions' }),
      ]);
      row.lastElementChild.append(
        remoteLabelButton(ctx, m),
        deleteModelButton(ctx, m),
        dragHandle(ctx, row, visible, index),
      );
      return row;
    });

    if (!rows.length) {
      rowsBox.replaceChildren(
        el('div', { class: 'log-empty' }, [
          el('div', { text: '没有匹配的模型' }),
          el('div', { class: 'faint', text: '清空搜索框，或取消「只看已启用」' }),
        ]),
      );
      return;
    }
    rowsBox.replaceChildren(head, ...rows);
    if (!viewState.filter && !viewState.onlyEnabled) {
      bindDragRows(ctx, rowsBox, visible, rows);
    }
  }

  const searchInput = el('input', {
    class: 'input',
    type: 'search',
    value: viewState.filter,
    placeholder: '搜索模型显示名、slug 或提供商',
    attrs: { spellcheck: 'false', 'aria-label': '搜索模型' },
    on: {
      input: (e) => {
        viewState.filter = e.target.value.trim().toLowerCase();
        refresh();
      },
    },
  });

  const onlyCheck = el('input', {
    type: 'checkbox',
    checked: viewState.onlyEnabled ? true : null,
    on: {
      change: (e) => {
        viewState.onlyEnabled = e.target.checked;
        refresh();
      },
    },
  });

  refresh();

  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('box', 14),
      el('span', { class: 'card-title', text: '全部模型' }),
      countLabel,
      el('span', { class: 'right' }),
      el('label', { class: 'check' }, [onlyCheck, el('span', { text: '只看已启用' })]),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'toolbar' }, [searchInput]),
      rowsBox,
      el('div', {
        class: 'hint',
        text: 'slug 形如 <渠道名>__<modelId>，网关按它反查上游提供商与真实模型名。按住任意模型行右侧把手拖动即可调序；状态开关、排序和删除会立即保存。',
      }),
    ]),
  ]);
}

function emptyState(ctx) {
  const { el, icon } = ctx;
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-glyph' }, [icon('box', 20)]),
    el('div', { class: 'empty-title', text: '还没有可注入的模型' }),
    el('div', {
      class: 'empty-text',
      text: '先添加一个提供商（Base URL + API Key），填上模型 ID 或点「从 /models 拉取」；保存后模型会出现在这里，再一键注入 ChatGPT 的模型选择器。',
    }),
    el('div', { class: 'empty-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        on: { click: () => ctx.openProviderForm(null) },
      }, [icon('plus', 13), el('span', { text: '添加提供商' })]),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        on: { click: () => ctx.navigate('providers') },
      }, [el('span', { text: '返回提供商列表' })]),
    ]),
  ]);
}

function modelSwitch(ctx, model) {
  const { el } = ctx;
  const available = model.providerEnabled !== false && model.hidden !== true;
  const on = model.enabled && available;
  return el('button', {
    class: 'model-switch switch-table',
    type: 'button',
    role: 'switch',
    disabled: viewState.busy || !available ? true : null,
    title: available ? (on ? '停用模型' : '启用模型') : '请先启用提供商',
    attrs: { 'aria-checked': on ? 'true' : 'false', 'aria-label': (on ? '停用' : '启用') + ' ' + (model.label || model.modelId) },
    on: { click: () => void toggleModel(ctx, model, !on) },
  });
}

function dragHandle(ctx, row, models, index) {
  const { el } = ctx;
  return el('button', {
    class: 'btn btn-icon model-drag-handle',
    type: 'button',
    disabled: viewState.busy || models.length < 2 ? true : null,
    title: '按住拖动调整模型顺序',
    attrs: { 'aria-label': `拖动第 ${index + 1} 个模型调整顺序`, 'tabindex': '-1' },
    on: {
      pointerdown: (event) => beginModelDrag(ctx, event, row),
    },
  }, [el('span', { class: 'drag-grip', text: '::' })]);
}

function deleteModelButton(ctx, model) {
  const { el, icon } = ctx;
  return el('button', {
    class: 'btn btn-icon ' + (model.remote && model.hidden ? 'btn-accent' : 'btn-danger') + ' model-delete',
    type: 'button',
    disabled: viewState.busy ? true : null,
    title: model.remote && model.hidden ? '恢复该远端模型' : '删除该模型',
    attrs: { 'aria-label': `删除模型 ${model.label || model.modelId}` },
    on: { click: () => confirmDeleteModel(ctx, model) },
  }, [icon(model.remote && model.hidden ? 'refresh' : 'trash', 13)]);
}

function remoteLabelButton(ctx, model) {
  if (!model.remote) return null;
  const { el, icon } = ctx;
  return el('button', { class: 'btn btn-icon', type: 'button', title: '修改远端模型显示名',
    attrs: { 'aria-label': '修改远端模型显示名' }, on: { click: () => void renameRemoteModel(ctx, model) } }, [icon('pencil', 12)]);
}

async function renameRemoteModel(ctx, model) {
  const next = window.prompt('远端模型显示名', model.label || model.modelId);
  if (!next || next.trim() === model.label) return;
  try {
    const status = await ctx.api.setRemoteModelLabel({ providerId: model.providerId, modelId: model.modelId, label: next.trim() });
    if (status && typeof status === 'object') ctx.state.status = status;
    ctx.toast('远端模型显示名已保存', 'ok');
    markRelaunchIfInjected(ctx);
    await ctx.reload('models', { preserveScrollTop: true });
  } catch (err) { ctx.toastError(err, '保存远端显示名失败'); }
}

/** 删除二次确认：说明会影响哪些地方，避免误删掉正在注入的模型。 */
function confirmDeleteModel(ctx, model) {
  const { el, icon, state } = ctx;
  const inject = state.inject || (state.status && state.status.inject) || {};
  const isDefault = inject.defaultModel === model.slug;
  const restoring = model.remote && model.hidden;
  const sameProvider = (state.models || []).filter((item) => item.providerId === model.providerId);
  const emptiesProvider = sameProvider.length <= 1;
  const modelKeyOf = (item) => item.orderKey || `${item.providerId}::${item.modelId}`;
  const lastEnabled = (state.models || []).every(
    (item) => !item.enabled || modelKeyOf(item) === modelKeyOf(model),
  );
  let confirmBtn = null;
  let busy = false;

  const details = [
    `「${model.label || model.modelId}」会从提供商「${model.providerName}」的模型列表中移除，其它模型不受影响。`,
    isDefault ? '它当前是默认模型，删除后默认值会自动落到下一个启用的模型。' : '',
    lastEnabled && inject.enabled
      ? '这是最后一个启用模型：删除后没有模型可注入，ChatGPT 会还原成官方模型。'
      : '',
    '删除后如果想恢复，需要在提供商页重新添加这个模型 ID。',
  ].filter(Boolean);
  if (model.remote) {
    details.splice(0, details.length,
      '「' + (model.label || model.modelId) + '」的处理只影响本机，远端共享端不会被修改。',
      '隐藏记录会保留；以后可恢复显示。同步不会自动重新添加你在本机隐藏的模型。',
    );
  }

  const run = async () => {
    if (busy) return;
    busy = true;
    viewState.busy = true;
    confirmBtn.disabled = true;
    confirmBtn.classList.add('is-busy');
    confirmBtn.lastElementChild.textContent = '删除中…';
    try {
      const wasInjected = !!inject.enabled;
      const status = model.remote && model.hidden
        ? await ctx.api.restoreRemoteModel({ providerId: model.providerId, modelId: model.modelId })
        : model.remote
          ? await ctx.api.deleteRemoteModel({ providerId: model.providerId, modelId: model.modelId })
        : await ctx.api.deleteModel({ providerId: model.providerId, modelId: model.modelId });
      if (status && typeof status === 'object') {
        ctx.state.status = status;
        if (status.inject) ctx.state.inject = { ...(ctx.state.inject || {}), ...status.inject };
      }
      const injectionDropped = wasInjected && status && status.inject && !status.inject.enabled;
      ctx.closeModal();
      // 注入开启时，目录和 Codex 配置都刚被改写（或已被还原），都要重启客户端才生效。
      if (wasInjected) ctx.markRelaunchNeeded?.();
      const name = model.label || model.modelId;
      if (model.remote && model.hidden) {
        ctx.toast('已恢复远端模型「' + name + '」，仍保持停用', 'ok');
      } else if (model.remote) {
        ctx.toast('已在本机隐藏远端模型「' + name + '」', 'warn');
      } else if (injectionDropped) {
        ctx.toast(`已删除模型「${name}」，没有剩余启用模型，已还原 ChatGPT 官方模型`, 'warn');
      } else {
        ctx.toast(`已删除模型「${name}」`, 'ok');
      }
    } catch (err) {
      ctx.toastError(err, '删除模型失败');
    } finally {
      busy = false;
      viewState.busy = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('is-busy');
        confirmBtn.lastElementChild.textContent = '删除模型';
      }
      await ctx.reload('models', { preserveScrollTop: true });
    }
  };

  confirmBtn = el('button', {
    class: 'btn btn-danger',
    type: 'button',
    on: { click: () => void run() },
  }, [icon('trash', 13), el('span', { text: '删除模型' })]);

  const modal = el('section', {
    class: 'modal model-delete-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除模型' },
  }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'grow' }, [
        el('h2', { text: '删除模型' }),
        el('div', { class: 'modal-sub', text: `${model.providerName || '提供商'} · ${model.modelId}` }),
      ]),
      el('button', {
        class: 'btn btn-icon',
        type: 'button',
        title: '关闭',
        attrs: { 'aria-label': '关闭' },
        on: { click: () => ctx.closeModal() },
      }, [icon('x', 15)]),
    ]),
    el('div', { class: 'modal-body' }, [
      el('div', { class: 'note note-warn' }, [
        icon('alert', 14),
        el('div', {
          class: 'grow',
          text: lastEnabled && inject.enabled ? '这是最后一个启用模型，删除后注入会自动关闭' : '删除后不可恢复',
        }),
      ]),
      el('div', { class: 'model-delete-reasons' }, details.map((text) => el('div', { class: 'hint', text }))),
    ]),
    el('div', { class: 'modal-foot' }, [
      el('span', { class: 'hint', text: emptiesProvider ? '该提供商的模型列表将被清空' : '其它模型和提供商设置不受影响' }),
      el('span', { class: 'right' }),
      el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => ctx.closeModal() } }, [
        el('span', { text: '取消' }),
      ]),
      confirmBtn,
    ]),
  ]);
  ctx.openModal(modal);
}

/** 计算拖动项插入目标位置后的完整顺序。 */
export function reorderModelKeys(keys, fromIndex, toIndex) {
  const next = Array.isArray(keys) ? keys.slice() : [];
  if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) return next;
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function bindDragRows(ctx, rowsBox, models, rows) {
  rows.forEach((row) => {
    row.addEventListener('pointerdown', (event) => {
      if (event.target && event.target.closest && event.target.closest('button')) return;
      beginModelDrag(ctx, event, row);
    });
  });
}

function beginModelDrag(ctx, event, row) {
  if (event.button !== undefined && event.button !== 0) return;
  const rowsBox = row.parentNode;
  if (dragState.row) {
    // 上一次拖拽没有正常收尾时（页面重绘、窗口失焦、指针丢事件），状态会一直停在旧行上。
    // 旧行还属于当前这张表就说明拖拽真的在进行，否则必须清掉——否则之后每次按下都会
    // 在第一道检查处被静默忽略，表现为“怎么拖都不换位置且没有任何提示”。
    if (rowsBox && dragState.rowsBox === rowsBox && dragState.row.isConnected !== false) return;
    cancelModelDrag();
  }
  if (viewState.busy || !rowsBox) return;
  const rows = Array.from(rowsBox.children).filter((child) => child.classList.contains('tbody-row'));
  const startIndex = rows.indexOf(row);
  if (startIndex < 0 || rows.length < 2) return;
  const rect = row.getBoundingClientRect();
  dragState.row = row;
  dragState.rowsBox = rowsBox;
  dragState.rows = rows;
  dragState.startIndex = startIndex;
  dragState.targetIndex = startIndex;
  dragState.startY = event.clientY;
  dragState.lastY = event.clientY;
  dragState.rowHeight = rect.height || row.offsetHeight || 1;
  dragState.rowTops = rows.map((item) => item.getBoundingClientRect().top);
  dragState.grabOffsetY = event.clientY - rect.top;
  dragState.pointerId = event.pointerId ?? null;
  dragState.finish = (finishEvent) => finishModelDrag(ctx, rowsBox, finishEvent);
  dragState.onBlur = () => cancelModelDrag();
  row.classList.add('is-dragging');
  row.setPointerCapture?.(event.pointerId);
  rowsBox.classList.add('is-dragging-list');
  rowsBox.addEventListener('pointermove', onModelDragMove);
  rowsBox.addEventListener('pointerup', dragState.finish);
  rowsBox.addEventListener('pointercancel', dragState.finish);
  // 指针在表格外松开、或窗口在拖拽中失焦时，rowsBox 收不到 pointerup。
  // 窗口级监听保证拖拽一定能收尾，不会把状态永久卡住。
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pointermove', onModelDragMove, true);
    window.addEventListener('pointerup', dragState.finish, true);
    window.addEventListener('pointercancel', dragState.finish, true);
    window.addEventListener('blur', dragState.onBlur);
  }
  event.preventDefault?.();
}

/** 摘掉拖拽期间挂在列表和窗口上的监听。 */
function removeDragListeners() {
  const rowsBox = dragState.rowsBox;
  if (rowsBox) {
    rowsBox.removeEventListener('pointermove', onModelDragMove);
    rowsBox.removeEventListener('pointerup', dragState.finish);
    rowsBox.removeEventListener('pointercancel', dragState.finish);
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener?.('pointermove', onModelDragMove, true);
    window.removeEventListener?.('pointerup', dragState.finish, true);
    window.removeEventListener?.('pointercancel', dragState.finish, true);
    window.removeEventListener?.('blur', dragState.onBlur);
    if (dragState.moveFrame) window.cancelAnimationFrame?.(dragState.moveFrame);
  }
  dragState.moveFrame = 0;
}

/** 放弃当前拖拽：撤销位移、摘掉监听，不写入顺序。 */
function cancelModelDrag() {
  const rows = Array.isArray(dragState.rows) ? dragState.rows : [];
  removeDragListeners();
  if (dragState.rowsBox) dragState.rowsBox.classList.remove('is-dragging-list');
  rows.forEach((row) => {
    row.classList.remove('is-dragging');
    row.style.setProperty('transform', 'none');
  });
  resetDragState();
}

/** 只复位模块状态，不动 DOM：保存成功后由 finishModelDrag 复用。 */
function resetDragState() {
  dragState.row = null;
  dragState.rowsBox = null;
  dragState.rows = [];
  dragState.rowTops = [];
  dragState.startIndex = -1;
  dragState.targetIndex = -1;
  dragState.pointerId = null;
  dragState.finish = null;
  dragState.onBlur = null;
}

function onModelDragMove(event) {
  if (!dragState.row || dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
  dragState.lastY = event.clientY;
  scheduleDragFrame();
  event.preventDefault?.();
}

function scheduleDragFrame(ctx) {
  if (!dragState.row || dragState.moveFrame) return;
  const raf = typeof window !== 'undefined' && window.requestAnimationFrame;
  if (typeof raf === 'function') {
    dragState.moveFrame = raf(() => {
      dragState.moveFrame = 0;
      updateDragVisual(ctx);
    });
  } else {
    updateDragVisual(ctx);
  }
}

function updateDragVisual(ctx) {
  if (!dragState.row) return;
  const rows = dragState.rows;
  const draggedY = dragState.lastY - dragState.startY;
  const targetIndex = dragTargetIndex(
    dragState.rowTops,
    dragState.startIndex,
    dragState.rowHeight,
    dragState.lastY,
    dragState.grabOffsetY,
  );
  // 让位与提交共用同一个 targetIndex，并且按整格位移：预览里看到的顺序就是
  // 松手后写入的顺序，不会再出现“看着已经换位、松手却弹回原位”。
  const rowOffsets = dragRowOffsets(
    dragState.rowTops,
    dragState.startIndex,
    targetIndex,
    dragState.rowHeight,
  );
  dragState.targetIndex = targetIndex;
  rows.forEach((row, index) => {
    if (index === dragState.startIndex) {
      row.style.setProperty('transform', `translateY(${draggedY}px)`);
      return;
    }
    const offset = rowOffsets[index] || 0;
    row.style.setProperty('transform', offset ? `translateY(${offset}px)` : 'none');
  });
}

/** 预览位移：被拖行已经越过的格子整格让位，保证预览顺序 == 提交顺序。 */
export function dragRowOffsets(rowTops, startIndex, targetIndex, rowHeight) {
  if (!Array.isArray(rowTops) || !rowTops.length || rowHeight <= 0) return [];
  if (startIndex < 0 || startIndex >= rowTops.length) return rowTops.map(() => 0);

  const offsets = rowTops.map(() => 0);
  if (targetIndex > startIndex) {
    for (let index = startIndex + 1; index <= targetIndex && index < rowTops.length; index += 1) {
      offsets[index] = -rowHeight;
    }
  } else if (targetIndex >= 0 && targetIndex < startIndex) {
    for (let index = targetIndex; index < startIndex; index += 1) {
      offsets[index] = rowHeight;
    }
  }
  return offsets;
}

/** 被拖行中心越过相邻格边界时换位（拖半行就换一格），正反方向使用同一条边界。 */
export function dragTargetIndex(rowTops, startIndex, rowHeight, pointerY, grabOffsetY) {
  if (!Array.isArray(rowTops) || !rowTops.length || rowHeight <= 0) return startIndex;
  if (startIndex < 0 || startIndex >= rowTops.length) return startIndex;

  const draggedCenter = pointerY - grabOffsetY + rowHeight / 2;
  let naturalIndex = startIndex;
  if (draggedCenter > rowTops[startIndex]) {
    // 向下：中心越过下一格的上边界，就算进入下一格
    for (let index = startIndex + 1; index < rowTops.length; index += 1) {
      if (draggedCenter <= rowTops[index]) break;
      naturalIndex = index;
    }
  } else if (draggedCenter < rowTops[startIndex]) {
    // 向上：中心越过上一格的下边界，就算进入上一格
    for (let index = startIndex - 1; index >= 0; index -= 1) {
      if (draggedCenter >= rowTops[index] + rowHeight) break;
      naturalIndex = index;
    }
  }

  return naturalIndex;
}

async function finishModelDrag(ctx, rowsBox, event) {
  if (!dragState.row || dragState.pointerId !== null && event?.pointerId !== dragState.pointerId) return;
  if (Number.isFinite(event?.clientY)) {
    // 松手可能发生在最后一个 requestAnimationFrame 之前，先同步目标位置再提交。
    dragState.lastY = event.clientY;
    updateDragVisual(ctx);
  }
  const rows = dragState.rows;
  const fromIndex = dragState.startIndex;
  const toIndex = dragState.targetIndex;
  const draggedRow = dragState.row;
  const orderKeys = rows.map((row) => row.dataset.orderKey).filter(Boolean);
  const nextKeys = reorderModelKeys(orderKeys, fromIndex, toIndex);
  const firstRects = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
  const movedRows = reorderModelRows(rowsBox, rows, fromIndex, toIndex);
  removeDragListeners();
  resetDragState();
  if (fromIndex === toIndex || !nextKeys.length) {
    rowsBox.classList.remove('is-dragging-list');
    rows.forEach((row) => {
      row.classList.remove('is-dragging');
      row.style.setProperty('transform', 'none');
    });
    return;
  }
  animateRowsToFinalPosition(rowsBox, firstRects, movedRows);
  viewState.busy = true;
  let saved = false;
  try {
    const status = await ctx.api.reorderModels({ orderKeys: nextKeys });
    applyModelOrderToState(ctx, nextKeys);
    if (status && typeof status === 'object') ctx.state.status = status;
    markRelaunchIfInjected(ctx);
    saved = true;
  } catch (err) {
    ctx.toastError(err, '调整模型顺序失败');
  } finally {
    viewState.busy = false;
    if (!saved) await ctx.reload('models', { preserveScrollTop: true });
  }
  void draggedRow;
}

/** 保存成功后只同步内存顺序，避免重建整页导致松手瞬间闪烁。 */
function applyModelOrderToState(ctx, orderKeys) {
  const models = Array.isArray(ctx.state.models) ? ctx.state.models : [];
  const byKey = new Map(models.map((model) => [
    model.orderKey || `${model.providerId}::${model.modelId}`,
    model,
  ]));
  const ordered = [];
  for (const key of orderKeys) {
    const model = byKey.get(key);
    if (!model) continue;
    ordered.push(model);
    byKey.delete(key);
  }
  ctx.state.models = [...ordered, ...byKey.values()];
}

function reorderModelRows(rowsBox, currentRows, fromIndex, toIndex) {
  const rows = currentRows.slice();
  const [moved] = rows.splice(fromIndex, 1);
  rows.splice(toIndex, 0, moved);
  // 直接按最终顺序追加已有节点，保留表头，同时避免 insertBefore 链在不同 DOM 实现中失去顺序。
  rowsBox.append(...rows);
  return rows;
}

function animateRowsToFinalPosition(rowsBox, firstRects, movedRows) {
  rowsBox.classList.add('is-dragging-list');
  movedRows.forEach((row) => {
    row.classList.remove('is-dragging');
    // 先关掉过渡再归零：拖拽期间非拖动行带让位过渡，否则这里量到的 lastRects 会落在动画中途。
    row.style.setProperty('transition', 'none');
    row.style.setProperty('transform', 'none');
  });
  const lastRects = new Map(movedRows.map((row) => [row, row.getBoundingClientRect()]));
  movedRows.forEach((row) => {
    const first = firstRects.get(row);
    const last = lastRects.get(row);
    if (!first || !last) return;
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (!dx && !dy) return;
    row.style.setProperty('transition', 'none');
    row.style.setProperty('transform', `translate(${dx}px, ${dy}px)`);
  });
  const raf = typeof window !== 'undefined' && window.requestAnimationFrame;
  const play = () => {
    movedRows.forEach((row) => {
      row.style.setProperty('transition', 'transform var(--dur-2) var(--ease-out)');
      row.style.setProperty('transform', 'none');
    });
    window.setTimeout(() => {
      rowsBox.classList.remove('is-dragging-list');
      movedRows.forEach((row) => row.style.removeProperty('transition'));
    }, 200);
  };
  if (typeof raf === 'function') raf(play);
  else play();
}

// ============ 动作 ============
async function toggleInject(ctx, next) {
  if (viewState.busy) return;
  const models = ctx.state.models || [];
  const gateway = ctx.state.gateway || (ctx.state.status && ctx.state.status.gateway) || {};

  // 先给出清晰指引，而不是让主进程抛错
  if (next) {
    if (!models.some((model) => model.enabled !== false)) {
      viewState.warn = {
        text: '没有已启用的模型：请在「提供商」页至少启用一个提供商和模型。',
        action: 'providers',
      };
      ctx.renderCurrent(true);
      ctx.toast('没有已启用的模型', 'warn');
      return;
    }
    if (!gateway.enabled) {
      viewState.warn = {
        text: '本地网关没有启用：ChatGPT 需要通过网关访问你的模型，所以注入会被拒绝。请先到设置页打开网关开关。',
        action: 'settings',
      };
      ctx.renderCurrent(true);
      ctx.toast('请先启用本地网关', 'warn');
      return;
    }
    if (!gateway.running) {
      viewState.warn = {
        text: `本地网关已启用但没有在运行（端口 ${gateway.port || '未知'}），注入前需要它先跑起来。到设置页点「启动网关」，或重启 gpt++。`,
        action: 'settings',
      };
      ctx.renderCurrent(true);
      ctx.toast('本地网关未运行', 'warn');
      return;
    }
  }

  viewState.warn = null;
  viewState.busy = true;
  try {
    const status = await ctx.api.setInject({ enabled: next });
    ctx.state.status = status;
    ctx.markRelaunchNeeded?.();
    const n = models.filter((m) => m.enabled).length;
    const msg = next
      ? `已注入 ${n} 个模型，重启 ChatGPT 客户端后可在模型选择器中看到`
      : '已还原：Codex 配置里的自定义模型清单已移除，ChatGPT 回到官方模型';
    ctx.toast(msg, next ? 'ok' : 'warn');
    ctx.logLocal(next ? 'info' : 'warn', msg);
  } catch (err) {
    viewState.warn = { text: `注入失败：${ctx.describeError(err)}`, action: 'settings' };
    ctx.toastError(err, '注入失败');
  } finally {
    viewState.busy = false;
    await ctx.reload('models');
  }
}

async function toggleModel(ctx, model, enabled) {
  if (viewState.busy || !model.orderKey) return;
  viewState.busy = true;
  try {
    const status = model.remote
      ? await ctx.api.setRemoteModelEnabled({ providerId: model.providerId, modelId: model.modelId, enabled })
      : await ctx.api.setModelEnabled({ providerId: model.providerId, modelId: model.modelId, enabled });
    ctx.state.status = status;
    markRelaunchIfInjected(ctx);
    ctx.toast((enabled ? '已启用' : '已停用') + '模型「' + (model.label || model.modelId) + '」', 'ok');
  } catch (err) {
    ctx.toastError(err, '修改模型状态失败');
  } finally {
    viewState.busy = false;
    await ctx.reload('models');
  }
}

async function moveModel(ctx, model, direction) {
  if (viewState.busy || !model.orderKey) return;
  viewState.busy = true;
  try {
    await ctx.api.moveModel({ providerId: model.providerId, modelId: model.modelId, direction });
    markRelaunchIfInjected(ctx);
  } catch (err) {
    ctx.toastError(err, '调整模型顺序失败');
  } finally {
    viewState.busy = false;
    await ctx.reload('models');
  }
}

async function setDefaultModel(ctx, slug) {
  if (!slug || viewState.busy) return;
  viewState.busy = true;
  try {
    const status = await ctx.api.setInject({ defaultModel: slug });
    ctx.state.status = status;
    markRelaunchIfInjected(ctx);
    const model = (ctx.state.models || []).find((m) => m.slug === slug);
    // 后端会把「已停用/不存在」的 slug 回退成第一个启用模型；
    // 提示必须按实际写进去的值说，不能照着用户点的值报平安。
    const applied = (status && status.inject && status.inject.defaultModel) || null;
    if (applied !== slug) {
      ctx.toast(
        applied
          ? `该模型当前不可为默认，已改为「${labelOf(ctx, applied)}」`
          : '默认模型未更改（注入时会自动取第一个启用的模型）',
        'warn',
      );
      ctx.logLocal('warn', `默认模型未落在 ${slug}，实际为 ${applied || '（空）'}`);
    } else {
      ctx.toast(`默认模型已设为「${model ? model.label : slug}」`, 'ok');
      ctx.logLocal('info', `默认模型：${slug}`);
    }
  } catch (err) {
    ctx.toastError(err, '设置默认模型失败');
  } finally {
    viewState.busy = false;
    await ctx.reload('models');
  }
}

/** 模型状态、排序或默认值变化会影响已写入的客户端目录。 */
function markRelaunchIfInjected(ctx) {
  const inject = ctx.state.inject || (ctx.state.status && ctx.state.status.inject);
  if (inject && inject.enabled) ctx.markRelaunchNeeded?.();
}

function labelOf(ctx, slug) {
  const m = (ctx.state.models || []).find((item) => item.slug === slug);
  return m ? m.label : slug;
}

async function openCodexFolder(ctx) {
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
