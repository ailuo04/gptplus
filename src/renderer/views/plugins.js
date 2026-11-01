// 插件市场：管理随 gpt++ 发布的插件状态与插件自己的轻量配置。

const viewState = {
  busy: new Set(),
};

const METRICS = [
  ['speed', '生成速度', '显示最近一次响应首包后的生成速度（不含排队与首包等待）'],
  ['cache', '缓存命中率', '显示输入 Token 的缓存命中比例'],
  ['context', '上下文占用', '显示当前会话占用的上下文窗口比例'],
];

function pluginById(state, id) {
  return (state.plugins || []).find((plugin) => plugin.id === id) || null;
}

function statusLabel(plugin) {
  if (!plugin?.installed) return '未安装';
  return plugin.enabled ? '已启用' : '已停用';
}

function statusClass(plugin) {
  if (!plugin?.installed) return '';
  return plugin.enabled ? 'chip-ok' : 'chip-warn';
}

function mergePlugin(ctx, next) {
  if (!next || typeof next !== 'object') return;
  const current = ctx.state.plugins || [];
  ctx.state.plugins = current.some((plugin) => plugin.id === next.id)
    ? current.map((plugin) => plugin.id === next.id ? next : plugin)
    : [...current, next];
  ctx.renderChrome();
  ctx.renderCurrent(true, { preserveScrollTop: true });
}

async function runPluginAction(ctx, id, action, successMessage) {
  if (viewState.busy.has(id)) return null;
  viewState.busy.add(id);
  ctx.renderCurrent(true, { preserveScrollTop: true });
  try {
    const next = await action();
    mergePlugin(ctx, next);
    if (successMessage) ctx.toast(successMessage, 'ok');
    return next;
  } catch (err) {
    ctx.toastError(err, '插件操作失败');
    return null;
  } finally {
    viewState.busy.delete(id);
    ctx.renderCurrent(true, { preserveScrollTop: true });
  }
}

function openUsageConfig(ctx, plugin) {
  const current = plugin?.config?.metrics || {};
  const fields = new Map();
  const rows = METRICS.map(([key, label, description]) => {
    const checkbox = ctx.el('input', {
      type: 'checkbox',
      checked: current[key] !== false,
      attrs: { 'aria-label': label },
    });
    fields.set(key, checkbox);
    return ctx.el('label', { class: 'plugin-config-option' }, [
      checkbox,
      ctx.el('span', { class: 'plugin-config-option-copy' }, [
        ctx.el('strong', { text: label }),
        ctx.el('span', { class: 'hint', text: description }),
      ]),
    ]);
  });

  const modal = ctx.openModal(
    ctx.el('section', {
      class: 'modal plugin-config-modal',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置 ChatGPT 用量信息栏' },
    }, [
      ctx.el('header', { class: 'modal-head' }, [
        ctx.el('div', { class: 'modal-title', text: '配置用量信息栏' }),
      ]),
      ctx.el('div', { class: 'modal-body plugin-config-body' }, [
        ctx.el('p', { class: 'setting-desc', text: '选择要显示在 ChatGPT 输入框下方的信息。保存后会尝试立即刷新已连接的 ChatGPT 页面。' }),
        ctx.el('div', { class: 'plugin-config-options' }, rows),
      ]),
      ctx.el('div', { class: 'modal-foot' }, [
        ctx.el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => ctx.closeModal() },
        }, [ctx.el('span', { text: '取消' })]),
        ctx.el('button', {
          class: 'btn btn-accent btn-sm',
          type: 'button',
          on: {
            click: () => {
              const metrics = Object.fromEntries([...fields.entries()].map(([key, checkbox]) => [key, checkbox.checked]));
              void runPluginAction(
                ctx,
                plugin.id,
                () => ctx.api.setPluginConfig({ id: plugin.id, config: { metrics } }),
                '用量信息栏配置已保存',
              ).then((saved) => {
                if (saved) ctx.closeModal();
              });
            },
          },
        }, [ctx.icon('check', 13), ctx.el('span', { text: '保存配置' })]),
      ]),
    ]),
  );
  modal.classList.add('is-plugin-config');
}

const VOICE_LANGUAGES = [
  ['', '自动检测'],
  ['zh', '中文'],
  ['en', 'English'],
  ['yue', '粤语'],
  ['ja', '日本語'],
  ['ko', '韩语'],
];

function openVoiceConfig(ctx, plugin) {
  const current = plugin?.config || {};
  const providers = (ctx.state.providers || []).filter((provider) => provider && provider.enabled !== false && provider.api !== 'anthropic');
  const selectedProvider = String(current.providerId || '');
  const providerOptions = providers.map((provider) => ctx.el('option', {
    value: provider.id,
    text: provider.name || provider.id,
    selected: provider.id === selectedProvider,
  }));
  if (!providerOptions.length) {
    providerOptions.push(ctx.el('option', { value: '', text: '没有可用的提供商', selected: true }));
  } else if (selectedProvider && !providers.some((provider) => provider.id === selectedProvider)) {
    providerOptions.push(ctx.el('option', { value: selectedProvider, text: selectedProvider + '（未找到）', selected: true }));
  }

  const engine = current.engine === 'provider' ? 'provider' : current.engine === 'system' ? 'system' : 'local';
  const engineSelect = ctx.el('select', {
    class: 'select',
    value: engine,
  }, [
    ctx.el('option', { value: 'local', text: '本地识别（SenseVoice，离线）', selected: engine === 'local' }),
    ctx.el('option', { value: 'provider', text: '提供商音频转写', selected: engine === 'provider' }),
    ctx.el('option', { value: 'system', text: 'Windows 系统听写（会弹出 Win+H 浮层）', selected: engine === 'system' }),
  ]);
  const providerSelect = ctx.el('select', { class: 'select' }, providerOptions);
  const modelInput = ctx.el('input', {
    class: 'input',
    type: 'text',
    value: String(current.model || 'whisper-1'),
    placeholder: 'whisper-1',
  });
  const languageSelect = ctx.el('select', {
    class: 'select',
    value: VOICE_LANGUAGES.some(([value]) => value === (current.language || '')) ? (current.language || '') : '',
  }, VOICE_LANGUAGES.map(([value, label]) => ctx.el('option', {
    value,
    text: label,
    selected: value === (current.language || ''),
  })));
  const rawSpaceHoldMs = Number(current.spaceHoldMs);
  const spaceHoldSeconds = Number.isFinite(rawSpaceHoldMs) ? Math.min(5, Math.max(0.3, rawSpaceHoldMs / 1000)) : 1;
  const spaceHoldInput = ctx.el('input', {
    class: 'input mono',
    type: 'number',
    value: String(spaceHoldSeconds),
    attrs: { min: '0.3', max: '5', step: '0.1', 'aria-label': '空格长按时长（秒）' },
  });

  const providerField = ctx.el('label', { class: 'field' }, [
    ctx.el('span', { class: 'label', text: '提供商' }),
    providerSelect,
    ctx.el('span', { class: 'hint', text: 'API Key 沿用提供商配置，不会另存；该提供商需要支持 POST /audio/transcriptions。' }),
  ]);
  const modelField = ctx.el('label', { class: 'field' }, [
    ctx.el('span', { class: 'label', text: '转写模型' }),
    modelInput,
    ctx.el('span', { class: 'hint', text: '常见值：whisper-1、gpt-4o-mini-transcribe，或提供商自己的转写模型名。' }),
  ]);
  const languageField = ctx.el('label', { class: 'field' }, [
    ctx.el('span', { class: 'label', text: '识别语言' }),
    languageSelect,
    ctx.el('span', { class: 'hint', text: '自动检测适合中英混说；指定语言通常更准。' }),
  ]);
  const spaceHoldField = ctx.el('label', { class: 'field' }, [
    ctx.el('span', { class: 'label', text: '空格长按时长（秒）' }),
    spaceHoldInput,
    ctx.el('span', { class: 'hint', text: '范围 0.3-5 秒，默认 1 秒。按住空格达到该时长后开始录音，松开自动转写。' }),
  ]);
  const providerFields = ctx.el('div', { class: 'plugin-config-options' }, [providerField, modelField]);
  const localHint = ctx.el('span', { class: 'hint', text: '首次使用会自动下载约 231 MB 的 SenseVoice 模型；如果已安装 DeepSeek Harness，会直接复用它的模型缓存。录音和识别都在本机完成。输入框内长按空格即可开始录音，松开自动转写。' });
  const systemHint = ctx.el('span', { class: 'hint', text: '系统听写会调用 Win+H 并弹出 Windows 语音浮层，不建议日常使用。' });
  const syncDisabled = () => {
    const provider = engineSelect.value === 'provider';
    const local = engineSelect.value === 'local';
    const system = engineSelect.value === 'system';
    providerSelect.disabled = !provider;
    modelInput.disabled = !provider;
    languageSelect.disabled = system;
    spaceHoldInput.disabled = system;
    providerFields.style.display = provider ? '' : 'none';
    languageField.style.display = system ? 'none' : '';
    localHint.style.display = local ? '' : 'none';
    systemHint.style.display = system ? '' : 'none';
  };
  engineSelect.addEventListener('change', syncDisabled);
  syncDisabled();

  const modal = ctx.openModal(
    ctx.el('section', {
      class: 'modal plugin-config-modal',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置语音输入' },
    }, [
      ctx.el('header', { class: 'modal-head' }, [
        ctx.el('div', { class: 'modal-title', text: '配置语音输入' }),
      ]),
      ctx.el('div', { class: 'modal-body plugin-config-body' }, [
        ctx.el('p', { class: 'setting-desc', text: '麦克风按钮会注入到 ChatGPT 输入框的模型选择器与发送键之间。默认使用本机 SenseVoice 离线识别；在输入框内长按空格可开始录音，默认 1 秒，松开自动转写。也可以改用提供商音频转写，或保留 Windows 系统听写。' }),
        ctx.el('label', { class: 'field' }, [
          ctx.el('span', { class: 'label', text: '输入方式' }),
          engineSelect,
          localHint,
          systemHint,
        ]),
        spaceHoldField,
        providerFields,
        languageField,
      ]),
      ctx.el('div', { class: 'modal-foot' }, [
        ctx.el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => ctx.closeModal() },
        }, [ctx.el('span', { text: '取消' })]),
        ctx.el('button', {
          class: 'btn btn-accent btn-sm',
          type: 'button',
          on: {
            click: () => {
              const engine = engineSelect.value === 'provider' ? 'provider' : engineSelect.value === 'system' ? 'system' : 'local';
              if (engine === 'provider' && !providerSelect.value) {
                ctx.toast('请先选择支持音频转写的提供商', 'warn');
                return;
              }
              const spaceHoldSeconds = Number(spaceHoldInput.value);
              if (!Number.isFinite(spaceHoldSeconds) || spaceHoldSeconds < 0.3 || spaceHoldSeconds > 5) {
                ctx.toast('空格长按时长需在 0.3-5 秒之间', 'warn');
                return;
              }
              const config = {
                engine,
                providerId: engine === 'provider' ? String(providerSelect.value || '') : String(current.providerId || ''),
                model: String(modelInput.value || 'whisper-1').trim() || 'whisper-1',
                language: String(languageSelect.value || ''),
                spaceHoldMs: Math.round(spaceHoldSeconds * 1000),
              };
              void runPluginAction(
                ctx,
                plugin.id,
                () => ctx.api.setPluginConfig({ id: plugin.id, config }),
                '语音输入配置已保存',
              ).then((saved) => {
                if (saved) ctx.closeModal();
              });
            },
          },
        }, [ctx.icon('check', 13), ctx.el('span', { text: '保存配置' })]),
      ]),
    ]),
  );
  modal.classList.add('is-plugin-config');
}

function openCatalogEnableConfirmation(ctx, plugin) {
  const submitLabel = ctx.el('span', { text: '备份并启用' });
  const submit = ctx.el('button', { class: 'btn btn-accent btn-sm', type: 'button', on: { click: () => {
    if (viewState.busy.has(plugin.id)) return;
    submit.disabled = true;
    submitLabel.textContent = '复制和校验中…';
    void runPluginAction(ctx, plugin.id,
      () => ctx.api.setPluginEnabled({ id: plugin.id, enabled: true }),
      '本地市场已注册，请重启 ChatGPT 并在「个人」中选择安装',
    ).then((saved) => {
      if (saved) { ctx.markRelaunchNeeded?.(); ctx.closeModal(); }
      else { submit.disabled = false; submitLabel.textContent = '备份并启用'; }
    });
  } } }, [ctx.icon('check', 13), submitLabel]);
  const modal = ctx.openModal(ctx.el('section', {
    class: 'modal plugin-config-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '启用 ChatGPT 插件目录修复' },
  }, [
    ctx.el('header', { class: 'modal-head' }, [ctx.el('div', { class: 'modal-title', text: '启用插件目录修复' })]),
    ctx.el('div', { class: 'modal-body plugin-config-body' }, [
      ctx.el('p', { class: 'setting-desc', text: '将 ChatGPT 已同步的插件示例复制到 gpt++ 数据目录并注册为独立本地市场。启用前会备份 Codex 配置；停用时只移除 gpt++ 写入的配置。' }),
      ctx.el('p', { class: 'setting-desc', text: '重启 ChatGPT 后请在「个人」中的本地市场选择并安装插件，开启新会话使用。此功能不能恢复远程公共目录或原有安装记录，联网插件仍需正常登录和授权。' }),
      ctx.el('p', { class: 'setting-desc', text: '首次复制和校验可能需要几十秒，请保持 gpt++ 运行。' }),
    ]),
    ctx.el('div', { class: 'modal-foot' }, [
      ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => ctx.closeModal() } }, [ctx.el('span', { text: '取消' })]),
      submit,
    ]),
  ]));
  modal.classList.add('is-plugin-config');
}

function catalogStatusText(plugin) {
  const status = plugin.catalogStatus;
  if (!status) return '刷新市场以检查本机缓存与配置状态';
  if (status.error) return status.error;
  if (status.needsMigration) return '旧版目录或本地副本不可用，请点击检查并修复';
  if (plugin.enabled && !status.configured) return '本地配置未生效，请点击检查并修复';
  const count = status.catalogCount || 0;
  return plugin.enabled ? `本地市场已注册（${count} 个条目）；重启 ChatGPT 后在「个人」选择安装` : `本机缓存：${count} 个条目；启用后复制并注册`;
}

function configureButton(ctx, plugin) {
  if (!plugin.installed) return null;
  if (plugin.id === 'weixin') {
    return ctx.el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.navigate('weixin') },
    }, [ctx.icon('plug', 13), ctx.el('span', { text: '配置' })]);
  }
  if (plugin.id === 'usage-statusline') {
    return ctx.el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => openUsageConfig(ctx, plugin) },
    }, [ctx.icon('plug', 13), ctx.el('span', { text: '配置' })]);
  }
  if (plugin.id === 'voice-input') {
    return ctx.el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => openVoiceConfig(ctx, plugin) },
    }, [ctx.icon('plug', 13), ctx.el('span', { text: '配置' })]);
  }
  return null;
}

function renderPluginCard(ctx, plugin) {
  const busy = viewState.busy.has(plugin.id);
  const toggle = plugin.installed
    ? ctx.el('button', {
        class: 'switch plugin-toggle' + (plugin.enabled ? ' is-enabled' : ''),
        type: 'button',
        role: 'switch',
        disabled: busy ? true : null,
        attrs: {
          'aria-checked': plugin.enabled ? 'true' : 'false',
          'aria-label': plugin.enabled ? `停用${plugin.name}` : `启用${plugin.name}`,
          title: plugin.enabled ? `停用${plugin.name}` : `启用${plugin.name}`,
        },
        on: {
          click: () => {
            if (plugin.id === 'chatgpt-plugin-catalog' && !plugin.enabled) {
              openCatalogEnableConfirmation(ctx, plugin);
              return;
            }
            void runPluginAction(
              ctx, plugin.id,
              () => ctx.api.setPluginEnabled({ id: plugin.id, enabled: !plugin.enabled }),
              plugin.id === 'chatgpt-plugin-catalog'
                ? '已移除 gpt++ 插件目录配置，请重启 ChatGPT'
                : plugin.enabled ? `${plugin.name}已停用` : `${plugin.name}已启用`,
            ).then((saved) => { if (saved && plugin.id === 'chatgpt-plugin-catalog') ctx.markRelaunchNeeded?.(); });
          },
        },
      }, [ctx.el('span', { class: 'switch-thumb' })])
    : null;

  const action = plugin.installed
    ? ctx.el('button', {
        class: 'btn btn-ghost btn-sm plugin-uninstall',
        type: 'button',
        disabled: busy ? true : null,
        on: {
          click: () => void runPluginAction(
            ctx,
            plugin.id,
            () => ctx.api.uninstallPlugin(plugin.id),
            plugin.id === 'chatgpt-plugin-catalog' ? '已卸载并移除 gpt++ 插件目录配置，请重启 ChatGPT' : `${plugin.name}已卸载，配置已保留`,
          ),
        },
      }, [ctx.icon('trash', 13), ctx.el('span', { text: '卸载' })])
    : ctx.el('button', {
        class: 'btn btn-accent btn-sm',
        type: 'button',
        disabled: busy ? true : null,
        on: {
          click: () => void runPluginAction(
            ctx,
            plugin.id,
            () => ctx.api.installPlugin(plugin.id),
            `${plugin.name}已安装，请启用后使用`,
          ),
        },
      }, [ctx.icon('download', 13), ctx.el('span', { text: '安装' })]);

  const configure = configureButton(ctx, plugin);
  const repair = plugin.id === 'chatgpt-plugin-catalog' && plugin.enabled
    ? ctx.el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy ? true : null,
        on: { click: () => void runPluginAction(ctx, plugin.id,
          () => ctx.api.setPluginEnabled({ id: plugin.id, enabled: true }),
          '本地市场已检查，请重启 ChatGPT 并在「个人」中选择安装',
        ).then((saved) => { if (saved) ctx.markRelaunchNeeded?.(); }) },
      }, [ctx.icon('refresh', 13), ctx.el('span', { text: busy ? '复制和校验中…' : '检查并修复' })])
    : null;
  const actions = [configure, repair, action].filter(Boolean);
  return ctx.el('article', { class: 'plugin-card' }, [
    ctx.el('header', { class: 'plugin-card-head' }, [
      ctx.el('div', { class: 'plugin-card-mark' }, [ctx.icon(plugin.icon, 20)]),
      ctx.el('div', { class: 'plugin-card-title' }, [
        ctx.el('div', { class: 'plugin-card-title-row' }, [
          ctx.el('h2', { text: plugin.name }),
          ctx.el('span', { class: `chip ${statusClass(plugin)}`, text: statusLabel(plugin) }),
        ]),
        ctx.el('div', { class: 'plugin-card-meta' }, [
          ctx.el('span', { text: `${plugin.category} · v${plugin.version}` }),
          ctx.el('span', { text: plugin.builtIn ? '内置插件' : '第三方插件' }),
        ]),
      ]),
      toggle,
    ]),
    ctx.el('div', { class: 'plugin-card-body' }, [
      ctx.el('p', { class: 'plugin-card-description', text: plugin.description }),
      ctx.el('p', { class: 'plugin-card-detail', text: plugin.detail }),
      plugin.id === 'chatgpt-plugin-catalog'
        ? ctx.el('p', { class: 'plugin-card-detail', text: catalogStatusText(plugin) }) : null,
    ].filter(Boolean)),
    ctx.el('footer', { class: 'plugin-card-foot' }, [
      ctx.el('span', { class: 'hint', text: plugin.id === 'weixin' ? '扫码登录与运行状态在配置页管理' : plugin.id === 'voice-input' ? '麦克风按钮会注入到 ChatGPT 输入框' : plugin.id === 'chatgpt-plugin-catalog' ? '本地市场；不更改登录授权' : '数据仅在本机处理' }),
      ctx.el('div', { class: 'plugin-card-actions' }, actions),
    ]),
  ]);
}

export function renderPlugins(root, ctx, actions) {
  const plugins = ctx.state.plugins || [];
  actions.replaceChildren(
    ctx.el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => void ctx.reload('plugins') },
    }, [ctx.icon('refresh', 13), ctx.el('span', { text: '刷新市场' })]),
  );

  const installed = plugins.filter((plugin) => plugin.installed).length;
  root.replaceChildren(
    ctx.el('section', { class: 'plugins-intro' }, [
      ctx.el('div', { class: 'plugins-intro-mark' }, [ctx.icon('box', 19)]),
      ctx.el('div', { class: 'plugins-intro-copy' }, [
        ctx.el('h2', { text: '按需安装功能' }),
        ctx.el('p', { text: `市场中的插件随 gpt++ 发布，安装后可以单独配置、启用或卸载。当前已安装 ${installed} 个插件。` }),
      ]),
    ]),
    ctx.el('div', { class: 'plugin-market-grid' }, plugins.map((plugin) => renderPluginCard(ctx, plugin))),
  );
}


