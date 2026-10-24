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
      views/usage.js           <- 使用量统计（C 负责）
      views/qq.js              <- QQ 远程助手独立页（C 负责）
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
      "api": "openai",             // "openai" | "anthropic"
      "enabled": true,
      "models": [
        { "id": "gpt-6.1-sol", "label": "GPT-6.1 Sol", "enabled": true, "reasoning": true }
      ],
      "secret": {
        "version": 1,
        "ciphertext": "<系统安全存储密文>"
      }
    }
  ]
}
```

提供商的 `baseUrl`、`apiKey`、`headers` 只在应用运行时内存中以明文存在，落盘时通过 Electron `safeStorage` 加密到 `providers[].secret`；`config.json` 不再保存这些字段的明文。旧版本含明文凭据的配置会在首次成功读取后迁移到该格式。若系统安全存储不可用，应用拒绝写入提供商凭据，避免回退到明文保存。

### 4.1 提供商配置传输文件

- 扩展名为 `.gptplus-providers`；外层 JSON 的 `format` 为 `gptplus-provider-config`，`version` 为 `3`。
- 文件本身保持可读取的 JSON。名称、模型列表、接口协议、启用状态、模型顺序和默认模型保持明文；每个提供商的 Base URL、API Key、请求头分别通过 Electron `safeStorage` 加密后以 base64url 写入 `secrets`。
- 导出和导入不要求、不接收、也不保存文件密码；文件不是整体加密包。系统安全存储不可用时直接拒绝导出或导入，不回退到明文。
- 文件绑定当前系统账户，不能作为跨电脑或跨 Windows 用户的可移植备份；界面必须明确提示这一点。导入在同一台电脑的同一系统账户下自动解密。
- 最大文件大小为 2 MiB。点击选择和拖拽都经相同的主进程扩展名、大小、结构、版本、系统安全存储和字段校验后生成脱敏预览；一次仅接受一个文件。
- 解密后的完整配置只在主进程导入会话中暂存（5 分钟过期），预览不返回 API Key、Base URL 或请求头。写入前确认新增、自动改名新增、覆盖或跳过；覆盖需要额外确认，目标变化后必须重新预览。
- 只接受当前版本 `3`；旧版密码文件、旧版整体密文、旧版明文 JSON 和不支持的加密参数直接拒绝，不做兼容迁移。
- 保留本机回环地址的无认证提供商兼容：显式空 API Key 仅允许 localhost、127.0.0.1、::1；缺少字段或远端提供商空 Key 都拒绝。
- 导入用同步内存事务暂存配置和默认模型更新，注入同步成功后只进行一次原子配置落盘。失败保留原提供商配置；注入外部文件恢复失败时单独报告。

安全边界：应用运行时必须解密并使用凭据；拥有当前系统用户的解密能力、设备管理员权限或调试权限的人仍可能获得运行时 API Key。API Key 复制按钮按用户要求保留，仅主动点击时写入剪贴板，这是“不进入剪贴板”规则的明确例外。历史明文备份、系统快照、崩溃转储及剪贴板历史无法由本功能保证擦除；迁移不会删除用户旧备份。运行时 Provider 数据结构和上游请求格式保持不变。

### 4.2 对等共享配置与远端模型

- `sharing.enabled` 与 `remoteSync.enabled` 是独立开关，默认均为 `false`；同步间隔默认 60 分钟，范围 5-1440 分钟。打开自动同步只定时读取已连接对端的 `/peer/v1/models`，不会调用本机上游的 `/models`。首次同步及自动同步关闭时仍可手动执行。
- `sharing.models` 只包含用户勾选的本机 `<providerId>::<modelId>`。共享端还会过滤已停用提供商/模型以及任何远端来源模型，避免再转发和递归。
- `sharing.clients[]` 每项有独立随机客户端 ID、显示名和 SHA-256 bearer token 摘要；明文 token 仅创建时由主进程写入系统剪贴板一次，不返回 renderer、不记录日志，撤销只删除该客户端摘要。接收端连接使用独立的 bearer token 与 URL；它们与本地 `gateway.token` 无关。
- `remoteSync.connections[]` 的 Base URL 与授权 token 仅在内存中解密使用，磁盘通过 Electron `safeStorage` 加密；不提供安全存储时拒绝保存。远端模型及同步状态保存在 `remoteSync.sources[]`，不写回本地 providers。
- 首次发现的远端模型以来源 ID、来源提供商 ID 和原始模型 ID 稳定区分，默认禁用；本机显示名、启用决定和隐藏记录由接收端独立保存。同步成功时缺失模型保留且标记未检测到；失败或不完整响应仅更新连接错误，不改变旧清单。恢复出现时保留本地偏好。删除只在本机隐藏，后续同步不会重新显示，可手动恢复。
- 所有新配置均可缺省读取为以上默认值；旧配置升级不改变既有提供商、模型、启用状态、模型顺序或注入设置。

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

### 6.1 对等端协议（peer/v1）

- `GET /peer/v1/models` 与 `POST /peer/v1/responses` 只使用共享端单独发放的 Bearer 授权；不接受 `gateway.token`。权限按客户端 ID 独立撤销。未授权返回 `401 UNAUTHORIZED`，共享关闭返回 `403 SHARING_DISABLED`，未发布模型返回 `404 MODEL_NOT_FOUND`，版本不兼容返回 `426 VERSION_UNSUPPORTED`。
- v1 清单包含 `protocolVersion:1`、`complete:true`、来源 `{id,name,revision,updatedAt}` 及模型 `{id,providerId,modelId,providerName,label,capabilities}`。`id` 固定为 `<providerId>::<modelId>`；能力标记包括 Responses、流式与推理。完整清单不包含 Base URL、API Key、请求头、客户端授权凭据或上游地址。
- 只有结构完整且通过校验的清单才可应用；模型数最多 10,000，清单最多 4 MiB，重复或格式错误条目使整次同步失败。`complete:true` 的空数组表示完整空清单。
- 接收端以来源哈希生成隔离 slug；Responses 请求经本地网关按原始共享 ID 鉴权转发到对应共享端。共享端检查该模型仍被明确发布并启用，然后使用共享端自己的 provider 配置与凭据访问上游。JSON/SSE 均透传；断连和超时通过 AbortSignal 传播。
- 默认网关仍只绑定 `127.0.0.1`。用户可在已加入 tailnet 的机器上手动运行 `tailscale serve --bg <网关端口>`，再把 Serve 显示的 HTTPS 设备地址填入对端连接。需自行启用 Tailscale HTTPS 证书并配置 ACL；不使用 Funnel，应用不安装、登录或改写 Tailscale。

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
  exportProviderConfig(input: { providerIds?: string[]|null }): Promise<{ canceled: boolean; count?: number }>;
  pickProviderImportFile(): Promise<{ canceled: boolean; fileName?: string; bytes?: Uint8Array }>;
  inspectProviderImport(input: { fileName: string; bytes: Uint8Array }): Promise<{ version: number; size: number; requiresPassword: false; portable: false }>;
  prepareProviderImport(input: { fileName: string; bytes: Uint8Array }): Promise<{ sessionId: string; preview: object }>;
  applyProviderImport(input: { sessionId: string; decisions: { sourceId: string; action: 'add'|'overwrite'|'skip' }[]; overwriteConfirmed?: boolean }): Promise<{ providers: Provider[]; counts: object; status: Status }>;
  cancelProviderImport(sessionId: string): Promise<{ canceled: boolean }>;
  testProvider(id: string): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }>;
  testProviderModels(patch: { providerId: string; modelIds: string[] }): Promise<{
    ok: boolean; results: { modelId: string; ok: boolean; status?: number; latencyMs: number; error?: string }[]; error?: string
  }>;
  fetchRemoteModels(id: string): Promise<{ ok: boolean; models: {id:string;label:string}[]; error?: string }>;

  getPeerState(): Promise<object>;                 // 仅返回脱敏共享、连接和来源快照
  setSharing(patch: { enabled?: boolean; name?: string; models?: {providerId:string;modelId:string}[] }): Promise<object>;
  addSharingClient(patch: { name?: string }): Promise<{ id:string; name:string; copied:boolean; state:object }>;
  revokeSharingClient(id: string): Promise<object>;
  setRemoteSync(patch: { enabled?:boolean; intervalMinutes?:number }): Promise<object>;
  saveRemoteConnection(patch: { id?:string; name?:string; baseUrl:string }): Promise<object>; // 授权 token 从主进程系统剪贴板读取
  setRemoteConnectionEnabled(patch: { id:string; enabled:boolean }): Promise<object>;
  deleteRemoteConnection(id:string): Promise<object>;
  syncRemoteNow(id:string): Promise<object>;
  setRemoteModelEnabled(patch: { providerId:string; modelId:string; enabled:boolean }): Promise<Status>;
  deleteRemoteModel(patch: { providerId:string; modelId:string }): Promise<Status>; // 本机隐藏
  restoreRemoteModel(patch: { providerId:string; modelId:string }): Promise<Status>;
  setRemoteModelLabel(patch: { providerId:string; modelId:string; label:string }): Promise<Status>;

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
                                        // 并默认选中；gptplus:chatgpt:relaunch 前会强制重写目录
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
createStore({ configPath, secretStorage? }) => {
  load(): Config                       // 缺失/损坏时返回默认值并备份损坏文件
  get(): Config                        // 内存快照（深拷贝）
  save(cfg): Config
  update(fn): Config                   // fn(draft) 就地修改
  transaction(cfg, apply): any         // 同步暂存；apply 成功后一次落盘，失败恢复内存与原文件
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

## 10. QQ 远程助手（任务中心 + OneBot 上报，v1.3.4）

目标：在 QQ 上接收 Codex 任务通知（完成/失败/每 N 分钟进度），并通过主人 QQ
的私聊命令远程控制本机 Codex（列任务、发新任务、插入要求、停止）。

### 10.1 配置（`config.json` 新增 `qqbot` 块）

```jsonc
{
  "qqbot": {
    "enabled": false,
    "apiUrl": "http://127.0.0.1:3000",   // NapCat HTTP 服务器地址
    "accessToken": "",                    // NapCat 访问令牌（可空）
    "eventToken": "",                     // 上报校验令牌（可空；非空时 /onebot/event 必须带）
    "notifyQq": "",                       // 接收通知的 QQ（4-14 位数字）
    "ownerQq": "",                        // 允许下发命令的 QQ（4-14 位数字）
    "progressMinutes": 5,                 // 进行中提醒间隔，1-120 分钟
    "codexPath": "",                      // codex.exe 显式路径（空则自动检测）
    "workspaceDir": "",                   // 新任务默认工作目录（空则用户主目录）
    "autoLaunch": false,                  // 开关打开/应用启动时自动拉起 NapCat
    "launchCommand": "",                  // 拉起命令（可含参数；win 下经 cmd /c 执行，兼容 .bat；空则自动识别）
    "launchQq": "",                       // 快速登录 QQ（4-14 位数字；作为 -q <QQ> 参数追加）
    "webuiPort": 0,                       // NapCat WebUI 端口（一键安装写入；0=未写）
    "webuiToken": ""                      // NapCat WebUI 令牌（一键安装写入，用于 app 内扫码登录）
  }
}
```

所有键可缺省；`normalizeQqBot` 负责清洗。令牌与 `gateway.token` 一样明文落盘
（本机回环服务，威胁模型一致）。

### 10.2 任务中心（`src/core/task-center.js`）

`createTaskCenter({ store, log, now?, spawnImpl? })`，两类任务统一注册表：

- **gateway 任务（g_ 前缀）**：由网关观察接口驱动，只能查看/停止。
  - `turnRequest({body,slug}) -> {turnKey}|null`：turnKey = sha1(instructions
    前 4000 字符 + 最后一条 user 消息)。同 turnKey 的重试/工具轮回并为一轮任务；
    手动停止后 90 秒冷却期内同 turnKey 的客户端重试不再重建任务。客户端对话后
    自动发起的「会话标题生成」请求（"You are a helpful assistant." 开头且要求
    输出 title JSON，见 `isTitleGenBody`）不建任务、不通知。
  - `turnResponse({body,slug,ok,status,hasToolCalls,text})`：status 200 且
    `hasToolCalls=false` -> 任务完成；499 或 stopRequested -> 已停止；其它失败
    仅标记 failing（客户端可能重试），由 stale sweep 收口（失败 3 分钟 / 空闲
    10 分钟）。
  - `requestStarted({turnKey,requestId,abort})` / `requestFinished({requestId})`：
    注册在途请求的断开句柄，`stopTask` 用它断开上游流。
- **exec 任务（e_ 前缀）**：`codex exec --json --skip-git-repo-check
  --sandbox workspace-write <prompt>` 子进程，stdout JSONL 解析（thread_id /
  agent_message / turn.completed / turn.failed 容错解析）。
  - `startExecTask({prompt,cwd})`、`followUp(id,text)`（运行中排队，结束后
    `codex exec resume <session|--last> <text>` 续跑）、`stopTask(id)`
    （Windows 用 `taskkill /PID <pid> /T /F` 结束进程树）。
  - codex 解析顺序：配置显式路径 > ChatGPT(MSIX) 内置
    `<pkg>/app/resources/codex.exe` > npm 全局
    `@openai/codex-win32-x64/vendor/.../bin/codex.exe` > PATH（.cmd 走 cmd.exe 包装）。
- `tick()`（30s 定时）：每任务按 `progressMinutes` 发 progress 通知 + stale 清扫；
  `listTasks() -> {running[], recent[]}`（含 id/kind/title/model/status/startedAt/
  endedAt/rounds/queued/lastText/lastError）；`stop()` 供应用退出时结束子进程。
- 事件：`on('notify', ({kind, task}))`，kind ∈ done|failed|stopped|stale|progress；
  任务中心不发消息，QQ 侧负责格式化与发送。

### 10.3 OneBot 接入（`src/core/qq-bot.js` + 网关路由）

> 运行形态：OneBot 框架（NapCat / Lagrange.OneBot / LLOneBot 等任一 OneBot 11
> 兼容端均可，免费开源）与 gpt++ 跑在同一台电脑，全部经 127.0.0.1 本机回环通信，
> 不需要服务器、公网或任何付费服务。担心风控时用 QQ 小号登录框架，
> 主号作为 notifyQq/ownerQq 收通知、发命令。

- 发送：`POST {apiUrl}/send_private_msg`（Bearer accessToken），连通性探测
  `GET {apiUrl}/get_login_info`；10 秒超时。
- 自动拉起（`launchNapCat`）：启动命令取 `launchCommand`，留空时
  `detectNapCatCommand()` 自动识别——候选目录为各盘根/用户目录/桌面/下载/
  LOCALAPPDATA 下的 `NapCat` 与 `NapCat*` 文件夹及 npm 全局目录，按已知入口名
  （NapCatWinBootMain.bat > launcher-user.bat > launcher.bat > … > napcat.cmd
  > NapCat 开头的 bat/cmd/exe 兜底，免管理员的 user 版优先）取第一个命中。
  spawn 前先 `syncNapCatConfig`：在 `<命令目录>/config/` 下没有 onebot11 配置时
  写入默认模板（HTTP 服务器 = apiUrl 端口 + accessToken；HTTP 上报 = 本地网关
  /onebot/event + eventToken；schema 对齐 NapCat 4.x，条目名 gptplus-api /
  gptplus-report），已有配置只同步这两个自有条目，不碰用户其它设置；NapCat
  登录后按模板生成 onebot11_<QQ>.json。随后先探测 `get_login_info`，已在线
  直接复用；离线时 `spawn(cmd.exe /d /s /c, 命令 [-q 快速登录QQ])`
  （NapCat 核心解析 -q/--qq；detached + unref + windowsHide，独立静默存活，
  不保留前台控制台），每 2.5 秒轮询一次
  `get_login_info`，120 秒内上线即成功，成功后按登录账号自动补全空的
  launchQq/notifyQq/ownerQq（autoLaunch 开且网关启用时顺带 enabled）。
  并发调用共享同一 Promise（去重）。触发点：应用启动（main.js 网关
  autoStart 后）、开关打开（ipc qqbot:set 后台）与渲染层「拉起 NapCat」
  按钮（ipc `qqbot:launch` 前台等待）；按钮只要求能解析到命令，其余两个
  还要求 `enabled && autoLaunch`。
- 接收：网关新增 `POST /onebot/event`（在网关令牌校验**之前**，由可选
  `eventToken` 自行校验：`Authorization: Bearer` / `access-token` /
  `X-Access-Token` / `?access_token=`）。NapCat 配置「HTTP POST 上报」指向
  `http://127.0.0.1:<网关端口>/onebot/event`。
- 只处理 `post_type=message && message_type=private && sender==ownerQq` 的文本
  与图片（raw_message 或 message 段数组：文本剥 CQ 码，图片取 image 段的
  图床直链，无直链时退回 NapCat 本地缓存文件）。**机器人只通报、不干预 Codex**：

```
帮助 | 任务/列表 | 状态
模型/model                  // 重新选择回答模型
新对话/重置                // 清空问答上下文与模型选择
<任意其它文本或图片>       // 手机问答：首次提问先回模型列表（回序号选择，5 分钟内有效），
                           // 选定后连续追问直接回答；POST 本地网关 /v1/responses
                           //（stream:false，Bearer gateway.token，带 X-Gptplus-Qq-Chat: 1
                           // 标记——网关任务观察据此跳过，聊天不会误报成 Codex 任务），
                           // 内存态多轮（保留 12 条，闲置 30 分钟或「新对话」清空），
                           // 不创建/停止/修改任何 Codex 任务
```

- 图片消息：收到 image 段（或 CQ:image 字符串兜底）立即下载图床直链
  （30 秒超时；单张 ≤5MB、单条 ≤4 张；类型按响应头/魔数/扩展名识别）转成
  data URL，随提问以 `input_image` 发给模型（openai/anthropic 适配器均支持）。
  只发图不配文字时用默认提问「请描述这张图片的内容」；选模型前收到的图片
  随待答问题暂存，回序号后一起发出（带图消息中的数字不当模型序号）。
  多轮上下文只保留最近 2 条带图消息的图片，更早的剔除以控制请求体大小；
  下载/超限失败会以「⚠ 命令执行失败」回复原因。

- 通知格式（只留任务名+耗时+结果）：完成（`✅「名」· 耗时\n回答`）、失败
  （+原因）、停止、已结束（空闲超时）、进行中（耗时+轮数）。

### 10.4 IPC（preload `window.gptplus`）

```ts
getQqBot(): Promise<{ enabled, apiUrl, accessToken, eventToken, notifyQq, ownerQq,
  progressMinutes, codexPath, workspaceDir, autoLaunch, launchCommand, launchQq,
  launch: { phase: 'idle'|'launching'|'online'|'failed', at, error, account },
  detectedLaunch: string,               // launchCommand 为空时自动识别到的启动命令（无则 ''）
  webhookUrl, gatewayRunning, codex: { path, source } | { path:'', error },
  install: NapCatInstallState }>;       // 一键安装状态快照（见 10.6）
setQqBot(patch): Promise<同上>;   // 开启时要求 notifyQq 已填、gateway.enabled
testQqBot(): Promise<{ api: {ok, account?, nickname?, error?}, sent: {ok, error?} }>;
launchNapCat(): Promise<{ ok, detected?, alreadyRunning?, account?, nickname?, error? }>;
installNapCat(): Promise<NapCatInstallState>;   // 启动/复用一键安装（并发去重），直到 done/failed 才返回
getNapCatInstallState(): Promise<NapCatInstallState>;
onNapCatInstall(cb): () => void;                // 事件 gptplus:qqbot:install，主进程节流推送
onQqLaunch(cb): () => void;                     // 事件 gptplus:qqbot:launch，拉起状态变化推送
getTasks(): Promise<{ running: TaskSnapshot[], recent: TaskSnapshot[], at: number }>;
```

### 10.5 边界与安全

- 网关默认只绑 127.0.0.1，上报路由只暴露给本机 NapCat；若用户改绑 0.0.0.0，
  必须设置 eventToken（设置页有提示）。
- 命令只认 ownerQq 的私聊；NapCat 不可达时通知发送失败只记日志，不影响网关。
- exec 任务继承注入的 `model_provider=gptplus` 配置；注入关闭时 codex 用官方
  登录态，行为不变。

### 10.6 一键安装（`src/core/napcat-install.js` + `napcat-webui.js` + `qr-code.js`）

QQ 远程页「一键安装」把装 QQ 桌面版 + 装 NapCat + 写配置 + 拉起登录串成一个
状态机（`createNapCatInstaller({store, qqBot, log, onEvent, fetchImpl, …})`，
全依赖注入）。安装目录固定 `%LOCALAPPDATA%\NapCat`（detectNapCatCommand 的
候选目录，自动识别可直接命中）。

阶段（phase）：`prepare → qq-check →（未装 QQ 时）qq-download → qq-install →
napcat-download → extract → configure → launch → done | failed`。

- **QQ 检测**：注册表 `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ` 的
  UninstallString 推导 QQ.exe（NapCat launcher 同款逻辑），失败兜底
  `%ProgramFiles%\Tencent\QQNT\QQ.exe`。
- **QQ 下载**：官网下载按钮背后的「彩虹配置」端点
  `cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/windowsConfig.js` 永远返回
  最新版直链（取 `ntDownloadX64Url`）；qqdl.gtimg.cn 不可达时换 dldir1.qq.com
  （同路径换 host）。
- **QQ 静默安装**：QQNT 安装器是 NSIS，`spawn(setup.exe, ['/S'])`（会弹一次
  UAC），装完轮询注册表键确认（10 分钟窗口）。
- **NapCat 下载**：GitHub Releases 的 `NapCat.Shell.zip`（latest 直链，约
  36MB；失败追加 ghproxy 镜像前缀），流式下载带进度/看门狗（120s 无进度中断）。
- **解压**：Windows 内置 bsdtar（`System32\tar.exe -xf`），先解压到
  `<installDir>.new-<hex>` 临时目录、校验 launcher-user.bat 存在后原子替换，
  避免半成品被自动识别误命中。无新依赖。
- **configure**：写 store（launchCommand=解压出的 launcher-user.bat、
  autoLaunch=true）；onebot11 配置仍由 launchNapCat 内的 syncNapCatConfig 写。
- **launch/登录**：先 launchNapCat（内含 -q 快速登录与 2 分钟在线等待），
  未上线则进入 WebUI 流程（`napcat-webui.js`）：
  - 启动 NapCat 前写入 `config/webui.json`（端口 6099 固定、令牌随机生成，
    port/token 存入 qqbot 配置）；已存在则读回真实值（NapCat 登录后会刷新 token）。
  - 认证：`POST /api/auth/login {hash: sha256(token+".napcat")}` →
    `data.Credential`，后续带 `Authorization: Bearer`；401 自动重读 webui.json
    重认证一次。
  - `GetQuickLoginListNew` 有历史账号 → `SetQuickLogin` 免扫码；
    否则 `GetQQLoginQrcode` 取登录 URL，经 `qr-code.js`（vendored
    qrcode-generator 生成矩阵 + 手写 1-bit PNG 编码，Node zlib）转 PNG
    data URL，随事件推送 → 渲染层弹扫码窗（qrImage 变化才重开弹窗，
    其余进度只更新弹窗文案：waiting_qrcode 提示扫码，qrcode_scanned 提示手机确认，
    initializing 提示登录初始化；`loginError` 原样展示，过期时调用
    `RefreshQRcode` 并等待新二维码 URL）。
  - 轮询 `apiTest`（OneBot get_login_info）为最终登录判据；WebUI 的
    `qrLoginAccepted` / `coreReady` 用于展示确认与初始化阶段，但不会代替
    OneBot 在线验证。只有上线后才 `markLaunchOnline` 并 `adoptLoginAccount`
    自动补全 launchQq/notifyQq/ownerQq；超时或 NapCat 返回登录错误均置
    `failed`，不会把未登录状态报告为成功。NapCat 以 detached + unref +
    windowsHide 启动，stdin/stdout/stderr 均忽略，不保留前台控制台。

事件 `{phase, percent, detail, error, account, qrImage, loginPhase, at}`
经 `onEvent` → main.js broadcast `gptplus:qqbot:install`；主进程节流
（phase/detail/loginPhase/qrImage 变化或 percent ≥1 才推）。任何阶段失败置
`failed`（error 带原因，界面可重试），不写 store。

拉起状态 `{phase: 'idle'|'launching'|'online'|'failed', at, error, account}`
的每次跃迁都经 qq-bot `setLaunch` 单一入口 → `onEvent` → main.js broadcast
`gptplus:qqbot:launch`（phase/account/error 都没变不重复推）；渲染层订阅后
实时刷新拉起芯片（「拉起中…/在线/失败」），不再依赖整页 reload。
