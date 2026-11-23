# 语音流式改造 + 系统音频回环 · 验证报告

日期：2026-11-23
范围：P0 验证收尾（真实模型样本、全量回归）+ P1 系统音频回环（实现、真机端到端、真实 ChatGPT 页面验收）。P0-1 麦克风人工验收留给用户；P2/P3 不做。
环境：Windows 11 专业版，Electron 38.4.0，Node 22.23.2；SenseVoice int8 + Silero VAD（`C:\Users\ailuo\.gptplus\voice-models\sensevoice\`），worker 加载约 1.6–1.75 s。

---

## 1. 结论

- v1.7.12 候选复验：全量回归 **562 用例：560 通过 / 0 失败 / 2 环境跳过**（跳过项仍为：`models_cache.json` 不存在；真实 `~/.codex/config.toml` 处于注入状态）。语音相关单测 60/60，回环模块单测 5/5。
- 真实模型 5 样本验证：中文停顿、阈值、长连续样本**最终文本与期望完全一致**；软切截断假句号问题已修复并复验。英文/混排存在已记录的模型级边界，阈值无需调整。
- 回环真机端到端（播放 → 采集 → 转写）通过；**真实 ChatGPT 桌面端页面单击麦克风 → 回环转写 → 输入框追加**验收通过，文本与期望完全一致。
- 用户截图的 `Cannot access 'startLoopbackRecording' before initialization` 已定位：来自旧/中间态构建，当前源码与新一轮打包产物均无此问题（第 5 节）。

## 2. 单测与全量回归

```
v1.7.12 复验：`npm test` → # tests 562 / # pass 560 / # fail 0 / # skipped 2
```

历史明细日志 `probe/full-test-run-final.log` 对应此前 551 项运行；本次 v1.7.12 复验结果如上。新增覆盖：软切去标点 3 用例（`speech-segmenter.test.js`）、回环页面/桥接 8 用例（`voice-input.test.js`）、回环模块 5 用例（`voice-loopback.test.js`，fake electron 注入）。

注意：受限 PATH 的终端跑 `npm test` 前需补 `C:\Windows\System32\WindowsPowerShell\v1.0;C:\Windows\System32;C:\Windows;`，否则 codex-config 用例 spawn `powershell.exe` 失败（环境问题，非代码问题）。

## 3. 真实模型样本验证

样本：2 条云 TTS（zh 停顿 / zh 长连续）+ 3 条 Windows SAPI（SSML `<break>` 精确停顿：en / mixed / zh 阈值）。原始与 16 kHz 重采样版在 `probe/voice-samples/`（重采样工具 `probe/wav16k.cjs`，Electron OfflineAudioContext）。首轮结果 `verify-results.txt`，修复后最终结果 `verify-results-final.txt`。

| 样本 | 时长 | 模式 | 最终文本 | 判定 |
|---|---|---|---|---|
| cloud-zh-pauses | 8.1 s | 快速推送 | 今天天气不错。我们下午去公园散步吧。晚上想吃什么？ | ✅ 与期望一致；停顿 1082/1050 ms → 句号，问句 → 问号 |
| cloud-zh-long | 16.8 s | `--realtime` | 人工智能正在改变我们获取信息的方式。语音识别让输入变得更加自然，只需要说话就能把想法变成文字。随着模型越来越小，离线识别也能在普通电脑上流畅运行，既保护隐私，又不依赖网络。 | ✅ 与期望一致；5 分句含 2 次软切，缝上无假句号、无重复字 |
| sapi-zh-threshold | 6.6 s | 快速推送 | 今天天气不错，我们下午去公园。晚上想吃什么？ | ✅ 与期望一致；短停顿出逗号、890 ms 出句号 |
| sapi-en | 10.5 s | `--realtime` | The weather is lovely today. Shall we go for a walk in the park this afternoon. I heard there is a new coffee shop nearby. | ⚠️ 内容正确；问句被模型自带 `.` 压过问号规则（已知边界） |
| sapi-mixed | 8.5 s | 快速推送 | 帮我查一下明天去上海的高铁。最好上午出发。second class就可以。 | ⚠️ 内容正确；<500 ms 停顿不分段、模型自补 `。`；全角句号后接英文无空格（已知边界） |

落地延迟（`--realtime`，相对该句语音结束）：长样本 976 / 1379 / 1396 / 2162 / 1707 ms；英文 676 / 1169 / 1597 ms。软切段与挂起段要等下一段到达或收尾 flush 才定稿，延迟偏高属设计内；快速推送模式处理快于实时，延迟被钳为 0，不代表真机延迟。

### 3.1 本轮修复的三个问题

1. **verify 工具丢块**：快速推送 >10 s 样本超过 `STREAM_QUEUE_LIMIT=80` 被丢块（首轮长样本开头整段丢失）。工具已加 dropped 警告，长样本改用 `--realtime`。
2. **落地延迟 NaN**：`local-speech.js` 的 `segment` 事件未转发 worker 的 `startMs/endMs`。已补转发；工具延迟公式改为 `event.at - pushOffset - event.endMs`（pushOffset = 模型加载耗时）。
3. **软切假句号**（根因修复）：连续语音每 4 s 软切时，模型在截断处补 `。`，分句器原本信任模型标点，导致「…在普通。电脑上…」这类假句号。修复：软切段经 `stripTrailingPunct` 去掉模型补的句尾标点，交回真实停顿规则；`softCut` 标记沿 worker segments → 主进程事件 → 桥接 → composer 全链路传递。3 个新单测覆盖。修复后长样本 `--realtime` 复验：软切缝「说话就能」「普通电脑上」拼接无缝。

## 4. 系统音频回环（P1）

### 4.1 架构变体（与交接建议的差异）

交接建议「主进程 desktopCapturer + setDisplayMediaRequestHandler，页面增加 getDisplayMedia 分支」。实际实现把采集放在 **gpt++ 自己的隐藏 BrowserWindow**，不在 ChatGPT 页面里调 `getDisplayMedia`：ChatGPT 页面的采集请求由 ChatGPT 自身主进程处理，gpt++ 无法为它设置 handler。gpt++ 主进程对 `session.defaultSession` 注册自动批准 handler（第一块屏幕 + `audio:'loopback'`，仅 Windows），采集窗口内重采样 16 kHz PCM 后经 ipcMain **直推** `session.stream.push`（绕过 CDP）；页面只经 outbox 发 `loopback-start/end/cancel`，分句/字幕仍走原有 `streamAppend/streamCaption/streamDone`。麦克风与回环共用 `enterStreamRecording` 及后续全部通道。

### 4.2 真机端到端（模块级）

`npx electron tools/verify-voice-loopback.cjs probe/voice-samples/cloud-zh-pauses-16k.wav --language zh`：

```
采集时长: 9.98s，电平回调: 78 次，峰值 0.452，有声帧占比 53%
[分句 停顿 1050ms] 我们下午去公园散步吧。
[分句 停顿 1082ms] 晚上想吃什么？
最终文本: 今天天气不错。我们下午去公园散步吧。晚上想吃什么？
回环链路验证通过。
```

原始采集音频：`probe/loopback-capture.wav`（可用 verify-voice-stream 复核）。

### 4.3 真实 ChatGPT 桌面端页面验收

用当前源码重新打包（`npm run pack` → `dist\win-unpacked`，asar 内确认 v15 + voice-loopback），临时替换运行中的旧安装版后，对真实 ChatGPT 页面（CDP 9229）自动化验收：

1. v15 运行时注入成功（`__gptplusVoiceRuntime === 'gptplus-voice-input-v15'`）。
2. 单击麦克风按钮 → 进入回环录音态（`status:'recording', loopback:true`），**无 TDZ 报错**。
3. 播放中文样本 → 再单击停止 → 输入框追加文本：`今天天气不错。我们下午去公园散步吧。晚上想吃什么？`，与期望完全一致（PASS）。
4. 验收后已清空输入框测试文本，恢复空草稿。

### 4.4 排查记录（真机超时 → 修通）

| 现象 | 根因 | 修复 |
|---|---|---|
| 采集页 `mediaDevices` 不存在 | `data:` URL 在 Electron 38 不是安全上下文 | 改 `file://` 临时页（`os.tmpdir()/gptplus-voice-loopback/`），销毁时清理 |
| `file://` 后仍 12 s 超时 | 页面顶层 `var closed=false` 与只读 `window.closed` 冲突，strict 下首行即抛 TypeError，整段脚本失效 | 整段页面脚本包外层 IIFE |
| `spawn powershell.exe ENOENT` | 受限 PATH 找不到 powershell | verify 工具改绝对路径 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` |
| 工具退出码 0 但无结果、无 wav | 采集窗口是唯一窗口，`stop()` 销毁触发 Electron 默认 `window-all-closed` 退出 | 工具注册 `window-all-closed` 空处理 |
| 新构建启动后不注入 | 从受限 PATH 终端启动，应用继承受限 PATH，`findChatGptDebugPort` spawn powershell 失败 | 以完整 PATH 启动（正常用户环境无此问题） |
| 页面 `hidden:true` 导致录音被取消 | ChatGPT 窗口最小化；CDP `Browser.getWindowForTarget` 对该 MSIX 窗口返回 not found | user32 `ShowWindowAsync(SW_RESTORE)` + `SetForegroundWindow` 恢复窗口 |

诊断探针（`probe/loopback-debug*.cjs`）已完成使命并删除；`file://` + 自动批准 handler 免用户手势可行已被探针与真机验收双重证实。

## 5. 用户截图 TDZ 报错的结论

截图报错 `Cannot access 'startLoopbackRecording' before initialization`（窗口标题指向 `dist\win-unpacked` 的旧构建）。核查：

- 磁盘上现存所有构建（安装版 1.7.11、dist 各 1.7.3/1.7.10 产物）运行时均为 **v13，不含任何回环代码**，不可能抛出该错误；报错只能来自某个中间态源码的临时运行/构建。
- 当前源码中 `startLoopbackRecording` 是 `voicePageRuntime` 函数体内的**函数声明**（提升，无 TDZ）；页面测试用 `vm.runInNewContext` 执行与真机注入完全相同的 `buildVoiceInputScript` 产物并模拟单击，通过。
- 新一轮打包产物在真实 ChatGPT 页面单击验收通过（4.3），确认当前代码无此问题。

处置：已用当前源码重新 `npm run pack`，`dist\win-unpacked\gpt-plus.exe` 为修复后的可运行构建。安装版 1.7.11 未改动；正式升级需走签名发布流程（`npm run dist`），版本号由发布流程管理（仓库当前 1.7.10）。

## 6. 已知边界（不修，留档）

1. 英文 SAPI 问句：模型自带 `.` 压过问号规则（P2 标点模型可解）。
2. 混排样本 <500 ms 停顿：低于 VAD `minSilence` 不分段，模型自补 `。`；属 VAD 粒度与模型标点行为，调阈值会牺牲正常分句。
3. 全角句号后接英文不加空格：排版可接受。
4. 预览字幕可能抖动（如 `weatherather`、`Now we go` → 定稿 `Shall we go`）：预览是未定稿窗口解码，定稿以整段解码为准，属设计内。
5. 回环采集依赖系统默认输出设备且未静音；采集窗口 `ScriptProcessorNode` deprecation 警告无害。

## 7. 剩余工作

- **P0-1 麦克风人工验收**（需人对麦克风说话）：长按空格 0.4–0.7 s 出字幕、停顿标点、Esc 只回滚本次、连续 10 分钟、松开收尾。清单见交接文档第 7 节。
- P1 提供商模式流式、P2/P3 增强：按交接文档第 8 节留后续。

## 8. 复现命令与产物

```bash
npm test                                            # 全量回归（受限 PATH 先补系统目录）
node tools/verify-voice-stream.cjs 样本-16k.wav --language zh --realtime
npx electron tools/verify-voice-loopback.cjs 样本-16k.wav --language zh
npm run pack                                        # 重新打包 dist\win-unpacked
```

产物：`probe/voice-samples/verify-results-final.txt`（最终样本结果）、`probe/voice-samples/verify-results.txt`（修复前首轮对照）、`probe/loopback-capture.wav`（回环原始采集）、`probe/full-test-run-final.log`（全量回归）、`probe/pack-build.log`（打包日志）。