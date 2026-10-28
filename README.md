# gpt++

让 **ChatGPT 桌面客户端**（Windows，MSIX `OpenAI.Codex`）的模型选择器里出现你自己添加的模型。

你在 gpt++ 里填写提供商（名称 / Base URL / API Key / 模型列表），点一下「注入」，
ChatGPT 的模型下拉菜单里就会出现这些模型；选中后对话请求会经本机的 gpt++ 网关
转发到对应提供商。

```
ChatGPT 客户端 ──► 本地网关 127.0.0.1:18120 ──► 你的提供商
   (选择器显示           (识别 slug，          (OpenAI 兼容 / Anthropic)
    自定义模型)            改写模型名与鉴权)
```

## 为什么这样做

ChatGPT 桌面端内置 OpenAI 的 Codex 引擎，它的模型清单由配置里的
`model_catalog_json` 决定。gpt++ 做三件事：

1. 把你在界面上配好的模型写成一份符合引擎 schema 的目录 JSON；
2. 在 `~/.codex/config.toml` 顶部写入 `model` / `model_provider` / `model_catalog_json`
   三个顶层键，并追加一个指向本地网关的 `[model_providers.gptplus]` 段；网关令牌
   通过 `auth.command` 按需读取，不写进 Codex 配置；
3. 起一个本地网关，按模型 slug 把请求路由到真正的提供商。

改完重启 ChatGPT 客户端即可在选择器里看到。

## 快速开始

```powershell
npm install                 # 安装 Electron
npm start                   # 启动 gpt++
```

界面里：

0. **主页** 是默认视图，把「提供商 → 本地网关 → ChatGPT」三段链路画在首屏：哪一段没通、
   下一步该做什么都写在那里，注入开关也在第三个节点上。链路未通时底部提示条只给一个当前动作。
   「最近请求」会在模型与耗时之间用英文显示本次调用实际发给上游的思考强度（标签 `EFFORT`，值如 `high`）；
   没有显式档位时显示 `default`，悬停可以看到 ChatGPT 请求值与上游值的差异。
1. **提供商** → 添加提供商：填名称、Base URL（如 `https://api.deepseek.com/v1`）、API Key，
   点「从 /models 拉取」自动带出模型列表，或手动添加。点「测试连接」可选择模型逐个发送最小生成请求，查看每个模型是否可用及响应延时；未配置模型时会检查 `/models` 接口连通性。
2. **模型** → 打开「注入到 ChatGPT」开关（会先检查网关是否在跑）。模型行右侧可拖动调序，
   也可以单独删除某个模型；删掉最后一个启用模型时会自动还原官方模型并关闭注入。
3. 点「重启 ChatGPT 客户端」，然后在对话框的模型选择器里选择你的模型。
4. 左侧底部开启「开机自启动」后，可选择「仅 gpt++」或「gpt++ + ChatGPT」；选择组合启动时，Windows 登录后会在网关启动检查完成后通过系统应用入口唤起 ChatGPT 主窗口。已启用的旧版登录项会自动迁移，无需重新开关自启动。
5. **插件市场** → 按需安装、启用和配置随 gpt++ 发布的功能。目前提供「微信连接」「ChatGPT 用量信息栏」和「语音输入」：用量信息栏会在 ChatGPT 输入框下方显示生成速度、缓存命中率和上下文占用；语音输入会在输入框的模型选择器与发送键之间加入麦克风按钮，默认用本机 SenseVoice 离线识别，录音条、波形和停止按钮都在 ChatGPT 页面内，不会弹出 Windows 语音浮层；在输入框内长按空格 1.5 秒即可开始录音，松开自动转写；也可以在插件设置里改用支持 `/audio/transcriptions` 的 OpenAI 兼容提供商。
6. **微信连接** → 扫码登录个人微信后，每个微信联系人会映射到独立的 Codex 会话：在微信里直接发消息，由本机 Codex 在设定的工作目录里处理并回复。连接使用微信官方 iLink Bot API 长轮询，不需要公网 IP；可配置联系人白名单、工作目录、模型与沙箱权限。微信里发送「帮助」查看指令；发送「新对话」清空当前联系人的上下文，发送「状态」查看连接信息。也可以直接发送图片（带文字说明即可让 Codex 查看/修改），本次回合在工作目录中新生成或修改的图片会自动回传微信（最多 3 张，需要工作目录可写）。ChatGPT 任务开始/完成会即时通知，运行中每 5 分钟提醒一次；通知直接发到微信，不进入 Codex 上下文。

## 打包给别人安装

```powershell
npm install
# 正式发布：需要先设置受 Windows 信任的代码签名证书
$env:WIN_CSC_LINK = "D:\secrets\gptplus-code-signing.pfx"
$env:WIN_CSC_KEY_PASSWORD = "证书密码"
npm run dist
```

安装包会生成在 `dist/gpt-plus-<版本>-setup.exe`。这是按当前用户安装的 Windows NSIS 安装包，
不要求安装者拥有管理员权限；安装目录可以在安装时修改，桌面和开始菜单会创建快捷方式。
安装器内部程序名使用兼容 Windows 的 `gpt-plus.exe`，应用显示名称仍是 `gpt++`。

## GitHub 发布与自动更新

仓库地址：<https://github.com/ailuo04/gptplus>

推送版本标签后，GitHub Actions 会在 Windows runner 上构建安装包，并创建 GitHub Release：

```powershell
git tag v1.1.0
git push origin v1.1.0
```

已安装的 gpt++ 会在启动的同时检查 GitHub Release。发现新版本时只弹窗提示，不会自动下载；点击“暂不更新”后，左侧设置导航和设置页会持续显示更新提示，用户可以稍后手动点击“立即更新”。
更新使用 NSIS 安装包和 `latest.yml` 元数据；开发模式、冒烟测试和未打包运行不会执行更新检查。

设置页的“软件更新”还支持“查看历史版本”。它只列出 GitHub 上已发布、非预览、低于当前版本且同时包含 NSIS 安装包与 `latest.yml` 的版本。选择版本并确认后，程序会下载对应 Release，复用同一套签名校验和 NSIS 覆盖安装流程；回退只替换程序文件，不会删除 `~/.gptplus` 配置、提供商或 API Key。

第一版工作流使用未签名安装包。正式分发前应在 GitHub Actions 中配置代码签名证书，否则 Windows 可能显示“未知发布者”。

`npm run dist` 是正式发布命令：没有证书、证书路径不存在、或构建后签名不是 `Valid` 时会直接失败，
不会误生成可交付的未签名安装包。只做本机功能测试时使用 `npm run dist:unsigned`，该命令生成的包不应发给别人。
构建后也可以单独执行 `npm run verify:signature` 检查安装器和主程序的 Authenticode 状态。

安装包只包含 gpt++ 程序本身，不包含本机的 `~/.gptplus`、API Key 或 `~/.codex` 配置。
每台电脑首次运行时都会使用自己的用户目录，并在重启 ChatGPT 时通过 Windows 的
`Get-AppxPackage` 动态找到当前实际安装版本，不依赖用户名、盘符或固定版本号。
如果自动发现不到 ChatGPT，点击重启动作时可以选择该电脑上的 `ChatGPT.exe`，选择结果只保存在当前用户配置中。

重启和开机自启动都会通过 Windows 已注册的应用入口（AUMID）激活 ChatGPT，不会直接运行
`WindowsApps` 里的 exe；因此在不同的 ChatGPT 版本、不同盘符或不同安装位置下都会重新解析实际安装位置。
包安装场景会先确认应用入口可用，再结束旧进程，并等待新进程出现后才报告重启成功。

代码签名证书必须包含 Code Signing 用途和私钥，并由 Windows 默认信任的证书机构签发；自签名证书只能在
手动安装该证书的电脑上显示为可信，不能解决发送给普通用户时的“未知发布者”。证书文件和密码只通过环境变量
提供，不能放进仓库或安装包。签名可以消除“未知发布者”，但新下载程序仍可能因为 SmartScreen 尚未建立信誉而显示额外提示。

## 目录与数据

| 路径 | 内容 |
|---|---|
| `~/.gptplus/config.json` | 提供商、密钥、网关设置、注入开关（App 的唯一数据源） |
| `~/.gptplus/model-catalog.json` | 生成给客户端读的模型目录 |
| `~/.gptplus/backups/` | 每次改动前的 `config.toml` 备份（保留 10 份）与还原状态 |
| `~/.codex/config.toml` | 只被增量修改，注入关闭时逐字节还原 |

## 必须知道的三件事

1. **注入是整体替换。** 注入生效期间，ChatGPT 自带的 GPT 模型会从选择器里消失，
   换成你配置的模型。点「还原注入」即可恢复原状。
2. **改完要重启客户端。** 引擎按文件路径缓存模型清单，重启最省事。
3. **别把 `model_catalog_json` 写到文件末尾。** 它必须写在第一个 `[table]` 之前，
   否则会被当成 `[windows]` 段下的键而被静默忽略——gpt++ 已经帮你处理了这点。

## 开发

```powershell
npm test                    # 全部单测（core / gateway / renderer / 微信连接 / app-server）
npm run test:core           # 逐套跑更稳
npm run test:gateway
npm run test:renderer

node tools\verify-e2e.cjs       # 端到端：store → 目录 → codex 配置 → 客户端清单
node tools\verify-picker.cjs    # 决定性验证：用真实客户端 app-server 的 model/list 核对
node tools\live-client-test.cjs # 真机：真实客户端经本地网关拿回复
```

`test/` 是正式回归测试，`test/fixtures/` 保存验证所需的固定夹具，不属于可删除的临时文件。
`probe/` 只保存可重新生成的日志、截图和隔离测试数据；不运行验证时可以整体清空。
`dist/` 保存打包产物，其他 `dist-*/` 与 `build/*-preview/` 是可清理的临时构建目录。
应用运行所需的代码和资源均在 `src/`，实际用户配置位于上文列出的用户目录中。

架构、接口契约与实测结论见 [spec.md](spec.md)；
桌面端机制调研见 [research/desktop-model-picker.md](research/desktop-model-picker.md)
与 [research/codex-gateway-protocol.md](research/codex-gateway-protocol.md)；
验证记录见 [docs/verification.md](docs/verification.md)。

## 已知限制

- 目录是整体替换，无法做到"官方模型 + 自定义模型"同时出现在同一个选择器里。
- 注入状态与客户端共享 `~/.codex/config.toml`：如果你同时用其他工具改这个文件，
  关闭注入时 gpt++ 会按自己的备份还原自己写过的那几个键（其它内容不动）。
- 网关支持 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 三种入站协议，均可路由到 Responses、Chat Completions 或 Anthropic Messages 上游，提供 JSON 和 SSE 回包。Responses 到 Responses 保持原文透传。
- 转换覆盖文本、图片、系统约束、函数工具及工具结果、推理文本/签名、缓存 Token 和输出截断状态。跨协议不是所有厂商扩展字段的无损透传；音视频、文件及 Anthropic 服务端内置工具等尚无完整映射的输入会明确拒绝。Chat 多候选输出当前仅支持 `n=1`。
- 上游拒绝推理档位时不会删掉档位后伪装成功；可选兼容字段的重试只针对上游明确拒绝的字段。模型自身不支持的能力仍需由提供商返回错误。
- 网关只在 gpt++ 运行时监听；关掉 App 客户端就发不出请求。

