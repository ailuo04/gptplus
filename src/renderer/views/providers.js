// 提供商页：卡片列表 + 编辑表单（含动态模型行、从 /models 拉取）。
//
// 安全：所有用户/接口字符串都经 textContent（el 的 text）或 setAttribute 进入 DOM。

const API_LABELS = { openai: 'OpenAI 兼容', responses: 'Responses 透传', anthropic: 'Anthropic' };
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

// 视图级临时状态（跨重渲染保留）
const viewState = {
  testing: {},
  probe: {},
  revealed: {},
  toggling: {},
  selected: {},
};

let providerDropGuardInstalled = false;
let providerDropContext = null;
let providerDropDepth = 0;
let providerDropOverlay = null;

function createProviderDropOverlay(ctx) {
  if (providerDropOverlay || typeof document === 'undefined' || !document.body) return;
  const { el, icon } = ctx;
  providerDropOverlay = el('div', {
    class: 'provider-file-drop-overlay',
    attrs: { 'aria-hidden': 'true' },
  }, [
    el('div', { class: 'provider-file-drop-card' }, [
      el('div', { class: 'provider-file-drop-icon' }, [icon('box', 19)]),
      el('div', { class: 'provider-file-drop-title', text: '松开鼠标即可导入' }),
      el('div', { class: 'provider-file-drop-hint', text: 'gpt++ 会检查文件并展示导入预览' }),
    ]),
  ]);
  providerDropOverlay.hidden = true;
  document.body.appendChild(providerDropOverlay);
}

function setProviderDropVisual(active) {
  if (typeof document === 'undefined') return;
  if (providerDropOverlay) providerDropOverlay.hidden = !active;
}

function clearProviderDropVisual() {
  providerDropDepth = 0;
  setProviderDropVisual(false);
}

export function installProviderDropGuard(ctx) {
  providerDropContext = ctx;
  createProviderDropOverlay(ctx);
  if (providerDropGuardInstalled || typeof window === 'undefined') return;
  const isFileTransfer = (event) => {
    const transfer = event.dataTransfer;
    return !!transfer && (Array.from(transfer.types || []).includes('Files') || transfer.files?.length);
  };
  const handleDragEnter = (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    providerDropDepth += 1;
    setProviderDropVisual(true);
  };
  const guard = (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    providerDropDepth = Math.max(0, providerDropDepth - 1);
    if (!providerDropDepth) setProviderDropVisual(false);
  };
  const handleDrop = (event) => {
    if (!isFileTransfer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearProviderDropVisual();
    const files = event.dataTransfer?.files;
    if (files?.length && providerDropContext) void openImportDialog(providerDropContext, files);
  };
  window.addEventListener('dragenter', handleDragEnter);
  window.addEventListener('dragover', guard);
  window.addEventListener('dragleave', handleDragLeave);
  window.addEventListener('drop', handleDrop);
  window.addEventListener('dragend', clearProviderDropVisual);
  providerDropGuardInstalled = true;
}

/**
 * 渲染提供商页。
 * @param {HTMLElement} root 内容容器
 * @param {any} ctx app.js 提供的上下文
 * @param {HTMLElement} actions 标题栏右侧动作槽
 */
export function renderProviders(root, ctx, actions) {
  const { el, icon, state } = ctx;
  installProviderDropGuard(ctx);
  const providers = state.providers || [];
  const providerIds = new Set(providers.map((provider) => provider.id));
  for (const id of Object.keys(viewState.selected)) {
    if (!providerIds.has(id)) delete viewState.selected[id];
  }

  // ---- 标题栏动作 ----
  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.reload('providers') },
    }, [icon('refresh', 13), el('span', { text: '刷新' })]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => openImportDialog(ctx) },
    }, [icon('folder', 13), el('span', { text: '导入配置' })]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => openExportDialog(ctx, null) },
    }, [icon('download', 13), el('span', { text: '导出全部' })]),
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      on: { click: () => openProviderForm(ctx, null) },
    }, [icon('plus', 13), el('span', { text: '添加提供商' })]),
  );

  if (!providers.length) {
    root.replaceChildren(transferZone(ctx), emptyState(ctx));
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
    el('button', {
      class: 'btn btn-sm btn-accent',
      type: 'button',
      disabled: selectedProviderIds().length ? null : true,
      title: '导出勾选的提供商配置',
      on: { click: () => openExportDialog(ctx, selectedProviderIds()) },
    }, [icon('download', 13), el('span', { text: `导出选中（${selectedProviderIds().length}）` })]),
  ]);

  const grid = el('div', { class: 'grid' }, providers.map((p) => providerCard(ctx, p)));
  root.replaceChildren(transferZone(ctx), quota, grid);
}

function selectedProviderIds() {
  return Object.entries(viewState.selected)
    .filter(([, selected]) => selected)
    .map(([id]) => id);
}

function transferZone(ctx) {
  const { el, icon } = ctx;
  const zone = el('section', {
    class: 'provider-transfer-zone',
    attrs: { 'aria-label': '提供商配置导入区' },
    on: {
      dragenter: (event) => {
        event.preventDefault();
        zone.classList.add('is-dragover');
      },
      dragover: (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        zone.classList.add('is-dragover');
      },
      dragleave: (event) => {
        if (!event.relatedTarget || !zone.contains?.(event.relatedTarget)) zone.classList.remove('is-dragover');
      },
      drop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearProviderDropVisual();
        zone.classList.remove('is-dragover');
        void openImportDialog(ctx, event.dataTransfer?.files);
      },
    },
  }, [
    el('div', { class: 'provider-transfer-zone-icon' }, [icon('box', 17)]),
    el('div', { class: 'grow' }, [
      el('div', { class: 'provider-transfer-zone-title', text: '将便携加密配置文件拖入窗口任意位置即可导入' }),
      el('div', { class: 'hint', text: '也可点击选择文件；完整配置由应用内解密后写入本机配置' }),
    ]),
    el('button', {
      class: 'btn btn-sm btn-ghost',
      type: 'button',
      on: { click: () => openImportDialog(ctx) },
    }, [icon('folder', 13), el('span', { text: '选择文件' })]),
  ]);
  return zone;
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
        on: { click: () => openImportDialog(ctx) },
      }, [icon('folder', 13), el('span', { text: '导入便携加密配置' })]),
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
  const selected = !!viewState.selected[p.id];

  // 名称 + Base URL
  const head = el('div', { class: 'pcard-top' }, [
    el('label', {
      class: 'provider-select',
      title: '选择该提供商用于导出',
    }, [
      el('input', {
        type: 'checkbox',
        checked: selected ? true : null,
        attrs: { 'aria-label': `选择提供商 ${p.name || '未命名'}` },
        on: {
          change: (event) => {
            viewState.selected[p.id] = !!event.target.checked;
            ctx.renderCurrent(true, { preserveScrollTop: true });
          },
        },
      }),
      el('span', { class: 'provider-select-mark', 'aria-hidden': 'true' }),
    ]),
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
  const foot = el('div', { class: 'pcard-foot' }, [
    el('button', {
      class: 'btn btn-sm btn-success' + (viewState.testing[p.id] ? ' is-busy' : ''),
      type: 'button',
      disabled: viewState.testing[p.id] ? true : null,
      title: models.length ? '选择要测试的模型，并逐个检查实际生成请求' : '请求该提供商的 /models 检查接口连通性',
      on: { click: () => (models.length ? openModelTestDialog(ctx, p) : testProvider(ctx, p)) },
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
      attrs: { 'aria-label': `删除提供商 ${p.name}` },
      on: { click: () => confirmDeleteProvider(ctx, p) },
    }, [icon('trash', 13)]),
  ]);
  if (probe) {
    foot.append(probeResult(ctx, p, probe));
  }

  return el('article', { class: 'card pcard' + (isOn ? '' : ' is-off') }, [
    head,
    chips,
    kv,
    modelMini,
    foot,
  ]);
}

function importErrorText(ctx, err, fallback = '导入失败') {
  const message = ctx.describeError(err, fallback);
  return message || fallback;
}

function fileBytes(file) {
  if (!file) return Promise.reject(new Error('没有选择文件'));
  const declaredSize = Number(file.size);
  if (Number.isFinite(declaredSize)) {
    if (declaredSize === 0) return Promise.reject(new Error('便携加密配置文件为空'));
    if (declaredSize > MAX_IMPORT_FILE_BYTES) return Promise.reject(new Error('便携加密配置文件超过大小限制'));
  }
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      if (bytes.length === 0) throw new Error('便携加密配置文件为空');
      if (bytes.length > MAX_IMPORT_FILE_BYTES) throw new Error('便携加密配置文件超过大小限制');
      return bytes;
    });
  }
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取配置文件失败'));
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        if (bytes.length === 0) {
          reject(new Error('便携加密配置文件为空'));
          return;
        }
        if (bytes.length > MAX_IMPORT_FILE_BYTES) {
          reject(new Error('便携加密配置文件超过大小限制'));
          return;
        }
        resolve(bytes);
      };
      reader.readAsArrayBuffer(file);
    });
  }
  return Promise.reject(new Error('当前环境无法读取配置文件'));
}

function importSourceFromFile(file) {
  if (!String(file?.name || '').toLowerCase().endsWith('.gptplus-providers')) {
    return Promise.reject(new Error('请选择 .gptplus-providers 便携加密配置文件'));
  }
  return fileBytes(file).then((bytes) => ({
    fileName: String(file.name || ''),
    bytes,
  }));
}

function openExportDialog(ctx, initialIds = null) {
  const { el, icon } = ctx;
  const providers = Array.isArray(ctx.state.providers) ? ctx.state.providers : [];
  const available = new Set(providers.map((provider) => provider.id));
  const selected = new Set(
    initialIds === null
      ? providers.map((provider) => provider.id)
      : (Array.isArray(initialIds) ? initialIds : []).filter((id) => available.has(id)),
  );
  let busy = false;

  const noteBox = el('div');
  const selectionSummary = el('span', { class: 'faint' });
  const providerList = el('div', { class: 'provider-transfer-list' });
  const exportBtn = el('button', { class: 'btn btn-primary', type: 'button' }, [
    icon('download', 13),
    el('span', { text: '导出配置文件' }),
  ]);

  function setNote(kind, text) {
    if (!text) {
      noteBox.replaceChildren();
      return;
    }
    noteBox.replaceChildren(el('div', { class: `note note-${kind}` }, [
      icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'info', 14),
      el('div', { class: 'grow', text }),
    ]));
  }

  function updateControls() {
    selectionSummary.textContent = `已选择 ${selected.size}/${providers.length} 个提供商`;
    exportBtn.disabled = busy || (!providers.length ? false : selected.size === 0);
    if (busy) exportBtn.classList.add('is-busy');
    else exportBtn.classList.remove('is-busy');
  }

  for (const provider of providers) {
    const checkbox = el('input', {
      type: 'checkbox',
      checked: selected.has(provider.id) ? true : null,
      attrs: { 'aria-label': `导出提供商 ${provider.name || '未命名'}` },
      on: {
        change: (event) => {
          if (event.target.checked) selected.add(provider.id);
          else selected.delete(provider.id);
          updateControls();
        },
      },
    });
    providerList.appendChild(el('label', { class: 'provider-transfer-row' }, [
      checkbox,
      el('span', { class: 'provider-transfer-row-main' }, [
        el('span', { class: 'provider-transfer-row-name', text: provider.name || '未命名提供商' }),
        el('span', { class: 'provider-transfer-row-meta', text: `${(provider.models || []).length} 个模型 · ${provider.enabled === false ? '已停用' : '已启用'}` }),
      ]),
    ]));
  }

  const body = el('div', { class: 'modal-body' }, [
    noteBox,
    el('div', { class: 'provider-transfer-section' }, [
      el('div', { class: 'modal-sect-head' }, [
        el('span', { class: 'modal-sect-title', text: '导出范围' }),
        selectionSummary,
        el('span', { class: 'right' }),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          on: { click: () => { for (const provider of providers) selected.add(provider.id); for (const input of providerList.querySelectorAll('input')) input.checked = true; updateControls(); } },
        }, [el('span', { text: '全选' })]),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          on: { click: () => { selected.clear(); for (const input of providerList.querySelectorAll('input')) input.checked = false; updateControls(); } },
        }, [el('span', { text: '清空' })]),
      ]),
      providerList,
    ]),
    el('div', { class: 'note note-warn' }, [
      icon('alert', 14),
      el('div', { class: 'grow', text: '文件外层保持可读取的 JSON，完整配置由应用内置密钥加密，不需要文件密码，可在安装同版本 gpt++ 的其他电脑导入。' }),
    ]),
  ]);

  async function runExport() {
    if (busy) return;
    if (!providers.length && initialIds !== null) {
      setNote('warn', '没有选中的提供商');
      return;
    }
    if (providers.length && selected.size === 0) {
      setNote('warn', '请至少选择一个提供商');
      return;
    }
    busy = true;
    exportBtn.disabled = true;
    exportBtn.classList.add('is-busy');
    exportBtn.lastElementChild.textContent = '导出中…';
    try {
      const providerIds = selected.size === providers.length ? null : [...selected];
      const result = await ctx.api.exportProviderConfig({
        providerIds,
      });
      if (result && result.canceled) return;
      ctx.closeModal();
      ctx.toast(`已导出 ${result?.count || 0} 个提供商的配置`, 'ok');
      ctx.logLocal('info', `提供商配置已导出（${result?.count || 0} 个）`);
    } catch (err) {
      setNote('warn', importErrorText(ctx, err, '导出失败'));
      ctx.toastError(err, '导出失败');
    } finally {
      busy = false;
      exportBtn.disabled = false;
      exportBtn.classList.remove('is-busy');
      exportBtn.lastElementChild.textContent = '导出配置文件';
      updateControls();
    }
  }

  exportBtn.addEventListener('click', () => void runExport());
  const modal = el('section', {
    class: 'modal provider-transfer-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '导出提供商配置' },
  }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'grow' }, [
        el('h2', { text: '导出提供商配置' }),
        el('div', { class: 'modal-sub', text: '完整配置使用应用内置密钥加密，不额外设置文件密码' }),
      ]),
      el('button', { class: 'btn btn-icon', type: 'button', title: '关闭', attrs: { 'aria-label': '关闭' }, on: { click: () => ctx.closeModal() } }, [icon('x', 15)]),
    ]),
    body,
    el('div', { class: 'modal-foot' }, [
      el('span', { class: 'hint', text: '取消导出不会修改现有配置' }),
      el('span', { class: 'right' }),
      el('button', { class: 'btn btn-ghost', type: 'button', disabled: busy ? true : null, on: { click: () => ctx.closeModal() } }, [el('span', { text: '取消' })]),
      exportBtn,
    ]),
  ]);
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void runExport();
    }
  });
  updateControls();
  ctx.openModal(modal);
}

async function openImportDialog(ctx, initialFiles = null) {
  const { el, icon } = ctx;
  const state = {
    phase: 'choose',
    source: null,
    sessionId: null,
    preview: null,
    decisions: new Map(),
    error: '',
    busy: false,
    applied: false,
    closed: false,
  };
  const body = el('div', { class: 'modal-body' });
  const foot = el('div', { class: 'modal-foot' });
  const title = el('h2', { text: '导入提供商配置' });
  const subtitle = el('div', { class: 'modal-sub', text: '文件会先校验和解密，确认后才会写入现有配置' });
  const modal = el('section', {
    class: 'modal provider-transfer-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入提供商配置' },
  }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'grow' }, [title, subtitle]),
      el('button', { class: 'btn btn-icon', type: 'button', title: '关闭', attrs: { 'aria-label': '关闭' }, on: { click: () => ctx.closeModal() } }, [icon('x', 15)]),
    ]),
    body,
    foot,
  ]);

  function cleanup() {
    state.closed = true;
    if (state.sessionId && !state.applied) void ctx.api.cancelProviderImport(state.sessionId).catch(() => {});
    if (state.source && state.source.bytes && typeof state.source.bytes.fill === 'function') state.source.bytes.fill(0);
    state.source = null;
    state.preview = null;
    state.sessionId = null;
  }

  function setError(message) {
    state.error = String(message || '');
  }

  function errorBox() {
    return state.error
      ? el('div', { class: 'note note-err' }, [icon('alert', 14), el('div', { class: 'grow', text: state.error })])
      : null;
  }

  function attachDrop(zone) {
    zone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget || !zone.contains?.(event.relatedTarget)) zone.classList.remove('is-dragover');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearProviderDropVisual();
      zone.classList.remove('is-dragover');
      void acceptFiles(event.dataTransfer?.files);
    });
  }

  async function acceptSource(source) {
    if (state.busy) return;
    if (!source || !source.fileName || !source.bytes) {
      setError('没有读取到配置文件');
      render();
      return;
    }
    state.busy = true;
    state.error = '';
    state.source = source;
    state.phase = 'checking';
    render();
    try {
      await ctx.api.inspectProviderImport(source);
      if (state.closed) return;
      setError('');
      state.busy = false;
      await prepare();
    } catch (err) {
      state.phase = 'choose';
      setError(importErrorText(ctx, err, '文件校验失败'));
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function acceptFiles(files) {
    if (state.busy || state.closed) return;
    const list = files ? Array.from(files) : [];
    if (list.length !== 1) {
      setError(list.length > 1 ? '一次只能导入一个便携加密配置文件' : '请拖入一个便携加密配置文件');
      render();
      return;
    }
    try {
      const source = await importSourceFromFile(list[0]);
      if (!state.closed) await acceptSource(source);
    } catch (err) {
      setError(importErrorText(ctx, err, '读取配置文件失败'));
      render();
    }
  }

  async function chooseFile() {
    if (state.busy) return;
    state.busy = true;
    setError('');
    render();
    try {
      const result = await ctx.api.pickProviderImportFile();
      if (state.closed || !result || result.canceled) return;
      state.busy = false;
      await acceptSource(result);
    } catch (err) {
      setError(importErrorText(ctx, err, '选择配置文件失败'));
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function prepare() {
    if (state.busy) return;
    state.busy = true;
    setError('');
    render();
    try {
      const result = await ctx.api.prepareProviderImport({ ...state.source });
      if (state.closed) {
        await ctx.api.cancelProviderImport(result.sessionId);
        return;
      }
      if (state.sessionId) await ctx.api.cancelProviderImport(state.sessionId);
      state.sessionId = result.sessionId;
      state.preview = result.preview;
      state.decisions = new Map((result.preview?.providers || []).map((provider) => [provider.sourceId, 'add']));
      state.phase = 'preview';
      render();
    } catch (err) {
      state.phase = 'choose';
      setError(importErrorText(ctx, err, '解密失败'));
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  function decisionPicker(provider) {
    const picker = el('select', {
      class: 'select provider-import-action',
      value: state.decisions.get(provider.sourceId) || 'add',
      attrs: { 'aria-label': `处理${provider.name || '提供商'}的同名配置` },
      on: {
        change: (event) => {
          state.decisions.set(provider.sourceId, String(event.target.value));
          render();
        },
      },
    }, [
      el('option', { value: 'add', text: provider.duplicate ? '新增为不同名称' : '新增' }),
      provider.duplicate && !provider.duplicate.multiple
        ? el('option', { value: 'overwrite', text: '覆盖同名配置' })
        : null,
      provider.duplicate && !provider.duplicate.multiple
        ? el('option', { value: 'skip', text: '跳过' })
        : null,
      provider.duplicate && provider.duplicate.multiple
        ? el('option', { value: 'skip', text: '跳过（存在多个同名目标）' })
        : null,
    ]);
    return picker;
  }

  async function applyNow() {
    if (state.busy || state.closed) return;
    if ([...state.decisions.values()].includes('overwrite') && state.phase !== 'confirm') {
      state.phase = 'confirm';
      render();
      return;
    }
    state.busy = true;
    setError('');
    render();
    try {
      const result = await ctx.api.applyProviderImport({
        sessionId: state.sessionId,
        decisions: [...state.decisions].map(([sourceId, action]) => ({ sourceId, action })),
        overwriteConfirmed: state.phase === 'confirm',
      });
      ctx.state.providers = Array.isArray(result?.providers) ? result.providers : ctx.state.providers;
      if (result?.status) {
        ctx.state.status = result.status;
        if (result.status.inject) ctx.state.inject = { ...(ctx.state.inject || {}), ...result.status.inject };
      }
      state.applied = true;
      markRelaunchIfInjected(ctx);
      ctx.closeModal();
      const counts = result?.counts || {};
      ctx.toast(`已导入配置：新增 ${counts.added || 0} 个，覆盖 ${counts.overwritten || 0} 个，跳过 ${counts.skipped || 0} 个`, 'ok');
      ctx.logLocal('info', `提供商配置已导入（新增 ${counts.added || 0}，覆盖 ${counts.overwritten || 0}，跳过 ${counts.skipped || 0}）`);
      await ctx.reload('providers');
    } catch (err) {
      setError(importErrorText(ctx, err, '导入失败，现有配置未修改'));
      ctx.toastError(err, '导入失败，现有配置未修改');
    } finally {
      state.busy = false;
      render();
    }
  }

  function renderChoose() {
    const zone = el('div', { class: 'provider-import-dropzone' }, [
      el('div', { class: 'provider-import-dropzone-icon' }, [icon('box', 22)]),
      el('div', { class: 'provider-import-dropzone-title', text: '将便携加密配置文件拖到这里或窗口任意位置' }),
      el('div', { class: 'hint', text: '只允许单个 .gptplus-providers 文件' }),
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: state.busy ? true : null, on: { click: () => void chooseFile() } }, [icon('folder', 13), el('span', { text: '选择文件' })]),
    ]);
    attachDrop(zone);
    return [errorBox(), zone];
  }

  function renderChecking() {
    return [errorBox(), el('div', { class: 'provider-import-progress' }, [
      el('div', { class: 'provider-import-progress-spinner' }),
      el('div', { class: 'provider-import-progress-title', text: '正在检查文件…' }),
      el('div', { class: 'hint', text: '校验扩展名、大小和加密格式' }),
    ])];
  }

  function renderPreview() {
    const preview = state.preview || { providers: [] };
    const rows = (preview.providers || []).map((provider) => el('div', { class: 'provider-import-preview-row' }, [
      el('div', { class: 'provider-import-preview-main' }, [
        el('div', { class: 'provider-import-preview-name', text: provider.name || '未命名提供商' }),
        el('div', { class: 'provider-import-preview-meta', text: `${provider.models.length} 个模型 · ${provider.api} · ${provider.enabled ? '已启用' : '已停用'} · API Key ${provider.hasApiKey ? '已配置' : '未配置'}` }),
        el('div', { class: 'provider-import-models', text: provider.models.map((model) => model.label || model.id).join('、') || '无模型' }),
      ]),
      decisionPicker(provider),
    ]));
    const overwriteCount = [...state.decisions.values()].filter((action) => action === 'overwrite').length;
    return [errorBox(), el('div', { class: 'note note-info' }, [
      icon('info', 14),
      el('div', { class: 'grow', text: '以下内容来自已认证的密文，仅展示名称、模型和状态；Base URL、API Key、请求头不会显示在预览中。' }),
    ]), el('div', { class: 'provider-import-preview-list' }, rows.length ? rows : [el('div', { class: 'provider-import-empty', text: '文件中没有提供商配置' })]),
      overwriteCount ? el('div', { class: 'note note-warn' }, [icon('alert', 14), el('div', { class: 'grow', text: `当前有 ${overwriteCount} 个提供商将覆盖同名配置，下一步会再次确认。` })]) : null,
    ];
  }

  function renderConfirm() {
    const overwriteCount = [...state.decisions.values()].filter((action) => action === 'overwrite').length;
    return [errorBox(), el('div', { class: 'note note-warn' }, [
      icon('alert', 16),
      el('div', { class: 'grow' }, [
        el('div', { text: `确定覆盖 ${overwriteCount} 个同名提供商吗？` }),
        el('div', { class: 'hint', text: '覆盖会替换 Base URL、API Key、模型列表和自定义请求头；其它提供商保持不变。' }),
      ]),
    ])];
  }

  function renderFoot() {
    foot.replaceChildren();
    if (state.phase === 'choose' || state.phase === 'checking') {
      foot.append(
        el('span', { class: 'hint', text: '拖拽和点击选择使用同一套文件校验流程' }),
        el('span', { class: 'right' }),
        el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => ctx.closeModal() } }, [el('span', { text: '取消' })]),
      );
      return;
    }
    if (state.phase === 'confirm') {
      foot.append(
        el('button', { class: 'btn btn-ghost', type: 'button', disabled: state.busy ? true : null, on: { click: () => { state.phase = 'preview'; render(); } } }, [el('span', { text: '返回修改' })]),
        el('span', { class: 'right' }),
        el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => ctx.closeModal() } }, [el('span', { text: '取消' })]),
        el('button', { class: 'btn btn-warning', type: 'button', disabled: state.busy ? true : null, on: { click: () => void applyNow() } }, [icon('check', 13), el('span', { text: state.busy ? '写入中…' : '确认覆盖并导入' })]),
      );
      return;
    }
    const overwriteCount = [...state.decisions.values()].filter((action) => action === 'overwrite').length;
    foot.append(
      el('button', { class: 'btn btn-ghost', type: 'button', disabled: state.busy ? true : null, on: { click: () => { state.phase = 'choose'; state.error = ''; render(); } } }, [el('span', { text: '重新选择' })]),
      el('span', { class: 'right' }),
      el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => ctx.closeModal() } }, [el('span', { text: '取消' })]),
      el('button', { class: 'btn btn-primary', type: 'button', disabled: state.busy ? true : null, on: { click: () => { if (overwriteCount) { state.phase = 'confirm'; render(); } else void applyNow(); } } }, [icon('check', 13), el('span', { text: state.busy ? '导入中…' : '确认导入' })]),
    );
  }

  function render() {
    if (state.closed) return;
    body.replaceChildren(...(
      state.phase === 'choose' ? renderChoose()
        : state.phase === 'checking' ? renderChecking()
          : state.phase === 'preview' ? renderPreview()
            : renderConfirm()
    ).filter(Boolean));
    renderFoot();
  }

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (state.phase === 'preview') {
        const overwriteCount = [...state.decisions.values()].filter((action) => action === 'overwrite').length;
        if (overwriteCount) { state.phase = 'confirm'; render(); }
        else void applyNow();
      } else if (state.phase === 'confirm') void applyNow();
    }
  });

  ctx.openModal(modal, { onClose: cleanup });
  render();
  if (initialFiles) await acceptFiles(initialFiles);
}

function probeResult(ctx, p, probe) {
  const { el, icon, fmt } = ctx;
  if (Array.isArray(probe.modelResults)) {
    const passed = probe.modelResults.filter((result) => result && result.ok).length;
    const total = probe.modelResults.length;
    const latencies = probe.modelResults
      .map((result) => Number(result && result.latencyMs))
      .filter((latency) => Number.isFinite(latency) && latency >= 0);
    const range = latencies.length
      ? latencies.length === 1
        ? fmt.dur(latencies[0])
        : `${fmt.dur(Math.min(...latencies))}–${fmt.dur(Math.max(...latencies))}`
      : '—';
    const title = probe.modelResults.map((result) =>
      `${result.modelId}: ${result.ok ? `通过 ${fmt.dur(result.latencyMs)}` : `失败 ${result.error || '未知错误'}`}`,
    ).join('\n');
    return el('div', {
      class: 'probe-result ' + (probe.ok ? 'probe-ok' : 'probe-bad'),
      title,
    }, [
      icon(probe.ok ? 'check' : 'alert', 13),
      el('span', {
        class: 'probe-text',
        text: `模型测试 · ${passed}/${total} 通过 · ${range}`,
      }),
    ]);
  }
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

function openModelTestDialog(ctx, p) {
  const { el, icon, fmt } = ctx;
  const models = (p.models || []).filter((model) => String(model && model.id || '').trim());
  const selected = new Set(models.filter((model) => model.enabled !== false).map((model) => model.id));
  let running = false;
  let results = [];

  const selectedText = el('span', { class: 'model-test-selected-count' });
  const modelList = el('div', { class: 'model-test-list' });
  const resultBox = el('div', { class: 'model-test-results' });
  const startBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    on: { click: () => void runModelTest() },
  }, [icon('activity', 13), el('span', { text: '开始测试' })]);

  function updateControls() {
    selectedText.textContent = `${selected.size}/${models.length} 个模型已选择`;
    startBtn.disabled = running || selected.size === 0;
    const buttons = modelList.querySelectorAll ? modelList.querySelectorAll('input') : [];
    for (const input of buttons) input.disabled = running;
  }

  function renderModelList() {
    modelList.replaceChildren(...models.map((model) => {
      const id = model.id;
      const label = model.label || id;
      const checkbox = el('input', {
        type: 'checkbox',
        checked: selected.has(id) ? true : null,
        attrs: { 'aria-label': `选择模型 ${label}`, 'data-model-id': id },
        on: {
          change: (event) => {
            if (event.target.checked) selected.add(id);
            else selected.delete(id);
            updateControls();
          },
        },
      });
      return el('label', { class: 'model-test-option' }, [
        checkbox,
        el('span', { class: 'model-test-option-main' }, [
          el('span', { class: 'model-test-option-label', text: label }),
          el('span', { class: 'model-test-option-id mono', text: id }),
        ]),
        model.enabled === false ? el('span', { class: 'chip faint', text: '未启用' }) : null,
      ]);
    }));
    updateControls();
  }

  function renderResults() {
    if (running) {
      resultBox.replaceChildren(el('div', { class: 'model-test-empty', text: '正在逐个发送最小生成请求，请稍候…' }));
      return;
    }
    if (!results.length) {
      resultBox.replaceChildren(el('div', { class: 'model-test-empty', text: '测试结果会显示在这里；每个模型都会单独统计延时。' }));
      return;
    }
    resultBox.replaceChildren(...results.map((result) => {
      const model = models.find((item) => item.id === result.modelId);
      return el('div', { class: 'model-test-result ' + (result.ok ? 'is-ok' : 'is-error') }, [
        el('span', { class: 'model-test-result-icon' }, [icon(result.ok ? 'check' : 'alert', 13)]),
        el('span', { class: 'model-test-result-name', text: model?.label || result.modelId }),
        el('span', { class: 'model-test-result-id mono', text: result.modelId }),
        el('span', { class: 'model-test-result-status', text: result.ok ? `通过 · HTTP ${result.status ?? 200}` : `失败${result.status ? ` · HTTP ${result.status}` : ''}` }),
        el('span', { class: 'model-test-result-latency mono', text: fmt.dur(result.latencyMs) }),
        result.ok ? null : el('span', { class: 'model-test-result-error', title: result.error || '', text: result.error || '未知错误' }),
      ]);
    }));
  }

  async function runModelTest() {
    if (running || selected.size === 0) {
      if (!selected.size) ctx.toast('请至少选择一个模型', 'warn');
      return;
    }
    running = true;
    results = [];
    updateControls();
    renderResults();
    try {
      const response = await ctx.api.testProviderModels({
        providerId: p.id,
        modelIds: models.filter((model) => selected.has(model.id)).map((model) => model.id),
      });
      results = Array.isArray(response?.results) ? response.results : [];
      viewState.probe[p.id] = {
        ok: !!response?.ok,
        modelResults: results,
        at: Date.now(),
      };
      const passed = results.filter((result) => result && result.ok).length;
      const summary = `「${p.name}」模型测试：${passed}/${results.length} 通过`;
      ctx.logLocal(response?.ok ? 'info' : 'error', summary);
      ctx.toast(summary, response?.ok ? 'ok' : 'warn');
      ctx.renderCurrent(true);
    } catch (err) {
      const error = ctx.describeError(err);
      results = [...selected].map((modelId) => ({ modelId, ok: false, latencyMs: 0, error }));
      viewState.probe[p.id] = { ok: false, modelResults: results, at: Date.now() };
      ctx.toastError(err, '模型测试失败');
    } finally {
      running = false;
      updateControls();
      renderResults();
    }
  }

  const selectAllBtn = el('button', {
    class: 'btn btn-sm btn-ghost',
    type: 'button',
    on: { click: () => { for (const model of models) selected.add(model.id); renderModelList(); } },
  }, [el('span', { text: '全选' })]);
  const clearBtn = el('button', {
    class: 'btn btn-sm btn-ghost',
    type: 'button',
    on: { click: () => { selected.clear(); renderModelList(); } },
  }, [el('span', { text: '清空' })]);
  const closeBtn = el('button', {
    class: 'btn btn-icon',
    type: 'button',
    title: '关闭',
    attrs: { 'aria-label': '关闭' },
    on: { click: () => { if (!running) ctx.closeModal(); } },
  }, [icon('x', 15)]);
  const modal = el('div', { class: 'modal model-test-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': `测试${p.name}的模型` } }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'grow' }, [
        el('h2', { text: `测试「${p.name}」的模型` }),
        el('div', { class: 'modal-sub', text: '逐个发送最小生成请求，确认模型可用并测量响应延时' }),
      ]),
      closeBtn,
    ]),
    el('div', { class: 'modal-body' }, [
      el('div', { class: 'model-test-toolbar' }, [
        selectedText,
        el('span', { class: 'right' }),
        selectAllBtn,
        clearBtn,
      ]),
      modelList,
      resultBox,
    ]),
    el('div', { class: 'modal-foot' }, [
      el('span', { class: 'hint', text: '每个模型发送一次最小生成请求，可能产生少量用量；不会修改配置' }),
      el('span', { class: 'right' }),
      el('button', { class: 'btn btn-ghost', type: 'button', disabled: running ? true : null, on: { click: () => ctx.closeModal() } }, [el('span', { text: '关闭' })]),
      startBtn,
    ]),
  ]);

  renderModelList();
  renderResults();
  ctx.openModal(modal, {});
}

/** 删除二次确认：说明会连带移除哪些模型，避免误删正在注入的提供商。 */
function confirmDeleteProvider(ctx, p) {
  const { el, icon } = ctx;
  const models = p.models || [];
  const enabledModels = models.filter((m) => m.enabled !== false);
  const inject = ctx.state.inject || (ctx.state.status && ctx.state.status.inject) || {};
  const lastProvider = (ctx.state.providers || []).length <= 1;
  let confirmBtn = null;
  let busy = false;

  const details = [
    `「${p.name}」的 ${models.length} 个模型会一起删除，并从 ChatGPT 清单里移除。`,
    inject.enabled
      ? `当前已开启注入：删除后目录会重写，需要重启 ChatGPT 才会生效${lastProvider ? '；这是最后一个提供商，删除后 ChatGPT 会还原成官方模型' : ''}。`
      : '',
    lastProvider ? '这是最后一个提供商，删除后界面会回到没有任何提供商的初始状态。' : '',
    '删除后如果想恢复，需要重新填写 Base URL、API Key 和模型清单。',
  ].filter(Boolean);

  const run = async () => {
    if (busy) return;
    busy = true;
    confirmBtn.disabled = true;
    confirmBtn.classList.add('is-busy');
    confirmBtn.lastElementChild.textContent = '删除中…';
    try {
      const list = await ctx.api.deleteProvider(p.id);
      ctx.state.providers = list;
      delete viewState.probe[p.id];
      delete viewState.revealed[p.id];
      markRelaunchIfInjected(ctx);
      ctx.closeModal();
      ctx.toast(`已删除「${p.name}」`, 'ok');
      await ctx.reload('providers');
    } catch (err) {
      ctx.toastError(err, '删除失败');
      ctx.renderCurrent(true);
    } finally {
      busy = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('is-busy');
        confirmBtn.lastElementChild.textContent = '删除提供商';
      }
    }
  };

  confirmBtn = el('button', {
    class: 'btn btn-danger',
    type: 'button',
    on: { click: () => void run() },
  }, [icon('trash', 13), el('span', { text: '删除提供商' })]);

  const modal = el('section', {
    class: 'modal provider-delete-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除提供商' },
  }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'grow' }, [
        el('h2', { text: '删除提供商' }),
        el('div', { class: 'modal-sub', text: `${p.name || '(未命名)'} · ${p.baseUrl || '未填写 Base URL'}` }),
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
          text: enabledModels.length
            ? `${enabledModels.length} 个启用模型将同时从 ChatGPT 清单移除`
            : '删除后不可恢复',
        }),
      ]),
      el('div', { class: 'model-delete-reasons' }, details.map((text) => el('div', { class: 'hint', text }))),
    ]),
    el('div', { class: 'modal-foot' }, [
      el('span', { class: 'hint', text: '删除后不可恢复' }),
      el('span', { class: 'right' }),
      el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => ctx.closeModal() } }, [
        el('span', { text: '取消' }),
      ]),
      confirmBtn,
    ]),
  ]);
  ctx.openModal(modal);
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
    api: existing && (existing.api === 'openai' || existing.api === 'anthropic' || existing.api === 'responses')
      ? existing.api
      : 'responses',
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
    placeholder: 'XXX',
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
  const apiSeg = el('div', { class: 'seg seg-api', attrs: { role: 'group', 'aria-label': '接口协议' } });
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
      el('div', { class: 'mrow-id-cell' }, [idInput,
        model.isNew ? el('span', { class: 'chip chip-warn', text: '新增' }) : null,
        model.detected === false ? el('span', { class: 'chip chip-err', text: '未检测到' }) : null,
      ]),
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
    el('div', { class: 'field' }, [
      el('label', { class: 'label' }, [el('span', { text: 'Base URL' }), el('span', { class: 'req', text: '*' })]),
      baseInput,
      el('div', { class: 'hint', text: '只填到版本号即可，例如 api.example.com/v1；缺少协议头或 /v1 时保存会自动补齐' }),
      refs.baseErr,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'API Key' }),
      el('div', { class: 'input-group' }, [keyInput, keyToggle]),
      el('div', { class: 'hint', text: '仅保存在本机配置；Base URL、API Key 和请求头由系统安全存储加密，界面里默认打码' }),
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
                reasoning: true,
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
    if (refs.nameErr) refs.nameErr.textContent = '请填写提供商名称，例如「XXX」';
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
      ...(m.isNew === true ? { isNew: true } : {}),
      ...(m.detected === false ? { detected: false } : {}),
      ...(Number.isFinite(Number(m.missingSince)) ? { missingSince: Number(m.missingSince) } : {}),
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
  await doPull(ctx, draft, refs, afterRowsChange);
}

async function doPull(ctx, draft, refs, afterRowsChange) {
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
    const missingAt = Date.now();
    for (const model of draft.models) {
      model.detected = false;
      model.isNew = false;
      if (!model.missingSince) model.missingSince = missingAt;
    }
    let added = 0;
    let kept = 0;
    for (const item of remote) {
      const id = String(item && item.id ? item.id : '').trim();
      if (!id) continue;
      const exist = byId.get(id);
      if (exist) {
        kept += 1;
        exist.detected = true;
        exist.isNew = false;
        exist.missingSince = null;
      } else {
        draft.models.push({
          id,
          label: String((item && item.label) || id).trim() || id,
          enabled: true,
          reasoning: true,
          detected: true,
          isNew: true,
          missingSince: null,
        });
        added += 1;
      }
    }
    afterRowsChange();
    const missing = draft.models.filter((model) => model.detected === false).length;
    const msg = `检查到 ${remote.length} 个模型：新增 ${added} 个（默认启用并开启推理），已存在 ${kept} 个，未检测到 ${missing} 个`;
    ctx.toast(msg, 'ok');
    ctx.logLocal('info', msg);
    if (refs.note) refs.note('ok', '已完成手动 /models 检查：新增模型默认启用并开启推理，未检测到的模型保留原启用状态；点「保存修改」写入结果。');
  } catch (err) {
    ctx.toastError(err, '拉取 /models 失败');
  } finally {
    draft.busy = false;
  }
}
