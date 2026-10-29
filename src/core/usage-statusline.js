'use strict';

const { buildUsageStatuslineStyle, computeUsageSnapshot, mergeUsageCacheEntry } = require('./usage-metrics.js');

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
  const CIRCUMFERENCE = 37.7;
  const SYNC_INTERVAL_MS = 1000;
  const runtimeKey = "gptplus-usage-statusline-v7";
  const STYLE_TEXT = ${JSON.stringify(buildUsageStatuslineStyle())};
  const computeUsageSnapshot = ${computeUsageSnapshot.toString()};
  const mergeUsageCacheEntry = ${mergeUsageCacheEntry.toString()};
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
      { tag: "circle", attrs: { cx: "8", cy: "8", r: "6", "stroke-width": "1", "stroke-opacity": "1" } },
      { tag: "circle", attrs: { cx: "8", cy: "8", r: "6", "stroke-width": "2.2", "stroke-dasharray": "0 " + CIRCUMFERENCE, transform: "rotate(-90 8 8)" } },
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

  function render(value) {
    const node = state.node;
    if (!node?.isConnected) return;
    const parts = state.parts || build(node);
    const labels = textLabels();
    const speed = value?.speed == null ? "--" : String(Math.max(0, Math.round(value.speed)));
    const cache = value?.cache == null ? "--" : value.cache.toFixed(1) + "%";
    const context = value?.context == null ? "--" : Math.round(value.context) + "%";
    const fingerprint = [
      speed, cache, context,
      value?.speedEstimated === true,
      value?.cacheEstimated === true,
      value?.contextEstimated === true,
      value?.window || 0,
    ].join("|");
    if (fingerprint === state.fingerprint) return;
    state.fingerprint = fingerprint;
    if (parts.speed) parts.speed.textContent = labels.speed(speed);
    if (parts.cache) parts.cache.textContent = labels.cache(cache);
    if (parts.context) parts.context.textContent = context;
    if (parts.ring) {
      const filled = value?.context == null ? 0 : value.context / 100 * CIRCUMFERENCE;
      parts.ring.setAttribute("stroke-dasharray", filled.toFixed(2) + " " + CIRCUMFERENCE);
    }
    node.dataset.hidden = String(Object.keys(parts).length === 0);
    const details = [];
    if (parts.speed) details.push("首包后生成速度 " + speed + " tok/s" + (value?.speedEstimated ? "（估算）" : ""));
    if (parts.cache) details.push("缓存命中 " + cache + (value?.cacheEstimated ? "（估算）" : ""));
    if (parts.context) details.push("上下文占用 " + context + (value?.contextEstimated ? "（估算）" : ""));
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
    const cached = state.cache.get(id);
    render(computeUsageSnapshot(cached?.events, cached?.request));
    return { id, changed: id !== previous };
  }

  function apply(id, events, request) {
    if (state.disposed) return false;
    const key = String(id || "").trim();
    if (!key) return false;
    const previous = state.cache.get(key);
    const merged = mergeUsageCacheEntry(previous, events, request);
    if (!merged) return false;
    state.cache.set(key, merged);
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
      style.textContent = STYLE_TEXT;
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
