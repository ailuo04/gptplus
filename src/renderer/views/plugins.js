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
        ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => { ctx.closeModal(); openBalanceConfig(ctx, plugin); } } }, [ctx.icon('server', 13), ctx.el('span', { text: '配置额度来源' })]),
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

function openBalanceConfig(ctx, plugin) {
  const current = plugin?.config?.balance || { enabled: false, providers: [], refreshIntervalSeconds: 60 };
  const saved = new Map((Array.isArray(current.providers) ? current.providers : []).map((item) => [item.providerId, item.adapter]));
  const providers = (ctx.state.providers || []).filter((provider) => provider && provider.enabled !== false);
  const fields = new Map();
  const rows = providers.map((provider) => {
    const adapter = saved.get(provider.id) || 'sub2api';
    const enabled = ctx.el('input', { type: 'checkbox', checked: saved.has(provider.id) && provider.hasKey === true,
      attrs: { 'aria-label': '关联 ' + (provider.name || provider.id) } });
    const adapterSelect = ctx.el('select', { class: 'select', attrs: { 'aria-label': (provider.name || provider.id) + ' 余额接口类型' } }, [
      ctx.el('option', { value: 'sub2api', text: 'Sub2API', selected: adapter === 'sub2api' }),
      ctx.el('option', { value: 'newapi', text: 'New API', selected: adapter === 'newapi' }),
    ]);
    if (!provider.hasKey) { enabled.disabled = true; adapterSelect.disabled = true; }
    fields.set(provider.id, { enabled, adapterSelect, provider });
    return ctx.el('div', { class: 'balance-provider-row' }, [
      ctx.el('label', { class: 'plugin-config-option balance-provider-toggle' }, [enabled, ctx.el('span', { class: 'plugin-config-option-copy' }, [
        ctx.el('strong', { text: provider.name || provider.id }),
        ctx.el('span', { class: 'hint', text: provider.hasKey ? '使用此提供商已保存的 API Key 查询' : '此提供商尚未保存 API Key' }),
      ])]),
      adapterSelect,
    ]);
  });
  const balanceEnabled = ctx.el('input', { type: 'checkbox', checked: current.enabled === true, attrs: { 'aria-label': '在用量信息栏显示额度' } });
  const seconds = ctx.el('input', { class: 'input mono', type: 'number', value: String(current.refreshIntervalSeconds || 60),
    attrs: { min: '10', max: '86400', step: '1', 'aria-label': '自动刷新间隔（秒）' } });
  const modal = ctx.openModal(ctx.el('section', {
    class: 'modal plugin-config-modal balance-config-modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置额度显示' },
  }, [
    ctx.el('header', { class: 'modal-head' }, [ctx.el('div', { class: 'modal-title', text: '配置额度显示' })]),
    ctx.el('div', { class: 'modal-body plugin-config-body' }, [
      ctx.el('p', { class: 'setting-desc', text: '为每个已有提供商选择 Sub2API 或 New API。插件只读取固定额度接口，不发起模型请求；API Key 留在本机主进程，不会发送到 ChatGPT 页面。' }),
      ctx.el('label', { class: 'plugin-config-option' }, [balanceEnabled, ctx.el('span', { class: 'plugin-config-option-copy' }, [ctx.el('strong', { text: '显示当前模型额度' }), ctx.el('span', { class: 'hint', text: '将额度并入四项用量信息栏' })])]),
      fields.size ? ctx.el('div', { class: 'plugin-config-options balance-provider-list' }, rows)
        : ctx.el('p', { class: 'hint', text: '没有可用的已保存 API Key 提供商。请先在提供商页面添加服务配置。' }),
      ctx.el('label', { class: 'field' }, [
        ctx.el('span', { class: 'label', text: '自动刷新间隔（秒）' }), seconds,
        ctx.el('span', { class: 'hint', text: '范围 10–86400 秒，默认 60 秒。刷新只调用额度查询接口。' }),
      ]),
    ]),
    ctx.el('div', { class: 'modal-foot' }, [
      ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => ctx.closeModal() } }, [ctx.el('span', { text: '取消' })]),
      ctx.el('button', { class: 'btn btn-accent btn-sm', type: 'button', on: { click: () => {
        const interval = Number(seconds.value);
        if (!Number.isInteger(interval) || interval < 10 || interval > 86400) { ctx.toast('刷新间隔必须是 10–86400 秒的整数', 'warn'); seconds.focus?.(); return; }
        const mappings = [...fields.values()].filter((field) => field.enabled.checked && field.provider.hasKey)
          .map((field) => ({ providerId: field.provider.id, adapter: field.adapterSelect.value }));
        void runPluginAction(ctx, plugin.id, () => ctx.api.setPluginConfig({ id: plugin.id, config: { ...plugin.config, balance: { enabled: balanceEnabled.checked, providers: mappings, refreshIntervalSeconds: interval } } }), '中转站余额配置已保存')
          .then((savedConfig) => { if (savedConfig) ctx.closeModal(); });
      } } }, [ctx.icon('check', 13), ctx.el('span', { text: '保存配置' })]),
    ]),
  ]));
  modal.classList.add('is-plugin-config');
}

function imageStatusText(plugin) {
  if (!plugin.enabled) return '未启用；保存配置后启用，重启 ChatGPT 并开启新对话。';
  const status = plugin.imageStatus;
  if (status?.error) return '技能配置异常：' + status.error;
  if (!status?.configured || !status.enabled) return '技能配置尚未生效，请重新保存配置或停用后启用。';
  if (plugin.config?.preferDefault && status.builtinSkillDisabled) return '自动优先已配置：内置 imagegen 技能已停用；请重启 ChatGPT 并开启新对话。';
  if (plugin.config?.preferDefault) return '自动优先：未找到已知内置 imagegen 技能，未停用任何内置技能；可显式调用 $gptplus-imagegen。';
  return '自定义技能已配置；可自动匹配或显式调用 $gptplus-imagegen。';
}

function imageChoiceGroup(ctx, name, label, options, current, onChange) {
  let value = options.some(([key]) => key === current) ? current : options[0][0];
  const radios = [];
  const choices = options.map(([key, text]) => {
    const radio = ctx.el('input', { type: 'radio', name: 'imagegen-' + name, value: key, checked: key === value,
      attrs: { 'aria-label': text }, on: { change: () => {
        if (!radio.checked) return;
        value = key;
        for (const other of radios) other.checked = other === radio;
        onChange?.();
      } },
    });
    radios.push(radio);
    return ctx.el('label', { class: 'imagegen-choice' }, [radio, ctx.el('span', { text })]);
  });
  const node = ctx.el('fieldset', { class: 'imagegen-option-group' }, [
    ctx.el('legend', { class: 'label', text: label }),
    ctx.el('div', { class: 'imagegen-options' + (name === 'aspectRatio' ? ' is-ratios' : '') }, choices),
  ]);
  return { node, get value() { return value; } };
}

function openImageConfig(ctx, plugin) {
  const current = plugin.config || {};
  const field = (label, input, hint) => ctx.el('label', { class: 'field' }, [
    ctx.el('span', { class: 'label', text: label }), input,
    ctx.el('span', { class: 'hint', text: hint }),
  ]);
  const input = (label, value, placeholder, type = 'text') => ctx.el('input', {
    class: 'input', type, value, placeholder, attrs: { 'aria-label': label, autocomplete: 'off' },
  });
  const url = input('API URL', current.baseUrl || '', 'https://your-provider.example/v1');
  const key = input('API Key', '', current.hasKey ? '已保存，留空保持不变' : '填写你的 API Key', 'password');
  const model = input('模型名', current.model || '', '提供商支持的生图模型名');
  const dimensions = ctx.el('p', { class: 'hint imagegen-dimensions' });
  const updateDimensions = () => {
    const edge = { '1K': 1024, '2K': 2048, '4K': 4096 }[resolution.value];
    const [width, height] = aspectRatio.value.split(':').map(Number);
    const scale = edge / Math.max(width, height);
    dimensions.textContent = '请求尺寸：' + Math.round(width * scale) + ' × ' + Math.round(height * scale) + ' px';
  };
  const resolution = imageChoiceGroup(ctx, 'resolution', '图片尺寸', [['1K', '1K'], ['2K', '2K'], ['4K', '4K']], current.resolution || '1K', updateDimensions);
  const aspectRatio = imageChoiceGroup(ctx, 'aspectRatio', '画面比例', [['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16']], current.aspectRatio || '1:1', updateDimensions);
  const quality = imageChoiceGroup(ctx, 'quality', '画质', [['low', '低'], ['medium', '中'], ['high', '高'], ['auto', '自动']], current.quality || 'auto');
  const background = imageChoiceGroup(ctx, 'background', '背景', [['auto', '自动'], ['opaque', '不透明'], ['transparent', '透明']], current.background || 'auto');
  updateDimensions();
  const prefer = ctx.el('input', { type: 'checkbox', checked: current.preferDefault !== false,
    attrs: { 'aria-label': '设为默认生图（自动优先）' } });
  const readConfig = () => ({
    baseUrl: url.value.trim(), apiKey: key.value.trim(), model: model.value.trim(), preferDefault: prefer.checked,
    resolution: resolution.value, aspectRatio: aspectRatio.value, quality: quality.value, background: background.value,
  });
  const requiredHint = '请填写 API URL、API Key 和模型名';
  const validateConfig = (config) => {
    if (!config.baseUrl || !config.model || (!config.apiKey && !current.hasKey)) {
      ctx.toast(requiredHint, 'warn'); return false;
    }
    return true;
  };
  const verifyLabel = ctx.el('span', { text: '生成 1 张验证（可能计费）' });
  const verifyResult = ctx.el('p', { class: 'hint', attrs: { role: 'status', 'aria-live': 'polite' }, text:
    '验证使用当前填写配置，无需先保存、启用插件或启动网关；Key 留空时复用已保存值。会实际生成 1 张测试图，可能计费，仅返回结果，不保存测试图片。' });
  const verify = ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
    on: { click: async () => {
      if (verify.disabled) return;
      const config = readConfig();
      if (!validateConfig(config)) { verifyResult.textContent = requiredHint; return; }
      verify.disabled = true; verifyLabel.textContent = '正在验证…';
      verifyResult.textContent = '正在使用当前填写配置生成 1 张测试图，请稍候；可能计费，仅返回结果，不保存测试图片。';
      try {
        const result = await ctx.api.verifyImagePlugin(config);
        const changed = JSON.stringify(readConfig()) !== JSON.stringify(config);
        if (!changed && result.baseUrl) url.value = result.baseUrl;
        verifyResult.textContent = `${changed ? '本次请求配置' : '当前填写配置'}验证通过：${result.model}，${result.count} 张（${result.formats.join(', ')}）。未自动保存配置或更改启用状态。`
          + (changed ? '表单已修改，请重新验证当前配置。' : plugin.enabled ? '' : '插件仍未启用，可保存后再启用。')
          + '这不代表新会话自动选择已验证。';
        ctx.toast('自定义生图接口验证通过', 'ok');
      } catch (err) {
        verifyResult.textContent = '验证失败：' + ctx.describeError(err, '请检查当前填写的服务配置。');
        ctx.toastError(err, '生图接口验证失败');
      }
      finally { verify.disabled = false; verifyLabel.textContent = '生成 1 张验证（可能计费）'; }
    } },
  }, [ctx.icon('activity', 13), verifyLabel]);
  const modal = ctx.openModal(ctx.el('section', {
    class: 'modal plugin-config-modal imagegen-config-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置自定义生图' },
  }, [
    ctx.el('header', { class: 'modal-head' }, [ctx.el('div', { class: 'modal-title', text: '配置自定义生图' })]),
    ctx.el('div', { class: 'modal-body plugin-config-body' }, [
      ctx.el('p', { class: 'setting-desc', text: '使用你自己的 OpenAI 兼容 Images API 生成图片；执行器固定使用这里的地址和模型，失败不自动切换服务。首版仅支持文生图。' }),
      field('API URL', url, '支持 Base URL 或完整 /images/generations 端点；缺少协议头或 /v1 时，验证和保存会自动补齐；完整生图端点原样使用。'),
      field('API Key', key, '使用本机系统安全存储加密保存；不写入技能、命令或日志。已有密钥时留空保持不变。'),
      field('模型名', model, '填写生图服务实际支持的模型名，不会自动替换模型。'),
      ctx.el('section', { class: 'imagegen-generation-settings', attrs: { 'aria-label': '默认生成参数' } }, [
        ctx.el('h3', { text: '默认生成参数' }),
        ctx.el('p', { class: 'hint', text: '仅在本次生图未明确指定时使用。对话中的临时要求只作用于该次请求，不修改这里的默认值，也不沿用到其他次生图。' }),
        resolution.node, aspectRatio.node, quality.node, background.node, dimensions,
        ctx.el('p', { class: 'hint', text: '1K / 2K / 4K 按长边 1024 / 2048 / 4096 px 换算。实际支持的尺寸、画质与透明背景由服务和模型决定；不支持时明确报错，不自动降级。透明背景使用 PNG。' }),
      ]),
      ctx.el('label', { class: 'plugin-config-option' }, [prefer, ctx.el('span', { class: 'plugin-config-option-copy' }, [
        ctx.el('strong', { text: '设为默认生图（自动优先）' }),
        ctx.el('span', { class: 'hint', text: '启用时备份并修改 Codex 技能设置，停用已知内置 imagegen 技能；不删除内置文件，停用插件时撤回这项设置。' }),
      ])]),
      ctx.el('p', { class: 'setting-desc', text: '不能保证模型每次都自动选择该技能，也不代表关闭底层生图工具。启用或修改默认设置后，请重启 ChatGPT 并开启新对话；需要确定选中时可使用 $gptplus-imagegen。' }),
      ctx.el('p', { class: 'hint', text: '通过技能生成时 gpt++ 与本地网关必须保持运行；下方配置验证无需网关。技能脚本需要 Python 3，可使用客户端自带运行时；不会自动安装依赖。' }),
      verify, verifyResult,
    ]),
    ctx.el('div', { class: 'modal-foot' }, [
      ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => ctx.closeModal() } }, [ctx.el('span', { text: '取消' })]),
      ctx.el('button', { class: 'btn btn-accent btn-sm', type: 'button', on: { click: () => {
        const config = readConfig();
        if (!validateConfig(config)) return;
        void runPluginAction(ctx, plugin.id, () => ctx.api.setPluginConfig({ id: plugin.id, config }), plugin.enabled ? '生图配置已保存，请重启 ChatGPT 并开启新对话' : '生图配置已保存，请启用后使用').then((saved) => {
          if (saved) { if (plugin.enabled) ctx.markRelaunchNeeded?.(); ctx.closeModal(); }
        });
      } } }, [ctx.icon('check', 13), ctx.el('span', { text: '保存配置' })]),
    ]),
  ]));
  modal.classList.add('is-plugin-config');
}

function openImageEnableConfirmation(ctx, plugin) {
  if (!plugin.config?.baseUrl || !plugin.config?.model || !plugin.config?.hasKey) {
    ctx.toast('请先保存生图服务的 URL、API Key 和模型', 'warn'); openImageConfig(ctx, plugin); return;
  }
  const modal = ctx.openModal(ctx.el('section', {
    class: 'modal plugin-config-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '启用自定义生图' },
  }, [
    ctx.el('header', { class: 'modal-head' }, [ctx.el('div', { class: 'modal-title', text: '启用自定义生图' })]),
    ctx.el('div', { class: 'modal-body plugin-config-body' }, [
      ctx.el('p', { class: 'setting-desc', text: '将安装 gptplus-imagegen 技能并备份、修改 Codex 技能设置。勾选默认优先时，会停用已知内置 imagegen 技能；不删除内置技能文件。停用本插件时撤回内置技能开关。' }),
      ctx.el('p', { class: 'setting-desc', text: '这是自动优先，不保证每次自动选中，也不关闭底层工具。启用后需重启 ChatGPT 并开启新对话。此操作本身不会调用生图接口或产生生图费用。' }),
    ]),
    ctx.el('div', { class: 'modal-foot' }, [
      ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => ctx.closeModal() } }, [ctx.el('span', { text: '取消' })]),
      ctx.el('button', { class: 'btn btn-accent btn-sm', type: 'button', on: { click: () => {
        void runPluginAction(ctx, plugin.id, () => ctx.api.setPluginEnabled({ id: plugin.id, enabled: true }),
          '自定义生图已启用，请重启 ChatGPT 并开启新对话').then((saved) => {
          if (saved) { ctx.markRelaunchNeeded?.(); ctx.closeModal(); }
        });
      } } }, [ctx.icon('check', 13), ctx.el('span', { text: '备份并启用' })]),
    ]),
  ]));
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
  const providers = (ctx.state.providers || []).filter((provider) => provider && provider.enabled !== false);
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
    ctx.el('span', { class: 'label', text: '长按触发时长（秒）' }),
    spaceHoldInput,
    ctx.el('span', { class: 'hint', text: '范围 0.3-5 秒，默认 1 秒。输入框内按住空格，或在未选中文字处按住鼠标左键，达到该时长后开始录音；松开按键或鼠标自动转写。' }),
  ]);
  const providerFields = ctx.el('div', { class: 'plugin-config-options' }, [providerField, modelField]);
  const localHint = ctx.el('span', { class: 'hint', text: '首次使用会自动下载约 231 MB 的 SenseVoice 模型；如果已安装 DeepSeek Harness，会直接复用它的模型缓存。录音和识别都在本机完成。输入框内长按空格，或在未选中文字处按住鼠标左键，达到设定时长后开始录音，松开后自动转写。' });
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
        ctx.el('p', { class: 'setting-desc', text: '麦克风按钮会注入到 ChatGPT 输入框的模型选择器与发送键之间。默认使用本机 SenseVoice 离线识别；在输入框内长按空格，或在未选中文字处按住鼠标左键，达到设定时长后开始录音，默认 1 秒，松开后自动转写。也可以改用提供商音频转写，或保留 Windows 系统听写。' }),
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
                ctx.toast('长按触发时长需在 0.3-5 秒之间', 'warn');
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
  if (plugin.id === 'custom-imagegen') {
    return ctx.el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => openImageConfig(ctx, plugin) } },
      [ctx.icon('plug', 13), ctx.el('span', { text: '配置' })]);
  }
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
            if (plugin.id === 'custom-imagegen' && !plugin.enabled) { openImageEnableConfirmation(ctx, plugin); return; }
            if (plugin.id === 'chatgpt-plugin-catalog' && !plugin.enabled) {
              openCatalogEnableConfirmation(ctx, plugin);
              return;
            }
            void runPluginAction(
              ctx, plugin.id,
              () => ctx.api.setPluginEnabled({ id: plugin.id, enabled: !plugin.enabled }),
              plugin.id === 'custom-imagegen'
                ? '自定义生图已停用，请重启 ChatGPT 并开启新对话'
                : plugin.id === 'chatgpt-plugin-catalog'
                ? '已移除 gpt++ 插件目录配置，请重启 ChatGPT'
                : plugin.enabled ? `${plugin.name}已停用` : `${plugin.name}已启用`,
            ).then((saved) => { if (saved && ['chatgpt-plugin-catalog', 'custom-imagegen'].includes(plugin.id)) ctx.markRelaunchNeeded?.(); });
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
            plugin.id === 'custom-imagegen' ? '已停用生图技能并保留服务配置，请重启 ChatGPT' : plugin.id === 'chatgpt-plugin-catalog' ? '已卸载并移除 gpt++ 插件目录配置，请重启 ChatGPT' : `${plugin.name}已卸载，配置已保留`,
          ).then((saved) => { if (saved && plugin.id === 'custom-imagegen') ctx.markRelaunchNeeded?.(); }),
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
      plugin.id === 'custom-imagegen' && plugin.installed
        ? ctx.el('p', { class: 'plugin-card-detail', text: imageStatusText(plugin) }) : null,
      plugin.id === 'chatgpt-plugin-catalog'
        ? ctx.el('p', { class: 'plugin-card-detail', text: catalogStatusText(plugin) }) : null,
    ].filter(Boolean)),
    ctx.el('footer', { class: 'plugin-card-foot' }, [
      ctx.el('span', { class: 'hint', text: plugin.id === 'custom-imagegen' ? '固定路由；gpt++ 与网关需保持运行' : plugin.id === 'weixin' ? '扫码登录与运行状态在配置页管理' : plugin.id === 'voice-input' ? '麦克风按钮会注入到 ChatGPT 输入框' : plugin.id === 'chatgpt-plugin-catalog' ? '本地市场；不更改登录授权' : '数据仅在本机处理' }),
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


