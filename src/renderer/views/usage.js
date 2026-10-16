// 使用量页：从主进程已持久化的网关完成日志聚合请求数、Token 与响应耗时。

const viewState = { range: 'all', display: '20' };

function tokenValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstToken(...values) {
  for (const value of values) {
    const n = tokenValue(value);
    if (n !== null) return n;
  }
  return 0;
}

function tokenMetrics(entry) {
  const usage = entry?.tokens && typeof entry.tokens === 'object' ? entry.tokens : {};
  const input = firstToken(usage.input_tokens, usage.prompt_tokens);
  const output = firstToken(usage.output_tokens, usage.completion_tokens);
  const cached = firstToken(
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
  );
  const cacheWrite = firstToken(
    usage.input_tokens_details?.cache_write_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_write_tokens,
  );
  const reasoning = firstToken(
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens,
  );
  const total = tokenValue(usage.total_tokens);
  return {
    input,
    cached,
    cacheWrite,
    output,
    reasoning,
    total: total === null ? input + output : total,
  };
}

function tokenCount(entry) {
  return tokenMetrics(entry).total;
}

function inputTokenCount(entry) {
  return tokenMetrics(entry).input;
}

function cachedTokenCount(entry) {
  return tokenMetrics(entry).cached;
}

function cacheWriteTokenCount(entry) {
  return tokenMetrics(entry).cacheWrite;
}

function reasoningTokenCount(entry) {
  return tokenMetrics(entry).reasoning;
}

function requestModelName(entry) {
  const model = String(entry?.upstreamModel || entry?.model || '').split('__').at(-1);
  const provider = String(entry?.providerName || entry?.providerId || '未知渠道');
  return model ? `${provider} · ${model}` : provider;
}

/** 返回模型统计的稳定键，兼容旧 providerId slug 与新 providerName slug。 */
function modelBreakdownKey(entry) {
  const provider = String(entry?.providerId || entry?.providerName || '未知渠道');
  const model = String(entry?.upstreamModel || entry?.model || '').split('__').at(-1) || '未标记';
  return `${provider}\u001f${model}`;
}

function hasCacheUsage(entry) {
  const usage = entry?.tokens && typeof entry.tokens === 'object' ? entry.tokens : {};
  return entry?.cacheUsageAvailable === true ||
    Object.prototype.hasOwnProperty.call(usage, 'cached_tokens') ||
    Object.prototype.hasOwnProperty.call(usage, 'cache_read_input_tokens') ||
    Object.prototype.hasOwnProperty.call(usage, 'cache_creation_input_tokens') ||
    Object.prototype.hasOwnProperty.call(usage, 'cache_write_tokens') ||
    Object.prototype.hasOwnProperty.call(usage.input_tokens_details || {}, 'cached_tokens') ||
    Object.prototype.hasOwnProperty.call(usage.input_tokens_details || {}, 'cache_write_tokens') ||
    Object.prototype.hasOwnProperty.call(usage.prompt_tokens_details || {}, 'cached_tokens') ||
    cachedTokenCount(entry) > 0 ||
    cacheWriteTokenCount(entry) > 0;
}

function cacheHitRate(entry) {
  if (!hasCacheUsage(entry)) return null;
  const input = inputTokenCount(entry);
  if (input <= 0) return null;
  const cached = Math.max(0, cachedTokenCount(entry));
  return Math.min(100, (cached / input) * 100);
}

function cacheHitRateText(entry) {
  const rate = cacheHitRate(entry);
  return rate === null ? '—' : `${rate.toFixed(1)}%`;
}

function completedRows(state) {
  const source = Array.isArray(state.usage) && state.usage.length ? state.usage : state.logs;
  return (source || [])
    .filter(isFinalResultEntry)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

/**
 * 所有「已经出结果」的网关请求日志：开始请求那条 status 是 0（还在飞），
 * 失败/客户端中断的是 4xx/5xx，成功是 200。成功率的分母必须是这些，
 * 只在 completedRows() 上算比例会永远是 100%。
 */
function settledRows(state) {
  return completedRows(state);
}

/** 网关一条请求会记录开始、上游响应和最终结果多条日志。只有最终日志才参与成功率。 */
function isFinalResultEntry(entry) {
  if (!entry || (!entry.providerId && !entry.providerName && !entry.model) || !Number.isFinite(Number(entry.at))) return false;
  const status = Number(entry.status);
  if (!Number.isFinite(status) || status <= 0) return false;
  if (entry.final === true || entry.usageRecord === true) return true;
  const message = String(entry.msg || '');
  if (/^(开始请求|上游返回 HTTP|上游拒绝可选参数)/.test(message)) return false;
  if (status === 200) return message.startsWith('完成 ') || !!entry.tokens || !message;
  if (message.startsWith('请求异常:')) return false;
  return message.startsWith('客户端中断:') || message.startsWith('流式转发失败:') ||
    message.startsWith('上游请求失败:') || message.startsWith('上游返回失败事件:') || Number(entry.ms) > 0;
}

function isSuccessStatus(status) {
  const value = Number(status);
  return Number.isFinite(value) && value >= 200 && value < 300;
}

function usageSource(entry) {
  if (!entry?.tokens) return '—';
  return entry.estimatedUsage === true ? '估算' : '上游';
}

function usageSourceClass(entry) {
  if (!entry?.tokens) return 'muted';
  return entry.estimatedUsage === true ? 'chip chip-warn' : 'chip chip-ok';
}

/** 本地时区的 YYYY-MM-DD：toISOString() 会按 UTC 切日，UTC+8 下今天的数据会被归错天 */
function localDayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rangeStart(range, now = Date.now()) {
  if (range === '24h') return now - 24 * 60 * 60 * 1000;
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  return 0;
}

function displayLimit(display, total) {
  if (display === 'all') return total;
  const limit = Number(display);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
}

function compactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 1 : 2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}K`;
  return String(Math.round(n));
}

function duration(ms, fmt) {
  return ms > 0 ? fmt.dur(ms) : '—';
}

function statCard(el, iconNode, label, value, detail, tone) {
  return el('article', { class: `usage-stat usage-stat-${tone}` }, [
    el('div', { class: 'usage-stat-icon' }, [iconNode]),
    el('div', { class: 'usage-stat-copy' }, [
      el('div', { class: 'usage-stat-label', text: label }),
      el('div', { class: 'usage-stat-value nums', text: value }),
      el('div', { class: 'usage-stat-detail', text: detail }),
    ]),
  ]);
}

function heatmapLevel(value, max) {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.35) return 2;
  if (ratio <= 0.65) return 3;
  return 4;
}

function buildTrend(el, rows) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay = new Date(today);
  firstDay.setDate(firstDay.getDate() - 364);
  firstDay.setDate(firstDay.getDate() - firstDay.getDay());

  const byDay = new Map();
  for (const row of rows) {
    const key = localDayKey(Number(row.at || 0));
    const day = byDay.get(key) || { value: 0, requests: 0 };
    day.value += tokenCount(row);
    day.requests += 1;
    byDay.set(key, day);
  }

  const weeks = [];
  const cursor = new Date(firstDay);
  while (cursor <= today) {
    const week = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(cursor);
      date.setDate(date.getDate() + weekday);
      const key = localDayKey(date.getTime());
      const stats = byDay.get(key) || { value: 0, requests: 0 };
      week.push({ date, key, ...stats, isFuture: date > today });
    }
    weeks.push(week);
    cursor.setDate(cursor.getDate() + 7);
  }

  const max = Math.max(0, ...weeks.flatMap((week) => week.map((day) => day.value)));
  const monthMarkers = [];
  const seenMonths = new Set();
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    for (const day of weeks[weekIndex]) {
      const monthKey = `${day.date.getFullYear()}-${day.date.getMonth()}`;
      if (seenMonths.has(monthKey)) continue;
      seenMonths.add(monthKey);
      monthMarkers.push({ weekIndex, label: `${day.date.getMonth() + 1}月` });
    }
  }

  const monthRow = el('div', { class: 'usage-heatmap-months', style: { '--heatmap-weeks': weeks.length } }, monthMarkers.map((marker) => el('span', {
    class: 'usage-heatmap-month',
    text: marker.label,
    style: { 'grid-column': `${marker.weekIndex + 1}` },
  })));
  const cells = [];
  for (const week of weeks) {
    for (const day of week) {
      const level = day.isFuture ? 0 : heatmapLevel(day.value, max);
      const detail = day.isFuture ? '暂无数据' : `${compactNumber(day.value)} tokens · ${day.requests} 次请求`;
      cells.push(el('span', {
        class: `usage-heatmap-cell usage-heatmap-level-${level}${day.isFuture ? ' is-future' : ''}`,
        attrs: {
          'data-date': day.key,
          'data-requests': day.requests,
          'data-tooltip': `${day.key} · ${detail}`,
          'aria-label': `${day.key} · ${detail}`,
          tabindex: '0',
        },
      }));
    }
  }
  const grid = el('div', { class: 'usage-heatmap-grid', style: { '--heatmap-weeks': weeks.length }, attrs: { role: 'img', 'aria-label': '近一年 Token 使用热力图' } }, cells);
  const legend = el('div', { class: 'usage-heatmap-legend', attrs: { 'aria-label': 'Token 使用量颜色图例' } }, [
    el('span', { class: 'usage-heatmap-legend-label', text: '少' }),
    ...[1, 2, 3, 4].map((level) => el('i', { class: `usage-heatmap-cell usage-heatmap-level-${level}`, attrs: { 'aria-hidden': 'true' } })),
    el('span', { class: 'usage-heatmap-legend-label', text: '多' }),
  ]);
  return el('div', { class: 'usage-heatmap-scroll' }, [el('div', { class: 'usage-heatmap-frame' }, [monthRow, grid, legend])]);
}

function breakdown(el, rows, title, key, emptyText) {
  const groups = new Map();
  for (const row of rows) {
    const groupKey = key === 'model' ? modelBreakdownKey(row) : String(row[key] || '未标记');
    const name = key === 'model' ? requestModelName(row) : String(row[key] || '未标记');
    const current = groups.get(groupKey) || { name, requests: 0, tokens: 0, ms: 0 };
    current.requests += 1;
    current.tokens += tokenCount(row);
    current.ms += Number(row.ms) || 0;
    groups.set(groupKey, current);
  }
  const list = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  return el('section', { class: 'card usage-breakdown' }, [
    el('header', { class: 'card-head' }, [el('span', { class: 'card-title', text: title }), el('span', { class: 'card-desc', text: `${list.length} 项` })]),
    list.length ? el('div', { class: 'usage-list' }, [
      el('div', { class: 'usage-list-row usage-list-head' }, ['名称', '请求', 'Token', '平均耗时'].map((text) => el('span', { text }))),
      ...list.map((item) => el('div', { class: 'usage-list-row' }, [
        el('div', { class: 'usage-list-name ellipsis', text: item.name }),
        el('div', { class: 'usage-list-metric nums', text: `${item.requests} 次` }),
        el('div', { class: 'usage-list-metric nums', text: compactNumber(item.tokens) }),
        el('div', { class: 'usage-list-metric muted nums', text: `${Math.round(item.ms / item.requests)}ms` }),
      ])),
    ]) : el('div', { class: 'usage-empty', text: emptyText }),
  ]);
}

/** 渲染使用量页。统计范围受主进程日志环大小限制，页面明确展示该边界。 */
export function renderUsage(root, ctx, actions) {
  const { el, icon, state, fmt } = ctx;
  const allRows = completedRows(state);
  const now = Date.now();
  // allRows 按时间倒序，最后一条就是已持久化历史里最早的那次请求
  const oldestDay = allRows.length ? localDayKey(Number(allRows[allRows.length - 1].at || 0)) : null;
  const start = rangeStart(viewState.range, now);
  const rows = allRows.filter((entry) => Number(entry.at) >= start);
  const totalTokens = rows.reduce((sum, row) => sum + tokenCount(row), 0);
  const inputTokens = rows.reduce((sum, row) => sum + inputTokenCount(row), 0);
  const outputTokens = rows.reduce((sum, row) => sum + tokenMetrics(row).output, 0);
  const cacheRows = rows.filter(hasCacheUsage);
  // 分母用全部有输入 token 的请求，而不是「带回读 usage 的那些」：
  // 只拿命中缓存的样本算比例会把命中率算得虚高。
  const cacheInputRows = rows.filter((row) => inputTokenCount(row) > 0);
  const cachedTokens = rows.reduce((sum, row) => sum + cachedTokenCount(row), 0);
  const cacheInputTokens = cacheInputRows.reduce((sum, row) => sum + inputTokenCount(row), 0);
  const cacheRate = cacheInputTokens > 0 ? Math.min(100, Math.round((cachedTokens / cacheInputTokens) * 100)) : null;
  const averageMs = rows.length ? rows.reduce((sum, row) => sum + (Number(row.ms) || 0), 0) / rows.length : 0;
  const settled = settledRows(state).filter((entry) => Number(entry.at) >= start);
  const successCount = settled.filter((entry) => isSuccessStatus(entry.status)).length;
  const failedCount = settled.length - successCount;
  const successRate = settled.length ? Math.round((successCount / settled.length) * 100) : 0;

  actions.replaceChildren(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => ctx.reload('usage') } }, [icon('refresh', 13), el('span', { text: '刷新统计' })]));

  const range = el('select', { class: 'select usage-range', value: viewState.range, attrs: { 'aria-label': '统计时间范围' }, on: { change: (e) => { viewState.range = e.target.value; ctx.renderCurrent(true); } } }, [
    el('option', { value: 'all', text: '全部历史' }),
    el('option', { value: '24h', text: '最近 24 小时' }),
    el('option', { value: '7d', text: '最近 7 天' }),
  ]);
  const display = el('select', { class: 'select usage-display', value: viewState.display, attrs: { 'aria-label': '显示请求条数' }, on: { change: (e) => { viewState.display = e.target.value; ctx.renderCurrent(true); } } }, [
    el('option', { value: '20', text: '显示 20 条' }),
    el('option', { value: '50', text: '显示 50 条' }),
    el('option', { value: '100', text: '显示 100 条' }),
    el('option', { value: '200', text: '显示 200 条' }),
    el('option', { value: 'all', text: '显示全部' }),
  ]);
  const rangeLabel = viewState.range === 'all' ? '全部历史' : viewState.range === '24h' ? '最近 24 小时' : '最近 7 天';
  const tableRows = rows.slice(0, displayLimit(viewState.display, rows.length));
  const header = el('div', { class: 'usage-toolbar' }, [
    el('div', { class: 'usage-toolbar-copy' }, [el('strong', { text: '网关使用概览' }), el('span', { text: `共 ${rows.length} 次请求 · ${rangeLabel}${viewState.range === 'all' && oldestDay ? `，自 ${oldestDay} 起` : ''}` })]),
    el('div', { class: 'usage-toolbar-controls' }, [range]),
  ]);
  const stats = el('div', { class: 'usage-stats' }, [
    statCard(el, icon('activity', 16), '请求数', String(rows.length), settled.length ? `成功率 ${successRate}% · 失败 ${failedCount} 次` : '暂无已出结果的请求', 'accent'),
    statCard(el, icon('box', 16), '总 Token', compactNumber(totalTokens), `输入 ${compactNumber(inputTokens)} · 输出 ${compactNumber(outputTokens)}`, 'ok'),
    statCard(el, icon('zap', 16), '平均耗时', duration(averageMs, fmt), rows.length ? '按完成请求计算' : '暂无完成请求', 'warn'),
    statCard(el, icon('server', 16), '活跃模型', String(new Set(rows.map((row) => row.model).filter(Boolean)).size), '当前筛选范围', 'codex'),
    statCard(
      el,
      icon('box', 16),
      '缓存命中率',
      cacheRate === null ? '—' : `${cacheRate}%`,
      cacheRows.length ? `缓存 ${compactNumber(cachedTokens)} / 输入 ${compactNumber(cacheInputTokens)}` : '上游未返回缓存 usage',
      'cache',
    ),
  ]);
  const trend = el('section', { class: 'card usage-trend' }, [el('header', { class: 'card-head' }, [el('span', { class: 'card-title', text: 'Token 使用趋势' }), el('span', { class: 'card-desc', text: '近一年 · 按完成时间' })]), buildTrend(el, rows)]);
  const overview = el('div', { class: 'usage-overview-grid' }, [
    trend,
    el('div', { class: 'usage-breakdown-grid' }, [
      breakdown(el, rows, '按模型', 'model', '暂无模型数据'),
      breakdown(el, rows, '按提供商', 'providerName', '暂无提供商数据'),
    ]),
  ]);
  const table = el('section', { class: 'card usage-recent' }, [
    el('header', { class: 'card-head usage-recent-head' }, [
      el('span', { class: 'card-title', text: '请求记录' }),
      el('span', { class: 'card-desc', text: `${tableRows.length} / ${rows.length}` }),
      display,
    ]),
    rows.length ? el('div', { class: 'usage-table' }, [
      el('div', { class: 'usage-table-row usage-table-head' }, ['时间', '渠道 · 模型', '未缓存输入', '缓存输入', '输出', '缓存命中率', '耗时', '状态', '缓存写入', '推理', '总 Token', '来源'].map((text) => el('span', { text }))),
      ...tableRows.map((row) => el('div', { class: 'usage-table-row' }, [
        el('span', { class: 'mono muted', text: fmt.dateTime(row.at) }), el('span', { class: 'ellipsis', text: requestModelName(row) }),
        el('span', { class: 'nums', text: compactNumber(Math.max(0, inputTokenCount(row) - cachedTokenCount(row) - cacheWriteTokenCount(row))) }),
        el('span', { class: 'nums', text: compactNumber(cachedTokenCount(row)) }),
        el('span', { class: 'nums', text: compactNumber(tokenMetrics(row).output) }),
        el('span', { class: 'nums', text: cacheHitRateText(row) }),
        el('span', { class: 'nums muted', text: duration(row.ms, fmt) }),
        el('span', { class: `chip ${isSuccessStatus(row.status) ? 'chip-ok' : 'chip-err'}`, text: `HTTP ${row.status}` }),
        el('span', { class: 'nums', text: compactNumber(cacheWriteTokenCount(row)) }),
        el('span', { class: 'nums', text: compactNumber(reasoningTokenCount(row)) }),
        el('span', { class: 'nums', text: compactNumber(tokenCount(row)) }),
        el('span', { class: usageSourceClass(row), text: usageSource(row) }),
      ])),
    ]) : el('div', { class: 'usage-empty', text: '暂无可统计的请求。网关收到请求终结结果后，这里会自动出现数据。' }),
  ]);
  root.replaceChildren(header, stats, overview, table);
}
