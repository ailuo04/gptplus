'use strict';
// 渲染层静态自检 + 无 Electron 的渲染冒烟测试（node:test）。
//
// 这个测试守的是最容易在并行开发里悄悄坏掉的东西：
//   1. index.html 引用的本地文件是否存在、有没有混进外部资源；
//   2. app.js 里点名的 DOM id 是否都在 index.html 里；
//   3. 三个视图导出的符号与 app.js 的 import 是否对得上；
//   4. preload 暴露的 API 是否每个都被界面调用过（反向也查：界面有没有调用不存在的 API）；
//   5. 有没有把数据拼进 innerHTML；
//   6. styles.css 里的 var(--x) 是否都有定义；
//   7. 每个渲染层模块能否按 ESM 解析（node --check + 真实 import）；
//   8. 用一个极小的 DOM 替身真正跑一遍三个页面与提供商表单的渲染，断言关键文案，
//      并确认明文 API Key 不会出现在 DOM 里。
//
// 运行：node --test test/renderer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const VIEWS = path.join(RENDERER, 'views');
const PRELOAD = path.join(ROOT, 'src', 'main', 'preload.cjs');

const APP = path.join(RENDERER, 'app.js');
const HTML = path.join(RENDERER, 'index.html');
const CSS = path.join(RENDERER, 'styles.css');

const VIEW_FILES = ['providers.js', 'models.js', 'usage.js', 'settings.js'];
const JS_FILES = ['app.js', ...VIEW_FILES.map((f) => path.join('views', f))];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJs(rel) {
  return read(path.join(RENDERER, rel));
}

function allRendererJs() {
  return JS_FILES.map((rel) => ({ rel, src: readJs(rel) }));
}

// 把渲染层原样复制到临时目录，并放一个 {"type":"module"} 的 package.json：
// 这样 node --check 与 import() 都按 ES module 语义处理，且相对 import 依然成立。
function copyRendererToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-renderer-'));
  fs.mkdirSync(path.join(tmp, 'views'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}', 'utf8');
  for (const rel of JS_FILES) {
    fs.copyFileSync(path.join(RENDERER, rel), path.join(tmp, rel));
  }
  return tmp;
}

// ============================================================
// 1. index.html 的本地引用与 CSP
// ============================================================
test('index.html 引用的每个本地 script/css 文件都存在', () => {
  const html = read(HTML);
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) refs.push(m[1]);

  assert.ok(refs.length >= 2, `index.html 至少应引用 app.js 与 styles.css，实际 ${refs.length} 个`);
  for (const ref of refs) {
    assert.ok(!/^[a-z]+:\/\//i.test(ref), `禁止外部资源引用：${ref}`);
    assert.ok(!ref.startsWith('//'), `禁止协议相对地址：${ref}`);
    const target = path.join(RENDERER, ref);
    assert.ok(fs.existsSync(target), `index.html 引用的文件不存在：${ref}`);
  }
  assert.ok(refs.includes('app.js'), 'index.html 必须引用 app.js');
  assert.ok(refs.includes('styles.css'), 'index.html 必须引用 styles.css');
});

test('index.html 用 <script type="module"> 加载 app.js，且禁止外部资源', () => {
  const html = read(HTML);
  assert.match(html, /<script\s+type="module"\s+src="app\.js">/, 'app.js 必须以 ES module 方式加载');
  assert.equal(/<script[^>]*src=["']?https?:/i.test(html), false, '不允许远程脚本');
  assert.equal(/<link[^>]*href=["']?https?:/i.test(html), false, '不允许远程样式');
  assert.equal(/@import/i.test(html), false, '不允许 @import');
});

test('启动主题脚本先于样式加载，避免首帧使用默认深色', () => {
  const html = read(HTML);
  const themeScript = html.indexOf('<script src="startup-theme.js"></script>');
  const stylesheet = html.indexOf('<link rel="stylesheet" href="styles.css">');
  const themeScriptPath = path.join(RENDERER, 'startup-theme.js');
  assert.ok(themeScript >= 0 && themeScript < stylesheet, '启动主题脚本必须在 styles.css 前运行');
  assert.ok(fs.existsSync(themeScriptPath), '启动主题脚本必须存在');
  const main = read(path.join(ROOT, 'src/main/main.js'));
  assert.match(main, /query:\s*\{\s*theme:\s*savedTheme,\s*resolvedTheme,/s, '主进程必须在首次导航时传入已保存主题');
  assert.match(read(PRELOAD), /requestAnimationFrame\(\(\)\s*=>\s*\{\s*requestAnimationFrame/s, '显示窗口前必须至少完成一次主题绘制');
});

test('index.html 有可用的 CSP，且没有任何外部地址', () => {
  const html = read(HTML);
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(csp, 'index.html 必须声明 CSP');
  const content = csp[1];
  assert.match(content, /default-src\s+'none'/, "CSP 应以 default-src 'none' 为基线");
  assert.match(content, /script-src[^;]*'self'/, "CSP 的 script-src 需要允许 'self'");
  assert.equal(/https?:/i.test(content), false, 'CSP 里不允许出现外部地址');
  assert.equal(/https?:\/\//i.test(html.replace(content, '')), false, 'index.html 不允许出现 http(s) 地址');
});

test('styles.css 没有外部资源引用（字体/图片/CDN）', () => {
  const css = read(CSS);
  assert.equal(/https?:\/\//i.test(css), false, 'styles.css 不允许出现 http(s) 地址');
  assert.equal(/@import/i.test(css), false, 'styles.css 不允许 @import');
  assert.match(css, /font-family:\s*var\(--font\)/, '正文使用本地字体栈变量');
  assert.equal(/url\(\s*['"]?https?:/i.test(css), false, '不允许远程 url()');
});

// ============================================================
// 2. app.js 与 index.html 的 DOM 契约
// ============================================================
test('app.js 引用的每个 DOM id 都存在于 index.html', () => {
  const html = read(HTML);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const src = read(APP);
  const wanted = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(wanted.length >= 10, `app.js 应通过 id 取用若干节点，实际 ${wanted.length} 个`);
  for (const id of wanted) {
    assert.ok(ids.has(id), `app.js 取用了 index.html 中不存在的 id: #${id}`);
  }
});

test('导航项与 app.js 的视图表一一对应', () => {
  const html = read(HTML);
  const navViews = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(navViews, ['models', 'providers', 'settings', 'usage'], '导航视图应与页面实现一致');

  const src = read(APP);
  const metaBlock = src.slice(src.indexOf('const VIEW_META'), src.indexOf('function renderChrome'));
  const metaViews = [...metaBlock.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(metaViews, navViews, 'VIEW_META 的键必须与导航的 data-view 完全一致');
});

test('重启 ChatGPT 是侧栏全局动作，而不是某个页面的局部动作', () => {
  const html = read(HTML);
  const appSrc = read(APP);
  const cssSrc = read(path.join(ROOT, 'src/renderer/styles.css'));
  assert.match(html, /id="sidebar-actions"/, '侧栏必须提供全局动作挂载点');
  assert.match(appSrc, /renderSidebarAction\(\)/, 'app.js 必须渲染侧栏重启动作');
  assert.match(appSrc, /api\.relaunchChatGpt\(\)/, '侧栏动作必须调用重启 API');
  assert.match(html, /id="sidebar-update-quick"/, '左侧必须提供常驻更新快捷入口');
  assert.match(appSrc, /function renderSidebarUpdateQuick\(\)/, 'app.js 必须渲染常驻更新快捷入口');
  assert.match(appSrc, /startUpdateDownload\(\)/, '快捷更新入口必须支持用户确认后安装');
  assert.match(cssSrc, /\.sidebar-update-quick-button\s*\{/, '常驻更新快捷入口必须有独立样式');
  assert.match(appSrc, /relaunchNeeded: false/, '必须有独立的待重启状态');
  assert.match(appSrc, /配置已修改，需要重启 ChatGPT 客户端生效/, '待重启状态必须给出明确警示');
  assert.match(appSrc, /observeCodexWrite\(s\)/, '状态广播应统一检测 Codex 配置写入');
  assert.doesNotMatch(appSrc, /flow-hint-alert/, '底部链路不应重复显示待重启警示');
  assert.match(cssSrc, /\.sidebar-relaunch\.btn-danger\s*\{[\s\S]*color:\s*var\(--err\)/, '确认重启按钮常态就应为红色');
  assert.match(cssSrc, /\.sidebar-relaunch-alert\s*\{/, '侧栏待重启状态必须有独立警示样式');
  assert.match(cssSrc, /\.hint-relaunch\s*\{/, '设置页待重启提示必须有强调样式');
  assert.doesNotMatch(cssSrc, /\.flow-hint-alert\s*\{/, '底部链路不应保留重复警示样式');
  assert.doesNotMatch(read(path.join(VIEWS, 'models.js')), /relaunchChatGpt/, '模型页不应再维护局部重启动作');
  assert.doesNotMatch(read(path.join(VIEWS, 'settings.js')), /relaunchChatGpt/, '设置页不应再维护局部重启动作');
});

test('代理/直连选择常驻左侧导航，不重复出现在设置页', () => {
  const appSrc = read(APP);
  const settingsSrc = read(path.join(VIEWS, 'settings.js'));
  const cssSrc = read(path.join(ROOT, 'src/renderer/styles.css'));
  assert.match(appSrc, /function saveNetworkMode\(nextMode\)/, 'app.js 必须负责保存网络模式');
  assert.match(appSrc, /api\.setNetwork\(\{ proxyMode: nextMode \}\)/, '侧栏控件必须调用 setNetwork');
  assert.match(appSrc, /class: `sidebar-network-option/, '代理选项必须渲染到侧栏动作区');
  assert.match(appSrc, /role: 'radiogroup'/, '代理选项组必须有 radiogroup 语义');
  assert.match(appSrc, /'aria-checked': mode === value/, '代理选项必须暴露 aria-checked 状态');
  assert.match(appSrc, /data: \{ networkMode: value \}/, '代理选项必须带有可定位的数据属性');
  assert.match(appSrc, /tabindex: mode === value \? '0' : '-1'/, '代理选项必须使用 roving tabindex');
  assert.match(appSrc, /target\?\.focus\(\)/, '切换后焦点必须回到新的代理选项');
  assert.match(appSrc, /ArrowLeft|ArrowRight/, '代理选项必须支持方向键切换');
  assert.match(cssSrc, /\.sidebar-network\s*\{/, '侧栏代理控件必须有独立容器样式');
  assert.match(cssSrc, /\.sidebar-network-option\.is-selected/, '侧栏代理控件必须有选中态样式');
  assert.doesNotMatch(settingsSrc, /networkCard|networkBusy|setNetworkMode|setNetwork/, '设置页不应再维护网络代理控件');
  assert.doesNotMatch(settingsSrc, /网络与代理|跟随系统代理/, '设置页不应再显示网络代理文案');
});

test('主题三态快捷控件位于底部状态栏，不重复出现在设置页', () => {
  const html = read(HTML);
  const appSrc = read(APP);
  const settingsSrc = read(path.join(VIEWS, 'settings.js'));
  assert.match(html, /<div class="statusbar-right">[\s\S]*id="theme-control"[\s\S]*id="build-tag"/, '主题控件应放在状态栏右侧，与版本号相邻');
  assert.match(appSrc, /function renderThemeControl\(\)/, 'app.js 应负责渲染底部主题快捷控件');
  assert.doesNotMatch(settingsSrc, /themeCard|saveTheme|themeBusy/, '设置页不应再渲染旧的主题卡片');
});

// ============================================================
// 3. views 导出 ↔ app.js import
// ============================================================
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function importsOf(src) {
  const list = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    list.push({ names, from: m[2] });
  }
  return list;
}

test('views/*.js 导出的每个符号都被 app.js import 使用', () => {
  const appSrc = read(APP);
  const appImported = new Set(importsOf(appSrc).flatMap((i) => i.names));

  for (const file of VIEW_FILES) {
    const names = exportedNames(read(path.join(VIEWS, file)));
    assert.ok(names.size > 0, `${file} 必须导出渲染函数`);
    for (const name of names) {
      assert.ok(appImported.has(name), `${file} 导出了 ${name}，但 app.js 没有 import 它`);
    }
  }
});

test('app.js 从 views 导入的每个符号都真实存在且被调用', () => {
  const appSrc = read(APP);
  const viewImports = importsOf(appSrc).filter((i) => i.from.startsWith('./views/'));
  assert.equal(viewImports.length, VIEW_FILES.length, 'app.js 应分别 import 三个视图');

  for (const imp of viewImports) {
    const target = path.join(RENDERER, imp.from);
    assert.ok(fs.existsSync(target), `import 路径不存在：${imp.from}`);
    const names = exportedNames(read(target));
    for (const name of imp.names) {
      assert.ok(names.has(name), `${imp.from} 没有导出 ${name}（app.js 的 import 已过期）`);
      const uses = appSrc
        .split('\n')
        .filter((line) => !/^\s*import\b/.test(line) && new RegExp(`\\b${name}\\b`).test(line));
      assert.ok(uses.length > 0, `app.js import 了 ${name} 却没有使用`);
    }
  }
});

test('视图渲染函数的签名统一为 (root, ctx, actions)', () => {
  const expected = [
    ['providers.js', 'renderProviders'],
    ['models.js', 'renderModels'],
    ['usage.js', 'renderUsage'],
    ['settings.js', 'renderSettings'],
  ];
  const appSrc = read(APP);
  for (const [file, fn] of expected) {
    const src = read(path.join(VIEWS, file));
    assert.match(
      src,
      new RegExp(`export\\s+function\\s+${fn}\\s*\\(\\s*root\\s*,\\s*ctx\\s*,\\s*actions\\s*\\)`),
      `${file} 的 ${fn} 必须是 (root, ctx, actions) 形式`,
    );
    assert.match(appSrc, new RegExp(`render:\\s*${fn}\\b`), `app.js 的 VIEW_META 应把 ${fn} 注册为渲染器`);
  }
});

// ============================================================
// 4. preload API 覆盖
// ============================================================
function preloadKeys() {
  const src = read(PRELOAD);
  const start = src.indexOf('exposeInMainWorld');
  assert.ok(start > 0, 'preload 必须调用 exposeInMainWorld');
  const end = src.indexOf('\n});', start);
  const block = src.slice(start, end > 0 ? end : undefined);
  return [...block.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
}

test('preload 暴露的每个 API 键都在渲染层被调用过', () => {
  const keys = preloadKeys();
  assert.ok(keys.length >= 17, `preload 的 API 数量异常：${keys.length}`);
  const sources = allRendererJs();
  for (const key of keys) {
    const hit = sources.find((s) => new RegExp(`\\b${key}\\b`).test(s.src));
    assert.ok(hit, `window.gptplus.${key} 没有任何界面代码调用（漏接 API）`);
  }
});

test('渲染层调用的 gptplus 方法都存在于 preload', () => {
  const keys = new Set(preloadKeys());
  for (const { rel, src } of allRendererJs()) {
    for (const m of src.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      assert.ok(keys.has(m[1]), `${rel} 调用了不存在的 API：gptplus.${m[1]}`);
    }
  }
});

test('渲染层只用 ctx.api 访问主进程 API', () => {
  for (const file of VIEW_FILES) {
    assert.equal(
      /window\.gptplus/.test(read(path.join(VIEWS, file))),
      false,
      `${file} 应通过 ctx.api 访问主进程 API`,
    );
  }
  assert.match(read(APP), /window\.gptplus/, '只有 app.js 负责拿到 window.gptplus');
});

test('视图用到的每个 ctx 成员都在 app.js 的上下文里', () => {
  const appSrc = read(APP);
  const start = appSrc.indexOf('const ctx = {');
  assert.ok(start > 0, 'app.js 必须定义 ctx');
  const end = appSrc.indexOf('\n};', start);
  const block = appSrc.slice(start, end > 0 ? end : undefined);
  const keys = new Set([...block.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*[,:]/gm)].map((m) => m[1]));
  assert.ok(keys.size >= 15, `ctx 成员太少，可能没解析对：${keys.size}`);

  for (const file of VIEW_FILES) {
    const src = read(path.join(VIEWS, file));
    const used = new Set([...src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*ctx\b/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':').pop().trim();
        if (name) used.add(name);
      }
    }
    assert.ok(used.size > 0, `${file} 应当通过 ctx 取用能力`);
    for (const name of used) {
      assert.ok(keys.has(name), `${file} 用到了 ctx.${name}，但 app.js 的 ctx 没有这个成员`);
    }
  }
});

// ============================================================
// 5. 安全：不允许把数据拼进 HTML
// ============================================================
test('innerHTML 只用于静态图标，绝不拼接数据', () => {
  for (const { rel, src } of allRendererJs()) {
    for (const line of src.split('\n')) {
      const m = line.match(/\.(?:inner|outer)HTML\s*=\s*([^;]+);/);
      if (!m) continue;
      const rhs = m[1].trim();
      assert.equal(rhs.includes('${'), false, `${rel} 的 innerHTML 赋值里出现了模板插值：${rhs}`);
      const isIconLookup = /^ICONS\[[^\]]+\](\s*\|\|\s*ICONS\.[A-Za-z_$][\w$]*)?$/.test(rhs);
      const isLiteral = /^(['"`])[^`]*\1$/.test(rhs);
      // el() 里 html 属性的唯一收口：只允许这一处把值写进 innerHTML
      const isHelperChokePoint = rhs === 'value' && /key === 'html'/.test(line);
      assert.ok(
        isIconLookup || isLiteral || isHelperChokePoint,
        `${rel} 的 innerHTML 只允许静态图标/字面量（或 el() 的 html 收口），实际：${rhs}`,
      );
    }
    assert.equal(/insertAdjacentHTML/.test(src), false, `${rel} 不允许 insertAdjacentHTML`);
    assert.equal(/document\.write\s*\(/.test(src), false, `${rel} 不允许 document.write`);
  }
});

test('el 的 html 属性只接收静态图标常量', () => {
  for (const { rel, src } of allRendererJs()) {
    for (const m of src.matchAll(/^\s*html:\s*([^,]+),/gm)) {
      const rhs = m[1].trim();
      assert.match(
        rhs,
        /^ICONS\[/,
        `${rel} 里 html 属性只允许传 ICONS[...]，实际：${rhs}`,
      );
    }
  }
});

test('渲染层不发起任何网络请求（离线可用）', () => {
  for (const { rel, src } of allRendererJs()) {
    assert.equal(/\bfetch\s*\(/.test(src), false, `${rel} 不允许 fetch`);
    assert.equal(/XMLHttpRequest/.test(src), false, `${rel} 不允许 XMLHttpRequest`);
    assert.equal(/new\s+WebSocket|new\s+EventSource/.test(src), false, `${rel} 不允许 WebSocket/EventSource`);
    assert.equal(/import\s*\(\s*['"`]/.test(src), false, `${rel} 不允许动态 import`);
    assert.equal(/https?:\/\//.test(src), false, `${rel} 不允许出现 http(s) 地址`);
  }
});

// ============================================================
// 6. CSS
// ============================================================
test('styles.css 里用到的 CSS 变量都有定义', () => {
  const css = read(CSS);
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/gi)].map((m) => m[1]);

  assert.ok(defined.size > 20, `CSS 变量太少，可能没解析对：${defined.size}`);
  assert.ok(used.length > 50, `var() 引用太少，可能没解析对：${used.length}`);
  const missing = [...new Set(used)].filter((v) => !defined.has(v));
  assert.deepEqual(missing, [], `styles.css 引用了未定义的变量：${missing.join(', ')}`);
});

test('危险按钮默认保持中性，只在悬停时显示红色警示', () => {
  const css = read(CSS);
  assert.match(
    css,
    /\.btn-danger\s*\{[^}]*background:\s*transparent[^}]*border-color:\s*var\(--line\)[^}]*color:\s*var\(--fg-faint\)/s,
    '危险按钮常态不应抢色',
  );
  assert.match(
    css,
    /\.btn-danger:hover\s*\{[^}]*background:\s*var\(--err-soft\)[^}]*border-color:\s*var\(--err-line\)[^}]*color:\s*var\(--err\)/s,
    '危险按钮悬停时应显示红色警示',
  );
  assert.match(
    css,
    /\.btn-icon\.btn-danger:hover\s*\{[^}]*background:\s*var\(--err-soft\)[^}]*border-color:\s*var\(--err-line\)[^}]*color:\s*var\(--err\)/s,
    '危险图标按钮悬停时应显示红色警示',
  );
  assert.match(read(path.join(VIEWS, 'providers.js')), /class:\s*'btn btn-icon btn-danger'/, '模型行删除按钮必须带危险语义类');
  assert.match(read(path.join(VIEWS, 'providers.js')), /class:\s*'btn btn-sm btn-danger right'/, '提供商删除入口必须带危险语义类');
  assert.match(read(HTML), /class="btn btn-danger btn-sm"[^>]*id="log-clear"/, '清空日志必须带危险语义类');
});

test('样式包含窄窗口/矮窗口适配，避免 940x620 破版', () => {
  const css = read(CSS);
  assert.match(css, /@media\s*\(max-width:\s*1040px\)/, '需要针对窄窗口的适配断点');
  assert.match(css, /@media\s*\(max-height:\s*700px\)/, '需要针对矮窗口的适配断点');
  assert.match(css, /overflow:\s*auto/, '内容区需要可滚动');
  assert.match(css, /prefers-reduced-motion/, '需要尊重系统的减少动画设置');
});

test('使用量趋势使用四档 Token 热力颜色，并为零值保留独立等级', () => {
  const css = read(CSS);
  for (const level of [0, 1, 2, 3, 4]) {
    assert.match(css, new RegExp(`\\.usage-heatmap-level-${level}\\s*\\{`), `缺少热力颜色等级 ${level}`);
  }
  assert.match(css, /\.usage-heatmap-scroll\s*\{[^}]*overflow-x:\s*auto/s, '热力图在窄窗口应可横向查看');
  assert.match(css, /\.usage-heatmap-cell\[data-tooltip\]:hover::after/, '热力格应使用页面内悬浮提示');
  assert.match(css, /transition:\s*opacity\s+(80ms|0\.1s|var\(--dur-1\))/, '悬浮提示出现动画应低于 0.5 秒');
});

test('使用量表格在桌面宽度内收缩，窄窗口才启用横向滚动', () => {
  const css = read(CSS);
  assert.match(css, /\.usage-table-row\s*\{[^}]*min-width:\s*0/s, '桌面表格不应固定撑出容器');
  assert.match(css, /\.usage-table-row\s*>\s*\*\s*\{[^}]*min-width:\s*0/s, '表格单元格必须允许收缩');
  assert.match(css, /\.usage-recent \.chip\s*\{[^}]*max-width:\s*100%/s, '状态胶囊不能超出最后一列');
  assert.match(css, /@media\s*\(max-width:\s*1040px\)[\s\S]*?\.usage-table-row\s*\{[^}]*min-width:\s*1260px/s, '窄窗口应保留横向滚动兜底');
});

// ============================================================
// 7. 语法与模块解析
// ============================================================
test('每个渲染层 JS 都能按 ESM 通过 node --check', () => {
  const tmp = copyRendererToTemp();
  try {
    for (const rel of JS_FILES) {
      const res = spawnSync(process.execPath, ['--check', path.join(tmp, rel)], { encoding: 'utf8' });
      if (res.error || res.status === null) continue; // 受限环境禁止子进程时由 import 测试兜底
      assert.equal(res.status, 0, `node --check 失败：${rel}\n${res.stderr || ''}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('渲染层模块可以在无 DOM 环境下 import（顶层无副作用）', async () => {
  const tmp = copyRendererToTemp();
  try {
    for (const rel of JS_FILES) {
      const mod = await import(pathToFileURL(path.join(tmp, rel)).href);
      assert.equal(typeof mod, 'object');
      if (rel === 'app.js') {
        for (const name of ['el', 'icon', 'fmt', 'maskKey']) {
          assert.ok(mod[name], `app.js 应导出 ${name}`);
        }
        assert.equal(typeof mod.el, 'function');
        assert.equal(typeof mod.icon, 'function');
        assert.equal(typeof mod.maskKey, 'function');
        assert.equal(typeof mod.fmt, 'object', 'fmt 是一组格式化函数');
        for (const key of ['clock', 'dateTime', 'rel', 'dur']) {
          assert.equal(typeof mod.fmt[key], 'function', `fmt.${key} 缺失`);
        }
      }
      if (rel === 'views/providers.js') {
        for (const name of ['renderProviders', 'openProviderForm', 'closeProviderForm']) {
          assert.equal(typeof mod[name], 'function', `providers.js 缺少导出 ${name}`);
        }
      }
      if (rel === 'views/models.js') assert.equal(typeof mod.renderModels, 'function');
      if (rel === 'views/settings.js') assert.equal(typeof mod.renderSettings, 'function');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================
// 8. 关键文案与交互契约
// ============================================================
test('模型页给出明确注入状态文案', () => {
  const src = read(path.join(VIEWS, 'models.js'));
  assert.match(
    src,
    /已注入 \$\{enabledModels\.length\} 个模型 · 重启 ChatGPT 客户端后可在模型选择器中看到/,
    '必须有一句明确的注入状态说明',
  );
  assert.match(src, /setInject/, '模型页必须调用 setInject');
  assert.match(src, /网关/, '模型页需要提示网关状态');
});

test('模型排序辅助函数支持把任意拖动项插入目标位置', async () => {
  const tmp = copyRendererToTemp();
  try {
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    assert.deepEqual(
      modelsMod.reorderModelKeys(['a', 'b', 'c', 'd'], 1, 3),
      ['a', 'c', 'd', 'b'],
      '拖动项应插入目标位置之后',
    );
    assert.deepEqual(
      modelsMod.reorderModelKeys(['a', 'b', 'c', 'd'], 3, 0),
      ['d', 'a', 'b', 'c'],
      '拖动项应支持向前插入',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('模型页使用自由拖动排序并通过批量 API 保存', () => {
  const src = read(path.join(VIEWS, 'models.js'));
  assert.match(src, /model-drag-handle/, '模型行需要有明确的拖动把手');
  assert.match(src, /pointerdown/, '排序应从指针按下开始，支持 Windows 鼠标拖动');
  assert.match(src, /requestAnimationFrame/, '拖动位移动画应使用 requestAnimationFrame');
  assert.match(src, /reorderModels/, '松手后应通过批量排序 API 保存完整顺序');
  assert.doesNotMatch(src, /orderButton\(/, '模型页不应再渲染上下移动按钮');
});

test('模型拖动结束动画只清理当前传入的行集合', () => {
  const src = read(path.join(VIEWS, 'models.js'));
  const start = src.indexOf('function animateRowsToFinalPosition');
  const end = src.indexOf('\n}\n\n// ============ 动作', start);
  assert.ok(start >= 0 && end > start, '应能定位拖动结束动画函数');
  const fn = src.slice(start, end);
  assert.match(fn, /movedRows\.forEach/, '动画应遍历传入的 movedRows');
  assert.doesNotMatch(fn, /\brows\.forEach/, '动画函数不能引用已移除的 rows 变量');
});

test('模型换序刷新保留当前页面滚动位置', () => {
  const appSrc = read(APP);
  const modelsSrc = read(path.join(VIEWS, 'models.js'));
  assert.match(appSrc, /async function reload\(scope = 'providers', options = \{\}\)/, 'reload 应支持传入刷新选项');
  assert.match(appSrc, /renderCurrent\(true, options\)/, 'reload 应把刷新选项传给渲染器');
  assert.match(
    appSrc,
    /const preserveScrollTop = options\.preserveScrollTop !== false/,
    '页面重绘默认应保留滚动位置',
  );
  assert.match(
    modelsSrc,
    /await ctx\.reload\('models', \{\s*preserveScrollTop: true\s*\}\)/,
    '拖动保存后应使用保留滚动位置的刷新',
  );
});

test('状态广播不重建当前页面，避免修改配置时整页闪烁', () => {
  const appSrc = read(APP);
  const cssSrc = read(path.join(ROOT, 'src/renderer/styles.css'));
  const statusHandlerStart = appSrc.indexOf('api.onStatus((s) => {');
  const statusHandlerEnd = appSrc.indexOf('\n    });', statusHandlerStart);
  assert.ok(statusHandlerStart >= 0 && statusHandlerEnd > statusHandlerStart, '应能定位状态订阅处理器');
  const statusHandler = appSrc.slice(statusHandlerStart, statusHandlerEnd);
  assert.doesNotMatch(statusHandler, /renderCurrent\(/, '状态广播不能重建当前页面');
  assert.doesNotMatch(appSrc, /scheduleStatusRender|statusRenderTimer/, '不应存在状态广播整页重绘定时器');
  assert.match(appSrc, /renderChrome\(\);[\s\S]*状态广播只更新顶部状态栏/, '状态广播应只更新顶部状态栏');
  assert.match(appSrc, /if \(state\.view !== targetView\) return/, '旧页面异步加载完成后不能覆盖新页面');
  assert.match(appSrc, /if \(state\.view === targetView\) \{/, '刷新完成后只能重绘发起刷新时的页面');
  assert.match(appSrc, /dom\.modalRoot\.addEventListener\('focusout'/, '弹窗输入也应纳入重绘焦点保护');
  assert.doesNotMatch(cssSrc, /\.note\s*\{[^}]*animation:\s*fade/, '持久状态提示不能每次重绘都重新播放淡入动画');
});

test('更新状态变化时同步刷新设置页更新卡片', () => {
  const appSrc = read(APP);
  const start = appSrc.indexOf('function handleUpdateState(next)');
  const end = appSrc.indexOf('\n}\n\n/** 更新确认弹窗', start);
  assert.ok(start >= 0 && end > start, '应能定位更新状态处理函数');
  const handler = appSrc.slice(start, end);
  assert.match(handler, /const changed = Object\.keys\(next\)/, '更新处理应先判断状态是否真的变化');
  assert.match(handler, /state\.view === 'settings'/, '设置页需要响应更新状态变化');
  assert.match(handler, /renderCurrent\(false, \{ preserveScrollTop: true \}\)/, '设置页刷新必须保留滚动位置');
});

test('提供商表单支持多模型行与从 /models 拉取', () => {
  const src = read(path.join(VIEWS, 'providers.js'));
  assert.match(src, /fetchRemoteModels/, '表单必须调用 fetchRemoteModels');
  assert.match(src, /saveProvider/, '表单必须调用 saveProvider');
  assert.match(src, /testProvider/, '卡片必须调用 testProvider');
  assert.match(src, /deleteProvider/, '卡片必须调用 deleteProvider');
  assert.match(src, /添加一行/, '模型行必须可以手动新增');
  assert.match(src, /从 \/models 拉取/, '必须有拉取按钮');
  assert.match(src, /maskKey/, 'API Key 必须默认打码');
});

test('设置页覆盖网关、探活、目录与还原注入', () => {
  const src = read(path.join(VIEWS, 'settings.js'));
  assert.match(src, /setGateway/, '设置页必须调用 setGateway');
  assert.match(src, /probeGateway/, '设置页必须调用 probeGateway');
  assert.match(src, /openCodexFolder/, '设置页必须调用 openCodexFolder');
  assert.match(src, /setInject\(\{\s*enabled:\s*false\s*\}\)/, '必须有还原注入动作');
  assert.match(src, /setModelLimits/, '设置页必须调用 setModelLimits');
  assert.match(src, /checkForUpdates/, '设置页必须提供手动检查更新入口');
  assert.match(src, /startUpdateDownload/, '设置页必须提供手动安装更新入口');
  assert.match(src, /上下文窗口 Token/, '设置页必须提供上下文窗口设置');
  assert.match(src, /自动压缩阈值 Token/, '设置页必须提供自动压缩设置');
  assert.match(src, /codex\.configPath/, '需要展示 codex.configPath');
  assert.match(src, /catalogPath/, '需要展示 catalogPath');
  assert.doesNotMatch(src, /网络与代理|setNetwork|跟随系统代理/, '设置页不应再承载网络代理切换');
});

test('日志抽屉与状态订阅在 app.js 中接线', () => {
  const src = read(APP);
  assert.match(src, /getLogs/, '启动时必须读取历史日志');
  assert.match(src, /api\.onLog\(/, '必须订阅 onLog 实时日志');
  assert.match(src, /api\.onStatus\(/, '必须订阅 onStatus 状态推送');
  assert.match(src, /LOG_DRAW_LIMIT\s*=\s*300/, '抽屉最多渲染 300 行');
  assert.match(src, /LOG_STATE_LIMIT\s*=\s*20000/, 'state.logs 保留全部已持久化历史，供使用量页聚合');
  assert.match(src, /filter\(matchesFilter\)\.slice\(-LOG_DRAW_LIMIT\)/, '抽屉只给最近 300 条建 DOM 节点');
  assert.ok(!/LOG_LIMIT/.test(src), '渲染上限与统计上限必须分开，不能共用一个 LOG_LIMIT 把历史截断');
});

// ============================================================
// 9. 渲染冒烟测试：极小 DOM 替身 + 真实视图代码
// ============================================================
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1; // 让 el() 的节点判定与真实 DOM 一致
    this.childNodes = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this._value = '';
    Object.defineProperty(this, 'value', {
      configurable: true,
      get: () => this._value,
      set: (value) => {
        const next = String(value);
        if (this.tagName !== 'SELECT') {
          this._value = next;
          return;
        }
        const option = this.childNodes.find((child) => child instanceof FakeNode && child.tagName === 'OPTION' && child.value === next);
        this._value = option ? next : '';
      },
    });
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.id = '';
    this.title = '';
    this.isConnected = true;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    const set = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !set.has(c) : !!on;
        if (want) set.add(c);
        else set.delete(c);
        return want;
      },
      _set: set,
    };
    this.style = {
      _props: {},
      setProperty(k, v) {
        this._props[k] = v;
      },
      getPropertyValue(k) {
        return this._props[k] || '';
      },
    };
  }

  get firstElementChild() {
    return this.childNodes.find((c) => c instanceof FakeNode) || null;
  }

  get lastElementChild() {
    const list = this.childNodes.filter((c) => c instanceof FakeNode);
    return list.length ? list[list.length - 1] : null;
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof FakeNode);
  }

  get textContent() {
    return this.childNodes.map((c) => (c instanceof FakeNode ? c.textContent : String(c))).join('');
  }

  set textContent(v) {
    this.childNodes = [];
    if (v !== null && v !== undefined && String(v) !== '') this.childNodes.push(String(v));
  }

  set innerHTML(v) {
    this.childNodes = [];
    // 只用于图标：<svg ...>…</svg> → 造一个 svg 元素，让 icon() 能设置宽高
    if (typeof v === 'string' && v.trim().startsWith('<svg')) {
      this.childNodes.push(new FakeNode('svg'));
    }
  }

  get innerHTML() {
    return '';
  }

  appendChild(node) {
    this.childNodes.push(node);
    if (this.tagName === 'SELECT' && this._value === '' && node instanceof FakeNode && node.tagName === 'OPTION') {
      this._value = node.value;
    }
    return node;
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
    return this;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    for (const n of nodes) if (n !== null && n !== undefined) this.appendChild(n);
    return this;
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((c) => c !== node);
    return node;
  }

  remove() {
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  focus() {}
  select() {}
  setSelectionRange() {}

  /** 收集整棵子树的文本，便于断言“界面上有没有这句话” */
  allText() {
    return this.textContent;
  }

  /** 收集整棵子树的属性值（含 class/aria），用于断言打码等 */
  allAttributes() {
    const out = [];
    const walk = (node) => {
      if (!(node instanceof FakeNode)) return;
      for (const [k, v] of Object.entries(node.attributes)) out.push(`${k}=${v}`);
      if (node.className) out.push(`class=${node.className}`);
      for (const child of node.childNodes) walk(child);
    };
    walk(this);
    return out;
  }

  /** 按 class 粗略查找（只支持单类名） */
  find(className) {
    const out = [];
    const walk = (node) => {
      if (!(node instanceof FakeNode)) return;
      if (String(node.className).split(/\s+/).includes(className)) out.push(node);
      for (const child of node.childNodes) walk(child);
    };
    walk(this);
    return out;
  }

  /** 按标签名查找 */
  findTag(tagName) {
    const want = String(tagName).toUpperCase();
    const out = [];
    const walk = (node) => {
      if (!(node instanceof FakeNode)) return;
      if (node.tagName === want) out.push(node);
      for (const child of node.childNodes) walk(child);
    };
    walk(this);
    return out;
  }
}

function installFakeDom() {
  const root = new FakeNode('div');
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => String(text),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
    readyState: 'complete',
    documentElement: new FakeNode('html'),
    body: root,
    activeElement: null,
  };
  globalThis.window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
    gptplus: null,
  };
  // Node 里 navigator 是只读 getter，只能重新定义
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: null },
    configurable: true,
    writable: true,
  });
  return root;
}

function makeApi(state, calls) {
  let seq = 0;
  return {
    getStatus: async () => state.status,
    setTheme: async (patch) => {
      calls.push(['setTheme', patch]);
      state.status = { ...state.status, theme: patch.theme };
      return state.status;
    },
    listProviders: async () => state.providers.slice(),
    saveProvider: async (input) => {
      calls.push(['saveProvider', input]);
      const id = input.id || `p_new${++seq}`;
      const saved = { ...input, id, hasKey: !!input.apiKey };
      const idx = state.providers.findIndex((p) => p.id === id);
      if (idx >= 0) state.providers[idx] = saved;
      else state.providers.push(saved);
      return state.providers.slice();
    },
    deleteProvider: async (id) => {
      calls.push(['deleteProvider', id]);
      state.providers = state.providers.filter((p) => p.id !== id);
      return state.providers.slice();
    },
    testProvider: async (id) => {
      calls.push(['testProvider', id]);
      return { ok: true, status: 200, latencyMs: 12 };
    },
    fetchRemoteModels: async (id) => {
      calls.push(['fetchRemoteModels', id]);
      return {
        ok: true,
        models: [
          { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
          { id: 'deepseek-v4', label: 'DeepSeek V4' },
        ],
      };
    },
    listModels: async () => state.models,
    getModelLimits: async () => state.modelLimits,
    setModelLimits: async (patch) => {
      calls.push(['setModelLimits', patch]);
      state.modelLimits = patch;
      state.status = { ...state.status, modelLimits: patch };
      return state.status;
    },
    getGateway: async () => state.gateway,
    setGateway: async (patch) => {
      calls.push(['setGateway', patch]);
      return state.status;
    },
    setNetwork: async (patch) => {
      calls.push(['setNetwork', patch]);
      state.network = { proxyMode: patch.proxyMode };
      state.status = { ...state.status, network: state.network };
      return state.status;
    },
    probeGateway: async () => {
      calls.push(['probeGateway']);
      return { ok: true, latencyMs: 5 };
    },
    getInject: async () => state.inject,
    setInject: async (patch) => {
      calls.push(['setInject', patch]);
      return state.status;
    },
    openCodexFolder: async () => {
      calls.push(['openCodexFolder']);
      return { ok: true };
    },
    relaunchChatGpt: async () => {
      calls.push(['relaunchChatGpt']);
      return { ok: true };
    },
    getLogs: async () => [],
    getUpdateState: async () => state.update || { enabled: false, status: 'idle' },
    checkForUpdates: async () => {
      calls.push(['checkForUpdates']);
      return state.update || { enabled: false, status: 'idle' };
    },
    downloadUpdate: async () => {
      calls.push(['downloadUpdate']);
      return state.update || { enabled: false, status: 'idle' };
    },
    onStatus: () => () => {},
    onLog: () => () => {},
    onUpdate: () => () => {},
  };
}

function makeCtx(mod, state, log) {
  const calls = log || [];
  return {
    api: makeApi(state, calls),
    state,
    el: mod.el,
    icon: mod.icon,
    fmt: mod.fmt,
    maskKey: mod.maskKey,
    shortPath: (p) => String(p || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~'),
    describeError: (err) => (err && err.message) || String(err),
    setThemePreference: (theme) => { state.theme = theme; state.status = { ...state.status, theme }; },
    toast: (msg, kind) => calls.push(['toast', kind, msg]),
    toastError: (err, fallback) => calls.push(['toastError', fallback]),
    logLocal: (level, msg) => calls.push(['log', level, msg]),
    markRelaunchNeeded: () => { state.relaunchNeeded = true; calls.push(['markRelaunchNeeded']); },
    copyText: async () => true,
    navigate: (view) => calls.push(['navigate', view]),
    reload: async () => {},
    renderChrome: () => {},
    renderCurrent: () => {},
    openModal: (node) => {
      calls.push(['openModal', node]);
      return node;
    },
    closeModal: () => true,
    isModalOpen: () => false,
    openProviderForm: () => {},
    closeProviderForm: () => {},
    _calls: calls,
  };
}

function fixtureState(overrides = {}) {
  return {
    view: 'providers',
    status: {
      appVersion: '0.1.0',
      theme: 'dark',
      providers: 2,
      models: 3,
      gateway: { enabled: true, running: true, port: 18120, url: '127.0.0.1:18120', startedAt: Date.now() - 60000 },
      network: { proxyMode: 'system' },
      inject: { enabled: true, catalogPath: 'C:\\Users\\ailuo\\.gptplus\\model-catalog.json', defaultModel: 'p_demo0001__gpt-6.1-sol' },
      codex: {
        configPath: 'C:\\Users\\ailuo\\.codex\\config.toml',
        catalogPath: 'C:\\Users\\ailuo\\.gptplus\\model-catalog.json',
        lastWrite: { at: Date.now() - 30000, ok: true },
      },
      paths: {
        configPath: 'C:\\Users\\ailuo\\.gptplus\\config.json',
        backupDir: 'C:\\Users\\ailuo\\.gptplus\\backups',
      },
    },
    providers: [
      {
        id: 'p_demo0001',
        name: '梦幻API',
        baseUrl: 'https://mhapi.example/v1',
        apiKey: 'sk-super-secret-1234',
        api: 'openai',
        headers: { 'X-Trace': '1' },
        enabled: true,
        hasKey: true,
        models: [
          { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
          { id: 'claude-x', label: 'Claude X', enabled: false, reasoning: false },
        ],
      },
      {
        id: 'p_demo0002',
        name: '本地 Ollama',
        baseUrl: '127.0.0.1:11434/v1',
        apiKey: '',
        api: 'anthropic',
        headers: {},
        enabled: true,
        hasKey: false,
        models: [{ id: 'qwen3', label: 'Qwen3', enabled: true, reasoning: false }],
      },
    ],
    models: [
      { slug: 'p_demo0001__gpt-6.1-sol', providerId: 'p_demo0001', providerName: '梦幻API', modelId: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: true, reasoning: true },
      { slug: 'p_demo0001__claude-x', providerId: 'p_demo0001', providerName: '梦幻API', modelId: 'claude-x', label: 'Claude X', enabled: false, reasoning: false },
      { slug: 'p_demo0002__qwen3', providerId: 'p_demo0002', providerName: '本地 Ollama', modelId: 'qwen3', label: 'Qwen3', enabled: true, reasoning: false },
    ],
    gateway: { enabled: true, running: true, port: 18120, url: '127.0.0.1:18120', modelBase: '127.0.0.1:18120', token: 'tok-abcdef123456' },
    modelLimits: { contextWindow: 1_000_000, autoCompactTokenLimit: null },
    inject: { enabled: true, catalogPath: 'C:\\Users\\ailuo\\.gptplus\\model-catalog.json', defaultModel: 'p_demo0001__gpt-6.1-sol' },
    logs: [],
    ...overrides,
  };
}

test('三个页面与提供商表单能在 DOM 替身上真实渲染', async () => {
  const tmp = copyRendererToTemp();
  try {
    // 先 import（此时没有 document，app.js 不会自动 boot），再装 DOM 替身
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const providersMod = await import(pathToFileURL(path.join(tmp, 'views', 'providers.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    const settingsMod = await import(pathToFileURL(path.join(tmp, 'views', 'settings.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();

    // --- 提供商页：空状态 ---
    const emptyState = fixtureState({ providers: [], models: [], status: { ...fixtureState().status, providers: 0, models: 0 } });
    let ctx = makeCtx(appMod, emptyState);
    let root = new FakeNode('main');
    let actions = new FakeNode('div');
    providersMod.renderProviders(root, ctx, actions);
    assert.match(root.allText(), /还没有任何提供商/, '空状态必须给出引导');
    assert.match(root.allText(), /添加提供商/, '空状态必须有添加入口');

    // --- 提供商页：卡片（API Key 必须打码） ---
    const state = fixtureState();
    ctx = makeCtx(appMod, state);
    root = new FakeNode('main');
    actions = new FakeNode('div');
    providersMod.renderProviders(root, ctx, actions);

    const providerText = root.allText();
    assert.match(providerText, /梦幻API/, '卡片应显示提供商名称');
    assert.match(providerText, /https:\/\/mhapi\.example\/v1/, '卡片应显示 Base URL');
    assert.match(providerText, /OpenAI 兼容/, '卡片应显示协议');
    assert.match(providerText, /2 个模型/, '卡片应显示模型数量');
    assert.match(providerText, /测试连接/, '卡片应有测试连接按钮');
    assert.equal(
      providerText.includes('sk-super-secret-1234'),
      false,
      '明文 API Key 绝不能出现在渲染结果里',
    );
    assert.match(providerText, /sk-•+1234/, 'API Key 应以打码形式展示');
    assert.match(providerText, /缺少 API Key/, '没有 Key 的提供商要有提示');

    // --- 提供商表单（最大的一块 UI 代码） ---
    const formCtx = makeCtx(appMod, fixtureState());
    providersMod.openProviderForm(formCtx, 'p_demo0001');
    const modalCall = formCtx._calls.find((c) => c[0] === 'openModal');
    assert.ok(modalCall, '打开表单应调用 ctx.openModal');
    const formText = modalCall[1].allText();
    assert.match(formText, /编辑「梦幻API」/, '编辑态标题应带名称');
    assert.match(formText, /从 \/models 拉取/, '表单必须有拉取按钮');
    assert.match(formText, /添加一行/, '表单必须能手动加模型行');
    assert.match(formText, /额外请求头/, '表单应有额外请求头字段');
    assert.match(formText, /共 2 个模型/, '表单应统计模型数量');

    const formInputs = modalCall[1].findTag('input');
    const inputValues = formInputs.map((n) => n.value);
    assert.ok(inputValues.includes('gpt-6.1-sol'), '表单应带出已有模型 ID');
    assert.ok(inputValues.includes('GPT-6.1 Sol'), '表单应带出已有模型显示名');
    assert.ok(inputValues.includes('梦幻API'), '表单应带出提供商名称');
    assert.ok(inputValues.includes('https://mhapi.example/v1'), '表单应带出 Base URL');

    const passwordInput = formInputs.find((n) => n.attributes.type === 'password');
    assert.ok(passwordInput, 'API Key 输入框默认应为 password 类型');
    assert.equal(passwordInput.value, 'sk-super-secret-1234', '表单里应能编辑真实 Key，但以密码框呈现');
    providersMod.closeProviderForm();

    // --- 模型页：注入已开启 ---
    const modelsCtx = makeCtx(appMod, fixtureState());
    const mRoot = new FakeNode('main');
    const mActions = new FakeNode('div');
    modelsMod.renderModels(mRoot, modelsCtx, mActions);
    const modelsText = mRoot.allText();
    assert.match(
      modelsText,
      /已注入 2 个模型 · 重启 ChatGPT 客户端后可在模型选择器中看到/,
      '必须给出具体的注入状态说明',
    );
    assert.match(modelsText, /p_demo0001__gpt-6\.1-sol/, '模型表应显示 slug');
    assert.match(modelsText, /1 · 提供商/, '应有链路第一步');
    assert.match(modelsText, /2 · 本地网关/, '应有链路第二步');
    assert.match(modelsText, /3 · ChatGPT 客户端/, '应有链路第三步');
    assert.match(modelsText, /默认模型/, '应有默认模型选择器');

    // --- 模型页：空状态 ---
    const noModels = makeCtx(appMod, fixtureState({ models: [], inject: { enabled: false, catalogPath: null, defaultModel: null } }));
    const nmRoot = new FakeNode('main');
    modelsMod.renderModels(nmRoot, noModels, new FakeNode('div'));
    assert.match(nmRoot.allText(), /还没有可注入的模型/, '模型页空状态必须有引导');

    // --- 设置页 ---
    const settingsCtx = makeCtx(appMod, fixtureState());
    const sRoot = new FakeNode('main');
    settingsMod.renderSettings(sRoot, settingsCtx, new FakeNode('div'));
    const settingsText = sRoot.allText();
    assert.match(settingsText, /本地网关/, '设置页应有网关卡片');
    assert.match(settingsText, /探活/, '设置页应有探活按钮');
    assert.doesNotMatch(settingsText, /网络与代理|跟随系统代理/, '设置页不应显示网络代理选择');
    assert.match(settingsText, /C:\\Users\\ailuo\\\.codex\\config\.toml/, '应显示 codex.configPath');
    assert.match(settingsText, /model-catalog\.json/, '应显示 catalogPath');
    assert.match(settingsText, /C:\\Users\\ailuo\\\.gptplus\\config\.json/, '关于页应显示 gpt++ 配置绝对路径');
    assert.match(settingsText, /C:\\Users\\ailuo\\\.gptplus\\backups/, '关于页应显示备份目录绝对路径');
    assert.match(settingsText, /还原注入/, '应有还原注入按钮');
    assert.match(settingsText, /打开 Codex 目录/, '应有打开目录按钮');
    assert.equal(settingsText.includes('tok-abcdef123456'), false, '网关令牌默认也要打码');

    settingsCtx.state.relaunchNeeded = true;
    const pendingSettingsRoot = new FakeNode('main');
    settingsMod.renderSettings(pendingSettingsRoot, settingsCtx, new FakeNode('div'));
    assert.match(pendingSettingsRoot.allText(), /配置已修改，需要重启 ChatGPT 客户端后生效/, '配置修改后设置页必须显示强警示');
    assert.match(pendingSettingsRoot.allText(), /左侧红色“重启 ChatGPT”/, '设置页必须引导用户点击红色重启按钮');

    // --- 缓存统计 ---
    const usageCtx = makeCtx(appMod, fixtureState({ logs: [{
      at: Date.now(),
      model: 'gpt-6.1-sol',
      providerName: '梦幻API',
      status: 200,
      ms: 1200,
      tokens: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
        output_tokens: 20,
        total_tokens: 120,
      },
    }] }));
    const uRoot = new FakeNode('main');
    usageMod.renderUsage(uRoot, usageCtx, new FakeNode('div'));
    assert.match(uRoot.allText(), /缓存命中率/, '使用量页应显示缓存命中率');
    assert.match(uRoot.allText(), /60%/, '缓存命中率应按缓存输入 Token / 总输入 Token 计算');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================
// 10. 交互路径：按钮点击真的会走到对应的 IPC
// ============================================================
function findNodes(root, predicate) {
  const out = [];
  const walk = (node) => {
    if (!(node instanceof FakeNode)) return;
    if (predicate(node)) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

function buttonsWithText(root, text) {
  return findNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent.includes(text));
}

function byAttr(root, attr, value) {
  return findNodes(root, (n) => n.attributes[attr] === value);
}

function click(node) {
  assert.ok(node, '要点击的节点必须存在');
  const handlers = node.listeners.click || [];
  assert.ok(handlers.length > 0, `节点「${node.textContent}」没有 click 处理器`);
  for (const fn of handlers) fn({ preventDefault() {}, target: node, currentTarget: node });
}

function type(node, value) {
  assert.ok(node, '要输入的节点必须存在');
  node.value = value;
  for (const fn of node.listeners.input || []) fn({ target: node });
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

function callsOf(ctx, name) {
  return ctx._calls.filter((c) => c[0] === name);
}

test('提供商页：测试连接 / 删除 / 保存 / 从 /models 拉取都能走通', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const providersMod = await import(pathToFileURL(path.join(tmp, 'views', 'providers.js')).href);
    installFakeDom();

    // --- 测试连接 ---
    const state = fixtureState();
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    providersMod.renderProviders(root, ctx, new FakeNode('div'));
    click(buttonsWithText(root, '测试连接')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'testProvider'), [['testProvider', 'p_demo0001']], '「测试连接」应调用 testProvider');
    const probeToast = ctx._calls.find((c) => c[0] === 'toast' && String(c[2]).includes('连接正常'));
    assert.ok(probeToast, '测试成功应给出带耗时结果的提示');

    // --- 删除（两步确认）---
    click(byAttr(root, 'title', '删除该提供商')[0]);
    const afterFirstClick = new FakeNode('main');
    providersMod.renderProviders(afterFirstClick, ctx, new FakeNode('div'));
    assert.match(afterFirstClick.allText(), /确认删除「梦幻API」/, '删除需要二次确认');
    click(buttonsWithText(afterFirstClick, '确认删除')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'deleteProvider'), [['deleteProvider', 'p_demo0001']], '确认后应调用 deleteProvider');

    // --- 新建提供商：先保存，再从 /models 拉取（一步完成）---
    const fresh = fixtureState({ providers: [], models: [] });
    const formCtx = makeCtx(appMod, fresh);
    providersMod.openProviderForm(formCtx, null);
    const modal = formCtx._calls.find((c) => c[0] === 'openModal')[1];
    assert.ok(modal, '表单应挂到 modal-root');

    click(buttonsWithText(modal, '保存提供商')[0]);
    await flush();
    assert.equal(callsOf(formCtx, 'saveProvider').length, 0, '必填项为空时不应提交');

    const inputs = modal.findTag('input');
    type(inputs[0], '新接口');
    type(inputs[1], 'api.example.com/v1');
    click(buttonsWithText(modal, '添加一行')[0]);
    const rows = modal.find('mrow');
    const lastRow = rows[rows.length - 1];
    assert.ok(lastRow && lastRow !== rows[0], '应新增一行模型');
    type(lastRow.findTag('input')[0], 'my-model');

    click(buttonsWithText(modal, '从 /models 拉取')[0]);
    await flush();
    const saved = callsOf(formCtx, 'saveProvider');
    assert.equal(saved.length, 1, '新提供商点拉取时应先保存');
    assert.equal(saved[0][1].name, '新接口');
    assert.equal(saved[0][1].baseUrl, 'api.example.com/v1');
    assert.equal(saved[0][1].models.length, 1, '手填的模型行会一起保存');
    assert.equal(saved[0][1].models[0].id, 'my-model');

    const pulled = callsOf(formCtx, 'fetchRemoteModels');
    assert.equal(pulled.length, 1, '保存后应继续拉取 /models');
    assert.equal(pulled[0][1], 'p_new1', '拉取要带上刚分配的 id');

    const values = modal.findTag('input').map((n) => n.value);
    assert.ok(values.includes('deepseek-v4'), '拉取到的新模型应填进表单');
    assert.equal(values.filter((v) => v === 'gpt-6.1-sol').length, 1, '已存在的模型不应重复添加');
    providersMod.closeProviderForm();
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('模型页：网关没运行时注入开关被拦下，并给出指引', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    installFakeDom();

    const state = fixtureState({
      gateway: { enabled: true, running: false, port: 18120, url: '', modelBase: '127.0.0.1:18120', token: '' },
      inject: { enabled: false, catalogPath: null, defaultModel: null },
      status: {
        ...fixtureState().status,
        gateway: { enabled: true, running: false, port: 18120, url: '', startedAt: null },
        inject: { enabled: false, catalogPath: null, defaultModel: null },
      },
    });
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    modelsMod.renderModels(root, ctx, new FakeNode('div'));
    const switches = root.find('switch');
    const modelSwitches = root.find('model-switch');
    assert.equal(switches.length, 1, '链路末端应只有一个注入开关');
    assert.equal(modelSwitches.length, 3, '模型表中每个模型应有一个状态开关');
    click(switches[0]);
    await flush();
    assert.equal(callsOf(ctx, 'setInject').length, 0, '网关没运行时不应真的去注入');
    const warnToast = ctx._calls.find((c) => c[0] === 'toast' && String(c[2]).includes('网关未运行'));
    assert.ok(warnToast, '应提示网关未运行');

    // 重新渲染后应看到带「去设置」按钮的黄色提示
    const rerendered = new FakeNode('main');
    modelsMod.renderModels(rerendered, ctx, new FakeNode('div'));
    assert.match(rerendered.allText(), /本地网关已启用但没有在运行/, '应给出可操作的原因说明');
    assert.ok(buttonsWithText(rerendered, '去设置').length, '提示里应有跳转设置的入口');

    // 所有 provider/model 停用时，注入开关应在界面层拦截
    const disabled = fixtureState({
      models: [
        { slug: 'p_demo0001__gpt-6.1-sol', providerId: 'p_demo0001', providerName: '梦幻API', modelId: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', enabled: false, reasoning: true },
      ],
      providers: fixtureState().providers.map((provider) => ({
        ...provider,
        enabled: false,
        models: (provider.models || []).map((model) => ({ ...model, enabled: false })),
      })),
      inject: { enabled: false, catalogPath: null, defaultModel: null },
      status: {
        ...fixtureState().status,
        inject: { enabled: false, catalogPath: null, defaultModel: null },
      },
    });
    const disabledCtx = makeCtx(appMod, disabled);
    const disabledRoot = new FakeNode('main');
    modelsMod.renderModels(disabledRoot, disabledCtx, new FakeNode('div'));
    click(disabledRoot.find('switch')[0]);
    await flush();
    assert.equal(callsOf(disabledCtx, 'setInject').length, 0, '没有启用模型时不应调用 setInject');
    assert.ok(disabledCtx._calls.some((c) => c[0] === 'toast' && String(c[2]).includes('已启用的模型')));

    // 网关正常时，切换注入会真的调用 setInject
    const ok = makeCtx(appMod, fixtureState());
    const okRoot = new FakeNode('main');
    const okActions = new FakeNode('div');
    modelsMod.renderModels(okRoot, ok, okActions);
    click(okRoot.find('switch')[0]);
    await flush();
    assert.deepEqual(callsOf(ok, 'setInject'), [['setInject', { enabled: false }]], '已注入时应能关闭注入');

    // 设为默认
    click(buttonsWithText(okRoot, '设为默认')[0]);
    await flush();
    assert.deepEqual(callsOf(ok, 'setInject')[1], ['setInject', { defaultModel: 'p_demo0001__claude-x' }]);

  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('设置页：端口校验 / 网关开关 / 探活 / 还原注入都能走通', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const settingsMod = await import(pathToFileURL(path.join(tmp, 'views', 'settings.js')).href);
    installFakeDom();

    const ctx = makeCtx(appMod, fixtureState());
    const root = new FakeNode('main');
    settingsMod.renderSettings(root, ctx, new FakeNode('div'));

    // 网关开关
    click(root.find('switch')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setGateway')[0], ['setGateway', { enabled: false }], '网关开关应调用 setGateway');

    // 端口：非法值被拦下
    const portInput = byAttr(root, 'aria-label', '网关端口')[0];
    assert.ok(portInput, '应有端口输入框');
    type(portInput, '700');
    click(buttonsWithText(root, '保存端口')[0]);
    await flush();
    assert.equal(callsOf(ctx, 'setGateway').length, 1, '非法端口不应提交');
    assert.ok(ctx._calls.find((c) => c[0] === 'toast' && c[1] === 'warn'), '非法端口应给出警告');

    // 端口：合法值
    const rerendered = new FakeNode('main');
    settingsMod.renderSettings(rerendered, ctx, new FakeNode('div'));
    type(byAttr(rerendered, 'aria-label', '网关端口')[0], '19999');
    click(buttonsWithText(rerendered, '保存端口')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setGateway')[1], ['setGateway', { port: 19999 }], '合法端口应提交');

    const limitsRoot = new FakeNode('main');
    settingsMod.renderSettings(limitsRoot, ctx, new FakeNode('div'));
    type(byAttr(limitsRoot, 'aria-label', '上下文窗口 Token')[0], '272000');
    type(byAttr(limitsRoot, 'aria-label', '自动压缩阈值 Token')[0], '244800');
    click(buttonsWithText(limitsRoot, '保存上下文设置')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setModelLimits')[0], ['setModelLimits', { contextWindow: 272000, autoCompactTokenLimit: 244800 }]);

    const invalidLimitsRoot = new FakeNode('main');
    settingsMod.renderSettings(invalidLimitsRoot, ctx, new FakeNode('div'));
    type(byAttr(invalidLimitsRoot, 'aria-label', '上下文窗口 Token')[0], '1000');
    click(buttonsWithText(invalidLimitsRoot, '保存上下文设置')[0]);
    await flush();
    assert.equal(callsOf(ctx, 'setModelLimits').length, 1, '非法上下文窗口不应提交');

    // 探活
    click(buttonsWithText(rerendered, '探活')[0]);
    await flush();
    assert.equal(callsOf(ctx, 'probeGateway').length, 1, '探活应调用 probeGateway');

    // 还原注入（两步确认）
    click(buttonsWithText(rerendered, '还原注入')[0]);
    const confirmRoot = new FakeNode('main');
    settingsMod.renderSettings(confirmRoot, ctx, new FakeNode('div'));
    assert.match(confirmRoot.allText(), /官方模型立刻恢复/, '还原注入需要二次确认');
    click(buttonsWithText(confirmRoot, '确认还原')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setInject'), [['setInject', { enabled: false }]], '确认后应调用 setInject(false)');

    // 打开目录
    click(buttonsWithText(confirmRoot, '打开 Codex 目录')[0]);
    await flush();
    assert.equal(callsOf(ctx, 'openCodexFolder').length, 1, '应调用 openCodexFolder');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================
// 12. 回归：使用量统计与默认模型标注
// ============================================================

test('使用量页：成功率含失败请求，趋势按本地时区分桶不丢数据', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();

    const usage = (input, output) => ({
      input_tokens: input,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: output,
      total_tokens: input + output,
    });
    const at = (hour, minute) => {
      const d = new Date();
      d.setHours(hour, minute, 0, 0);
      return d.getTime();
    };
    // 本地 00:30 与 23:30：按 UTC 切日的旧实现里，23:30 那条会落进 7 个桶之外被静默丢掉
    // （任何时区偏移下都成立），按本地日期切桶后两条都必须被计入。
    const now = at(23, 30);
    const logs = [
      // 成功
      { at: now, providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 200, ms: 100, tokens: usage(80, 20) },
      { at: at(0, 30), providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 200, ms: 60, tokens: usage(40, 10) },
      // 失败与在飞：成功率必须把它们算进分母
      { at: now, providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 502, ms: 30 },
      { at: now, providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 0, ms: 0 },
    ];
    const ctx = makeCtx(appMod, fixtureState({ logs }));
    const root = new FakeNode('main');
    usageMod.renderUsage(root, ctx, new FakeNode('div'));

    const text = root.allText();
    // 3 条已出结果（2 成功 + 1 失败）；旧实现只在 status===200 的集合里算比例 -> 永远 100%
    assert.match(text, /成功率 67%/, `成功率应约 67%，实际文案：${text.slice(0, 400)}`);
    assert.match(text, /失败 1 次/);
    assert.doesNotMatch(text, /100% 返回 HTTP 200/);

    // 趋势图：本地时区下「今天」的热力格必须收到三条终结请求（2 成功 + 1 失败）
    // （el() 是走 className 赋值的，FakeNode 的 classList 不会同步，所以按 className 字符串找）
    const hasClass = (n, name) => String(n.className || '').split(/\s+/).includes(name);
    const cells = findNodes(root, (n) => hasClass(n, 'usage-heatmap-cell') && n.attributes['data-date']);
    assert.ok(cells.length >= 365, `年度热力图应至少覆盖 365 天，实际 ${cells.length}`);
    const counted = cells.reduce((sum, cell) => sum + Number(cell.attributes['data-requests'] || 0), 0);
    assert.equal(counted, 3, '三条终结请求都必须落在某个桶里（旧实现按 UTC 切日会漏掉今天的）');
    assert.match(root.allText(), /近一年 · 按完成时间/);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('使用量页：优先使用 state.usage，并纳入 final/usageRecord 失败请求', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();

    const now = Date.now();
    const logs = [{
      at: now,
      providerId: 'p_logs',
      providerName: '原始日志渠道',
      model: 'logs-model',
      status: 200,
      ms: 10,
      tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }];
    const usage = [
      {
        at: now,
        providerId: 'p_usage',
        providerName: 'usage 渠道',
        model: 'final-failure-model',
        status: 502,
        ms: 240,
        final: true,
      },
      {
        at: now - 1,
        providerId: 'p_usage',
        providerName: 'usage 渠道',
        model: 'usage-record-failure-model',
        status: 499,
        ms: 180,
        usageRecord: true,
      },
    ];
    const root = new FakeNode('main');
    usageMod.renderUsage(root, makeCtx(appMod, fixtureState({ logs, usage })), new FakeNode('div'));

    const rows = findNodes(root, (node) => {
      const classes = String(node.className || '').split(/\s+/);
      return classes.includes('usage-table-row') && !classes.includes('usage-table-head');
    });
    assert.equal(rows.length, 2, '非空 state.usage 应优先于 state.logs，且两条失败终结请求都应进入明细');
    assert.doesNotMatch(root.allText(), /原始日志渠道|logs-model/, 'state.logs 不应覆盖非空的 state.usage');
    assert.match(root.allText(), /final-failure-model/);
    assert.match(root.allText(), /usage-record-failure-model/);

    for (const row of rows) {
      const status = row.childNodes[7];
      assert.ok(status, '请求明细应包含状态列');
      assert.match(status.className, /\bchip-err\b/, '失败终结请求的状态列必须使用 chip-err');
      assert.match(status.textContent, /^HTTP (?:502|499)$/);
    }
    assert.match(root.allText(), /请求数/);
    assert.match(root.allText(), /成功率 0%/);
    assert.match(root.allText(), /失败 2 次/);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('使用量页：Token 热力图按使用量映射 1 到 4 档颜色', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const at = (offset, total) => {
      const d = new Date(today);
      d.setDate(d.getDate() - offset);
      return { at: d.getTime(), providerId: 'p_demo0001', model: 'a__m', status: 200, tokens: { total_tokens: total } };
    };
    const root = new FakeNode('main');
    usageMod.renderUsage(root, makeCtx(appMod, fixtureState({ logs: [at(0, 1000), at(1, 700), at(2, 400), at(3, 200), at(4, 50)] })), new FakeNode('div'));

    const hasClass = (n, name) => String(n.className || '').split(/\s+/).includes(name);
    const cells = findNodes(root, (n) => hasClass(n, 'usage-heatmap-cell') && n.attributes['data-date']);
    for (const level of [1, 2, 3, 4]) {
      assert.ok(cells.some((cell) => hasClass(cell, `usage-heatmap-level-${level}`)), `应出现热力颜色等级 ${level}`);
    }
    assert.ok(cells.some((cell) => hasClass(cell, 'usage-heatmap-level-0')), '无使用量日期应保留零值等级');
    assert.ok(cells.some((cell) => cell.attributes['data-requests'] === '1' && hasClass(cell, 'usage-heatmap-level-4')), '最大 Token 日应使用最高等级');
    assert.ok(cells.every((cell) => cell.attributes['data-tooltip']), '每个日期格都应提供即时悬浮提示内容');
    assert.equal(cells.some((cell) => cell.attributes.title), false, '热力格不应依赖原生 title 延迟提示');
    assert.ok(cells.every((cell) => cell.attributes.tabindex === '0'), '热力格应支持键盘聚焦查看提示');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('使用量页：完整 Token 列、兼容缓存字段与 usage 来源', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();
    const now = Date.now();
    const logs = [
      {
        at: now, providerId: 'p_demo0001', providerName: '梦幻API',
        model: 'p_demo0001__estimated-model', upstreamModel: 'estimated-model',
        status: 200, ms: 1200, estimatedUsage: true,
        tokens: {
          input_tokens: 100,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
          output_tokens: 25,
          reasoning_tokens: 7,
          total_tokens: 125,
        },
      },
      {
        at: now - 1, providerId: 'p_demo0001', providerName: '梦幻API',
        model: 'p_demo0001__upstream-model', upstreamModel: 'upstream-model',
        status: 200, ms: 900,
        tokens: {
          input_tokens: 80,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 90,
        },
      },
    ];
    const root = new FakeNode('main');
    usageMod.renderUsage(root, makeCtx(appMod, fixtureState({ logs })), new FakeNode('div'));
    const text = root.allText();
    assert.match(text, /梦幻API · estimated-model/);
    assert.match(text, /梦幻API · upstream-model/);
    assert.match(text, /未缓存输入/);
    assert.match(text, /缓存输入/);
    assert.match(text, /输出/);
    assert.match(text, /缓存写入/);
    assert.match(text, /推理/);
    assert.match(text, /总 Token/);
    assert.match(text, /来源/);
    const rows = findNodes(root, (n) => String(n.className || '').split(/\s+/).includes('usage-table-row'));
    const requestRows = rows.filter((n) => !String(n.className || '').split(/\s+/).includes('usage-table-head'));
    assert.equal(requestRows.length, 2, '两条有 usage 的成功请求都应展示在明细中');

    const estimated = requestRows.find((n) => n.textContent.includes('estimated-model'));
    assert.ok(estimated, '最近请求应展示渠道与模型名');
    const estimatedCells = estimated.childNodes.map((cell) => cell.textContent);
    assert.equal(estimatedCells.length, 12, '请求明细应有完整的 12 列');
    assert.equal(estimatedCells[2], '60', '未缓存输入 = 总输入 100 - 缓存读取 30 - 缓存写入 10');
    assert.equal(estimatedCells[3], '30', 'cache_read_input_tokens 应映射到缓存输入列');
    assert.equal(estimatedCells[4], '25', '输出 token 应位于缓存命中率之前');
    assert.equal(estimatedCells[5], '30.0%', '缓存命中率应使用 cache_read_input_tokens / 输入 token');
    assert.equal(estimatedCells[8], '10', 'cache_creation_input_tokens 应映射到缓存写入列');
    assert.equal(estimatedCells[9], '7', '推理 token 应支持顶层 reasoning_tokens');
    assert.equal(estimatedCells[10], '125', '总 Token 列应展示 total_tokens');
    assert.equal(estimatedCells[11], '估算', 'estimatedUsage 请求应显示估算来源');
    assert.match(estimated.childNodes[11].className, /\bchip-warn\b/);

    const upstream = requestRows.find((n) => n.textContent.includes('upstream-model'));
    assert.ok(upstream, '上游 usage 请求应展示在明细中');
    const upstreamCells = upstream.childNodes.map((cell) => cell.textContent);
    assert.equal(upstreamCells[2], '55', '嵌套缓存字段的未缓存输入应扣除缓存读取和缓存写入');
    assert.equal(upstreamCells[3], '20', '嵌套 cached_tokens 应映射到缓存输入列');
    assert.equal(upstreamCells[8], '5', '嵌套 cache_write_tokens 应映射到缓存写入列');
    assert.equal(upstreamCells[9], '3', '嵌套 reasoning_tokens 应映射到推理列');
    assert.equal(upstreamCells[10], '90', '上游请求应展示 total_tokens');
    assert.equal(upstreamCells[11], '上游', '非估算 usage 请求应显示上游来源');
    assert.match(upstream.childNodes[11].className, /\bchip-ok\b/);
    assert.doesNotMatch(text, /p_demo0001__/);
    assert.match(text, /缓存命中率/);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('使用量页：旧新 slug 的同一渠道模型合并统计', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();

    const now = Date.now();
    const logs = [
      {
        at: now,
        providerId: 'p_demo0001',
        providerName: '梦幻API',
        model: 'p_demo0001__gpt-6.1-sol',
        upstreamModel: 'gpt-6.1-sol',
        status: 200,
        ms: 100,
        tokens: { total_tokens: 10 },
      },
      {
        at: now - 1,
        providerId: 'p_demo0001',
        providerName: '梦幻API',
        model: '梦幻API__gpt-6.1-sol',
        upstreamModel: 'gpt-6.1-sol',
        status: 200,
        ms: 300,
        tokens: { total_tokens: 20 },
      },
      {
        at: now - 2,
        providerId: 'p_demo0002',
        providerName: 'movoapi',
        model: 'movoapi__gpt-6.1-sol',
        upstreamModel: 'gpt-6.1-sol',
        status: 200,
        ms: 50,
        tokens: { total_tokens: 5 },
      },
    ];
    const root = new FakeNode('main');
    usageMod.renderUsage(root, makeCtx(appMod, fixtureState({ logs })), new FakeNode('div'));

    const breakdowns = root.find('usage-breakdown');
    assert.equal(breakdowns.length, 2, '应有按模型和按提供商两个统计区块');
    const modelBreakdown = breakdowns[0];
    const modelRows = modelBreakdown.find('usage-list-row').filter((row) => !row.className.includes('usage-list-head'));
    assert.equal(modelRows.length, 2, '同一渠道的旧新 slug 应合并成一个模型统计项');
    assert.match(modelBreakdown.allText(), /梦幻API · gpt-6\.1-sol/);
    assert.match(modelBreakdown.allText(), /2 次/);
    assert.match(modelBreakdown.allText(), /30/);
    assert.match(modelBreakdown.allText(), /200ms/);
    assert.match(modelBreakdown.allText(), /movoapi · gpt-6\.1-sol/);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('使用量页：时间范围与请求记录显示条数会真实生效并保留选中值', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();

    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const request = (age, index) => ({
      at: now - age,
      providerId: 'p_demo0001',
      providerName: '梦幻API',
      model: 'p_demo0001__gpt-6.1-sol',
      status: 200,
      ms: 100 + index,
      tokens: { total_tokens: 10 + index },
    });
    const logs = [
      ...Array.from({ length: 5 }, (_, index) => request((index + 1) * hour, index)),
      ...Array.from({ length: 15 }, (_, index) => request(2 * day + index * hour, index + 5)),
      ...Array.from({ length: 40 }, (_, index) => request(8 * day + index * hour, index + 20)),
    ];

    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    const ctx = makeCtx(appMod, fixtureState({ logs }));
    ctx.renderCurrent = () => usageMod.renderUsage(root, ctx, actions);
    const dataRows = () => findNodes(root, (node) => {
      const classes = String(node.className || '').split(/\s+/);
      return classes.includes('usage-table-row') && !classes.includes('usage-table-head');
    });
    const recentHeader = () => findNodes(root, (node) => String(node.className || '').split(/\s+/).includes('usage-recent-head'))[0];
    const selects = () => root.findTag('select');
    const change = (node, value) => {
      node.value = value;
      for (const handler of node.listeners.change || []) handler({ target: node });
    };

    usageMod.renderUsage(root, ctx, actions);
    assert.equal(selects()[0].value, 'all', '默认时间范围应为全部历史');
    assert.equal(selects()[1].value, '20', '默认显示条数应为 20');
    assert.equal(dataRows().length, 20, '全部历史默认只显示 20 条请求记录');
    assert.match(recentHeader().textContent, /20 \/ 60/, '请求记录标题应显示当前条数与总数');

    change(selects()[0], '24h');
    assert.equal(selects()[0].value, '24h', '选择最近 24 小时后控件不能回落到全部历史');
    assert.equal(dataRows().length, 5, '最近 24 小时应只显示 5 条请求');
    assert.match(recentHeader().textContent, /5 \/ 5/, '最近 24 小时的请求记录总数应为 5');

    change(selects()[0], '7d');
    assert.equal(selects()[0].value, '7d', '选择最近 7 天后控件不能回落到全部历史');
    assert.equal(dataRows().length, 20, '最近 7 天应显示 20 条请求');
    assert.match(recentHeader().textContent, /20 \/ 20/, '最近 7 天的请求记录总数应为 20');

    change(selects()[0], 'all');
    change(selects()[1], '50');
    assert.equal(selects()[1].value, '50', '选择显示 50 条后控件不能回落到 20 条');
    assert.equal(dataRows().length, 50, '选择显示 50 条后应显示 50 条请求');
    assert.match(recentHeader().textContent, /50 \/ 60/, '显示 50 条的标题应反映实际可见条数');

    change(selects()[1], 'all');
    assert.equal(selects()[1].value, 'all', '选择显示全部后控件应保持显示全部');
    assert.equal(dataRows().length, 60, '选择显示全部后应显示全部 60 条请求');
    assert.match(recentHeader().textContent, /60 \/ 60/, '显示全部的标题应反映完整历史');

    change(selects()[0], '24h');
    assert.equal(dataRows().length, 5, '应先应用时间范围，再应用显示条数');
    assert.match(recentHeader().textContent, /5 \/ 5/, '组合筛选不能把全部历史带回请求记录');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('模型页：默认模型标注只跟着真正写进配置的 slug', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    installFakeDom();

    const base = fixtureState();
    const state = fixtureState({
      // store 里从没设过默认模型
      inject: { enabled: true, catalogPath: base.inject.catalogPath, defaultModel: null },
      status: { ...base.status, inject: { ...base.status.inject, defaultModel: null } },
    });
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    modelsMod.renderModels(root, ctx, new FakeNode('div'));
    assert.equal(
      findNodes(root, (n) => n.textContent === '当前默认').length,
      0,
      '没有真正设置默认模型时不能给任何行打「当前默认」',
    );
    assert.match(root.allText(), /未设置/, '默认模型应显示未设置');

    const hasClass = (n, name) => String(n.className || '').split(/\s+/).includes(name);
    const withDefault = makeCtx(appMod, fixtureState());
    const root2 = new FakeNode('main');
    modelsMod.renderModels(root2, withDefault, new FakeNode('div'));
    const offRow = findNodes(root2, (n) => hasClass(n, 'tbody-row') && hasClass(n, 'is-off'));
    assert.ok(offRow.length, '应存在停用模型行');
    const btn = findNodes(offRow[0], (n) => n.tagName === 'BUTTON' && n.textContent.includes('设为默认'))[0];
    assert.ok(btn, '停用模型行应有设为默认按钮（禁用态）');
    assert.equal(btn.disabled, true, '停用模型不能设为默认，按钮必须禁用而不是静默改值');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
