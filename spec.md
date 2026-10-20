# gpt++ 技术契约 (v1)

> 本文件是各模块并行开发的**唯一接口契约**。任何模块的公开签名以此为准；
> 需要变更时先改本文件，再改代码。

## 1. 目标

Windows 桌面 App（Electron），用途：

1. 在 App 里管理「自定义模型提供商」：名称、BaseURL、API Key、模型列表。
2. App 提供本地网关（gateway），把 ChatGPT 桌面客户端的请求路由到用户添加的提供商。
3. App 把配置写入 Codex 配置目录，使 **ChatGPT 桌面客户端的模型选择器**里出现自定义模型。

## 2. 已验证的桌面端机制（证据）

> 补充结论来自 `research/desktop-model-picker.md`（用真实引擎驱动 `model/list` JSON-RPC 得出）
> 与 `research/codex-gateway-protocol.md`（用真实引擎 + 本地网关抓包得出）。

目标客户端：MSIX `OpenAI.Codex` 26.930.2377.0，显示名 **ChatGPT**，
可执行文件 `C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`，
内置 `resources\codex.exe`（`codex-cli 0.159.0-alpha.12.1`）。

### 2.1 四条硬约束（踩中任意一条都会静默失效）

1. **`model_catalog_json` 必须是顶层键，且写在第一个 `[table]` 之前。**
   写在文件末尾会被解析成 `windows.model_catalog_json`，引擎只打一行
   `` `windows.model_catalog_json` is ignored `` 然后什么都不做。
2. **目录是整体替换，不是追加。** 一旦生效，内置 GPT 模型从选择器里全部消失。
3. **一个坏条目会废掉整份目录。** 引擎 stderr 报一行错，然后回退到内置列表。
   空 `models` 数组同样回退（"must contain at least one model"）。
4. **改完必须重启客户端。** 选择器的 react-query key 里只有目录**路径**没有内容，
   默认缓存 5 分钟；重启是最省事的做法。

### 2.2 模型选择器的数据来源（代码路径）

```
app-initial.js @4019868  j5r → queryFn: sendRequest('model/list', {includeHidden:true, ...})
app-initial.js @4015763  l5r → 客户端过滤：hasConfiguredModelCatalog && !hidden 才算可见
app-shared.js  @2827171  W9t → model_catalog_json 是非空字符串
app-shared.js  @2827271  G9t → model_provider 指向存在的 [model_providers.<id>]
```

- `visibility: "list"` → `hidden=false`（可见）；`"hide"|"none"` → 不可见。
- `supported_in_api: false` → 该条目**从 model/list 直接消失**（不是隐藏）。
- `codex-auto-review` 被客户端硬编码排除。

### 2.3 目录条目的必填字段

`schema 校验是"逐字段报缺"的，可以用 `codex debug models` 迭代发现：

```
slug, display_name, supported_reasoning_levels, shell_type, visibility, supported_in_api,
priority, support_verbosity, truncation_policy, experimental_supported_tools
```

外加 `base_instructions` 或 `model_messages.instructions_template` **二选一必填**。
枚举取值：`shell_type ∈ default|local|shell_command|unified_exec|disabled`；
`visibility ∈ list|hide|none`；`truncation_policy.mode ∈ bytes|tokens`；
`effort` 是自由字符串。其余 39 个字段可选，多余的键会被忽略。

### 2.4 网关（wire_api = "responses"）实测契约

- 客户端只访问两条路由：`POST {base_url}/responses`（唯一热路径，`accept: text/event-stream`）
  与 `GET {base_url}/models`（仅 `codex doctor` 探活用，且**不带** Authorization）。
  没有 `/responses/{id}` 或 cancel 路由；取消 = 客户端断开连接。
- 请求恒为 `store:false`、`stream:true`、`include:["reasoning.encrypted_content"]`，
  且**从不发 `previous_response_id`**（每轮重发完整 transcript），网关可以完全无状态。
- 最小可用流是**两帧**：`response.output_item.done`（带完整文本的 message item）
  + `response.completed`（带 `usage.total_tokens`）。
- **最阴的坑：`response.output_text.delta` 只是装饰。**
  只发 delta、末尾 item 的 `content` 为空数组时，客户端 exit 0、token 计数正常、
  但**答案是空的**。文本必须落在 `item.content[].text` 里。
- SSE 的 `event:` 行可选；JSON 里的 `type` 字段必填且以它为准。
- 认证：`requires_openai_auth=false` 且无 key → 不带任何认证头；
  `env_key` 或 `experimental_bearer_token` → `Authorization: Bearer <值>`。
- 模型名：客户端把 body 的 `model` 原样发来，网关可任意改写（客户端不校验回显值）。
- 工具调用：网关发 `function_call`（arguments 是 JSON 字符串）或 `custom_tool_call`
  （input 是原始字符串）；客户端以 `function_call_output` / `custom_tool_call_output`
  按 `call_id` 回灌，实测往返成功。
- 重试放大：上游 500 会让客户端重试到 30 次请求 / 24.7 秒；4xx 只重试 6 次。
  **应用层错误应该返回 4xx，不要返回 5xx。**

### 2.5 `~/.gptplus` 与 `~/.codex` 的关系

- `~/.gptplus/config.json` 是 App 的唯一数据源（提供商、密钥、网关、注入开关）。
- `~/.codex/config.toml` 只被增量修改：顶层 `model` / `model_provider` /
  `model_catalog_json`，加一个带标记注释的 `[model_providers.gptplus]` 段。
  关闭注入时逐字节还原（原始值记录在 `~/.gptplus/backups/inject-state-*.json`）。
- 写入前备份到 `~/.gptplus/backups/config.toml.<时间戳>`，保留最近 10 份。

## 3. 目录布局

```
C:\ailuo_own\gpt++\
  package.json
  spec.md                      <- 本文件
  src/
    main/
      main.js                  <- Electron 主进程 / 窗口（Lead 负责）
      preload.cjs              <- contextBridge 暴露 window.gptplus（Lead 负责）
    core/
      paths.js                 <- 所有路径常量（A 负责）
      store.js                 <- 用户配置读写 ~/.gptplus/config.json（A 负责）
      catalog.js               <- 生成 model_catalog_json（A 负责）
      codex-config.js          <- 读写 ~/.codex/config.toml（A 负责）
      provider-client.js       <- 拉取 /models、连通性测试（A 负责）
      log-store.js             <- 网关日志 JSONL 持久化 + 启动回放（使用量页数据源）
      context.js               <- createContext() 组装所有模块（Lead 负责）
      ipc.js                   <- registerIpc({ipcMain, ctx, ...})（Lead 负责）
      gateway/
        server.js              <- HTTP 服务器 + 路由（B 负责）
        router.js              <- slug -> provider/model 解析（B 负责）
        responses.js           <- Responses 流式契约（B 负责）
        adapters/openai.js     <- OpenAI 兼容上游（B 负责）
        adapters/responses.js  <- OpenAI Responses 原生上游（透传，B 负责）
        adapters/anthropic.js  <- Anthropic Messages（B 负责，可选）
    renderer/
      index.html
      styles.css               <- C 负责
      app.js                   <- 主控制器/路由（C 负责）
      views/providers.js       <- 提供商 CRUD（C 负责）
      views/models.js          <- 模型列表/选择/测试（C 负责）
      views/settings.js        <- 网关开关、注入开关、端口（C 负责）
  tools/                       <- 逆向/验证脚本（Lead 负责）
  research/                    <- 桌面端机制调研报告
  scripts/
```

## 4. 用户数据（磁盘契约）

`~/.gptplus/config.json`（`~` = `C:\Users\ailuo`）：

```jsonc
{
  "version": 1,
  "gateway": { "enabled": true, "port": 18120, "host": "127.0.0.1", "token": "<随机32位>" },
  "inject": { "enabled": false, "catalogPath": null, "defaultModel": null },
  "modelOrder": [],
  "providers": [
    {
      "id": "p_xxx",              // 稳定 id
      "name": "梦幻API",
      "baseUrl": "https://mhapi.net/v1",
      "apiKey": "sk-...",
      "api": "openai",             // "openai" | "anthropic"
      "headers": {},               // 额外请求头
      "enabled": true,
      "models": [
        { "id": "gpt-6.1-sol", "label": "GPT-6.1 Sol", "enabled": true, "reasoning": true }
      ]
    }
  ]
}
```

`~/.codex/config.toml`：只增量维护 **我们自己的** 段落，其它内容原样保留：

- 顶层 `model`、`model_provider`、`model_catalog_json`
  （**仅在 inject.enabled 时写入；写在第一个 `[table]` 之前**，见 2.1 第 1 条）
- `[model_providers.gptplus]`（仅在 inject.enabled 时写入，`base_url` 跟随 `gateway.port`/`gateway.host`）

写入前必须备份到 `~/.gptplus/backups/config.toml.<时间戳>`，且备份保留最近 10 份。

`~/.gptplus/gateway.log`：追加式 JSONL，一行一条 `ctx.log()` 记录（配置写入提示 +
网关请求日志混在一起，字段与 `gptplus:logs:get` 返回的完全一致）。**这个文件是
使用量页的持久化载体**：启动时由 `log-store.js` 回放最近 `LOG_RING_SIZE`（20000）条，
所以退出重进后统计不再清零。回放时读不了/不该读的行一律跳过——进程被强杀时最后一行
可能是半条 JSON。条目数或文件体积超上限时，在启动阶段原子重写压缩到最近 `LOG_RING_SIZE` 条。

## 5. 模型 slug 规则（关键）

写入目录的 slug 必须能被网关反查回 (provider, model)：

```
<渠道名>__<modelId>
```

例：`梦幻API__gpt-6.1-sol`。渠道名中的空格会规范成 `-`；同名渠道会追加稳定 provider id 以避免冲突。`modelId` 中允许 `.`、`-`、`_`；`__` 为分隔符，解析时按**第一个** `__` 切分。网关仍兼容旧的 `<providerId>__<modelId>` slug。`display_name` 用 `模型label (提供商名)`。

模型整体显示顺序保存在 `modelOrder` 中，元素格式为 `<providerId>::<modelId>`；未记录的新模型自动追加到末尾。目录 `priority`、`context.models()` 和网关 `/v1/models` 均遵循该顺序。删除模型时必须同时移除它在 `modelOrder` 里的键，否则会留下指向不存在模型的陈旧条目。

> 注意：slug 必须避开官方模型名（如 `gpt-5.1-codex`）。客户端会用「slug 是否等于
> 已知官方名」来决定请求的 wire 形状；自定义 slug 走经典形状，这是我们要的。
> 另外注入目录后 `model` 必须等于目录里的某个 slug，否则输入框会显示生疏的原始名。

## 6. 网关契约

- 监听 `http://127.0.0.1:<port>/v1`。
- 认证：若 `gateway.token` 非空，要求 `Authorization: Bearer <token>`；不匹配返回 401。
- 路由：
  - `GET /v1/models` → `{object:"list", data:[{id:<slug>, object:"model", owned_by:<providerName>}]}`
  - `POST /v1/responses` → 见下
  - `GET /healthz` → `{ok:true, providers:<n>, models:<n>}`
- `POST /v1/responses`：
  1. 读 body.model（slug），经 router 解析出 provider + 真实 modelId。
  2. 未知 slug：若形如 `<providerId>__<modelId>` 且 provider 存在则直用；否则 404
     `{"error":{"message":"unknown model <slug>","type":"invalid_request_error"}}`。
  3. 记日志（时间、slug、provider、状态、耗时、token 用量）：网关侧留最近 200 条供
     `getLogs()` 调试，同时回调 `log()` 交给 `context.js` 落盘，见第 4 节 `gateway.log`。
  4. 交给 adapter：把 Responses 请求体转成上游请求；`stream` 为 true 时必须回
     `text/event-stream`，按 Responses 事件流回写。
  5. adapter 按 `provider.api` 三选一：
     - `openai`：转换为 `POST {base}/chat/completions`（绝大多数兼容中转）；
     - `responses`：**透传** `POST {base}/responses`，请求体只改写 model 为真实
       modelId，流式响应逐字节转发（`pipeResponsesSse`）。用于原生支持 Responses
       API 的上游：encrypted reasoning、原生事件序列不经重建；compat 重试跳过；
     - `anthropic`：转换为 Messages API。

## 7. IPC 契约（主进程 ↔ 渲染层）

`preload.cjs` 通过 `contextBridge` 暴露 `window.gptplus`。所有方法返回 Promise，
失败时 **reject** 一个 `Error`，`error.message` 为可直接展示的中文/英文短句。
所有会改磁盘的方法返回最新状态快照。

```ts
type Provider = {
  id: string; name: string; baseUrl: string; apiKey: string;
  api: 'openai' | 'responses' | 'anthropic'; headers: Record<string,string>; enabled: boolean;
  models: { id: string; label: string; enabled: boolean; reasoning?: boolean }[];
  hasKey?: boolean;            // 只读派生字段，渲染层只用于显示
};

type ProviderInput = Omit<Provider,'id'|'hasKey'> & { id?: string };

type ModelRef = { slug: string; providerId: string; providerName: string; modelId: string;
                  label: string; enabled: boolean; reasoning: boolean };

type Status = {
  providers: number; models: number; gateway: { enabled: boolean; running: boolean;
  port: number; url: string; startedAt: number|null };
  inject: { enabled: boolean; catalogPath: string|null; defaultModel: string|null };
  codex: { configPath: string; catalogPath: string; lastWrite: { at: number; ok: boolean; error?: string }|null };
};

window.gptplus = {
  getStatus(): Promise<Status>;
  listProviders(): Promise<Provider[]>;
  saveProvider(input: ProviderInput): Promise<Provider[]>;
  deleteProvider(id: string): Promise<Provider[]>;
  testProvider(id: string): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }>;
  testProviderModels(patch: { providerId: string; modelIds: string[] }): Promise<{
    ok: boolean; results: { modelId: string; ok: boolean; status?: number; latencyMs: number; error?: string }[]; error?: string
  }>;
  fetchRemoteModels(id: string): Promise<{ ok: boolean; models: {id:string;label:string}[]; error?: string }>;

  listModels(): Promise<ModelRef[]>;                    // 全部 provider 的全部模型（渠道名 slug 化，按 modelOrder）
  setModelEnabled(patch: { providerId: string; modelId: string; enabled: boolean }): Promise<Status>;
  deleteModel(patch: { providerId: string; modelId: string }): Promise<Status>;
                                                        // 删除单个模型：同步清掉 modelOrder 中的键与失效的默认模型；
                                                        // 若删掉最后一个启用模型，自动关闭注入并还原官方模型
  moveModel(patch: { providerId: string; modelId: string; direction: 'up'|'down' }): Promise<Status>;
  getGateway(): Promise<{ enabled: boolean; running: boolean; port: number; url: string;
                          modelBase: string; token: string }>;
  setGateway(patch: { enabled?: boolean; port?: number }): Promise<Status>;
  probeGateway(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;

  getInject(): Promise<{ enabled: boolean; catalogPath: string|null; defaultModel: string|null }>;
  setInject(patch: { enabled?: boolean; defaultModel?: string|null }): Promise<Status>;
  openCodexFolder(): Promise<{ ok: boolean; error?: string }>;
  openCodexConfig(): Promise<{ ok: boolean; error?: string }>;  // 用系统默认编辑器打开 config.toml

  onStatus(cb: (s: Status) => void): () => void;        // 返回取消订阅函数
  onLog(cb: (entry: LogEntry) => void): () => void;
};
```

`LogEntry = { at: number; level: 'info'|'warn'|'error'; msg: string;
               providerId?: string; model?: string; status?: number; ms?: number }`

## 8. 模块接口（core 层，CommonJS，无 Electron 依赖以方便单测）

所有 core 模块都必须是**纯 Node CommonJS**，不 `require('electron')`，可被 `node --test` 直接测试。

```js
// src/core/paths.js
module.exports = {
  HOME,                    // C:\Users\ailuo
  APP_DIR,                 // ~/.gptplus
  CONFIG_PATH,             // ~/.gptplus/config.json
  BACKUP_DIR,              // ~/.gptplus/backups
  CODEX_HOME,              // ~/.codex （支持 $CODEX_HOME 覆盖）
  CODEX_CONFIG_PATH,       // ~/.codex/config.toml
  CATALOG_PATH,            // ~/.gptplus/model-catalog.json
  LOG_PATH,                // ~/.gptplus/gateway.log
  ensureDirs(),            // 建目录，幂等
};

// src/core/store.js
createStore({ configPath }) => {
  load(): Config                       // 缺失/损坏时返回默认值并备份损坏文件
  get(): Config                        // 内存快照（深拷贝）
  save(cfg): Config
  update(fn): Config                   // fn(draft) 就地修改
  providers(): Provider[]
  getProvider(id): Provider | undefined
  upsertProvider(input): Provider      // 无 id 时生成 p_<8位>
  removeProvider(id): boolean
  newGatewayToken(): string
}

// src/core/catalog.js
createCatalog({ store, paths }) => {
  buildEntries(): { slug, entry }[]    // 生成目录模型条目（含必填字段与 base_instructions）
  buildCatalogJson(): object           // { models: [...] } 可直接 JSON.stringify 落盘
  writeCatalog(): { path, count, bytes }
  seedBaseInstructions(): string       // 优先从 ~/.codex/models_cache.json 取 gpt-5.5 的
                                       // base_instructions；失败时用内置精简版
  slugify(providerId, modelId, providerName?): string // `${providerName || providerId}__${modelId}`
  slugForProvider(provider, modelId, providers?): string // 生成最终渠道名 slug
  parseSlug(slug): { providerId, modelId } | null   // providerId 字段表示左侧渠道 key，按第一个 '__' 切分
}

// src/core/codex-config.js
createCodexConfig({ store, catalog, paths }) => {
  readText(): string                   // 不存在返回 ''
  backup(): string                     // 返回备份文件路径，保留最近 10 份
  applyInjection({ enabled, catalogPath, defaultModel }): { changed, backupPath }
                                       // 只增删我们自己的键/段，其它内容逐字保留
  isInjected(): boolean
}

// src/core/provider-client.js
createProviderClient({ store }) => {
  testProvider(id): Promise<{ ok, status, latencyMs, error }>       // GET {baseUrl}/models
  testProviderModels(id, modelIds): Promise<{ ok, results }>        // 按渠道协议逐模型发送最小生成请求，记录各自状态与延时
  fetchRemoteModels(id): Promise<{ ok, models: [{id,label}], error }>
}

// src/core/log-store.js
createLogStore({ logPath, maxEntries = LOG_RING_SIZE, maxBytes = 8 * 1024 * 1024 }) => {
  load(): LogEntry[]        // 回放磁盘历史（时间升序），首次运行/读失败返回 []；超上限时压缩文件
  append(entry): entry      // 入环 + 落盘一行 JSONL，环满丢最旧
  all(): LogEntry[]         // 浅拷贝，context.logs() 用它
}
```

`getStatus()` 的形状见第 7 节 `Status`；`ctx.status()` 由 Lead 在 `context.js` 里实现。

```js
// src/core/gateway/server.js
createGateway({ store, paths, log }) => {
  start({ port, host, token }): Promise<{ port, url }>
  stop(): Promise<void>
  stopSync(): void
  getState(): { running, port, host, url, startedAt }
  autoStart(): Promise<void>              // 读 store.gateway，enabled 且端口可用则启动
  probe(): Promise<{ ok, latencyMs, error }>   // 自测 GET /healthz
  on(event, cb): () => void                // 事件: 'log' -> LogEntry
}
```

`log(entry)` 由 `context.js` 传入，形如
`log({ level, msg, providerId?, model?, status?, ms? })`，缺 `at` 时由 context 补。

## 9. 分工与写入范围

| 模块 | 文件（写入范围） | 负责人 |
|---|---|---|
| 骨架/主进程/契约/最终验证 | `src/main/**`, `spec.md`, `tools/**`, `probe/**` | Lead |
| core（配置/目录/Codex 注入/IPC） | `src/core/!(gateway)/**` | A |
| gateway（HTTP/路由/适配器） | `src/core/gateway/**` | B |
| 渲染层（UI/CSS/交互） | `src/renderer/**` | C |

禁止改动范围外文件；跨模块问题通过消息沟通，不改别人的文件。
