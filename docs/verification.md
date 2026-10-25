# 验证记录

本文件记录 gpt++ 的机制验证与端到端验证。所有验证都在**隔离的 `CODEX_HOME`** 下进行，
用户的 `C:\Users\ailuo\.codex` 与 `C:\Users\ailuo\.gptplus` 未被改动
（验证前后 `config.toml` 的 LastWriteTime 保持 `2026/10/3 0:06:16`、Length 3176）。

## 一、历史验证记录

下表是早期验证记录（当时 74 个用例），不代表当前测试套件规模；当前结果以本文件后续复核记录及实际命令输出为准。

| 命令 | 覆盖内容 | 结果 |
|---|---|---|
| `npm test` | core 24 + gateway 22 + renderer 28 个单测 | **74 passed / 0 failed** |
| `node tools\verify-e2e.cjs` | store → 目录 JSON → codex 配置写入/还原 → 客户端解析 | **21/21** |
| `node tools\verify-picker.cjs` | 用**真实客户端** `app-server` 的 `model/list` 核对选择器数据源 | **16/16** |
| `node tools\verify-final.cjs` | **真实客户端** → **成品网关** → 假上游：纯文本 + 工具往返 + 鉴权 + 404 | **16/16** |
| `node tools\live-client-test.cjs` | 真实客户端经原型网关拿到回复 | **PASS** |
| Electron 冒烟（`--smoke-dump/--smoke-shot/--smoke-view`） | 三个页面真实渲染、无运行期错误、17 个 IPC 键齐全 | **PASS** |

### verify-picker 的输出（决定性证据）

```
PASS  model_catalog_json 是顶层键且在首个 [table] 之前
PASS  自定义模型对选择器可见（hidden=false）
--- model/list (includeHidden=true) 返回 3 条 ---
   p_840a2a73__gpt-6.1-sol          hidden=false default=true  display="GPT-6.1 Sol (梦幻API)"
   p_840a2a73__claude-sonnet-4.5    hidden=false default=false display="Claude Sonnet 4.5 (梦幻API)"
   p_fbbe8341__qwen3-coder:30b      hidden=false default=false display="Qwen3 Coder 30B (本地 Ollama)"
```

`model/list` 就是模型选择器读取的接口，所以这等于证明了"自定义模型会出现在选择器里"。

### verify-final 的输出（真实链路）

```
PASS  真实客户端经成品网关拿到纯文本回复（exit 0 且输出正确）  -- exit=0 out="FINAL-OK"
PASS  上游收到的是真实 modelId（不是 slug）                    -- demo-model
PASS  上游收到提供商自己的 API Key                             -- Bearer sk-upstream-secret
PASS  工具调用：客户端执行工具并回灌第二轮请求                  -- upstream rounds=2
PASS  工具调用：第二轮把工具结果以 role=tool 回灌               -- system,user,user,assistant,tool
PASS  工具调用：客户端最终拿到 TOOL-DONE                        -- exit=0 out="TOOL-DONE"
PASS  未知模型返回 404 + invalid_request_error
PASS  缺少 token 时 /v1/models 返回 401
```

## 二、核心机制（逆向 + 实测）

目标客户端：MSIX `OpenAI.Codex` 26.930.2377.0，显示名 **ChatGPT**，
内置引擎 `resources\codex.exe` = `codex-cli 0.159.0-alpha.12.1`。

### 模型选择器的数据来源

```
app-initial.js @4019868  j5r → queryFn: sendRequest('model/list', {includeHidden:true, ...})
app-initial.js @4015763  l5r → 客户端过滤：hasConfiguredModelCatalog && !hidden 才算可见
app-shared.js  @2827171  W9t → model_catalog_json 是非空字符串
app-shared.js  @2827271  G9t → model_provider 指向存在的 [model_providers.<id>]
```

### 四条硬约束

1. **`model_catalog_json` 必须写在第一个 `[table]` 之前**，否则会被解析成
   `windows.model_catalog_json`，引擎只打一行警告然后静默忽略。
   （`tools/verify-picker.cjs` 对此有专门断言）
2. **注入是整体替换**：生效期间内置 GPT 模型从选择器消失。
3. **一个坏条目废掉整份目录**，空 `models` 数组同样回退到内置列表。
   → 所以 `context.syncInjection()` 里加了"拒绝写出空目录"的守卫。
4. **改完必须重启客户端**（react-query key 只含目录路径，默认缓存 5 分钟）。

### 目录条目必填字段（用 `codex debug models` 逐个报错迭代出来）

```
slug, display_name, supported_reasoning_levels, shell_type, visibility, supported_in_api,
priority, support_verbosity, truncation_policy, experimental_supported_tools
```

外加 `base_instructions` 或 `model_messages.instructions_template` 二选一必填。
`supported_in_api:false` 的条目会从 `model/list` **直接消失**（不是隐藏）。

### 网关（`wire_api = "responses"`）实测契约

- 热路径只有 `POST {base_url}/responses`（`accept: text/event-stream`）；
  `GET {base_url}/models` 只被 `codex doctor` 探活用且不带 Authorization。
- 请求恒为 `store:false` / `stream:true`，**从不发 `previous_response_id`**（每轮重发全量），
  所以网关可以完全无状态。
- 最小可用流是两帧（`response.output_item.done` + `response.completed`）；
  **但只发 `output_text.delta` 而末尾 item 的 `content` 为空 → 答案是空的**，
  文本必须落在 `item.content[].text`。
- 应用层错误应返回 **4xx**：上游 500 会让客户端重试 30 次/24.7 秒。

## 三、过程中修掉的真实缺陷

| 缺陷 | 发现方式 | 修复 |
|---|---|---|
| `base_url` 的 host 硬编码、端口不跟随设置 | `verify-picker.cjs` 断言 | 跟随 `store.gateway.host/port`，并支持显式覆盖 + host/port 归一化 |
| 模型页渲染出字面量 `null` | Electron 冒烟截图肉眼发现 | `replaceChildren(...[...].filter(Boolean))` |
| 空目录会写出 `{"models":[]}` 并静默回退 | 调研结论 + `context.js` 加固 | `syncInjection` 拒绝写出空目录并保留上一份 |
| Codex provider 静态 bearer 字段 | Codex 官方配置参考 | 改用 `auth.command` 从 gpt++ 本机配置按需读取令牌 |
| `npm test` 在 Node 26 下裸目录不展开 | 实跑 | 改为 `node --test --test-concurrency=1 "test/**/*.test.js"` |
| `SseWriter.end()` 未 `res.end()` 导致挂住 | gateway 单测 | 已修 |

## 四、仍未验证 / 已知限制

- **桌面端 Electron UI 的模型下拉是否 100% 复用 `model/list` 的结果**：从代码路径看是
  （`j5r` 的 queryFn 就是 `model/list`），且我们已验证该接口返回正确内容；
  但整个 Electron 窗口的可视化确认需要用户重启客户端后肉眼确认一次。
- **Anthropic 适配器**只有单测覆盖（mock 上游），没有真机验证。
- **推理（reasoning）事件的 item 结构**未经真机验证（假上游不返回推理内容）。
- 上游 400 时网关会自动降级重试一次（去掉 `reasoning_effort` 等可选参数）。
- 注入与客户端的 `config.toml` 共享：若同时有别的工具改这个文件，
  关闭注入时 gpt++ 按自己的状态文件还原自己写过的键，其它内容不动。
