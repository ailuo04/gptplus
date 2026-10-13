# Codex "Responses" Local HTTP Gateway — Interface Contract

**Target under study:** `C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0`
**Engine:** `app\resources\codex.exe` (324,622,128 bytes), self-reports `codex-cli 0.159.0-alpha.12.1`
**Date of captures:** session-local, deterministic harness in `C:\ailuo_own\gpt++\research\capture\`
**Goal:** what a third-party app must implement at `http://127.0.0.1:<port>/v1` to serve custom models to this client via a `model_provider` with `wire_api = "responses"`.

---

## 0. How to read the evidence

Two independent evidence classes are used, and every claim is labelled with one:

| Tag | Meaning |
|---|---|
| **[CAP]** | Captured live traffic. The real `codex.exe` was pointed at a local Python gateway via an isolated `CODEX_HOME` (never touching `C:\Users\ailuo\.codex`). Raw request/response bytes are in `research\capture\capture.jsonl` and `research\capture\logs\*`. |
| **[BIN]** | Static string/struct archaeology in `codex.exe`. Decimal byte offsets are exact (`rg --byte-offset`); hex given alongside. Because rustc/LLVM tail-merges string literals, some adjacent literals appear interleaved in `.rodata` — where that happens the reconstruction is marked **[BIN-inferred]** and cross-checked against **[CAP]** wherever possible. |
| **[INFER]** | Reasoning not directly observed. Flagged explicitly. |

Nothing in `C:\Program Files\WindowsApps` or `C:\Users\ailuo\.codex` was modified.

---

## 1. Endpoints used

### 1.1 Summary

When `wire_api = "responses"`, this build talks to exactly **two** HTTP routes on `model_providers.<id>.base_url`:

| Method | Path | Purpose | Trigger | Evidence |
|---|---|---|---|---|
| `POST` | `{base_url}/responses` | The generate/stream call. **The only route on the model hot path.** | Every model turn (each `codex exec`, and each tool-result follow-up turn). | **[CAP]** 100 % of captured model traffic; **[BIN]** 252,491,018 — serde tag `"response.create"` and the request field table (`ResponsesWsRequest`, also at 254,754,807 / 257,231,848). No struct named `ResponsesApiRequest` exists in this build. |
| `GET` | `{base_url}/models` | Provider route probe / reachability check. | `codex doctor` only (see §1.3). **Not** called during normal `exec`/TUI runs. | **[CAP]** probe captured only under `doctor`; **[BIN]** 251,667,161 |
| `GET` | `{base_url}/responses` (WebSocket upgrade) | Streaming transport alternative. | Only when `supports_websockets = true` is set on the provider. Off by default. | **[CAP]** raw upgrade captured; **[BIN]** 250,924,300 |

**There is no `/v1/chat/completions` in this engine.** `rg -F 'chat/completions'` on `codex.exe` exits 1 (no match). A gateway only needs the Responses wire API.

### 1.2 `POST {base_url}/responses` — the main call

**[CAP]** Observed line, verbatim from the capture log (`research\capture\logs\toolcall.capture.jsonl`):

```
POST /v1/responses HTTP/1.1
host: 127.0.0.1:10199
content-type: application/json
accept: text/event-stream
originator: codex_exec
user-agent: codex_exec/0.159.0-alpha.12.1 (Windows 10.0.26200; x86_64) unknown (codex_exec; 0.159.0-alpha.12.1)
session-id: 01a0fd69-5004-7fd0-a9c6-8b1b06181f00
thread-id: 01a0fd69-5004-7fd0-a9c6-8b1b06181f00
x-client-request-id: 01a0fd69-5004-7fd0-a9c6-8b1b06181f00
x-codex-window-id: 01a0fd69-5004-7fd0-a9c6-8b1b06181f00:0
x-codex-beta-features: remote_compaction_v2
x-codex-turn-metadata: {"installation_id":"...","session_id":"...","thread_id":"...","agent_name":"/root","turn_id":"...","window_id":"...:0","window_number":0,"context_window_id":"...","request_kind":"turn","root_turn_id":"...","thread_source":"user","turn_trigger":"exec","sandbox":"none","sandbox_mode":"read-only","auto_review_enabled":false,"node_repl_auto_review_required":false,"node_repl_disabled":false,"turn_started_at_unix_ms":1790957868469,"analytics_enabled":true,"model":"capture-model"}
content-length: 44078
```

Notes that matter for a gateway:

* The route is built as **`base_url` + `/responses`**. With `base_url = "http://127.0.0.1:10100/v1"` the wire path is `/v1/responses`. `base_url` must therefore include the `/v1` (or any) prefix the gateway expects.
* `accept: text/event-stream` is always sent. **[CAP]** returning `Content-Type: application/json` with a single JSON body is **rejected** — the client retried 6× and failed with `stream disconnected before completion: stream closed before response.completed`.
* `x-codex-*`, `session-id`, `thread-id`, `x-client-request-id` are **informational**; the client does not require them to be echoed. **[CAP]** the minimal gateway ignored all of them and worked.
* `x-codex-turn-metadata` is a JSON **string** nested in a header — parse defensively or ignore.
* Unknown/extra request headers are harmless. **[CAP]**

### 1.3 `GET {base_url}/models` — the probe

**[BIN]** 251,667,161:

```
warning)... route probe: .. returned .. (required).provider base URL route returned 404 - verify the configured API prefix
.. returned ..GET /models returns 2xx, 401, or 403
Set base_url to the provider API root, for example https://api.openai.com/v1
.. route probe: .. .. (required).provider route probe could not connect - verify network access to the provider API
GET /models completesCheck proxy, VPN, firewall, DNS, and custom CA configuration
```

**[CAP]** `codex doctor --no-color --summary` against `base_url = "http://127.0.0.1:10199/v1"` produced exactly one probe:

```
GET /v1/models
   originator: codex_cli_rs
   user-agent: codex_cli_rs/0.159.0-alpha.12.1 (Windows 10.0.26200; x86_64) unknown
   accept: */*
```

and reported `✓ reachability active provider endpoints are reachable over HTTP`.

Two behaviours worth designing around:

1. **The probe carries no `Authorization` header**, even when the provider has `env_key` set. **[CAP]** — verified with `env_key = "MY_LOCAL_KEY"`: the `/models` probe came through with only `originator` and `user-agent`.
2. **A `401`/`403` on `/models` is treated as a pass** per the string at 251,667,161. Only `404` is scored as "verify the configured API prefix". **[BIN]** + **[INFER]** on the exact scoring.

`GET /v1/models` was **never observed during a normal `codex exec` run** — 12 distinct capture sessions, zero `/models` calls outside `doctor`.

### 1.4 WebSocket variant (opt-in; recommend leaving off)

With `supports_websockets = true` on the provider, the client switches transport to a WebSocket upgrade at `GET ws://<host>/<prefix>/responses`. **[CAP]** raw bytes from a TCP probe:

```
GET /v1/responses HTTP/1.1
Host: 127.0.0.1:10199
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: wECupUKgzf3/rud9luvGKw==
user-agent: codex_exec/0.159.0-alpha.12.1 (...)
originator: codex_exec
openai-beta: responses_websockets=2026-02-06
x-codex-turn-metadata: {...,"request_kind":"prewarm",...}
sec-websocket-extensions: permessage-deflate; client_max_window_bits
```

Failure surfaced as `codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 400 Bad Request, url: ws://127.0.0.1:10199/v1/responses`.

**Recommendation: do not set `supports_websockets`.** The default is HTTP POST + SSE, which is what §7 specifies. `codex doctor` explicitly reports `✓ websocket Responses WebSocket is not enabled for the active provider`. **[BIN]** corroboration: `supports_websockets` is a `ModelProviderInfo` field (251,599,860) and `codex-api\src\endpoint\responses_websocket.rs` exists as a separate endpoint module.

### 1.5 Routes that do **not** exist

Searched for and **not found** on the custom-provider path:

| Route | Result |
|---|---|
| `{base_url}/responses/{id}` (retrieve) | **[BIN]** no `/responses/` substring anywhere in the binary; no `.put`/`.delete` builder for it |
| `{base_url}/responses/{id}/cancel` | **[BIN]** the four `/cancel` hits (14,911,152 / 95,818,995 / 250,674,406 / 250,835,529) are all inside unrelated code blobs (`tasks/cancel`, `cell/cancel`), not HTTP route tables |
| `{base_url}/chat/completions` | **[BIN]** absent entirely |
| `{base_url}/v1/input_items`, `/conversations` | **[BIN]** absent |

**Cancellation is transport-level, not a second HTTP call.** **[INFER]** grounded in **[BIN]** the string `response.cancelled` (251,551,512) and the stream constant `discard_partial_items` (255,322,568): the client drops the SSE connection. The gateway should treat client disconnect as cancellation. **Cheapest verification:** see §8-R1.

### 1.6 Non-model routes seen elsewhere (not part of this contract)

**[BIN]** The binary also contains ChatGPT-backend routes (`/backend-api` ×many, `/v1/agent/*`, `/v1/files`, `/v1/images/generations`, `/v1/analytics/codex/turn-costs`, `/v1/user-auth-credential/whoami`) and local-provider routes (`Ollama … /api/tags`, `… /v1/models`; LM Studio `… /models`). These belong to other providers/features and are **not** used for a `wire_api = "responses"` custom provider. **[CAP]** none appeared in any capture.

**[BIN]** The JS side confirms the same provider shape the desktop app itself injects — `tools\asar-out\app-shared.js`:

```js
l.model_provider = zN,
l[`model_providers.${zN}`] = { name: BEt, base_url: e, experimental_bearer_token: t, wire_api: `responses` }
```

The Electron shell performs **no** model HTTP itself: `rg -o '/v1/[a-z...]+'` on `main.js` / `app-shared.js` / `app-initial.js` returns only statsig, telemetry and ChatGPT-backend paths. All model traffic goes through the Rust engine.

---

## 2. Request shape — `POST {base_url}/responses`

### 2.1 Top-level keys, in wire order

**[CAP]** Real captured body, `gpt-5.5`, `store: false`, custom provider. Wire order is stable and matches the serde declaration order found at **[BIN]** 257,231,880 (`response.create` `model` `instructions` `input` `tools` `tool_choice` `parallel_tool_calls` `reasoning` `store` `stream` `stream_options` `include` `service_tier` `prompt_cache_key` `client_metadata` `access_programs`).

```json
{
  "model": "gpt-5.5",
  "instructions": "<17,174-char Codex system prompt>",
  "input": [ /* array of items, §2.2 */ ],
  "tools": [ /* array of tool declarations, §2.3 */ ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium" },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "01a0fd6e-8664-7ca3-b1df-bb9878e3ab97",
  "text": { "verbosity": "low" },
  "client_metadata": {
    "root_turn_id": "01a0fd6e-...",
    "x-codex-installation-id": "e684b4d7-...",
    "x-codex-window-id": "01a0fd6e-...:0",
    "x-codex-turn-metadata": "{...nested JSON string...}",
    "thread_id": "01a0fd6e-...",
    "turn_id": "01a0fd6e-...",
    "session_id": "01a0fd6e-..."
  }
}
```

A trimmed-but-verbatim copy is written to `research\example-request.json`.

### 2.2 Field-by-field

| Field | Type | Presence | Notes |
|---|---|---|---|
| `model` | string | **always** | See §4. |
| `instructions` | string | **usually** | The full Codex system prompt (~17 KB). **Absent** under the "responses lite" catalog flag — see §2.4. |
| `input` | array of items | **always** | Full conversation history, re-sent every turn (§2.5). |
| `tools` | array | **usually** | Absent in "responses lite" mode (§2.4). |
| `tool_choice` | `"auto"` | always | **[CAP]** never observed as anything else. |
| `parallel_tool_calls` | bool | always | `true` for classic mode; `false` observed for `gpt-6-astra` (lite mode). |
| `reasoning` | object | always | `{"effort": "medium"}` by default. Keys seen **[CAP]**: `effort` (`low`/`medium`/`high`/`xhigh`/`max`), `summary` (`auto`/`detailed`), `context` (`all_turns`). **[BIN]** 257,231,880 + 251,979,390 also declare `sequential_cutoff`, `strict`, `schema`, `format`, `verbosity`, `reasoning_summary_delivery`, `json_schema`, `cyber`. |
| `store` | bool | always | **[CAP]** `false` in **every** capture (custom provider). Consequence: no server-side state, no `previous_response_id` (§2.5). |
| `stream` | bool | always | **[CAP]** `true` in every capture. |
| `stream_options` | object | **conditional** | Declared in the serde table; **never observed** with a custom provider. **[INFER]** reserved for OpenAI-hosted providers. |
| `include` | array | always | `["reasoning.encrypted_content"]`. |
| `service_tier` | string | conditional | **[CAP]** present only when configured (`-c service_tier="priority"` → `"service_tier": "priority"`). |
| `prompt_cache_key` | string | always | Equals the session id. Safe to ignore or use as a cache key. |
| `text` | object | conditional | **[CAP]** `{"verbosity": "low"}` for catalog-known slugs; **absent** when the slug is unknown to the client's catalog (fallback metadata). `-c model_verbosity="high"` → `{"verbosity":"high"}`. |
| `client_metadata` | object | always | Telemetry bag. All values are strings; `x-codex-turn-metadata` is a nested JSON string. Ignore. |
| `previous_response_id` | string | **never observed** | See §2.5. |
| `max_output_tokens` | number | **never observed** | **[BIN]** present in other structs (254,325,313 etc.) but not sent for custom providers. |
| `access_programs`, `generate`, `codex_output_schema` | — | **never observed** | Declared in the Responses-**WebSocket** serde table at 252,491,018; not on the HTTP path. |

### 2.3 `input` items (client → gateway)

**[CAP]** Item types observed in real bodies: `message`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `additional_tools` (lite mode only).

```json
{"type":"message","id":"msg_01a0fd69-...","role":"user",
 "content":[{"type":"input_text","text":"Say hello."}]}
```
```json
{"type":"message","id":"msg_...","role":"developer",
 "content":[{"type":"input_text","text":"<skills_instructions>..."}]}
```

**[BIN]** `ResponseItem` is an internally-tagged enum on `type` (≈252,500,700, `0xF0C9F7C`); full tag list:

```
additional_tools  message  agent_message  reasoning  local_shell_call  function_call
tool_search_call  function_call_output  custom_tool_call  custom_tool_call_output
tool_search_output  web_search_call  image_generation_call  compaction
configuration_update  compaction_trigger  context_compaction  other
```

**[BIN]** `ContentItem` tags (≈252,494,900, `0xF0C9D24`/`0xF0C9E1C`): `input_text`, `input_image` (+`detail`), `input_audio` (+`audio_url`), `output_text`, `refusal`, `summary_text`, `reasoning_text`, `encrypted_content`.

A gateway that ignores non-`message` items and just forwards I/O will still work, but must **echo tool-call items back into the transcript** it builds for the upstream model (§6).

### 2.4 Two request modes — this is the biggest compatibility trap

**[CAP]** Two structurally different bodies were observed, selected by the **client's own model catalog**, not by the provider:

**(a) Classic Responses mode** — slug known to the catalog with `use_responses_lite: false`, or **any unknown slug** (fallback metadata). Example: `gpt-5.5`, `capture-model`.
Top-level `instructions` + top-level `tools` (10 entries: `function`/`custom`/`tool_search`/`web_search`).

**(b) "Responses lite" mode** — slug with `use_responses_lite: true` in the catalog. Example: `gpt-6-astra`.
**No `instructions` key, no `tools` key, `parallel_tool_calls: false`.** Instead `input[0]` is:

```json
{"type":"additional_tools","id":"at_b24dee49-...","role":"developer",
 "tools":[{"type":"namespace","name":"functions","description":"",
           "tools":[{"type":"custom","name":"exec","description":"Run JavaScript code to orchestrate/compose tool calls\n- Evaluates the provided JavaScr..."}]}]}
```
and the system prompt arrives as an ordinary `message` item with `role: "developer"`.

**[CAP]** `codex debug models` on this install lists exactly 10 catalog slugs; 9 of 10 have `"use_responses_lite": true`:

```
gpt-6-astra  gpt-6-sol  gpt-6-luna  gpt-5.6-sol  gpt-5.6-terra  gpt-5.6-luna
gpt-daybreak-blue-latest  gpt-daybreak-red-latest  gpt-5.5  codex-auto-review
```

**Practical consequence:** a third-party gateway advertising a *custom* slug that is not in this catalog automatically gets **mode (a)**, the ordinary OpenAI Responses shape. This is the mode to build against. If you deliberately reuse a catalog slug, you must also handle mode (b).

### 2.5 No server-side state; full history every turn

**[CAP]** In a 2-turn tool session, request #1 and request #2 had **identical top-level key sets** and **no `previous_response_id`** in either:

```
REQ #1 keys: model, instructions, input, tools, tool_choice, parallel_tool_calls, reasoning, store, stream, include, prompt_cache_key, client_metadata
REQ #2 keys: model, instructions, input, tools, tool_choice, parallel_tool_calls, reasoning, store, stream, include, prompt_cache_key, client_metadata
REQ #1 input types: message, message, message
REQ #2 input types: message, message, message, function_call, function_call_output
```

Because `store: false`, the client **re-sends the entire transcript** and never asks the gateway to remember anything. A stateless gateway is fully sufficient. **[INFER]** `store: true` + `previous_response_id` exists in the protocol (the WebSocket serde table at 252,491,018 declares `previous_response_id`, `generate`, `codex_output_schema`) but is not reachable through the `responses` provider config on this build — no `disable_response_storage`-style key exists in the binary.

### 2.6 Shaping the request for an OpenAI-compatible relay

**[INFER]**, derived from the above:

1. Take `instructions` (or, in lite mode, the leading `role: "developer"` message) and map it to the upstream system prompt.
2. Walk `input` in order and map `message` items by `role` (`developer`/`system` → system, `user` → user, `assistant` → assistant).
3. Map `input_text` content parts to text. `input_image` parts carry image data — drop or forward if the upstream is multimodal.
4. Map `function_call` → the upstream's assistant tool-call; `function_call_output` → the matching tool result keyed by `call_id`.
5. Map `tools` → upstream tool definitions. `type: "function"` with `parameters` is a JSON-schema tool. `type: "custom"` is **freeform** (see §6.2) and usually has no upstream equivalent — either drop it or wrap it in a synthetic string-argument function.
6. `tool_choice`, `parallel_tool_calls`, `reasoning.effort`, `text.verbosity` have no uniform upstream meaning — drop or translate per upstream.
7. Ignore `store`, `include`, `prompt_cache_key`, `client_metadata`, `service_tier`.

---

## 3. Response shape — SSE stream

### 3.1 Framing rules (all verified by live capture)

| Rule | Result | Evidence |
|---|---|---|
| `Content-Type: text/event-stream` required | **Yes.** A `application/json` body is rejected; 6 attempts then failure. | **[CAP]** `nonstream` scenario, exit 1 |
| SSE `event:` line required | **No.** `data:`-only streams work identically. | **[CAP]** `noevent` scenario, exit 0 |
| JSON `type` field required | **Yes, and it is authoritative.** A mismatched `type` fails; a missing `type` fails. | **[CAP]** `typemismatch` and `notype` scenarios, both exit 1 |
| Unknown extra fields tolerated | **Yes.** `sequence_number` was present in every capture and is not in the client struct — harmless. | **[CAP]** + **[BIN]** struct has 13 fields, no `sequence_number` |
| Chunked transfer / no `Content-Length` | Works | **[CAP]** all streaming captures |
| The final `message` item's `content[].text` is populated | **Required for text to appear.** Deltas alone render nothing. | **[CAP]** `deltas` vs `minimal` |
| A stream that ends without `response.completed` | Fails after 6 attempts with `stream closed before response.completed` | **[CAP]** + **[BIN]** literal at ≈252,490,600 |

**[BIN]** The parser is `codex-api\src\sse\responses.rs` (module path literal at 252,490,488). The deserialization target is a **flat struct**:

```
struct ResponseCompleted ... struct ResponsesStreamEvent
  headers response item item_id call_id delta text summary_index content_index safety_buffering
  struct ResponsesStreamEvent with 13 elements
```
— field-name list at 252,500,719 (`0xF0CDAEF`); the literal `struct ResponsesStreamEvent with 13 elements` also appears at 255,280,248. That flat 10-named-field shape is why the client can read `delta` from `output_text.delta`, `arguments`/`input`/`text` from the `.done` variants, `item` from `output_item.*`, and `response` from `completed`/`failed`/`incomplete`.

### 3.2 Event catalogue

**Event names confirmed present as literals in `codex.exe`:**

| Event | Offset | Status |
|---|---|---|
| `response.created` | 252,482,512 | parsed |
| `response.in_progress` | ≈252,498,368 **[BIN-inferred]** | parsed |
| `response.output_item.added` | 252,507,938 | parsed |
| `response.output_item.done` | 252,498,560 / 252,508,075 | parsed |
| `response.content_part.added` | ≈252,498,368 **[BIN-inferred]** | parsed |
| `response.content_part.done` | ≈252,498,368 **[BIN-inferred]** | parsed |
| `response.output_text.delta` | ≈252,498,368 **[BIN-inferred]** | parsed (see §3.4 — cosmetic) |
| `response.output_text.done` | 252,482,544 | parsed |
| `response.reasoning_summary_part.added` | 252,507,654 | parsed |
| `response.reasoning_summary_part.done` | 252,507,802 | parsed |
| `response.reasoning_summary_text.delta` | 252,507,581 | parsed |
| `response.reasoning_summary_text.done` | 252,507,618 | parsed |
| `response.reasoning_text.delta` | ≈252,498,368 **[BIN-inferred]** | parsed |
| `response.function_call_arguments.delta` | 252,507,727 | parsed |
| `response.function_call_arguments.done` | 252,507,765 | parsed |
| `response.custom_tool_call_input.delta` | 252,507,544 | parsed |
| `response.custom_tool_call_input.done` | 252,507,691 | parsed |
| `response.completed` | 252,490,613 | parsed (terminal) |
| `response.failed` | 252,468,326 | parsed (terminal) |
| `response.incomplete` | ≈252,498,368 **[BIN-inferred]** | parsed (terminal) |
| `response.metadata` | 252,498,208 | parsed (non-terminal, ignorable) |
| `codex.response.metadata` | ≈252,498,400 | Codex-specific metadata |
| `response.cancelled` | 251,551,512 | cancellation bookkeeping |
| `error` | present, but too generic a literal to pin to a route by offset | stream-level error **[CAP]** |

**Confirmed absent** (searched individually, no match): `response.queued`, `response.refusal.delta`/`.done`, `response.audio.*`, `response.output_text.annotation.added`, `response.web_search_call.*`, `response.code_interpreter_call_code.*`, `response.image_generation_call.partial_image`, `response.error`. Non-streaming shape: no.

**Parser error strings** (≈252,490,600–252,508,100) that reveal the contract:

```
stream closed before response.completed.        Failed to parse SSE event
SSE Error:                                      idle timeout waiting for SSE
unhandled responses event:                      failed to parse ResponseItem from output_item.added
failed to parse ResponseCompleted:              Incomplete response returned, reason:
failed to parse ResponseItem from output_item.done
```
plus field names `incomplete_details` (252,508,091) and `reason` .

### 3.3 Minimal viable stream — **verified by live capture**

**[CAP]** This exact 2-event stream produced `exit=0` and correct rendering (`minimal` scenario). `response.output_item.done` carries the whole message; no deltas, no `created`, no content parts, no `event:` lines.

```
data: {"type":"response.output_item.done","sequence_number":0,"output_index":0,
       "item":{"type":"message","id":"msg_capture_min","role":"assistant","status":"completed",
               "content":[{"type":"output_text","text":"minimal path works","annotations":[]}]}}

data: {"type":"response.completed","sequence_number":1,
       "response":{"id":"resp_capture_0001","object":"response","created_at":...,"status":"completed",
                   "model":"capture-model","output":[...same message item...],
                   "usage":{"input_tokens":1,"output_tokens":3,"total_tokens":4,
                            "input_tokens_details":{"cached_tokens":0},
                            "output_tokens_details":{"reasoning_tokens":0}}}}
```

**[CAP]** Even a single `response.completed` with an empty `output` array is accepted (`bare` scenario, exit 0) — the turn just produces no text. So the hard requirement is exactly one thing:

> **A well-formed `{"type":"response.completed", ...}` object must arrive on the stream before the connection closes.**

### 3.4 Must-emit vs optional

| Event | Requirement | Why |
|---|---|---|
| `response.completed` | **MUST** | Only terminal event that ends the stream successfully. Its absence is the failure mode `stream closed before response.completed`. |
| `response.output_item.done` (with the final `message` item) | **MUST** | **This is the authoritative text channel.** A stream that delivers correctly-formed `output_text.delta` events but ends with a `message` item whose `content` is empty renders **no text at all** — capture-verified (`deltas` scenario: exit 0, `tokens used 11`, empty answer). The deltas are cosmetic. |
| `response.created` | optional | Purely decorative for this client. |
| `response.in_progress` | optional | Never observed as required. |
| `response.output_item.added` | optional (recommended) | Lets the TUI show a placeholder while streaming. |
| `response.content_part.added` / `.done` | optional | Only meaningful alongside streaming text; **not** a substitute for item content. |
| `response.output_text.delta` | optional | Incremental UX only. **[CAP]** a full delta sequence with an empty terminal item produced **no output**. |
| `response.output_text.done` | optional | Final text for the part; likewise not a substitute for item content. |
| `response.reasoning_summary_part.added` / `.done` | optional | Reasoning summary grouping. |
| `response.reasoning_summary_text.delta` / `.done` | optional | **[CAP]** rendering verified (`reasoning` scenario printed `analysis complete`). |
| `response.function_call_arguments.delta` / `.done` | optional | Streaming tool args. **[CAP]** fully round-tripped. |
| `response.custom_tool_call_input.delta` / `.done` | optional | Freeform tool args. **[CAP]** fully round-tripped. |
| `response.failed` | optional (error path) | **[CAP]** fails the turn with the message from `response.error.message`. |
| `response.incomplete` | optional (error path) | **[CAP]** fails with `Incomplete response returned, reason: <incomplete_details.reason>`. |
| `response.metadata` | optional | Ignored. |
| `error` | optional (error path) | **[CAP]** fails the turn. |

### 3.5 Envelopes

Field names below come from **[CAP]** payloads that the client accepted, cross-checked against the **[BIN]** struct field list.

**Non-terminal, item-scoped** (`item_id`, `output_index`, `content_index`/`summary_index`, `delta`):

```json
{"type":"response.output_text.delta","sequence_number":10,
 "item_id":"msg_capture_0001","output_index":0,"content_index":0,"delta":"Hello fro"}
```

**Item lifecycle** (`item` for `.added`, `item` for `.done`):

```json
{"type":"response.output_item.added","sequence_number":2,"output_index":0,
 "item":{"type":"message","id":"msg_capture_0001","role":"assistant","status":"in_progress","content":[]}}
```

**Terminal** (`response` — the full response object):

```json
{"type":"response.completed","sequence_number":33,
 "response":{"id":"resp_capture_0001","object":"response","created_at":1790957855,
             "status":"completed","model":"capture-model","output":[ /* items */ ],
             "parallel_tool_calls":true,"tool_choice":"auto","tools":[],
             "usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20,
                      "input_tokens_details":{"cached_tokens":0},
                      "output_tokens_details":{"reasoning_tokens":0}}}}
```

**[BIN]** `struct ResponseCompletedUsage with 6 elements` (252,447,500): `input_tokens`, `input_tokens_details`, `output_tokens`, `output_tokens_details`, `total_tokens`, `codex_rollout_budget_units`. Only `total_tokens` was visibly consumed (`tokens used 20` in the TUI), but supply all the standard ones.

**[BIN]** `struct ResponseCompleted with 4 elements` (≈252,500,800): `usage`, `usage_metadata`, `end_turn`, +1.

**[BIN]** `struct Error with 6 elements` (252,447,500): `type`, `code`, `plan_type`, `resets_at`, `misalignment`, +1.

### 3.6 Response headers the client reads

**[BIN]** ≈252,506,100 (`0xF0CEFF4`), module `codex-api\src\sse\responses_error.rs`:

```
id  usage  retry_model  openai_verification_recommendation  openai_chatgpt_moderation_metadata
X-Models-Etag  openai-model  x-reasoning-included  x-request-id  x-codex-turn-state
```

**[BIN]** ≈252,503,300, rate-limit/safety response headers:

```
x-codex-promo-message  x-codex-credits-has-credits  x-codex-credits-unlimited  x-codex-credits-balance
x-codex-primary-used-percent  x-codex-primary-window-minutes  x-codex-primary-reset-at
x-codex-secondary-used-percent  x-codex-secondary-window-minutes  x-codex-secondary-reset-at
x-codex-limit-name  x-codex-rate-limit-reached-type
x-codex-safety-buffering-enabled  x-codex-safety-buffering-faster-model
```

All optional. A gateway may omit every one of them; none was required in any working capture. `x-codex-turn-state` is the one non-trivial case — **[BIN]** it is read from the response and (per `codex-api\src\endpoint\responses.rs`, 252,493,992, alongside `session-id`, `thread-id`, `x-openai-subagent`, `memory_consolidation`) is part of a server-affinity scheme. **[CAP]** the working minimal gateway sent none of these and streaming still succeeded, so treat it as an optimisation, not a requirement.

---

## 4. How the model name is transmitted

**It arrives as the top-level JSON body field `model`.** **[CAP]** verified across five slugs:

| Configured slug | Body `model` |
|---|---|
| `capture-model` | `"capture-model"` |
| `gpt-5-codex` | `"gpt-5-codex"` |
| `gpt-5.1-codex` | `"gpt-5.1-codex"` |
| `gpt-5.1` | `"gpt-5.1"` |
| `gpt-5.5` | `"gpt-5.5"` |
| `gpt-6-astra` | `"gpt-6-astra"` |

The value is passed through **verbatim** from `model = "..."` in `config.toml` (or `-m/--model`, or `-c model="..."`). It also appears as `client_metadata["x-codex-turn-metadata"] → .model` and inside the header JSON, but `body.model` is the field to read.

**The gateway is free to ignore or remap it.** **[CAP]** the capture gateway replied with a completely different `"model"` value inside `response.completed.response.model` and the client never complained — it echoed the configured slug in its own UI regardless (`model: capture-model` was printed from config, not from the response). There is no client-side verification that the response's `model` matches the request's.

**Caveat — the slug still steers the client, not the server.** Although the wire value is free-form, it selects *client-side* metadata (context window, verbosity support, and the classic-vs-lite wire mode of §2.4). Recommended pattern:

* Advertise a slug the client's catalog does **not** know (e.g. `local-mistral-large`). The client emits the classic Responses shape and prints one warning:
  `warning: Model metadata for '<slug>' not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`
* Remap inside the gateway: `{"model": "claude-…" | "llama-…" | …}`.
* To silence the warning and supply a real context window, use `model_catalog_json` (a config key confirmed at **[BIN]** 251,101,518 and already used by `C:\Users\ailuo\.codex\opencodex.config.toml`). The schema is the same JSON emitted by `codex debug models` — see `research\capture\logs\catalog.json` (572,649 bytes, 10 entries). **[INFER]** on the exact merge semantics.

---

## 5. Auth

### 5.1 Header the client sends

**[CAP]** `Authorization: Bearer <token>` — exactly, with a capital `A`, one space, and the literal scheme `Bearer`. No other auth header was ever observed.

| Provider config | Header actually sent | Capture |
|---|---|---|
| `requires_openai_auth = false` (no key) | *(none)* | `auth-none` |
| `env_key = "MY_LOCAL_KEY"` (+ `requires_openai_auth = false`) | `authorization: Bearer env-key-value-xyz` | `auth-envkey` |
| `env_key = "MY_LOCAL_KEY"` (no `requires_openai_auth`) | `authorization: Bearer env-key-value-xyz` | `auth-envkey-no-roa` |
| `experimental_bearer_token = "secret-token-abc123"` | `authorization: Bearer secret-token-abc123` | `auth-bearer` |
| `requires_openai_auth = true`, no credentials | *(none — and no error)* | `auth-required` |

Key points:

* **`requires_openai_auth = false` is the right setting for a local gateway.** It means "don't try to attach ChatGPT credentials", not "never send a token".
* Setting `env_key` is sufficient on its own to get a Bearer header; `requires_openai_auth` need not be restated. **[CAP]**
* `experimental_bearer_token` hard-codes a literal token in `config.toml` and outranks `env_key`. Good for local dev, poor for anything else.
* With `requires_openai_auth = true` and no stored credentials, the client sends **no** Authorization header at all and still issued the request; only `codex doctor` complained (`✗ auth no Codex credentials were found - Run codex login or provide an API key through a supported auth env var.`). **[CAP]** Don't use `true` for a local gateway.
* Extra static/derived headers and query params work and are applied to the `/responses` call:

```toml
http_headers     = { "X-Custom-Static" = "static-value" }
env_http_headers = { "X-Custom-Env" = "MY_LOCAL_KEY" }
query_params     = { "api-version" = "2025-04-01-preview" }
```
**[CAP]** → `POST /v1/responses?api-version=2025-04-01-preview` with `x-custom-static: static-value` and `x-custom-env: env-key-value-xyz`. Header names are lower-cased on the wire.

**[BIN]** `ModelProviderInfo with 20 elements` (251,599,860) confirms the full provider surface:

```
base_url  model_catalog_url  env_key  env_key_instructions  experimental_bearer_token
gateway_oauth  wire_api  query_params  http_headers  env_http_headers
request_max_retries  stream_max_retries  stream_idle_timeout_ms  websocket_connect_timeout_ms
requires_openai_auth  supports_websockets  supports_standalone_web_search  ...
```

### 5.2 What the gateway may/must return

**A local gateway may ignore `Authorization` entirely.** **[CAP]** every scenario in this study ran with the gateway never validating the header.

If you *do* enforce auth, the observed failure behaviour is:

| Response | Behaviour | Evidence |
|---|---|---|
| `401` with `{"error":{...}}` | Retried **6×** total (1 + 5), then `ERROR: unexpected status 401 Unauthorized: <error.message>, url: <full url>` | **[CAP]** `status-401` |
| `403` | **[INFER]** same class as 401 (both are treated as "probe-pass" statuses per §1.3, and both are non-retryable-at-the-limit) | **[BIN]** |
| `404` | Retried 6×, then `unexpected status 404 Not Found` | **[CAP]** `status-404` |
| `429` | **1 request only**, then `ERROR: exceeded retry limit, last status: 429 Too Many Requests` (a `Retry-After: 3` was supplied) | **[CAP]** `status-429` |
| `500` | **30 requests** over 24.7 s, then `ERROR: We're currently experiencing high demand, which may cause temporary errors.` | **[CAP]** `status-500` |

**Error body shape the client reads:** `{"error": {"message": "...", "type": "...", "code": "..."}}` — the `message` string is surfaced verbatim into the client's error line. **[CAP]**

`Retry-After` is honoured; **[BIN]** ≈252,506,000 also declares `x-ms-retry-after-ms` and a body-scraping regex `(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)`.

**Recommendation:** for a local single-user gateway, return `200` and stream, or `4xx` with a clear `error.message` and accept the 6-attempt retry. Never return `500` for an application error — it costs 25 seconds and 30 requests.

---

## 6. Tool calls

### 6.1 JSON-schema function calls (`type: "function"`)

**Gateway → client** (what you emit):

```
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,
       "item":{"type":"function_call","id":"fc_capture_1","call_id":"call_capture_1",
               "name":"exec_command","arguments":"","status":"in_progress"}}
data: {"type":"response.function_call_arguments.delta","sequence_number":2,
       "item_id":"fc_capture_1","output_index":0,"delta":"{\"cmd\": \"echo hello-from-tool\"}"}
data: {"type":"response.function_call_arguments.done","sequence_number":3,
       "item_id":"fc_capture_1","output_index":0,
       "arguments":"{\"cmd\": \"echo hello-from-tool\"}"}
data: {"type":"response.output_item.done","sequence_number":4,"output_index":0,
       "item":{"type":"function_call","id":"fc_capture_1","call_id":"call_capture_1",
               "name":"exec_command","arguments":"{\"cmd\": \"echo hello-from-tool\"}",
               "status":"completed"}}
data: {"type":"response.completed", ...}
```

* `arguments` is a **JSON-encoded string**, not an object.
* `name` must be one the client actually declared in `tools` (or in `additional_tools.tools`). Calling an undeclared name yields `codex_core::tools::router: error=unsupported custom tool call: <name>` or an equivalent router error. **[CAP]**
* `id` is the model-side id; `call_id` is the correlation id. Both are echoed back.

**Client → gateway** (next turn's `input[]`, verbatim **[CAP]**):

```json
{"type":"function_call","id":"fc_capture_1","name":"exec_command",
 "arguments":"{\"cmd\": \"echo hello-from-tool\"}","call_id":"call_capture_1"}
```
```json
{"type":"function_call_output","id":"fco_01a0fd69-52d4-7d41-8ddd-d3570f70b228",
 "call_id":"call_capture_1",
 "output":"exec_command failed: CreateProcess { message: \"Rejected(...) rejected: blocked by policy\" }"}
```

* The client **echoes your `id` verbatim** in the `function_call` item.
* `function_call_output.output` is a **plain string** (the raw tool result), and the client generates its own `id` with an `fco_` prefix.
* There is no top-level "tool results" array — results are ordinary `input[]` items, matched by `call_id`.

### 6.2 Freeform custom tool calls (`type: "custom"`)

`apply_patch` is declared as `type: "custom"` (freeform, Lark grammar in `format.definition`) whenever the client's catalog knows the slug. **[CAP]** with `-m gpt-5.5`:

Client's declaration:
```json
{"type":"custom","name":"apply_patch",
 "description":"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
 "format":{"type":"grammar","syntax":"lark","definition":"start: begin_patch hunk+ end_patch\r\n..."}}
```

Gateway emits:
```
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,
       "item":{"type":"custom_tool_call","id":"ctc_capture_1","call_id":"call_custom_1",
               "name":"apply_patch","input":""}}
data: {"type":"response.custom_tool_call_input.delta","sequence_number":2,
       "item_id":"ctc_capture_1","output_index":0,"delta":"*** Begin Patch\n*** Add File: ..."}
data: {"type":"response.custom_tool_call_input.done","sequence_number":3,
       "item_id":"ctc_capture_1","output_index":0,"input":"*** Begin Patch\n...*** End Patch\n"}
data: {"type":"response.output_item.done", ..., "item":{... "input":"*** Begin Patch\n...", ...}}
```

Client echoes back **[CAP]**:
```json
{"type":"custom_tool_call","id":"ctc_capture_1","call_id":"call_custom_1",
 "name":"apply_patch","input":"*** Begin Patch\n*** Add File: gateway-note.txt\n+hello from gateway\n*** End Patch\n"}
```
```json
{"type":"custom_tool_call_output","id":"ctco_01a0fd70-bcdf-7241-b685-7fafdf9428ea",
 "call_id":"call_custom_1",
 "output":"patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings"}
```

Differences from `function_call`: the field is **`input`** (a raw string) instead of `arguments` (a JSON string), and the delta events are `response.custom_tool_call_input.*`.

### 6.3 Other tool item types

**[BIN]** ≈252,500,700 declares additional item kinds on the same `type` tag: `tool_search_call` / `tool_search_output` (`execution: "client"`), `web_search_call` (actions `search`/`open_page`/`find_in_page` with `query`/`queries`/`url`/`pattern`), `image_generation_call`, `local_shell_call`. **[CAP]** none were exercised. A gateway should not emit them unless it also implements the matching tools.

---

## 7. Minimal viable gateway spec

### 7.1 Numbered checklist

1. **Listen** on `127.0.0.1:<port>`. Serve `POST <prefix>/responses` and `GET <prefix>/models`.
2. **`POST /responses`:** read the JSON body. Read `model` (→ upstream model choice) and `input[]` (→ upstream messages). Everything else is optional context.
3. **Respond `200`** with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and **chunked** transfer encoding (or just close the connection when done).
4. **Emit SSE frames.** Each frame is `data: <json>\n\n`. The `event:` line is **optional** — but if you send it, its value must match the JSON `type`.
5. **Every payload MUST have a `type` field**, and that `type` is authoritative. Send `sequence_number` if you like; the client ignores it.
6. **Emit content — and put the text in the item.** Stream it for UX:
   `response.output_item.added` → `response.content_part.added` → N× `response.output_text.delta` → `response.output_text.done` → `response.content_part.done` → `response.output_item.done`,
   **but the `response.output_item.done` item MUST carry the finished text** in `item.content[].text`. Deltas alone render nothing (§3.4, R5). A single `response.output_item.done` with the finished `message` item, with no deltas at all, is the capture-verified shortest correct path.
7. **Emit exactly one terminal event** and stop: `response.completed` (success), `response.failed`, or `response.incomplete`. **A stream that closes without `response.completed` fails the turn after 6 attempts.**
8. **Include `usage`** in `response.completed.response.usage` as `{input_tokens, output_tokens, total_tokens}` (+ optional `*_tokens_details`). `total_tokens` is what the client displays.
9. **For tool calls**, emit a `function_call` item (JSON `arguments` string) or a `custom_tool_call` item (raw `input` string) followed by `response.output_item.done`, then `response.completed`. **Only call a tool whose `name` appeared in the request's `tools` array** (or `additional_tools[].tools`).
10. **Accept the follow-up turn.** The client re-sends the whole transcript with `function_call` / `function_call_output` (or `custom_tool_call` / `custom_tool_call_output`) items appended. Match results by `call_id`. Be stateless — `store` is always `false` and `previous_response_id` is never sent.
11. **`GET /models`:** return `200` with `{"object":"list","data":[{"id":"<slug>","object":"model"}]}`, **or** return `401`/`403`. Do **not** return `404`. The client sends no `Authorization` on this route.
12. **Never respond `500`** for an application error — use `4xx` with `{"error":{"message":"..."}}`. A `500` costs 30 requests and ~25 seconds.
13. **Do not set `supports_websockets`** on the provider, so the client stays on HTTP+SSE.
14. If your upstream is not Responses-native, **relay**: map `input[]` → upstream messages, upstream output → `response.output_text.delta`/`done` + `response.completed`.

### 7.2 Smallest `config.toml` provider block

```toml
model = "local-mistral-large"          # any slug; unknown slugs are remappable by the gateway
model_provider = "localgw"

[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = false
```

That is a complete, working configuration — no token, no extra headers. See `research\capture\codex-home\config.toml` for the exact file that was used.

With a token:

```toml
[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
env_key = "LOCAL_GW_TOKEN"             # -> Authorization: Bearer $LOCAL_GW_TOKEN
requires_openai_auth = false
```

With a hard-coded token and a query-string API version:

```toml
[model_providers.localgw]
name = "Local Gateway"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "local-dev-token"
query_params = { "api-version" = "2025-04-01-preview" }
http_headers = { "X-Client" = "codex" }
```

Optional tuning keys, from the **[BIN]** `ModelProviderInfo` field list (251,599,860):

```toml
request_max_retries = 2
stream_max_retries  = 2
stream_idle_timeout_ms = 300000
model_catalog_json = "C:\\path\\to\\catalog.json"    # top-level key, not per-provider
```

### 7.3 Reference implementation

A working gateway lives at `C:\ailuo_own\gpt++\research\capture\gateway.py` (~370 lines, stdlib only). It implements every rule above and was the counterparty for every **[CAP]** claim in this document. Scenario switch via `GW_SCENARIO` ∈ {`full`, `minimal`, `bare`, `deltas`, `toolcall`, `reasoning`, `customtool`, `noevent`, `typemismatch`, `notype`, `nonstream`, `sse_error`, `sse_failed`, `sse_incomplete`}; HTTP status override via `GW_STATUS`.

---

## 8. Risks and uncertainties

### R1 — Cancellation / mid-stream abort semantics. **Medium impact, low risk of breaking you.**
No `DELETE {base_url}/responses/{id}` or `/cancel` route exists in the binary (§1.5). **[INFER]** cancellation is client-side disconnect only. If a gateway relies on an explicit cancel signal to stop upstream billing, it will not get one.
*Cheapest verification:* point the gateway at a scenario that streams deltas with a 2 s gap, run the interactive TUI (`codex` with no subcommand), press `Esc`/`Ctrl-C` mid-stream, and confirm the server sees the socket close and no follow-up request. Capture with `research\capture\gateway.py` plus a longer delta delay.

### R2 — Catalog-slug collision silently switches the wire mode. **High impact, easy to trip.**
If your configured model slug happens to be one of the 10 in `codex debug models` — or one the client later syncs from the network — the request silently changes shape: no `instructions`, no top-level `tools`, tools folded into `input[0].type == "additional_tools"`, `parallel_tool_calls: false` (§2.4). A gateway that only handles the classic shape will then behave incorrectly without an obvious error.
*Cheapest verification:* run `codex debug models` (fast, offline — output saved at `research\capture\logs\catalog.json`) and confirm your slug is absent; or assert on every request that `instructions` and `tools` are present and log loudly if not. Cheapest **defence**: pick a distinctive slug.

### R3 — Retry amplification on 5xx. **Medium impact, high likelihood during development.**
A `500` produced **30 requests in 24.7 s**; a `401`/`404` produced 6. **[CAP]** A buggy gateway returning `500` will hammer itself and can double-apply side effects if the gateway is not idempotent. Note retries reuse the same `x-client-request-id`, so it is possible to de-duplicate — but nothing in the client guarantees it.
*Cheapest verification:* run the harness with `GW_STATUS=500` (`research\capture\status-matrix.ps1`) and count requests in `capture.jsonl`. Mitigation: return `4xx` for all application errors; set `request_max_retries = 0` / `stream_max_retries = 0` on the provider while developing.

### R4 — "Responses lite" wire mode is largely unexplored. **Low near-term impact.**
Only its request shape was captured ([CAP], `gpt-6-astra`); no successful lite-mode stream was exercised, and the client-side handling of `additional_tools` / `namespace` tool nesting is unverified in this study.
*Cheapest verification:* run `research\capture\run-scenario.ps1` with `-Prompt "hi"` after adding `-m gpt-6-astra` to the driver's argument list, then diff the resulting `capture.jsonl` against the classic run.

### R5 — Deltas are cosmetic, not the text channel. **RESOLVED — high value, easy to get wrong.**
Originally flagged as an uncertainty; now **[CAP]**-verified. A stream containing `response.output_item.added` (empty message), `response.content_part.added`, a complete `response.output_text.delta` sequence, `response.output_text.done`, `response.content_part.done`, `response.output_item.done` with an **empty** `content` array, and `response.completed` produced **exit 0, `tokens used 11`, and no rendered text whatsoever** (`deltas` scenario). The message item's `content[].text` in `response.output_item.done` is the authoritative channel. A relay that streams deltas but forgets to fill in the terminal item will look like it works while silently returning empty answers.
*Reproduce:* `run-scenario.ps1 -Scenario deltas`; compare with `-Scenario minimal`.

### R6 — `store` / `previous_response_id` may become reachable. **Low, future-facing.**
The WebSocket serde table declares `previous_response_id`, `generate`, and `codex_output_schema` (252,491,018), and the client parses `store`. If a future build flips `store` to `true` for custom providers, stateless gateways will start receiving `previous_response_id` and must either honour it or fail loudly.
*Cheapest verification:* grep the client logs / add an assertion in the gateway that logs any request containing `previous_response_id` or `store: true`. Historical traffic can be checked in `C:\Users\ailuo\.codex\logs_2.sqlite` (read-only) if the desktop app has been used with a custom provider.

### R7 — Static analysis limits.
Several event-name literals are **not present as contiguous strings** in `.rodata` — the linker tail-merged them with neighbouring literals, so they were reconstructed rather than read directly. Confirmed absent-as-contiguous by exact `rg -F`: `response.in_progress`, `response.content_part.added`, `response.content_part.done`, `response.output_text.delta`, `response.reasoning_text.delta`, `response.incomplete`, `codex.response.metadata`. They are marked **[BIN-inferred]** in §3.2 and were each cross-checked against a live capture: `response.incomplete` reproduced the exact **[BIN]** message `Incomplete response returned, reason: max_output_tokens`; `response.output_text.delta` and the `content_part` pair rendered correctly in the `full` scenario; `response.reasoning_summary_text.*` rendered in the `reasoning` scenario. The remaining uncertainty is which of the cosmetic events the client *acts on* versus merely tolerates in its match table — §3.4 and §R5 now settle that for the text path.
*Cheapest verification:* the harness takes a new scenario per event; assert on rendered TUI output rather than exit code.

### R8 — Desktop-app (Electron) path not separately exercised.
All captures used `codex.exe exec` (originator `codex_exec`). The desktop app drives the same Rust engine through `app-server`, so the wire contract should be identical, but the originator string, feature flags (`x-codex-beta-features`), and connector/web-search tool entries may differ.
*Cheapest verification:* point `C:\Users\ailuo\.codex\config.toml` at the gateway (a user-owned file — **not** modified by this study) and observe the app's traffic on the same capture log.

---

## 9. Evidence index

### 9.1 Binary offsets cited (decimal / hex, `codex.exe`, 324,622,128 bytes)

| Claim | Offset |
|---|---|
| `/v1/responses` (responses-api-proxy default `upstream-url`) | 258,586,854 / `0xF69B8E6` |
| `/models` route-probe diagnostics block | 251,667,161 / `0xF0022D9` |
| `GET /models returns 2xx, 401, or 403` | 251,667,157 / `0xF0022D5` |
| `/models` LM Studio client | 251,487,529 / `0xEFD6529` |
| `ModelProviderInfo` provider-key blob (`base_url` … ) | 251,599,860 / `0xEFF1BF4` |
| `struct ModelProviderInfo with 20 elements` | 251,600,074 / `0xEFF1CCA` |
| `experimental_bearer_token`, `gateway_oauth`, `requires_openai_auth` | 250,781,108 / `0xEF29DB4` |
| Responses request field order (`response.create … access_programs`) | 257,231,880 / `0xF550C08` |
| Responses-**WS** request field order (+ `previous_response_id`, `generate`, `codex_output_schema`) | 252,491,018 / `0xF0CB4F8` |
| `struct ResponsesStreamEvent with 13 elements` | 252,500,719 / `0xF0CDAEF` |
| `struct ResponseCompletedUsage` / `struct Error` (6 fields each) | 252,447,500 / `0xF0C0B0C` |
| `internally tagged enum ResponseItem` (tag list) | 252,485,984 / `0xF0CA160` |
| `ContentItem` tags | ≈252,494,900 / `0xF0C9D24` |
| `codex-api\src\sse\responses.rs` module path | 252,490,488 / `0xF0CB2F8` |
| `response.created` | 252,482,512 / `0xF0C9350` |
| `response.completed` | 252,490,613 / `0xF0CB3F5` |
| `response.failed` | 252,468,326 / `0xF0C7E26` |
| `response.metadata` | 252,498,208 / `0xF0CD120` |
| `response.output_item.added` | 252,507,938 / `0xF0CF822` |
| `response.output_item.done` | 252,498,560 / `0xF0CD200`, 252,508,075 / `0xF0CF8AB` |
| Coalesced summary/fn-args/custom-input event block | 252,507,544 / `0xF0CF518` |
| Coalesced created/in_progress/content_part/reasoning_text block | 252,498,368 / `0xF0CD1C0` |
| `response.cancelled` | 251,551,512 / `0xEFE5118` |
| `incomplete_details` / `reason` | 252,508,091 / `0xF0CF8BB` |
| `codex-api\src\sse\responses_error.rs` response headers | ≈252,506,100 / `0xF0CEFF4` |
| `x-codex-*` rate-limit/safety response headers | ≈252,503,300 / `0xF0CE400` |
| `codex-api\src\endpoint\responses_websocket.rs` | 250,924,300 / `0xEF4CD0C` |
| `x-reasoning-included`, `openai-model`, `x-codex-turn-state` | ≈250,924,450 / `0xEF4CDA0` |
| `codex-api\src\endpoint\responses.rs` (`session-id`, `thread-id`, `x-openai-subagent`) | 252,493,992 / `0xF0CC0A8` |
| `codex-api\src\endpoint\models.rs` | 257,461,016 / `0xF58F418` |
| `model_catalog_json` config key | 251,101,518 / `0xEF7814E` |
| `chat/completions` | **absent (rg exit 1)** |
| `/responses/` (retrieve/cancel paths) | **absent (rg exit 1)** |

All exact offsets above were re-read directly from the binary and confirmed to contain the quoted text (spot-check harness: `tools\range-dump.ps1 -Start <offset> -End <offset+90>`).

### 9.2 Capture artefacts

| File | Contents |
|---|---|
| `research\capture\gateway.py` | Reference implementation, all scenarios |
| `research\capture\run-scenario.ps1` | Start gateway → run `codex exec` → collect |
| `research\capture\auth-matrix.ps1` | Five provider-auth variants |
| `research\capture\status-matrix.ps1` | 401/404/429/500 + SSE error-event matrix |
| `research\capture\ws-probe.py` | Raw TCP listener for the WebSocket upgrade |
| `research\capture\capture.jsonl` | Latest raw request log (method, path, headers, body) |
| `research\capture\logs\*.capture.jsonl` | Per-scenario raw request logs |
| `research\capture\logs\*.codex.{out,err}.txt` | Per-scenario client stdout/stderr |
| `research\capture\logs\catalog.json` | `codex debug models` output (572,649 bytes) |
| `research\capture\homes\<variant>\config.toml` | The exact configs used for each auth variant |
| `research\example-request.json` | Real captured request body, long strings elided |

### 9.3 Reproduce

```powershell
# gateway (scenario "minimal" is the capture-verified shortest working path)
$env:GW_SCENARIO="minimal"; $env:GW_PORT="10199"
& <python> C:\ailuo_own\gpt++\research\capture\gateway.py

# client, isolated CODEX_HOME so ~/.codex is never touched
$env:CODEX_HOME="C:\ailuo_own\gpt++\research\capture\codex-home"
& "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe" `
  exec --skip-git-repo-check -s read-only --color never "Say hello."
```

Observed result: exit 0, stdout `minimal path works`, `tokens used 4`.

---

## 10. One-paragraph answer

A Codex `wire_api = "responses"` provider needs exactly one hot-path endpoint — `POST {base_url}/responses`, always `Accept: text/event-stream`, always `stream: true` and `store: false`, with a stateless full-transcript `input[]` array — plus an optional unauthenticated `GET {base_url}/models` probe that must not 404. The response must be SSE whose every `data:` payload carries a `type` field the client recognises (the `event:` line is optional and the JSON `type` is authoritative), and the stream must terminate with `response.completed`. The smallest stream that works is two frames: a `response.output_item.done` holding a finished `message` item **whose `content[].text` is populated**, and a `response.completed` carrying `usage.total_tokens` — streaming deltas are cosmetic and render nothing on their own. Tool calls are ordinary output items (`function_call` with a JSON-string `arguments`, or `custom_tool_call` with a raw-string `input`), and the client returns them on the next turn as `function_call_output` / `custom_tool_call_output` items matched by `call_id`. The chosen model slug arrives verbatim in `body.model` and the gateway may remap it freely, but the slug should be one the client's catalog does not know, so the client stays on the classic request shape.
