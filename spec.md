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
- 认证：`env_key` / `experimental_bearer_token` 会生成 `Authorization: Bearer <值>`；
  `auth.command` 可按需取得 bearer token。gpt++ 使用 `auth.command` 从本机配置读取
  网关令牌，不把令牌写入 Codex 配置，也不与 `requires_openai_auth`、`env_key` 或
  `experimental_bearer_token` 混用。
- 模型名：客户端把 body 的 `model` 原样发来，网关可任意改写（客户端不校验回显值）。
- 工具调用：网关发 `function_call`（arguments 是 JSON 字符串）或 `custom_tool_call`
  （input 是原始字符串）；客户端以 `function_call_output` / `custom_tool_call_output`
  按 `call_id` 回灌，实测往返成功。
- 重试放大：上游 500 会让客户端重试到 30 次请求 / 24.7 秒；4xx 只重试 6 次。
  **应用层错误应该返回 4xx，不要返回 5xx。**

### 2.5 `~/.gptplus` 与 `~/.codex` 的关系

- `~/.gptplus/config.json` 是 App 的唯一数据源（提供商、密钥、网关、注入开关）。
- `~/.codex/config.toml` 只被增量修改：顶层 `model` / `model_provider` /
  `model_catalog_json`，加一个带标记注释的 `[model_providers.gptplus]` 段及其
  `[model_providers.gptplus.auth]` 子段。认证命令从 `~/.gptplus/config.json` 读取当前
  网关令牌并仅通过标准输出交给 Codex；令牌本身不写入 Codex 配置。
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
      codex-cli.js             <- Codex CLI 定位（微信连接共用）
      codex-app-server.js      <- Codex app-server JSON-RPC 客户端
      weixin-connect.js        <- 微信 iLink 长轮询 / 二维码 / 会话映射
      task-monitor.js          <- ChatGPT 任务监听与 5 分钟进度通知
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
      views/weixin.js          <- 微信连接独立页（C 负责）
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

## 10. 微信连接（iLink + Codex app-server）

目标：用个人微信通过微信官方 iLink Bot API 连接本机 Codex；
每个微信联系人映射到一个独立的 Codex 会话（app-server thread），
在微信里发消息即可让 Codex 在该联系人的会话里执行并回复。

### 10.1 配置（`config.json` 的 `weixin` 块）

```json
{
  "weixin": {
    "enabled": false,                         // 连接是否应在启动时自动恢复
    "baseUrl": "https://ilinkai.weixin.qq.com",// iLink 网关
    "token": "",                              // 登录凭据（Bearer token，扫码后自动写入）
    "accountId": "",                          // 机器人账号，形如 xxx@im.bot
    "allowFrom": "",                          // 允许的微信用户 ID；空/`*` 允许全部，逗号分隔
    "routeTag": "",                           // SKRouteTag，仅网关要求时填写
    "workDir": "",                            // 工作目录；空 = 当前用户主目录
    "model": "",                              // 留空使用 Codex 当前默认模型
    "sandbox": "read-only",                   // read-only | workspace-write | danger-full-access
    "codexPath": ""                           // 留空自动查找独立 Codex CLI
  }
}
```

所有键可缺省，`normalizeWeixin` 负责清洗。首次升级时会把旧 `qqbot.workspaceDir`
与 `qqbot.codexPath` 迁移到 `weixin`，其它 QQ 配置直接丢弃。凭据与 `gateway.token`
一样明文落盘（仅当前用户可读的 `~/.gptplus`）。

### 10.2 模块划分

- `src/core/weixin-connect.js`：iLink 客户端、二维码登录、长轮询、消息过滤/去重、
  状态文件、每联系人 thread 映射、回复分片与失败回复。
- `src/core/codex-app-server.js`：Codex app-server 的最小 JSON-RPC 客户端
  （`initialize` → `thread/resume|start` → `turn/start`）。
- `src/core/codex-cli.js`：CLI 定位：显式配置 > npm 全局独立 CLI > PATH >
  桌面版托管 CLI > ChatGPT 内置。优先独立 CLI，避免桌面版把 app-server
  转交给运行中的 ChatGPT 进程导致「停止连接」无法结束服务。
- `src/core/task-monitor.js`：观察网关上的 ChatGPT 桌面端轮次，产生开始、
  5 分钟进度、完成/失败/结束事件；微信来源请求由网关过滤。

### 10.3 iLink 协议

- `GET  ilink/bot/get_bot_qrcode?bot_type=3`：获取登录二维码
  （`qrcode` + `qrcode_img_content`）。
- `GET  ilink/bot/get_qrcode_status?qrcode=...`：轮询扫码状态
  （`wait / scaned / confirmed / expired`）；请求带
  `iLink-App-ClientVersion: 1`，成功时返回 `bot_token / ilink_bot_id /
  baseurl / ilink_user_id`。
- `POST ilink/bot/getupdates`：长轮询，body 为
  `{ get_updates_buf, base_info: { channel_version } }`；响应携带
  `msgs / get_updates_buf / longpolling_timeout_ms`。
- `POST ilink/bot/sendmessage`：回复，`msg` 必须带 `to_user_id`、
  `client_id`、`message_type=2`、`message_state=2`、`item_list` 与
  **入站消息里的 `context_token`**；文本按 3800 字符分片，片间 100ms。
- 图片入站：`item_list[].type=2` 的 `image_item.media.encrypt_query_param`
  + `aes_key`（或 `image_item.aeskey` hex）→ CDN
  `novac2c.cdn.weixin.qq.com/c2c/download`，AES-128-ECB 解密；
  支持最多 4 张、单张 5MB。
- 图片出站：`POST ilink/bot/getuploadurl`（`filekey/media_type=1/to_user_id/
  rawsize/rawfilemd5/filesize/aeskey`）→ 响应优先使用 `upload_full_url`
  （兼容旧 `upload_param`）→ CDN `c2c/upload` 加密上传，
  取响应头 `x-encrypted-param` → `sendmessage` 的 `image_item`；
  `aeskey` 传 hex，`media.aes_key` 传 base64(hex ASCII)，`mid_size` 为
  填充后的密文大小。单张上限 10MB。
- 请求头：`Authorization: Bearer <token>`、
  `AuthorizationType: ilink_bot_token`、随机 `X-WECHAT-UIN`；
  配置了 `routeTag` 时带 `skroutetag`。
- 状态文件：`~/.gptplus/weixin-connect-state-<account>.json`（无账号时
  `weixin-connect-state.json`），保存 `getUpdatesBuf`、`threadIds`、
  `contextTokens` 与最多 512 条 `processedMessageKeys`；原子替换写入。
- 收消息只处理 `message_type=1 && message_state=2` 且发送者在
  `allowFrom` 内的文本/语音转写；超过 5 分钟的消息和已处理消息跳过。
  缺少 `context_token` 的消息只更新状态、不回复。

### 10.4 扫码登录

渲染层点「扫码登录 / 重新登录」→ IPC `weixin:qr:start` 获取二维码，
主进程用 `qr-code.js` 转 PNG data URL；弹窗每 1.5 秒调用
`weixin:qr:status` 轮询。确认后自动写入 `token / accountId / baseUrl /
routeTag`，并在 `allowFrom` 为空时填入 `ilink_user_id`；界面刷新为已登录。

### 10.5 微信指令

整条消息精确匹配时拦截（也接受 `帮助。`、`/help` 这类写法），不会进入 Codex：

- `帮助` / `指令` / `菜单` / `help` / `?` → 返回指令列表。
- `新对话` / `新会话` / `清空上下文` / `重置` / `new` / `reset` / `clear` →
  删除当前联系人的 `threadIds` 映射并回复确认；下一条消息新建 thread。
- `状态` / `status` / `当前会话` → 返回连接状态、账号、联系人、工作目录、
  当前模型、沙箱、会话 id 与已处理消息数。

正常提问（例如「帮助我改代码」「新对话 然后画图」）不会命中指令。
指令不启动 app-server，也不消耗模型调用；由于消息按顺序处理，当前 Codex
任务结束后才会执行排队中的指令。

### 10.6 ChatGPT 任务通知

- 新增 `src/core/task-monitor.js`，只观察经过本地网关、且不是微信来源的
  `/v1/responses` 轮次（ChatGPT 桌面端任务）。
- 新任务首个请求 → 立即发「▶️ ChatGPT 任务开始」；同一个 turnKey 的工具轮
  只累加轮次，不重复开始。
- 运行中每 5 分钟发一次「⏳ ChatGPT 任务进行中」（按任务启动时间计算）；
  任务完成、停止或失败收口后从运行表移除，不再发 5 分钟进度。
- 最终响应不含工具调用 → 立即「✅ ChatGPT 任务完成」，附带短结果；
  客户端中断（HTTP 499）→ 立即「🛑 已停止」；失败先等待客户端重试，
  5 分钟无重试才收口为失败；20 分钟无请求收口为「💤 已结束」。
- 微信 app-server 启动时追加
  `-c model_providers.gptplus.http_headers.X-Gptplus-Source=weixin`，
  网关同时用 `originator: gptplus-weixin` 兜底识别，避免微信自己的对话
  被当成 ChatGPT 任务反复通知。
- 通知通过 iLink `sendmessage` 直接发给微信联系人：优先 `allowFrom` 中第一个
  已有 `context_token` 的联系人；`allowFrom` 为空时用最近联系人。通知不写入
  任何 Codex thread、不增加 `processedMessages`、不进入 Codex 上下文。
- 只有走 gpt++ 本地网关的 ChatGPT 任务可被观察；直接使用官方模型或其它
  不经网关的请求不会产生任务通知。

### 10.7 Codex 会话

- 启动连接时要求 token 与存在的工作目录；`enabled` 置 true 后开始长轮询。
- 收到某联系人消息：
  1. 提取文本/语音转写和图片；图片保存到
     `~/.gptplus/weixin-media/`，以 `file://` URL 随文本作为
     app-server 的 `input[] = [{type:'text'}, {type:'image'}]` 发送；
  2. 按 `from_user_id` 从状态文件取已保存的 thread id；
  3. 调 app-server `thread/resume`；失败则删除映射并 `thread/start`；
  4. `turn/start` 发送文本/图片（`approvalPolicy: never`，可选 sandbox/model）；
  5. 收集 `item/completed` 的 `agentMessage` 文本，`turn/completed`
     或 `thread/status/changed(idle)` 收口；
  6. 回复末尾追加 `模型 · ctx NN%` 与压缩后的工作目录；
  7. 模型没有返回文字时回复「Codex 已完成处理，但没有返回文字内容。」。
- 图片交给模型前，网关对 `x-gptplus-source: weixin` 请求把
  `weixin-media/` 内白名单中的 `file://` 图片转成 data URL 再转发上游；
  目录外文件不读取（防止本机任意文件被发送）。
- 回合结束后扫描工作目录（深度/条目/目录黑名单限制），把本次新写入或修改的
  图片（png/jpg/jpeg/webp/gif/bmp，最多 3 张、单张 10MB）上传 iLink 并发回
  微信；只回传工作目录内的图片，需要沙箱可写。
- 图片会作为用户消息进入该联系人的 Codex 上下文；「帮助」「状态」等指令
  仍然不进入上下文。
- app-server 的审批/用户输入/工具调用请求统一拒绝（`decline` / 空答案 /
  `tool not available on this client`），避免微信侧无人确认而卡住。
- 单轮超时 600 秒；连接停止时会结束 app-server 进程树。
- 失败时给联系人回复首行原因（隐藏用户目录、截断 160 字），状态改为
  `retrying`，下一条消息会重新拉起 app-server。
- 状态字段：`state`（stopped/starting/running/retrying/stopping/error）、
  `message`、`accountId`、`lastPeerId`、`lastMessageAtMs`、
  `processedMessages`、`hasToken`。

### 10.8 IPC / preload

```js
getWeixin(): Promise<{ ...weixinConfig, status }>;
getWeixinStatus(): Promise<WeixinStatus>;
setWeixin(patch): Promise<{ ...weixinConfig, status }>;
startWeixin(): Promise<{ ok, error?, status }>;
stopWeixin(): Promise<{ ok, status }>;
startWeixinQr(patch): Promise<{ qrStatus, qrContent, qrImage, accountId, linkedUserId, hasToken }>;
getWeixinQrStatus(): Promise<同上>;
pickWeixinWorkDir(): Promise<string|null>;
pickWeixinCodex(): Promise<string|null>;
detectWeixinCodex(): Promise<{ path, source }>;
openWeixinLink(url): Promise<true>;
onWeixinStatus(cb): () => void;   // 事件 gptplus:weixin:status
```

- 保存时会校验 baseUrl 为 http(s)、sandbox 枚举；`enabled` 仅由启动/停止控制。
- 应用启动时若 `weixin.enabled && token`，主进程自动调用 `autoStart()`；
  退出时 `shutdown()` 停止长轮询与 app-server，但不改写 `enabled`。
- 渲染层不发起任何网络请求；二维码、状态与文件选择全部经 IPC。

### 10.9 安全与边界

- 只处理 `allowFrom` 白名单联系人的消息；白名单为空表示允许全部（与
  Codex++ 一致），界面已明确提示。
- 微信连接不使用网关的 `/onebot/event`，也不需要公网或额外端口。
- 图片内联只接受微信来源请求、只读取 `~/.gptplus/weixin-media/` 内的普通文件，
  拒绝符号链接、目录、超大文件和其它本地路径。
- 图片回传只扫描设置的工作目录，跳过 `.git`、`node_modules`、`.gptplus` 等
  目录，不读取系统目录或用户主目录中的无关图片。
- 微信凭据、状态文件与 Codex 配置都只保存在当前用户的 `~/.gptplus` /
  `~/.codex`，不写入安装包或日志（日志只记状态与错误原因）。
