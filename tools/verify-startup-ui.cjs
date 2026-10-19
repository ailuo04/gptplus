'use strict';
// Run with electron. Real renderer, isolated API: never changes login items.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.GPTPLUS_STARTUP_UI_OUTPUT || path.join(root, 'probe', 'startup-ui'));
const reports = [];
let win;
const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map((v) => JSON.stringify(v)).join(',')})`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await run(fn)) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${fn}`);
}
async function inspect(label) {
  await run(() => document.querySelector('.sidebar-startup').scrollIntoView({ block: 'nearest', behavior: 'instant' }));
  await wait(180);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await wait(250);
  const r = await run(() => {
    const card = document.querySelector('.sidebar-startup');
    const rect = (n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      card: rect(card), toggle: rect(card.querySelector('[role="switch"]')),
      title: rect(card.querySelector('.sidebar-startup-title')),
      thumb: getComputedStyle(card.querySelector('.sidebar-startup-thumb')).backgroundColor,
      background: getComputedStyle(card).backgroundImage,
      surface: getComputedStyle(card).backgroundColor,
      theme: document.documentElement.dataset.theme,
      options: [...card.querySelectorAll('[role="radio"]')].map((n) => ({
        ...rect(n), overflow: n.scrollWidth > n.clientWidth,
        selected: n.classList.contains('is-selected'), color: getComputedStyle(n).color,
        lines: n.querySelector('span').getClientRects().length,
      })), errors: window.__startupTest.errors(),
    };
  });
  assert.ok(Math.abs(r.toggle.y + r.toggle.height / 2 - r.title.y - r.title.height / 2) < 2, `${label}: switch and title must share a row`);
  assert.ok(r.toggle.x > r.title.right, `${label}: switch must be right of title`);
  assert.ok(r.card.height <= 92, `${label}: compact card, got ${r.card.height}`);
  assert.equal(r.background, 'none', `${label}: no gradient`);
  assert.equal(r.surface, r.theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(24, 28, 35)', `${label}: correct theme surface`);
  assert.equal(r.thumb, 'rgb(255, 255, 255)', `${label}: white thumb`);
  for (const o of r.options) {
    const expectedColor = o.selected
      ? (r.theme === 'light' ? 'rgb(23, 37, 46)' : 'rgb(243, 246, 251)')
      : (r.theme === 'light' ? 'rgb(80, 98, 108)' : 'rgb(154, 167, 185)');
    assert.equal(o.color, expectedColor, `${label}: readable mode text after theme change`);
    assert.equal(o.overflow, false, `${label}: no text overflow`);
    assert.equal(o.lines, 1, `${label}: single-line mode labels`);
    assert.ok(o.x >= r.card.x && o.right <= r.card.right, `${label}: options inside card`);
    assert.ok(o.y >= r.toggle.bottom, `${label}: options below header`);
  }
  assert.equal(r.options[0].height, r.options[1].height, `${label}: equal option heights`);
  assert.ok(Math.abs(r.options[0].width - r.options[1].width) < 0.1, `${label}: mode options must have equal widths`);
  assert.deepEqual(r.errors, [], `${label}: no renderer errors`);
  reports.push({ label, ...r });
  console.log(`[pass] ${label}`);
  return r;
}
async function shot(name, crop) {
  // Flush the hidden window's compositor before retaining the screenshot.
  await win.webContents.capturePage();
  await wait(500);
  const image = await win.webContents.capturePage(crop && {
    x: Math.floor(crop.x), y: Math.floor(crop.y), width: Math.ceil(crop.width), height: Math.ceil(crop.height),
  });
  assert.equal(image.isEmpty(), false);
  fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
}
async function click(selector) {
  const point = await run((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  }
  await wait(60);
}
const idle = () => !document.querySelector('.sidebar-startup-toggle').disabled;
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: {
    additionalArguments: process.argv.includes('--review-app') ? ['--visual-demo'] : [],
    preload: path.join(root, 'test', 'fixtures', 'startup-ui-preload.cjs'),
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  try {
    await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    await until(() => document.documentElement.dataset.ready === '1' && !document.querySelector('.sidebar-startup-toggle').disabled);
    if (process.argv.includes('--review-app')) {
      await wait(600);
      const review = [];
      const gallery = [];
      for (const theme of ['light', 'dark']) {
        await run((t) => { document.documentElement.dataset.theme = t; }, theme);
        for (const [width, height] of [[1440, 900], [940, 620]]) {
          win.setContentSize(width, height);
          for (const view of ['home', 'providers', 'models', 'usage', 'settings']) {
            await run((v) => document.querySelector(`[data-view="${v}"]`).click(), view);
            await wait(650);
            const expectedTitle = { home: '\u4e3b\u9875', providers: '\u63d0\u4f9b\u5546', models: '\u6a21\u578b', usage: '\u4f7f\u7528\u91cf', settings: '\u8bbe\u7f6e' }[view];
            assert.equal(await run(() => document.querySelector('#view-title').textContent), expectedTitle);
            await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            await wait(300);
            const result = await run(() => ({
              title: document.querySelector('#view-title').textContent,
              textLength: document.querySelector('#view').textContent.length,
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
              networkLines: document.querySelector('.sidebar-network-title').getClientRects().length,
              networkTitleHeight: document.querySelector('.sidebar-network-title').getBoundingClientRect().height,
              networkOptionHeight: document.querySelector('.sidebar-network-option').getBoundingClientRect().height,
              footerOverflow: [...document.querySelectorAll('.flow-val, .flow-summary')].filter(n => n.getBoundingClientRect().width > 0).some(n => n.scrollWidth > n.clientWidth),
              switchSizes: [...document.querySelectorAll('.switch, .switch-table')].map(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })),
              errors: window.__startupTest.errors(),
            }));
            assert.ok(result.textLength > 30);
            assert.deepEqual(result.errors, []);
            assert.equal(result.horizontalOverflow, false, 'No document overflow');
            assert.ok(result.networkTitleHeight < 22, 'Network title must stay on one line');
            assert.ok(result.networkOptionHeight <= 30, 'Network modes must stay compact');
            assert.equal(result.footerOverflow, false, 'Status text must not be truncated');
            for (const size of result.switchSizes) assert.deepEqual(size, { width: 36, height: 20 }, 'Unified switch geometry');
            await shot(`review-${theme}-${width}-${view}`);
            const images = [`review-${theme}-${width}-${view}.png`];
            const scroll = await run(() => {
              const n = document.querySelector('#view');
              return { height: n.clientHeight, max: n.scrollHeight - n.clientHeight };
            });
            for (let y = 0, page = 1; y < scroll.max; page++) {
              y = Math.min(scroll.max, y + Math.floor(scroll.height * 0.85));
              await run((top) => { document.querySelector('#view').scrollTop = top; }, y);
              await wait(300);
              const name = `review-${theme}-${width}-${view}-part${page}`;
              await shot(name);
              images.push(`${name}.png`);
            }
            await run(() => { document.querySelector('#view').scrollTop = 0; });
            gallery.push({ theme, width, height, title: expectedTitle, images });
            review.push({ theme, width, height, view, ...result });
            console.log(`[review] ${theme} ${width} ${view}`);
          }
        }
      }
      fs.writeFileSync(path.join(output, 'app-review.json'), JSON.stringify(review, null, 2));
      const sections = gallery.map((g) => `<section><h2>${g.title} / ${g.theme} / ${g.width} x ${g.height}</h2>${g.images.map((src, i) => `<figure><a href="${src}" target="_blank"><img src="${src}" alt="${g.title} ${g.theme} ${i + 1}" loading="lazy"></a><figcaption>${i + 1} / ${g.images.length}</figcaption></figure>`).join('')}</section>`).join('');
      fs.writeFileSync(path.join(output, 'gallery.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gpt++ / UI Review</title><style>body{margin:0;background:#edf1f3;color:#17252e;font:14px 'Segoe UI',sans-serif}header{padding:24px;max-width:1440px;margin:auto}h1{font-size:24px;margin:0 0 8px}p{line-height:1.6}main{max-width:1440px;margin:auto;padding:0 24px 40px}section{padding:20px 0;border-top:1px solid #bdcbd1}h2{font-size:18px}figure{margin:16px 0 28px}img{width:100%;height:auto;display:block;border:1px solid #bdcbd1;box-sizing:border-box}figcaption{padding:8px 0;color:#50626c}</style><header><h1>gpt++ / UI Review</h1><p>Actual Electron screenshots using isolated demonstration data. Four views, light/dark themes, desktop/minimum window. Long views are captured in overlapping scroll sections. Click an image for its full resolution.</p></header><main>${sections}</main></html>`);
      app.exit(0);
      return;
    }
    for (const theme of ['light', 'dark']) {
      await run((t) => { document.documentElement.dataset.theme = t; }, theme);
      for (const [width, height] of [[1440, 900], [940, 620]]) {
        win.setContentSize(width, height);
        await wait(220);
        const r = await inspect(`${theme}-${width}x${height}`);
        await shot(`${theme}-${width}`, r.card);
        await shot(`${theme}-${width}-window`);
      }
    }
    await click('[data-startup-target="both"]');
    await until(idle);
    assert.equal(await run(() => document.querySelector('[data-startup-target="both"]').getAttribute('aria-checked')), 'true');
    await shot('dark-both', (await inspect('both-selected')).card);
    await click('[data-startup-target="gptplus"]');
    await until(idle);
    assert.equal(await run(() => document.querySelector('[data-startup-target="gptplus"]').getAttribute('aria-checked')), 'true', 'Must switch back from both to gptplus');
    assert.equal(await run(() => document.querySelector('[data-startup-target="both"]').getAttribute('aria-checked')), 'false');
    assert.deepEqual(await run(() => window.__startupTest.calls().slice(-1)), [{ enabled: true, target: 'gptplus' }]);
    await shot('dark-gptplus-restored', (await inspect('gptplus-restored')).card);
    await click('[data-startup-target="both"]');
    await until(idle);
    assert.equal(await run(() => document.querySelector('[data-startup-target="both"]').getAttribute('aria-checked')), 'true');
    await click('.sidebar-startup-toggle');
    await until(idle);
    assert.equal(await run(() => document.querySelector('.sidebar-startup-toggle').getAttribute('aria-checked')), 'false');
    assert.equal(await run(() => [...document.querySelectorAll('.sidebar-startup-option')].every((n) => n.disabled)), true);
    await shot('dark-off', (await inspect('off')).card);
    await click('.sidebar-startup-toggle');
    await until(idle);
    await run(() => window.__startupTest.holdNext());
    await click('.sidebar-startup-toggle');
    assert.equal(await run(() => [...document.querySelectorAll('.sidebar-startup button')].every((n) => n.disabled)), true);
    await inspect('saving');
    await run(() => window.__startupTest.finish(false));
    await until(idle);
    assert.equal(await run(() => document.querySelector('.sidebar-startup-toggle').getAttribute('aria-checked')), 'true');
    assert.equal(await run(() => document.querySelector('[data-startup-target="both"]').getAttribute('aria-checked')), 'true');
    await inspect('error-restored');
    await run(() => document.querySelector('.sidebar-startup-toggle').focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await until(() => document.querySelector('.sidebar-startup-toggle').getAttribute('aria-checked') === 'false' && !document.querySelector('.sidebar-startup-toggle').disabled);
    await click('.sidebar-startup-toggle');
    await until(idle);
    // Desktop-only app: mobile checks cover the live component, not the whole app.
    await run(() => {
      const card = document.querySelector('.sidebar-startup');
      document.body.replaceChildren(card);
      Object.assign(document.body.style, { minWidth: '0', padding: '16px' });
      card.style.width = '188px';
    });
    win.setContentSize(390, 844);
    await wait(200);
    for (const theme of ['light', 'dark']) {
      await run((t) => { document.documentElement.dataset.theme = t; }, theme);
      await inspect(`${theme}-component-390x844`);
      await shot(`${theme}-mobile-component`);
    }
    const calls = await run(() => window.__startupTest.calls());
    assert.deepEqual(calls[0], { enabled: true, target: 'both' });
    assert.deepEqual(calls[1], { enabled: true, target: 'gptplus' });
    assert.deepEqual(calls[2], { enabled: true, target: 'both' });
    assert.deepEqual(calls[3], { enabled: false, target: 'both' });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ result: 'passed', reports, calls }, null, 2));
    console.log(`[pass] mode selection, off/on, saving lock, error rollback, keyboard; ${reports.length} layout checks`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await shot('failure').catch(() => {});
    app.exit(1);
  }
});
