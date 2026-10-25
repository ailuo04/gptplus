'use strict';

function buildUsageStatuslineScript({ readyWaitMs, metrics } = {}) {
  const readyWait = Math.max(500, Number(readyWaitMs) || 12000);
  const selectedMetrics = {
    speed: metrics?.speed !== false,
    cache: metrics?.cache !== false,
    context: metrics?.context !== false,
  };
  const metricsJson = JSON.stringify(selectedMetrics);
  return `(() => {
  const READY_WAIT_MS = ${readyWait};
  const METRICS = ${metricsJson};
  const ID = "gptplus-codex-usage-statusline";
  const STYLE_ID = "gptplus-codex-usage-statusline-style";
  const EXT_ATTR = "data-gptplus-usage-statusline";
  const STALE_MS = 120000;
  const CIRCUMFERENCE = 37.7;
  const SYNC_INTERVAL_MS = 5000;
  const runtimeKey = "gptplus-usage-statusline-v3";
  if (globalThis.__gptplusUsageStatuslineRuntime === runtimeKey && globalThis.__gptplusUsageStatusline) {
    return { ok: true, installed: true, reused: true };
  }
  globalThis.__gptplusUsageStatuslineDispose?.();
  globalThis.__gptplusUsageStatuslineRuntime = runtimeKey;
  const state = { node: null, parts: null, threadId: "", timer: 0, observer: null, cache: new Map(), fingerprint: "", disposed: false };
  const NS = "http://www.w3.org/2000/svg";

  function visible(node) {
    if (!node || !node.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && node.getBoundingClientRect().width > 0;
  }

  function textLabels() {
    const lang = String(document.documentElement?.lang || navigator.language || "").toLowerCase();
    return lang.startsWith("zh")
      ? { speed: (v) => v + " tok/s", cache: (v) => "缓存命中 " + v, aria: "用量状态栏" }
      : { speed: (v) => v + " tok/s", cache: (v) => "cache hit " + v, aria: "Usage status line" };
  }

  function svgIcon(shapes) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const created = [];
    for (const shape of shapes) {
      const child = document.createElementNS(NS, shape.tag);
      for (const [key, value] of Object.entries(shape.attrs)) child.setAttribute(key, value);
      svg.appendChild(child);
      created.push(child);
    }
    return { svg, created };
  }

  function ringIcon() {
    const icon = svgIcon([
      { tag: "circle", attrs: { cx: "8", cy: "8", r: "6", "stroke-opacity": ".3" } },
      { tag: "circle", attrs: { cx: "8", cy: "8", r: "6", "stroke-dasharray": "0 " + CIRCUMFERENCE, transform: "rotate(-90 8 8)" } },
    ]);
    return { svg: icon.svg, ring: icon.created[1] };
  }

  function makeItem(root, key, icon) {
    const item = document.createElement("span");
    item.className = "gptplus-usage-item";
    item.dataset.usage = key;
    item.appendChild(icon);
    const value = document.createElement("span");
    value.className = "gptplus-usage-value";
    value.textContent = "--";
    item.appendChild(value);
    root.appendChild(item);
    return value;
  }

  function build(node) {
    node.textContent = "";
    const parts = {};
    if (METRICS.speed) {
      parts.speed = makeItem(node, "speed", svgIcon([
        { tag: "path", attrs: { d: "M2 12.5a6 6 0 0 1 12 0" } },
        { tag: "path", attrs: { d: "M8 12.5 10.8 8.6" } },
      ]).svg);
    }
    if (METRICS.cache) {
      parts.cache = makeItem(node, "cache", svgIcon([
        { tag: "path", attrs: { d: "M8 2.2c2.5 0 4.5.8 4.5 1.8S10.5 5.8 8 5.8 3.5 5 3.5 4 5.5 2.2 8 2.2Z" } },
        { tag: "path", attrs: { d: "M3.5 4v8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4" } },
        { tag: "path", attrs: { d: "M3.5 8c0 1 2 1.8 4.5 1.8S12.5 9 12.5 8" } },
      ]).svg);
    }
    if (METRICS.context) {
      const ring = ringIcon();
      parts.context = makeItem(node, "context", ring.svg);
      parts.ring = ring.ring;
    }
    state.parts = parts;
    return state.parts;
  }

  function composerCard() {
    const cards = [...document.querySelectorAll("[data-composer-surface-variant]")];
    let fallback = null;
    for (const card of cards) {
      if (!visible(card) || card.closest("[" + EXT_ATTR + "]")) continue;
      fallback = card;
      if (card.querySelector('.ProseMirror[contenteditable="true"], textarea:not(:disabled):not([readonly]), [role="textbox"][contenteditable="true"]')) return card;
    }
    return fallback;
  }

  function threadId(card) {
    const root = card?.closest("[data-codex-composer-root]");
    const composerId = root?.querySelector("[data-above-composer-conversation-id]")?.getAttribute("data-above-composer-conversation-id");
    const inThread = root?.getAttribute("data-composer-placement") === "thread";
    const sidebarId = inThread ? document.querySelector('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]')?.getAttribute("data-app-action-sidebar-thread-id") : "";
    const id = String(composerId || sidebarId || "").replace(/^local:/, "").trim();
    if (!id || id.startsWith("client-new-thread:") || id === "__proto__" || id === "prototype" || id === "constructor") return "";
    return /^[A-Za-z0-9_.-]{8,128}$/.test(id) ? id : "";
  }

  function ensureNode(card) {
    if (!card) return null;
    let node = state.node;
    if (!node) {
      node = document.createElement("div");
      node.id = ID;
      node.setAttribute(EXT_ATTR, "true");
      node.setAttribute("role", "status");
      state.node = node;
    }
    // 插到输入框外层容器之后，让页面布局为状态栏留出高度，避免贴底被裁切。
    const anchor = card.parentElement || card;
    if (!node.isConnected || node.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", node);
    return node;
  }

  function percent(numerator, denominator) {
    if (!(denominator > 0) || !(numerator >= 0)) return null;
    return Math.min(100, Math.max(0, numerator / denominator * 100));
  }

  function latestTurn(events) {
    if (!Array.isArray(events) || !events.length) return [];
    let start = events.length - 1;
    const id = events[start].turn_id;
    if (typeof id === "string" && id) while (start > 0 && events[start - 1].turn_id === id) start -= 1;
    return events.slice(start);
  }

  function cacheRate(events) {
    let input = 0;
    let cached = 0;
    for (const event of latestTurn(events)) {
      const value = Number(event.input_tokens) || 0;
      if (value > 0) {
        input += value;
        cached += Math.max(0, Math.min(Number(event.cached_input_tokens) || 0, value));
      }
    }
    return input > 0 ? percent(cached, input) : null;
  }

  function speedRate(events) {
    const segment = latestTurn(events);
    const rates = [];
    for (let i = 1; i < segment.length; i += 1) {
      const before = segment[i - 1];
      const current = segment[i];
      const delta = (Number(current.turn_output_tokens) || 0) - (Number(before.turn_output_tokens) || 0);
      const seconds = (Date.parse(current.t) - Date.parse(before.t)) / 1000;
      if (delta <= 0 || seconds < 0.5 || seconds > 120) continue;
      rates.push(delta / seconds);
    }
    if (!rates.length) return null;
    const recent = rates.slice(-3);
    return recent.reduce((sum, value) => sum + value, 0) / recent.length;
  }

  function snapshot(events) {
    if (!Array.isArray(events) || !events.length) return null;
    const latest = events[events.length - 1];
    const time = Date.parse(latest.t);
    return {
      speed: speedRate(events),
      cache: cacheRate(events),
      context: percent(Number(latest.total_tokens), Number(latest.context_window)),
      stale: Number.isFinite(time) ? Date.now() - time > STALE_MS : false,
      window: Number(latest.context_window) || 0,
    };
  }

  function render(value) {
    const node = state.node;
    if (!node?.isConnected) return;
    const parts = state.parts || build(node);
    const labels = textLabels();
    const speed = value?.speed == null ? "--" : String(Math.max(0, Math.round(value.speed)));
    const cache = value?.cache == null ? "--" : value.cache.toFixed(1) + "%";
    const context = value?.context == null ? "--" : Math.round(value.context) + "%";
    const fingerprint = [speed, cache, context, value?.stale === true, value?.window || 0].join("|");
    if (fingerprint === state.fingerprint) return;
    state.fingerprint = fingerprint;
    if (parts.speed) parts.speed.textContent = labels.speed(speed);
    if (parts.cache) parts.cache.textContent = labels.cache(cache);
    if (parts.context) parts.context.textContent = context;
    if (parts.ring) {
      const filled = value?.context == null ? 0 : value.context / 100 * CIRCUMFERENCE;
      parts.ring.setAttribute("stroke-dasharray", filled.toFixed(2) + " " + CIRCUMFERENCE);
    }
    node.dataset.stale = String(value?.stale === true);
    node.dataset.hidden = String(Object.keys(parts).length === 0);
    const details = [];
    if (parts.speed) details.push("生成速度 " + speed + " tok/s");
    if (parts.cache) details.push("缓存命中 " + cache);
    if (parts.context) details.push("上下文占用 " + context);
    if (parts.context && value?.window > 0) details.push("窗口 " + value.window);
    node.title = details.join(" · ");
    node.setAttribute("aria-label", labels.aria + "：" + details.join("，"));
  }

  function hide() {
    if (state.node) state.node.dataset.hidden = "true";
    state.fingerprint = "";
  }

  function sync() {
    const card = composerCard();
    if (!card) { state.threadId = ""; hide(); return null; }
    const id = threadId(card);
    const previous = state.threadId;
    state.threadId = id;
    ensureNode(card);
    render(snapshot(state.cache.get(id)));
    return { id, changed: id !== previous };
  }

  function apply(id, events) {
    if (state.disposed) return false;
    const key = String(id || "").trim();
    if (!key || !Array.isArray(events)) return false;
    state.cache.set(key, events.slice(-24));
    while (state.cache.size > 32) state.cache.delete(state.cache.keys().next().value);
    sync();
    return true;
  }

  function context() {
    if (state.disposed) return null;
    const current = sync();
    return { id: current?.id || "", hidden: document.hidden === true, mounted: !!state.node?.isConnected };
  }

  function tick() {
    if (state.disposed) return;
    sync();
    state.timer = setTimeout(tick, SYNC_INTERVAL_MS);
  }

  function install() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute(EXT_ATTR, "true");
      const textColor = "color-mix(in srgb,var(--color-token-text-primary,#dfdfdf) 82%,transparent)";
      style.textContent = "#" + ID + "{display:flex;align-items:center;justify-content:center;gap:24px;box-sizing:border-box;width:100%;margin:6px 0 0;padding:0 10px;font:inherit;font-size:12px;line-height:17px;color:" + textColor + ";user-select:none;cursor:default}#" + ID + "[data-hidden=\\\"true\\\"]{display:none}#" + ID + " .gptplus-usage-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-variant-numeric:tabular-nums;transition:opacity .2s}#" + ID + " .gptplus-usage-item,#" + ID + " .gptplus-usage-value,#" + ID + " .gptplus-usage-item svg{color:" + textColor + "!important}#" + ID + " .gptplus-usage-value{font-weight:500}#" + ID + " .gptplus-usage-item svg{flex:0 0 auto;opacity:1}#" + ID + "[data-stale=\\\"true\\\"] .gptplus-usage-item{opacity:.55}";
      document.head?.appendChild(style);
    }
    document.getElementById(ID)?.remove();
    const composerSelector = "[data-codex-composer-root], [data-composer-surface-variant], [data-above-composer-conversation-id]";
    state.observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.target?.closest?.("[" + EXT_ATTR + "]")) return false;
        if (record.type === "attributes") return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) =>
          node.nodeType === 1 && !node.matches?.("[" + EXT_ATTR + "]")
          && (node.matches?.(composerSelector) || node.querySelector?.(composerSelector)));
      });
      if (relevant) sync();
    });
    state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-above-composer-conversation-id", "data-composer-placement", "data-app-action-sidebar-thread-selected", "data-app-action-sidebar-thread-id"] });
    sync();
    state.timer = setTimeout(tick, 2000);
    globalThis.__gptplusUsageStatusline = { context, apply };
    globalThis.__gptplusUsageStatuslineReady = true;
    globalThis.__gptplusUsageStatuslineDispose = () => {
      state.disposed = true;
      globalThis.__gptplusUsageStatuslineReady = false;
      if (globalThis.__gptplusUsageStatuslineRuntime === runtimeKey) globalThis.__gptplusUsageStatuslineRuntime = "";
      delete globalThis.__gptplusUsageStatusline;
      clearTimeout(state.timer);
      state.observer?.disconnect();
      state.node?.remove();
      document.getElementById(STYLE_ID)?.remove();
    };
  }

  // 启动阶段 CDP 可能在文档创建前就执行脚本，必须等 body 出现再安装。
  return new Promise((resolve) => {
    const deadline = Date.now() + READY_WAIT_MS;
    const boot = () => {
      if (state.disposed) { resolve({ ok: true, installed: false, disposed: true }); return; }
      if (!document.body) {
        if (Date.now() >= deadline) { resolve({ ok: true, installed: false, pending: true }); return; }
        setTimeout(boot, 100);
        return;
      }
      try {
        install();
        resolve({ ok: true, installed: true });
      } catch (error) {
        globalThis.__gptplusUsageStatuslineReady = false;
        if (globalThis.__gptplusUsageStatuslineRuntime === runtimeKey) globalThis.__gptplusUsageStatuslineRuntime = "";
        resolve({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    };
    boot();
  });
})()`;
}

module.exports = { buildUsageStatuslineScript };
