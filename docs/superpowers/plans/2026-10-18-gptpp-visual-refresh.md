# gpt++ 前端视觉改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 gpt++ 业务行为的前提下，把现有 Electron 渲染层提升为层级清楚、状态明确、双主题一致、可长期使用的精密工作台界面。

**Architecture:** 先建立视觉基线和自动化审计，再更新设计令牌与共享组件，随后按“提供商与模型 → 使用量 → 设置 → 浮层与动效”的顺序分页改造。保留现有 `el()`、`icon()`、原生 IPC 和 CSP 架构，不引入新框架。

**Tech Stack:** Electron 38、原生 HTML/CSS/ES Modules、Node `node:test`、Electron `capturePage()`、Windows PowerShell 验证脚本。

**Spec:** `docs/superpowers/specs/2026-10-18-gptpp-visual-refresh-design.md`

## Global Constraints

- 只改视觉、布局、组件结构与视觉反馈；不改 IPC、网关、存储、目录注入和模型路由契约。
- 保留本地资源策略：不得新增远程字体、CDN、外部图片或未授权的网络请求。
- 用户字符串不得拼进 `innerHTML`；只允许现有静态图标表和 `el()` 收口写入。
- API Key 默认打码，任何截图、日志和测试输出不得包含明文 Key。
- 卡片圆角不超过 `8px`；阴影只用于浮层、弹窗、Toast、日志抽屉和明确抬升的工具面板。
- 常规文字保留 `letter-spacing: 0`，不使用视口宽度缩放字号。
- 所有视觉任务同时检查深色与浅色主题。
- 必测窗口：`940x620` 最小、`1180x780` 默认、`1440x900` 宽屏。
- 所有主要操作保持键盘可达，支持 `prefers-reduced-motion: reduce`。
- 改动前检查 `git status --short` 和 `git diff`；工作树已有修改默认视为用户改动，不覆盖、不回退。
- 每次提交只包含该任务相关文件；未经用户明确要求不提交、不推送。

---

## 文件结构与职责

| 路径 | 责任 |
|---|---|
| `src/renderer/index.html` | 应用壳、导航、状态栏、浮层挂载点 |
| `src/renderer/styles.css` | 设计 token、基础组件、页面样式、主题、动效 |
| `src/renderer/app.js` | 全局 chrome、状态栏、侧栏动作、弹窗宿、日志与动态样式 |
| `src/renderer/views/providers.js` | 提供商页与编辑表单 |
| `src/renderer/views/models.js` | 连接轨道、默认模型、模型表 |
| `src/renderer/views/usage.js` | 统计、趋势、使用量表 |
| `src/renderer/views/settings.js` | 更新、上下文、网关、注入与路径设置 |
| `test/renderer.test.js` | 渲染层安全、契约、样式变量与 DOM 冒烟测试 |
| `tools/smoke.cjs` | 新建的 Electron 视觉基线采集与截图审计命令 |
| `docs/superpowers/specs/2026-10-18-gptpp-visual-refresh-design.md` | 视觉目标和验收口径 |
| `docs/visual-regression/` | 基线截图、审计输出、差异图；不作为运行时资源 |

不在本计划内新增：

- React、Vue、Svelte、Tailwind 或组件框架。
- 远程字体和图标包。
- 新 IPC、新持久化字段或新业务状态。
- 移动端布局。

## 实施前基线

在开始任何样式编辑前，确认：

1. 当前默认窗口尺寸是 `1180x780`，最小尺寸是 `940x620`。
2. `npm test` 当前结果。
3. 现有冒烟截图是否存在空白、布局错位或运行期错误。
4. `src/renderer/styles.css` 中当前 CSS 变量全部有定义。
5. `git diff` 中已有修改来自用户，不能被视觉任务覆盖。

若基线本身有错误，先记录并修复阻塞问题，再做视觉改造。

---

### Task 1: 建立视觉基线与截图审计

**Files:**
- Create: `tools/smoke.cjs`
- Modify: `package.json`
- Create: `docs/visual-regression/README.md`

**Interfaces:**
- Consumes: Electron 应用的 `--smoke-view`、`--smoke-open`、`--smoke-shot`、`--smoke-dump` 参数。
- Produces: `npm run visual:baseline`，生成四个视图、两种主题和至少两个窗口尺寸的截图与 `audit.json`。

**约束：**

- 只使用仓库已有的 Electron，不安装 Playwright 或浏览器自动化依赖。
- 冒烟数据必须隔离到临时目录，禁止写入真实 `~/.gptplus` 或 `~/.codex`。
- 截图文件只放在 `docs/visual-regression/` 或临时目录。
- `tools/smoke.cjs` 不能用字符串拼接导航名来驱动 Electron；使用固定参数表。

**步骤：**

- [ ] 1. 先写一个测试，验证 `package.json` 的 `scripts` 中存在 `visual:baseline`，并验证 `tools/smoke.cjs` 不使用远程 URL。

```js
test('视觉审计命令存在且只使用本地资源', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.match(pkg.scripts['visual:baseline'], /tools[\\/]smoke\.cjs/);
  const tool = read(path.join(ROOT, 'tools', 'smoke.cjs'));
  assert.doesNotMatch(tool, /https?:\/\//);
  assert.match(tool, /--smoke-shot/);
});
```

- [ ] 2. 运行该测试，确认因脚本缺失而失败。

```powershell
npm run test:renderer
```

Expected: FAIL，提示 `visual:baseline` 不存在或 `tools/smoke.cjs` 无法读取。

- [ ] 3. 创建 `tools/smoke.cjs`，职责只包括：

  - 解析 `--out`、`--check`、`--viewport`；
  - 创建临时冒烟目录；
  - 通过 `child_process.spawn` 启动 `electron .`；
  - 传入固定参数 `--smoke-shot`、`--smoke-dump`、`--smoke-view`、`--smoke-open`；
  - 等待退出码；
  - 校验截图尺寸大于 0、DOM dump 文本长度大于 0；
  - 输出 JSON 审计摘要；
  - 失败时以非零退出码结束。

核心参数形式：

```js
const baseArgs = [
  '.',
  '--smoke-dump', dumpPath,
  '--smoke-shot', shotPath,
];
if (scenario.view) baseArgs.push('--smoke-view', scenario.view);
if (scenario.open) baseArgs.push('--smoke-open', scenario.open);
```

- [ ] 4. 在 `package.json` 添加脚本：

```json
"visual:baseline": "node tools/smoke.cjs --out docs/visual-regression/baseline",
"visual:check": "node tools/smoke.cjs --out docs/visual-regression/current --check"
```

- [ ] 5. 运行基线命令。

```powershell
npm run visual:baseline
```

Expected: 生成 `providers`、`models`、`usage`、`settings`、`provider-form`、`logs` 的截图与 dump；命令退出码为 0。

- [ ] 6. 人工打开截图检查四个页面不是黑屏、白屏、错误页或布局完全破版；记录基线问题到 `docs/visual-regression/README.md`。

- [ ] 7. 运行完整测试。

```powershell
npm test
```

Expected: 全部通过；若已有失败，先记录基线失败，不在视觉任务中掩盖。

**验收：**

- 截图命令可在当前 Windows 环境重复运行。
- 冒烟数据不触碰真实用户目录。
- `npm test` 结果被记录。
- 截图路径和审计输出有固定、可预测的位置。

---

### Task 2: 设计令牌、主题与共享基础组件

**Files:**
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer.test.js`
- Test: `test/renderer.test.js`

**Interfaces:**
- Consumes: 现有 `:root` 和 `html[data-theme="light"]` 变量。
- Produces: 统一 token 名称、卡片圆角上限、按钮/输入/徽标/状态点的共享视觉规则。

**步骤：**

- [ ] 1. 先写 token 约束测试：

```js
test('视觉 token 约束：卡片圆角不超过 8px', () => {
  const css = read(CSS);
  const cardRadius = css.match(/--radius-card:\s*(\d+)px/);
  assert.ok(cardRadius, '必须提供 --radius-card token');
  assert.ok(Number(cardRadius[1]) <= 8);
  assert.match(css, /\.card\s*\{[\s\S]*?border-radius:\s*var\(--radius-card\)/);
});
```

- [ ] 2. 运行测试，确认失败。

```powershell
npm run test:renderer
```

- [ ] 3. 在 `:root` 与浅色主题中增加新的语义 token，但不立即删除旧 token：

```css
--ui-bg: #101315;
--ui-surface: #171b1d;
--ui-text: #eef2ef;
--ui-muted: #9ba6a7;
--ui-cyan: #63bbc8;
--ui-amber: #e0a34c;
--radius-card: 8px;
--radius-control: 6px;
```

浅色主题对应值：

```css
--ui-bg: #f4f6f3;
--ui-surface: #ffffff;
--ui-text: #172127;
--ui-muted: #596970;
--ui-cyan: #227383;
--ui-amber: #a96417;
```

- [ ] 4. 将旧变量映射到新 token，先保持行为一致：

```css
--bg: var(--ui-bg);
--bg-panel: var(--ui-surface);
--fg: var(--ui-text);
--fg-dim: var(--ui-muted);
--accent: var(--ui-cyan);
```

如果旧主题依赖不同计算值，使用中间别名而不是直接替换全部引用。

- [ ] 5. 将 `.card`、`.pcard`、`.empty`、`.table`、`.usage-stat` 的圆角统一为 `var(--radius-card)`。

- [ ] 6. 将按钮与输入框的圆角统一为 `var(--radius-control)`。

- [ ] 7. 删除或收口以下重复动效：

```css
.card:hover { transform: none; }
.pcard:hover { transform: none; }
.wire-node:hover { transform: none; }
.empty:hover .empty-glyph { transform: none; }
.dot-ok { animation: none; }
```

删除规则时先全仓搜索选择器，避免影响状态逻辑。

- [ ] 8. 为浅色主题增加针对 `.muted`、`.faint`、`.chip`、`.table .thead` 的对比度覆盖，而不是直接全局加深所有文字。

- [ ] 9. 运行测试与截图。

```powershell
npm run test:renderer
npm run visual:check
```

Expected: token 测试通过；四页仍能渲染；没有空白页。

**验收：**

- 新旧 token 都有清晰映射关系。
- 卡片和控件圆角符合规范。
- 深色和浅色都不出现不可读的灰字。
- 不改变组件语义和事件处理。

---

### Task 3: 应用外壳、导航和底部状态栏

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer.test.js`
- Test: `test/renderer.test.js`

**步骤：**

- [ ] 1. 先写结构测试，验证侧栏不再把完整拓扑图重复放在底部，并验证状态栏仍有日志、主题、版本入口。

```js
test('状态栏保留日志、主题和版本入口，侧栏不重复完整拓扑', () => {
  const html = read(HTML);
  const app = read(APP);
  assert.match(html, /id="theme-control"/);
  assert.match(html, /id="build-tag"/);
  assert.match(html, /id="log-toggle"/);
  assert.doesNotMatch(app, /sidebar-topology-card/);
});
```

- [ ] 2. 运行测试，确认结构约束处于当前状态。

```powershell
npm run test:renderer
```

- [ ] 3. 调整侧栏底部结构：保留网关/注入摘要、网络模式、自启动、更新和重启动作，但减少独立边框容器。日志、主题和版本继续留在底部状态栏。

- [ ] 4. 修改 `renderSidebarFoot()`：只显示一行网关摘要和一行注入摘要；不要在此处重复完整模型数量、连接轨道说明和所有状态 chip。

- [ ] 5. 修改 `renderFlow()`：状态栏保留紧凑拓扑，但为每个节点设置固定最大宽度和省略号；窄窗口隐藏非关键摘要，不隐藏状态本身。

- [ ] 6. 调整导航选中态与焦点态：

```css
.nav-item.is-active {
  background: rgba(99, 187, 200, 0.07);
  border-color: rgba(99, 187, 200, 0.28);
  box-shadow: none;
}
```

- [ ] 7. 降低品牌图、导航图标、状态点的发光和动画强度，保留品牌识别。

- [ ] 8. 验证最小窗口：

```powershell
npm run visual:check -- --viewport 940x620
```

若该参数尚不存在，Task 1 必须先支持 `--viewport`，再执行此命令。

**验收：**

- 侧栏底部不再像一组叠叠卡片。
- 顶部标题、动作按钮和导航在三种窗口尺寸下对齐。
- 状态栏信息不重叠，日志入口始终可点。
- 键盘导航和焦点环正常。

---

### Task 4: 提供商页与编辑表单

**Files:**
- Modify: `src/renderer/views/providers.js`
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer.test.js`
- Test: `test/renderer.test.js`

**步骤：**

- [ ] 1. 写行为保持测试，确认提供商卡仍显示名称、协议、模型数、API Key 打码和测试连接动作。

```js
test('提供商卡保留核心信息和打码 Key', () => {
  const src = read(path.join(VIEWS, 'providers.js'));
  assert.match(src, /API_LABELS/);
  assert.match(src, /maskKey/);
  assert.match(src, /测试连接/);
  assert.match(src, /添加提供商/);
});
```

- [ ] 2. 运行测试确认基线通过，再做页面结构改造。

- [ ] 3. 将提供商页概览条从“多个状态 chip 堆叠”改为一行紧凑摘要：

```text
2 个提供商 · 4 个模型 · 3 个已启用        注入：已开启
```

- [ ] 4. 提供商卡保留四类信息：名称与 Base URL；协议与启用状态；模型数量；API Key 状态与操作。将“支持推理”“未启用模型数”等次要信息移动到模型预览或详情区域。

- [ ] 5. 把测试连接结果显示在卡片底部，使用单行提示和状态图标；失败时显示短错误，完整错误保留在 `title` 或运行日志中。

- [ ] 6. 调整编辑表单：名称与协议同一行；Base URL 独占一行；API Key 使用密码框和显隐图标同行；模型清单作为可滚动表格；保存与取消固定在弹窗底部；错误提示靠近对应字段。

- [ ] 7. 确保 `Ctrl+Enter` 保存、`Esc` 关闭和焦点返回行为不变。

- [ ] 8. 运行：

```powershell
npm run test:renderer
npm run visual:baseline
```

并检查提供商页与 `provider-form` 截图。

**验收：**

- 提供商信息不再被多个同等级 chip 淹没。
- 编辑表单首屏能看到名称、协议、Base URL、API Key 的主操作。
- 连接测试与保存失败有明确下一步。
- API Key 不以明文出现在截图、dump、日志或页面默认态。

---

### Task 5: 模型页、连接轨道与模型表

**Files:**
- Modify: `src/renderer/views/models.js`
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer.test.js`
- Test: `test/renderer.test.js`

**步骤：**

- [ ] 1. 写结构测试，验证连接轨道仍包含三个业务节点，且注入开关保留 aria 语义。

```js
test('模型页连接轨道保留提供商、网关、ChatGPT 三个节点', () => {
  const src = read(path.join(VIEWS, 'models.js'));
  assert.match(src, /1 · 提供商/);
  assert.match(src, /2 · 本地网关/);
  assert.match(src, /3 · ChatGPT 客户端/);
  assert.match(src, /role:\s*'switch'/);
  assert.match(src, /aria-checked/);
});
```

- [ ] 2. 运行测试，确认当前结构。

- [ ] 3. 将连接轨道从三张渐变卡改为一个整行主面板：左端提供商；中段网关；右端 ChatGPT；连接段只在链路真实连通时运动；未连通节点显示原因和下一步。

- [ ] 4. 合并注入成功提示：将“已注入 N 个模型”并入轨道第三节点，保留目录路径和备份说明到可展开的次信息。

- [ ] 5. 默认模型区域改为一行布局：label、picker、当前 slug、设置状态；在窄窗口允许 slug 换到第二行。

- [ ] 6. 模型表：宽屏显示全部列；窄屏隐藏次要列，但显示名、提供商、状态和默认动作不可隐藏；slug 保持可复制；停用行的文字保持可读，使用左侧状态条和文字提示；拖动把手、开关和默认按钮使用固定尺寸。

- [ ] 7. 保留所有事件：启用/停用模型、设为默认、拖动排序、搜索过滤和只看已启用。

- [ ] 8. 运行：

```powershell
npm run test:renderer
npx electron . --smoke-view models --smoke-open log --smoke-shot probe\models-refresh.png --smoke-dump probe\models-refresh.json
```

Expected: Electron 退出码为 0；截图能显示连接轨道和模型表；点击日志后抽屉不遮住主动作。

**验收：**

- 页面唯一的强视觉焦点是连接轨道。
- 注入状态不再在三个连续区域重复。
- 模型主操作在默认窗口内无需横向滚动即可完成。
- 拖动排序、开关和默认模型行为保持不变。

---

### Task 6: 使用量页

**Files:**
- Modify: `src/renderer/views/usage.js`
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer.test.js`
- Test: `test/renderer.test.js`

**步骤：**

- [ ] 1. 写结构测试，确认统计、趋势、按模型、按提供商和请求记录都存在。

```js
test('使用量页保留统计、趋势和明细结构', () => {
  const src = read(path.join(VIEWS, 'usage.js'));
  assert.match(src, /usage-stats/);
  assert.match(src, /usage-heatmap/);
  assert.match(src, /按模型/);
  assert.match(src, /按提供商/);
  assert.match(src, /请求记录/);
});
```

- [ ] 2. 将顶部筛选和刷新整合到一行工具栏；在窄窗口允许控件换行但不压缩数值文字。

- [ ] 3. 统计组件统一高度、数值基线和图标尺寸。每个统计卡最多一个状态色条，不使用多层阴影。

- [ ] 4. 调整热力图：主图占主要面积；月份标签不重叠；单元格最小尺寸在窄窗口仍可辨识；提示框不越出内容区域；空数据时显示结构说明，不显示看似有数据的占位柱。

- [ ] 5. 将按模型/按提供商列表统一列宽与数值对齐；长模型名截断并保留完整 `title`。

- [ ] 6. 请求记录在窄窗口使用横向滚动容器，保持表头和数值列可见。

- [ ] 7. 运行：

```powershell
npm run test:renderer
npx electron . --smoke-view usage --smoke-shot probe\usage-refresh.png --smoke-dump probe\usage-refresh.json
```

**验收：**

- 顶部工具栏不抢占主图表的视觉优先级。
- 五张统计卡同一高度、同一对齐。
- 空数据和有数据两种状态都能正常渲染。
- 长时间历史表格不会撑破页面。

---

### Task 7: 设置页

**Files:**
- Modify: `src/renderer/views/settings.js`
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer.test.js`
- Test: `test/renderer.test.js`

**步骤：**

- [ ] 1. 写结构测试，确认更新、模型上下文、网关和注入设置仍在。

```js
test('设置页保留更新、上下文、网关和注入设置', () => {
  const src = read(path.join(VIEWS, 'settings.js'));
  assert.match(src, /软件更新/);
  assert.match(src, /模型上下文/);
  assert.match(src, /本地网关/);
  assert.match(src, /注入/);
});
```

- [ ] 2. 将设置页从多张独立 card 改为连续设置区块，每个区块有清晰的标题、说明和行间分割线。

- [ ] 3. 每行设置采用固定网格：`title + description` 在左，`control` 在右；控制区不因说明文字换行而左右跳动。

- [ ] 4. 输入框、开关和保存按钮保持控件高度一致；表单错误在对应行内展示。

- [ ] 5. 区分危险操作：恢复注入、回退版本、删除或覆盖类动作、重启提示。只有确认阶段使用红色实心或高对比边框。

- [ ] 6. 将路径显示改为可复制、可截断的单行字段，避免长路径撑宽布局。

- [ ] 7. 检查更新、回退选择器、网关端口保存和上下文保存仍使用原有 IPC 调用。

- [ ] 8. 运行：

```powershell
npm run test:renderer
npx electron . --smoke-view settings --smoke-shot probe\settings-refresh.png --smoke-dump probe\settings-refresh.json
```

**验收：**

- 设置页在默认窗口内不需要横向滚动。
- 每个设置只出现一次，不再套多层容器。
- 长路径和错误消息不会挤出控件。
- 危险动作与普通设置视觉分离。

---

### Task 8: 弹窗、日志抽屉、空状态、加载态与动效收口

**Files:**
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/views/providers.js`
- Modify: `src/renderer/views/models.js`
- Modify: `src/renderer/views/usage.js`
- Modify: `src/renderer/views/settings.js`
- Modify: `test/renderer.test.js`

**步骤：**

- [ ] 1. 写动效约束测试：

```js
test('动效遵守 reduced-motion 与状态色语义', () => {
  const css = read(CSS);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@keyframes current/);
  assert.match(css, /animation-iteration-count:\s*1/);
});
```

- [ ] 2. 统一弹窗头部、正文、底部动作为一套样式；固定底部操作区，长表单只滚正文。

- [ ] 3. 统一日志抽屉：保留可读行高、筛选、自动滚动、清空和关闭；在窄窗口隐藏次要元信息但不隐藏日志正文。

- [ ] 4. 统一 Toast：成功、警告、错误、信息使用左侧状态条和图标，保持同一宽度与位置。

- [ ] 5. 空状态只保留一个主动作和一个次动作；按钮和说明不超出容器。

- [ ] 6. 加载态使用固定尺寸骨架或占位，避免从加载状态切换时内容跳动。

- [ ] 7. 删除装饰性悬停位移和持续脉动；只保留有因果的状态反馈。

- [ ] 8. 运行：

```powershell
npx electron . --smoke-view providers --smoke-open form --smoke-shot probe\modal-refresh.png --smoke-dump probe\modal-refresh.json
npx electron . --smoke-open log --smoke-shot probe\logs-refresh.png --smoke-dump probe\logs-refresh.json
```

**验收：**

- 弹窗和日志抽屉在最小窗口内可滚动、可关闭。
- 打开浮层后焦点仍在可达控件中，关闭后回到触发元素。
- reduced motion 下没有持续电流、脉动或弹跳。
- 无空白页、无运行时错误、无文本重叠。

---

### Task 9: 最终视觉回归

**Files:**
- Modify: `docs/visual-regression/README.md`
- Create: `docs/visual-regression/final/`（截图）

**步骤：**

- [ ] 1. 运行完整单测。

```powershell
npm test
```

Expected: 全部通过。

- [ ] 2. 运行视觉审计默认尺寸、最小尺寸和宽屏尺寸。

```powershell
npm run visual:check
npm run visual:check -- --viewport 940x620
npm run visual:check -- --viewport 1440x900
```

若视口参数由 Task 1 实现，则要求每次生成对应尺寸截图。

- [ ] 3. 验证浅色主题。验证前先确认可用的 Electron 冒烟参数或临时隔离数据，不修改真实用户设置。

- [ ] 4. 人工检查：空白页、字体缺失、文字截断、按钮溢出、控件覆盖、卡片圆角超限、状态重复、浅色对比不足、页面切换跳动。

- [ ] 5. 手工走主流程：添加提供商；编辑并保存；测试连接；启用/停用模型；设置默认模型；打开/关闭注入；保存网关端口；打开日志；清空日志；关闭弹窗并返回触发位置。

- [ ] 6. 确认 `git diff` 中没有业务逻辑、IPC 契约或密钥泄露。

- [ ] 7. 在 `docs/visual-regression/README.md` 记录：使用的命令、截图路径、通过/失败项、未验证项和原因、当前工作树状态。

**验收：**

- 设计规范里的 10 条验收标准逐条有证据。
- 截图不是空白、黑屏或错误页。
- 主要流程全部可用。
- 没有未说明的残留视觉问题。

---

## 执行检查点

每个任务完成后停下报告，至少包含：

1. 修改的文件；
2. 解决的问题；
3. 运行的测试命令与结果；
4. 截图路径和人工观察；
5. 已知限制；
6. 是否需要用户确认进入下一阶段。

推荐分三次停点：

- 停点 A：Task 1 到 Task 3，确认外壳和视觉系统方向。
- 停点 B：Task 4 到 Task 7，确认四页信息层级。
- 停点 C：Task 8 到 Task 9，确认浮层、动效和最终回归。

## 风险控制

| 风险 | 预防 |
|---|---|
| 覆盖已有修改 | 每任务先查看 `git diff`，只改目标选择器和函数 |
| CSS 级联意外影响 | 新 token 先映射旧 token，再逐页移除旧样式 |
| 测试无法代表视觉效果 | 每任务至少一张真实 Electron 截图 |
| 浅色主题后置 | 每个停点都检查双主题截图 |
| 状态颜色再次失控 | 语义色仅用于文字、细条、图标和小面积背景 |
| 动画影响性能 | 只动画 transform/opacity，禁止持续布局动画 |
| 新资源违反 CSP | 不引入远程字体、图片和图标 CDN |
| 大文件难维护 | 只做与视觉目标直接相关的局部拆分，不做无关重构 |
