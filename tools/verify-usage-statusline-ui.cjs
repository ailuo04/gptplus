'use strict';
// Render the actual injected script in Chromium using an isolated composer fixture.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildUsageStatuslineScript } = require('../src/core/usage-statusline.js');
const output = path.resolve(__dirname, '../probe/usage-statusline-ui');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));
const run = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map(value => JSON.stringify(value)).join(',')})`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, width: 836, height: 240, webPreferences: {
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
  } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><style>
      *{box-sizing:border-box}body{margin:0;padding:20px 12px;font:13px "Segoe UI",sans-serif;background:#fff;color:#111}
      html[data-theme="dark"] body{background:#202123;color:#eee;--color-token-text-primary:#eee}
      [data-composer-surface-variant]{height:74px;border:1px solid #9996;border-radius:16px;padding:16px}
    </style></head><body><main data-codex-composer-root data-composer-placement="thread">
      <div data-above-composer-conversation-id="thread_ui_1234"></div>
      <div><div data-composer-surface-variant="default"><div role="textbox" contenteditable="true">消息输入框</div></div></div>
    </main></body></html>`));
    const reports = [];
    for (const theme of ['light', 'dark']) {
      await run(win, value => { document.documentElement.dataset.theme = value; }, theme);
      for (const width of [836, 600, 390, 280]) {
        win.setContentSize(width, 240);
        await run(win, () => new Promise(resolve => { const deadline = setTimeout(resolve, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(deadline); resolve(); })); }));
        for (const scenario of ['empty', 'usage', 'delta', 'long', 'no-balance', 'balance-only', 'english']) {
          const balance = { enabled: scenario !== 'no-balance' };
          const metrics = scenario === 'balance-only' ? { speed: false, cache: false, context: false } : undefined;
          await run(win, lang => {
            globalThis.__gptplusUsageStatuslineDispose?.();
            document.documentElement.lang = lang;
          }, scenario === 'english' ? 'en-US' : 'zh-CN');
          const installed = await win.webContents.executeJavaScript(buildUsageStatuslineScript({ balance, metrics }));
          assert.equal(installed.installed, true);
          const baseline = await run(win, scenario => {
            const api = globalThis.__gptplusUsageStatusline;
            if (scenario !== 'empty') {
              const at = Date.now();
              api.apply('thread_ui_1234', [{ t: new Date(at).toISOString(), context_window: 1000, total_tokens: 450 }],
                { at, speed: 42.36, inputTokens: 400, cachedInputTokens: 300, totalTokens: 450, cacheUsageAvailable: true });
              const snapshot = { ok: true, balance: scenario === 'long' ? '123456789.12' : '438.17', deltaKind: 'cumulative' };
              api.applyBalance(snapshot);
              const baseline = [...document.getElementById('gptplus-codex-usage-statusline').children].map(node => {
                const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height };
              });
              if (['delta', 'long'].includes(scenario)) api.applyBalance({ ...snapshot, delta: '123.4567' });
              return baseline;
            }
          }, scenario);
          await run(win, () => new Promise(resolve => { const deadline = setTimeout(resolve, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(deadline); resolve(); })); }));
          if (theme === 'light' && width === 836 && scenario === 'delta') {
            const animations = await run(win, () => document.querySelector('.gptplus-balance-delta').getAnimations().map(animation => animation.transitionProperty));
            assert.ok(animations.includes('transform'), 'spend popup animates out instead of appearing instantly');
          }
          if (['delta', 'long'].includes(scenario)) await new Promise(resolve => setTimeout(resolve, 260));
          const result = await run(win, () => {
            const rect = node => {
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
            };
            const bar = document.getElementById('gptplus-codex-usage-statusline');
            return { bar: rect(bar), viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth,
              items: [...bar.children].map(node => ({ ...rect(node), key: node.dataset.usage, text: node.textContent })),
              visible: [...document.querySelectorAll('.gptplus-usage-value,.gptplus-balance-amount,.gptplus-balance-delta')]
                .filter(node => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden')
                .map(node => ({ ...rect(node), text: node.textContent })),
            };
          });
          const name = `${theme}-${width}-${scenario}`;
          if (scenario !== 'empty') {
            if (scenario !== 'balance-only') assert.ok(result.items.some(item => item.text === '42.4 tok/s'), name);
            if (balance.enabled) assert.ok(result.visible.some(item => item.text === (scenario === 'long' ? '123,456,789.12' : '438.17')), name);
          }
          if (['delta', 'long'].includes(scenario)) {
            assert.deepEqual(result.items.map(({x,y,width,height})=>({x,y,width,height})), baseline, `${name}: popup must not move any metric`);
          }
          assert.equal(result.items.length, scenario === 'no-balance' ? 3 : scenario === 'balance-only' ? 1 : 4, name);
          assert.ok(result.pageWidth <= result.viewportWidth, `${name}: no horizontal page overflow (${result.pageWidth}/${width})`);
          for (const item of [...result.items, ...result.visible]) {
            assert.ok(item.x >= 8 && item.right <= result.viewportWidth - 8, `${name}: text stays inside viewport: ${item.text}`);
          }
          for (let index = 1; index < result.items.length; index += 1) {
            const previous = result.items[index - 1];
            const next = result.items[index];
            if (Math.abs(previous.y - next.y) < 2) {
              const gap = next.x - previous.right;
              assert.ok(gap >= 12, `${name}: metrics have breathing room`);
              if (width >= 600) assert.ok(gap <= 36, `${name}: metrics stay grouped (gap=${gap})`);
            }
          }
          for (let index = 1; index < result.visible.length; index += 1) {
            const previous = result.visible[index - 1];
            const next = result.visible[index];
            if (Math.abs(previous.y - next.y) < 2) assert.ok(next.x >= previous.right, `${name}: amounts never overlap`);
          }
          if (width >= 600) assert.ok(result.items.every(item => Math.abs(item.y - result.items[0].y) < 2), `${name}: one row when space permits`);
          if (theme === 'light' && [836, 280].includes(width) && ['empty', 'usage', 'delta'].includes(scenario)) {
            const image = await win.webContents.capturePage();
            fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
            if (width === 836 && ['usage', 'delta'].includes(scenario)) {
              const scale = image.getSize().width / result.viewportWidth;
              const preview = image.crop({ x: 0, y: Math.floor((result.bar.y - 7) * scale),
                width: image.getSize().width, height: Math.ceil((result.bar.height + 14) * scale) });
              fs.writeFileSync(path.join(output, scenario === 'delta' ? 'preview-delta.png' : 'preview.png'), preview.toPNG());
            }
          }
          if (theme === 'light' && width === 280 && scenario === 'delta') {
            await new Promise(resolve => setTimeout(resolve, 2100));
            const hidden = await run(win, () => ({
              opacity: getComputedStyle(document.querySelector('.gptplus-balance-delta')).opacity,
              rects: [...document.getElementById('gptplus-codex-usage-statusline').children].map(node => {
                const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
              }),
            }));
            assert.equal(hidden.opacity,'0','popup retracts after the display period');
            assert.deepEqual(hidden.rects,baseline,'retracting popup must not move metrics');
          }
          reports.push({ theme, width, scenario, ...result });
        }
      }
    }
    // A clipped composer near the bottom must not clip the popup or move its metrics.
    win.setContentSize(280, 200);
    await run(win, () => {
      globalThis.__gptplusUsageStatuslineDispose?.();
      const main=document.querySelector('main');
      main.style.cssText='position:fixed;left:12px;right:12px;bottom:8px;overflow:hidden;transform:translateZ(0)';
    });
    await win.webContents.executeJavaScript(buildUsageStatuslineScript({ balance:{enabled:true} }));
    await run(win, () => {
      globalThis.__gptplusUsageStatusline.applyBalance({ok:true,balance:'438.17',delta:'0.023',deltaKind:'cumulative'});
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const edge = await run(win, () => {
      const delta=document.querySelector('.gptplus-balance-delta');
      const r=delta.getBoundingClientRect();
      const bar=document.getElementById('gptplus-codex-usage-statusline').getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return { bodyChild:delta.parentElement===document.body, x:r.x, y:r.y, right:r.right, bottom:r.bottom,
        viewportWidth:innerWidth, viewportHeight:innerHeight, barTop:bar.top, visible:getComputedStyle(delta).visibility };
    });
    assert.equal(edge.bodyChild,true,'popup escapes clipping composer ancestors');
    assert.equal(edge.visible,'visible');
    assert.ok(edge.x>=8 && edge.right<=edge.viewportWidth-8 && edge.y>=8 && edge.bottom<=edge.viewportHeight-8,'edge popup stays inside viewport');
    await run(win, () => globalThis.__gptplusUsageStatuslineDispose());
    assert.equal(await run(win, () => document.querySelectorAll('.gptplus-balance-delta').length),0,'dispose leaves no floating popup');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
    console.log(`[pass] ${reports.length} real Chromium layouts: stationary metrics during popup/retraction, animation, edge avoidance and cleanup`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
