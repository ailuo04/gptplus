'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildPublicCatalogScript, startPublicCatalogOnPort, stopPublicCatalogBridge } = require('../src/core/chatgpt-public-catalog.js');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.parentElement = null; this.className = ''; this.value = ''; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...items) { for (const item of items) this.appendChild(item); }
  appendChild(item) { item.remove(); this.children.push(item); item.parentElement = this; return item; }
  remove() { if (!this.parentElement) return; const children = this.parentElement.children; children.splice(children.indexOf(this), 1); this.parentElement = null; }
  replaceChildren(...items) { for (const item of this.children) item.parentElement = null; this.children = []; this.append(...items); }
  get nextElementSibling() { if (!this.parentElement) return null; const children = this.parentElement.children; return children[children.indexOf(this) + 1] || null; }
  insertAdjacentElement(where, item) { assert.equal(where, 'afterend'); item.remove(); const children = this.parentElement.children; children.splice(children.indexOf(this) + 1, 0, item); item.parentElement = this.parentElement; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector === '[role="tablist"]') return this.attributes.role === 'tablist';
    if (selector === '[role="tab"]') return this.attributes.role === 'tab';
    if (selector === '[role="tab"][aria-selected="true"]') return this.attributes.role === 'tab' && this.attributes['aria-selected'] === 'true';
    throw Error('unexpected selector: ' + selector);
  }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture() {
  const html = new Element('html');
  html.lang = 'zh-CN';
  const head = new Element('head');
  const body = new Element('body');
  html.append(head, body);
  const search = new Element('input');
  search.id = 'plugins-store-page-search';
  const anchor = new Element('div');
  const tabs = new Element('div');
  tabs.setAttribute('role', 'tablist');
  const publicTab = new Element('button');
  publicTab.textContent = '公开';
  publicTab.setAttribute('role', 'tab');
  publicTab.setAttribute('aria-selected', 'true');
  const personalTab = new Element('button');
  personalTab.textContent = '个人';
  personalTab.setAttribute('role', 'tab');
  personalTab.setAttribute('aria-selected', 'false');
  tabs.append(publicTab, personalTab);
  anchor.append(tabs);
  const nativeList = new Element('section');
  nativeList.textContent = 'Native public plugins';
  body.append(search, anchor, nativeList);
  const document = {
    head, body, documentElement: html,
    createElement: (tag) => new Element(tag),
    getElementById: (id) => [html, ...html.descendants()].find((node) => node.id === id) || null,
    querySelectorAll: (selector) => html.querySelectorAll(selector),
  };
  const messages = [];
  const observers = [];
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const context = vm.createContext({ document, navigator: { language: 'zh-CN' }, window: { postMessage: (message) => messages.push(message) }, MutationObserver, URLSearchParams, setTimeout });
  return { html, document, anchor, publicTab, personalTab, context, messages, observers };
}

const catalog = { marketplacePath: 'C:\\local market\\.agents\\plugins\\marketplace.json', plugins: [
  { name: 'linear', displayName: 'Linear', description: 'Issues', category: 'Productivity' },
  { name: 'demo', displayName: '<img src=x>', description: 'Demo', category: 'Coding' },
] };

test('公开页显示本地示例、筛选和原生详情入口；切换标签和停用后移除', async () => {
  const f = fixture();
  const result = vm.runInContext(buildPublicCatalogScript(catalog), f.context);
  assert.equal(result.installed, true);
  assert.equal(result.count, 2);
  const panel = f.document.getElementById('gptplus-public-local-catalog');
  assert.ok(panel);
  assert.equal(f.anchor.nextElementSibling, panel);
  assert.equal(panel.nextElementSibling.textContent, 'Native public plugins');
  assert.match(panel.textContent, /本地插件示例（gpt\+\+）/);
  assert.match(panel.textContent, /并非远程公共目录/);
  const grid = panel.querySelector('.gp-grid');
  assert.equal(grid.children.length, 2);
  assert.equal(grid.children[1].children[0].children[0].textContent, '<img src=x>', '插件文字不能作为 HTML 执行');
  grid.children[0].listeners.click();
  assert.equal(f.messages.length, 1);
  const message = f.messages[0];
  assert.equal(message.type, 'navigate-to-route');
  const [route, query] = message.path.split('?');
  assert.equal(route, '/plugins/linear@gptplus-curated');
  assert.equal(new URLSearchParams(query).get('marketplacePath'), catalog.marketplacePath);
  assert.equal(new URLSearchParams(query).get('pluginName'), 'linear');
  const filter = panel.querySelector('.gp-filter');
  filter.value = 'demo';
  filter.listeners.input();
  assert.equal(grid.children.length, 1);
  assert.match(grid.textContent, /Demo/);
  f.observers[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.anchor.nextElementSibling, panel, '重复更新不能移动到原生列表之后');
  f.publicTab.setAttribute('aria-selected', 'false');
  f.personalTab.setAttribute('aria-selected', 'true');
  f.observers[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.document.getElementById('gptplus-public-local-catalog'), null);
  f.publicTab.setAttribute('aria-selected', 'true');
  f.personalTab.setAttribute('aria-selected', 'false');
  f.observers[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(f.document.getElementById('gptplus-public-local-catalog'));
  f.context.__gptplusPublicCatalog.dispose();
  assert.equal(f.document.getElementById('gptplus-public-local-catalog'), null);
  assert.equal(f.document.getElementById('gptplus-public-local-catalog-style'), null);
  assert.equal(f.observers[0].disconnected, true);
});

test('重复注入会清理旧列表和观察器', () => {
  const f = fixture();
  vm.runInContext(buildPublicCatalogScript(catalog), f.context);
  vm.runInContext(buildPublicCatalogScript(catalog), f.context);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.html.descendants().filter((node) => node.id === 'gptplus-public-local-catalog').length, 1);
  assert.equal(f.html.descendants().filter((node) => node.id === 'gptplus-public-local-catalog-style').length, 1);
  f.context.__gptplusPublicCatalog.dispose();
});


test('公开页桥接在页面重载后重新注入，停用后不再注入', async (t) => {
  t.after(stopPublicCatalogBridge);
  let installed = false;
  let injections = 0;
  const ctx = { plugins: { isActive: () => true }, chatgptPluginRecovery: { publicCatalog: () => catalog } };
  const page = { id: 'test', url: 'app://-/index.html' };
  const evaluateImpl = async (_page, expression) => {
    if (expression === 'Boolean(globalThis.__gptplusPublicCatalog)') return installed;
    installed = true;
    injections += 1;
    return { installed: true };
  };
  await startPublicCatalogOnPort({ ctx, cdpPort: 1234, target: page, intervalMs: 20, evaluateImpl });
  assert.equal(injections, 1);
  installed = false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(injections, 2);
  stopPublicCatalogBridge();
  installed = false;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(injections, 2);
});
