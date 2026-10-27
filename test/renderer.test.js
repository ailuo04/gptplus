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

const VIEW_FILES = ['home.js', 'providers.js', 'models.js', 'usage.js', 'plugins.js', 'settings.js', 'weixin.js'];
const JS_FILES = ['app.js', ...VIEW_FILES.map((f) => path.join('views', f))];

function read(file) {
  // Windows 上 core.autocrlf=true 会把工作区里的部分文件换成 CRLF，而下面按 '\n'
  // 做的源码切片断言会因此找不到锚点。统一成 LF，保证本地与 CI 结果一致。
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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
  assert.deepEqual(navViews, ['home', 'models', 'plugins', 'providers', 'settings', 'usage', 'weixin'], '导航视图应与页面实现一致');

  const src = read(APP);
  const metaBlock = src.slice(src.indexOf('const VIEW_META'), src.indexOf('function renderChrome'));
  const metaViews = [...metaBlock.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(metaViews, navViews, 'VIEW_META 的键必须与导航的 data-view 完全一致');
  assert.match(src, /view: 'home'/, '主页应是默认打开的第一个视图');
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

test('开机自启动开关常驻左侧底部并调用系统登录项 API', () => {
  const appSrc = read(APP);
  const preloadSrc = read(PRELOAD);
  const cssSrc = read(path.join(ROOT, 'src/renderer/styles.css'));
  assert.match(appSrc, /function renderStartupControl\(\)/, 'app.js 必须渲染开机自启动控件');
  assert.match(appSrc, /function saveStartupPreference\(enabled, nextTarget\)/, 'app.js 必须处理开机自启动切换');
  assert.match(appSrc, /api\.getStartup\(\)/, '启动时必须读取开机自启动状态');
  assert.match(appSrc, /api\.setStartup\(\{ enabled, target \}\)/, '切换必须调用 setStartup 并带启动目标');
  assert.match(
    appSrc,
    /nextTarget === undefined\s*\?\s*\(current\.target === 'both' \? 'both' : 'gptplus'\)\s*:\s*nextTarget === 'both' \? 'both' : 'gptplus'/,
    '明确选择仅 gpt++ 时必须切回 gptplus，不能沿用当前 both 目标',
  );
  assert.match(appSrc, /class: 'sidebar-startup'/, '控件必须位于左侧底部动作区');
  assert.match(appSrc, /role: 'switch'/, '开机自启动必须使用 switch 语义');
  assert.match(appSrc, /data: \{ startupTarget: value \}/, '启动目标选项必须带有可定位的数据属性');
  assert.match(appSrc, /role: 'radiogroup'/, '启动目标选项组必须有 radiogroup 语义');
  assert.match(appSrc, /gpt\+\+ \+ ChatGPT/, '界面必须提供同时启动 ChatGPT 的选项');
  assert.match(cssSrc, /\.sidebar-startup-options\s*\{/, '启动目标选项必须有独立样式');
  assert.match(cssSrc, /\.sidebar-startup-toggle\s*\{[^}]*width:\s*40px;/s, '同排开关应保持紧凑的固定宽度');
  assert.match(preloadSrc, /getStartup:.*gptplus:startup:get/, 'preload 必须暴露读取启动状态 API');
  assert.match(preloadSrc, /setStartup:.*gptplus:startup:set/, 'preload 必须暴露设置启动状态 API');
  assert.match(cssSrc, /\.sidebar-startup\s*\{/, '开机自启动控件必须有独立样式');
  assert.match(cssSrc, /\.sidebar-startup-toggle\.is-enabled/, '开机自启动必须有开启态样式');
  assert.match(cssSrc, /\.sidebar-startup-option\.is-selected/, '启动目标必须有选中态样式');
});

test('主题三态快捷控件位于底部状态栏，不重复出现在设置页', () => {
  const html = read(HTML);
  const appSrc = read(APP);
  const settingsSrc = read(path.join(VIEWS, 'settings.js'));
  assert.match(html, /<div class="statusbar-right">[\s\S]*id="theme-control"[\s\S]*id="build-tag"/, '主题控件应放在状态栏右侧，与版本号相邻');
  assert.match(appSrc, /function renderThemeControl\(\)/, 'app.js 应负责渲染底部主题快捷控件');
  assert.doesNotMatch(settingsSrc, /themeCard|saveTheme|themeBusy/, '设置页不应再渲染旧的主题卡片');
});

test('gpt++ 不在自身底部重复展示 ChatGPT 用量指标', () => {
  const html = read(HTML);
  const appSrc = read(APP);
  const cssSrc = read(CSS);
  assert.doesNotMatch(html, /id="runtime-metrics"/);
  assert.doesNotMatch(appSrc, /function renderRuntimeMetrics\(\)/);
  assert.doesNotMatch(cssSrc, /\.runtime-metrics\s*\{/);
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
  assert.equal(viewImports.length, VIEW_FILES.length, 'app.js 应分别 import 所有视图');

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
    ['home.js', 'renderHome'],
    ['providers.js', 'renderProviders'],
    ['models.js', 'renderModels'],
    ['usage.js', 'renderUsage'],
    ['plugins.js', 'renderPlugins'],
    ['settings.js', 'renderSettings'],
    ['weixin.js', 'renderWeixin'],
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

test('禁用的主按钮悬停时不会回落成浅色底配浅色字', () => {
  const css = read(CSS);
  // 通用禁用态把背景改成中性面板色，但 .btn-primary 的文字色是 --on-accent（近白），
  // 两者叠加会让按钮在悬停时变成一块空白。主按钮必须覆盖掉这条回落。
  assert.match(css, /\.btn\[disabled\]:hover[^{]*\{[^}]*background:\s*var\(--bg-panel-2\)/s, '禁用态悬停应保留中性底色回落');
  const primaryDisabled = css.match(/\.btn-primary\[disabled\]:hover[^{]*\{([^}]*)\}/s)?.[1] || '';
  assert.match(primaryDisabled, /background:\s*var\(--accent\)/, '主按钮禁用悬停时背景必须保持主色，避免文字消失');
});

test('页面切换只使用单一内容区的短淡入，不创建占位层或双层路由图层', () => {
  const css = read(CSS);
  const stageRule = css.match(/\.page-stage\s*\{([^}]*)\}/s)?.[1] || '';
  assert.equal(stageRule, '', '不应再保留 page-stage 双层路由样式');
  assert.match(css, /\.content\.is-view-switching\s*\{[^}]*animation:\s*view-switch 120ms ease-out both/s);
  assert.match(read(APP), /function playViewSwitch\(\)/);
  assert.doesNotMatch(read(APP), /routeTransitionActive|ROUTE_TRANSITION_MS|renderRoutePlaceholder|playEnter/);
  assert.doesNotMatch(css, /\.page-stage|\.route-placeholder/);
});

test('切页先立即渲染当前状态，数据加载完成后只刷新仍在当前页', () => {
  const appSrc = read(APP);
  assert.match(
    appSrc,
    /renderCurrent\(true, \{ preserveScrollTop: false \}\);\s*playViewSwitch\(\);/s,
    '点击切页后必须先用当前状态渲染页面再播放动画',
  );
  assert.match(appSrc, /const needsData = \(VIEW_META\[view\]\.needs \|\| \[\]\)\.some\(\(key\) => !state\.loaded\[key\]\);/);
  assert.match(appSrc, /if \(!needsData\) return;\s*ensureLoaded\(view\)\.then/s, '缓存页不能在切页后再次无条件重绘');
  assert.match(
    appSrc,
    /ensureLoaded\(view\)\.then\(\(\) => \{[\s\S]*?if \(state\.view !== view \|\| token !== viewTransitionToken\) return;[\s\S]*?renderCurrent\(true, \{ preserveScrollTop: true \}\);/s,
    '异步数据完成后只能刷新仍处于当前页的内容',
  );
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

test('默认模型下拉展开时位于后续模型卡片之上', () => {
  const css = read(CSS);
  assert.match(css, /\.card:has\(\.model-picker\.is-open\)\s*\{[^}]*z-index:\s*20/s, '展开默认模型选择器时，父卡片必须提升层级');
  assert.match(css, /\.model-picker-menu\s*\{[^}]*z-index:\s*30/s, '默认模型菜单必须有独立层级');
  assert.match(css, /\.model-picker-menu\s*\{[^}]*background-color:\s*var\(--bg-panel\)/s, '默认模型菜单必须使用不透明背景');
});

test('使用量页把趋势与拆分统计放入同一概览网格', () => {
  const css = read(CSS);
  const usage = read(path.join(VIEWS, 'usage.js'));
  assert.match(usage, /class: 'usage-overview-grid'/, '趋势和拆分统计应有共同容器');
  assert.match(css, /\.usage-overview-grid\s*\{[^}]*display:\s*grid/s, '使用量概览应采用网格布局');
  assert.match(css, /\.usage-recent\s*\{[^}]*max-height:/s, '请求记录应在卡片内部滚动，避免撑高整页');
});

test('上游网络模式使用独立的系统代理与直连语义色', () => {
  const css = read(CSS);
  assert.match(css, /--network-system:/, '缺少系统代理颜色令牌');
  assert.match(css, /--network-direct:/, '缺少直连颜色令牌');
  assert.match(css, /\.sidebar-network-option\[data-network-mode="system"\]\.is-selected/, '系统代理选中态必须有独立样式');
  assert.match(css, /\.sidebar-network-option\[data-network-mode="direct"\]\.is-selected/, '直连选中态必须有独立样式');
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
      if (rel === 'views/home.js') assert.equal(typeof mod.renderHome, 'function');
      if (rel === 'views/models.js') assert.equal(typeof mod.renderModels, 'function');
      if (rel === 'views/settings.js') assert.equal(typeof mod.renderSettings, 'function');
      if (rel === 'views/weixin.js') assert.equal(typeof mod.renderWeixin, 'function');
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

test('模型拖动按被拖行中心越过格边界判断目标（拖半行即换位）', async () => {
  const tmp = copyRendererToTemp();
  try {
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    const rowTops = [100, 150, 200];
    // grabOffsetY = 25 时，被拖行中心正好等于 pointerY；起始中心 175
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 200, 25), 1, '中心正好压在格边界上时保持原位');
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 201, 25), 2, '中心越过下一格上边界后换到下一行');
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 226, 25), 2, '继续向下仍停在下一行');
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 152, 25), 1, '向上还没越过边界时保持原位');
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 148, 25), 0, '向上越过边界后换到上一行');
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 201, 25), 2, '向下 26px 就换位，不需要拖满一整行');
    assert.equal(modelsMod.dragTargetIndex(rowTops, 1, 50, 251, 50), 2, '同一个中心点对应同一个目标，与抓取位置无关');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('模型拖动预览按整格让位，不做“半格后弹回”的无效位移', async () => {
  const tmp = copyRendererToTemp();
  try {
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    const rowTops = [100, 150, 200, 250];
    assert.deepEqual(modelsMod.dragRowOffsets(rowTops, 1, 1, 50), [0, 0, 0, 0], '没有换位时其它行不动');
    assert.deepEqual(modelsMod.dragRowOffsets(rowTops, 1, 2, 50), [0, 0, -50, 0], '向下换一格：下一行整格让位');
    assert.deepEqual(modelsMod.dragRowOffsets(rowTops, 1, 3, 50), [0, 0, -50, -50], '向下换两格：中间各行整格上移');
    assert.deepEqual(modelsMod.dragRowOffsets(rowTops, 2, 1, 50), [0, 50, 0, 0], '向上换一格：上一行整格让位');
    assert.deepEqual(modelsMod.dragRowOffsets(rowTops, 2, 0, 50), [50, 50, 0, 0], '向上换两格：经过的行整格下移');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('松手提交的顺序与拖动预览里行让位显示的顺序一致', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    installFakeDom();
    // 同步执行 rAF，指针一动就能在 DOM 上量到预览位移
    window.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    window.cancelAnimationFrame = () => {};

    const state = fixtureState();
    const ctx = makeCtx(appMod, state);
    const saved = [];
    ctx.api.reorderModels = async ({ orderKeys }) => {
      saved.push(orderKeys);
      return state.status;
    };

    const runCase = async (deltaY) => {
      saved.length = 0;
      const root = new FakeNode('main');
      modelsMod.renderModels(root, ctx, new FakeNode('div'));
      const rows = root.find('tbody-row');
      const rowsBox = root.find('table')[0];
      rows.forEach((row, index) => {
        // DOM 替身不会把 setAttribute('class') 同步进 classList，这里手动补上
        row.classList.add('tbody-row');
        row.getBoundingClientRect = () => ({ top: 100 + index * 50, left: 0, width: 600, height: 50 });
      });
      const keys = rows.map((row) => row.dataset.orderKey);
      const startIndex = 1;
      const startY = 100 + startIndex * 50 + 25;

      rows[startIndex].find('model-drag-handle')[0].listeners.pointerdown[0]({
        button: 0,
        pointerId: 9,
        clientY: startY,
        preventDefault() {},
      });
      rowsBox.listeners.pointermove[0]({ pointerId: 9, clientY: startY + deltaY, preventDefault() {} });

      // 预览里已经“让开”的格数，就是这一拖实际插入的位置
      let previewTarget = startIndex;
      rows.forEach((row, index) => {
        const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.getPropertyValue('transform') || '');
        const offset = match ? Number(match[1]) : 0;
        if (index > startIndex && offset < 0) previewTarget = index;
        if (index < startIndex && offset > 0) previewTarget = index;
      });
      const previewOrder = modelsMod.reorderModelKeys(keys, startIndex, previewTarget);

      await rowsBox.listeners.pointerup[0]({ pointerId: 9, clientY: startY + deltaY });

      if (previewTarget === startIndex) {
        assert.equal(saved.length, 0, `位移 ${deltaY}px 时预览没有换位，松手也不应提交`);
      } else {
        assert.deepEqual(saved[0], previewOrder, `位移 ${deltaY}px 时松手提交的顺序应与预览一致`);
      }
    };

    for (const delta of [-130, -80, -30, -24, 0, 24, 30, 80, 130]) {
      await runCase(delta);
    }
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('模型拖动松手时同步最终指针位置并立即更新 DOM 顺序', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    installFakeDom();

    const state = fixtureState();
    const ctx = makeCtx(appMod, state);
    const savedOrders = [];
    ctx.api.reorderModels = async ({ orderKeys }) => {
      savedOrders.push(orderKeys);
      return state.status;
    };
    const root = new FakeNode('main');
    modelsMod.renderModels(root, ctx, new FakeNode('div'));
    const rowsBox = root.find('table')[0];
    const rows = root.find('tbody-row');
    assert.equal(rows.length, 3, '测试需要至少三行模型才能验证越过相邻行');
    rows.forEach((row, index) => {
      row.classList.add('tbody-row');
      row.getBoundingClientRect = () => ({ top: 100 + index * 50, left: 0, width: 600, height: 50 });
    });
    const before = rows.map((row) => row.dataset.orderKey);
    const handle = rows[0].find('model-drag-handle')[0];
    const startY = 125;
    const finalY = 245;
    const queuedFrames = [];
    window.requestAnimationFrame = (callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    };
    window.cancelAnimationFrame = () => {};

    handle.listeners.pointerdown[0]({
      button: 0,
      pointerId: 7,
      clientY: startY,
      preventDefault() {},
    });
    rowsBox.listeners.pointermove[0]({
      pointerId: 7,
      clientY: finalY,
      preventDefault() {},
    });
    assert.equal(queuedFrames.length, 1, '移动事件应等待下一动画帧处理');

    await rowsBox.listeners.pointerup[0]({ pointerId: 7, clientY: finalY });

    const expected = [before[1], before[2], before[0]];
    assert.deepEqual(savedOrders, [expected], '松手应使用最终坐标提交完整顺序');
    assert.deepEqual(
      rowsBox.children.filter((row) => row.classList.contains('tbody-row')).map((row) => row.dataset.orderKey),
      expected,
      '列表 DOM 应在保存成功后立即与新顺序一致',
    );
    assert.deepEqual(
      state.models.map((model) => model.orderKey || `${model.providerId}::${model.modelId}`),
      expected,
      '内存状态也应同步为新顺序',
    );
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('页面重绘打断拖拽后，后续拖拽仍能生效', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    installFakeDom();
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};

    const state = fixtureState();
    const ctx = makeCtx(appMod, state);
    const savedOrders = [];
    ctx.api.reorderModels = async ({ orderKeys }) => {
      savedOrders.push(orderKeys);
      return state.status;
    };

    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    modelsMod.renderModels(root, ctx, actions);

    const prepare = (rows) => rows.map((row, index) => {
      row.classList.add('tbody-row');
      row.getBoundingClientRect = () => ({ top: 100 + index * 50, left: 0, width: 600, height: 50 });
      const handle = row.find('model-drag-handle')[0];
      handle.getBoundingClientRect = () => ({ top: 100 + index * 50, left: 0, width: 28, height: 28 });
      return handle;
    });

    const handles = prepare(root.find('tbody-row'));
    assert.equal(handles.length, 3, '测试需要三行模型');
    // 按下把手开始拖拽，但还没松手
    handles[0].listeners.pointerdown[0]({ button: 0, pointerId: 11, clientY: 125, preventDefault() {} });

    // 模拟拖拽途中页面被重绘（点刷新、其它操作触发 reload 等）
    root.replaceChildren();
    modelsMod.renderModels(root, ctx, new FakeNode('div'));
    const handlesAfter = prepare(root.find('tbody-row'));
    const rowsBox = root.find('table')[0];

    // 重绘后必须还能重新开始拖拽，而不是被上一次的残留状态永久卡住
    handlesAfter[0].listeners.pointerdown[0]({ button: 0, pointerId: 12, clientY: 125, preventDefault() {} });
    rowsBox.listeners.pointermove[0]({ pointerId: 12, clientY: 245, preventDefault() {} });
    await rowsBox.listeners.pointerup[0]({ pointerId: 12, clientY: 245 });

    assert.equal(savedOrders.length, 1, '重绘后的拖拽应正常提交一次排序');
    assert.deepEqual(
      rowsBox.children.filter((row) => row.classList.contains('tbody-row')).map((row) => row.dataset.orderKey),
      savedOrders[0],
      '重绘后的拖拽应真正换位',
    );
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
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
  assert.match(
    fn,
    /row\.style\.setProperty\('transition', 'transform var\(--dur-2\) var\(--ease-out\)'\)[\s\S]*?row\.style\.setProperty\('transform', 'none'\)/,
    '松手归位时应临时启用 transform 过渡，避免清除反向位移时闪跳',
  );
  assert.match(fn, /row\.style\.removeProperty\('transition'\)/, '归位动画结束后应清理临时过渡');
});

test('模型换序成功不重建页面，失败时保留滚动位置恢复', () => {
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
    /if \(!saved\) await ctx\.reload\('models', \{\s*preserveScrollTop: true\s*\}\)/,
    '拖动保存失败时才应使用保留滚动位置的刷新来恢复界面',
  );
  const finishStart = modelsSrc.indexOf('async function finishModelDrag');
  const finishEnd = modelsSrc.indexOf('\n}\n\n/** 保存成功后只同步内存顺序', finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart, '应能定位模型拖动结束流程');
  const finishFn = modelsSrc.slice(finishStart, finishEnd);
  assert.match(finishFn, /applyModelOrderToState\(ctx, nextKeys\)/, '保存成功后应直接同步当前内存顺序');
  assert.match(finishFn, /let saved = false/, '拖动保存流程需要区分保存成功与失败');
  assert.match(finishFn, /saved = true/, '保存成功后应标记为已保存');
});

test('刷新模型列表时必须同步提供商快照，避免渠道卡片残留已删除的模型', () => {
  const appSrc = read(APP);
  const planStart = appSrc.indexOf('const RELOAD_PLAN = {');
  const planEnd = appSrc.indexOf('\n};', planStart);
  assert.ok(planStart >= 0 && planEnd > planStart, '应能定位 RELOAD_PLAN');
  const plan = appSrc.slice(planStart, planEnd);
  // 数组项本身含 []（[loadModels, '模型列表']），不能用非贪婪到第一个 ] 匹配。
  const modelsStart = plan.indexOf('models: [');
  const modelsEnd = plan.indexOf('\n  ],', modelsStart);
  assert.ok(modelsStart >= 0 && modelsEnd > modelsStart, 'RELOAD_PLAN 应包含 models 条目');
  const modelsBlock = plan.slice(modelsStart, modelsEnd);
  assert.match(
    modelsBlock,
    /loadProviders/,
    '模型页的写操作（删除/启停/排序）也会改动提供商内部模型，刷新时必须一并重拉提供商列表',
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
  assert.match(appSrc, /if \(state\.view !== view \|\| token !== viewTransitionToken\) return/, '旧页面异步加载完成后不能覆盖新页面');
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
  const cssSrc = read(path.join(ROOT, 'src/renderer/styles.css'));
  assert.match(src, /fetchRemoteModels/, '表单必须调用 fetchRemoteModels');
  assert.match(src, /saveProvider/, '表单必须调用 saveProvider');
  assert.match(src, /testProvider/, '卡片必须调用 testProvider');
  assert.match(src, /testProviderModels/, '渠道有模型时必须支持逐模型测试');
  assert.match(src, /openModelTestDialog/, '必须允许先选择要测试的模型');
  assert.match(src, /model-test-result-latency/, '逐模型测试必须展示延时');
  assert.match(src, /deleteProvider/, '卡片必须调用 deleteProvider');
  assert.match(src, /添加一行/, '模型行必须可以手动新增');
  assert.match(src, /从 \/models 拉取/, '必须有拉取按钮');
  assert.match(src, /maskKey/, 'API Key 必须默认打码');
  assert.match(src, /exportProviderConfig/, '提供商页必须支持加密配置导出');
  assert.match(src, /prepareProviderImport/, '提供商页必须支持解密预览');
  assert.match(src, /applyProviderImport/, '提供商页必须在确认后写入导入配置');
  assert.match(src, /dragover/, '提供商页必须处理拖拽悬停反馈');
  assert.match(src, /event\.preventDefault\(\)/, '拖拽导入必须阻止浏览器直接打开文件');
  assert.match(src, /provider-import-dropzone/, '导入弹窗必须提供拖拽接收区域');
  assert.match(src, /复制 API Key/, 'API Key 复制入口必须保留');
  assert.match(cssSrc, /\.provider-file-drop-overlay\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/, '窗口级拖拽覆盖层必须在窗口正中显示');
  assert.match(cssSrc, /\.provider-file-drop-card\s*\{[\s\S]*?width:\s*min\(356px, 100%\);[\s\S]*?backdrop-filter:\s*blur\(28px\) saturate\(155%\)/, '提示必须使用紧凑尺寸的液态玻璃卡片');
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
  assert.match(src, /listRollbackReleases/, '设置页必须提供历史版本列表入口');
  assert.match(src, /rollbackToVersion/, '设置页必须提供指定版本回退入口');
  assert.match(src, /pendingRollback/, '回退必须先选择版本再确认');
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
    this.parentNode = null;
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
      removeProperty(k) {
        delete this._props[k];
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
    if (node instanceof FakeNode && node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    if (node instanceof FakeNode) node.parentNode = this;
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
    for (const child of this.children) child.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) if (n !== null && n !== undefined) this.appendChild(n);
    return this;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    if (node instanceof FakeNode) node.parentNode = null;
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

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
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
    removeEventListener: () => {},
    readyState: 'complete',
    documentElement: new FakeNode('html'),
    body: root,
    activeElement: null,
  };
  globalThis.window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
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
    testProviderModels: async (patch) => {
      calls.push(['testProviderModels', patch]);
      return {
        ok: true,
        results: patch.modelIds.map((modelId, index) => ({ modelId, ok: true, status: 200, latencyMs: 12 + index })),
      };
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
    deleteModel: async ({ providerId, modelId }) => {
      calls.push(['deleteModel', { providerId, modelId }]);
      state.models = state.models.filter(
        (model) => !(model.providerId === providerId && model.modelId === modelId),
      );
      return state.status;
    },
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
    openCodexConfig: async () => {
      calls.push(['openCodexConfig']);
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
    listRollbackReleases: async () => {
      calls.push(['listRollbackReleases']);
      return state.update?.rollbackReleases || [];
    },
    rollbackToVersion: async (version) => {
      calls.push(['rollbackToVersion', version]);
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
    // app.js 通过 ctx 暴露全局重启流程；首屏「下一步」按钮复用它，避免复制状态机。
    relaunchChatGpt: async () => {
      calls.push(['relaunchChatGpt']);
      state.relaunchNeeded = false;
      return true;
    },
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
    openProviderForm: (providerId) => calls.push(['openProviderForm', providerId ?? null]),
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
    assert.ok(
      root.findTag('button').some((button) => button.getAttribute('title') === '复制 API Key'),
      '提供商卡片必须保留 API Key 复制入口',
    );

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
test('主页：三段接线、今日流量与注入开关都来自真实状态', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const homeMod = await import(pathToFileURL(path.join(tmp, 'views', 'home.js')).href);
    installFakeDom();

    const today = new Date();
    today.setHours(10, 0, 0, 0);
    const state = fixtureState({
      logs: [
        { at: today.getTime(), providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 200, ms: 120, tokens: { input_tokens: 600, output_tokens: 400, total_tokens: 1000 } },
        { at: today.getTime() - 3600000, providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 502, ms: 80 },
      ],
      relaunchNeeded: false,
    });
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    homeMod.renderHome(root, ctx, actions);

    const text = root.allText();
    assert.match(text, /1 · 提供商/, '首屏必须有提供商节点');
    assert.match(text, /2 · 本地网关/, '首屏必须有本地网关节点');
    assert.match(text, /3 · ChatGPT 客户端/, '首屏必须有 ChatGPT 客户端节点');
    assert.match(text, /2 个/, '提供商节点应显示真实数量');
    assert.match(text, /运行中 :18120/, '网关节点应显示运行状态与端口');
    assert.match(text, /127\.0\.0\.1:18120/, '网关节点应显示本地地址');
    assert.match(text, /已注入 2 个模型/, '客户端节点应显示已注入数量');
    assert.match(text, /链路畅通/, '三段都通时应给出链路状态');
    assert.match(text, /1\.00K/, '今日流量应汇总当天 Token');
    assert.match(text, /成功率/, '今日流量应展示成功率');
    assert.match(text, /50%/, '今日成功率应包含失败请求');
    assert.match(text, /梦幻API/, '提供商清单应列出真实提供商');
    assert.equal(root.find('switch').length, 1, '首屏只应有一个注入总开关');
    assert.equal(root.find('switch')[0].getAttribute('aria-checked'), 'true', '注入开启时开关应处于开态');

    // 主按钮 = 添加提供商；注入开关走 setInject
    click(buttonsWithText(actions, '添加提供商')[0]);
    assert.ok(ctx._calls.some((call) => call[0] === 'openProviderForm'), '顶部主按钮应打开新建提供商表单');
    click(root.find('switch')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setInject'), [['setInject', { enabled: false }]], '注入开关应调用 setInject');

    // Codex 入口：主按钮默认打开配置文件夹，二级菜单可选打开方式
    const split = actions.find('codex-split')[0];
    assert.ok(split, '右上角应有 Codex 配置分体按钮');
    click(split.find('codex-split-main')[0]);
    await flush();
    assert.equal(callsOf(ctx, 'openCodexFolder').length, 1, '主按钮应默认打开配置文件夹');
    click(split.find('codex-split-caret')[0]);
    assert.ok(split.classList.contains('is-open'), '点小箭头应展开二级菜单');
    const codexItems = split.find('codex-split-item');
    assert.equal(codexItems.length, 2, '二级菜单应有打开文件夹/打开配置文件两个条目');
    click(codexItems[1]);
    await flush();
    assert.equal(callsOf(ctx, 'openCodexConfig').length, 1, '「打开配置文件」条目应调用 openCodexConfig');
    assert.ok(!split.classList.contains('is-open'), '选择条目后二级菜单应收起');

    // 网关未运行时打开注入应被拦下，并引导到设置页
    const blockedState = fixtureState({
      gateway: { enabled: true, running: false, port: 18120, url: '', modelBase: '127.0.0.1:18120', token: '' },
      inject: { enabled: false, catalogPath: null, defaultModel: null },
      status: {
        ...fixtureState().status,
        gateway: { enabled: true, running: false, port: 18120, url: '', startedAt: null },
        inject: { enabled: false, catalogPath: null, defaultModel: null },
      },
    });
    const blocked = makeCtx(appMod, blockedState);
    const blockedRoot = new FakeNode('main');
    homeMod.renderHome(blockedRoot, blocked, new FakeNode('div'));
    assert.match(blockedRoot.allText(), /等待接通/, '未全通时应显示等待接通');
    click(blockedRoot.find('switch')[0]);
    await flush();
    assert.equal(callsOf(blocked, 'setInject').length, 0, '网关未运行时不得注入');
    assert.ok(blocked._calls.some((call) => call[0] === 'navigate' && call[1] === 'settings'), '应把用户带到网关设置');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('主页最近请求展示实际发给上游的思考强度，旧记录不伪造档位', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const homeMod = await import(pathToFileURL(path.join(tmp, 'views', 'home.js')).href);
    installFakeDom();
    const now = Date.now();
    const base = { providerId: 'p_demo0001', providerName: '梦幻API', model: 'a__m', status: 200, ms: 120 };
    const state = fixtureState({
      logs: [
        { ...base, at: now, reasoningEffort: 'high', reasoningEffortRequested: 'medium' },
        { ...base, at: now - 1, reasoningEffort: null, reasoningEffortRequested: 'medium' },
        { ...base, at: now - 2 },
      ],
    });
    const root = new FakeNode('main');
    homeMod.renderHome(root, makeCtx(appMod, state), new FakeNode('div'));

    const lines = findNodes(root, (n) => String(n.className || '').split(/\s+/).includes('home-recent-provider'));
    assert.equal(lines.length, 3, '三条最近请求都应渲染渠道行');
    assert.match(lines[0].textContent, /思考 高/, '应显示适配器映射后实际上游档位');
    assert.match(lines[0].getAttribute('title'), /实际发给上游的思考强度：高/);
    assert.match(lines[0].getAttribute('title'), /ChatGPT 请求：中/);
    assert.match(lines[1].textContent, /思考 默认/, '没有显式档位时应说明上游使用默认值');
    assert.doesNotMatch(lines[2].textContent, /思考/, '缺少档位字段的旧记录不能猜测');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('主页对等共享入口打开配置弹窗，两个开关分别保存', async () => {
  assert.match(read(APP), /home:[\s\S]*?needs: \[[^\]]*'peer'/, '主页加载依赖中必须包含对等共享快照');
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const homeMod = await import(pathToFileURL(path.join(tmp, 'views', 'home.js')).href);
    const settingsMod = await import(pathToFileURL(path.join(tmp, 'views', 'settings.js')).href);
    installFakeDom();

    const state = fixtureState({
      peer: {
        sharing: { enabled: false, clients: [], localModels: [] },
        remoteSync: { enabled: false, intervalMinutes: 60, connections: [], sources: [] },
      },
    });
    const ctx = makeCtx(appMod, state);
    ctx.reload = async () => {};
    ctx.openPeerSettings = () => settingsMod.openPeerSettings(ctx);
    const modalHost = new FakeNode('div');
    modalHost.replaceChild = (next, current) => {
      const index = modalHost.childNodes.indexOf(current);
      if (index < 0) return current;
      current.parentNode = null;
      next.parentNode = modalHost;
      modalHost.childNodes[index] = next;
      return current;
    };
    ctx.openModal = (node) => {
      ctx._calls.push(['openModal', node]);
      modalHost.replaceChildren(node);
    };
    ctx.api.setSharing = async (patch) => {
      ctx._calls.push(['setSharing', patch]);
      state.peer.sharing = { ...state.peer.sharing, enabled: patch.enabled };
      return state.peer;
    };
    ctx.api.setRemoteSync = async (patch) => {
      ctx._calls.push(['setRemoteSync', patch]);
      state.peer.remoteSync = { ...state.peer.remoteSync, ...patch };
      return state.peer;
    };

    const root = new FakeNode('main');
    homeMod.renderHome(root, ctx, new FakeNode('div'));
    assert.match(root.allText(), /对等共享/, '主页首屏应有明显的对等共享入口');
    assert.match(root.allText(), /共享未开启/, '主页应显示共享开关状态');
    assert.match(root.allText(), /自动同步未开启/, '主页应显示远端同步状态');
    click(buttonsWithText(root, '配置对等共享')[0]);

    let modal = callsOf(ctx, 'openModal')[0]?.[1];
    assert.ok(modal, '主页入口应打开配置弹窗');
    assert.match(modal.className, /peer-settings-modal/);
    assert.match(modal.allText(), /Tailscale ACL/, '弹窗应保留网络与访问控制说明');
    assert.equal(modal.find('switch').length, 2, '弹窗应分别提供本机共享和远端自动同步开关');

    click(byAttr(modal, 'aria-label', '共享本机模型')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setSharing'), [['setSharing', { enabled: true, models: [] }]]);
    assert.equal(modalHost.children[0], modal, '操作后应保留同一个弹窗根节点');
    assert.match(modal.allText(), /共享本机模型已开启/, '操作后弹窗应刷新到最新共享状态');
    click(byAttr(modal, 'aria-label', '共享本机模型')[0]);
    await flush();
    assert.equal(callsOf(ctx, 'setSharing').length, 2, '刷新后的弹窗控件仍能继续操作');
    click(byAttr(modal, 'aria-label', '自动同步远端模型')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'setRemoteSync'), [['setRemoteSync', { enabled: true, intervalMinutes: 60 }]]);

    const settingsModView = new FakeNode('main');
    settingsMod.renderSettings(settingsModView, ctx, new FakeNode('div'));
    assert.match(settingsModView.allText(), /配置对等共享/, '设置页应提供通往同一配置弹窗的入口');
    assert.doesNotMatch(settingsModView.allText(), /生成新客户端授权|对端 Tailscale Serve 主机名/, '设置页不应再铺开完整配置表单');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('主页「下一步」：配置待生效时给的是重启 ChatGPT，而不是跳模型页', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const homeMod = await import(pathToFileURL(path.join(tmp, 'views', 'home.js')).href);
    installFakeDom();

    // 三段都通 + 配置待生效：黄条应出现，并且动作是真正的重启。
    const state = fixtureState({ relaunchNeeded: true });
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    homeMod.renderHome(root, ctx, new FakeNode('div'));

    const strip = root.find('home-next');
    assert.equal(strip.length, 1, '配置待生效时必须显示「下一步」提示条');
    assert.match(strip[0].allText(), /配置已修改，需要重启 ChatGPT 客户端后生效/, '提示条文案必须说明为什么要重启');

    const action = strip[0].find('home-next-action');
    assert.equal(action.length, 1, '提示条里应有唯一的操作按钮');
    assert.match(action[0].textContent, /重启 ChatGPT/, '按钮文案必须是重启 ChatGPT');
    assert.doesNotMatch(action[0].textContent, /去模型页/, '不能再把用户带去模型页');
    // 「需要重启」是阻断态：整条转红，主操作也切成红色语义按钮。
    const actionClass = String(action[0].className);
    assert.match(actionClass, /btn-danger/, '重启动作应使用红色阻断语义按钮');
    assert.doesNotMatch(actionClass, /btn-accent/, '重启动作不应再是蓝色强调按钮');
    assert.match(String(strip[0].className), /is-blocking/, '待重启提示条必须进入红色阻断态');
    assert.equal(strip[0].getAttribute('role'), 'alert', '阻断态提示条应以 alert 角色播报');

    // 第一次点击只进入确认态，绝不立刻杀进程。
    click(action[0]);
    await flush();
    assert.equal(callsOf(ctx, 'relaunchChatGpt').length, 0, '首次点击只能进入确认态，不能立刻重启');
    assert.match(action[0].textContent, /确认重启/, '首次点击后按钮应变为确认态');
    assert.equal(action[0].disabled, false, '确认态按钮仍可点击');

    // 第二次点击才真正重启，并且走 app.js 的全局流程（不重复实现 IPC）。
    click(action[0]);
    await flush();
    assert.equal(callsOf(ctx, 'relaunchChatGpt').length, 1, '确认后必须调用全局重启入口');
    assert.equal(callsOf(ctx, 'navigate').filter((call) => call[1] === 'models').length, 0, '重启动作不应跳转到模型页');
    assert.equal(state.relaunchNeeded, false, '重启成功后待重启状态应清除');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('主页「下一步」：重启失败时提示条保留、按钮恢复可点', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const homeMod = await import(pathToFileURL(path.join(tmp, 'views', 'home.js')).href);
    installFakeDom();

    const state = fixtureState({ relaunchNeeded: true });
    const ctx = makeCtx(appMod, state);
    ctx.relaunchChatGpt = async () => {
      ctx._calls.push(['relaunchChatGpt']);
      state.relaunchNeeded = true; // 失败：配置仍未生效
      return false;
    };
    const root = new FakeNode('main');
    homeMod.renderHome(root, ctx, new FakeNode('div'));
    const action = root.find('home-next-action')[0];

    click(action);
    await flush();
    click(action);
    await flush();

    assert.equal(callsOf(ctx, 'relaunchChatGpt').length, 1, '失败路径也必须只调用一次重启');
    assert.equal(action.disabled, false, '重启失败后按钮必须恢复可点');
    assert.match(action.textContent, /重启 ChatGPT/, '重启失败后按钮文案必须回到「重启 ChatGPT」');
    assert.equal(state.relaunchNeeded, true, '重启失败后配置仍未生效，必须保持待重启状态');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('侧栏重启成功后主页黄条也要立即消失', () => {
  const appSrc = read(APP);
  const start = appSrc.indexOf('function renderRelaunchState()');
  const end = appSrc.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, '应能定位待重启状态重绘函数');
  const body = appSrc.slice(start, end);
  // 主页首屏同样展示 relaunchNeeded：只重绘设置页会让黄条一直挂着，
  // 用户在侧栏重启成功后仍看到「配置已修改」。
  assert.match(body, /state\.view === 'home'/, '侧栏重启后必须重绘主页，黄条才会消失');
  assert.match(body, /renderCurrent\(/, '必须触发当前页面重绘');
});

test('提示条样式：普通提醒用琥珀，待重启用红色阻断态，双主题各有独立令牌', () => {
  const cssSrc = read(path.join(ROOT, 'src/renderer/styles.css'));
  const dark = cssSrc.slice(cssSrc.indexOf(':root {'), cssSrc.indexOf('html[data-theme="light"]'));
  const lightStart = cssSrc.indexOf('html[data-theme="light"]');
  const light = cssSrc.slice(lightStart, lightStart + 6000);
  for (const [label, block] of [['深色', dark], ['浅色', light]]) {
    for (const token of ['--notice-warn-bg', '--notice-warn-line', '--notice-warn-text', '--notice-warn-edge']) {
      assert.match(block, new RegExp(`${token}:`), `${label}主题必须定义 ${token}`);
    }
    for (const token of ['--notice-err-bg', '--notice-err-line', '--notice-err-text', '--notice-err-edge',
      '--notice-err-action-bg', '--notice-err-action-bg-hover', '--notice-err-action-text']) {
      assert.match(block, new RegExp(`${token}:`), `${label}主题必须定义 ${token}`);
    }
  }
  const strip = cssSrc.slice(cssSrc.indexOf('.home-next {'));
  assert.match(strip, /background:\s*var\(--notice-warn-bg\)/, '提示条应使用更实的琥珀底色');
  assert.match(strip, /border:\s*1px solid var\(--notice-warn-line\)/, '提示条应有更明显的描边');
  assert.match(strip, /box-shadow:\s*inset 3px 0 0 var\(--notice-warn-edge\)/, '提示条应有左侧强调边');
  assert.match(strip, /\.home-next-text \{[^}]*font-weight:\s*(?:5[5-9]0|6\d0)/, '提示文字必须加粗到能一眼看见');
  assert.match(strip, /\.home-next \.home-next-action \{[^}]*background:\s*var\(--notice-warn-bg-hover\)/, '普通提醒的按钮要有实心琥珀底');
  // 待重启是阻断态：整条红色，按钮实心红底白字，不能退回到琥珀色。
  assert.match(strip, /\.home-next\.is-blocking \{[^}]*background:\s*var\(--notice-err-bg\)/, '待重启提示条必须用红色底');
  assert.match(strip, /\.home-next\.is-blocking \{[^}]*border-color:\s*var\(--notice-err-line\)/, '待重启提示条必须有红色描边');
  assert.match(strip, /\.home-next\.is-blocking \.home-next-action \{[^}]*background:\s*var\(--notice-err-action-bg\)/, '待重启按钮必须是实心红底');
  assert.match(strip, /\.home-next\.is-blocking \.home-next-action \{[^}]*color:\s*var\(--notice-err-action-text\)/, '待重启按钮文字必须是白字');
});

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

test('提供商配置：便携加密文件点击和拖拽共用预览，覆盖必须再次确认', async () => {
  const tmp = copyRendererToTemp();
  const transfer = require(path.join(ROOT, 'src/core/provider-transfer.js'));
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const providersMod = await import(pathToFileURL(path.join(tmp, 'views/providers.js')).href);
    installFakeDom();
    const globalHandlers = new Map();
    window.addEventListener = (name, fn) => globalHandlers.set(name, fn);
    const sourceConfig = fixtureState();
    const payload = transfer.createExportPayload(sourceConfig);
    const secretStorage = {
      encrypt: (text) => Buffer.from(`test:${text}`, 'utf8'),
      decrypt: (bytes) => {
        const value = Buffer.from(bytes).toString('utf8');
        if (!value.startsWith('test:')) throw new Error('当前测试存储无法解密');
        return value.slice(5);
      },
      isAvailable: () => true,
    };
    const encrypted = transfer.encryptProviderConfigPortable(payload);
    const source = () => ({ fileName: 'test.gptplus-providers', bytes: new Uint8Array(encrypted) });
    const file = () => ({ name: 'test.gptplus-providers', size: encrypted.length,
      arrayBuffer: async () => new Uint8Array(encrypted).buffer });
    const state = fixtureState();
    const ctx = makeCtx(appMod, state);
    let modal = null;
    let onClose = null;
    let inspections = 0;
    let preparations = 0;
    let writes = 0;
    ctx.el = (...args) => {
      const node = appMod.el(...args);
      node.querySelectorAll = (selector) => selector === 'input[type="password"]'
        ? byAttr(node, 'type', 'password') : node.findTag(selector);
      node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
      return node;
    };
    ctx.openModal = (node, options = {}) => { onClose?.(); modal = node; onClose = options.onClose; };
    ctx.closeModal = () => { const cleanup = onClose; onClose = null; cleanup?.(); };
    ctx.api.pickProviderImportFile = async () => source();
    ctx.api.inspectProviderImport = async (input) => { inspections += 1; return transfer.inspectProviderConfigFile(input); };
    ctx.api.prepareProviderImport = async (input) => {
      preparations += 1;
      return { sessionId: 'test-session', preview: transfer.buildImportPreview(transfer.decryptProviderConfig({ ...input, secretStorage }), state.providers) };
    };
    ctx.api.cancelProviderImport = async () => ({});
    ctx.api.applyProviderImport = async (input) => {
      writes += 1;
      assert.equal(input.overwriteConfirmed, true);
      return { providers: state.providers, counts: { overwritten: 1, added: 1, skipped: 0 } };
    };
    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    providersMod.renderProviders(root, ctx, actions);
    let prevented = 0;
    const event = (files = []) => ({ dataTransfer: { types: ['Files'], files },
      preventDefault() { prevented += 1; }, stopPropagation() {} });
    const dropOverlay = document.body.find('provider-file-drop-overlay')[0];
    assert.ok(dropOverlay, '窗口级拖拽提示面板必须创建');
    globalHandlers.get('dragenter')(event());
    assert.equal(dropOverlay.hidden, false, '拖入文件时窗口必须显示接收态');
    globalHandlers.get('dragenter')(event());
    globalHandlers.get('dragleave')({ ...event(), relatedTarget: null });
    assert.equal(dropOverlay.hidden, false, '窗口内部切换目标时不能提前清除接收态');
    globalHandlers.get('dragleave')({ ...event(), relatedTarget: null });
    assert.equal(dropOverlay.hidden, true, '拖出窗口后必须清除接收态');
    globalHandlers.get('dragenter')(event());
    prevented = 0;
    globalHandlers.get('dragover')(event());
    assert.equal(prevented, 1, '窗口级拖拽保护必须识别 Files 类型并阻止浏览器默认打开');
    globalHandlers.get('dragend')(event());
    assert.equal(dropOverlay.hidden, true, '拖拽取消后必须清除接收态');
    globalHandlers.get('dragenter')(event());
    globalHandlers.get('drop')(event());
    assert.equal(dropOverlay.hidden, true, '无文件放下或取消时必须清除接收态');

    for (const mode of ['pick', 'area-drop', 'dialog-drop', 'window-drop']) {
      if (mode === 'area-drop') {
        globalHandlers.get('dragenter')(event());
        root.find('provider-transfer-zone')[0].listeners.drop[0](event([file()]));
        assert.equal(dropOverlay.hidden, true, '主页拖放区放下文件后必须清除窗口接收态');
      }
      else if (mode === 'window-drop') {
        globalHandlers.get('dragenter')(event());
        assert.equal(dropOverlay.hidden, false);
        globalHandlers.get('drop')(event([file()]));
        assert.equal(dropOverlay.hidden, true, '放下文件后必须清除接收态');
      }
      else {
        click(buttonsWithText(actions, '导入配置')[0]);
        if (mode === 'pick') click(buttonsWithText(modal, '选择文件')[0]);
        else {
          const zone = modal.find('provider-import-dropzone')[0];
          globalHandlers.get('dragenter')(event());
          zone.listeners.dragenter[0](event());
          assert.equal(zone.classList.contains('is-dragover'), true);
          zone.listeners.dragleave[0]({ relatedTarget: null });
          assert.equal(zone.classList.contains('is-dragover'), false);
          zone.listeners.drop[0](event([file()]));
          assert.equal(dropOverlay.hidden, true, '弹窗拖放区放下文件后必须清除窗口接收态');
        }
      }
      await flush();
      assert.equal(writes, mode === 'pick' ? 0 : mode === 'area-drop' ? 1 : mode === 'dialog-drop' ? 2 : 3);
      assert.match(modal.allText(), /GPT-6.1 Sol/);
      assert.doesNotMatch(modal.allText(), /解密密码|导出时设置的密码/);
      assert.equal(byAttr(modal, 'type', 'password').length, 0, '配置导入不得要求文件密码');
      assert.doesNotMatch(modal.allText(), /sk-super-secret-1234|https:\/\/mhapi\.example/);
      const picker = modal.find('provider-import-action')[0];
      picker.value = 'overwrite';
      picker.listeners.change[0]({ target: picker });
      const beforeWrites = writes;
      click(buttonsWithText(modal, '确认导入')[0]);
      await flush();
      assert.equal(writes, beforeWrites, '预览页确认后不能直接覆盖');
      assert.match(modal.allText(), /确定覆盖 1 个同名提供商/);
      click(buttonsWithText(modal, '确认覆盖并导入')[0]);
      await flush();
      assert.equal(writes, beforeWrites + 1);
    }
    assert.equal(inspections, 4);
    assert.equal(preparations, 4);

    let reads = 0;
    const cases = [
      [{ name: 'bad.txt', size: 1 }, /请选择 .*加密配置文件/],
      [{ name: 'empty.gptplus-providers', size: 0 }, /文件为空/],
      [{ name: 'huge.gptplus-providers', size: 2 * 1024 * 1024 + 1 }, /大小限制/],
    ];
    for (const [invalid, message] of cases) {
      click(buttonsWithText(actions, '导入配置')[0]);
      modal.find('provider-import-dropzone')[0].listeners.drop[0](event([{ ...invalid,
        arrayBuffer: async () => { reads += 1; return new ArrayBuffer(1); } }]));
      await flush();
      assert.match(modal.allText(), message);
    }
    assert.equal(reads, 0, '非法类型、空文件和超大文件必须在读取前拒绝');
    click(buttonsWithText(actions, '导入配置')[0]);
    modal.find('provider-import-dropzone')[0].listeners.drop[0](event([file(), file()]));
    await flush();
    assert.match(modal.allText(), /一次只能导入一个/);
    modal.find('provider-import-dropzone')[0].listeners.drop[0](event([{
      name: 'broken.gptplus-providers', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }]));
    await flush();
    assert.match(modal.allText(), /配置文件不是有效的 JSON 格式/);
    assert.equal(writes, 4);
    ctx.closeModal();

    let exported = null;
    ctx.api.exportProviderConfig = async (input) => {
      exported = input;
      assert.equal('password' in input, false, '导出接口不应再传文件密码');
      transfer.encryptProviderConfigPortable(transfer.createExportPayload(state, input.providerIds));
      return { count: input.providerIds?.length || state.providers.length };
    };
    click(buttonsWithText(actions, '导出全部')[0]);
    assert.equal(byAttr(modal, 'type', 'password').length, 0, '导出弹窗不得出现密码输入框');
    const range = modal.find('provider-transfer-list')[0].findTag('input')[1];
    range.checked = false;
    range.listeners.change[0]({ target: range });
    click(buttonsWithText(modal, '导出配置文件')[0]);
    await flush();
    assert.deepEqual(exported.providerIds, ['p_demo0001']);
    let copied = null;
    ctx.copyText = async (value) => { copied = value; };
    click(byAttr(root, 'title', '复制 API Key')[0]);
    assert.equal(copied, state.providers[0].apiKey, '用户主动复制 API Key 的现有功能必须保留');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('开机自启动目标支持双向切换，关闭再开启时保留所选目标', async () => {
  const tmp = copyRendererToTemp();
  try {
    installFakeDom();
    const nodes = new Map([...read(HTML).matchAll(/\bid="([^"]+)"/g)]
      .map((match) => [match[1], new FakeNode('div')]));
    document.getElementById = (id) => nodes.get(id) || null;
    let saved = { supported: true, enabled: true, target: 'gptplus' };
    const calls = [];
    window.gptplus = {
      ...makeApi(fixtureState(), calls),
      getStartup: async () => ({ ...saved }),
      setStartup: async (patch) => {
        calls.push(['setStartup', { ...patch }]);
        saved = { ...saved, ...patch };
        return { ...saved };
      },
    };
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    await flush();
    assert.equal(document.documentElement.dataset.ready, '1', '真实启动流程必须完成');
    const sidebar = nodes.get('sidebar-actions');
    const option = (target) => sidebar.find('sidebar-startup-option')
      .find((node) => node.dataset.startupTarget === target);
    const toggle = () => sidebar.find('sidebar-startup-toggle')[0];

    for (const target of ['both', 'gptplus', 'both']) {
      assert.equal(option(target).disabled, false, '目标选项必须可以点击');
      click(option(target));
      await flush();
      assert.deepEqual(appMod.state.startup, { supported: true, enabled: true, target }, '点击后必须切换到所选目标');
      assert.equal(option(target).getAttribute('aria-checked'), 'true', '所选目标必须同步到界面');
      assert.equal(option(target === 'both' ? 'gptplus' : 'both').getAttribute('aria-checked'), 'false');
      assert.deepEqual(calls.at(-1), ['setStartup', { enabled: true, target }], '必须将所选目标交给主进程保存');
    }

    for (const enabled of [false, true]) {
      click(toggle());
      await flush();
      assert.deepEqual(appMod.state.startup, { supported: true, enabled, target: 'both' }, '切换总开关不能重置启动目标');
      assert.deepEqual(calls.at(-1), ['setStartup', { enabled, target: 'both' }]);
      assert.equal(option('gptplus').disabled, !enabled);
      assert.equal(option('both').disabled, !enabled);
    }

    const count = calls.length;
    click(option('both'));
    await flush();
    assert.equal(calls.length, count, '重复点击当前目标不应再次保存');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('重启 ChatGPT：确认后立即撤下红色警示，失败时才恢复', async () => {
  const tmp = copyRendererToTemp();
  try {
    installFakeDom();
    const nodes = new Map([...read(HTML).matchAll(/\bid="([^"]+)"/g)]
      .map((match) => [match[1], new FakeNode('div')]));
    document.getElementById = (id) => nodes.get(id) || null;
    const calls = [];
    let resolveRelaunch = null;
    let onStatus = null;
    window.gptplus = {
      ...makeApi(fixtureState(), calls),
      onStatus: (cb) => {
        onStatus = cb;
        return () => {};
      },
      relaunchChatGpt: () => {
        calls.push(['relaunchChatGpt']);
        return new Promise((resolve) => { resolveRelaunch = resolve; });
      },
    };
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    await flush();
    assert.equal(document.documentElement.dataset.ready, '1', '真实启动流程必须完成');

    const sidebar = nodes.get('sidebar-actions');
    const button = () => sidebar.find('sidebar-relaunch')[0];
    const isDanger = () => String(button().className).split(/\s+/).includes('btn-danger');
    const buttonText = () => button().textContent;
    let writeAt = Date.now() - 1000;
    const simulateWrite = async () => {
      writeAt += 1000;
      onStatus({
        ...fixtureState().status,
        codex: { ...fixtureState().status.codex, lastWrite: { at: writeAt, ok: true } },
      });
      await flush();
    };

    await simulateWrite();
    assert.equal(isDanger(), true, '有未生效配置时按钮必须是红色');
    assert.match(buttonText(), /配置待生效/);

    click(button());
    await flush();
    assert.match(buttonText(), /确认重启/, '第一次点击只进入确认态');
    click(button());
    await flush();
    assert.equal(calls.filter((call) => call[0] === 'relaunchChatGpt').length, 1, '确认后必须调用重启 API');
    assert.equal(isDanger(), false, '确认后应立即撤下红色，而不是等主进程结束进程');
    assert.match(buttonText(), /正在重启/, '重启期间应显示进行中状态');
    assert.equal(button().disabled, true, '重启期间按钮必须禁用，避免重复点击');

    // 旧写入的状态广播可能比 IPC 回复更晚到达：不能让它把红色又标回来。
    onStatus({
      ...fixtureState().status,
      codex: { ...fixtureState().status.codex, lastWrite: { at: writeAt, ok: true } },
    });
    await flush();
    assert.equal(isDanger(), false, '迟到的旧状态广播不应重新亮起红色警示');
    assert.match(buttonText(), /正在重启/);

    resolveRelaunch({ ok: true });
    await flush();
    assert.equal(appMod.state.relaunchNeeded, false);
    assert.equal(isDanger(), false);
    assert.match(buttonText(), /重启 ChatGPT 客户端/, '成功后恢复为普通重启入口');

    // 失败路径：红色警示必须回来，用户才知道配置仍未生效。
    await simulateWrite();
    click(button());
    await flush();
    click(button());
    await flush();
    resolveRelaunch({ ok: false, error: 'ChatGPT 没有退出' });
    await flush();
    assert.equal(appMod.state.relaunchNeeded, true, '重启失败后必须恢复待重启警示');
    assert.equal(isDanger(), true);
    assert.equal(button().disabled, false);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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
    const testModal = ctx._calls.find((call) => call[0] === 'openModal')?.[1];
    assert.ok(testModal, '已有模型时应先打开模型选择与测试结果弹窗');
    assert.match(testModal.allText(), /选择/, '测试弹窗应允许选择模型');
    assert.match(testModal.allText(), /GPT-6\.1 Sol/, '测试弹窗应显示模型名称');
    click(buttonsWithText(testModal, '开始测试')[0]);
    await flush();
    assert.deepEqual(callsOf(ctx, 'testProviderModels'), [[
      'testProviderModels', { providerId: 'p_demo0001', modelIds: ['gpt-6.1-sol'] },
    ]], '默认只选已启用模型，并将所选模型逐项提交');
    assert.match(testModal.allText(), /通过 · HTTP 200/, '成功结果应显示状态码');
    assert.match(testModal.allText(), /12ms/, '成功结果应显示单模型延时');
    const probeToast = ctx._calls.find((c) => c[0] === 'toast' && String(c[2]).includes('模型测试：1/1 通过'));
    assert.ok(probeToast, '测试完成应给出模型通过数量');

    // --- 删除（弹窗二次确认）---
    click(byAttr(root, 'title', '删除该提供商')[0]);
    const deleteModal = ctx._calls.filter((c) => c[0] === 'openModal').pop()[1];
    assert.ok(deleteModal, '点删除卡片按钮应弹出确认弹窗，而不是在卡片内联展开');
    assert.match(deleteModal.allText(), /删除提供商/, '弹窗标题应写明删除提供商');
    assert.match(deleteModal.allText(), /梦幻API/, '弹窗应显示要删除的提供商名');
    assert.match(deleteModal.allText(), /2 个模型会一起删除/, '弹窗应说明连带删除的模型数量');
    assert.equal(callsOf(ctx, 'deleteProvider').length, 0, '弹窗出现时还不能真的删除');
    click(buttonsWithText(deleteModal, '取消')[0]);
    assert.equal(callsOf(ctx, 'deleteProvider').length, 0, '取消后不应删除');

    click(byAttr(root, 'title', '删除该提供商')[0]);
    const confirmModal = ctx._calls.filter((c) => c[0] === 'openModal').pop()[1];
    click(buttonsWithText(confirmModal, '删除提供商')[0]);
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
    // 拉取成功后的收尾提示同样要用到表单引用（refs.note）：漏传会让成功路径被 catch 成红色报错
    const pullErrors = formCtx._calls.filter(
      (c) => (c[0] === 'toast' && c[1] === 'error') || c[0] === 'toastError',
    );
    assert.deepEqual(pullErrors, [], '拉取成功后不应再弹出任何错误提示');
    assert.match(modal.allText(), /已完成手动 \/models 检查/, '成功提示应写进表单顶部');
    assert.match(modal.allText(), /新增/, '新模型应标记为新增');
    assert.match(modal.allText(), /默认停用/, '新模型应默认停用');
    for (const row of modal.find('mrow')) {
      const id = row.findTag('input')[0]?.value;
      if (id === 'gpt-6.1-sol' || id === 'deepseek-v4') {
        assert.equal(row.findTag('input')[2].checked, false, '新发现的上游模型必须默认禁用');
      }
    }
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

test('模型页：任意模型都能从行内删除，且要经过二次确认', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const modelsMod = await import(pathToFileURL(path.join(tmp, 'views', 'models.js')).href);
    installFakeDom();

    const state = fixtureState();
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    modelsMod.renderModels(root, ctx, new FakeNode('div'));

    const deleteButtons = root.find('model-delete');
    assert.equal(deleteButtons.length, 3, '每个模型行都必须有删除入口，包括已停用的模型');
    assert.equal(
      deleteButtons.some((btn) => btn.disabled),
      false,
      '正常状态下删除按钮不能被禁用',
    );

    // 第一次点击只弹确认框，不直接删
    click(deleteButtons[0]);
    const modalCall = callsOf(ctx, 'openModal')[0];
    assert.ok(modalCall, '点击删除应先打开确认弹窗');
    const modalText = modalCall[1].allText();
    assert.match(modalText, /删除模型/, '弹窗标题要明确是删除模型');
    assert.match(modalText, /其它模型和提供商设置不受影响/, '要说明影响范围');
    assert.equal(callsOf(ctx, 'deleteModel').length, 0, '未确认前不得调用删除 API');

    // 取消不产生任何删除
    click(buttonsWithText(modalCall[1], '取消')[0]);
    assert.equal(callsOf(ctx, 'deleteModel').length, 0, '取消后不应删除');

    // 确认后才调用 API
    click(deleteButtons[1]);
    const confirmModal = callsOf(ctx, 'openModal')[1][1];
    click(buttonsWithText(confirmModal, '删除模型')[0]);
    await flush();
    assert.deepEqual(
      callsOf(ctx, 'deleteModel'),
      [['deleteModel', { providerId: 'p_demo0001', modelId: 'claude-x' }]],
      '确认后应按 providerId + modelId 精确删除',
    );
    assert.ok(
      ctx._calls.some((c) => c[0] === 'toast' && String(c[2]).includes('已删除模型')),
      '删除成功要有提示',
    );

    // 删除默认模型时，弹窗要说明默认值会转移
    const defaultCtx = makeCtx(appMod, fixtureState());
    const defaultRoot = new FakeNode('main');
    modelsMod.renderModels(defaultRoot, defaultCtx, new FakeNode('div'));
    click(defaultRoot.find('model-delete')[0]);
    assert.match(
      callsOf(defaultCtx, 'openModal')[0][1].allText(),
      /当前是默认模型/,
      '删除默认模型要提前说明默认值会落到别的模型',
    );

    // 最后一个启用模型：删除后注入会被关闭，弹窗必须提前说明
    const onlyOne = fixtureState({
      models: [
        { slug: 'p_demo0002__qwen3', providerId: 'p_demo0002', providerName: '本地 Ollama', modelId: 'qwen3', label: 'Qwen3', enabled: true, reasoning: false },
      ],
      inject: { enabled: true, catalogPath: 'C:\\Users\\ailuo\\.gptplus\\model-catalog.json', defaultModel: 'p_demo0002__qwen3' },
      status: {
        ...fixtureState().status,
        inject: { enabled: true, catalogPath: 'C:\\Users\\ailuo\\.gptplus\\model-catalog.json', defaultModel: 'p_demo0002__qwen3' },
      },
    });
    const lastCtx = makeCtx(appMod, onlyOne);
    const lastRoot = new FakeNode('main');
    modelsMod.renderModels(lastRoot, lastCtx, new FakeNode('div'));
    click(lastRoot.find('model-delete')[0]);
    assert.match(
      callsOf(lastCtx, 'openModal')[0][1].allText(),
      /最后一个启用模型/,
      '删除最后一个启用模型必须提示注入会被关闭',
    );
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

test('设置页：选择回退版本后确认按钮立即显示', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const settingsMod = await import(pathToFileURL(path.join(tmp, 'views', 'settings.js')).href);
    installFakeDom();

    const state = fixtureState({
      status: { ...fixtureState().status, appVersion: '0.2.2' },
      update: {
        enabled: true,
        status: 'idle',
        currentVersion: '0.2.2',
        rollbackReleases: [{ version: '0.2.1', name: 'v0.2.1' }],
      },
    });
    const ctx = makeCtx(appMod, state);
    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    const renders = [];
    ctx.renderCurrent = (force) => {
      renders.push(force);
      // 模拟 app.js：焦点还在 select 时，非强制重绘会被焦点保护跳过。
      if (force) settingsMod.renderSettings(root, ctx, actions);
    };

    settingsMod.renderSettings(root, ctx, actions);
    const select = byAttr(root, 'aria-label', '选择回退版本')[0];
    assert.ok(select, '应有回退版本选择框');
    select.value = '0.2.1';
    for (const handler of select.listeners.change || []) handler({ target: select });

    assert.deepEqual(renders, [true], '选择版本后必须强制重绘，不能等失焦再刷新');
    assert.equal(buttonsWithText(root, '确认回退到 v0.2.1').length, 1, '选择版本后确认回退按钮应立即显示');
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

test('usage badge counts all final requests and follows the overview range', async () => {
  const tmp = copyRendererToTemp();
  try {
    const app = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usage = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();
    const now = Date.now();
    const request = (patch) => ({ at: now, model: 'demo', status: 200, final: true, ...patch });
    app.state.usage = [
      request({ tokens: { total_tokens: 10 } }),
      request({ status: 502 }),
      request({ status: 499, final: false, usageRecord: true }),
      request({ at: now - 3 * 86400000 }),
      request({ at: now - 10 * 86400000 }),
      request({ status: 0 }),
      request({ final: false, msg: '上游返回 HTTP 200', tokens: {} }),
    ];
    app.state.logs = [request({})];
    const badge = new FakeNode('span');
    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    const ctx = makeCtx(app, app.state);
    ctx.renderCurrent = () => {
      usage.renderUsage(root, ctx, actions);
      app.updateUsageBadge(badge);
    };
    ctx.renderCurrent();
    assert.equal(badge.textContent, '5');
    assert.match(root.allText(), /共 5 次请求/);
    for (const [range, expected] of [['24h', 3], ['7d', 4], ['all', 5]]) {
      const select = root.findTag('select')[0];
      select.value = range;
      for (const handler of select.listeners.change) handler({ target: select });
      assert.equal(badge.textContent, String(expected));
      assert.match(root.allText(), new RegExp(`共 ${expected} 次请求`));
    }
    app.state.usage = [];
    app.state.logs = [request({ status: 502 }), request({ tokens: {} }), request({ status: 0 })];
    ctx.renderCurrent();
    assert.equal(badge.textContent, '2', 'legacy logs use the same final-result rules');
    app.state.logs = [];
    ctx.renderCurrent();
    assert.equal(badge.textContent, '0');
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

test('使用量页：提供全部清空与保留趋势的细数据清空入口', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const usageMod = await import(pathToFileURL(path.join(tmp, 'views', 'usage.js')).href);
    installFakeDom();
    const state = fixtureState({
      logs: [],
      usage: [],
      usageTrend: [{ day: '2026-10-17', tokens: 13, requests: 1 }],
    });
    const calls = [];
    const ctx = makeCtx(appMod, state, calls);
    ctx.api.clearUsage = async (patch) => {
      calls.push(['clearUsage', patch]);
      return { mode: patch.mode, trend: state.usageTrend };
    };
    ctx.reload = async (scope) => calls.push(['reload', scope]);
    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    usageMod.renderUsage(root, ctx, actions);

    assert.match(actions.allText(), /清空细数据/);
    assert.match(actions.allText(), /全部清空/);
    const detailButton = actions.children.find((node) => node.textContent.includes('清空细数据'));
    detailButton.listeners.click[0]();
    const modal = calls.find((entry) => entry[0] === 'openModal')[1];
    assert.match(modal.allText(), /只保留 Token 使用趋势/);
    const confirm = modal.findTag('button').find((node) => node.textContent.includes('清空细数据'));
    confirm.listeners.click[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.find((entry) => entry[0] === 'clearUsage')[1], { mode: 'details' });
    assert.deepEqual(state.usageTrend, [{ day: '2026-10-17', tokens: 13, requests: 1 }]);
    assert.ok(calls.some((entry) => entry[0] === 'reload' && entry[1] === 'usage'));
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

test('插件市场：展示两个内置插件并支持配置、启停与卸载入口', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const pluginsMod = await import(pathToFileURL(path.join(tmp, 'views', 'plugins.js')).href);
    installFakeDom();
    const state = fixtureState({
      view: 'plugins',
      plugins: [
        { id: 'weixin', name: '微信连接', version: '1.0.0', category: '连接', icon: 'wechat', description: '微信描述', detail: '微信详情', builtIn: true, configurable: true, installed: true, enabled: true, active: true, config: {} },
        { id: 'usage-statusline', name: 'ChatGPT 用量信息栏', version: '1.0.0', category: '效率', icon: 'activity', description: '用量描述', detail: '用量详情', builtIn: true, configurable: true, installed: true, enabled: true, active: true, config: { metrics: { speed: true, cache: true, context: true } } },
      ],
    });
    const calls = [];
    const ctx = makeCtx(appMod, state, calls);
    ctx.api.setPluginEnabled = async (patch) => {
      calls.push(['setPluginEnabled', patch]);
      const plugin = state.plugins.find((item) => item.id === patch.id);
      const next = { ...plugin, enabled: patch.enabled, active: patch.enabled };
      state.plugins = state.plugins.map((item) => item.id === patch.id ? next : item);
      return next;
    };
    ctx.api.uninstallPlugin = async (id) => {
      calls.push(['uninstallPlugin', id]);
      const plugin = state.plugins.find((item) => item.id === id);
      const next = { ...plugin, installed: false, enabled: false, active: false };
      state.plugins = state.plugins.map((item) => item.id === id ? next : item);
      return next;
    };
    ctx.api.installPlugin = async (id) => {
      calls.push(['installPlugin', id]);
      const plugin = state.plugins.find((item) => item.id === id);
      const next = { ...plugin, installed: true, enabled: false, active: false };
      state.plugins = state.plugins.map((item) => item.id === id ? next : item);
      return next;
    };
    ctx.api.setPluginConfig = async (patch) => {
      calls.push(['setPluginConfig', patch]);
      const plugin = state.plugins.find((item) => item.id === patch.id);
      const next = { ...plugin, config: patch.config };
      state.plugins = state.plugins.map((item) => item.id === patch.id ? next : item);
      return next;
    };

    const root = new FakeNode('main');
    pluginsMod.renderPlugins(root, ctx, new FakeNode('div'));
    assert.match(root.allText(), /微信连接/);
    assert.match(root.allText(), /ChatGPT 用量信息栏/);
    assert.match(root.allText(), /已启用/);
    assert.match(root.allText(), /配置/);
    assert.match(root.allText(), /卸载/);

    const configButtons = root.findTag('button').filter((node) => node.textContent.includes('配置'));
    const usageConfig = configButtons.at(-1);
    assert.ok(usageConfig, '用量插件应有配置入口');
    usageConfig.listeners.click[0]();
    const modal = calls.find((entry) => entry[0] === 'openModal')?.[1];
    assert.ok(modal, '配置入口应打开弹窗');
    assert.match(modal.allText(), /生成速度/);
    assert.match(modal.allText(), /缓存命中率/);
    assert.match(modal.allText(), /上下文占用/);

    const uninstall = root.findTag('button').find((node) => node.textContent.includes('卸载'));
    assert.ok(uninstall, '已安装插件应有卸载入口');
    await uninstall.listeners.click[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.some((entry) => entry[0] === 'uninstallPlugin' && entry[1] === 'weixin'));

    state.plugins = state.plugins.map((plugin) => plugin.id === 'weixin'
      ? { ...plugin, installed: false, enabled: false, active: false }
      : plugin);
    const root2 = new FakeNode('main');
    pluginsMod.renderPlugins(root2, ctx, new FakeNode('div'));
    const install = root2.findTag('button').find((node) => node.textContent.includes('安装'));
    assert.ok(install, '未安装插件应有安装入口');
    await install.listeners.click[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.some((entry) => entry[0] === 'installPlugin' && entry[1] === 'weixin'));
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('微信连接页：状态、连接设置与扫码入口渲染完整', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const weixinMod = await import(pathToFileURL(path.join(tmp, 'views', 'weixin.js')).href);
    installFakeDom();
    const state = fixtureState({
      view: 'weixin',
      weixin: {
        enabled: false,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'secret-token',
        accountId: 'bot@im.bot',
        allowFrom: 'owner@im.wechat',
        routeTag: '',
        workDir: 'C:\work',
        model: '',
        sandbox: 'read-only',
        codexPath: '',
        status: {
          state: 'stopped', message: '微信连接未启动。', accountId: 'bot@im.bot',
          lastPeerId: '', lastMessageAtMs: 0, processedMessages: 0, hasToken: true,
        },
      },
    });
    const ctx = makeCtx(appMod, state);
    ctx.api.getWeixinStatus = async () => state.weixin.status;
    const root = new FakeNode('main');
    const actions = new FakeNode('div');
    weixinMod.renderWeixin(root, ctx, actions);
    const text = root.allText();
    assert.match(text, /个人微信连接/, '页面应有个人微信连接状态卡');
    assert.match(text, /连接设置/, '页面应有连接设置卡');
    assert.match(text, /每个微信联系人会映射到独立的 Codex 会话/, '必须说明联系人独立会话');
    assert.match(text, /iLink API 地址/, '账号区应有 iLink API 地址');
    assert.match(text, /允许的微信用户 ID/, '账号区应有联系人白名单');
    assert.match(text, /SKRouteTag/, '账号区应有路由标签');
    assert.match(text, /重新登录/, '已有 token 时按钮应为重新登录');
    assert.match(text, /已处理消息/, '状态卡应有已处理消息统计');
    assert.match(text, /最近联系人/, '状态卡应有最近联系人统计');
    assert.match(text, /发送「帮助」查看指令/, '页面应提示微信指令入口');
    assert.match(text, /发送「新对话」清空/, '页面应提示新对话指令');
    assert.match(text, /图片可直接发给 Codex/, '页面应提示图片输入');
    assert.match(text, /图片会自动回传/, '页面应提示图片回传');
    assert.match(actions.allText(), /刷新状态/, '顶部应有状态刷新入口');
    const passwordInput = root.findTag('input').find((n) => n.attributes.type === 'password');
    assert.ok(passwordInput, '登录凭据默认应为密码框');
    assert.equal(passwordInput.value, 'secret-token', '凭据应可编辑');
    assert.equal(text.includes('secret-token'), false, '凭据明文不能出现在页面文本里');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('微信连接页：点重新登录会打开二维码弹窗并可关闭', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const weixinMod = await import(pathToFileURL(path.join(tmp, 'views', 'weixin.js')).href);
    installFakeDom();
    const state = fixtureState({
      view: 'weixin',
      weixin: {
        enabled: false,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'secret-token',
        accountId: 'bot@im.bot',
        allowFrom: '',
        routeTag: '',
        workDir: 'C:\work',
        model: '',
        sandbox: 'read-only',
        codexPath: '',
        status: {
          state: 'stopped', message: '微信连接未启动。', accountId: 'bot@im.bot',
          lastPeerId: '', lastMessageAtMs: 0, processedMessages: 0, hasToken: true,
        },
      },
    });
    const ctx = makeCtx(appMod, state);
    ctx.api.startWeixinQr = async (patch) => {
      ctx._calls.push(['startWeixinQr', patch]);
      return {
        qrStatus: 'wait',
        qrContent: 'https://example.test/login',
        qrImage: 'data:image/png;base64,AAA',
        accountId: '',
        linkedUserId: '',
        hasToken: false,
      };
    };
    ctx.api.getWeixinQrStatus = async () => ({ qrStatus: 'wait' });
    const root = new FakeNode('main');
    weixinMod.renderWeixin(root, ctx, new FakeNode('div'));
    const loginButton = root.findTag('button').find((n) => n.textContent.includes('重新登录'));
    assert.ok(loginButton, '状态卡应有重新登录按钮');
    for (const handler of loginButton.listeners.click || []) await handler({ target: loginButton });
    const startCall = ctx._calls.find((c) => c[0] === 'startWeixinQr');
    assert.ok(startCall, '点击重新登录应请求二维码');
    const modalCall = ctx._calls.find((c) => c[0] === 'openModal');
    assert.ok(modalCall, '拿到二维码后应打开弹窗');
    const modal = modalCall[1];
    assert.match(modal.allText(), /微信扫码登录/, '弹窗标题');
    assert.match(modal.allText(), /等待扫码/, '弹窗状态');
    const img = modal.findTag('img')[0];
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAA');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('微信连接页：启动/停止会调用主进程并刷新状态卡', async () => {
  const tmp = copyRendererToTemp();
  try {
    const appMod = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const weixinMod = await import(pathToFileURL(path.join(tmp, 'views', 'weixin.js')).href);
    installFakeDom();
    const state = fixtureState({
      view: 'weixin',
      weixin: {
        enabled: false,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'secret-token',
        accountId: 'bot@im.bot',
        allowFrom: '',
        routeTag: '',
        workDir: 'C:\work',
        model: '',
        sandbox: 'read-only',
        codexPath: '',
        status: {
          state: 'stopped', message: '微信连接未启动。', accountId: 'bot@im.bot',
          lastPeerId: '', lastMessageAtMs: 0, processedMessages: 0, hasToken: true,
        },
      },
    });
    const ctx = makeCtx(appMod, state);
    const runningStatus = {
      state: 'running', message: '微信连接正在运行。', accountId: 'bot@im.bot',
      lastPeerId: 'owner@im.wechat', lastMessageAtMs: Date.now(), processedMessages: 3, hasToken: true,
    };
    ctx.api.startWeixin = async () => {
      ctx._calls.push(['startWeixin']);
      state.weixin = { ...state.weixin, status: runningStatus };
      return { ok: true, status: runningStatus };
    };
    ctx.api.stopWeixin = async () => {
      ctx._calls.push(['stopWeixin']);
      const stopped = { ...runningStatus, state: 'stopped', message: '微信连接已停止。' };
      state.weixin = { ...state.weixin, status: stopped };
      return { ok: true, status: stopped };
    };
    const root = new FakeNode('main');
    weixinMod.renderWeixin(root, ctx, new FakeNode('div'));
    const startButton = root.findTag('button').find((n) => n.textContent.includes('启动'));
    assert.ok(startButton, '应有启动按钮');
    for (const handler of startButton.listeners.click || []) await handler({ target: startButton });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ctx._calls.some((c) => c[0] === 'startWeixin'), '点击启动应调用 startWeixin');
    assert.match(root.allText(), /运行中/, '状态卡应刷新为运行中');
    assert.match(root.allText(), /owner@im\.wechat/, '状态卡应显示最近联系人');
    const stopButton = root.findTag('button').find((n) => n.textContent.includes('停止'));
    assert.ok(stopButton, '运行中应显示停止按钮');
    for (const handler of stopButton.listeners.click || []) await handler({ target: stopButton });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ctx._calls.some((c) => c[0] === 'stopWeixin'), '点击停止应调用 stopWeixin');
    assert.match(root.allText(), /已停止/, '状态卡应刷新为已停止');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.navigator;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
