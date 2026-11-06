'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBalanceIndicatorScript, createDigitAnimationPlan, formatBalanceAmount, resumeChatGptBalance, startChatGptBalanceBridge, disposeChatGptBalance } = require('../src/core/chatgpt-balance.js');

test('balance formatter keeps compact readable amounts with at most two decimals', () => {
  assert.equal(formatBalanceAmount('1234.005', 'USD', 'USD', 'en-US').text, '$1,234.01');
  assert.equal(formatBalanceAmount('72.123456789', 'USD', 'USD', 'en-US').text, '$72.12');
  assert.equal(formatBalanceAmount('0.00001234', 'USD', 'USD', 'en-US').text, '<$0.01');
  assert.equal(formatBalanceAmount('1.25', 'CNY', 'CNY', 'zh-CN').text, '¥1.25');
  assert.equal(formatBalanceAmount('1500000.6789', null, '额度', 'zh-CN').text, '1,500,000.68 额度');
  assert.equal(formatBalanceAmount('1500000', null, '额度', 'zh-CN').text, '1,500,000 额度');
});
test('balance digit animation only rolls changed positions', () => {
  const plan = createDigitAnimationPlan(
    { integer: '72', fraction: '40' },
    { integer: '71', fraction: '92' },
  );
  assert.deepEqual(plan.integerChanges, [{ from: '2', to: '1', fromIndexFromRight: 0 }]);
  assert.deepEqual(plan.fractionChanges, [
    { from: '4', to: '9', index: 0 },
    { from: '0', to: '2', index: 1 },
  ]);
  const unchanged = createDigitAnimationPlan(
    { integer: '72', fraction: '40' },
    { integer: '72', fraction: '40' },
  );
  assert.equal(unchanged.changedCount, 0);
});

test('balance indicator script reads exact model prop and fails closed on unknown slug', async () => {
  const script = buildBalanceIndicatorScript({
    modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }],
  });
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /__reactFiber\$/);
  assert.match(script, /data-composer-navigation-target/);
  assert.match(script, /__gptplusBalance/);
  assert.match(script, /visualViewport/);
  assert.match(script, /#gptplus-balance-indicator\{[^}]*border:4px solid[^}]*background:transparent/, 'indicator should be a hollow outline ring, not a filled circle');
  assert.doesNotMatch(script, /apiKey|Authorization|sk-[A-Za-z0-9]/);
});

test('balance indicator anchors above the bottom profile/settings button and ignores sidebar text', async () => {
  const vm = require('node:vm');
  const nodes = [];
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.style = {};
      this.dataset = {};
      this.isConnected = true;
      this.className = '';
      this.id = '';
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    addEventListener() {}
    remove() { this.isConnected = false; this.parentElement?.children?.splice(this.parentElement.children.indexOf(this), 1); }
    querySelectorAll() { return this.children; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 }; }
  }
  const settingsChat = new Node('div');
  settingsChat.setAttribute('role', 'button');
  settingsChat.setAttribute('aria-label', '将设置和更新改为液态玻璃弹窗');
  settingsChat.rect = { left: 60, top: 203, right: 332, bottom: 233, width: 272, height: 30 };
  const profile = new Node('button');
  profile.setAttribute('aria-label', '打开个人资料菜单');
  profile.rect = { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
  const rail = new Node('nav');
  rail.setAttribute('aria-label', '应用导航');
  rail.setAttribute('data-app-navigation-rail', 'true');
  rail.appendChild(settingsChat);
  rail.appendChild(profile);
  const modelLabel = new Node('span');
  modelLabel.className = 'ModelPickerTriggerModelText-test';
  modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div');
  composer.appendChild(modelLabel);
  composer.querySelectorAll = () => [];
  composer.closest = () => composer;
  const head = new Node('head');
  const body = new Node('body');
  body.appendChild(rail);
  body.appendChild(composer);
  const doc = {
    documentElement: { lang: 'en' },
    body,
    head,
    hidden: false,
    createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; },
    getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null,
    querySelector: (selector) => (selector.includes('data-app-navigation-rail') ? rail : null),
    querySelectorAll: (selector) => {
      if (selector.includes('ModelPickerTriggerModelText')) return [modelLabel];
      if (selector.includes('data-composer-navigation-target')) return [composer];
      if (selector.includes('button')) return [settingsChat, profile];
      return [];
    },
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {} },
    navigator: { language: 'en-US' },
    visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} },
    innerWidth: 1377,
    innerHeight: 943,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 2,
    clearInterval() {},
    Date,
    Intl,
    matchMedia: () => ({ matches: false }),
    Math, Map, Set, JSON, String, Number, BigInt, Object, Array,
  };
  const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
  const result = await vm.runInNewContext(script, sandbox);
  assert.equal(result.installed, true);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  assert.equal(ring.isConnected, true);
  assert.equal(ring.style.left, '8px', 'ring should stay over the narrow left rail');
  assert.equal(ring.style.top, '846px', 'ring should sit 8px above the profile button');
});
test('balance indicator supports dragging, remembers its position, and restores the default', async () => {
  const vm = require('node:vm');
  const nodes = [];
  const listeners = new Map();
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.style = {};
      this.dataset = {};
      this.isConnected = true;
      this.className = '';
      this.id = '';
      this.parentElement = null;
      this.textContent = '';
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    addEventListener(name, callback) { this.listeners = this.listeners || {}; this.listeners[name] = callback; }
    removeEventListener() {}
    remove() { this.isConnected = false; this.parentElement?.children?.splice(this.parentElement.children.indexOf(this), 1); }
    querySelectorAll() { return this.children; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 }; }
    setPointerCapture() {}
  }
  const profile = new Node('button');
  profile.setAttribute('aria-label', '打开个人资料菜单');
  profile.rect = { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
  const rail = new Node('nav');
  rail.setAttribute('data-app-navigation-rail', 'true');
  rail.appendChild(profile);
  const modelLabel = new Node('span');
  modelLabel.className = 'ModelPickerTriggerModelText-test';
  modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div');
  composer.appendChild(modelLabel);
  composer.querySelectorAll = () => [];
  composer.closest = () => composer;
  const head = new Node('head');
  const body = new Node('body');
  body.appendChild(rail);
  body.appendChild(composer);
  const doc = {
    documentElement: { lang: 'en' },
    body,
    head,
    hidden: false,
    createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; },
    getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null,
    querySelector: (selector) => (selector.includes('data-app-navigation-rail') ? rail : null),
    querySelectorAll: (selector) => {
      if (selector.includes('ModelPickerTriggerModelText')) return [modelLabel];
      if (selector.includes('data-composer-navigation-target')) return [composer];
      if (selector.includes('button')) return [profile];
      return [];
    },
  };
  const storage = new Map();
  const sandbox = {
    document: doc,
    window: {
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name) { listeners.delete(name); },
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    navigator: { language: 'en-US' },
    visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} },
    innerWidth: 1377,
    innerHeight: 943,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 2,
    clearInterval() {},
    Date,
    Intl,
    matchMedia: () => ({ matches: false }),
    Math, Map, Set, JSON, String, Number, BigInt, Object, Array,
  };
  const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
  const result = await vm.runInNewContext(script, sandbox);
  assert.equal(result.installed, true);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  assert.equal(ring.style.left, '8px');
  assert.equal(ring.style.top, '846px');
  assert.match(ring.getAttribute('title') || '', /拖动.*双击恢复/);
  assert.equal(typeof ring.listeners.pointerdown, 'function', 'ring should be draggable with pointer events');
  ring.listeners.pointerdown({ button: 0, pointerId: 7, clientX: 20, clientY: 860, preventDefault() {}, stopPropagation() {} });
  ring.listeners.pointermove({ pointerId: 7, clientX: 320, clientY: 520, preventDefault() {} });
  ring.listeners.pointerup({ pointerId: 7, clientX: 320, clientY: 520, preventDefault() {} });
  assert.equal(ring.style.left, '308px');
  assert.equal(ring.style.top, '558px');
  assert.equal(JSON.parse(storage.get('gptplus-balance-indicator-position-v1')).left, 308);
  ring.listeners.dblclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(ring.style.left, '8px');
  assert.equal(ring.style.top, '846px');
  assert.equal(storage.has('gptplus-balance-indicator-position-v1'), false);
});
test('balance details close on outside pointerdown and refresh without closing', async () => {
  const vm = require('node:vm');
  const nodes = [];
  const listeners = new Map();
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {};
      this.isConnected = true; this.className = ''; this.id = ''; this.textContent = ''; this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    removeEventListener() {}
    remove() { this.isConnected = false; this.parentElement?.children?.splice(this.parentElement.children.indexOf(this), 1); }
    querySelectorAll() { return this.children; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 }; }
    setPointerCapture() {}
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单'); profile.rect = { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = {
    documentElement: { lang: 'en' }, body, head, hidden: false,
    createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; },
    getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null,
    querySelector: (selector) => (selector.includes('data-app-navigation-rail') ? rail : null),
    querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [],
  };
  const sandbox = { document: doc, window: { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
  const result = await vm.runInNewContext(script, sandbox);
  assert.equal(result.installed, true);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  const details = nodes.find((node) => node.id === 'gptplus-balance-indicator-details');
  ring.listeners.click({ button: 0, preventDefault() {}, stopPropagation() {} });
  const refresh = details.children[details.children.length - 1];
  listeners.get('pointerdown')({ target: composer, preventDefault() {} });
  assert.equal(typeof listeners.get('pointerdown'), 'function', 'outside close listener should be installed');
  ring.listeners.click({ button: 0, preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  listeners.get('pointerdown')({ target: composer, preventDefault() {} });
  assert.equal(details.dataset.open, 'false');
  ring.listeners.click({ button: 0, preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  refresh.listeners.click({ button: 0, preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  listeners.get('pointerdown')({ target: details, preventDefault() {} });
  assert.equal(details.dataset.open, 'true');
});

test('balance page runtime maps only exact slugs, rejects stale provider pushes, and disposes overlay', async () => {
  const vm = require('node:vm');
  const nodes = [];
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.style = {};
      this.dataset = {};
      this.listeners = {};
      this.isConnected = true;
      this.textContent = '';
      this.parentElement = null;
      this.className = '';
      this.id = '';
      nodes.push(this);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    removeEventListener(name) { delete this.listeners[name]; }
    remove() { this.isConnected = false; this.parentElement?.children?.splice(this.parentElement.children.indexOf(this), 1); }
    querySelectorAll() { return this.children; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return this.rect || { left: 12, top: 870, right: 48, bottom: 906, width: 36, height: 36 }; }
    insertAdjacentElement(_where, child) { this.appendChild(child); }
  }
  const profile = new Node('button');
  profile.setAttribute('aria-label', '打开个人资料菜单');
  profile.rect = { left: 8, top: 890, right: 44, bottom: 926, width: 36, height: 36 };
  const picker = new Node('button');
  picker.setAttribute('data-composer-navigation-target', 'reasoning');
  const modelLabel = new Node('span');
  modelLabel.className = 'ModelPickerTriggerModelText-test';
  modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  picker.appendChild(modelLabel);
  const head = new Node('head');
  const body = new Node('body');
  const doc = {
    documentElement: { lang: 'en' },
    body,
    head,
    hidden: false,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null,
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector.includes('ModelPickerTriggerModelText')) return [modelLabel];
      if (selector.includes('data-composer-navigation-target')) return [picker];
      if (selector.includes('button')) return [profile];
      return [];
    },
  };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, removeEventListener() {} },
    navigator: { language: 'en-US' },
    visualViewport: { offsetLeft: 0, width: 1200, addEventListener() {}, removeEventListener() {} },
    innerWidth: 1200,
    innerHeight: 940,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 2,
    clearInterval() {},
    Date,
    Intl,
    matchMedia: () => ({ matches: false }),
    Math,
    Map,
    Set,
    JSON,
    String,
    Number,
    BigInt,
    Object,
    Array,
  };
  const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
  const result = await vm.runInNewContext(script, sandbox);
  assert.equal(result.installed, true);
  assert.equal(sandbox.__gptplusBalance.context().providerId, 'p_a');
  assert.equal(sandbox.__gptplusBalance.apply({ providerId: 'p_a', balance: '72.40', currency: 'USD', unit: 'USD', at: 1000 }), true);
  assert.equal(sandbox.__gptplusBalance.apply({ providerId: 'p_other', balance: '8', currency: 'USD', unit: 'USD' }), false);
  assert.equal(sandbox.__gptplusBalance.apply({ providerId: 'p_a', balance: '71.92', currency: 'USD', unit: 'USD' }), true);
  const amountNode = nodes.find((node) => node.id === 'gptplus-balance-indicator-value');
  assert.equal(amountNode.children.filter((node) => node.className === 'gpb-track').length, 2, 'only the changed cents should scroll');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', balance: '71.92', currency: 'USD', unit: 'USD' });
  assert.equal(amountNode.children.filter((node) => node.className === 'gpb-track').length, 0, 'unchanged values should not animate');
  modelLabel.__reactFiber$test.memoizedProps.model = 'unknown__model';
  assert.equal(sandbox.__gptplusBalance.context().providerId, '');
  sandbox.__gptplusBalance.dispose();
  assert.equal(nodes.some((node) => node.id === 'gptplus-balance-indicator-root' && node.isConnected), false);
});



test('balance page shows the last successful value while waiting for a new read', async () => {
  const vm = require('node:vm');
  const nodes = [];
  const listeners = new Map();
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this.isConnected = true; this.className = ''; this.id = ''; this.textContent = ''; this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    removeEventListener() {}
    remove() { this.isConnected = false; this.parentElement?.children?.splice(this.parentElement.children.indexOf(this), 1); }
    querySelectorAll() { return this.children; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 }; }
    setPointerCapture() {} contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单'); profile.rect = { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => (selector.includes('data-app-navigation-rail') ? rail : null), querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
  const result = await vm.runInNewContext(script, sandbox);
  assert.equal(result.installed, true);
  const value = nodes.find((node) => node.id === 'gptplus-balance-indicator-value');
  assert.equal(sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '455.3', currency: 'USD', unit: 'USD', at: 1000, ok: true, providerSnapshots: { p_a: { providerId: 'p_a', balance: '455.3', currency: 'USD', unit: 'USD', at: 1000 } } }), true);
  assert.equal(value.children.map((node) => node.textContent).join(''), '$455.3');
  modelLabel.__reactFiber$test.memoizedProps.model = 'fapi__model-a';
  sandbox.__gptplusBalance.context();
  assert.equal(value.children.map((node) => node.textContent).join(''), '$455.3', 'same provider model switch should retain the last value');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', ok: false, error: 'temporary upstream error', providerSnapshots: { p_a: { providerId: 'p_a', balance: '455.3', currency: 'USD', unit: 'USD', at: 1000 } } });
  assert.equal(value.children.map((node) => node.textContent).join(''), '$455.3', 'refresh failure should keep the last successful value visible');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', ok: true, balance: '454.8', currency: 'USD', unit: 'USD', at: 2000 });
  assert.match(value.children.map((node) => node.textContent).join(''), /^\$45/);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  ring.listeners.click({ button: 0, preventDefault() {}, stopPropagation() {} });
  const details = nodes.find((node) => node.id === 'gptplus-balance-indicator-details');
  assert.match(details.children.map((node) => node.textContent).join(' '), /454\.8/);
});

test('balance page restores the last successful value after reinjection', async () => {
  const vm = require('node:vm');
  const storage = new Map();
  const buildPage = async () => {
    const nodes = [];
    const listeners = new Map();
    class Node {
      constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this.isConnected = true; this.className = ''; this.id = ''; this.textContent = ''; this.parentElement = null; }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      getAttribute(name) { return this.attributes[name] || null; }
      removeAttribute(name) { delete this.attributes[name]; }
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
      replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      removeEventListener() {}
      remove() { this.isConnected = false; }
      querySelectorAll() { return this.children; }
      getClientRects() { return this.isConnected ? [{}] : []; }
      getBoundingClientRect() { return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 }; }
      setPointerCapture() {} contains(node) { return node === this; }
    }
    const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
    const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
    const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
    const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
    const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
    const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => (selector.includes('data-app-navigation-rail') ? rail : null), querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
    const sandbox = { document: doc, window: { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } }, localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
    const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
    const result = await vm.runInNewContext(script, sandbox);
    return { result, nodes, sandbox };
  };
  const first = await buildPage();
  assert.equal(first.result.installed, true);
  first.sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '455.29645593', currency: 'USD', unit: 'USD', at: 1000, ok: true });
  const saved = JSON.parse(storage.get('gptplus-balance-last-value-v1'));
  assert.equal(saved.last.balance, '455.29645593');
  assert.equal(JSON.stringify(saved).includes('apiKey'), false);
  first.sandbox.__gptplusBalance.dispose();
  const second = await buildPage();
  assert.equal(second.result.installed, true);
  const value = second.nodes.find((node) => node.id === 'gptplus-balance-indicator-value');
  assert.match(value.children.map((node) => node.textContent).join(''), /^\$455/);
  const ring = second.nodes.find((node) => node.id === 'gptplus-balance-indicator');
  assert.equal(ring.dataset.stale, 'true');
  assert.match(ring.getAttribute('aria-label') || '', /上一次读取/);
});

test('chatgpt balance lifecycle injects, follows model switches, pushes only safe snapshots, and disposes', async () => {
  const target = { id: 'page-1', type: 'page', url: 'app://-/index.html', title: 'ChatGPT' };
  const calls = [];
  let current = { modelSlug: 'a__m1', providerId: 'p_a', manualRefresh: 0 };
  let pageScript = false;
  const pageState = { value: null };
  const runtime = {
    configure(config) { calls.push(['configure', config]); },
    setCurrentProvider(id) { calls.push(['current', id]); },
    refresh(id, options) { calls.push(['refresh', id, options]); return Promise.resolve({ ok: true, providerId: id }); },
    refreshCurrent() { return Promise.resolve({ ok: true }); },
    getSnapshots() { return { p_a: { providerId: 'p_a', balance: '3.2', currency: 'USD', unit: 'USD', apiKey: undefined } }; },
    onUpdate(callback) { this.callback = callback; return () => { this.callback = null; }; },
    stop() { calls.push(['stop']); },
  };
  const config = { providers: [{ providerId: 'p_a', adapter: 'sub2api' }, { providerId: 'p_b', adapter: 'newapi' }], refreshIntervalSeconds: 60 };
  const ctx = {
    store: { get: () => ({ providers: [], chatgpt: {} }), providers: () => [{ id: 'p_a', name: 'Provider A' }, { id: 'p_b', name: 'Provider B' }] },
    plugins: { isActive: (id) => id === 'provider-balance', config: () => config },
    balanceRuntime: runtime,
    models: () => [
      { slug: 'a__m1', providerId: 'p_a', providerName: 'A', enabled: true },
      { slug: 'b__m2', providerId: 'p_b', providerName: 'B', enabled: true },
    ],
  };
  const result = await resumeChatGptBalance({
    ctx,
    findPort: async () => 9229,
    listTargetsImpl: async () => [target],
    inject: async () => { pageScript = true; return { installed: true }; },
    startBridge: (options) => startChatGptBalanceBridge({ ...options, pollMs: 5,
      listTargetsImpl: async () => [target],
      evaluateImpl: async (_page, expression) => {
        if (expression.includes('.context?.()')) return { ...current, mounted: pageScript };
        if (expression.includes('.apply?.(')) { pageState.value = JSON.parse(expression.slice(expression.indexOf('(') + 1, -1).split(',')[0]); return true; }
        return { installed: true };
      },
      ensurePageScript: async () => { pageScript = true; return { installed: true }; },
    }),
  });
  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(calls.some((call) => call[0] === 'current' && call[1] === 'p_a'));
  assert.ok(calls.some((call) => call[0] === 'refresh' && call[1] === 'p_a'));
  current = { modelSlug: 'b__m2', providerId: 'p_b', manualRefresh: 0 };
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(calls.some((call) => call[0] === 'current' && call[1] === 'p_b'));
  assert.ok(calls.some((call) => call[0] === 'refresh' && call[1] === 'p_b'));
  current = { modelSlug: 'b__m2', providerId: 'p_b', manualRefresh: 0, detailsOpen: true };
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call[0] === 'refresh' && call[1] === 'p_a' && call[2].reason === 'details'), 'opening details reads other mapped balances once');
  assert.equal(JSON.stringify(pageState.value).includes('apiKey'), false);
  const port = result.cdpPort;
  const disposed = await disposeChatGptBalance({ cdpPort: port, target, evaluateImpl: async () => ({ ok: true }), removeScriptImpl: async () => ({}) });
  assert.equal(disposed.ok, true);
  assert.ok(calls.some((call) => call[0] === 'current' && call[1] === ''), 'dispose must clear the current provider timer selection');
});