'use strict';
// 运行：npx electron tools/verify-hero-next.cjs
// 真实渲染层 + 假 API：验证主页「下一步」黄条的文案、按钮、双主题对比度与实际重启交互。
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.GPTPLUS_HERO_OUTPUT || path.join(root, 'probe', 'hero-next'));
let win;

const run = (fn, ...args) => win.webContents.executeJavaScript(
  `(${fn})(${args.map((v) => JSON.stringify(v)).join(',')})`,
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 120; i += 1) {
    if (await run(fn)) return;
    await wait(50);
  }
  throw new Error('Timed out: ' + (label || fn));
}

/** 截取整窗或指定区域，返回 nativeImage 与 PNG 字节。 */
async function capture(crop) {
  await win.webContents.capturePage();
  await wait(300);
  return win.webContents.capturePage(crop && {
    x: Math.floor(crop.x), y: Math.floor(crop.y),
    width: Math.ceil(crop.width), height: Math.ceil(crop.height),
  });
}
async function shot(name, crop) {
  const image = await capture(crop);
  assert.equal(image.isEmpty(), false, name + ': screenshot must not be empty');
  fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
  return image;
}
async function clickSelector(selector) {
  const point = await run((s) => {
    const node = document.querySelector(s);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector);
  assert.ok(point, 'missing selector: ' + selector);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  }
  await wait(140);
}

/** 读取黄条的几何/样式，并用截图像素反推真实底色与对比度。 */
const inspectDom = () => {
  const strip = document.querySelector('.home-next');
  if (!strip) return null;
  const button = strip.querySelector('.home-next-action');
  const textNode = strip.querySelector('.home-next-text');
  const rect = (n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const styles = (n) => {
    const s = getComputedStyle(n);
    return {
      background: s.backgroundColor,
      color: s.color,
      borderColor: s.borderTopColor,
      borderWidth: s.borderTopWidth,
      boxShadow: s.boxShadow,
      fontWeight: s.fontWeight,
      fontSize: s.fontSize,
      paddingLeft: s.paddingLeft,
      borderRadius: s.borderRadius,
    };
  };
  const scroll = document.querySelector('#view');
  return {
    theme: document.documentElement.dataset.theme,
    strip: { ...rect(strip), ...styles(strip) },
    text: { ...rect(textNode), ...styles(textNode) },
    button: button
      ? { ...rect(button), ...styles(button), tag: button.tagName, disabled: button.disabled, text: button.textContent.trim() }
      : null,
    stripText: strip.textContent.replace(/\s+/g, ' ').trim(),
    isBlocking: strip.classList.contains('is-blocking'),
    role: strip.getAttribute('role'),
    buttonClass: button ? button.className : '',
    color: {
      stripBg: getComputedStyle(strip).backgroundColor,
      stripBorder: getComputedStyle(strip).borderTopColor,
      text: getComputedStyle(textNode).color,
      buttonBg: button ? getComputedStyle(button).backgroundColor : null,
      buttonBorder: button ? getComputedStyle(button).borderTopColor : null,
      buttonText: button ? getComputedStyle(button).color : null,
    },
    viewScrollTop: scroll ? scroll.scrollTop : 0,
    errors: window.__heroTest.errors(),
  };
};

// 像素 → 相对亮度 / 对比度
function samplePixel(image, x, y) {
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const bx = Math.max(0, Math.min(size.width - 1, Math.round(x)));
  const by = Math.max(0, Math.min(size.height - 1, Math.round(y)));
  const i = (by * size.width + bx) * 4;
  return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] };
}
/** 在给定矩形内取出现次数最多的颜色（背景占绝大多数像素），比单点取样稳健。 */
function modalPixel(image, box) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const tally = new Map();
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(size.width - 1, Math.round(box.x + box.width));
  const y1 = Math.min(size.height - 1, Math.round(box.y + box.height));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * size.width + x) * 4;
      const key = (bitmap[i + 2] << 16) | (bitmap[i + 1] << 8) | bitmap[i];
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of tally) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255, a: 255 };
}
function luminance({ r, g, b }) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function parseRgb(value) {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((v) => parseFloat(v.trim()));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      preload: path.join(root, 'test', 'fixtures', 'hero-next-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const report = { checks: [] };
  try {
    await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    await until(() => document.documentElement.dataset.ready === '1', 'renderer ready');
    await wait(500);
    // 隐藏窗口不会推进 CSS 过渡：主题切换后 getComputedStyle 会停在过渡起点，
    // 截图也会拍到这个中间色。验证时统一关掉过渡与动画，保证取色和截图确定。
    await run(() => {
      const style = document.createElement('style');
      style.id = 'hero-verify-no-motion';
      style.textContent = '*,*::before,*::after{transition:none !important;animation:none !important;}';
      document.head.appendChild(style);
      void document.body.offsetHeight;
    });
    await wait(200);

    // 进入「配置已修改，需要重启」状态
    await run(() => window.__heroTest.markRelaunchNeeded());
    await until(() => document.querySelector('.home-next') !== null, 'next-step strip appears');
    await wait(400);
    assert.equal(await run(() => window.__heroTest.relaunchNeeded()), true, 'relaunch strip must be visible');

    for (const theme of ['light', 'dark']) {
      await run((t) => window.__heroTest.setTheme(t), theme);
      await wait(450);
      const info = await run(inspectDom);
      assert.ok(info, theme + ': strip must exist');
      assert.match(info.stripText, /配置已修改，需要重启 ChatGPT 客户端后生效/, theme + ': strip copy');
      assert.match(info.button.text, /重启 ChatGPT/, theme + ': button offers restart');
      assert.doesNotMatch(info.button.text, /去模型页/, theme + ': button must not be a models-page link');
      assert.equal(info.button.tag, 'BUTTON', theme + ': action is a real button');
      assert.ok(info.strip.width > 0 && info.strip.height > 0, theme + ': strip has size');
      assert.ok(info.strip.height <= 60, `${theme}: strip stays compact (${info.strip.height}px)`);
      assert.ok(info.button.right <= info.strip.right + 0.5, theme + ': button inside strip');
      assert.deepEqual(info.errors, [], theme + ': no renderer errors');

      // 用真实像素算对比度：底色取条内留白处，按钮底色取按钮左侧留白处。
      const hero = await run(() => {
        const r = document.querySelector('.home-hero').getBoundingClientRect();
        const s = document.querySelector('.home-next').getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, stripX: s.x, stripY: s.y, stripH: s.height };
      });
      const crop = {
        x: hero.stripX - 2, y: hero.stripY - 2,
        width: Math.min(info.strip.width + 4, win.getContentSize()[0] - hero.stripX + 2),
        height: info.strip.height + 4,
      };
      const image = await shot('strip-' + theme, crop);
      // capturePage 的入参是 DIP，但高 DPI 屏幕上返回的位图是物理像素；
      // 不换算会把取样框按 1.25 倍缩到别的位置，采到的是提示条底色而不是按钮底色。
      const imageWidth = image.getSize().width;
      const scale = imageWidth / Math.max(1, Math.round(crop.width));
      const toPixels = (box) => ({
        x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale,
      });
      // 取色点必须落在「纯底色」上：用矩形内出现最多的颜色推底色，避免采到字形像素。
      const bgPixel = modalPixel(image, toPixels({ x: 6, y: 3, width: info.strip.width - 12, height: info.strip.height - 6 }));
      const textContrast = contrast(parseRgb(info.color.text), bgPixel);
      let buttonContrast = null;
      if (info.button) {
        const buttonPixel = modalPixel(image, toPixels({
          x: (info.button.x - crop.x) + 3,
          y: (info.button.y - crop.y) + 2,
          width: info.button.width - 6,
          height: info.button.height - 4,
        }));
        buttonContrast = contrast(parseRgb(info.color.buttonText), buttonPixel);
      }
      if (process.env.GPTPLUS_HERO_DEBUG) {
        console.log('[debug]', theme, {
          scale, text: info.color.text, bgPixel, textContrast: textContrast.toFixed(2),
          buttonText: info.color.buttonText, buttonContrast: buttonContrast === null ? null : buttonContrast.toFixed(2),
        });
      }
      assert.ok(textContrast >= 4.5, `${theme}: strip text contrast ${textContrast.toFixed(2)} must be >= 4.5`);
      assert.ok(buttonContrast >= 4.5, `${theme}: button text contrast ${buttonContrast.toFixed(2)} must be >= 4.5`);
      assert.notEqual(info.strip.boxShadow, 'none', theme + ': strip must carry the edge shadow');
      // 待重启是阻断态：红底 + 红描边 + 红色按钮，不能仍是琥珀色。
      assert.ok(info.isBlocking, theme + ': relaunch strip must be in blocking state');
      assert.equal(info.role, 'alert', theme + ': blocking strip must be announced as an alert');
      assert.match(String(info.buttonClass), /btn-danger/, theme + ': restart action must use the danger variant');
      report.checks.push({
        theme, strip: info.strip, text: info.text, button: info.button,
        colors: info.color, textContrast: Number(textContrast.toFixed(2)), buttonContrast: Number(buttonContrast.toFixed(2)),
      });
      console.log(`[pass] ${theme}: ${Math.round(info.strip.width)}x${Math.round(info.strip.height)} strip, text ${textContrast.toFixed(2)}:1, button ${buttonContrast.toFixed(2)}:1`);
    }

    // 整窗截图（浅色，和用户截图同视角）
    await run(() => window.__heroTest.setTheme('light'));
    await wait(400);
    await shot('hero-light-full');

    // ---- 交互：两段式确认，第二次点击才真正重启 ----
    const count = () => run(() => window.__heroTest.calls().filter((c) => c[0] === 'relaunchChatGpt').length);
    assert.equal(await count(), 0, 'no relaunch before click');
    await clickSelector('.home-next-action');
    await wait(250);
    const armed = await run(inspectDom);
    assert.equal(await count(), 0, 'first click must not restart immediately');
    assert.match(armed.button.text, /确认/, 'first click arms confirmation');
    await shot('strip-light-confirm');
    report.checks.push({ step: 'armed', button: armed.button.text });

    await clickSelector('.home-next-action');
    await wait(1000);
    assert.equal(await count(), 1, 'second click must call relaunchChatGpt exactly once');
    const done = await run(inspectDom);
    assert.equal(done, null, 'after a successful restart the strip must disappear');
    const toasts = await run(() => Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent.trim()));
    assert.ok(toasts.some((t) => /已重启 ChatGPT/.test(t)), 'success toast must confirm the restart: ' + JSON.stringify(toasts));
    await shot('after-restart');
    report.checks.push({ step: 'restarted', toasts });
    console.log('[pass] interaction: two-step confirm, one relaunch, strip clears, success toast');

    // ---- 失败路径：黄条保留、按钮恢复可点 ----
    await run(() => window.__heroTest.setRelaunchMode('fail'));
    await run(() => window.__heroTest.markRelaunchNeeded());
    await until(() => document.querySelector('.home-next') !== null, 'strip returns');
    await wait(320);
    await clickSelector('.home-next-action');
    await wait(140);
    await clickSelector('.home-next-action');
    await wait(800);
    const failed = await run(inspectDom);
    assert.ok(failed, 'failure keeps the strip visible');
    assert.match(failed.button.text, /重启 ChatGPT/, 'failed attempt restores the label');
    assert.equal(failed.button.disabled, false, 'failed attempt re-enables the button');
    await shot('strip-light-failed');
    report.checks.push({ step: 'failed', button: failed.button.text, disabled: failed.button.disabled });
    console.log('[pass] failure path: strip stays, button usable again');

    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('[pass] hero-next verification complete -> ' + output);
    app.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    await shot('failure').catch(() => {});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({
      error: String(error && error.message || error), checks: report.checks,
    }, null, 2));
    app.exit(1);
  }
});
