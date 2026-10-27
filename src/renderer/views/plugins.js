// 插件市场：管理随 gpt++ 发布的插件状态与插件自己的轻量配置。

const viewState = {
  busy: new Set(),
};

const METRICS = [
  ['speed', '生成速度', '显示最近一次响应的 tok/s（包含思考阶段）'],
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
          click: () => void runPluginAction(
            ctx,
            plugin.id,
            () => ctx.api.setPluginEnabled({ id: plugin.id, enabled: !plugin.enabled }),
            plugin.enabled ? `${plugin.name}已停用` : `${plugin.name}已启用`,
          ),
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
            `${plugin.name}已卸载，配置已保留`,
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
  const actions = [configure, action].filter(Boolean);
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
    ]),
    ctx.el('footer', { class: 'plugin-card-foot' }, [
      ctx.el('span', { class: 'hint', text: plugin.id === 'weixin' ? '运行状态仍由微信连接页单独控制' : '数据仅在本机处理' }),
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

