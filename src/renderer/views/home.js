// 主页：把「提供商 → 本地网关 → ChatGPT 客户端」这条接线放在首屏，
// 下面接着是最近请求、今日流量、提供商清单和常用入口。所有数据都来自已有状态快照。

const viewState = {
  injectBusy: false,
};

// 首屏底部的「重启 ChatGPT」采用两段式确认：第一次点击只把按钮切成确认态，
// 6 秒内再点一次才真正结束并重启客户端，避免在首屏误触直接关掉 ChatGPT。
const RELAUNCH_CONFIRM_MS = 6000;
const RELAUNCH_ACTION_TEXT = '重启 ChatGPT';
const RELAUNCH_CONFIRM_TEXT = '确认重启？';
const RELAUNCH_BUSY_TEXT = '重启中…';
const RELAUNCH_TITLE = '结束并重新启动 ChatGPT.exe，让它重新读取模型清单';
const RELAUNCH_CONFIRM_TITLE = '再次点击确认：立即结束并重新启动 ChatGPT.exe';
const RELAUNCH_BUSY_TITLE = '正在结束旧的 ChatGPT 进程并重新启动，请稍候';
const REASONING_LABELS = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};

function reasoningLabel(value) {
  const key = String(value || '').toLowerCase();
  return REASONING_LABELS[key] || key;
}
/** 重启进行中（含确认后的 IPC 往返），阻止重复点击。 */
let relaunchBusy = false;
/** 距离真正执行重启还差一次确认。 */
let relaunchConfirmArmed = false;
/** 当前处于确认态的按钮节点：页面重绘后据此识别出旧按钮并放弃确认。 */
let relaunchConfirmButton = null;
let relaunchConfirmTimer = 0;

/** 本地时区的 YYYY-MM-DD，与使用量页保持同一种切日方式。 */
function localDayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isSettledEntry(entry) {
  if (!entry || (!entry.providerId && !entry.providerName && !entry.model)) return false;
  const at = Number(entry.at);
  const status = Number(entry.status);
  if (!Number.isFinite(at) || !Number.isFinite(status) || status <= 0) return false;
  if (entry.final === true || entry.usageRecord === true) return true;
  const message = String(entry.msg || '');
  if (/^(开始请求|上游返回 HTTP|上游拒绝可选参数|请求异常:)/.test(message)) return false;
  if (status === 200) return message.startsWith('完成 ') || !!entry.tokens || !message;
  return message.startsWith('客户端中断:') || message.startsWith('流式转发失败:') ||
    message.startsWith('上游请求失败:') || message.startsWith('上游返回失败事件:') || Number(entry.ms) > 0;
}

function tokenTotal(entry) {
  const usage = entry && entry.tokens && typeof entry.tokens === 'object' ? entry.tokens : {};
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens);
  const output = Number(usage.output_tokens ?? usage.completion_tokens);
  return (Number.isFinite(input) && input > 0 ? input : 0) + (Number.isFinite(output) && output > 0 ? output : 0);
}

function settledEntries(state) {
  const source = Array.isArray(state.usage) && state.usage.length ? state.usage : state.logs;
  return (source || []).filter(isSettledEntry);
}

function compactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 1 : 2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}K`;
  return String(Math.round(n));
}

/** 网关地址：主进程运行时会给出完整 URL，未运行时只展示端口，不编造地址。 */
function gatewayAddress(gateway) {
  if (!gateway) return '';
  if (gateway.running && gateway.url) return String(gateway.url);
  if (!gateway.port) return '';
  return gateway.enabled ? `127.0.0.1:${gateway.port}` : '';
}

function chainState(ctx) {
  const { state } = ctx;
  const status = state.status || {};
  const providers = state.providers || [];
  const models = state.models || [];
  const gateway = state.gateway || status.gateway || {};
  const inject = state.inject || status.inject || { enabled: false };
  // 快照可能还没拉全：数组为空时回落到主进程状态里的计数，避免首屏先报 0。
  const providerCount = providers.length || Number(status.providers) || 0;
  const modelTotal = models.length || Number(status.models) || 0;
  const enabledModels = models.length
    ? models.filter((m) => m.enabled).length
    : Number(status.modelsEnabled) || 0;
  return { status, providers, models, gateway, inject, providerCount, modelTotal, enabledModels };
}

export function renderHome(root, ctx, actions) {
  const { el, icon, state, fmt } = ctx;

  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.reload('home') },
    }, [icon('refresh', 13), el('span', { text: '刷新总览' })]),
    codexSplitButton(ctx),
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      on: { click: () => ctx.openProviderForm(null) },
    }, [icon('plus', 13), el('span', { text: '添加提供商' })]),
  );

  root.replaceChildren(
    hero(ctx),
    peerEntry(ctx),
    el('div', { class: 'home-grid' }, [
      recentCard(ctx),
      trafficCard(ctx),
    ]),
    el('div', { class: 'home-grid home-grid-lower' }, [
      providersCard(ctx),
      shortcutsCard(ctx),
    ]),
  );
}

function peerEntry(ctx) {
  const { el, icon, state } = ctx;
  const peer = state.peer || {};
  const sharing = peer.sharing || {};
  const remote = peer.remoteSync || {};
  return el('section', { class: 'home-peer-entry' }, [
    el('div', { class: 'home-peer-mark' }, [icon('plug', 17)]),
    el('div', { class: 'home-peer-copy' }, [
      el('span', { class: 'home-peer-title', text: '对等共享' }),
      el('span', { class: 'home-peer-desc', text: '发布本机模型，或同步另一台电脑的模型；两种方式可同时使用。' }),
    ]),
    el('div', { class: 'home-peer-states' }, [
      el('span', { class: 'chip ' + (sharing.enabled ? 'chip-ok' : ''), text: '共享' + (sharing.enabled ? '已开启' : '未开启') }),
      el('span', { class: 'chip ' + (remote.enabled ? 'chip-ok' : ''), text: '自动同步' + (remote.enabled ? '已开启' : '未开启') }),
    ]),
    el('button', {
      class: 'btn btn-sm btn-accent',
      type: 'button',
      on: { click: () => ctx.openPeerSettings() },
    }, [icon('plug', 13), el('span', { text: '配置对等共享' })]),
  ]);
}

// ============ 首屏：信号链路 ============
function hero(ctx) {
  const { el, icon, state, fmt } = ctx;
  const s = chainState(ctx);
  const { gateway, inject, providerCount, modelTotal, enabledModels, models } = s;
  const injectOn = !!inject.enabled;
  const gatewayRunning = !!gateway.running;

  const healthy = providerCount > 0 && gatewayRunning && injectOn;
  const started = providerCount > 0 || gateway.enabled || injectOn;
  const statusText = healthy ? '链路畅通' : started ? '等待接通' : '尚未配置';
  const statusTone = healthy ? 'chip-ok' : started ? 'chip-warn' : '';

  const lastWrite = state.status && state.status.codex && state.status.codex.lastWrite;
  const networkMode = state.network && state.network.proxyMode === 'direct' ? '直连' : '系统代理';

  const head = el('div', { class: 'home-hero-head' }, [
    el('div', { class: 'home-hero-title' }, [
      el('span', { class: 'wire-eyebrow', text: 'SIGNAL PATH' }),
      el('strong', { text: '三段线路，接在一起才算接通' }),
    ]),
    el('div', { class: 'home-hero-status' }, [
      el('span', {
        class: `chip ${statusTone}`,
        attrs: { role: 'status' },
      }, [
        el('span', { class: 'dot ' + (healthy ? 'dot-ok' : started ? 'dot-warn' : 'dot-off') }),
        el('span', { text: statusText }),
      ]),
    ]),
  ]);

  const providerNode = chainNode(ctx, {
    step: '1 · 提供商',
    tone: 'provider',
    live: providerCount > 0,
    dot: providerCount > 0 ? 'dot-ok' : 'dot-off',
    value: `${providerCount} 个`,
    detail: providerCount
      ? `提供 ${modelTotal} 个模型${models.some((m) => !m.enabled) ? ` · ${models.filter((m) => !m.enabled).length} 个已停用` : ''}`
      : '添加一个 Base URL 和 API Key 就能开始',
  });

  const gatewayNode = chainNode(ctx, {
    step: '2 · 本地网关',
    tone: 'gateway',
    live: gatewayRunning,
    dot: gatewayRunning ? 'dot-ok' : gateway.enabled ? 'dot-warn' : 'dot-off',
    value: gatewayRunning ? `运行中 :${gateway.port}` : gateway.enabled ? '已启用 · 未运行' : '未启用',
    detail: gatewayRunning
      ? gatewayAddress(gateway)
      : gateway.enabled ? '已启用，但没有监听端口；到设置页启动它' : 'ChatGPT 通过它访问你的模型',
    monoDetail: true,
  });

  const injectSwitch = el('button', {
    class: 'switch home-chain-switch',
    type: 'button',
    role: 'switch',
    disabled: viewState.injectBusy ? true : null,
    attrs: {
      'aria-checked': injectOn ? 'true' : 'false',
      'aria-label': '注入模型到 ChatGPT 客户端',
      'aria-busy': viewState.injectBusy ? 'true' : null,
      title: injectOn ? '关闭注入，还原官方模型' : '把启用模型写入 ChatGPT 模型清单',
    },
    on: { click: () => void toggleInject(ctx, !injectOn) },
  });

  const clientNode = el('div', { class: 'home-chain-node is-client' + (injectOn ? ' is-on' : '') }, [
    el('div', { class: 'home-chain-eyebrow', text: '3 · ChatGPT 客户端' }),
    el('div', { class: 'home-chain-value' }, [
      el('span', { class: 'dot ' + (injectOn ? 'dot-warn' : 'dot-off') }),
      el('span', { class: 'home-chain-main ellipsis', text: injectOn ? `已注入 ${enabledModels} 个模型` : '未注入' }),
      el('span', { class: 'right' }),
      injectSwitch,
    ]),
    el('div', {
      class: 'home-chain-detail ellipsis',
      title: injectOn
        ? (state.relaunchNeeded ? '模型清单已写入；重启 ChatGPT 后生效' : '模型清单已写入 Codex 配置')
        : '打开开关即可写入模型清单',
      text: injectOn
        ? (state.relaunchNeeded ? '已写入 · 等待重启客户端' : '模型清单已写入 Codex 配置')
        : '打开开关即可写入模型清单',
    }),
  ]);

  const linkA = chainLink(ctx, providerCount > 0 && gatewayRunning);
  const linkB = chainLink(ctx, gatewayRunning && injectOn);
  const next = nextStep(ctx);

  const foot = el('div', { class: 'home-hero-foot' }, [
    el('div', { class: 'home-hero-meta' }, [
      el('span', { class: 'home-meta-item' }, [icon('plug', 12), el('span', { text: `上游网络 · ${networkMode}` })]),
      el('span', { class: 'home-meta-sep', text: '·' }),
      el('span', { class: 'home-meta-item' }, [
        icon('code', 12),
        el('span', {
          text: lastWrite && lastWrite.ok
            ? `最后写入 ${fmt.rel(lastWrite.at)}`
            : injectOn ? '模型清单已写入 Codex 配置' : '尚未写入 Codex 配置',
        }),
      ]),
    ]),
    el('button', {
      class: 'home-hero-link',
      type: 'button',
      on: { click: () => ctx.navigate('settings') },
    }, [el('span', { text: healthy ? '查看网关设置' : '检查网关设置' }), icon('chevronDown', 12)]),
  ]);

  const nextButton = next
    ? el('button', {
        class: `btn btn-sm ${next.blocking ? 'btn-danger' : 'btn-warning'} home-next-action`,
        type: 'button',
        title: next.title || null,
        // 按钮节点先建好再绑事件：run() 需要拿到自身来切换「确认 / 重启中」文案与忙碌态。
        on: { click: () => void next.run(nextButton) },
      }, [el('span', { text: next.action })])
    : null;

  const nextBar = next
    ? el('div', { class: `home-next${next.blocking ? ' is-blocking' : ''}`, attrs: { role: next.blocking ? 'alert' : 'note' } }, [
        icon('alert', 13),
        el('span', { class: 'home-next-text', text: next.text }),
        nextButton,
      ])
    : null;

  return el('section', { class: 'home-hero', attrs: { 'aria-label': '接线总览' } }, [
    head,
    el('div', { class: 'home-chain' }, [providerNode, linkA, gatewayNode, linkB, clientNode]),
    nextBar,
    foot,
  ]);
}

/** 链路没通时只告诉用户「下一步做哪一件事」，不在页面上罗列全部步骤。 */
function nextStep(ctx) {
  const s = chainState(ctx);
  const { gateway, inject, providerCount, enabledModels } = s;
  if (!providerCount) {
    return { text: '还没有提供商：先接入一个 Base URL 与 API Key。', action: '添加提供商', run: () => ctx.openProviderForm(null) };
  }
  if (!gateway.enabled) {
    return { text: '本地网关未启用：ChatGPT 需要通过它访问你的模型。', action: '去启用网关', run: () => ctx.navigate('settings') };
  }
  if (!gateway.running) {
    return { text: `本地网关已启用但没有运行（端口 ${gateway.port || '未设置'}）。`, action: '去启动网关', run: () => ctx.navigate('settings') };
  }
  if (!inject.enabled) {
    return enabledModels
      ? { text: `${enabledModels} 个启用模型还没有写入 ChatGPT 的模型清单。`, action: '去注入模型', run: () => ctx.navigate('models') }
      : { text: '没有已启用的模型：先在模型页启用至少一个。', action: '去启用模型', run: () => ctx.navigate('models') };
  }
  if (ctx.state.relaunchNeeded) {
    // 这里必须真正重启客户端：配置已写入磁盘，但 ChatGPT 只在启动时读取一次，
    // 把用户带去模型页不会让新配置生效。
    return {
      text: '配置已修改，需要重启 ChatGPT 客户端后生效。',
      action: RELAUNCH_ACTION_TEXT,
      title: RELAUNCH_TITLE,
      blocking: true,
      run: (button) => restartChatGpt(ctx, button),
    };
  }
  return null;
}

function chainNode(ctx, { step, tone, live, dot, value, detail, monoDetail }) {
  const { el } = ctx;
  return el('div', { class: `home-chain-node is-${tone}${live ? ' is-live' : ''}` }, [
    el('div', { class: 'home-chain-eyebrow', text: step }),
    el('div', { class: 'home-chain-value' }, [
      el('span', { class: `dot ${dot}` }),
      el('span', { class: 'home-chain-main ellipsis', text: value }),
    ]),
    el('div', {
      class: 'home-chain-detail ellipsis' + (monoDetail && live ? ' is-mono' : ''),
      title: detail,
      text: detail,
    }),
  ]);
}

function chainLink(ctx, live) {
  const { el, icon } = ctx;
  return el('div', { class: 'home-chain-link' + (live ? ' is-live' : ''), attrs: { 'aria-hidden': 'true' } }, [
    icon('chevronDown', 14),
  ]);
}

// ============ 最近请求 ============
function recentCard(ctx) {
  const { el, icon, state, fmt } = ctx;
  const rows = settledEntries(state)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 5);

  const head = el('header', { class: 'card-head' }, [
    icon('activity', 14),
    el('span', { class: 'card-title', text: '最近请求' }),
    el('span', { class: 'card-desc', text: rows.length ? `最近 ${rows.length} 条网关完成记录` : '网关收到请求后显示在这里' }),
    el('span', { class: 'right' }),
    el('button', {
      class: 'btn btn-sm btn-ghost',
      type: 'button',
      on: { click: () => ctx.navigate('usage') },
    }, [el('span', { text: '全部记录' })]),
  ]);

  const body = rows.length
    ? el('div', { class: 'home-recent-list' }, rows.map((row) => {
      const ok = Number(row.status) >= 200 && Number(row.status) < 300;
      const model = String(row.upstreamModel || row.model || '').split('__').at(-1);
      const provider = String(row.providerName || row.providerId || '未知渠道');
      const effortKnown = Object.prototype.hasOwnProperty.call(row, 'reasoningEffort');
      const effort = row.reasoningEffort ? reasoningLabel(row.reasoningEffort) : (effortKnown ? 'default' : '');
      const requested = row.reasoningEffortRequested ? reasoningLabel(row.reasoningEffortRequested) : '';
      const effortTitle = effortKnown
        ? `Reasoning effort sent upstream: ${effort}${requested && requested !== effort ? ` (ChatGPT requested: ${requested})` : ''}`
        : '';
      return el('div', { class: 'home-recent-row' }, [
        el('span', { class: 'home-recent-time mono', text: fmt.clock(row.at) }),
        el('div', { class: 'home-recent-main' }, [
          el('span', { class: 'home-recent-model ellipsis', text: model || provider }),
          el('span', { class: 'home-recent-provider ellipsis', title: provider, text: provider }),
        ]),
        el('span', { class: 'home-recent-effort', title: effortTitle }, effort ? [
          el('span', { class: 'home-recent-effort-key', text: 'effort' }),
          el('span', { class: 'home-recent-effort-value', text: effort }),
        ] : []),
        el('span', { class: 'home-recent-ms mono', text: row.ms ? fmt.dur(row.ms) : '—' }),
        el('span', {
          class: 'chip ' + (ok ? 'chip-ok' : 'chip-err'),
          text: `HTTP ${row.status}`,
        }),
      ]);
    }))
    : el('div', { class: 'home-recent-empty' }, [
      el('span', { text: '还没有请求记录。在 ChatGPT 里选一个已注入的模型发起对话，这里会出现每次调用的耗时与状态。' }),
    ]);

  return el('section', { class: 'card home-recent' }, [head, body]);
}

// ============ 今日流量 ============
function trafficCard(ctx) {
  const { el, icon, state, fmt } = ctx;
  const now = Date.now();
  const todayKey = localDayKey(now);
  const settled = settledEntries(state);
  const today = settled.filter((entry) => localDayKey(Number(entry.at)) === todayKey);
  const tokens = today.reduce((sum, entry) => sum + tokenTotal(entry), 0);
  const success = today.filter((entry) => Number(entry.status) >= 200 && Number(entry.status) < 300).length;
  const rate = today.length ? Math.round((success / today.length) * 100) : null;
  const average = today.length
    ? today.reduce((sum, entry) => sum + (Number(entry.ms) || 0), 0) / today.length
    : 0;

  const series = lastDays(settled, state.usageTrend, 7);
  const max = Math.max(1, ...series.map((day) => day.tokens));

  const head = el('header', { class: 'card-head' }, [
    icon('activity', 14),
    el('span', { class: 'card-title', text: '今日流量' }),
    el('span', { class: 'card-desc', text: '本地网关' }),
  ]);

  const body = el('div', { class: 'card-body home-traffic-body' }, [
    el('div', { class: 'home-traffic-main' }, [
      el('span', { class: 'home-traffic-value nums', text: compactNumber(tokens) }),
      el('span', { class: 'home-traffic-unit', text: 'Token' }),
    ]),
    el('div', { class: 'home-traffic-metrics' }, [
      metric(el, '请求', String(today.length)),
      metric(el, '成功率', rate === null ? '—' : `${rate}%`),
      metric(el, '平均耗时', today.length ? fmt.dur(average) : '—'),
    ]),
    el('div', {
      class: 'home-spark',
      attrs: { role: 'img', 'aria-label': '最近七天 Token 用量' },
    }, series.map((day) => el('div', { class: 'home-spark-col' }, [
      el('div', { class: 'home-spark-track' }, [
        el('div', {
          class: 'home-spark-bar' + (day.tokens > 0 ? '' : ' is-zero'),
          style: { height: `${day.tokens > 0 ? Math.max(8, Math.round((day.tokens / max) * 100)) : 3}%` },
          title: `${day.label} · ${compactNumber(day.tokens)} Token · ${day.requests} 次请求`,
        }),
      ]),
      el('span', { class: 'home-spark-label', text: day.label }),
    ]))),
    today.length
      ? el('div', { class: 'home-traffic-note', text: '统计来自网关终结记录，与使用量页一致' })
      : el('div', { class: 'home-traffic-note is-empty', text: '今天还没有请求：在 ChatGPT 里发起一次对话即可看到流量' }),
    el('div', { class: 'home-card-foot' }, [
      el('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        on: { click: () => ctx.navigate('usage') },
      }, [el('span', { text: '查看使用量' }), icon('chevronDown', 12)]),
    ]),
  ]);

  return el('section', { class: 'card home-traffic' }, [head, body]);
}

function metric(el, label, value) {
  return el('div', { class: 'home-metric' }, [
    el('span', { class: 'home-metric-label', text: label }),
    el('span', { class: 'home-metric-value nums', text: value }),
  ]);
}

/** 最近 N 天：优先用主进程趋势，缺日补零。 */
function lastDays(settled, trend, days) {
  const keys = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    keys.push({ key: localDayKey(d.getTime()), label: `${d.getMonth() + 1}/${d.getDate()}` });
  }
  const known = new Map();
  if (Array.isArray(trend) && trend.length) {
    for (const row of trend) known.set(String(row.day || ''), { tokens: row.tokens, requests: row.requests });
  } else {
    for (const entry of settled) {
      const key = localDayKey(Number(entry.at));
      const current = known.get(key) || { tokens: 0, requests: 0 };
      current.tokens += tokenTotal(entry);
      current.requests += 1;
      known.set(key, current);
    }
  }
  return keys.map(({ key, label }) => {
    const row = known.get(key) || { tokens: 0, requests: 0 };
    return { label, tokens: Number(row.tokens) || 0, requests: Number(row.requests) || 0 };
  });
}

// ============ 提供商清单 ============
function providersCard(ctx) {
  const { el, icon, state } = ctx;
  const providers = state.providers || [];
  const visible = providers.slice(0, 4);
  const totalModels = providers.reduce((sum, p) => sum + (p.models || []).length, 0);

  const head = el('header', { class: 'card-head' }, [
    icon('server', 14),
    el('span', { class: 'card-title', text: '提供商' }),
    el('span', { class: 'card-desc', text: providers.length ? `${providers.length} 个 · ${totalModels} 个模型` : '还没有接入任何接口' }),
    el('span', { class: 'right' }),
    el('button', {
      class: 'btn btn-sm btn-ghost',
      type: 'button',
      on: { click: () => ctx.navigate('providers') },
    }, [el('span', { text: '管理全部' })]),
  ]);

  const list = visible.length
    ? el('ul', { class: 'home-provider-list' }, visible.map((provider) => {
      const models = provider.models || [];
      const enabled = models.filter((m) => m.enabled !== false).length;
      return el('li', { class: 'home-provider-row' + (provider.enabled === false ? ' is-off' : '') }, [
        el('span', { class: 'dot ' + (provider.enabled === false ? 'dot-off' : enabled ? 'dot-ok' : 'dot-warn') }),
        el('div', { class: 'home-provider-main' }, [
          el('span', { class: 'home-provider-name ellipsis', text: provider.name || '(未命名)' }),
          el('span', { class: 'home-provider-url mono ellipsis', title: provider.baseUrl || '', text: provider.baseUrl || '未填写 Base URL' }),
        ]),
        el('span', { class: 'home-provider-count', text: `${enabled}/${models.length} 个模型` }),
        el('button', {
          class: 'btn btn-icon home-provider-edit',
          type: 'button',
          title: `编辑「${provider.name || '未命名'}」`,
          attrs: { 'aria-label': `编辑提供商 ${provider.name || '未命名'}` },
          on: { click: () => ctx.openProviderForm(provider.id) },
        }, [icon('pencil', 13)]),
      ]);
    }))
    : el('div', { class: 'home-provider-empty' }, [
        el('span', { text: '还没有提供商。添加第一个接口后，模型会出现在这里并流向网关。' }),
        el('button', {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          on: { click: () => ctx.openProviderForm(null) },
        }, [icon('plus', 13), el('span', { text: '添加提供商' })]),
      ]);

  return el('section', { class: 'card home-providers' }, [head, list]);
}

// ============ 快捷入口 ============
function shortcutsCard(ctx) {
  const { el, icon, state } = ctx;
  const gateway = state.gateway || (state.status && state.status.gateway) || {};
  const address = gateway.running ? gatewayAddress(gateway) : '';

  const action = (iconName, title, desc, onClick, disabled) => el('button', {
    class: 'home-shortcut',
    type: 'button',
    disabled: disabled ? true : null,
    on: { click: onClick },
  }, [
    el('span', { class: 'home-shortcut-icon' }, [icon(iconName, 14)]),
    el('span', { class: 'home-shortcut-copy' }, [
      el('span', { class: 'home-shortcut-title', text: title }),
      el('span', { class: 'home-shortcut-desc', text: desc }),
    ]),
    el('span', { class: 'home-shortcut-arrow' }, [icon('chevronDown', 12)]),
  ]);

  return el('section', { class: 'card home-shortcuts' }, [
    el('header', { class: 'card-head' }, [
      icon('plug', 14),
      el('span', { class: 'card-title', text: '快捷入口' }),
    ]),
    el('div', { class: 'home-shortcut-list' }, [
      action('copy', '复制网关地址', address || '网关运行时可用', () => void ctx.copyText(address, '网关地址'), !address),
      action('folder', '打开 Codex 配置目录', '查看模型清单与配置文件', () => void openCodexFolder(ctx)),
      action('box', '管理注入的模型', '启停、排序与默认模型', () => ctx.navigate('models')),
      action('server', '网关与端口设置', '开关、端口、探活与还原注入', () => ctx.navigate('settings')),
    ]),
  ]);
}

async function openCodexFolder(ctx) {
  try {
    const res = await ctx.api.openCodexFolder();
    if (res && res.ok) ctx.toast('已在资源管理器中打开 Codex 配置目录', 'ok');
    else ctx.toast(`打开目录失败：${(res && res.error) || '未知错误'}`, 'error');
  } catch (err) {
    ctx.toastError(err, '打开 Codex 目录失败');
  }
}

async function openCodexConfig(ctx) {
  try {
    const res = await ctx.api.openCodexConfig();
    if (res && res.ok) ctx.toast('已用默认编辑器打开 Codex 配置文件', 'ok');
    else ctx.toast(`打开配置文件失败：${(res && res.error) || '未知错误'}`, 'error');
  } catch (err) {
    ctx.toastError(err, '打开 Codex 配置文件失败');
  }
}

// 右上角 Codex 入口：主按钮默认打开配置文件夹，右侧小箭头展开二级菜单，
// 在「打开配置文件夹 / 打开配置文件」之间选择；点菜单外或按 Esc 收起。
function codexSplitButton(ctx) {
  const { el, icon } = ctx;
  let open = false;

  const menuItem = (iconName, label, run) => el('button', {
    class: 'codex-split-item',
    type: 'button',
    attrs: { role: 'menuitem' },
    on: { click: () => { setOpen(false); run(); } },
  }, [
    icon(iconName, 12),
    el('span', { class: 'codex-split-item-label', text: label }),
  ]);

  const menu = el('div', {
    class: 'codex-split-menu',
    attrs: { role: 'menu', 'aria-label': '选择打开 Codex 配置的方式' },
  }, [
    menuItem('folder', '打开配置文件夹', () => void openCodexFolder(ctx)),
    menuItem('code', '打开配置文件', () => void openCodexConfig(ctx)),
  ]);

  const caret = el('button', {
    class: 'codex-split-caret',
    type: 'button',
    attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': '选择打开 Codex 配置的方式' },
    on: { click: () => setOpen(!open) },
  }, [icon('chevronDown', 12)]);

  const wrapper = el('div', { class: 'codex-split' }, [
    el('button', {
      class: 'btn btn-ghost btn-sm codex-split-main',
      type: 'button',
      title: '默认打开 Codex 配置文件夹；右侧小箭头可选择打开配置文件',
      on: { click: () => void openCodexFolder(ctx) },
    }, [icon('folder', 13), el('span', { text: 'Codex 配置' })]),
    caret,
    menu,
  ]);

  function setOpen(next) {
    open = next;
    wrapper.classList.toggle('is-open', open);
    caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
  }
  function onOutside(event) {
    if (!wrapper.contains(event.target)) setOpen(false);
  }
  function onKey(event) {
    if (event.key === 'Escape') setOpen(false);
  }
  return wrapper;
}

// ============ 动作 ============
async function toggleInject(ctx, next) {
  if (viewState.injectBusy) return;
  const s = chainState(ctx);
  if (next) {
    if (!s.enabledModels) {
      ctx.toast('没有已启用的模型：请先在「模型」页启用至少一个模型', 'warn');
      ctx.navigate('models');
      return;
    }
    if (!s.gateway.enabled) {
      ctx.toast('本地网关没有启用：ChatGPT 需要通过它访问你的模型', 'warn');
      ctx.navigate('settings');
      return;
    }
    if (!s.gateway.running) {
      ctx.toast('本地网关未运行：先到设置页启动网关再注入', 'warn');
      ctx.navigate('settings');
      return;
    }
  }
  viewState.injectBusy = true;
  try {
    const status = await ctx.api.setInject({ enabled: next });
    if (status && typeof status === 'object') {
      ctx.state.status = status;
      if (status.inject) ctx.state.inject = { ...(ctx.state.inject || {}), ...status.inject };
    }
    ctx.markRelaunchNeeded();
    const msg = next
      ? `已注入 ${s.enabledModels} 个模型，重启 ChatGPT 客户端后生效`
      : '已还原：ChatGPT 回到官方模型';
    ctx.toast(msg, next ? 'ok' : 'warn');
    ctx.logLocal(next ? 'info' : 'warn', msg);
  } catch (err) {
    ctx.toastError(err, '修改注入状态失败');
  } finally {
    viewState.injectBusy = false;
    await ctx.reload('home');
  }
}

// ============ 重启 ChatGPT（首屏「下一步」） ============
// 真正的重启流程在 app.js：它统一负责 toast、运行日志、待重启状态复位与侧栏重绘。
// 首屏这里只负责按钮自身的两段式确认、忙碌态和结束后的重绘，避免复制一份 IPC 状态机。

/** 不用 window 也能跑（测试环境里 window 可能只是个极简替身）。 */
function relaunchSchedule(fn, ms) {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') return window.setTimeout(fn, ms) || 0;
  return setTimeout(fn, ms) || 0;
}

function relaunchCancel(id) {
  if (!id) return;
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') window.clearTimeout(id);
  else clearTimeout(id);
}

function setNextActionLabel(button, text) {
  if (!button) return;
  const label = button.firstElementChild;
  if (label) label.textContent = text;
  else button.textContent = text;
}

function setNextActionTitle(button, text) {
  if (!button) return;
  button.setAttribute('title', text);
}

function removeButtonAttr(button, name) {
  if (!button) return;
  if (typeof button.removeAttribute === 'function') button.removeAttribute(name);
  else if (button.attributes) delete button.attributes[name];
}

/** 忙碌态：禁用按钮、标记 aria-busy、把文案切到「重启中…」。 */
function setNextActionBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.disabled = true;
    if (button.classList) {
      button.classList.remove('is-confirming');
      button.classList.add('is-busy');
    }
    button.setAttribute('aria-busy', 'true');
    setNextActionLabel(button, RELAUNCH_BUSY_TEXT);
    setNextActionTitle(button, RELAUNCH_BUSY_TITLE);
    return;
  }
  button.disabled = false;
  if (button.classList) button.classList.remove('is-busy');
  removeButtonAttr(button, 'aria-busy');
  setNextActionLabel(button, RELAUNCH_ACTION_TEXT);
  setNextActionTitle(button, RELAUNCH_TITLE);
}

function clearRelaunchConfirmTimer() {
  relaunchCancel(relaunchConfirmTimer);
  relaunchConfirmTimer = 0;
}

/**
 * 放弃确认态。restoreLabel 为 false 时保留当前文案（紧接着要切「重启中…」）。
 */
function disarmRelaunchConfirm(restoreLabel = true) {
  relaunchConfirmArmed = false;
  clearRelaunchConfirmTimer();
  const button = relaunchConfirmButton;
  relaunchConfirmButton = null;
  if (!button) return;
  if (button.classList) button.classList.remove('is-confirming');
  if (restoreLabel && !relaunchBusy) {
    setNextActionLabel(button, RELAUNCH_ACTION_TEXT);
    setNextActionTitle(button, RELAUNCH_TITLE);
  }
}

/** 第一次点击：只把按钮切成「确认重启？」，6 秒内没有再次点击就自动复原。 */
function armRelaunchConfirm(button) {
  relaunchConfirmArmed = true;
  relaunchConfirmButton = button || null;
  if (button) {
    if (button.classList) button.classList.add('is-confirming');
    setNextActionLabel(button, RELAUNCH_CONFIRM_TEXT);
    setNextActionTitle(button, RELAUNCH_CONFIRM_TITLE);
  }
  clearRelaunchConfirmTimer();
  relaunchConfirmTimer = relaunchSchedule(() => {
    relaunchConfirmTimer = 0;
    disarmRelaunchConfirm();
  }, RELAUNCH_CONFIRM_MS);
}

/**
 * 调真正的重启入口：优先 app.js 通过 ctx 暴露的全局流程（已经负责提示与状态复位）；
 * 只有在上下文里没有这个入口时才直接走 IPC，并自行提示。
 */
async function callRelaunch(ctx) {
  if (typeof ctx.relaunchChatGpt === 'function') {
    const ok = await ctx.relaunchChatGpt();
    return { ok: ok === true, handled: true };
  }
  if (!ctx.api || typeof ctx.api.relaunchChatGpt !== 'function') {
    throw new Error('当前环境不支持重启 ChatGPT 客户端');
  }
  const res = await ctx.api.relaunchChatGpt();
  return { ok: !!(res && res.ok), error: (res && res.error) || '', handled: false };
}

/**
 * 首屏底部的「重启 ChatGPT」：两段式确认，确认后结束并重新启动 ChatGPT.exe。
 * @param {object} ctx 视图上下文
 * @param {HTMLButtonElement} [button] 触发点的按钮节点，用于切换文案与忙碌态
 */
async function restartChatGpt(ctx, button) {
  if (relaunchBusy) return;
  // 第一次点击只进入确认态。页面重绘后按钮节点已经换了：同样必须重新确认，
  // 绝不在用户没看到「确认重启？」的新按钮上直接结束 ChatGPT 进程。
  if (!relaunchConfirmArmed || relaunchConfirmButton !== button) {
    if (relaunchConfirmArmed) disarmRelaunchConfirm();
    armRelaunchConfirm(button);
    return;
  }
  disarmRelaunchConfirm(false);
  relaunchBusy = true;
  setNextActionBusy(button, true);
  try {
    const result = await callRelaunch(ctx);
    if (result.ok) {
      // 走 app.js 的全局流程时它已经吐过提示与日志，这里不再重复一遍。
      if (!result.handled) {
        ctx.toast('已重启 ChatGPT 客户端：新的模型清单已加载', 'ok');
        ctx.logLocal('info', '已重启 ChatGPT 客户端并加载新的模型清单');
      }
    } else if (!result.handled) {
      ctx.toast(`重启失败：${result.error || '未知错误'}`, 'error');
    }
  } catch (err) {
    ctx.toastError(err, '重启 ChatGPT 失败');
  } finally {
    relaunchBusy = false;
    setNextActionBusy(button, false);
    // 无论成败都重绘首屏：成功后「配置已修改」提示应消失，失败后按钮要恢复可点。
    try {
      if (typeof ctx.reload === 'function') await ctx.reload('home');
      else if (typeof ctx.renderCurrent === 'function') ctx.renderCurrent(true);
    } catch (err) {
      ctx.toastError(err, '刷新总览失败');
    }
  }
}

