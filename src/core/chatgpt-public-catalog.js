'use strict';

// Extend the desktop client's public page without changing its remote catalog or
// installing plugins. Each item navigates to the client's own local detail page.
const path = require('node:path');
const { findChatGptDebugPort } = require('./chatgpt-launch.js');
const { listTargets, pickMainTarget, waitForTarget, evaluate } = require('./cdp.js');

let activeBridge = null;
let bridgeGeneration = 0;

function publicCatalogPage(catalog) {
  if (!document.head || !document.documentElement) {
    document.addEventListener('DOMContentLoaded', () => publicCatalogPage(catalog), { once: true });
    return { ok: true, installed: true, count: catalog.plugins.length };
  }
  const key = '__gptplusPublicCatalog';
  globalThis[key]?.dispose?.();
  const state = { panel: null, observer: null, input: null, disposed: false, scheduled: false };
  const id = 'gptplus-public-local-catalog';
  const cssId = 'gptplus-public-local-catalog-style';
  const style = document.createElement('style');
  style.id = cssId;
  style.textContent = `
    #gptplus-public-local-catalog { margin: 20px 0 28px; }
    #gptplus-public-local-catalog .gp-head { font-weight: 600; margin-bottom: 4px; }
    #gptplus-public-local-catalog .gp-hint { color: var(--color-text-secondary, #777); font-size: 12px; margin-bottom: 12px; }
    #gptplus-public-local-catalog .gp-filter { box-sizing: border-box; width: 100%; max-width: 320px; padding: 7px 10px; margin-bottom: 12px; border: 1px solid var(--color-border-default, #ddd); border-radius: 8px; background: transparent; color: inherit; }
    #gptplus-public-local-catalog .gp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; }
    #gptplus-public-local-catalog .gp-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px; text-align: left; background: transparent; color: inherit; border: 1px solid var(--color-border-default, #ddd); border-radius: 9px; cursor: pointer; }
    #gptplus-public-local-catalog .gp-item:hover { background: var(--color-surface-secondary, rgba(128,128,128,.10)); }
    #gptplus-public-local-catalog .gp-item:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    #gptplus-public-local-catalog .gp-text { min-width: 0; flex: 1; }
    #gptplus-public-local-catalog .gp-name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #gptplus-public-local-catalog .gp-description { display: block; font-size: 12px; color: var(--color-text-secondary, #777); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #gptplus-public-local-catalog .gp-open { flex: none; font-size: 18px; }
    #gptplus-public-local-catalog .gp-empty { font-size: 12px; color: var(--color-text-secondary, #777); }
  `;
  document.head.appendChild(style);
  const lang = String(document.documentElement?.lang || navigator.language || '').toLowerCase();
  const zh = lang.startsWith('zh');
  const words = zh
    ? { title: '本地插件示例（gpt++）', hint: '来自本机缓存，并非远程公共目录；点击后在客户端详情页自行安装。', filter: '筛选本地插件示例', empty: '没有匹配的本地插件', open: '打开插件详情：' }
    : { title: 'Local plugin examples (gpt++)', hint: 'From the local cache, not the remote public catalog. Open a plugin to install it in the client.', filter: 'Filter local plugin examples', empty: 'No matching local plugins', open: 'Open plugin details: ' };

  function routeFor(item) {
    const query = new URLSearchParams({ marketplacePath: catalog.marketplacePath, pluginName: item.name, hostId: 'local', directoryTab: 'openai' });
    return '/plugins/' + encodeURIComponent(item.name + '@gptplus-curated').replaceAll('%40', '@') + '?' + query.toString();
  }
  function draw() {
    if (!state.panel) return;
    const grid = state.panel.querySelector('.gp-grid');
    const search = String(state.input?.value || '').trim().toLowerCase();
    grid.replaceChildren();
    const matching = catalog.plugins.filter((p) => [p.name, p.displayName, p.description, p.category].some((value) => String(value || '').toLowerCase().includes(search)));
    for (const item of matching) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gp-item';
      button.setAttribute('aria-label', words.open + item.displayName);
      const text = document.createElement('span');
      text.className = 'gp-text';
      const name = document.createElement('span');
      name.className = 'gp-name';
      name.textContent = item.displayName;
      const description = document.createElement('span');
      description.className = 'gp-description';
      description.textContent = item.description || item.category;
      text.append(name, description);
      const action = document.createElement('span');
      action.className = 'gp-open';
      action.textContent = '›';
      action.setAttribute('aria-hidden', 'true');
      button.append(text, action);
      button.addEventListener('click', () => {
        // The desktop client consumes this local message through its normal router.
        window.postMessage({ type: 'navigate-to-route', path: routeFor(item) }, '*');
      });
      grid.appendChild(button);
    }
    if (!matching.length) {
      const empty = document.createElement('div');
      empty.className = 'gp-empty';
      empty.textContent = words.empty;
      grid.appendChild(empty);
    }
  }
  function makePanel() {
    const panel = document.createElement('section');
    panel.id = id;
    panel.setAttribute('aria-label', words.title);
    const heading = document.createElement('div');
    heading.className = 'gp-head';
    heading.textContent = words.title + ' · ' + catalog.plugins.length;
    const hint = document.createElement('div');
    hint.className = 'gp-hint';
    hint.textContent = words.hint;
    const input = document.createElement('input');
    input.className = 'gp-filter';
    input.type = 'search';
    input.placeholder = words.filter;
    input.setAttribute('aria-label', words.filter);
    input.addEventListener('input', draw);
    const grid = document.createElement('div');
    grid.className = 'gp-grid';
    panel.append(heading, hint, input, grid);
    state.input = input;
    state.panel = panel;
    draw();
    return panel;
  }
  function update() {
    if (state.disposed) return;
    const search = document.getElementById('plugins-store-page-search');
    const tablist = search && [...document.querySelectorAll('[role="tablist"]')].find((node) => {
      const tabs = [...node.querySelectorAll('[role="tab"]')];
      return tabs.some((tab) => /^(公开|public)$/i.test(tab.textContent.trim()))
        && tabs.some((tab) => /^(个人|personal)$/i.test(tab.textContent.trim()));
    });
    const active = tablist?.querySelector('[role="tab"][aria-selected="true"]');
    if (!tablist || !active || !/^(公开|public)$/i.test(active.textContent.trim())) {
      state.panel?.remove();
      return;
    }
    const panel = state.panel || makePanel();
    let anchor = tablist;
    // Keep injected DOM outside React's tablist wrapper when it has its own
    // siblings (such as the native category list), so a rerender cannot remove it.
    while (anchor.parentElement && (!anchor.nextElementSibling || anchor.nextElementSibling === panel) && anchor.parentElement !== document.body) {
      anchor = anchor.parentElement;
    }
    if (!anchor.parentElement) return;
    if (anchor.nextElementSibling !== panel) anchor.insertAdjacentElement('afterend', panel);
  }
  function schedule() {
    if (state.scheduled || state.disposed) return;
    state.scheduled = true;
    setTimeout(() => { state.scheduled = false; update(); }, 50);
  }
  state.observer = new MutationObserver(schedule);
  state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  state.dispose = () => {
    state.disposed = true;
    state.observer.disconnect();
    state.panel?.remove();
    document.getElementById(cssId)?.remove();
    if (globalThis[key] === state) delete globalThis[key];
  };
  globalThis[key] = state;
  update();
  return { ok: true, installed: true, count: catalog.plugins.length };
}

function buildPublicCatalogScript(catalog) {
  return `(${publicCatalogPage.toString()})(${JSON.stringify(catalog)})`;
}

function isChatGptPage(page) {
  const url = String(page?.url || '');
  return /^app:\/\/-\/index\.html(?:[?#]|$)/i.test(url)
    || (url !== 'about:blank' && /chatgpt|codex/i.test(String(page?.title || '')));
}

function stopPublicCatalogBridge({ disposeInFlight = false } = {}) {
  bridgeGeneration += 1;
  if (!activeBridge) return;
  activeBridge.stop(disposeInFlight);
  activeBridge = null;
}

async function startPublicCatalogOnPort({ ctx, cdpPort, target = null, timeoutMs = 15000, intervalMs = 1500, evaluateImpl = evaluate, listTargetsImpl = listTargets, waitForTargetImpl = waitForTarget } = {}) {
  if (ctx?.plugins?.isActive && !ctx.plugins.isActive('chatgpt-plugin-catalog')) return { ok: false, skipped: true, disabled: true };
  const catalog = ctx?.chatgptPluginRecovery?.publicCatalog?.();
  if (!catalog || !Array.isArray(catalog.plugins) || !catalog.plugins.length) throw new Error('本地插件市场没有可显示的条目');
  stopPublicCatalogBridge();
  const generation = bridgeGeneration;
  const source = buildPublicCatalogScript(catalog);
  let page = target || await waitForTargetImpl(cdpPort, { timeoutMs });
  if (!target && !isChatGptPage(page)) {
    const deadline = Date.now() + timeoutMs;
    while (!isChatGptPage(page) && Date.now() < deadline && generation === bridgeGeneration) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      page = pickMainTarget(await listTargetsImpl(cdpPort));
    }
    if (!isChatGptPage(page)) throw new Error('未找到 ChatGPT 主页面');
  }
  if (generation !== bridgeGeneration) return { ok: false, skipped: true };
  const result = await evaluateImpl(page, source);
  if (generation !== bridgeGeneration || (ctx?.plugins?.isActive && !ctx.plugins.isActive('chatgpt-plugin-catalog'))) {
    if (ctx?.plugins?.isActive && !ctx.plugins.isActive('chatgpt-plugin-catalog')) {
      await evaluateImpl(page, 'globalThis.__gptplusPublicCatalog?.dispose?.(); ({ ok: true })');
    }
    return { ok: false, skipped: true };
  }
  if (result?.installed !== true) throw new Error('插件列表页面脚本未安装');

  // CDP registrations made on a short-lived socket disappear when it closes.
  // Reattach after a reload or replacement of the client window instead.
  let stopped = false;
  let timer = null;
  let lastErrorAt = 0;
  let reinjecting = null;
  const bridge = {
    stop(disposeInFlight) {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (disposeInFlight && page && reinjecting) {
        void reinjecting.finally(() => evaluateImpl(page, 'globalThis.__gptplusPublicCatalog?.dispose?.(); ({ ok: true })')).catch(() => {});
      }
    },
    cdpPort,
  };
  activeBridge = bridge;
  async function poll() {
    if (stopped) return;
    try {
      if (!page) {
        const candidate = pickMainTarget(await listTargetsImpl(cdpPort));
        if (isChatGptPage(candidate)) page = candidate;
      }
      if (page) {
        const installed = await evaluateImpl(page, 'Boolean(globalThis.__gptplusPublicCatalog)');
        if (!installed && !stopped) {
          reinjecting = evaluateImpl(page, source);
          try { await reinjecting; } finally { reinjecting = null; }
        }
      }
    } catch (error) {
      page = null;
      if (Date.now() - lastErrorAt > 60000) {
        lastErrorAt = Date.now();
        ctx?.log?.({ level: 'warn', msg: '公开页本地插件列表暂时无法更新: ' + error.message });
      }
    }
    if (!stopped) {
      timer = setTimeout(poll, intervalMs);
      timer.unref?.();
    }
  }
  timer = setTimeout(poll, intervalMs);
  timer.unref?.();
  return { ok: true, count: catalog.plugins.length, cdpPort };
}

async function disposePublicCatalog({ cdpPort, target = null } = {}) {
  stopPublicCatalogBridge({ disposeInFlight: true });
  const page = target || pickMainTarget(await listTargets(cdpPort));
  if (!page) return { ok: false, skipped: true };
  await evaluate(page, 'globalThis.__gptplusPublicCatalog?.dispose?.(); ({ ok: true })');
  return { ok: true };
}

async function resumePublicCatalog({ ctx, findPort = findChatGptDebugPort, listTargetsImpl = listTargets } = {}) {
  if (!ctx?.plugins?.isActive?.('chatgpt-plugin-catalog')) return { ok: false, skipped: true, disabled: true };
  const executablePath = ctx?.store?.get?.()?.chatgpt?.executablePath || '';
  const imageName = executablePath ? path.win32.basename(executablePath) : '';
  const port = await findPort(imageName ? { imageName } : {});
  if (!port) return { ok: false, skipped: true };
  const page = pickMainTarget(await listTargetsImpl(port));
  if (!isChatGptPage(page)) return { ok: false, skipped: true };
  try {
    return await startPublicCatalogOnPort({ ctx, cdpPort: port, target: page });
  } catch (error) {
    ctx?.log?.({ level: 'warn', msg: '公开页本地插件列表加载失败: ' + error.message });
    return { ok: false, error: error.message };
  }
}

module.exports = { buildPublicCatalogScript, startPublicCatalogOnPort, resumePublicCatalog, disposePublicCatalog, stopPublicCatalogBridge };
