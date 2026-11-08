'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBalanceIndicatorScript, createDigitAnimationPlan, formatBalanceAmount, computeBalanceRingProgress, resumeChatGptBalance, startChatGptBalanceBridge, disposeChatGptBalance } = require('../src/core/chatgpt-balance.js');

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

test('balance ring progress follows the remaining share and uses exact threshold boundaries', () => {
  assert.deepEqual(computeBalanceRingProgress({ balance: '80', totalUsed: '20', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '80', level: 'normal' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '20', totalUsed: '80', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '20', level: 'normal' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '19.99', totalUsed: '80.01', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '19.99', level: 'warning' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '5', totalUsed: '95', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '5', level: 'warning' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '4.99', totalUsed: '95.01', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '4.99', level: 'danger' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '0', totalUsed: '100', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '0', level: 'danger' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '8', totalUsed: null, unit: 'USD', totalUsedUnit: 'USD' }), { percent: null, level: 'normal' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '8', totalUsed: '2', unit: 'USD', totalUsedUnit: 'CNY' }), { percent: null, level: 'normal' });
  assert.deepEqual(computeBalanceRingProgress({ unlimited: true }), { percent: '100', level: 'normal' });
});

test('balance ring progress caps overfull quotas instead of drawing past a full circle', () => {
  assert.deepEqual(computeBalanceRingProgress({ balance: '20', totalUsed: '0', unit: 'USD', totalUsedUnit: 'USD' }), { percent: '100', level: 'normal' });
  assert.deepEqual(computeBalanceRingProgress({ balance: '8', totalUsed: null, unit: 'USD', totalUsedUnit: 'USD' }), { percent: null, level: 'normal' });
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
  assert.match(script, /#gptplus-balance-indicator\{[^}]*background:transparent/, 'indicator should be a hollow outline ring, not a filled circle');
  assert.match(script, /conic-gradient/, 'indicator should render a progress ring');
  assert.match(script, /background:conic-gradient\(from 0deg,var\(--gpb-ring-color\) 0% var\(--gpb-progress\)/, 'remaining quota should start at 12 o’clock and progress clockwise');
  assert.doesNotMatch(script, /--gpb-turn/, 'a percentage progress value must not be multiplied into degrees incorrectly');
  assert.match(script, /--gpb-ring-color/, 'ring color should be driven by a shared threshold variable');
  assert.match(script, /pointerenter/, 'details should be hover-triggered rather than click-triggered');
  assert.match(script, /touch-action:none/, 'dragging must not be intercepted by touch scrolling');
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
  assert.equal(ring.listeners.click, undefined, 'details should not be click-triggered');
  assert.equal(details.dataset.open, 'false');
  ring.listeners.pointerenter({ stopPropagation() {} });
  const refresh = details.children[details.children.length - 1];
  listeners.get('pointerdown')({ target: composer, preventDefault() {} });
  assert.equal(typeof listeners.get('pointerdown'), 'function', 'outside close listener should be installed');
  ring.listeners.pointerenter({ stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  listeners.get('pointerdown')({ target: composer, preventDefault() {} });
  assert.equal(details.dataset.open, 'false');
  ring.listeners.pointerenter({ stopPropagation() {} });
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

test('balance ring paints progress, threshold colors, and hover details with the requested fields', async () => {
  const vm = require('node:vm');
  const nodes = [];
  const listeners = new Map();
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = { setProperty(name, value) { this[name] = value; } };
      this.dataset = {}; this.listeners = {}; this.isConnected = true; this.className = ''; this.id = ''; this.textContent = ''; this.parentElement = null;
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
    getBoundingClientRect() { return this.rect || { left: 12, top: 870, right: 48, bottom: 906, width: 36, height: 36 }; }
    setPointerCapture() {}
    contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  const script = buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] });
  await vm.runInNewContext(script, sandbox);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  const details = nodes.find((node) => node.id === 'gptplus-balance-indicator-details');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '20', totalUsed: '80', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', at: 1000, ok: true, providerSnapshots: { p_a: { providerId: 'p_a', providerName: 'Alpha Relay', balance: '20', totalUsed: '80', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', at: 1000 }, p_b: { providerId: 'p_b', providerName: 'Beta Relay', balance: '999', currency: 'USD', unit: 'USD' } }, providerList: [{ providerId: 'p_a', name: 'Alpha Relay' }, { providerId: 'p_b', name: 'Beta Relay' }] });
  assert.equal(ring.dataset.level, 'normal');
  assert.equal(ring.style['--gpb-progress'], '20%');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '19', totalUsed: '81', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', at: 1000, ok: true });
  assert.equal(ring.dataset.level, 'warning');
  assert.equal(ring.style['--gpb-progress'], '19%');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '4', totalUsed: '96', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', delta: '0.12', deltaKind: 'cumulative', at: 1000, ok: true });
  assert.equal(ring.dataset.level, 'danger');
  assert.equal(ring.style['--gpb-progress'], '4%');
  assert.equal(details.dataset.open, 'false');
  ring.listeners.pointerenter({ preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  assert.match(details.children.map((node) => node.textContent).join(' '), /Alpha Relay|p_a/);
  const detailText = (node) => (node.textContent || '') + ' ' + (node.children || []).map(detailText).join(' ');
  assert.match(details.children.map(detailText).join(' '), /余额/);
  assert.match(details.children.map(detailText).join(' '), /消耗值/);
  assert.match(details.children.map(detailText).join(' '), /最近一次消耗量/);
  assert.doesNotMatch(details.children.map(detailText).join(' '), /Beta Relay|999/);
  ring.listeners.pointerleave({ preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'false');
});

test('balance toast stays inside every viewport edge while dragging', async () => {
  const vm = require('node:vm');
  const nodes = [];
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
    getBoundingClientRect() {
      if (this.id === 'gptplus-balance-indicator-toast') return { left: 100, top: 100, right: 100 + (this.textContent.length * 7), bottom: 120, width: this.textContent.length * 7, height: 20 };
      return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
    }
    setPointerCapture() {}
    contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 320, height: 240, addEventListener() {}, removeEventListener() {} }, innerWidth: 320, innerHeight: 240, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  await vm.runInNewContext(buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] }), sandbox);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  const toast = nodes.find((node) => node.id === 'gptplus-balance-indicator-toast');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '99', totalUsed: '1', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', delta: '12345678901234567890.1234', deltaKind: 'cumulative', at: 1000, ok: true });
  ring.rect = { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
  ring.listeners.pointerdown({ button: 0, pointerId: 3, clientX: 20, clientY: 910, preventDefault() {}, stopPropagation() {} });
  ring.listeners.pointermove({ pointerId: 3, clientX: 0, clientY: 0, preventDefault() {} });
  ring.rect = { left: 8, top: 8, right: 44, bottom: 44, width: 36, height: 36 };
  ring.listeners.pointerup({ pointerId: 3, clientX: 0, clientY: 0, preventDefault() {} });
  const left = Number(String(toast.style.left).replace('px', ''));
  const top = Number(String(toast.style.top).replace('px', ''));
  const width = toast.textContent.length * 7;
  assert.ok(left >= 8, 'toast must keep its left edge inside viewport');
  assert.ok(left + width <= 312, 'toast must keep its right edge inside viewport');
  assert.ok(top >= 8, 'toast must not be clipped at the top edge');
  assert.ok(top + 20 <= 232, 'toast must not be clipped at the bottom edge');
});

test('balance toast is shown once per successful snapshot and ignores cache replays', async () => {
  const vm = require('node:vm');
  const nodes = [];
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
    setPointerCapture() {}
    contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  await vm.runInNewContext(buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] }), sandbox);
  const toast = nodes.find((node) => node.id === 'gptplus-balance-indicator-toast');
  const snapshot = { providerId: 'p_a', currentProviderId: 'p_a', balance: '9', totalUsed: '1', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', delta: '0.02', deltaKind: 'cumulative', at: 1000, ok: true };
  sandbox.__gptplusBalance.apply({ ...snapshot, at: 1000 });
  assert.equal(toast.dataset.visible, 'true');
  toast.dataset.visible = 'false';
  sandbox.__gptplusBalance.apply({ ...snapshot, at: 1000 });
  assert.equal(toast.dataset.visible, 'false', 'a cached snapshot must not trigger the same consumption toast again');
  sandbox.__gptplusBalance.apply({ ...snapshot, at: 2000, delta: '0.03' });
  assert.equal(toast.dataset.visible, 'true', 'a newer successful read should show its own consumption amount');
  assert.match(toast.textContent, /0\.03/);
});

test('balance consumption toast keeps a non-zero tiny amount visible', async () => {
  const vm = require('node:vm');
  const nodes = [];
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
    setPointerCapture() {}
    contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  await vm.runInNewContext(buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] }), sandbox);
  const toast = nodes.find((node) => node.id === 'gptplus-balance-indicator-toast');
  sandbox.__gptplusBalance.apply({ providerId: 'p_a', currentProviderId: 'p_a', balance: '9', totalUsed: '1.0000001', currency: 'USD', unit: 'USD', totalUsedUnit: 'USD', delta: '0.0000001', deltaKind: 'cumulative', at: 1000, ok: true });
  assert.equal(toast.dataset.visible, 'true');
  assert.match(toast.textContent, /^-\<\$0\.01$/);
});

test('balance details flip beside the ring and stay inside a narrow viewport', async () => {
  const vm = require('node:vm');
  const nodes = [];
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
    getBoundingClientRect() {
      if (this.id === 'gptplus-balance-indicator-details') return { left: 100, top: 100, right: 340, bottom: 240, width: 240, height: 140 };
      return this.rect || { left: 8, top: 898, right: 44, bottom: 934, width: 36, height: 36 };
    }
    setPointerCapture() {}
    contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 320, height: 240, addEventListener() {}, removeEventListener() {} }, innerWidth: 320, innerHeight: 240, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  await vm.runInNewContext(buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] }), sandbox);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  const details = nodes.find((node) => node.id === 'gptplus-balance-indicator-details');
  ring.rect = { left: 8, top: 190, right: 52, bottom: 234, width: 44, height: 44 };
  ring.listeners.pointerenter({ preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  const left = Number(String(details.style.left).replace('px', ''));
  assert.ok(left >= 8, 'details must stay to the right of the viewport edge');
  assert.ok(left + 240 <= 312, 'details must stay inside the viewport after flipping');
  const top = Number(String(details.style.top).replace('px', ''));
  assert.ok(top >= 8, 'details must stay below the top edge');
  assert.ok(top + 140 <= 232, 'details must stay above the bottom edge');
});

test('balance hover details remain open while moving from the ring into the popup', async () => {
  const vm = require('node:vm');
  const nodes = [];
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
    setPointerCapture() {}
    contains(node) { return node === this || this.children.includes(node); }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  await vm.runInNewContext(buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] }), sandbox);
  const ring = nodes.find((node) => node.id === 'gptplus-balance-indicator');
  const details = nodes.find((node) => node.id === 'gptplus-balance-indicator-details');
  ring.listeners.pointerenter({ preventDefault() {}, stopPropagation() {} });
  assert.equal(details.dataset.open, 'true');
  ring.listeners.pointerleave({ preventDefault() {}, stopPropagation() {}, relatedTarget: details });
  assert.equal(details.dataset.open, 'true', 'crossing toward details must not close the popup');
  details.listeners.pointerenter({ preventDefault() {}, stopPropagation() {} });
  details.listeners.pointerleave({ preventDefault() {}, stopPropagation() {}, relatedTarget: ring });
  assert.equal(details.dataset.open, 'true');
  details.listeners.pointerleave({ preventDefault() {}, stopPropagation() {}, relatedTarget: composer });
  assert.equal(details.dataset.open, 'false');
});

test('balance indicator refresh replaces stale styles and progress markup after an update', async () => {
  const vm = require('node:vm');
  const nodes = [];
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this.isConnected = true; this.className = ''; this.id = ''; this.textContent = ''; this.parentElement = null; }
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
    contains(node) { return node === this; }
  }
  const profile = new Node('button'); profile.setAttribute('aria-label', '打开个人资料菜单');
  const rail = new Node('nav'); rail.setAttribute('data-app-navigation-rail', 'true'); rail.appendChild(profile);
  const modelLabel = new Node('span'); modelLabel.className = 'ModelPickerTriggerModelText-test'; modelLabel.__reactFiber$test = { memoizedProps: { model: 'fapi__model-a' }, return: null };
  const composer = new Node('div'); composer.appendChild(modelLabel); composer.querySelectorAll = () => []; composer.closest = () => composer;
  const head = new Node('head'); const body = new Node('body'); body.appendChild(rail); body.appendChild(composer);
  const doc = { documentElement: { lang: 'en' }, body, head, hidden: false, createElement: (tag) => { const node = new Node(tag); nodes.push(node); return node; }, getElementById: (id) => nodes.find((node) => node.id === id && node.isConnected) || null, querySelector: (selector) => selector.includes('data-app-navigation-rail') ? rail : null, querySelectorAll: (selector) => selector.includes('ModelPickerTriggerModelText') ? [modelLabel] : selector.includes('data-composer-navigation-target') ? [composer] : selector.includes('button') ? [profile] : [] };
  const sandbox = { document: doc, window: { addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en-US' }, visualViewport: { offsetLeft: 0, width: 1377, height: 943, addEventListener() {}, removeEventListener() {} }, innerWidth: 1377, innerHeight: 943, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {}, Date, Intl, matchMedia: () => ({ matches: false }), Math, Map, Set, JSON, String, Number, BigInt, Object, Array };
  const oldStyle = new Node('style'); oldStyle.id = 'gptplus-balance-indicator-style'; oldStyle.textContent = 'stale style'; head.appendChild(oldStyle);
  const oldRoot = new Node('div'); oldRoot.id = 'gptplus-balance-indicator-root'; body.appendChild(oldRoot);
  let disposed = 0;
  sandbox.__gptplusBalanceRuntime = 'gptplus-balance-indicator-v1';
  sandbox.__gptplusBalance = { dispose() { disposed += 1; oldStyle.remove(); oldRoot.remove(); } };
  const refreshed = await vm.runInNewContext(buildBalanceIndicatorScript({ modelRoutes: [{ slug: 'fapi__model-a', providerId: 'p_a' }] }), sandbox);
  assert.equal(refreshed.installed, true);
  assert.equal(refreshed.reused, undefined, 'a newer page runtime must not reuse the previous injected UI');
  assert.equal(disposed, 1, 'a newer page runtime must dispose the previous injected UI');
  const ring = nodes.filter((node) => node.id === 'gptplus-balance-indicator' && node.isConnected).at(-1);
  const styles = nodes.filter((node) => node.id === 'gptplus-balance-indicator-style' && node.isConnected);
  assert.equal(styles.length, 1, 'a reinjection must not leave duplicate style nodes');
  assert.match(styles[0].textContent, /--gpb-progress/);
  assert.ok(ring.children.some((child) => child.className === 'gpb-ring'), 'a reinjected ring must contain its progress visual');
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
  ring.listeners.pointerenter({ stopPropagation() {} });
  const details = nodes.find((node) => node.id === 'gptplus-balance-indicator-details');
  const detailText = (node) => (node.textContent || '') + ' ' + (node.children || []).map(detailText).join(' ');
  assert.match(details.children.map(detailText).join(' '), /454\.8/);
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
    plugins: { isActive: (id) => id === 'usage-statusline', config: () => ({ balance: { ...config, enabled: true } }) },
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
  assert.equal(calls.some((call) => call[0] === 'refresh' && call[2].reason === 'details'), false, 'opening details must not refresh other providers');
  assert.equal(JSON.stringify(pageState.value).includes('apiKey'), false);
  const port = result.cdpPort;
  const disposed = await disposeChatGptBalance({ cdpPort: port, target, evaluateImpl: async () => ({ ok: true }), removeScriptImpl: async () => ({}) });
  assert.equal(disposed.ok, true);
  assert.ok(calls.some((call) => call[0] === 'current' && call[1] === ''), 'dispose must clear the current provider timer selection');
});
