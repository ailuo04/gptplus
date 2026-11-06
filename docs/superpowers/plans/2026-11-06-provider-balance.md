# 中转站余额插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ChatGPT 桌面客户端左侧栏「设置」上方增加跟随当前模型上游的余额圆环，并支持 Sub2API / New API 的只读查询、区间消费提示、可配置轮询和逐位变化数字滚动。

**Architecture:** gpt++ 主进程复用现有提供商凭据与系统代理，通过固定 GET 路由读取余额并在内存中计算各提供商独立的变化快照；安全过滤后的数据经 CDP 推送到 ChatGPT。独立页面脚本在窄侧栏之外建立根级 overlay，识别当前实际选中模型并映射到提供商，绘制圆环、详情、边界避让提示和仅变化位滚动动画。插件配置、启停和生命周期沿用现有插件市场 / IPC 结构，不依赖用量信息栏插件启用。

**Tech Stack:** Electron、Node.js CommonJS、现有 `node:test`、CDP、浏览器 DOM/CSS/ResizeObserver、项目现有系统代理与安全存储。

---

## 文件结构

- `src/core/plugin-manager.js`：注册「中转站余额」内置插件；规范化已关联的 `providerId` / adapter 和 60 秒默认刷新间隔；公开配置只含提供商 ID 与适配器，不含 Key。
- `src/core/provider-balance.js`（新）：Sub2API 与 New API 固定只读 GET、超时/响应限制、认证头、错误分类和站点账务响应归一化。
- `src/core/balance-runtime.js`（新）：插件启停、刷新计时、按 provider/凭据隔离快照、请求合并、精确区间差额与仅发送展示安全数据。
- `src/core/chatgpt-balance.js`（新）：生成 ChatGPT 页面脚本、CDP 注入/恢复/清理、当前模型变化桥接和余额数据推送。
- `src/core/context.js`：创建并公开 balance client/runtime，统一注入现有系统代理 fetch。
- `src/core/ipc.js`：处理 balance 配置即时应用、手动刷新、详情读取；插件禁用/卸载时停止运行时；确保余额插件单独启用也能使用 CDP。
- `src/main/preload.cjs`：暴露白名单化的余额操作 IPC，无 Node、Key 或通用请求能力。
- `src/main/main.js`：响应余额插件配置/启停生命周期，并在 ChatGPT 已运行时恢复注入；保持用量信息栏和语音输入的独立启停。
- `src/renderer/views/plugins.js`：插件卡片及配置表单：选择现有提供商、指定 Sub2API/New API、设置 10–86400 秒刷新间隔。
- `src/renderer/styles.css`：只放插件市场配置表单需要的最少样式；ChatGPT overlay 样式由受控页面脚本创建。
- `test/provider-balance.test.js`（新）：固定端点、鉴权、账务解析、消费差额、精度、失败与限流。
- `test/chatgpt-balance.test.js`（新）：页面脚本、CDP 注入/桥接、模型切换、overlay 位置、数字滚动与清理。
- `test/core.test.js`：插件配置规范化、缺省状态和安全公开配置。
- `test/renderer.test.js`：插件配置 UI、验证和保存行为。
- `test/chatgpt-launch.test.js` 或新建 `test/balance-runtime.test.js`：生命周期和 CDP 恢复的无真实 ChatGPT 集成测试；择较小且符合现有结构的测试位置。
- `README.md`：插件用途、配置、两站点适配范围、查询不调用生成接口、消费口径及实际限制。
- `spec.md`：追加已有架构/插件契约的公开说明；只记录实现后验证成立的实际接口字段。

**不修改/不覆盖：** 用户已有未跟踪文件 `.verify-doraemon-ride.cjs`；不改提供商卡片复制 API Key 的现有功能；不触碰真实用户配置、外部 ChatGPT 插件文件或真实站点凭据。

## 依赖顺序与实现关口

1. 首先只读调查当前已安装 ChatGPT 版本中“此刻所选模型”的可靠 DOM 信号，以及模型切换时实际 DOM 变化。必须能读取精确模型 slug / catalog entry，不能用模型标签、最近请求、全局默认模型或上一个会话的缓存猜测。如果没有稳定信号，停止该关口并向用户说明证据缺口，不把启发式冒充确定选择。
2. 余额只使用设计文档中核对过的官方只读 usage/token 端点。端点前缀须兼容已有提供商 Base URL 的 `/v1` 与自托管路径；不得探测聊天、Responses、Messages、生成、图片、音频路由。
3. 所有金额/消费计算保留原始精度；页面只能收到脱敏展示状态，不能收到 API Key、Authorization/custom secret headers 或完整上游响应。
4. 仅在每次配置/启停成功后生效；刷新间隔保存后立即生效。停用/卸载时同步取消 timer、挂起刷新、注入脚本与观察器。
5. 余额圆环及错误 `!` 必须是页面功能；红色消费额在圆环正上方、完整落于 ChatGPT 可见窗口内，不能被侧栏裁剪；数字只滚动变化位。

### Task 1：查明当前模型选择信号并增加插件配置契约

**Files:**
- Read: `research/desktop-model-picker.md`
- Read: `src/core/usage-statusline.js`
- Modify: `src/core/plugin-manager.js`
- Test: `test/core.test.js`

- [ ] **Step 1：写配置规范化失败测试**

在 `test/core.test.js` 现有 `plugin manager` 测试附近增加 node:test 用例，核心断言如下；用现有 `tmpDir` / `cleanup` 建立隔离 Store：

```js
const plugin = manager.get('provider-balance');
assert.equal(plugin.installed, false);
assert.equal(plugin.enabled, false);
assert.deepEqual(plugin.config, { providers: [], refreshIntervalSeconds: 60 });
manager.setConfig('provider-balance', {
  providers: [
    { providerId: 'p_demo0001', adapter: 'sub2api' },
    { providerId: 'p_demo0002', adapter: 'newapi' },
  ],
  refreshIntervalSeconds: 60,
});
assert.deepEqual(manager.config('provider-balance').providers, [
  { providerId: 'p_demo0001', adapter: 'sub2api' },
  { providerId: 'p_demo0002', adapter: 'newapi' },
]);
assert.throws(() => manager.setConfig('provider-balance', {
  providers: [{ providerId: 'p_demo0001', adapter: 'guess' }], refreshIntervalSeconds: 60,
}), /adapter/);
assert.throws(() => manager.setConfig('provider-balance', {
  providers: [], refreshIntervalSeconds: 9,
}), /刷新间隔/);
assert.equal(JSON.stringify(plugin).includes('apiKey'), false);
assert.equal(JSON.stringify(plugin).includes('secret'), false);
```

未知或重复 providerId 不进入已保存公开配置；刷新秒数 10–86400 的边界有效、边界外失败；adapter 仅接受 `sub2api` / `newapi`。
- [ ] **Step 2：运行目标测试确认失败**

Run: `node --test --test-name-pattern="provider balance plugin config" test/core.test.js`
Expected: FAIL，原因是插件定义和 balance config normalizer 尚不存在。

- [ ] **Step 3：实现最小配置契约**

在 `src/core/plugin-manager.js` 中新增 `DEFAULT_BALANCE_CONFIG`、`normalizeBalanceConfig(raw, { strict = false })` 并在 `normalizePluginConfig` 中分派 `provider-balance`。磁盘状态恢复以安全默认值处理旧/坏字段；用户显式 `setConfig` 必须走 strict 校验并抛出可读错误。最终配置结构固定为：

```js
{
  providers: [{ providerId: '现有稳定 provider id', adapter: 'sub2api' }],
  refreshIntervalSeconds: 60,
}
```

新增默认未安装、未启用的内置插件定义，ID `provider-balance`。归一化保留有效 provider 映射和整数间隔，不读取或复制任何凭据。插件说明明确“只调用额度查询接口，不发送生成请求；插件启用后使用现有提供商 Key”。把 default 和 normalizer 按现有 export 风格导出。

- [ ] **Step 4：运行目标测试确认通过**

Run: `node --test --test-name-pattern="provider balance plugin config" test/core.test.js`
Expected: 新增配置用例 PASS；检查现有插件市场 ID 顺序断言，并一并更新为实际 catalog 顺序后，`npm run test:core` PASS。

- [ ] **Step 5：执行当前版本只读模型选择器调查**

当前安装客户端为 26.1029.7803.0。活动选择器只有一个可见模型入口；沿该 DOM 节点的 React fiber 读取到选择组件的 `props.model` 精确值（当前 `fapi__gpt-6.1-sol`），与 `props.displayName` 只用于核对而不用于路由。实现读取精确 `model` 并用本地 catalog `slugForProvider` 结果反查 providerId；组件信号缺失、值不唯一或未知一律显示 `!`。由于这是客户端内部 React 信号而非公开 DOM API，必须加 fixture 覆盖、运行时防护与版本变化时的 fail-closed 行为；实际用户选中状态不在调查时更改。

### Task 2：实现两类固定只读余额客户端

**Files:**
- Create: `src/core/provider-balance.js`
- Create: `test/provider-balance.test.js`
- Read: `src/core/provider-client.js`
- Read: `src/core/base-url.js`
- Read: `src/core/system-proxy.js`

- [ ] **Step 1：先写仅允许 GET 的 HTTP 合约测试**

使用本机 `http.createServer` 合成响应和记录请求。验证 Sub2API 仅请求 `/v1/usage`、New API 仅请求 `/api/usage/token`（允许其文档指定的末尾 `/`），都携带已有 API Key 的 Bearer auth，并保留用户已配置的安全自定义 header；无请求体、无任何 generation/chat 路由。覆盖 Base URL 为 `https://example.test/v1` 与 `https://example.test/relay/v1` 时端点不重复 `/v1` 且自托管前缀保留。

- [ ] **Step 2：运行目标测试确认失败**

Run: `node --test test/provider-balance.test.js`
Expected: FAIL，原因是余额 client 尚不存在。

- [ ] **Step 3：实现 endpoint builder 和 reader**

新增接口：

```js
createProviderBalanceClient({ fetchImpl, timeoutMs = 10000, maxResponseBytes = 256 * 1024 })
  -> { read({ provider, adapter }) }
```

`read` 只构造一个固定 GET；`provider` 仅从主进程 Store 读取。请求使用现有系统代理 fetch、AbortSignal 超时、受限 body reader 和 `provider-client.js` 的大小写不敏感 header 合并约定。adapter 之外的 HTTP 方法/URL 不暴露给 renderer。错误返回安全、短消息，不能含 Key、Authorization、自定义密钥或完整响应体。主进程按 adapter 选择常量 endpoint：

```js
function endpointPath(adapter) {
  if (adapter === 'sub2api') return '/v1/usage';
  if (adapter === 'newapi') return '/api/usage/token';
  throw new Error('不支持的余额接口类型');
}
```

以单测覆盖 Base URL 的版本路径处理和自托管前缀保留，确保 renderer 无法提供目标 URL。

- [ ] **Step 4：先测后实现账务响应解析**

写 Sub2API 与 New API 的合成 fixtures，验证 key remaining / subscription 状态、New API quota 单位换算、`total_used`、明确币种、不限额及不支持/矛盾字段。解析函数返回内部规范对象 `{ balance, currency, unit, unlimited, totalUsed, totalUsedUnit, accountScope }`，数字以十进制字符串或等价精确表示保留原始精度。字段缺失/旧版不兼容时报清楚的适配错误，不把缺省值变成零。

- [ ] **Step 5：验证 reader**

Run: `node --test test/provider-balance.test.js`
Expected: 端点、固定 GET、响应大小、401/403/404/429/5xx、超时、非法 JSON、Sub2API 套餐/钱包、New API 换算和不限额用例全部 PASS；请求记录中不出现生成 endpoint 或 body。

### Task 3：建立刷新运行时、精确差额和限流状态

**Files:**
- Create: `src/core/balance-runtime.js`
- Create or extend: `src/core/balance-decimal.js`（只有复用逻辑无法在 `balance-runtime.js` 清晰测试时才新增）
- Test: `test/provider-balance.test.js`

- [ ] **Step 1：写区间差额测试**

用 fake clock 与注入的 client 构建运行时。断言首次读成功建立基线且不生成负数；累计数增加产生差额；完全不变返回零；余额增加不弹负数；统计回退/币种或单位变化/Key 身份变化重建基线；A 提供商和 B 提供商从不交叉相减。用 `0.0000001` 等小数证明计算不会浮点串扰或舍入成 0。

- [ ] **Step 2：运行目标测试确认失败**

Run: `node --test --test-name-pattern="balance interval delta" test/provider-balance.test.js`
Expected: FAIL，原因是 runtime/decimal calculator 尚不存在。

- [ ] **Step 3：实现纯差额和快照身份**

实现纯函数 `computeBalanceDelta(previous, next)` 和运行时 `createBalanceRuntime({ store, client, now, setTimeoutImpl, clearTimeoutImpl })`。快照键至少包含 providerId、Key 的本地主进程 hash、站点类型、币种/单位/统计口径；Key 原文、散列值和原始 headers 均不进入返回对象/日志。十进制差值使用字符串或 BigInt coefficient/scale，不依赖二进制浮点。返回的 delta 只表达可靠的累计使用差；只有余额时标记 net-balance-change 供详情说明；首个快照、充值或重置禁止消费 toast。纯函数最低契约：

```js
function computeBalanceDelta(previous, next) {
  if (!previous) return { kind: 'baseline', delta: null };
  if (previous.currency !== next.currency || previous.unit !== next.unit) {
    return { kind: 'reset', delta: null };
  }
  if (previous.totalUsed != null && next.totalUsed != null) {
    const delta = subtractDecimal(next.totalUsed, previous.totalUsed);
    if (compareDecimal(delta, '0') < 0) return { kind: 'reset', delta: null };
    return { kind: 'cumulative', delta };
  }
  const net = subtractDecimal(previous.balance, next.balance);
  return compareDecimal(net, '0') > 0
    ? { kind: 'net-balance-change', delta: net }
    : { kind: 'credit-or-unknown', delta: null };
}
```

`subtractDecimal` / `compareDecimal` 使用同一个 BigInt coefficient/scale 实现，并保留最小非零位。

- [ ] **Step 4：写轮询、复用和停用测试**

验证 `refresh(providerId)` 对并发请求合并、默认间隔 60 秒、自定义间隔更改后立即重排、未选上游不轮询、详情打开时手动读取其他已配置上游、Retry-After 暂停刷新、失败不更新基线、停用/卸载清 timer 并阻止晚到响应污染 UI。

- [ ] **Step 5：实现 schedule/lifecycle 并验证**

运行时暴露 `configure(config)`, `refresh(providerId,{ reason })`, `refreshCurrent(providerId)`, `getSnapshots()`, `stop()`；用 promise map 合并相同 provider 请求，按最新已选 provider/页面 generation token 检查 toast 可见性，保留每个 provider 的独立内存快照。运行 `node --test --test-name-pattern="balance interval delta|balance refresh runtime" test/provider-balance.test.js`，预期全部 PASS。

### Task 4：开发安全的页面圆环、viewport overlay 与数字动效

**Files:**
- Create: `src/core/chatgpt-balance.js`
- Create: `test/chatgpt-balance.test.js`
- Read: `src/core/usage-statusline.js`
- Read: Task 1 确认的 ChatGPT DOM fixture

- [ ] **Step 1：先写页面脚本测试**

用 `node:vm` 或现有 CDP fake page 执行生成的浏览器脚本，使用 DOM fixture 验证：找出精确当前模型 slug；与模型 catalog 切换事件同步更新 provider；无匹配或无法识别时在圆环显示红色 `!`；A -> B 后 A 晚到数据不会覆盖 B；页面重挂/导航不重复创建节点/观察器；toast 在根级 overlay 而不是侧栏 overflow 容器内。

- [ ] **Step 2：运行目标测试确认失败**

Run: `node --test --test-name-pattern="balance indicator page script" test/chatgpt-balance.test.js`
Expected: FAIL，原因是 page script builder 尚不存在。

- [ ] **Step 3：实现 UI 和边界避让**

生成带命名空间 id/属性的页面脚本，在 `document.body` 的 overlay 根节点中创建设置上方圆环、详情弹层与轻提示。挂载接口为 `buildBalanceIndicatorScript({ pluginId, initialState }) -> string`；页面全局仅公开 `globalThis.__gptplusBalance.apply(snapshot)`、`context()`、`dispose()` 三个窄方法。使用圆环 `getBoundingClientRect()` 计算 fixed/viewport 坐标；`visualViewport` 左右边距至少 8px；提示水平居中优先、会出界时向内平移，完整保留负号和长金额。监听 relevant DOM MutationObserver、滚动、ResizeObserver、window/visualViewport resize，销毁时移除所有 listener/observer/timer/node。任何异常都不抛到 ChatGPT 页面全局。

- [ ] **Step 4：先测后实现逐位滚动渲染**

断言 `72.40 -> 71.92` 只有三个变化位获得滚动 track，`72.40 -> 72.41` 只有末位滚动，`72.40 -> 72.40` 零 track，符号/小数点/千分位固定；进位、位数变化、负值、货币位置、状态切换和连续刷新后的最终读数正确。对照插件的 exact decimal formatter 使用 `Intl.NumberFormat.formatToParts` 分离 currency/group/decimal/integer/fraction；按位数对齐整数组和小数组，不用整个金额递增计数。只变化位动画约 400ms、单次，金额不变不动画，新快照覆盖旧动画而不排队，`prefers-reduced-motion` 直接更新。

- [ ] **Step 5：实现刷新金额轻提示**

只在本次成功比较得到可信区间 delta 时，在圆环正上方的同一个根 overlay 显示红色负数金额（无说明文字），淡入、约 2 秒后淡出；重复刷新替换同一提示。首次基线、重置、未知消费或充值不显示负数金额。浏览器内 accessibility label 保持完整余额与状态。

- [ ] **Step 6：验证 DOM 和视觉边界**

运行：`node --test test/chatgpt-balance.test.js`。
Expected: changed digits-only、未变化位无动画、reduced-motion、连续值更新、Toast 2 秒生命周期、长字符串与 viewport clamp、窄侧栏 overflow、重挂无重复节点等用例 PASS。对 Task 1 当前 ChatGPT 版本进行隔离 UI 冒烟；未能连接真实版本时报告未验证，不伪称通过。

### Task 5：接通独立 CDP 生命周期和模型映射

**Files:**
- Modify: `src/core/context.js`
- Modify: `src/core/chatgpt-balance.js`
- Modify: `src/core/ipc.js`
- Modify: `src/main/main.js`
- Modify or create: `test/chatgpt-balance.test.js`
- Read: `src/core/cdp.js`
- Read: `src/core/chatgpt-launch.js`

- [ ] **Step 1：先写主进程生命周期测试**

注入 fake `findChatGptDebugPort`, `listTargets`, `inject`, `evaluate`, timers。断言插件启用会恢复已开放 CDP 的 ChatGPT；停用/卸载会 dispose 并停止余额刷新；余额插件在用量信息栏关闭时仍能独立挂载；用量信息栏和语音插件原有恢复流程仍各自只按本插件状态运行。

- [ ] **Step 2：运行目标测试确认失败**

Run: `node --test --test-name-pattern="chatgpt balance lifecycle" test/chatgpt-balance.test.js`
Expected: FAIL，原因是 balance runtime/CDP handler 未接入。

- [ ] **Step 3：组装 context、runtime 和订阅**

`context.js` 用同一 `network` fetch 创建 `createProviderBalanceClient` 与 `createBalanceRuntime` 并返回 `providerBalance` / `balanceRuntime`。主进程在 balance 插件 change 时只配置/停止自己的 runtime 和 CDP script；不能复用 `stopUsageStatuslineBridge()` 作为总停用操作。

- [ ] **Step 4：实现 CDP 推送和定时调度**

在 `chatgpt-balance.js` 加入 `resumeChatGptBalance({ctx,...})`, `disposeChatGptBalance({cdpPort,...})`, `startChatGptBalanceBridge(...)`，沿用 `findChatGptDebugPort`, `listTargets`, `pickMainTarget`, `evaluate`, `addScriptOnNewDocument`, `removeScriptOnNewDocument`。这些 API 与 return shape：

```js
resumeChatGptBalance({ ctx, timeoutMs, findPort, listTargetsImpl, inject })
  -> Promise<{ ok: boolean, skipped?: boolean, cdpPort?: number, error?: string }>
startChatGptBalanceBridge({ cdpPort, runtime, listTargetsImpl, evaluateImpl })
  -> { stop() }
disposeChatGptBalance({ cdpPort, target, timeoutMs })
  -> Promise<{ ok: boolean, skipped?: boolean }>
```主进程只将模型 slug/providerId、格式化余额/单位、状态、可信 delta、采样时间发给页面；Key、Header 和上游完整响应只留在 main。

- [ ] **Step 5：处理只启用余额插件的 ChatGPT 重启路径**

测试当前 `ipc.js` ChatGPT restart handler：余额启用但 `usage-statusline` 关闭时，重启仍需通过带 CDP 端口的 launch 并注入余额；两插件同时启用时使用同一调试启动且各自独立注入；两插件都关闭时保持现有启动路径。只抽取足以安全共享 CDP 启动参数的最小帮助函数，不把余额逻辑绑进用量脚本，不改变 voice-input 的行为。

- [ ] **Step 6：验证状态隔离和启动组合**

Run: `node --test --test-name-pattern="chatgpt balance lifecycle|restart.*CDP|usage-statusline" test/chatgpt-balance.test.js test/chatgpt-launch.test.js`
Expected: 余额插件独立、与用量信息栏并行、禁用清理和旧插件回归测试 PASS。

### Task 6：配置 IPC 与插件市场界面

**Files:**
- Modify: `src/core/ipc.js`
- Modify: `src/main/preload.cjs`
- Modify: `src/renderer/views/plugins.js`
- Modify: `src/renderer/styles.css`
- Test: `test/renderer.test.js`
- Test: `test/chatgpt-balance.test.js` 或 `test/core.test.js`

- [ ] **Step 1：写配置表单和 IPC 失败测试**

renderer FakeNode 覆盖 provider 下拉、adapter 下拉、10–86400 秒 interval、非法输入不调用 save、保存只发送 providerId/adapter/interval；状态页/插件 change event 不含凭据。IPC 覆盖 `gptplus:plugin:balance:refresh` 只接受已配置 providerId、`gptplus:plugin:balance:list` 返回脱敏 snapshot；任意 URL/任意方法请求通道不存在。

- [ ] **Step 2：运行目标测试确认失败**

Run: `node --test --test-name-pattern="balance plugin config UI|balance plugin IPC" test/renderer.test.js`
Expected: FAIL，原因是 balance 配置和 IPC/preload 方法尚不存在。

- [ ] **Step 3：实现 IPC 和最小暴露 API**

新增 `balance:list` / `balance:refresh` 的确定性处理器。`refresh` 接 providerId 而非 URL/key/adapter；主进程从已保存映射和 Store 构造唯一站点 GET。preload 只暴露 `getBalanceSnapshots()` 与 `refreshProviderBalance(providerId)`。保存 `provider-balance` config 后重新 `balanceRuntime.configure()` 即时应用。插件 disable/uninstall 应停止 timer、完成 CDP dispose。

- [ ] **Step 4：实现设置弹窗**

在 `configureButton()` 为 `provider-balance` 增加配置入口；表单列出当前 `ctx.state.providers` 的本地有效 provider，每项选 Sub2API/New API，允许删除映射，间隔输入以秒保存；未保存 key 不展示、不复制。详情列表由 ChatGPT 页面圆环点击使用，插件市场配置仅设置映射/轮询。沿用 `ctx.el`, `runPluginAction`, `ctx.openModal` 及现有 UI 文案风格。保存数据只能如下：

```js
ctx.api.setPluginConfig({
  id: 'provider-balance',
  config: {
    providers: [{ providerId: selectedProviderId, adapter: selectedAdapter }],
    refreshIntervalSeconds: Number(intervalInput.value),
  },
});
```

- [ ] **Step 5：运行 renderer 与相关 IPC 测试**

Run: `node --test --test-name-pattern="balance plugin config UI|balance plugin IPC" test/renderer.test.js test/chatgpt-balance.test.js`
Expected: UI 保存正确、边界校验正确、IPC 无自定义 URL/Key 输入、renderer 公开状态不含凭据；相关测试 PASS。

### Task 7：端到端覆盖、文档和发布检查

**Files:**
- Modify: `README.md`
- Modify: `spec.md`
- Modify: `docs/superpowers/specs/2026-11-06-provider-balance-design.md`（仅在实现与审批设计有经过验证的差异时）
- Test: `test/provider-balance.test.js`
- Test: `test/chatgpt-balance.test.js`
- Test: `test/core.test.js`
- Test: `test/renderer.test.js`
- Test: `test/packaging.test.js`（仅在 files 白名单或安装测试需要时）

- [ ] **Step 1：补齐跨层验收测试**

使用本地 fake 上游、无效/合成 Key、CDP mock 和 DOM fixture 验证完整路径：配置映射 -> 页面识别模型 slug -> gateway router/catalog 精确解析 providerId -> 只读余额 GET -> 新余额进入当前圆环 -> 可信 interval delta 以红色负数显示在正上方 -> 两秒淡出。切换到另一家、切到未关联模型、快速交替响应、额度重置和插件停用时，分别断言 provider 不串、错误显示 `!`、余额完整/状态正确、无多余 toast 且无遗留请求。

- [ ] **Step 2：确认从头至尾不走模型调用**

本地 fake server 记录所有路径、方法和 request body。每个刷新 interval、手动刷新、模型切换及首次基线期间只允许两种已批准 GET；断言不存在 `chat/completions`、`responses`、`messages`、`images/generations`、transcription 或任何 POST。assert body bytes 为 0。

- [ ] **Step 3：更新面向用户的说明**

`README.md` 插件市场章节增加安装/配置 Sub2API 与 New API、用现有 provider Key、自定义刷新间隔默认 60 秒、上游不兼容错误、余额可被同 Key 的其他客户端影响、消费 toast 只有可比较累计值时才报告。`spec.md` 只追加测试确认的 endpoint/字段与生命周期契约，并说明消费统计为 Key 区间用量而非精确到单模型/会话。

- [ ] **Step 4：执行完整验证**

Run: `node --test test/provider-balance.test.js test/chatgpt-balance.test.js`
Expected: 两个新测试套件 PASS。

Run: `npm run test:core; npm run test:renderer`
Expected: 现有核心及渲染回归 PASS，且保留 provider 卡片 API Key 复制按钮相关测试。

Run: `npm test`
Expected: 所有正式测试 PASS，0 failures。

Run: `node --check src/core/provider-balance.js; node --check src/core/balance-runtime.js; node --check src/core/chatgpt-balance.js; node --check src/core/context.js; node --check src/core/ipc.js; node --check src/main/main.js`
Expected: 所有语法检查退出码 0。

Run: `npm run smoke`
Expected: Electron 隔离冒烟通过，插件市场无 renderer 错误；若环境不支持真实 ChatGPT 调试端口，单独标明未完成实机验证。

- [ ] **Step 5：检查交付范围**

Run: `git status --short; git diff --check; git diff --name-only`
Expected: 只包含本功能源文件、正式测试和文档；不修改或删除 `.verify-doraemon-ride.cjs`；不触碰用户数据或产生 staging/commit/push。只有用户后续明确要求发布时才进入提交流程。

## 计划自检

- 设计覆盖：独立内置插件、Sub2API/New API 固定只读接口、凭据不暴露、默认 60 秒/自定义间隔、模型切换路由、红色 `!`、当前上游余额/详情、错误与过期状态、Key 级区间消费口径、2 秒红色金额 toast、viewport 根级 overlay 边界、仅变化数位滚动、reduced-motion、配置立即生效、启停/重载清理、无模型生成 Token 均有明确 Task 和验证步骤。
- 所有新运行时公开方法在首次使用处定义，不用 task 编号代替接口定义。
- 已有用户未跟踪脚本不纳入任何写集；未列出 commit 操作，遵守仓库不经确认不提交。
- 真实 ChatGPT UI 信号先只读取证；未能证明精确当前模型映射时，不能实现一个外观上成功但实际可能展示错误上游余额的猜测回退。
