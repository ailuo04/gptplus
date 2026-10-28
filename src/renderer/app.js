// gpt++ 渲染层控制器：状态、路由、全局 chrome（状态栏/日志抽屉/弹窗/提示）。
//
// 安全约定（全项目遵守）：
//   1. 任何来自用户或 API 的字符串一律通过 textContent / 属性设置进入 DOM，绝不拼进 innerHTML。
//   2. 代码中唯一的 innerHTML 用法是 ICONS 表里的静态图标字面量（见 icon()）。
//   3. 没有远程资源：无 fetch、无外部字体、无 CDN（CSP 也是 default-src 'none'）。

import { renderProviders, openProviderForm, closeProviderForm, installProviderDropGuard } from './views/providers.js';
import { dragRowOffsets, dragTargetIndex, renderModels, reorderModelKeys } from './views/models.js';
import { renderUsage, usageRows } from './views/usage.js';
import { openPeerSettings, renderSettings } from './views/settings.js';
import { renderHome } from './views/home.js';
import { renderWeixin } from './views/weixin.js';
import { renderPlugins } from './views/plugins.js';

// ============ 静态图标（纯字面量，不含任何变量） ============
const SVG_OPEN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const SVG_FILL = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">';

const ICONS = Object.freeze({
  plus: SVG_OPEN + '<path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
  pencil: SVG_OPEN + '<path d="M11.2 2.7l2.1 2.1-7.1 7.1-2.9.8.8-2.9z"/><path d="M2.6 14h10.8"/></svg>',
  trash: SVG_OPEN + '<path d="M2.9 4.6h10.2"/><path d="M6.4 4.6V3.1h3.2v1.5"/><path d="M4.6 4.6l.6 8.4h5.6l.6-8.4"/></svg>',
  refresh: SVG_OPEN + '<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7"/><path d="M13.4 2.9v3.2h-3.2"/></svg>',
  eye: SVG_OPEN + '<path d="M1.9 8S4.2 4.4 8 4.4 14.1 8 14.1 8 11.8 11.6 8 11.6 1.9 8 1.9 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  eyeOff:
    SVG_OPEN +
    '<path d="M6.5 6.5A2 2 0 0 0 8 10a2 2 0 0 0 1.7-.9"/><path d="M4.1 4.5C2.6 5.5 1.9 8 1.9 8s2.3 3.6 6.1 3.6c.9 0 1.7-.2 2.4-.6"/>' +
    '<path d="M11 9.9c2-.9 3.1-1.9 3.1-1.9S12 4.4 8.2 4.4c-.5 0-1 .1-1.4.2"/><path d="M2.7 2.7l10.6 10.6"/></svg>',
  copy: SVG_OPEN + '<rect x="5.7" y="5.7" width="7.3" height="7.3" rx="1.6"/><path d="M10.3 5.7V4.3c0-.9-.7-1.6-1.6-1.6H4.3c-.9 0-1.6.7-1.6 1.6v4.4c0 .9.7 1.6 1.6 1.6h1.4"/></svg>',
  download: SVG_OPEN + '<path d="M8 2.4v7.1M5.2 7.1L8 9.9l2.8-2.8M3 12.3h10"/></svg>',
  check: SVG_OPEN + '<path d="M3.4 8.4l3 3 6.2-6.9"/></svg>',
  x: SVG_OPEN + '<path d="M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4"/></svg>',
  folder: SVG_OPEN + '<path d="M2.4 4.3h4l1.3 1.6h5.9v6.3H2.4z"/></svg>',
  power: SVG_OPEN + '<path d="M8 2.6v5.1"/><path d="M12.1 4.6a5.4 5.4 0 1 1-8.2 0"/></svg>',
  alert: SVG_OPEN + '<path d="M8 2.7l5.7 10.6H2.3z"/><path d="M8 6.5v3.1M8 11.6h.01"/></svg>',
  info: SVG_OPEN + '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.6M8 5.2h.01"/></svg>',
  zap: SVG_OPEN + '<path d="M9.1 2.3L4.4 9h3.1l-.6 4.7L11.6 7H8.4z"/></svg>',
  server: SVG_OPEN + '<rect x="2.4" y="3.1" width="11.2" height="4.1" rx="1.3"/><rect x="2.4" y="8.8" width="11.2" height="4.1" rx="1.3"/><path d="M5 5.15h.01M5 10.85h.01"/></svg>',
  chevronDown: SVG_OPEN + '<path d="M4.4 6.4L8 10l3.6-3.6"/></svg>',
  chevronUp: SVG_OPEN + '<path d="M4.4 9.6L8 6l3.6 3.6"/></svg>',
  activity: SVG_OPEN + '<path d="M1.7 8h2.8l1.9-4.3 3 8.6 1.8-4.3h3.1"/></svg>',
  box: SVG_OPEN + '<path d="M2.5 5.4L8 2.7l5.5 2.7v5.2L8 13.3l-5.5-2.7z"/><path d="M2.5 5.4L8 8.1l5.5-2.7M8 8.1v5.2"/></svg>',
  lock: SVG_OPEN + '<rect x="3.3" y="7" width="9.4" height="6.2" rx="1.2"/><path d="M5.2 7V5.1a2.8 2.8 0 0 1 5.6 0V7"/></svg>',
  dot: SVG_FILL + '<circle cx="8" cy="8" r="3"/></svg>',
  plug: SVG_OPEN + '<path d="M6 6.6V3.2M10 6.6V3.2"/><path d="M4.2 6.6h7.6v1.9a3.8 3.8 0 0 1-7.6 0z"/><path d="M8 12.3v1.4"/></svg>',
  code: SVG_OPEN + '<path d="M6.2 4.6L3 8l3.2 3.4M9.8 4.6L13 8l-3.2 3.4"/></svg>',
  sun: SVG_OPEN + '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"/></svg>',
  moon: SVG_OPEN + '<path d="M12.8 10.7A5.5 5.5 0 0 1 5.3 3.2 5.6 5.6 0 1 0 12.8 10.7z"/></svg>',
  monitor: SVG_OPEN + '<rect x="2.3" y="2.8" width="11.4" height="8" rx="1.2"/><path d="M6 13.2h4M8 10.8v2.4"/></svg>',
  wechat: SVG_OPEN + '<path d="M2.4 3.1h7.4v5.3H6.1L4 10.4V8.4H2.4z"/><path d="M6.2 8.4h7.4v5.1h-1.5v1.7l-2-1.7H6.2z"/></svg>',
  mic: SVG_OPEN + '<path d="M8 2.6a2.2 2.2 0 0 1 2.2 2.2v2.7a2.2 2.2 0 0 1-4.4 0V4.8A2.2 2.2 0 0 1 8 2.6Z"/><path d="M3.9 7.5v.4a4.1 4.1 0 0 0 8.2 0v-.4M8 12v1.5"/></svg>',
  message: SVG_OPEN + '<path d="M2.7 3.3h10.6v7.1H6.7L4.1 12.8v-2.4H2.7z"/><path d="M5.3 6.2h5.4M5.3 8.3h3.4"/></svg>',
  qr: SVG_OPEN + '<path d="M2.6 6V2.7H6M10 2.7h3.4V6M13.4 10v3.3H10M6 13.3H2.6V10"/><path d="M5.2 5.2h1.6v1.6H5.2zM9.2 9.2h1.6v1.6H9.2z"/>',
  play: SVG_OPEN + '<path d="M5.2 3.2l7 4.8-7 4.8z"/>',
  search: SVG_OPEN + '<circle cx="7.1" cy="7.1" r="4.3"/><path d="M10.4 10.4l3 3"/>',
  external: SVG_OPEN + '<path d="M9.2 2.6h4.2v4.2M13.1 2.9L7.4 8.6"/><path d="M12.1 9.5v3.1a.9.9 0 0 1-.9.9H3.7a.9.9 0 0 1-.9-.9V5.1a.9.9 0 0 1 .9-.9h3.1"/>',
});

// ============ DOM 构造helper ============
/**
 * 创建元素。props:
 *   class / text / html（仅静态字面量）/ on / attrs / data / style，其余作为属性。
 * children: 字符串（自动 textContent 转义）、节点或数组。
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const deferredControlProps = [];
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value; // 仅静态图标
    else if (key === 'on') {
      for (const [evt, fn] of Object.entries(value)) node.addEventListener(evt, fn);
    } else if (key === 'attrs') {
      for (const [attr, val] of Object.entries(value)) {
        if (val === null || val === undefined || val === false) continue;
        node.setAttribute(attr, val === true ? '' : String(val));
      }
    } else if (key === 'data') {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = String(dv);
    } else if (key === 'style') {
      for (const [sk, sv] of Object.entries(value)) node.style.setProperty(sk, String(sv));
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      // 子节点挂载后再设置控件属性，避免 select 在 option 存在前回落到第一项。
      deferredControlProps.push([key, value]);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  // 表单控件走属性赋值；textarea 的 value 必须使用 property。
  for (const [key, value] of deferredControlProps) {
    if (key in node) {
      node[key] = key === 'value' ? String(value) : Boolean(value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return node;
}

// 判断是不是 DOM 节点：不依赖全局 Node 构造器，避免在非浏览器环境里直接 ReferenceError
function isDomNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
}

function appendChildren(node, children) {
  if (children === null || children === undefined || children === false) return node;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(isDomNode(child) ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, size = 14) {
  const wrap = el('span', { class: 'icon', html: ICONS[name] || ICONS.dot });
  const svg = wrap.firstElementChild;
  if (svg) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  return wrap;
}

// 共享下拉选择器：避免原生 option 弹层脱离应用主题，统一使用渲染层自己的 listbox。
let pickerSequence = 0;

function createSelectPicker(ctx, config = {}) {
  const { el: createElement, icon: createIcon } = ctx;
  const options = Array.isArray(config.options) ? config.options.map((option) => ({
    value: String(option?.value ?? ''),
    label: String(option?.label ?? option?.value ?? ''),
  })) : [];
  const pickerId = `select-picker-${++pickerSequence}`;
  const selectedValue = String(config.value ?? '');
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
  let activeIndex = selectedIndex;
  let open = false;

  const wrapper = createElement('div', { class: `select-picker${config.className ? ` ${config.className}` : ''}` });
  // 保留一个不可见的原生 select 作为表单/自动化语义镜像；实际视觉和展开菜单由下方 listbox 负责。
  const nativeSelect = createElement('select', {
    class: 'select-picker-native',
    value: selectedValue,
    attrs: {
      'aria-label': config.ariaLabel || '选择选项',
      'aria-hidden': 'true',
      tabindex: '-1',
    },
    on: {
      change: (event) => {
        const index = options.findIndex((option) => option.value === String(event.target.value));
        if (index >= 0) choose(index);
      },
    },
  }, options.map((option) => createElement('option', { value: option.value, text: option.label })));
  const button = createElement('button', {
    class: 'select-picker-trigger',
    type: 'button',
    disabled: config.disabled ? true : null,
    attrs: {
      role: 'combobox',
      'aria-label': config.ariaLabel || '选择选项',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': pickerId,
    },
  });
  const valueNode = createElement('span', { class: 'select-picker-value' });
  const valueLabel = createElement('span', { class: 'select-picker-label' });
  const chevron = createElement('span', { class: 'select-picker-chevron' }, [createIcon('chevronDown', 14)]);
  valueNode.append(valueLabel);
  button.append(valueNode, chevron);

  const menu = createElement('div', {
    class: 'select-picker-menu',
    id: pickerId,
    attrs: { role: 'listbox', 'aria-label': config.ariaLabel || '可选项' },
  });

  function updateValue(index) {
    const option = options[index] || options[0];
    valueLabel.textContent = option ? option.label : '暂无可选项';
    if (option) nativeSelect.value = option.value;
    button.setAttribute('aria-activedescendant', option ? `${pickerId}-${index}` : '');
  }

  function updateActive(index) {
    if (!options.length) return;
    activeIndex = Math.max(0, Math.min(options.length - 1, index));
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
    const option = options[index];
    if (!option) return;
    close();
    button.focus();
    config.onChange?.(option.value);
  }

  function openMenu() {
    if (open || button.disabled || !options.length) return;
    open = true;
    wrapper.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    updateActive(activeIndex);
    document.addEventListener?.('pointerdown', onDocumentPointerDown, true);
  }

  function onDocumentPointerDown(event) {
    if (!wrapper.contains?.(event.target)) close();
  }

  options.forEach((option, index) => {
    menu.appendChild(createElement('button', {
      class: 'select-picker-option',
      type: 'button',
      id: `${pickerId}-${index}`,
      data: { index },
      attrs: { role: 'option', 'aria-selected': index === selectedIndex ? 'true' : 'false' },
      on: {
        click: () => choose(index),
        pointerenter: () => updateActive(index),
      },
    }, [
      createElement('span', { class: 'select-picker-option-label', text: option.label }),
      createElement('span', { class: `select-picker-option-check${index === selectedIndex ? ' is-selected' : ''}` }, [createIcon('check', 14)]),
    ]));
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
      updateActive(options.length - 1);
    }
  });

  updateValue(selectedIndex);
  updateActive(selectedIndex);
  wrapper.append(nativeSelect, button, menu);
  return wrapper;
}

// ============ 工具 ============
const fmt = {
  clock(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  dateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmt.clock(ts)}`;
  },
  rel(ts) {
    if (!ts) return '从未';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    if (diff < 15000) return '刚刚';
    if (diff < 60000) return `${Math.round(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
    return fmt.dateTime(ts);
  },
  dur(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1000) return `${Math.round(n)}ms`;
    return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`;
  },
};

function maskKey(raw) {
  const s = String(raw || '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(Math.max(6, s.length));
  return `${s.slice(0, 3)}${'•'.repeat(8)}${s.slice(-4)}`;
}

function shortPath(p) {
  const s = String(p || '');
  return s.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
}

function describeError(err, fallback = '操作失败') {
  if (!err) return fallback;
  const msg = err && err.message ? err.message : String(err);
  return msg && msg.trim() ? msg : fallback;
}

// ============ 应用状态 ============
const state = {
  view: 'home',
  // preload 会在 CSS 首次计算前写入该属性；这里同步沿用，避免首屏先落到深色。
  theme: typeof document !== 'undefined'
    ? (document.documentElement.dataset.themeMode || document.documentElement.dataset.theme || 'dark')
    : 'dark',
  status: null,
  providers: [],
  models: [],
  modelLimits: null,
  gateway: null,
  network: null,
  startup: null,
  inject: null,
  peer: null,
  logs: [],
  usage: [],
  usageTrend: [],
  logOpen: false,
  logFilter: 'all',
  logPaused: false,
  pendingRelaunch: false,
  relaunchNeeded: false,
  weixin: null,
  plugins: [],
  update: {
    enabled: false,
    status: 'idle',
    currentVersion: null,
    version: null,
    releaseDate: null,
    percent: 0,
    error: null,
    rollbackTarget: null,
    rollbackReleases: null,
    lastCheckedAt: null,
    checkIntervalMinutes: 60,
    initialCheckDelayMinutes: 2,
  },
  loaded: { status: false, providers: false, models: false, modelLimits: false, gateway: false, inject: false, peer: false, startup: false, update: false, logs: false, usage: false, weixin: false, plugins: false },
};

const THEME_MODES = new Set(['dark', 'light', 'system']);
let systemThemeQuery = null;

function normalizeThemeMode(value) {
  return THEME_MODES.has(value) ? value : 'dark';
}

function applyTheme(mode) {
  if (typeof document === 'undefined') return;
  const selected = normalizeThemeMode(mode);
  const resolved = selected === 'system'
    && typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : selected === 'system' ? 'dark' : selected;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = selected;
}

function onSystemThemeChange() {
  if (state.theme === 'system') applyTheme('system');
}

function syncSystemThemeListener() {
  if (systemThemeQuery && typeof systemThemeQuery.removeEventListener === 'function') {
    systemThemeQuery.removeEventListener('change', onSystemThemeChange);
  }
  systemThemeQuery = null;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || state.theme !== 'system') return;
  systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');
  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', onSystemThemeChange);
  }
}

function setThemePreference(value) {
  state.theme = normalizeThemeMode(value);
  syncSystemThemeListener();
  applyTheme(state.theme);
  return state.theme;
}

/** 日志抽屉里最多渲染多少行 DOM。只约束界面，不约束统计。 */
const LOG_DRAW_LIMIT = 300;
/** 与主进程 log-store 的 LOG_RING_SIZE 对齐：使用量页要看到全部历史 */
const LOG_STATE_LIMIT = 20000;
const MAX_TOASTS = 4;

let api = null;
let subscribed = false;
let relaunchTimer = 0;
let relaunchBusy = false;
let themeSaveBusy = false;
let networkSaveBusy = false;
let startupSaveBusy = false;
let networkFocusMode = null;
let observedWriteAt = 0;
let updatePromptedVersion = null;
let updateModalSync = null;
let viewTransitionToken = 0;
let viewSwitchFrame = 0;
let viewSwitchTimer = 0;
const VIEW_SWITCH_MS = 120;

const dom = {};

// ============ 轻提示 ============
function toast(message, kind = 'info', ttlOverride) {
  const root = dom.toastRoot;
  if (!root) return;
  const iconName = kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : kind === 'error' ? 'alert' : 'info';
  const ttl = ttlOverride ?? (kind === 'error' ? 6500 : kind === 'warn' ? 5000 : 3400);
  const node = el('div', {
    class: `toast toast-${kind}`,
    attrs: { role: 'status' },
    style: { '--toast-duration': `${ttl}ms` },
  }, [
    icon(iconName, 14),
    el('div', { class: 'toast-msg', text: String(message ?? '') }),
  ]);
  root.appendChild(node);
  while (root.children.length > MAX_TOASTS) root.removeChild(root.firstElementChild);
  window.setTimeout(() => {
    node.classList.add('is-closing');
    window.setTimeout(() => node.remove(), 390);
  }, ttl);
}

function toastError(err, fallback) {
  const msg = describeError(err, fallback);
  toast(msg, 'error');
  pushLog({ at: Date.now(), level: 'error', msg });
  return msg;
}

function normalizeLogEntry(entry) {
  const src = entry && typeof entry === 'object' ? entry : {};
  // 逐字段挑着复制会静默丢掉主进程新增的字段（cacheUsageAvailable 就这么丢过，
  // 使用量页的缓存统计因此一直判失真）。这里保留全部字段，只补默认值。
  return {
    ...src,
    at: src.at || Date.now(),
    level: src.level || 'info',
    msg: String(src.msg || ''),
  };
}

function logIdentity(entry) {
  return [
    entry?.at,
    entry?.level,
    entry?.msg,
    entry?.providerId,
    entry?.providerName,
    entry?.model,
    entry?.upstreamModel,
    entry?.status,
    entry?.ms,
    entry?.events,
    entry?.clientGone,
    entry?.cacheUsageAvailable,
    entry?.estimatedUsage,
    JSON.stringify(entry?.tokens || null),
  ].map((value) => String(value ?? '')).join('\u001f');
}

// ============ 本地日志（渲染层自身事件，不经过主进程） ============
function pushLog(entry) {
  const full = { ...normalizeLogEntry(entry), local: true };
  state.logs.push(full);
  while (state.logs.length > LOG_STATE_LIMIT) state.logs.shift();
  updateLogBadge();
  if (state.logOpen) {
    appendLogRow(full);
    trimLogDom();
    autoScrollLogs();
  }
}

function mergeUsageRecords(records) {
  if (!Array.isArray(records)) return 0;
  const known = new Set(state.usage.map((entry) => String(entry?.requestId || logIdentity(entry))));
  let added = 0;
  for (const entry of records) {
    const normalized = normalizeLogEntry(entry);
    const identity = String(normalized.requestId || logIdentity(normalized));
    if (known.has(identity)) continue;
    known.add(identity);
    state.usage.push(normalized);
    added += 1;
  }
  if (added) state.usage.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  return added;
}

function handleIncomingLog(entry, rerender = renderCurrent) {
  if (!entry || typeof entry !== 'object') return;
  const normalized = normalizeLogEntry(entry);
  const identity = logIdentity(normalized);
  if (state.logs.some((current) => logIdentity(current) === identity)) return;
  pushLog(normalized);
  const finalRecord = normalized.final === true || normalized.usageRecord === true;
  if (finalRecord) mergeUsageRecords([normalized]);
  updateUsageBadge();
  if (state.view === 'usage') rerender(false, { preserveScrollTop: true });
  // 主页也展示最近请求与今日流量：只在请求终结时重绘一次，不跟着中间日志刷新。
  else if (state.view === 'home' && finalRecord) rerender(false, { preserveScrollTop: true });
}

function logLocal(level, msg) {
  pushLog({ at: Date.now(), level, msg });
}

// ============ 剪贴板 ============
async function copyText(text, label = '内容') {
  const value = String(text ?? '');
  if (!value) {
    toast(`${label}为空，没有可复制的内容`, 'warn');
    return false;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      toast(`已复制${label}`, 'ok');
      return true;
    }
  } catch {
    /* 退回到 execCommand */
  }
  try {
    const ta = el('textarea', { class: 'sr-only', attrs: { 'aria-hidden': 'true' } });
    ta.value = value;
    ta.style.setProperty('position', 'fixed');
    ta.style.setProperty('opacity', '0');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? `已复制${label}` : '复制失败，请手动选择文本', ok ? 'ok' : 'warn');
    return ok;
  } catch {
    toast('复制失败，请手动选择文本', 'warn');
    return false;
  }
}

// ============ 弹窗宿主 ============
let currentModal = null;
// 缩回动画时长；节点必须等动画播完再移除，否则关闭会表现为“瞬间消失”。
const MODAL_EXIT_MS = 200;

function openModal(node, options = {}) {
  closeModal();
  const backdrop = el(
    'div',
    {
      class: 'modal-backdrop',
      on: {
        mousedown: (e) => {
          if (e.target === backdrop) closeModal();
        },
      },
    },
    [node],
  );
  dom.modalRoot.appendChild(backdrop);
  currentModal = { backdrop, onClose: options.onClose || null, prevFocus: document.activeElement };
  const focusTarget = backdrop.querySelector('[data-autofocus]') || backdrop.querySelector('input, textarea, select, button');
  if (focusTarget) window.setTimeout(() => focusTarget.focus(), 0);
  return backdrop;
}

function closeModal() {
  if (!currentModal) return false;
  const { backdrop, onClose, prevFocus } = currentModal;
  currentModal = null;
  backdrop.classList.add('is-closing');
  window.setTimeout(() => backdrop.remove(), MODAL_EXIT_MS);
  if (typeof onClose === 'function') {
    try {
      onClose();
    } catch {
      /* 关闭回调异常不影响界面 */
    }
  }
  // 打开另一个弹窗时旧弹窗还在播放缩回动画，此时不能把焦点抢回旧位置。
  if (currentModal) return true;
  if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
    try {
      prevFocus.focus();
    } catch {
      /* ignore */
    }
  }
  return true;
}

function isModalOpen() {
  return !!currentModal;
}

// ============ 数据加载 ============
async function loadStatus() {
  state.status = await api.getStatus();
  if (state.status && state.status.network) state.network = { ...state.status.network };
  if (state.status && Array.isArray(state.status.plugins)) state.plugins = state.status.plugins;
  setThemePreference(state.status && state.status.theme);
  state.loaded.status = true;
}

async function loadStartup() {
  if (typeof api.getStartup !== 'function') {
    state.startup = { supported: false, enabled: false, target: 'gptplus' };
    state.loaded.startup = true;
    return;
  }
  try {
    const result = await api.getStartup();
    state.startup = result && typeof result === 'object'
      ? {
          supported: result.supported !== false,
          enabled: !!result.enabled,
          target: result.target === 'both' ? 'both' : 'gptplus',
        }
      : { supported: false, enabled: false, target: 'gptplus' };
  } catch (err) {
    state.startup = { supported: false, enabled: false, target: 'gptplus' };
    logLocal('warn', `读取开机自启动状态失败: ${describeError(err)}`);
  }
  state.loaded.startup = true;
}

/** 读取主进程维护的更新状态，确保启动时不会错过可用版本事件。 */
async function loadUpdate() {
  if (typeof api.getUpdateState !== 'function') return;
  const next = await api.getUpdateState();
  if (next && typeof next === 'object') handleUpdateState(next);
  state.loaded.update = true;
}

async function loadProviders() {
  state.providers = await api.listProviders();
  state.loaded.providers = true;
}

async function loadModels() {
  state.models = await api.listModels();
  state.loaded.models = true;
}

async function loadModelLimits() {
  state.modelLimits = await api.getModelLimits();
  state.loaded.modelLimits = true;
}

async function loadGateway() {
  state.gateway = await api.getGateway();
  state.loaded.gateway = true;
}

async function loadInject() {
  state.inject = await api.getInject();
  state.loaded.inject = true;
}

async function loadPeer() {
  if (typeof api.getPeerState === 'function') state.peer = await api.getPeerState();
  state.loaded.peer = true;
}

async function loadWeixin() {
  if (typeof api.getWeixin === 'function') state.weixin = await api.getWeixin();
  state.loaded.weixin = true;
}

async function loadPlugins() {
  if (typeof api.listPlugins === 'function') {
    const plugins = await api.listPlugins();
    state.plugins = Array.isArray(plugins) ? plugins : [];
  }
  state.loaded.plugins = true;
}

async function loadLogs() {
  const logs = await api.getLogs();
  if (Array.isArray(logs)) {
    // 本地日志（渲染层自己的提示）只存在于内存，整体替换会把它们抹掉
    const local = state.logs.filter((entry) => entry && entry.local);
    state.logs = [...local, ...logs.map(normalizeLogEntry)]
      .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
      .slice(-LOG_STATE_LIMIT);
  }
  state.loaded.logs = true;
}

async function loadUsage() {
  const hasUsageApi = typeof api.getUsage === 'function';
  let records = hasUsageApi ? await api.getUsage() : null;
  if (!hasUsageApi && typeof api.getLogs === 'function') {
    records = await api.getLogs();
  }
  if (Array.isArray(records)) {
    state.usage = records.map(normalizeLogEntry).sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  }
  if (typeof api.getUsageTrend === 'function') {
    const trend = await api.getUsageTrend();
    state.usageTrend = Array.isArray(trend) ? trend : [];
  }
  state.loaded.usage = true;
}

/**
 * 增量合并主进程日志，供使用量页的定时刷新使用。
 * @param {any[]} logs 主进程返回的持久化日志
 * @returns {number} 新增日志条数
 */
function mergeUsageLogs(logs) {
  if (!Array.isArray(logs)) return 0;
  let added = 0;
  const known = new Set(state.logs.map((entry) => logIdentity(entry)));
  for (const entry of logs) {
    const normalized = normalizeLogEntry(entry);
    const identity = logIdentity(normalized);
    if (known.has(identity)) continue;
    known.add(identity);
    state.logs.push(normalized);
    added += 1;
  }
  if (added) {
    state.logs = state.logs
      .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
      .slice(-LOG_STATE_LIMIT);
  }
  return added;
}

/** 统一的安全加载：失败时提示但不抛出，避免整页白屏 */
async function tryLoad(loader, label) {
  try {
    await loader();
    return true;
  } catch (err) {
    toastError(err, `${label}读取失败`);
    return false;
  }
}

const RELOAD_PLAN = {
  home: [
    [loadPlugins, '插件列表'],
    [loadProviders, '提供商列表'],
    [loadModels, '模型列表'],
    [loadGateway, '网关状态'],
    [loadInject, '注入状态'],
    [loadUsage, '使用量统计'],
    [loadStatus, '全局状态'],
  ],
  providers: [
    [loadProviders, '提供商列表'],
    [loadModels, '模型列表'], // 模型由提供商派生，改完提供商要一起刷新
    [loadStatus, '全局状态'],
  ],
  models: [
    [loadModels, '模型列表'],
    // 删除/启停模型会改掉提供商内部的模型数组，反过来也要刷新提供商快照；
    // 否则切到提供商页仍显示已删除的模型，编辑表单还会把它重新写回去。
    [loadProviders, '提供商列表'],
    [loadInject, '注入状态'],
    [loadGateway, '网关状态'],
    [loadStatus, '全局状态'],
  ],
  settings: [
    [loadModelLimits, '模型上下文设置'],
    [loadGateway, '网关状态'],
    [loadInject, '注入状态'],
    [loadUpdate, '更新状态'],
    [loadStatus, '全局状态'],
    [loadPeer, '对等共享状态'],
  ],
  usage: [[loadUsage, '使用量统计'], [loadLogs, '使用量日志']],
  weixin: [
    [loadPlugins, '插件列表'],
    [loadWeixin, '微信连接配置'],
    [loadStatus, '全局状态'],
  ],
  plugins: [[loadPlugins, '插件列表'], [loadProviders, '提供商列表'], [loadStatus, '全局状态']],
};

async function reload(scope = 'providers', options = {}) {
  const targetView = state.view;
  const plan = RELOAD_PLAN[scope] || RELOAD_PLAN.providers;
  for (const [loader, label] of plan) {
    await tryLoad(loader, label);
  }
  if (state.view === targetView) {
    renderChrome();
    renderCurrent(true, options);
  }
}

const USAGE_REFRESH_INTERVAL_MS = 60_000;
let usageRefreshTimer = null;
let usageRefreshInFlight = false;

/** 停止使用量页的自动刷新定时器。 */
function stopUsageAutoRefresh() {
  if (usageRefreshTimer === null || typeof window === 'undefined') return;
  window.clearInterval(usageRefreshTimer);
  usageRefreshTimer = null;
}

/**
 * 拉取并增量更新使用量日志，不触发整页重置。
 * @returns {Promise<number>} 本次新增日志条数
 */
async function refreshUsageIncrementally() {
  if (!api || (typeof api.getUsage !== 'function' && typeof api.getLogs !== 'function') || usageRefreshInFlight) return 0;
  usageRefreshInFlight = true;
  try {
    const hasUsageApi = typeof api.getUsage === 'function';
    let records = hasUsageApi ? await api.getUsage() : null;
    if (!hasUsageApi && typeof api.getLogs === 'function') {
      records = await api.getLogs();
    }
    const added = mergeUsageRecords(records);
    if (typeof api.getUsageTrend === 'function') {
      const trend = await api.getUsageTrend();
      state.usageTrend = Array.isArray(trend) ? trend : [];
    }
    state.loaded.usage = true;
    if (state.view === 'usage') {
      renderChrome();
      renderCurrent(false, { preserveScrollTop: true });
    }
    return added;
  } catch (err) {
    toastError(err, '使用量日志读取失败');
    return 0;
  } finally {
    usageRefreshInFlight = false;
  }
}

/** 根据当前视图启停使用量页的每分钟增量刷新。 */
function syncUsageAutoRefresh() {
  if (state.view !== 'usage' || !api || typeof window === 'undefined') {
    stopUsageAutoRefresh();
    return;
  }
  if (usageRefreshTimer !== null) return;
  usageRefreshTimer = window.setInterval(() => {
    void refreshUsageIncrementally();
  }, USAGE_REFRESH_INTERVAL_MS);
}

// ============ 全局 chrome ============
const VIEW_META = {
  home: {
    title: '主页',
    sub: '提供商、本地网关与 ChatGPT 客户端连成一条线路',
    render: renderHome,
    // 使用量由后台加载：历史记录可能有上万条，不能挡住首屏。
    needs: ['providers', 'status', 'gateway', 'inject', 'models', 'peer'],
  },
  providers: {
    title: '提供商',
    sub: '添加你自己的模型接口；保存后模型会进入 ChatGPT 的模型清单',
    render: renderProviders,
    needs: ['providers', 'status'],
  },
  models: {
    title: '模型',
    sub: '注入后 ChatGPT 客户端的模型选择器里会出现这些模型',
    render: renderModels,
    needs: ['models', 'inject', 'gateway'],
  },
  usage: {
    title: '使用量',
    sub: '查看本地网关请求、Token 与响应耗时统计',
    render: renderUsage,
    needs: ['usage'],
  },
  plugins: {
    title: '插件市场',
    sub: '按需安装、配置和管理可选功能',
    render: renderPlugins,
    needs: ['plugins', 'providers'],
  },
  weixin: {
    title: '微信连接',
    sub: '通过个人微信连接本机 Codex 会话',
    render: renderWeixin,
    needs: ['weixin', 'status'],
  },
  settings: {
    title: '设置',
    sub: '本地网关、Codex 配置写入与客户端重启',
    render: renderSettings,
    needs: ['modelLimits', 'gateway', 'inject', 'update', 'status', 'peer'],
  },
};

function renderChrome() {
  const s = state.status;
  const weixinPlugin = state.plugins.find((plugin) => plugin.id === 'weixin');
  const weixinNav = dom.nav.querySelector('[data-plugin-nav="weixin"]');
  if (weixinNav) weixinNav.hidden = !!weixinPlugin && !weixinPlugin.installed;
  if (state.view === 'weixin' && weixinPlugin && !weixinPlugin.installed) state.view = 'plugins';

  // 导航
  for (const btn of dom.nav.querySelectorAll('.nav-item')) {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  }
  const activeNav = dom.nav.querySelector('.nav-item.is-active');
  if (activeNav) {
    dom.nav.style.setProperty('--nav-indicator-y', `${activeNav.offsetTop}px`);
    dom.nav.style.setProperty('--nav-indicator-h', `${activeNav.offsetHeight}px`);
  }
  const providerBadge = dom.nav.querySelector('[data-badge="providers"]');
  const modelBadge = dom.nav.querySelector('[data-badge="models"]');
  const gatewayBadge = dom.nav.querySelector('[data-badge="gateway"]');
  const updateBadge = dom.nav.querySelector('[data-badge="update"]');
  const pluginsBadge = dom.nav.querySelector('[data-badge="plugins"]');
  setAnimatedText(providerBadge, s ? String(s.providers) : '–');
  setAnimatedText(modelBadge, s ? String(s.models) : '–');
  setAnimatedText(pluginsBadge, String(state.plugins.filter((plugin) => plugin.installed).length));
  const homeSignal = dom.nav.querySelector('[data-signal="home"]');
  if (homeSignal) {
    const live = !!(s && s.providers > 0 && s.gateway && s.gateway.running && s.inject && s.inject.enabled);
    homeSignal.classList.toggle('is-live', live);
    homeSignal.classList.toggle('is-pending', !!s && !live && (s.providers > 0 || (s.gateway && s.gateway.enabled)));
  }
  updateUsageBadge();
  if (gatewayBadge) {
    const running = !!(s && s.gateway && s.gateway.running);
    setAnimatedText(gatewayBadge, s ? (running ? '运行' : '停') : '–');
    gatewayBadge.classList.toggle('is-run', running);
    gatewayBadge.classList.toggle('is-off', !!s && !running);
  }
  if (updateBadge) {
    const hasUpdate = ['available', 'downloading', 'downloaded'].includes(state.update?.status);
    setAnimatedText(updateBadge, hasUpdate ? '新' : '');
    updateBadge.classList.toggle('is-update', hasUpdate);
    updateBadge.hidden = !hasUpdate;
  }

  // 标题
  const meta = VIEW_META[state.view];
  dom.viewTitle.textContent = meta.title;
  dom.viewSub.textContent = meta.sub;

  // 侧栏底部
  renderSidebarUpdateQuick();
  renderSidebarAction();
  renderSidebarFoot(s);

  // 状态栏链路
  renderFlow(s);
  renderThemeControl();

  // 版本
  dom.buildTag.textContent = s && s.appVersion ? `v${s.appVersion}` : '';
}

/** 左侧常驻更新入口：检查、最新版提示和用户确认后的安装都从这里进入。 */
function renderSidebarUpdateQuick() {
  const root = dom.sidebarUpdateQuick;
  if (!root) return;
  const update = state.update || {};
  const status = update.status || 'idle';
  const checking = status === 'checking';
  const downloading = status === 'downloading';
  const pending = status === 'available' || status === 'downloaded';
  const disabled = !api || checking || downloading || update.enabled === false;
  const label = status === 'checking'
    ? '检查中…'
    : status === 'available'
      ? `更新到 v${update.version || ''}`
      : status === 'downloading'
        ? `下载中 ${Math.round(update.percent || 0)}%`
        : status === 'downloaded'
          ? '继续安装更新'
          : status === 'latest'
            ? '已是最新版本'
            : status === 'error'
              ? '重试检查更新'
              : update.enabled === false ? '更新不可用' : '检查更新';
  const title = status === 'available'
    ? '下载并安装新版本'
    : status === 'downloaded'
      ? '重启并安装已下载的更新'
      : status === 'latest'
        ? '再次检查 GitHub Release'
        : '检查 GitHub Release 更新';
  const iconName = pending || downloading ? 'download' : status === 'latest' ? 'check' : status === 'error' ? 'alert' : 'refresh';
  root.replaceChildren(el('button', {
    class: `sidebar-update-quick-button${status === 'latest' ? ' is-latest' : ''}${pending ? ' is-pending' : ''}`,
    type: 'button',
    disabled: disabled ? true : null,
    title,
    attrs: { 'aria-label': title },
    on: {
      click: () => {
        if (status === 'available' || status === 'downloaded') void startUpdateDownload();
        else void checkForUpdates();
      },
    },
  }, [icon(iconName, 13), el('span', { text: label })]));
}

/** 底部状态栏里的全局主题快捷切换。图标按钮保留 title，便于鼠标悬停识别。 */
function renderThemeControl() {
  if (!dom.themeControl) return;
  const options = [
    ['dark', 'moon', '深色'],
    ['light', 'sun', '浅色'],
    ['system', 'monitor', '跟随系统'],
  ];
  dom.themeControl.replaceChildren(
    el('div', { class: 'theme-quick', role: 'group', attrs: { 'aria-label': '界面主题' } }, options.map(([value, iconName, label]) => el('button', {
      class: 'theme-quick-btn' + (state.theme === value ? ' is-active' : ''),
      type: 'button',
      disabled: !api || themeSaveBusy ? true : null,
      title: label,
      attrs: { 'aria-label': label, 'aria-pressed': state.theme === value ? 'true' : 'false' },
      on: { click: () => void saveThemePreference(value) },
    }, [icon(iconName, 13)]))),
  );
}

/** 侧栏底部的开机自启动设置，状态由系统登录项 API 返回。 */
function renderStartupControl() {
  const current = state.startup || { supported: null, enabled: false, target: 'gptplus' };
  const supported = current.supported !== false;
  const enabled = !!current.enabled;
  const target = current.target === 'both' ? 'both' : 'gptplus';
  const buttonTitle = current.supported === null
    ? '正在读取开机自启动状态'
    : enabled ? '点击关闭开机自启动' : '点击开启开机自启动';
  const targetOption = (value, label, description) => el('button', {
    class: `sidebar-startup-option${target === value ? ' is-selected' : ''}`,
    type: 'button',
    disabled: !api || !supported || !enabled || startupSaveBusy ? true : null,
    title: description,
    data: { startupTarget: value },
    attrs: {
      role: 'radio',
      'aria-checked': target === value ? 'true' : 'false',
      'aria-label': `${label}：${description}`,
    },
    on: { click: () => void saveStartupPreference(true, value) },
  }, [el('span', { text: value === 'both' ? '+ ChatGPT' : label })]);
  return el('section', { class: 'sidebar-startup', attrs: { 'aria-label': '开机自启动' } }, [
    el('div', { class: 'sidebar-startup-head' }, [
      icon('power', 13),
      el('span', { class: 'sidebar-startup-title', text: '开机自启动' }),
      el('button', {
        class: 'sidebar-startup-toggle' + (enabled ? ' is-enabled' : ''),
        type: 'button',
        disabled: !api || !supported || current.supported === null || startupSaveBusy ? true : null,
        title: buttonTitle,
        attrs: {
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-label': '开机自启动',
        },
        on: { click: () => void saveStartupPreference(!enabled) },
      }, [
        el('span', { class: 'sidebar-startup-track', attrs: { 'aria-hidden': 'true' } }, [
          el('span', { class: 'sidebar-startup-thumb' }),
        ]),
      ]),
    ]),
    el('div', { class: 'sidebar-startup-options', role: 'radiogroup', attrs: { 'aria-label': '选择开机自启动应用' } }, [
      targetOption('gptplus', '仅 gpt++', '开机只启动 gpt++'),
      targetOption('both', 'gpt++ + ChatGPT', '开机同时启动 gpt++ 和 ChatGPT'),
    ]),
  ]);
}

/** 只在状态值真正变化时给侧栏徽标一次短反馈，避免状态广播导致持续闪烁。 */
function setAnimatedText(node, value) {
  if (!node) return;
  const next = String(value);
  if (node.textContent === next) return;
  node.textContent = next;
  node.classList.remove('is-updated');
  window.setTimeout(() => {
    if (!node.isConnected) return;
    node.classList.add('is-updated');
    window.setTimeout(() => node.classList.remove('is-updated'), 320);
  }, 0);
}

async function saveThemePreference(next) {
  if (themeSaveBusy || !api || !THEME_MODES.has(next)) return;
  const previous = state.theme;
  themeSaveBusy = true;
  document.documentElement.classList.add('is-theme-switching');
  setThemePreference(next);
  renderChrome();
  try {
    const status = await api.setTheme({ theme: next });
    state.status = status;
    if (status && status.theme) setThemePreference(status.theme);
    toast(`主题已切换为${next === 'dark' ? '深色' : next === 'light' ? '浅色' : '跟随系统'}`, 'ok');
  } catch (err) {
    setThemePreference(previous);
    toastError(err, '保存主题失败');
  } finally {
    themeSaveBusy = false;
    window.setTimeout(() => document.documentElement.classList.remove('is-theme-switching'), 360);
    renderChrome();
  }
}

/** 立即切换上游网络模式，不重启网关，也不迁移正在进行的请求。 */
async function saveNetworkMode(nextMode) {
  const currentMode = state.network && state.network.proxyMode === 'direct' ? 'direct' : 'system';
  if (networkSaveBusy || !api || !['system', 'direct'].includes(nextMode) || currentMode === nextMode) return;

  // 先更新侧栏选中态，让用户感知到切换是即时的；主进程失败时再恢复旧值。
  networkSaveBusy = true;
  networkFocusMode = nextMode;
  state.network = { ...(state.network || {}), proxyMode: nextMode };
  renderChrome();
  try {
    const status = await api.setNetwork({ proxyMode: nextMode });
    state.status = status;
    state.network = status && status.network ? status.network : { proxyMode: nextMode };
    const msg = nextMode === 'system' ? '已切换为系统代理：跟随 Windows 系统代理设置' : '已切换为直连';
    toast(msg, 'ok');
    logLocal('info', msg);
  } catch (err) {
    networkFocusMode = currentMode;
    state.network = { ...(state.network || {}), proxyMode: currentMode };
    toastError(err, '切换网络模式失败');
  } finally {
    networkSaveBusy = false;
    renderChrome();
  }
}

async function saveStartupPreference(enabled, nextTarget) {
  const current = state.startup || { supported: false, enabled: false, target: 'gptplus' };
  const target = nextTarget === undefined
    ? (current.target === 'both' ? 'both' : 'gptplus')
    : nextTarget === 'both' ? 'both' : 'gptplus';
  if (startupSaveBusy || !api || current.supported === false
    || (current.enabled === enabled && current.target === target)) return;
  startupSaveBusy = true;
  state.startup = { ...current, enabled, target };
  renderChrome();
  try {
    const next = await api.setStartup({ enabled, target });
    state.startup = next && typeof next === 'object'
      ? {
          supported: next.supported !== false,
          enabled: !!next.enabled,
          target: next.target === 'both' ? 'both' : 'gptplus',
        }
      : { supported: true, enabled, target };
    const targetLabel = target === 'both' ? 'gpt++ 和 ChatGPT' : '仅 gpt++';
    toast(enabled ? `已开启开机自启动：${targetLabel}` : '已关闭开机自启动', 'ok');
    logLocal('info', enabled ? `已开启开机自启动：${targetLabel}` : '已关闭开机自启动');
  } catch (err) {
    state.startup = current;
    toastError(err, '设置开机自启动失败');
  } finally {
    startupSaveBusy = false;
    renderChrome();
  }
}

/** 侧栏里的全局客户端重启动作：所有页面共用同一份确认状态。 */
function renderSidebarAction() {
  if (!dom.sidebarActions) return;
  const mode = state.network && state.network.proxyMode === 'direct' ? 'direct' : 'system';
  const pending = state.pendingRelaunch;
  const needed = state.relaunchNeeded;
  const networkOption = (value, label, description, glyph) => el('button', {
    class: `sidebar-network-option${mode === value ? ' is-selected' : ''}`,
    type: 'button',
    disabled: !api || networkSaveBusy ? true : null,
    title: description,
    data: { networkMode: value },
    tabindex: mode === value ? '0' : '-1',
    attrs: {
      role: 'radio',
      'aria-checked': mode === value ? 'true' : 'false',
      'aria-label': `${label}：${description}`,
    },
    on: {
      click: () => void saveNetworkMode(value),
      keydown: (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = e.key === 'ArrowLeft' ? 'system' : 'direct';
        if (next !== mode) void saveNetworkMode(next);
      },
    },
  }, [icon(glyph, 12), el('span', { text: label })]);
  const networkControl = el('section', { class: 'sidebar-network', attrs: { 'aria-label': '上游网络连接' } }, [
    el('div', { class: 'sidebar-network-head' }, [
      icon('plug', 13),
      el('span', { class: 'sidebar-network-title', text: '上游网络' }),
      el('span', {
        class: 'sidebar-network-state' + (mode === 'direct' ? ' is-direct' : ''),
        text: mode === 'system' ? '系统代理' : '直连',
      }),
    ]),
    el('div', { class: 'sidebar-network-modes', role: 'radiogroup', attrs: { 'aria-label': '选择上游网络模式' } }, [
      networkOption('system', '系统代理', '跟随 Windows 系统代理；Clash Verge 开启系统代理时自动使用代理', 'plug'),
      networkOption('direct', '直连', '不使用系统代理，直接连接模型提供商', 'zap'),
    ]),
  ]);
  const startupControl = renderStartupControl();
  const update = state.update || {};
  const updatePending = ['available', 'downloading', 'downloaded'].includes(update.status);
  const updateNotice = updatePending
    ? el('div', { class: 'sidebar-update-wrap' }, [
        el('div', { class: 'sidebar-update-alert', attrs: { role: 'alert' } }, [
          icon('zap', 14),
          el('span', { text: update.status === 'downloading'
            ? `正在下载新版本 v${update.version || ''}`
            : `检测到新版本 v${update.version || ''}` }),
        ]),
        el('button', {
          class: 'btn btn-sm sidebar-update-button ' + (update.status === 'available' ? 'btn-warning' : 'btn-ghost'),
          type: 'button',
          disabled: !api || update.status !== 'available' ? true : null,
          title: update.status === 'available' ? '立即下载并安装新版本' : '更新正在处理中',
          on: { click: () => void startUpdateDownload() },
        }, [icon('download', 13), el('span', { text: update.status === 'downloading' ? `下载中 ${Math.round(update.percent || 0)}%` : '立即更新' })]),
      ])
    : null;
  const button = el('button', {
    class: 'btn btn-sm sidebar-relaunch '
      + (relaunchBusy ? 'btn-ghost is-busy' : pending || needed ? 'btn-danger' : 'btn-ghost'),
    type: 'button',
    disabled: !api || relaunchBusy ? true : null,
    title: relaunchBusy
      ? '正在结束旧的 ChatGPT 进程并重新启动，请稍候'
      : pending
        ? '再次点击确认，立即结束并重新启动 ChatGPT.exe'
        : '结束 ChatGPT.exe 再重新启动，让它重新读取模型清单',
    on: {
      click: () => {
        if (relaunchBusy) return;
        if (!state.pendingRelaunch) {
          state.pendingRelaunch = true;
          renderSidebarAction();
          window.clearTimeout(relaunchTimer);
          relaunchTimer = window.setTimeout(() => {
            if (state.pendingRelaunch) {
              state.pendingRelaunch = false;
              renderSidebarAction();
            }
          }, 6000);
          return;
        }
        void relaunchChatGpt();
      },
    },
  }, [
    icon(relaunchBusy ? 'refresh' : 'power', 13),
    el('span', {
      text: relaunchBusy
        ? '正在重启 ChatGPT…'
        : pending
          ? '确认重启 ChatGPT？'
          : needed ? '重启 ChatGPT（配置待生效）' : '重启 ChatGPT 客户端',
    }),
  ]);
  const warning = !relaunchBusy && needed
    ? el('div', { class: 'sidebar-relaunch-alert', attrs: { role: 'alert' } }, [
        icon('alert', 14),
        el('span', { text: '配置已修改，需要重启 ChatGPT 客户端生效' }),
      ])
    : null;
  dom.sidebarActions.replaceChildren(
    ...(updateNotice ? [updateNotice] : []),
    networkControl,
    startupControl,
    el('div', { class: 'sidebar-relaunch-wrap' }, [warning, button]),
  );
  if (networkFocusMode && !networkSaveBusy) {
    const target = dom.sidebarActions.querySelector(`[data-network-mode="${networkFocusMode}"]`);
    networkFocusMode = null;
    target?.focus();
  }
}

/** 用户明确选择更新时，开始下载；检测到版本本身不会触发这个函数。 */
async function startUpdateDownload() {
  if (!api || !['available', 'downloaded'].includes(state.update?.status)) return;
  try {
    const next = await api.downloadUpdate();
    if (next && typeof next === 'object') handleUpdateState(next);
    toast('已开始下载更新，下载完成后会自动重启安装', 'info');
  } catch (err) {
    toastError(err, '开始更新失败');
  }
}

/** 手动检查更新，结果仍通过主进程事件统一回写到全局状态。 */
async function checkForUpdates() {
  if (!api || state.update?.status === 'checking' || state.update?.status === 'downloading') return;
  try {
    const next = await api.checkForUpdates();
    if (next && typeof next === 'object') handleUpdateState(next);
    if (next?.status === 'latest') toast('当前已是最新版本', 'ok');
    else if (next?.status === 'checking') toast('正在检查更新…', 'info');
  } catch (err) {
    toastError(err, '检查更新失败');
  }
}

/** 接收主进程更新事件，并在首次发现版本时弹出确认框。 */
function handleUpdateState(next) {
  if (!next || typeof next !== 'object') return;
  const changed = Object.keys(next).some((key) => state.update?.[key] !== next[key]);
  state.update = { ...state.update, ...next };
  renderChrome();
  // 设置页的更新卡片不属于 chrome；更新事件到达时需要同步重绘，避免左侧和卡片显示不同状态。
  if (changed && state.view === 'settings') {
    renderCurrent(false, { preserveScrollTop: true });
  }
  updateModalSync?.();
  if (state.update.status === 'available' && state.update.version
    && updatePromptedVersion !== state.update.version && !isModalOpen()) {
    updatePromptedVersion = state.update.version;
    openUpdateModal();
  }
}

/** 更新确认弹窗：暂不更新只关闭弹窗，版本状态会继续留在左侧和设置页。 */
function openUpdateModal() {
  const update = state.update || {};
  const sub = el('div', { class: 'modal-sub', text: `当前 v${update.currentVersion || '—'} · 最新 v${update.version || '—'}` });
  const status = el('div', { class: 'modal-body' });
  const foot = el('div', { class: 'modal-foot' });
  const modal = el('section', { class: 'modal modal-update', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'update-modal-title' } }, [
    el('header', { class: 'modal-head' }, [
      el('div', { class: 'modal-update-mark' }, [icon('download', 15)]),
      el('div', { class: 'modal-update-heading' }, [
        el('h2', { text: '发现 gpt++ 新版本', attrs: { id: 'update-modal-title' } }),
        sub,
      ]),
    ]),
    status,
    foot,
  ]);
  const sync = () => {
    const current = state.update || {};
    status.replaceChildren(
      el('div', { class: 'note note-warn' }, [
        icon(current.status === 'downloading' ? 'download' : 'zap', 15),
        el('div', { class: 'grow' }, [
          el('div', { text: current.status === 'downloading' ? `正在下载 v${current.version || ''}` : current.status === 'downloaded' ? '更新已下载，正在准备安装' : `检测到最新版 v${current.version || ''}` }),
          el('div', { class: 'faint', text: current.status === 'downloading' ? `下载进度 ${Math.round(current.percent || 0)}%，完成后会自动重启安装。` : '更新会下载并安装新版本，暂不更新不影响使用。' }),
        ]),
      ]),
    );
    foot.replaceChildren();
    if (current.status === 'available') {
      foot.append(
        el('button', { class: 'btn btn-ghost', type: 'button', on: { click: closeModal } }, [el('span', { text: '暂不更新' })]),
        el('button', { class: 'btn btn-warning', type: 'button', on: { click: () => void startUpdateDownload() } }, [icon('download', 13), el('span', { text: '立即更新' })]),
      );
    } else if (current.status === 'downloading') {
      foot.append(el('button', { class: 'btn btn-ghost', type: 'button', on: { click: closeModal } }, [el('span', { text: '后台下载' })]));
    } else if (current.status === 'downloaded') {
      foot.append(el('button', { class: 'btn btn-ghost', type: 'button', on: { click: closeModal } }, [el('span', { text: '关闭' })]));
    } else {
      foot.append(el('button', { class: 'btn btn-ghost', type: 'button', on: { click: closeModal } }, [el('span', { text: '关闭' })]));
    }
  };
  updateModalSync = sync;
  openModal(modal, { onClose: () => { updateModalSync = null; } });
  sync();
}

/** 标记配置已写入磁盘，提醒用户重启 ChatGPT 客户端读取新配置。 */
function markRelaunchNeeded() {
  if (state.relaunchNeeded) return;
  state.relaunchNeeded = true;
  renderChrome();
}

/** 统一接收主进程的 Codex 配置写入结果，避免漏掉其它配置入口。 */
function observeCodexWrite(s) {
  const write = s && s.codex && s.codex.lastWrite;
  const at = Number(write && write.at);
  if (!write || !Number.isFinite(at) || at <= observedWriteAt) return;
  observedWriteAt = at;
  if (write.ok) markRelaunchNeeded();
}

/** 待重启状态同时影响侧栏按钮、设置页提示和主页「下一步」黄条，三处都要立即重绘。 */
function renderRelaunchState() {
  renderChrome();
  // 主页黄条也由 relaunchNeeded 决定：从侧栏重启成功后必须让它消失，
  // 否则用户会以为配置仍然没生效（设置页同理）。
  if (state.view === 'settings' || state.view === 'home') {
    renderCurrent(false, { preserveScrollTop: true });
  }
}

/**
 * 调用主进程重启 ChatGPT，并把结果反馈到全局提示与运行日志。
 * @returns {Promise<boolean>} 是否重启成功；视图层的「下一步」按钮据此决定后续文案
 */
async function relaunchChatGpt() {
  if (relaunchBusy) return false;
  const wasNeeded = state.relaunchNeeded;
  state.pendingRelaunch = false;
  window.clearTimeout(relaunchTimer);
  relaunchBusy = true;
  // 用户确认后先撤掉红色警示：结束旧进程、等待退出、再唤起客户端需要几秒，
  // 这段时间按钮应显示“正在重启”，而不是继续停在“配置待生效”。
  // 同时把已观察到的写入时间推进到现在，防止还在路上的旧状态广播把红色又标回来。
  state.relaunchNeeded = false;
  observedWriteAt = Math.max(observedWriteAt, Date.now());
  renderRelaunchState();
  try {
    const res = await api.relaunchChatGpt();
    if (res && res.ok) {
      // 重启完成后再收一次时间戳：重启过程中若有新写入，新的 ChatGPT 进程已经会读到它。
      state.relaunchNeeded = false;
      observedWriteAt = Math.max(observedWriteAt, Date.now());
      if (res.injected === false) {
        toast(`ChatGPT 已重启，但输入框用量栏注入失败：${res.injectError || '无法连接调试端口'}`, 'warn', 7000);
      } else {
        toast('已重启 ChatGPT 客户端：新的模型清单已加载', 'ok');
      }
      logLocal(res.injected === false ? 'warn' : 'info', res.injected === false
        ? `ChatGPT 已重启，但输入框用量栏注入失败：${res.injectError || '无法连接调试端口'}`
        : '已重启 ChatGPT 客户端并加载新的模型清单');
      return true;
    } else {
      state.relaunchNeeded = wasNeeded || state.relaunchNeeded;
      toast(`重启失败：${(res && res.error) || '未知错误'}`, 'error');
      return false;
    }
  } catch (err) {
    state.relaunchNeeded = wasNeeded || state.relaunchNeeded;
    toastError(err, '重启 ChatGPT 失败');
    return false;
  } finally {
    relaunchBusy = false;
    renderRelaunchState();
  }
}

/** 真正会被写进模型清单的模型数：提供商与模型都必须处于启用状态 */
function enabledModelCount() {
  const list = state.models || [];
  if (list.length) return list.filter((m) => m.enabled).length;
  // 模型列表还没拉到时用主进程报的「启用数」；status.models 是总数（含停用），
  // 拿它兜底会把「已注入 N 个模型」报大。
  const s = state.status;
  return s ? (typeof s.modelsEnabled === 'number' ? s.modelsEnabled : s.models) : 0;
}

function renderSidebarFoot(s) {
  // Connection state has one permanent home in the status bar.
  dom.sidebarFoot.hidden = true;
  dom.sidebarFoot.replaceChildren();
}

/** 状态栏的「提供商 → 网关 → ChatGPT」链路：本界面唯一的记忆点，直接反映系统接线 */
function renderFlow(s) {
  const nodes = [];
  const sep = (live) => el('span', { class: 'flow-sep' + (live ? ' is-live' : ''), text: '→' });

  const providersNode = el('span', { class: 'flow-node flow-provider' }, [
    el('span', { class: 'flow-key', text: '提供商' }),
    el('span', { class: 'flow-summary', text: s ? `${s.providers} 个 · 模型 ${s.models}` : '正在读取…' }),
  ]);

  const gw = (s && s.gateway) || null;
  const gatewayRunning = !!gw?.running;
  const gatewayNode = el('span', { class: 'flow-node flow-gateway' }, [
    el('span', { class: 'dot ' + (gw ? (gatewayRunning ? 'dot-ok' : gw.enabled ? 'dot-warn' : 'dot-off') : 'dot-off') }),
    el('span', { class: 'flow-key', text: '网关' }),
    el('span', {
      class: 'flow-val' + (gw && gatewayRunning ? '' : ' is-dim'),
      title: gw?.url || (gw ? `${gw.host || '127.0.0.1'}:${gw.port}` : ''),
      text: gw ? (gatewayRunning ? `运行中 :${gw.port}` : gw.enabled ? `未运行 :${gw.port}` : '未启用') : '–',
    }),
  ]);

  const inject = (s && s.inject) || null;
  const codexNode = el('span', { class: 'flow-node is-codex' }, [
    el('span', { class: 'dot ' + (inject && inject.enabled ? 'dot-warn' : 'dot-off') }),
    el('span', { class: 'flow-key', text: 'ChatGPT' }),
    el('span', {
      class: 'flow-val',
      text: inject && inject.enabled ? `已注入 ${enabledModelCount()} 个` : '未注入',
    }),
  ]);

  nodes.push(providersNode, sep(gatewayRunning && !!inject?.enabled), gatewayNode, sep(!!inject?.enabled), codexNode);
  dom.flow.replaceChildren(...nodes);
}

function updateUsageBadge(badge = dom.nav?.querySelector('[data-badge="usage"]')) {
  setAnimatedText(badge, String(usageRows(state).length));
}

function updateLogBadge() {
  const n = state.logs.length;
  setAnimatedText(dom.logToggleCount, String(n));
  setAnimatedText(dom.logCount, `${n} 条`);
}

// ============ 日志抽屉 ============
function logMetaText(entry) {
  const parts = [];
  if (entry.providerId) parts.push(entry.providerId);
  if (entry.model) parts.push(entry.model);
  if (entry.status !== undefined && entry.status !== null) parts.push(`HTTP ${entry.status}`);
  if (entry.ms !== undefined && entry.ms !== null) parts.push(fmt.dur(entry.ms));
  return parts.join(' · ');
}

function logRowNode(entry, fresh = false) {
  const meta = logMetaText(entry);
  return el('div', { class: `log-row lv-${entry.level || 'info'}${fresh ? ' is-new' : ''}` }, [
    el('span', { class: 'log-time', text: fmt.clock(entry.at) }),
    el('span', { class: 'log-level', text: entry.level || 'info' }),
    el('span', { class: 'log-msg', text: entry.msg || '' }),
    el('span', { class: 'log-meta', text: meta }),
  ]);
}

function matchesFilter(entry) {
  if (state.logFilter === 'all') return true;
  if (state.logFilter === 'info') return entry.level !== 'warn' && entry.level !== 'error';
  return entry.level === state.logFilter;
}

function appendLogRow(entry) {
  if (!dom.logList || !matchesFilter(entry)) return;
  const empty = dom.logList.querySelector('.log-empty');
  if (empty) empty.remove();
  dom.logList.appendChild(logRowNode(entry, true));
}

function trimLogDom() {
  if (!dom.logList) return;
  const rows = dom.logList.querySelectorAll('.log-row');
  for (let i = 0; i < rows.length - LOG_DRAW_LIMIT; i += 1) rows[i].remove();
}

function renderLogs() {
  if (!dom.logList) return;
  // 历史持久化后 state.logs 可能有上万条，全量建 DOM 节点会把抽屉卡死
  const rows = state.logs.filter(matchesFilter).slice(-LOG_DRAW_LIMIT).map(logRowNode);
  if (!rows.length) {
    dom.logList.replaceChildren(
      el('div', { class: 'log-empty' }, [
        el('div', { text: state.logs.length ? '当前过滤条件下没有日志' : '暂无日志' }),
        el('div', {
          class: 'faint',
          text: state.logs.length ? '切换到「全部」可以看到其它级别的记录' : '网关收到请求、配置写入后，这里会实时显示',
        }),
      ]),
    );
  } else {
    dom.logList.replaceChildren(...rows);
  }
  updateLogBadge();
  autoScrollLogs(true);
}

function autoScrollLogs(force = false) {
  if (!dom.logList) return;
  if (state.logPaused && !force) return;
  dom.logList.scrollTop = dom.logList.scrollHeight;
  state.logPaused = false;
  updateAutoscrollLabel();
}

function updateAutoscrollLabel() {
  if (!dom.logAutoscroll) return;
  dom.logAutoscroll.textContent = state.logPaused ? '滚动已暂停' : '自动滚动';
  dom.logAutoscroll.classList.toggle('muted', !state.logPaused);
}

function setLogOpen(open) {
  state.logOpen = !!open;
  dom.logDrawer.classList.toggle('is-open', state.logOpen);
  dom.logToggle.setAttribute('aria-expanded', state.logOpen ? 'true' : 'false');
  dom.logToggleLabel.textContent = state.logOpen ? '收起日志' : '运行日志';
  if (dom.logClose) {
    dom.logClose.replaceChildren(icon(state.logOpen ? 'chevronDown' : 'chevronUp', 14));
  }
  if (state.logOpen) {
    renderLogs();
  }
}

// ============ 视图渲染 ============
let renderPending = false;

function viewHasFocusedInput() {
  const active = document.activeElement;
  const inView = !!(active && dom.view && dom.view.contains(active));
  const inModal = !!(active && dom.modalRoot && dom.modalRoot.contains(active));
  if (!inView && !inModal) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 给已渲染的内容区播放一次短淡入，不等待数据，也不制造空白过渡层。 */
function playViewSwitch() {
  if (!dom.view) return;
  dom.view.classList.remove('is-view-switching');
  if (viewSwitchFrame) {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(viewSwitchFrame);
    else window.clearTimeout(viewSwitchFrame);
    viewSwitchFrame = 0;
  }
  if (viewSwitchTimer) {
    window.clearTimeout(viewSwitchTimer);
    viewSwitchTimer = 0;
  }
  const start = () => {
    viewSwitchFrame = 0;
    dom.view.classList.add('is-view-switching');
    viewSwitchTimer = window.setTimeout(() => {
      viewSwitchTimer = 0;
      dom.view.classList.remove('is-view-switching');
    }, VIEW_SWITCH_MS);
  };
  viewSwitchFrame = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(start)
    : window.setTimeout(start, 0);
}

function renderCurrent(force = false, options = {}) {
  const meta = VIEW_META[state.view];
  if (!meta) return;
  // 局部状态变化只重建当前视图内容，不应把用户正在浏览的位置跳回顶部；
  // 只有切页时才由 navigate 显式传 false。
  const preserveScrollTop = options.preserveScrollTop !== false;
  const previousScrollTop = preserveScrollTop ? dom.view.scrollTop : 0;
  if (!force && viewHasFocusedInput()) {
    // 记下来，等焦点离开输入框后补一次渲染：否则这次跳过的刷新永远不会再来，
    // 页面会长期停留在旧数据上。
    renderPending = true;
    return;
  }
  renderPending = false;
  dom.viewActions.replaceChildren();
  dom.view.replaceChildren();
  try {
    meta.render(dom.view, ctx, dom.viewActions);
    updateUsageBadge();
  } catch (err) {
    dom.view.replaceChildren(
      el('div', { class: 'note note-err' }, [
        icon('alert', 15),
        el('div', {}, [
          el('div', { text: `渲染「${meta.title}」页面时出错` }),
          el('div', { class: 'mono', text: describeError(err) }),
        ]),
      ]),
    );
  }
  dom.view.scrollTop = preserveScrollTop ? previousScrollTop : 0;
}

function navigate(view) {
  if (!VIEW_META[view]) return;
  if (view === 'weixin' && state.plugins.length && !state.plugins.some((plugin) => plugin.id === 'weixin' && plugin.installed)) return;
  if (view === state.view) return;
  const token = ++viewTransitionToken;
  state.view = view;
  syncUsageAutoRefresh();
  renderChrome();
  // 先用当前缓存状态画出页面，数据加载放到后台，避免点击后进入空白或骨架等待。
  renderCurrent(true, { preserveScrollTop: false });
  playViewSwitch();
  const needsData = (VIEW_META[view].needs || []).some((key) => !state.loaded[key]);
  if (!needsData) return;
  ensureLoaded(view).then(() => {
    if (state.view !== view || token !== viewTransitionToken) return;
    renderChrome();
    renderCurrent(true, { preserveScrollTop: true });
  });
}

const LOADER_BY_KEY = {
  status: [loadStatus, '全局状态'],
  providers: [loadProviders, '提供商列表'],
  models: [loadModels, '模型列表'],
  modelLimits: [loadModelLimits, '模型上下文设置'],
  gateway: [loadGateway, '网关状态'],
  inject: [loadInject, '注入状态'],
  usage: [loadUsage, '使用量统计'],
  logs: [loadLogs, '使用量日志'],
  peer: [loadPeer, '对等共享状态'],
  weixin: [loadWeixin, '微信连接配置'],
  plugins: [loadPlugins, '插件列表'],
};

const inflight = new Map();

/** 确保某页依赖的数据已加载（同一份数据并发只拉一次） */
async function ensureLoaded(view) {
  const needs = (VIEW_META[view] && VIEW_META[view].needs) || [];
  const jobs = [];
  for (const key of needs) {
    if (state.loaded[key]) continue;
    const entry = LOADER_BY_KEY[key];
    if (!entry) continue;
    if (!inflight.has(key)) {
      const job = tryLoad(entry[0], entry[1]).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    jobs.push(inflight.get(key));
  }
  await Promise.all(jobs);
}

// ============ 提供给各视图的上下文 ============
const ctx = {
  api: null, // boot() 里填入 window.gptplus
  state,
  el,
  icon,
  toast,
  toastError,
  logLocal,
  copyText,
  fmt,
  maskKey,
  shortPath,
  describeError,
  setThemePreference,
  navigate,
  reload,
  renderChrome,
  renderCurrent,
  markRelaunchNeeded,
  relaunchChatGpt,
  checkForUpdates,
  startUpdateDownload,
  openModal,
  closeModal,
  isModalOpen,
  openProviderForm: (providerId) => openProviderForm(ctx, providerId),
  closeProviderForm: () => closeProviderForm(),
  openPeerSettings: () => openPeerSettings(ctx),
  dragRowOffsets,
  dragTargetIndex,
  reorderModelKeys,
};

// ============ 事件订阅 ============
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  try {
    api.onStatus((s) => {
      if (!s || typeof s !== 'object') return;
      observeCodexWrite(s);
      state.status = s;
      if (s.theme) setThemePreference(s.theme);
      if (s.modelLimits) state.modelLimits = s.modelLimits;
      // 视图优先读 state.gateway / state.inject 快照；只更新 state.status 的话
      // 主进程推来的新状态会被旧快照盖住（例如端口、注入开关在别处改了）。
      // 合并而不是替换：这两个快照还有 getGateway/getInject 独有的字段（token、modelBase）。
      if (s.gateway) state.gateway = { ...(state.gateway || {}), ...s.gateway };
      if (s.network) state.network = { ...(state.network || {}), ...s.network };
      if (s.inject) state.inject = { ...(state.inject || {}), ...s.inject };
      if (Array.isArray(s.models)) state.models = s.models;
      if (s.peer) updatePeerStatus(s);
      state.loaded.status = true;
      renderChrome();
      // 状态广播只更新顶部状态栏。配置操作自己的成功/失败流程负责更新当前视图，
      // 避免修改其它配置时把当前页面整棵 DOM 替换掉。
    });
  } catch (err) {
    logLocal('warn', `订阅状态事件失败: ${describeError(err)}`);
  }
  try {
    api.onUpdate((next) => handleUpdateState(next));
  } catch (err) {
    logLocal('warn', `订阅更新事件失败: ${describeError(err)}`);
  }
  try {
    // 微信连接状态：主进程每次状态变化都会推送；页面自己的状态轮询会刷新状态卡，
    // 这里不整页重渲染，避免打断正在编辑的连接设置。
    api.onWeixinStatus?.((next) => {
      if (!next || typeof next !== 'object') return;
      state.weixin = { ...(state.weixin || {}), status: next };
    });
  } catch (err) {
    logLocal('warn', `订阅微信连接状态失败: ${describeError(err)}`);
  }
  try {
    api.onPluginChange?.((event) => {
      const next = event && event.plugin;
      if (next && typeof next === 'object') {
        state.plugins = state.plugins.some((plugin) => plugin.id === next.id)
          ? state.plugins.map((plugin) => plugin.id === next.id ? next : plugin)
          : [...state.plugins, next];
        if (state.view === 'weixin' && next.id === 'weixin' && !next.installed) state.view = 'plugins';
        renderChrome();
        renderCurrent(true, { preserveScrollTop: true });
      } else {
        void tryLoad(loadPlugins, '插件列表').then(() => {
          renderChrome();
          renderCurrent(true, { preserveScrollTop: true });
        });
      }
    });
  } catch (err) {
    logLocal('warn', `订阅插件状态失败: ${describeError(err)}`);
  }
  try {
    api.onLog((entry) => {
      handleIncomingLog(entry);
    });
  } catch (err) {
    logLocal('warn', `订阅日志事件失败: ${describeError(err)}`);
  }
}

function updatePeerStatus(status) {
  state.peer = status.peer;
  if (state.view === 'settings' || state.view === 'home') renderCurrent(false, { preserveScrollTop: true });
}

// ============ 静态 DOM 接线 ============
function wireStaticDom() {
  dom.nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn && btn.dataset.view) navigate(btn.dataset.view);
  });

  // 焦点离开输入框后再补上被跳过的渲染；弹窗输入也要保护背景页面。
  const flushPendingRender = () => {
    window.setTimeout(() => {
      if (renderPending && !viewHasFocusedInput()) renderCurrent(true, { preserveScrollTop: true });
    }, 0);
  };
  dom.view.addEventListener('focusout', flushPendingRender);
  dom.modalRoot.addEventListener('focusout', flushPendingRender);

  dom.logToggle.addEventListener('click', () => setLogOpen(!state.logOpen));
  dom.logClose.addEventListener('click', () => setLogOpen(false));

  dom.logFilters.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    state.logFilter = btn.dataset.filter || 'all';
    for (const b of dom.logFilters.querySelectorAll('.filter-btn')) {
      b.classList.toggle('is-active', b === btn);
    }
    renderLogs();
  });

  dom.logClear.addEventListener('click', () => {
    const n = state.logs.length;
    state.logs = [];
    renderLogs();
    logLocal('info', `已清空 ${n} 条本地日志（主进程日志缓冲不受影响）`);
  });

  dom.logAutoscroll.addEventListener('click', () => {
    state.logPaused = false;
    autoScrollLogs(true);
  });

  dom.logList.addEventListener('scroll', () => {
    const atBottom = dom.logList.scrollHeight - dom.logList.scrollTop - dom.logList.clientHeight < 24;
    if (state.logPaused === atBottom) {
      state.logPaused = !atBottom;
      updateAutoscrollLabel();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isModalOpen()) {
      e.preventDefault();
      closeModal();
    }
  });

  window.addEventListener('error', (e) => {
    logLocal('error', `渲染层异常: ${describeError(e.error || e.message)}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    logLocal('error', `未处理的 Promise 拒绝: ${describeError(e.reason)}`);
  });

  window.addEventListener('beforeunload', stopUsageAutoRefresh);
}

function cacheDom() {
  dom.nav = document.getElementById('nav');
  dom.sidebarUpdateQuick = document.getElementById('sidebar-update-quick');
  dom.sidebarActions = document.getElementById('sidebar-actions');
  dom.sidebarFoot = document.getElementById('sidebar-foot');
  dom.viewTitle = document.getElementById('view-title');
  dom.viewSub = document.getElementById('view-sub');
  dom.viewActions = document.getElementById('view-actions');
  dom.view = document.getElementById('view');
  dom.logDrawer = document.getElementById('log-drawer');
  dom.logList = document.getElementById('log-list');
  dom.logCount = document.getElementById('log-count');
  dom.logFilters = document.getElementById('log-filters');
  dom.logClear = document.getElementById('log-clear');
  dom.logClose = document.getElementById('log-close');
  dom.logToggle = document.getElementById('log-toggle');
  dom.logToggleLabel = document.getElementById('log-toggle-label');
  dom.logToggleCount = document.getElementById('log-toggle-count');
  dom.logAutoscroll = document.getElementById('log-autoscroll');
  dom.flow = document.getElementById('flow');
  dom.themeControl = document.getElementById('theme-control');
  dom.buildTag = document.getElementById('build-tag');
  dom.modalRoot = document.getElementById('modal-root');
  dom.toastRoot = document.getElementById('toast-root');
}

function renderPreloadMissing() {
  const box = el('div', { class: 'note note-err' }, [
    icon('alert', 16),
    el('div', {}, [
      el('div', { text: '没有检测到 window.gptplus，界面无法与主进程通信。' }),
      el('div', {
        class: 'muted',
        text: '常见原因：preload.cjs 未加载（BrowserWindow 的 preload 路径不对），或主进程启动时抛出了异常。请在开发者工具 Console 里查看报错。',
      }),
    ]),
  ]);
  dom.view.replaceChildren(box);
  dom.viewActions.replaceChildren();
  dom.buildTag.textContent = 'preload 未加载';
  logLocal('error', 'window.gptplus 不存在：preload 未暴露 API');
}

async function boot() {
  cacheDom();
  wireStaticDom();
  renderChrome();
  setLogOpen(false);

  if (!window.gptplus) {
    renderPreloadMissing();
    return;
  }
  api = window.gptplus;
  ctx.api = api;
  installProviderDropGuard(ctx);

  // 先接收状态广播，网关在主进程后台启动时不会错过状态更新。
  subscribe();

  // 默认页只依赖全局状态和提供商列表，先画出可交互页面。
  await ensureLoaded('home');
  await Promise.all([
    tryLoad(loadStartup, '开机自启动状态'),
    tryLoad(loadUpdate, '更新状态'),
  ]);
  renderChrome();
  renderCurrent(true, { preserveScrollTop: false });
  syncUsageAutoRefresh();
  logLocal('info', '界面已就绪：gpt++ 渲染层 v1');
  document.documentElement.dataset.ready = '1';
  api.notifyReady?.(document.documentElement.dataset.theme);

  // 模型、设置和历史日志不再挡住首屏；加载完成后只刷新真正受影响的区域。
  void Promise.all([
    ensureLoaded('models'),
    ensureLoaded('settings'),
    tryLoad(loadUpdate, '更新状态'),
    tryLoad(loadLogs, '历史日志'),
    tryLoad(loadUsage, '使用量统计'),
  ]).then(() => {
    updateLogBadge();
    renderChrome();
    if (state.view === 'usage' || state.view === 'home') renderCurrent(true, { preserveScrollTop: true });
  });
}

if (typeof document !== 'undefined') {
  const start = () => {
    // boot() 里任何一步抛错都会让界面永久停在「正在加载…」，
    // 之前异常只落到 unhandledrejection 里，用户完全看不出来。
    Promise.resolve()
      .then(boot)
      .catch((err) => {
        try {
          logLocal('error', `界面初始化失败: ${describeError(err)}`);
          if (typeof toast === 'function') toast(`界面初始化失败：${describeError(err)}`, 'error');
        } catch {
          /* 报错路径本身再出错就只能留给控制台 */
        }
        document.documentElement.dataset.ready = '1';
        window.gptplus?.notifyReady?.();
      });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

export {
  el,
  icon,
  createSelectPicker,
  fmt,
  maskKey,
  state,
  handleIncomingLog,
  updateUsageBadge,
  mergeUsageLogs,
  refreshUsageIncrementally,
  USAGE_REFRESH_INTERVAL_MS,
};
