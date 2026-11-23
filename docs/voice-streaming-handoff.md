# 语音输入流式改造 · 技术交接说明

更新日期：2026-11-23（P0 验证收尾 + P1 系统音频回环已完成）
范围：`gpt++` 语音输入插件（本地 SenseVoice 引擎）
状态：流式改造 + 系统音频回环已实现；v1.7.12 候选全量回归 562 用例 560 通过 / 0 失败 / 2 环境跳过；真实模型中英样本验证、回环真机端到端验证、**真实 ChatGPT 桌面端页面回环验收**均通过（详见 `docs/voice-streaming-verification.md`）。**仅剩 P0-1 麦克风人工验收**（需人对麦克风说话，见第 7 节清单）。

---

## 1. 改造目标

| 问题 | 目标 |
|---|---|
| 必须等整段语音结束才出字 | 说话/播放过程中就能看到逐步转写 |
| 断句、标点混乱（`你好 ，今天`） | 按真实停顿分句，自动补 `，。？` |
| 识别准确率偏低 | 减少 VAD 边界截断、长句误切、语言逐段翻转 |
| "播放听力素材"占用麦克风 | Windows 单击麦克风改为系统音频回环，不采麦克风 |

改造前链路：`MediaRecorder 整段录制 → 停止 → decodeAudioData → WAV → base64 → 一次性识别 → insertText`
改造后链路：`16 kHz PCM 128 ms 分块 → 主进程背压 → VAD 分段 + 增量解码 → 稳定分句追加 + 实时字幕`

---

## 2. 文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `src/core/speech-segmenter.js` | 文本整形、停顿定标点、微片段合并、中英混排、软切段去模型补标点（纯函数 + 有状态分句器） |
| `src/core/voice-loopback.js` | 系统音频回环采集（仅 Windows）：gpt++ 主进程隐藏窗口 + `setDisplayMediaRequestHandler` 自动批准 + 16 kHz PCM 经 IPC 直推流式会话 |
| `test/speech-segmenter.test.js` | 分句/标点/软切单测 |
| `test/local-speech-worker.test.js` | 流式会话单测（假 VAD/假解码，无需模型） |
| `test/voice-loopback.test.js` | 回环模块单测（fake electron，5 用例） |
| `tools/verify-voice-stream.cjs` | 真实录音验证工具，打印预览/分句/停顿/落地延迟；长样本用 `--realtime` |
| `tools/verify-voice-loopback.cjs` | 真机回环验证工具：播放 WAV → 回环采集 → 真实模型转写，原始音频存 `probe/loopback-capture.wav` |
| `docs/voice-streaming-verification.md` | 本轮验证报告（样本结果、回环排查记录、已知边界） |

### 修改

| 文件 | 改动 |
|---|---|
| `src/core/local-speech-worker.js` | 流式会话；批量路径复用同一套分段/分句；`segments` 数组携带 `softCut` 标记 |
| `src/core/local-speech.js` | `startSpeechStream`（音频窗口、背压、超时、错误回传）；`segment` 事件转发 `startMs/endMs`（落地延迟计算依赖） |
| `src/core/voice-input.js` | 页面 PCM 采集、实时字幕、稳定前缀追加、取消回滚；桥接 140 ms 高频轮询；运行时 v15：单击 listen 模式走回环（`startLoopbackRecording`），主进程 `loopbackReady` 后与麦克风共用 `enterStreamRecording`；`softCut` 全链路传递 |
| `src/core/plugin-manager.js` | 插件说明文案（Windows 单击 = 转写系统声音） |
| `package.json` | `asarUnpack` 增加 `src/core/speech-segmenter.js` |
| `README.md` | 功能说明与验证命令 |
| `test/voice-input.test.js` | 脚本断言改 7 参；回环页面/桥接测试；harness 增加 loopback/micCalls/outbox/fireTimer |

---

## 3. 关键函数位置

| 位置 | 说明 |
|---|---|
| `src/core/speech-segmenter.js:106` `stripTrailingPunct` | 软切段去掉模型在截断处补的句尾标点，交回真实停顿规则 |
| `src/core/speech-segmenter.js:186` `createSegmentComposer` | 分句器：挂起最后一段，等下一段起始时间到达后定标点 |
| `src/core/local-speech-worker.js:234` `createStreamSession` | 流式会话：VAD 边界 + 自维护采样缓冲 + 预览解码 + 软切 |
| `src/core/local-speech.js:429` `startSpeechStream` | 主进程流控制器：`push(buffer)` / `end()` / `cancel()` |
| `src/core/voice-loopback.js:119` `createLoopbackCapture` | 回环采集：隐藏窗口 + handler 自动批准 + IPC 收 PCM/电平；`electronImpl` 可注入供单测 |
| `src/core/voice-input.js:567` `appendStreamText` | 稳定分句写入输入框（只追加） |
| `src/core/voice-input.js:707` `enterStreamRecording` | 进入录音态（波形/计时/10 分钟上限），麦克风与回环共用 |
| `src/core/voice-input.js:723` `startLoopbackRecording` | 单击回环：只发 `loopback-start`，等 `loopbackReady`，12 s 等待超时 |
| `src/core/voice-input.js:754` `startStreamRecording` | 麦克风 16 kHz 采集与设备约束 |
| `src/core/voice-input.js:2204` `startVoiceInputBridge` | 页面 ↔ 主进程桥接；`loopback-start` 触发 `startSessionLoopback`，PCM 直推 `session.stream.push` |

---

## 4. 协议与数据流

麦克风路径：

```
页面 ScriptProcessor(2048 samples @16k)
  → outbox: {type:'pcm', id, data(base64)}
  → 桥接 140ms 轮询 takeOutbox()
  → stream.push(Buffer)  [4 块在途窗口]
  → worker: stream-audio → VAD(512 窗口) → segment/partial
  → 主进程分句器 push(segment) → streamAppend(稳定分句)
  → 页面字幕 streamCaption(稳定/未定稿)
  → 停止时 outbox 追加 {type:'end'} → worker flush → stream-done → streamDone
```

回环路径（Windows 单击，**不经页面采集、不经 CDP 传音频**）：

```
页面单击 → outbox: {type:'loopback-start', id} → 桥接 startSessionLoopback
  → gpt++ 隐藏 BrowserWindow（file:// 临时页）getDisplayMedia
  → session.defaultSession handler 自动批准 {video:第一块屏幕, audio:'loopback'}
  → 采集窗口 ScriptProcessor → ipcMain 直推 session.stream.push（绕过 CDP）
  → onStarted → 页面 loopbackReady → enterStreamRecording（与麦克风共用）
  → onLevel → streamLevel 驱动波形；分句/字幕仍走 streamAppend/streamCaption/streamDone
  → 停止：页面 {type:'end'} → 桥接停采集（先 IPC 停止信号，300ms 兜底 destroy）→ worker flush
```

消息类型：`stream-start / stream-audio / stream-end / stream-cancel`（主→worker）；`stream-open / ack / partial / segment / stream-done / stream-error / stream-closed`（worker→主）。页面 outbox 新增 `loopback-start`；主进程→页面新增 `loopbackReady / streamLevel`。

**为什么不在 ChatGPT 页面里调 `getDisplayMedia`**：该请求由 ChatGPT 自己的主进程处理，gpt++ 无法为它设置 handler，也无法保证返回回环音频。这是交接文档 P1 建议的可行变体：采集放在 gpt++ 自己的隐藏窗口，页面只负责发起/停止与展示。

---

## 5. 关键参数（改行为先看这里）

| 参数 | 值 | 位置 |
|---|---|---|
| 采集采样率 / 分块 | 16000 Hz / 2048 样本（128 ms） | `voice-input.js` `PCM_RATE` `PCM_CHUNK`；`voice-loopback.js` 同名常量 |
| 桥接轮询 | 录音/转写 140 ms，其余 350 ms，隐藏 1800 ms | `voice-input.js` `STREAM_POLL_MS` |
| outbox 上限 | 240 块（约 30 s） | `OUTBOX_LIMIT` |
| VAD | threshold 0.5，minSpeech 0.25 s，minSilence 0.5 s，window 512 | `local-speech-worker.js` `createTranscriber` |
| 首/尾补白 | 120 ms / 150 ms（每段） | `STREAM_DEFAULTS` `headPadMs` `tailPadMs` |
| 预卷 | 180 ms（仅预览） | `prerollMs` |
| 长语音软切 | 每 4 s，在最近 900 ms 最低能量 20 ms 帧处切；软切段 `stripTrailingPunct` | `maxSegmentMs` `quietCutWindowMs` |
| 预览解码 | 最短语音 700 ms，间隔 240–1200 ms 自适应，窗口 5 s | `minPartialSpeechMs` `partial*` |
| 标点阈值 | 停顿 ≥850 ms 句号；300–850 ms 逗号；<300 ms 不加 | `speech-segmenter.js` `PERIOD_PAUSE_MS` `CLAUSE_PAUSE_MS` |
| 碎片合并 | ≤2 字且 <420 ms 并入下一句 | `speech-segmenter.js` `FRAGMENT_*` |
| 连续录音上限 | 10 分钟 | `MAX_STREAM_MS` |
| 收尾超时 / 批量超时 | 30 s / 120 s | `local-speech.js` `STREAM_END_TIMEOUT_MS` |
| 回环启动超时 / 停止兜底 | 12 s / 300 ms | `voice-loopback.js` `START_TIMEOUT_MS` `STOP_GRACE_MS` |
| 回环 handler | 自动批准第一块屏幕 + `audio:'loopback'`，`useSystemPicker:false`；标记挂 session 防重复注册 | `voice-loopback.js` `createLoopbackCapture` |
| verify 工具队列上限 | 80 块（约 10 s），超出丢块并警告 | `tools/verify-voice-stream.cjs` `STREAM_QUEUE_LIMIT` |

---

## 6. 不可破坏的约定

1. **已写入输入框的文字永不回改**。未定稿内容只出现在字幕条；输入框只做追加。这是避免 ProseMirror 事务/撤销栈被反复改写的前提。
2. **取消只回滚本次会话**。`rollbackSession` 会校验插入片段是否仍然匹配，不匹配就放弃回滚，宁可留字也不误删用户原文。
3. **注入脚本必须自包含**。`voicePageRuntime` 会被 `toString()` 后注入页面，禁止在其中 `require` 或引用模块作用域变量。
4. **改页面运行时代码必须 bump `RUNTIME_KEY`**（当前 `gptplus-voice-input-v15`），否则旧脚本不会被替换。
5. **`speech-segmenter.js` 必须保留在 `asarUnpack`**。worker 运行在 `app.asar.unpacked/src/core/`，从该目录 `require('./speech-segmenter.js')` 找不到 asar 内的文件。`voice-loopback.js` 只在主进程用，留在 asar 内即可。
6. **插件配置结构未变**（仍是 `engine/providerId/model/language/spaceHoldMs`），不要为流式/回环新增必填字段，否则会破坏 `core.test.js` 的 deepEqual 断言与旧配置兼容。
7. **提供商/系统听写路径保持整段转写**，不要假设它们有流事件。
8. **回环采集页必须 `file://` 加载且整段脚本包在外层 IIFE 里**。`data:` URL 在 Chromium 不是安全上下文（`mediaDevices` 不暴露）；页面顶层 `var closed` 会与只读的 `window.closed` 冲突，strict 模式下赋值即抛 TypeError 使整段脚本失效。临时页写 `os.tmpdir()/gptplus-voice-loopback/`，窗口销毁时清理。
9. **不要在 ChatGPT 页面里调 `getDisplayMedia`**（handler 不可控，见第 4 节）。回环 PCM 由采集窗口 ipcMain 直推流式会话，不要改回经 CDP/outbox 传音频。

---

## 7. 验证方式

```bash
# 1) 语音相关单测（无需模型）
node --test test/speech-segmenter.test.js test/local-speech-worker.test.js test/voice-input.test.js test/voice-loopback.test.js

# 2) 全量回归（受限 PATH 的终端需先补系统目录，codex-config 用例会 spawn powershell.exe）
npm test

# 3) 真实模型 + 真实录音（需 16 kHz 单声道 PCM16 WAV；>10 s 样本必须 --realtime）
node tools/verify-voice-stream.cjs 录音.wav --realtime

# 4) 真机回环端到端（Electron 运行；播放样本同时采集转写）
npx electron tools/verify-voice-loopback.cjs 样本-16k.wav --language zh
```

当前结果（2026-11-23，详见验证报告）：

- 语音相关单测 60/60 通过，回环模块单测 5/5 通过。
- v1.7.12 候选全量 562 个用例：560 通过、0 失败、2 个环境跳过（`models_cache.json` 不存在；真实 `~/.codex/config.toml` 处于注入状态）。
- 真实模型 5 样本（2 云 TTS + 3 Windows SAPI 带 SSML 精确停顿）：中文停顿/阈值/长连续样本最终文本与期望完全一致；软切修复后长样本 `--realtime` 复验通过。英文/混排样本存在已记录的模型级边界（见报告）。
- 回环真机端到端：播放 8.1 s 中文样本 → 采集 9.98 s（峰值电平 0.452，有声帧 53%）→ 转写「今天天气不错。我们下午去公园散步吧。晚上想吃什么？」，分句停顿 1050/1082 ms 正确定句号、问句出问号。
- **真实 ChatGPT 桌面端页面验收**：新打包版注入 v15 → 单击麦克风进入回环录音态（无 TDZ 报错）→ 播放样本 → 输入框追加文本与期望完全一致。

手动验收清单（**仅剩此项，需人对麦克风说话**）：

1. 长按空格说话：0.4–0.7 s 内出现浅色字幕，停顿后整句进入输入框。
2. 停顿约 0.3 s 出逗号，约 0.9 s 出句号；问句出问号。
3. 按 Esc：只删除本次插入的文字，原草稿不变。
4. 单击麦克风连续转写 10 分钟不中断（Windows 单击现为系统声音回环；麦克风连续转写请用长按空格或在外放场景验证）。
5. 松开按键：最后一句补齐，字幕消失，状态回到 idle。

---

## 8. 已知边界与待办（移交重点）

| 优先级 | 事项 | 状态/建议 |
|---|---|---|
| P0 | 麦克风人工验收（字幕定位/遮挡、ProseMirror 插入与撤销） | **待用户**按第 7 节清单真机走一遍 |
| P0 | 真实语音准确率自动化验证 | **已完成**：5 样本比对通过，阈值无需调整（报告第 3 节） |
| P1 | "播放听力素材"系统音频回环 | **已完成**：gpt++ 隐藏窗口采集变体（第 4 节），真机页面验收通过 |
| P1 | 提供商模式仍整段转写 | `/audio/transcriptions` 无流式接口；如必须实时，只能做窗口重传（成本高，需用户可选开启） |
| P2 | 规则标点覆盖不足 | `sherpa-onnx-node` 已带 `OfflinePunctuation`，可选用 `ct-punc` 模型替代/补充规则；注意额外模型体积。英文问句被模型自带 `.` 压过问号规则即属此类 |
| P2 | 连续模式关闭回声消除，嘈杂环境效果差 | 增加"外放/口述"显式开关，而不是仅按点击/长按区分 |
| P2 | ProseMirror 重渲染后回滚可能跳过 | 记录并提示用户"已保留文字"，或改用可撤销的 marker 方案 |
| P3 | 预览解码占 CPU | 低配机器可加开关或把 `partialMaxIntervalMs` 调大；当前已按解码耗时自适应 |

模型级已知边界（不修，报告有样本证据）：英文 SAPI 问句模型自带 `.` 压过问号规则；混排样本 <500 ms 停顿不被 VAD 分段、模型自补 `。`；全角句号后接英文不加空格（排版可接受）。

---

## 9. 回归风险点

- `evaluate()` 每次调用新建 WebSocket，录音期间约 7 次/秒；若后续把轮询降到 <100 ms，需要先改成持久连接。
- `AudioContext({sampleRate:16000})` 依赖 Chromium 内部重采样；不支持时已回退整段识别，回退分支不要删。
- 页面测试使用 VM + 假 DOM/AudioContext；新增页面 API 时需同步更新 `test/voice-input.test.js` 的 sandbox mock。
- worker 的 `SampleBuffer` 依赖绝对采样下标；改动 VAD 窗口大小时必须同时改 `VAD_WINDOW`，否则 `segment.start` 与缓冲位置会错位。
- 软切不补尾、VAD 收尾才补尾，这个区别不要合并，否则会在软切缝上出现重复字。软切段必须先 `stripTrailingPunct` 再交停顿规则，否则截断处会出现模型补的假句号。
- 回环采集窗口可能是进程里唯一的窗口：无头验证工具必须注册 `window-all-closed` 空处理，否则 `stop()` 销毁窗口会触发 Electron 默认退出，主流程来不及写结果。
- `findChatGptDebugPort` 与验证工具的播放都依赖 `powershell.exe`：前者按 PATH 查找（正常用户环境无碍），后者已改绝对路径。受限 PATH 的终端跑应用/测试前需补 `C:\Windows\System32\WindowsPowerShell\v1.0`。
- 采集页 `ScriptProcessorNode` 有 deprecation 警告，无害；换 AudioWorklet 时注意 `file://` + nodeIntegration 的加载方式不变。