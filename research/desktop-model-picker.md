# How the ChatGPT/Codex Desktop model picker decides what to show — and how to add a third-party model

Target: MSIX `OpenAI.Codex` 26.930.2377.0, `C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0`.
Engine bundled with it: `app\resources\codex.exe` = `codex-cli 0.159.0-alpha.12.1`.
All byte offsets refer to the already-extracted files in `C:\ailuo_own\gpt++\tools\asar-out\` (text) or to
`app\resources\codex.exe` (binary; offsets are true byte offsets, verified with a byte-exact scanner).

> **Method note.** Everything marked **[PROVEN]** was reproduced by running the engine's own
> `codex debug models`, `codex app-server` (real `model/list` JSON-RPC over stdio) and `codex exec`
> against stub servers, using **isolated `CODEX_HOME` directories inside this workspace**
> (`tools\testhome`, `tools\variants*`, `tools\realhome`). Nothing under `C:\Users\ailuo\.codex` or
> `C:\Program Files\WindowsApps` was modified — the user's files were only read and *copied*.

---

## 1. Verdict

**The picker route works — fully, not partially — but only through `model_catalog_json`.**

| Question | Answer | Status |
|---|---|---|
| Can the model picker display custom/third-party models? | **Yes.** The picker's list is whatever the local Codex engine returns from the app-server `model/list` RPC, and the engine returns the contents of the file named by `model_catalog_json`. | [PROVEN] R2/V1/V19 |
| Which config condition is required? | `model_catalog_json = "<abs path to .json>"` set as a **top-level** key of `config.toml` (before the first `[table]`), pointing at a JSON object `{"models":[…]}` with ≥1 valid entry. | [PROVEN] R1 vs R2 |
| Which per-entry conditions make it *appear*? | `visibility: "list"` (→ `hidden:false`) **and** `supported_in_api: true`. `visibility:"hide"`/`"none"` → `hidden:true` → filtered out client-side; `supported_in_api:false` → the entry is dropped from `model/list` altogether. | [PROVEN] V1/V2/W1 |
| Does it need `model_provider`/`model_providers`? | **For display: no.** For *use*: yes — routing goes through `model_providers.<id>`; without it the request is sent with the default OpenAI provider. | [PROVEN] V4 + relay e2e |
| Does the local catalog merge with the server/bundled list? | **No. It replaces it completely.** With a catalog configured the built-in GPT models are gone from `model/list`. | [PROVEN] V1/V19/probe-full |
| Is a server-fetched catalog involved? | A server path exists (`GET /v2/models` for ChatGPT-account transports, cached in `models_cache.json`), but for the local host the local catalog/bundled catalog wins. The user's stale `models_cache.json` is **not** consulted. | [PROVEN] R0, main.js:3177283 |

**Blunt summary:** the picker cannot be fed by `model_providers` alone, and it cannot be fed by editing
`models_cache.json`. The single switch is `model_catalog_json`, and it is a *replacement*, not an
addition — turning it on deletes the built-in GPT models from the picker unless you re-declare them in
your catalog file.

---

## 2. Where the picker's model list comes from (config → list)

### 2.1 Data source: an app-server RPC, not a bundled array

`app-initial.js` @4019868 defines the react-query used by every model picker surface:

```js
j5r=ec(q,({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,
           hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o,limit:s,modelCatalogPath:c,
           modelProvider:l},{get:u,queryClient:d,scope:f})=>{
  let p=n==null?u(w5r):new Set([...n,`persistent`]), m=u(y5r), h=a&&u(Gl,`1186680773`);
  return{
    queryKey:[...Vye(i,t,s), ...o?[l]:[], ...c==null?[]:[c]],
    enabled:u(ra).includes(i),
    refetchOnWindowFocus:!0,
    staleTime:ca.FIVE_MINUTES,
    queryFn:({queryKey:e})=>{
      let n=d.getQueryData(e)==null?`interactive`:`background`;
      return o&&d.removeQueries({exact:!0,queryKey:Vye(i,t,s)}),
      Fc(f,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:n})
    },
    select:({data:n})=>c5r({additionalAvailableModels:new Set(e),authMethod:t,availableModels:m.availableModels,
      defaultModel:m.defaultModel,enabledReasoningEfforts:p,hasConfiguredModelCatalog:r,
      includeUltraReasoningEffort:h,isCustomModelProvider:o,models:n,useHiddenModels:m.useHiddenModels})
  }
})
```

Three things to read off this snippet:

* **`sendRequest('model/list', {includeHidden:true, cursor:null, limit})`** — the list comes from the
  **Codex engine** (app-server JSON-RPC), always with `includeHidden:true`. Hidden models are delivered
  and then filtered in the renderer, not by the server.
* **The query key embeds only the catalog *path*, never its contents**
  (`...c==null?[]:[c]` where `c = modelCatalogPath`). Editing the file at the same path does not
  invalidate the query; `refetchOnWindowFocus:true` + `staleTime = 5 min` is what eventually picks up
  an edit. See risk R-5.
* **`Vye`** (app-shared.js @5478473, exported as `O3r`, re-exported `O3r as VN` @7732323) is
  `function O3r(e,t,n=100){return[...k3r,e,t??`no-auth`,n]}` with
  `k3r=[`models`,`list`]` — i.e. the query key starts `["models","list",hostId,authMethod??"no-auth",limit]`.

The `queryKey` value is also assembled in one more place (app-initial.js @9515800) which confirms the
same three components:

```js
p=s==null?s:Hm(s), m=Vye(e.hostId,u.authMethod);
hVe(p)&&m.push(p?.model_provider??``),
typeof p?.model_catalog_json==`string`&&m.push(p.model_catalog_json);
```

### 2.2 The two config predicates that gate everything

`app-shared.js` @2826987–2827504 (the block that also defines `UB`/`Hm`, the config resolver):

```js
function UB(e){let t=K9t(e.profiles),n=typeof e.profile==`string`?K9t(t?.[e.profile]):null;
  if(n==null)return e; let r={...e};
  for(let[e,t]of Object.entries(n))t!=null&&(r[e]=t); return r}
function W9t(e){return typeof e?.model_catalog_json==`string`&&e.model_catalog_json.trim().length>0}
function G9t(e){let t=e?.model_provider,n=K9t(e?.model_providers);
  return typeof t==`string`&&n!=null&&Object.hasOwn(n,t)}
function K9t(e){let t=q9t.safeParse(e);return t.success?t.data:null}   // q9t = Su(z(),qu())  (record<string, unknown>)
```

These are re-exported (`W9t as iLt` @7752585, `G9t as oLt` @7761303, `UB as rLt` @7765647) and imported by
`app-initial.js` (@117523 `iLt as IPe`, @122167 `oLt as hVe`, @124515 `rLt as Hm`, @107054 `VN as Vye`), so:

* `IPe(cfg)` = `W9t(cfg)` = **`hasConfiguredModelCatalog`** — true iff `model_catalog_json` is a non-empty string.
* `hVe(cfg)` = `G9t(cfg)` = **`isCustomModelProvider`** — true iff `model_provider` is a string that is a key of `model_providers`.
* `Hm(cfg)` = `UB(cfg)` = **profile merge**: if `profile` names an entry of `profiles`, that profile's
  non-null keys are copied over the top-level config *for the webview's view of the config only*.
  (`Hm` is applied to every `config/read` result: app-initial.js @3991768, @3992141, @4018487, @9516542 — the last
  two also feed `IPe`/`hVe` at @9516542 and @9516937.)

`D5r` (app-initial.js @4018058) is the hook the UI calls; the relevant part (@4018487, @4018706):

```js
c = s==null?null:Hm(s.config),  g=gm, _=j5r,
u = i?.authMethod??null, d=e?.enabledReasoningEfforts, f=IPe(c), p=n,
m = e?.includeUltraReasoningEffort!==!1, h=hVe(c),
...
b = {additionalAvailableModels:l, authMethod:u, enabledReasoningEfforts:d, hasConfiguredModelCatalog:f,
     hostId:p, includeUltraReasoningEffort:m, isCustomModelProvider:h, limit:r,
     modelCatalogPath:v, modelProvider:y}          // v = c.model_catalog_json, y = c.model_provider
```

### 2.3 The visibility filter (the actual "what shows in the list" decision)

`app-initial.js` @4014704 (`c5r`) and @4015763 (`l5r`), verbatim:

```js
function c5r({additionalAvailableModels:e,authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,
              hasConfiguredModelCatalog:a,includeUltraReasoningEffort:o,isCustomModelProvider:s=!1,models:c,useHiddenModels:l}){
  let u=[],d=null, f=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),
      p=o&&c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));
  return c.forEach(r=>{
    if(l5r({additionalAvailableModels:e,authMethod:t,availableModels:n,hasConfiguredModelCatalog:a,isCustomModelProvider:s,model:r,useHiddenModels:l})){
      let e=o?r.supportedReasoningEfforts:r.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),
          n=(t===`copilot`?[e.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:e)
              .filter(({reasoningEffort:e})=>Dye(e)&&i.has(e)),
          a={...r,supportedReasoningEfforts:n};
      u.push(a), r.isDefault&&(d=a)
    }
  }),
  d??=u.find(e=>e.model===r)??null,
  {models:u,defaultModel:d,hasModelSupportingMaxReasoningEffort:f,hasModelSupportingUltraReasoningEffort:p}
}

function l5r({additionalAvailableModels:e,authMethod:t,availableModels:n,hasConfiguredModelCatalog:r,
               isCustomModelProvider:i,model:a,useHiddenModels:o}){
  return e?.has(a.model)===!0
      || a.model!==`codex-auto-review` && (
             r&&!a.hidden
          || (o&&!i&&t!==`amazonBedrock` ? n.has(a.model) : !a.hidden))
}
```

Read as a decision table for one model row `a`:

1. If `a.model` is in `additionalAvailableModels` → **always shown**.
2. Else if `a.model === 'codex-auto-review'` → **never shown in this list**.
3. Else if `hasConfiguredModelCatalog && !a.hidden` → **shown**.
4. Else if `useHiddenModels && !isCustomModelProvider && authMethod !== 'amazonBedrock'` → shown only if the slug is in `availableModels`.
5. Else → **shown iff `!a.hidden`**.

`additionalAvailableModels`/`availableModels`/`useHiddenModels` do **not** come from `config.toml`: they
come from the persisted UI store (`h5r=[]`, `g5r={availableModels:new Set(h5r),useHiddenModels:!1,defaultModel:mle}`
@4016525, `y5r=rn(q,g5r,{isEqual:v5r.default})` @4016683) which is seeded by `m5r(e)` @4016184 reading a **Statsig dynamic
config** (`Ic('107580212')` → `Gfn` = `getDynamicConfig`, app-shared.js @3285250):

```js
function m5r(e){let t=Jh(K()).safeParse(e.available_models),n=Eg().safeParse(e.use_hidden_models),
  r=K().safeParse(e.default_model);
  return{availableModels:new Set(t.success?t.data:h5r),useHiddenModels:n.success?n.data:g5r.useHiddenModels,
         defaultModel:r.success?r.data:g5r.defaultModel}}
```

So a user cannot simply list a hidden model into the picker via TOML; the supported route is
`visibility: "list"`.

### 2.4 Engine side: where `model/list` is actually computed

`model/list` is an app-server method (wire schema generated by the binary itself):

* `codex app-server generate-json-schema --out <dir>` produces `v2/ModelListParams.json`
  (`includeHidden`, `cursor`, `limit`) and `v2/ModelListResponse.json` (`data: Model[]`, each with
  required `defaultReasoningEffort, description, displayName, hidden, id, isDefault, model,
  supportedReasoningEfforts`).
* In the desktop main process the same method can be proxied to the ChatGPT backend:
  `main.js` @3173692 defines the zod schema for `model/list`, @3174389 maps it in `nqe`, and @3177283
  contains
  ```js
  case`model/list`: f=`/v2/models`; break;
  ```
  i.e. `GET {backend}/v2/models` for account-backed transports. (Renderer-side zod mirror in main.js is
  what the desktop uses for validation.)

For the **local** host, the catalog is produced by the Rust module whose source path is baked into the
binary (`models-manager\src\model_info.rs`, codex.exe @257607197) which embeds a 407 079-byte default
catalog at **codex.exe @257607192** starting `{\r\n  "models": [\r\n    {\r\n      "slug": "gpt-6-astra", …`.
The user-facing error strings for the catalog live at codex.exe @254631894:

```
model_catalog_json path `<p>` must contain at least one model
failed to parse model_catalog_json path `<p>` as JSON: <serde error>
```

and on failure the engine logs, on stderr, e.g. `codex_app_server: Invalid configuration; using defaults.`
then serves the bundled catalog instead.

`models_cache.json` is a *cache written by the engine*, not a knob: codex.exe @258018448
(`failed to write models cache` … `models_cache.json`) and @257518552
(`ModelsCacheEntry` with fields `fetched_at","etag","client_version","identity","models"`).
**[PROVEN R0]** placing the user's real `models_cache.json` (which contains stale `MovoAPI/*` entries)
next to a config without `model_catalog_json` yields the 10 bundled models — the cache is ignored.

### 2.5 Every config key involved in the decision

| Key | Role in the picker decision | Evidence |
|---|---|---|
| `model_catalog_json` (string, abs path) | **The switch.** Non-empty ⇒ `hasConfiguredModelCatalog=true`; the engine loads that file as the *entire* catalog. | app-shared.js @2827204; codex.exe @254631894 |
| `model` (string) | The selected/requested slug. Also written into the request body. If it matches a catalog slug the app shows that name; otherwise the composer still prints the raw string but the picker list won't contain it. | app-initial.js @4045027 (`Q9r`); relay e2e |
| `model_provider` (string) | Makes `isCustomModelProvider=true` (only if it is a key of `model_providers`). Changes the query key and the client-side `removeQueries` behaviour; **not** required for the catalog to be listed. | app-shared.js @2827280; V4 |
| `model_providers` (table) | `K9t` = `z.record(z.string(), z.unknown())` — existence of the key is what `G9t` tests. | app-shared.js 2827392 (`function K9t`), `q9t` at 2827460 |
| `model_providers.<id>.name/base_url/wire_api/requires_openai_auth/experimental_bearer_token/…` | Routing + credentials. Full accepted set (codex.exe @250781081): `base_url, model_catalog_url, env_key, env_key_instructions, experimental_bearer_token, gateway_oauth, aws, wire_api, query_params, http_headers, env_http_headers, request_max_retries, stream_max_retries, stream_idle_timeout_ms, websocket_connect_timeout_ms, requires_openai_auth, supports_websockets, supports_standalone_web_search`. | codex.exe @250781081; relay e2e |
| `profile` / `profiles.<name>` | `Hm`/`UB` merges the named profile over the top level *for the webview*; a `model_catalog_json` inside a profile is therefore visible to the picker logic as if top-level. | app-shared.js @2826987 |
| `available_models`, `use_hidden_models`, `default_model` | **Not TOML keys** — Statsig dynamic-config fields feeding `m5r`. | app-initial.js @4016184 |

---

## 3. Exact `model_catalog_json` schema

### 3.1 Top level

```jsonc
{ "models": [ /* ≥1 entry */ ] }
```

* `models` is **required**: `{"data":[…]}` fails with `missing field 'models'` **[PROVEN W7]**.
* A bare JSON array fails (`invalid type: map, expected a sequence` — i.e. an object is expected) **[PROVEN W3]**.
* An empty array fails with `model_catalog_json path ... must contain at least one model` and the engine falls
  back to the bundled catalog **[PROVEN V11]**.
* Extra top-level keys are tolerated **[PROVEN W12]**.

### 3.2 Per-model entry — required vs optional

Recovered by using the engine as an oracle: start from a full bundled entry, delete one key at a time,
observe whether `codex debug models` still parses (`tools\catalog-probe.cjs --required`,
log `tools\out\required-sweep2.txt`), then greedily delete everything deletable
(`tools\catalog-minimize.cjs`, log `tools\out\minimize-log.txt`).

**Required (12 slots, 11 keys + a message source):**

| Field | Notes |
|---|---|
| `slug` | string; this is what `model/list` returns as `model`/`id`, and what `model` in config.toml must match |
| `display_name` | string; rendered label |
| `supported_reasoning_levels` | array of `{effort, description}`; `effort` is a **free-form string** (no enum — `"bogus"` parses, `"none"/"persistent"/"max"` parse). Empty array is accepted. |
| `shell_type` | enum: `default` \| `local` \| `shell_command` \| `unified_exec` \| `disabled` |
| `visibility` | enum: `list` \| `hide` \| `none` |
| `supported_in_api` | bool — **must be `true`** or the model is dropped from `model/list` entirely |
| `priority` | integer; ascending sort order of the returned list |
| `support_verbosity` | bool |
| `truncation_policy` | object; `mode` enum `bytes` \| `tokens`, plus `limit` |
| `experimental_supported_tools` | array of strings (may be `[]`) |
| `model_messages` **or** `base_instructions` | `model_messages.instructions_template` must be a string (empty string is fine), **or** supply top-level `base_instructions`. Otherwise: ``model `x` is missing both `base_instructions` and `model_messages.instructions_template` `` |

**Optional (verified deletable, 39 keys):** `prefer_websockets`, `default_verbosity`,
`apply_patch_tool_type`, `web_search_tool_type`, `input_modalities`, `supports_image_detail_original`,
`supports_parallel_tool_calls`, `tool_mode`, `multi_agent_version`, `multi_agent_reasoning_effort`,
`use_responses_lite`, `supports_reasoning_effort_updates`, `include_skills_usage_instructions`,
`include_apps_usage_instructions`, `include_plugin_usage_instructions`, `guardian`,
`node_repl_auto_review_required`, `node_repl_disabled`, `requires_sandboxed_review`,
`auto_review_model_override`, `model_specialty`, `context_window`, `max_context_window`,
`auto_compact_token_limit`, `comp_hash`, `default_reasoning_summary`, `description`,
`default_reasoning_level`, `minimal_client_version`, `availability_nux`, `upgrade`,
`available_in_plans`, `supports_search_tool`, `supports_experimental_context`, `default_service_tier`,
`service_tiers`, `additional_speed_tiers`, `supports_reasoning_summary_parameter`,
`supports_reasoning_summaries`.

Additional accepted keys visible in the binary's serde field table (codex.exe @251978998) and in the
bundled catalog: `available_access_programs`, `effective_context_window_percent`, `base_instructions`.
Unknown extra keys are **not** rejected (no `deny_unknown_fields`) **[PROVEN W2]**.

**There is no zod schema for the catalog in the JS bundles.** The webview never parses the catalog file;
it only consumes the `model/list` response (`main.js` @3173692 has the zod for that RPC). The authority is
the Rust serde struct (`ModelInfo`, field table at codex.exe @251978998).

### 3.3 Minimal valid entry (verified)

```json
{
  "slug": "claude-sonnet-4.5",
  "display_name": "Claude Sonnet 4.5",
  "supported_reasoning_levels": [
    { "effort": "low", "description": "Fast" },
    { "effort": "medium", "description": "Balanced" },
    { "effort": "high", "description": "Deep" }
  ],
  "shell_type": "shell_command",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 1,
  "support_verbosity": true,
  "truncation_policy": { "mode": "tokens", "limit": 10000 },
  "model_messages": { "instructions_template": "You are a helpful coding agent." },
  "experimental_supported_tools": []
}
```

---

## 4. Visibility rules, and local vs server catalog

**Mapping `visibility` → `hidden` [PROVEN V1/W1]:**

| catalog `visibility` | `model/list` `hidden` | in `includeHidden:false` (default list) |
|---|---|---|
| `list` | `false` | yes |
| `hide` | `true` | no |
| `none` | `true` | no |

`supported_in_api: false` removes the entry from **both** lists (a catalog containing only such an entry
returns 0 models) **[PROVEN V2]**.

**Local vs server: replacement, not merge.**

* With `model_catalog_json` set, `model/list` returns *only* the catalog's entries — the 10 bundled models
  (`gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
  gpt-daybreak-blue-latest, gpt-daybreak-red-latest, gpt-5.5, codex-auto-review`) disappear
  **[PROVEN probe-full, V1, V19]**.
* There is no precedence contest to reason about: the local file is the whole catalog. **[PROVEN T2]**:
  a provider's `model_catalog_url` was *not even fetched* (stub HTTP server logged no request) and the
  local file still won.
* Without `model_catalog_json`, the bundled catalog is served, and the stale `models_cache.json` is
  ignored **[PROVEN R0]**.

**What happens to the built-in GPT models:** they are gone from `model/list` while a catalog is set.
If you still want them, you must copy their entries into your catalog file — the exact JSON is available
at codex.exe @257607192 (407 079 bytes) or from `codex debug models --bundled`.

**Ordering / default [PROVEN V8, V13, V17]:** entries come back sorted by `priority` ascending.
`isDefault` is set on the **first entry of the returned order**, not on the model named by config
`model`. The renderer then applies `d ??= u.find(e=>e.model===r)??null` using its own saved default.

**Which model name the composer displays:** `Q9r` (app-initial.js @4045027):

```js
function Q9r({userSavedModelString:e,userSavedReasoningEffort:t,listModelsData:n}){
  let r=e?Z9r(n?.models,e):n?.defaultModel??Z9r(n?.models,`gpt-5.5`), …
  return{model:r?r.model:e??`gpt-5.5`, …}}
```

so a saved-but-unlisted slug is still *printed*, but it can never be *picked* from the list. With a
non-ChatGPT provider the saved string is `config.model` (the `isChatGptAuth` guard in `rei`
@4047099 sets `userSavedModelString` to `null` only for ChatGPT auth). That is exactly the user's current
state: the composer prints `gpt-6.1-sol` while the picker menu contains only the 7 visible GPT models.

---

## 5. Working config recipe

### 5.1 `C:\Users\ailuo\.codex\config.toml`

**Placement matters.** The top-level keys must appear **before the first `[table]` header**. The current
file starts tables at line 6, so lines 1–4 are the only safe place. Appending the key at the end puts it
inside `[windows]` and the engine warns and ignores it **[PROVEN R1]**:
``Codex is ignoring 1 unrecognized configuration setting … `windows.model_catalog_json` is ignored.``

```toml
model = "claude-sonnet-4.5"
model_provider = "relay"
model_catalog_json = "C:\\Users\\ailuo\\.codex\\relay-catalog.json"

[model_providers.relay]
name = "My Relay"
base_url = "https://mhapi.net"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "sk-..."

# ... the rest of the existing file (notify, mcp_servers, desktop, windows, ...) unchanged ...
```

* The credential is supplied by `experimental_bearer_token` (verified end-to-end: the engine sent
  `Authorization: Bearer <token>` to `base_url` **[PROVEN relay e2e]**). Alternatives accepted by the same
  struct (codex.exe @250781081): `env_key` (+ `env_key_instructions`), `http_headers`,
  `env_http_headers`, `query_params`, `requires_openai_auth = true` for ChatGPT-token auth.
* **Delete the now-dead `model_reasoning_effort = "xhigh"`** or make sure the value exists in the new
  entry's `supported_reasoning_levels`; the renderer filters efforts with
  `Dye(e) && i.has(e)` (app-initial.js @4015537) and unknown efforts are silently dropped.
* Path style: `model_catalog_json` is read by Rust; use a plain absolute Windows path with
  **doubled backslashes** in TOML (or forward slashes). The existing `opencodex.config.toml` shows the
  doubled-backslash form working.

### 5.2 `C:\Users\ailuo\.codex\relay-catalog.json`

```json
{
  "models": [
    {
      "slug": "claude-sonnet-4.5",
      "display_name": "Claude Sonnet 4.5",
      "description": "Third-party model served by the relay.",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Balances speed and depth" },
        { "effort": "high", "description": "Greater reasoning depth" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 1,
      "support_verbosity": true,
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "model_messages": { "instructions_template": "You are a helpful coding agent." },
      "experimental_supported_tools": []
    },
    {
      "slug": "gpt-6.1-sol",
      "display_name": "GPT-6.1 Sol",
      "description": "Third-party model served by the relay.",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast" },
        { "effort": "medium", "description": "Balanced" },
        { "effort": "high", "description": "Deep" },
        { "effort": "xhigh", "description": "Extra high" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 2,
      "support_verbosity": true,
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "model_messages": { "instructions_template": "You are a helpful coding agent." },
      "experimental_supported_tools": []
    }
  ]
}
```

Set `model = "<one of the listed slugs>"` so the composer's saved string resolves inside the list.
**[PROVEN R2]** with the user's *real* config.toml (copied) plus this top-level key, `model/list` returned
exactly `gpt-6.1-sol[hidden=false,def=true]` and a `visibility:"hide"` sibling
`claude-hidden[hidden=true]`, with `includeHidden=false` returning only the visible one.

After editing: fully restart the app (or at minimum focus the window after 5 minutes) — see R-5.

### 5.3 Verify without touching the app

```
set CODEX_HOME=<scratch dir>
codex.exe debug models            :: prints the raw catalog the engine resolved
codex.exe app-server --stdio      :: then send initialize / initialized / model/list
```

`tools\appserver-drive.cjs <home> <label>` in this repo does the JSON-RPC handshake and prints exactly
what the picker receives, including the `hidden` flags.

---

## 6. Uncertainties, risks, and how to test each

| # | Risk / uncertainty | Evidence | Test |
|---|---|---|---|
| R-1 | **TOML placement.** Any table header before the key silently swallows it (`windows.model_catalog_json` is ignored). This is almost certainly the first thing that will go wrong. | [PROVEN R1] | After editing, run `codex.exe debug models` with `CODEX_HOME=C:\Users\ailuo\.codex` and grep stderr for `is ignored`. |
| R-2 | **Whole-catalog rejection.** One malformed entry invalidates the entire file; the engine logs one stderr line and serves the bundled list. There is no per-entry skip. | [PROVEN V7/V15/V16] | Same `debug models` run: any `failed to parse model_catalog_json path` means nothing from your file is active. |
| R-3 | **Built-ins vanish.** Setting the catalog drops all 10 GPT models from `model/list`. Users often expect a merge. | [PROVEN probe-full/V19] | `appserver-drive.cjs` and look for `gpt-6-astra`; if absent, that is expected. |
| R-4 | **`supported_in_api` / `visibility` traps.** `supported_in_api:false` removes the row; `visibility:"hide"|"none"` hides it from the picker even though `model/list` still returns it. | [PROVEN V2/W1] | `appserver-drive.cjs` prints `hidden=` per model. |
| R-5 | **Stale list after editing the catalog.** The react-query key contains the *path* only, so writing new content to the same file does not invalidate it; `staleTime` is 5 min, `refetchOnWindowFocus:true`. Whether the *engine* re-reads `config.toml`/catalog per request was not proven. | app-initial.js @4020204/@4020259 | Edit the catalog's `display_name` only, refocus the window, watch the picker label. If it does not change, restart the app. |
| R-6 | **`model` mismatch.** With `model` set to a slug absent from the catalog, the list shows the first entry as `isDefault` and the composer still prints the raw saved string. | [PROVEN V9/V13]; `Q9r` @4045027 | `appserver-drive.cjs`: check `default=` on the row you expect. |
| R-7 | **MSIX packaging / version drift.** The webview logic above is for 26.930.2377.0; the engine is `0.159.0-alpha.12.1` and is *replaced on update*. A future catalog schema change would surface as `missing field …`. | — | Re-run `codex.exe debug models --version`-style checks after an app update; re-run `tools\catalog-probe.cjs`. |
| R-8 | **`model_catalog_url` looks like a shorter route but is inert here** (no HTTP request was observed even with a live stub server). Do not rely on it. | [PROVEN T1/T2] | Point it at a local logging server and run `debug models`; if no request appears, treat it as unsupported. |
| R-9 | **Server-fetched list.** For ChatGPT-account transports `model/list` is proxied to `GET /v2/models` (main.js @3177283) and cached by the engine in `models_cache.json`. For the local host it did not apply in any test, but a signed-in account plus a remote host could change which catalog wins. | main.js @3177283; codex.exe @258018448 | Set `model_catalog_json`, sign in, and compare the picker against `appserver-drive.cjs` output; if they differ, you are on the remote host path. |
| R-10 | **Reasoning-effort strings.** `supported_reasoning_levels[].effort` is free-form, but the renderer keeps only efforts in the enabled set (`Dye(e) && i.has(e)`), and the app's `[desktop] enabled-reasoning-efforts` list (`["low","medium","high","xhigh","ultra","persistent","max"]` in the user's config) intersects it. A custom effort string that the UI does not know will never render. | app-initial.js @4015537; user config line 83 | Add `{"effort":"superhigh"}` to the catalog and see whether it appears in the effort submenu. |
| R-11 | **`experimental_bearer_token` is, by name, experimental.** The e2e test proves it is honoured today for `wire_api="responses"`; `env_key` is the more stable alternative. | [PROVEN relay e2e]; codex.exe @250781081 | Point `base_url` at a local stub that logs headers and run `codex exec --skip-git-repo-check "hi"`. |

---

## 7. Evidence index

**Extracted text bundles (byte offsets are file offsets)**

| Offset | File | What |
|---|---|---|
| 4019868 | `asar-out\app-initial.js` | `j5r` model-list query definition (queryFn `model/list`) |
| 4020204 | `asar-out\app-initial.js` | queryKey = `Vye(hostId,auth,limit)` + provider + catalog path |
| 4020483 | `asar-out\app-initial.js` | `sendRequest('model/list',{includeHidden:!0,cursor:null,limit})` |
| 4014704 | `asar-out\app-initial.js` | `c5r` select/transform of the list |
| 4015763 | `asar-out\app-initial.js` | `l5r` visibility predicate (decision table in §2.3) |
| 4018058 | `asar-out\app-initial.js` | `D5r` hook (calls `j5r`, passes `hasConfiguredModelCatalog`/`isCustomModelProvider`) |
| 4018487, 4018706, 4018757 | `asar-out\app-initial.js` | `Hm(s.config)`, `f=IPe(c)`, `h=hVe(c)` |
| 4016184 | `asar-out\app-initial.js` | `m5r`: `available_models` / `use_hidden_models` / `default_model` (Statsig) |
| 4016525, 4016683 | `asar-out\app-initial.js` | `y5r=rn(q,g5r,…)`, `g5r` defaults |
| 4045027 | `asar-out\app-initial.js` | `Q9r` displayed-model resolution |
| 4047099 | `asar-out\app-initial.js` | `rei`: `userSavedModelString` computation, `D5r` call site |
| 9515800 (block), 9516542, 9516937 | `asar-out\app-initial.js` | second assembly of the same query key; `hasConfiguredModelCatalog:IPe(p)`, `isCustomModelProvider:hVe(p)` |
| 3991768, 3992141, 3992194 | `asar-out\app-initial.js` | `Hm(config)` applied to `config/read` results; `IPe(Hm(r.config))` |
| 117523 / 122167 / 124515 / 107054 | `asar-out\app-initial.js` | import map: `iLt as IPe`, `oLt as hVe`, `rLt as Hm`, `VN as Vye` |
| 2826987 | `asar-out\app-shared.js` | `function UB(e)` — profile merge (= `Hm`) |
| 2827171 | `asar-out\app-shared.js` | `function W9t(e)` — `hasConfiguredModelCatalog` |
| 2827271 | `asar-out\app-shared.js` | `function G9t(e)` — `isCustomModelProvider` |
| 2827392, 2827460 | `asar-out\app-shared.js` | `function K9t(e)` + `q9t=Su(z(),qu())` |
| 5478473 | `asar-out\app-shared.js` | `function O3r(e,t,n=100)` (= `Vye`), `k3r=['models','list']` |
| 3285250 | `asar-out\app-shared.js` | `function Gfn(e,t)` — Statsig `getDynamicConfig` |
| 7732323, 7752585, 7761303, 7765647 | `asar-out\app-shared.js` | export map: `O3r as VN`, `W9t as iLt`, `G9t as oLt`, `UB as rLt` |
| 3173692 | `asar-out\main.js` | zod schema for `model/list` |
| 3174389 | `asar-out\main.js` | `nqe` response-schema map incl. `"model/list"` |
| 3177283 | `asar-out\main.js` | `case 'model/list': f='/v2/models'` (HTTP backend mapping) |

**`app\resources\codex.exe` (324 622 128 bytes; true byte offsets)**

| Offset | What |
|---|---|
| 257607192 | Embedded default catalog, 407 079 bytes, `{"models":[{"slug":"gpt-6-astra",…` (source path `models-manager\src\model_info.rs` at 257607197) |
| 254631894 | `model_catalog_json path \`…\` must contain at least one model` / `failed to parse model_catalog_json path \`…\` as JSON: …` |
| 251978998 | `ModelInfo` serde field table (slug, display_name, default_reasoning_level, supported_reasoning_levels, shell_type, visibility, supported_in_api, priority, …) |
| 250781081 | `ModelProviderInfo` field table (`base_url, model_catalog_url, env_key, env_key_instructions, experimental_bearer_token, gateway_oauth, aws, wire_api, query_params, http_headers, env_http_headers, request_max_retries, stream_max_retries, stream_idle_timeout_ms, websocket_connect_timeout_ms, requires_openai_auth, supports_websockets, supports_standalone_web_search`) |
| 258018448 | `failed to write models cache` / `models_cache.json` |
| 257518552 | `ModelsCacheEntry` (`fetched_at, etag, client_version, identity, models`) |
| — | `codex app-server generate-json-schema --experimental --out <dir>` → `v2/ModelListParams.json`, `v2/ModelListResponse.json` |

**Generated evidence produced by this investigation (all under `tools\out\`)**

| File | Content |
|---|---|
| `embedded-catalog.json` | 407 KB bundled catalog extracted from `codex.exe` |
| `bundled-models.json`, `probe-full.json`, `custom-models.json` | `debug models` outputs |
| `required-sweep2.txt` | required/optional sweep (11 required, 39 optional) |
| `minimal-entry.json`, `minimize-log.txt` | greedy minimisation to the 11-key entry |
| `variants-log.txt`, `variants2-log.txt`, `variants3-log.txt`, `variants4-log.txt`, `variants5-log.txt` | V1–V20, W1–W8, T1–T2 result matrix |
| `realhome-log2.txt` | R0 (real config as-is → 10 bundled models) vs R2 (key at top → 2 catalog models) |
| `relay-e2e-log.txt` | `POST /v1/responses`, `Authorization: Bearer sk-relay-test-token`, `"model":"claude-sonnet-4.5"`, `"instructions"` from the catalog entry |

**Helper scripts written for this investigation:** `tools\offsets.cjs`, `tools\catalog-probe.cjs`,
`tools\catalog-minimize.cjs`, `tools\appserver-probe.cjs`, `tools\appserver-drive.cjs`,
`tools\variants.cjs`, `tools\variants2.cjs`, `tools\variants3.cjs`, `tools\variants4.cjs`,
`tools\variants5.cjs`, `tools\realhome-probe.cjs`, `tools\relay-e2e.cjs`.
