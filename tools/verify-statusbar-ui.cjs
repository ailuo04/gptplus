'use strict';
// Real renderer, isolated demo API: no gateway or user settings are changed.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.GPTPLUS_STATUSBAR_UI_OUTPUT || path.join(root, 'probe', 'statusbar-ui'));
const run = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map((v) => JSON.stringify(v)).join(',')})`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: {
    additionalArguments: ['--visual-demo'],
    preload: path.join(root, 'test', 'fixtures', 'startup-ui-preload.cjs'),
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  try {
    fs.mkdirSync(output, { recursive: true });
    await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    await run(win, () => new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (document.documentElement.dataset.ready === '1') return resolve();
        if (Date.now() - started > 5000) return reject(new Error('Renderer not ready'));
        setTimeout(check, 25);
      };
      check();
    }));
    const reports = [];
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [[1440, 900], [940, 620], [390, 844]]) {
        win.setContentSize(width, height);
        await run(win, (value) => { document.documentElement.dataset.theme = value; }, theme);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const result = await run(win, () => {
          const rect = (n) => {
            const r = n.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
          };
          return {
            bar: rect(document.querySelector('.statusbar')),
            flow: rect(document.querySelector('.flow')),
            dots: [...document.querySelectorAll('.flow-node > .dot')].map((dot) => {
              const style = getComputedStyle(dot);
              const spread = style.boxShadow === 'none' ? 0 : parseFloat(style.boxShadow.match(/(-?[\d.]+)px\s*$/)[1]);
              return { ...rect(dot), spread, node: rect(dot.parentElement), label: rect(dot.nextElementSibling) };
            }),
            textOverflow: [...document.querySelectorAll('.flow-val, .flow-summary')]
              .filter((n) => n.getBoundingClientRect().width > 0).some((n) => n.scrollWidth > n.clientWidth),
            errors: window.__startupTest.errors(),
          };
        });
        const name = `${theme}-${width}`;
        const crop = { x: Math.floor(result.bar.x), y: Math.floor(result.bar.y), width: Math.ceil(result.bar.width), height: Math.ceil(result.bar.height) };
        await win.webContents.capturePage();
        const image = await win.webContents.capturePage(crop);
        assert.equal(image.isEmpty(), false, `${name}: nonblank capture`);
        fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
        assert.equal(result.dots.length, 2, `${name}: both status indicators remain`);
        for (const dot of result.dots) {
          assert.ok(dot.x - dot.spread >= dot.node.x, `${name}: status dot halo is clipped on the left`);
          assert.ok(dot.right + dot.spread <= dot.label.x, `${name}: status dot overlaps its label`);
          if (width >= 940) assert.ok(dot.right <= result.flow.right, `${name}: status indicator must be visible`);
        }
        if (width >= 940) assert.equal(result.textOverflow, false, `${name}: status text remains readable`);
        assert.deepEqual(result.errors, [], `${name}: no renderer errors`);
        reports.push({ theme, width, height, ...result });
        console.log(width >= 940
          ? `[pass] ${name}: status dots do not clip or overlap text`
          : `[observe] ${name}: below supported 940px minimum; full status chain may be hidden`);
      }
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
