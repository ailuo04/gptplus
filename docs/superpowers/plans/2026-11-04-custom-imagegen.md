# Custom Image Generation Implementation Plan

> **For agentic workers:** Execute inline, task by task; use superpowers:test-driven-development and superpowers:verification-before-completion. No subagents or commits are required.

**Goal:** Ship a configurable custom-imagegen marketplace plugin with secure credentials, fixed execution routing and honest skill-priority controls.

**Architecture:** Reuse the existing plugin manager, secure store, authenticated local gateway and plugin IPC lifecycle. Add focused image execution and managed-skill modules; ship a dependency-free Python client inside the installed skill.

**Tech Stack:** Electron, CommonJS Node.js, node:test, browser ES modules, Python 3 standard library.

---

## Task 1: Configuration and credentials
Files: src/core/plugin-manager.js, src/core/store.js, test/custom-imagegen.test.js, test/core.test.js.
- [x] Add failing tests for opt-in installation, normalization, public key masking and encrypted persistence/reload.
- [x] Run `node --test test/custom-imagegen.test.js` and observe missing-feature failures.
- [x] Add custom-imagegen definition, strict config normalization, preserve-empty-key updates, and secure disk serialization/deserialization. Run targeted tests.

## Task 2: Fixed-route image service and local gateway
Files: src/core/image-generation.js, src/core/gateway/server.js, src/core/context.js, test/custom-imagegen.test.js.
- [x] Add failing local HTTP tests: exact configured URL/model/key; caller overrides rejected; disabled/missing config rejected; upstream errors and redirects never cause fallback; response/size validation.
- [x] Implement `createImageGeneration({plugins, fetchImpl})`, returning `generate(input)`; enforce prompt/size/count and bounded timeout/response. Register authenticated loopback-only POST /gptplus/images/generations.
- [x] Run service and gateway tests, asserting no upstream calls on rejected local requests.

## Task 3: Managed skill and transactional lifecycle
Files: src/core/imagegen-skill.js, src/core/assets/custom-imagegen/generate.py, src/core/ipc.js, src/core/context.js, test/custom-imagegen.test.js.
- [x] Add failing tests for install, default preference, disable, user edit conflicts, backup, repeat enable, persistence rollback and secret-free skill contents.
- [x] Install SKILL.md, agents/openai.yaml and scripts/generate.py; store only the app config path in the locator. Maintain checksum-protected skills.config block with absolute SKILL.md paths. Preserve unrelated settings and refuse inline-array conflicts.
- [x] Wire plugin enable/disable/uninstall/config changes through one rollback-capable IPC transaction. Restore runtime at startup only when the plugin was enabled; do not modify user configuration on ordinary startup if unchanged.
- [x] Test the installed Python helper end-to-end against a local synthetic image server; verify no overwrite, failure exit status and no credential output.

## Task 4: Marketplace configuration and status
Files: src/renderer/views/plugins.js, src/main/preload.cjs, src/core/ipc.js, src/core/context.js, test/renderer.test.js, README.md.
- [x] Add failing renderer tests for URL/key/model/default fields, blank-key preservation, default change restart hints and no strong-guarantee wording.
- [x] Add configuration modal, enable confirmation, runtime status and explicit paid-generation route verification action. Return verification summary only (no base64 or key) to renderer.
- [x] Document supported Images API, gpt++/gateway/Python prerequisites, restart/new-conversation steps and automatic-selection limits.

## Task 5: Verification and review
- [x] Run `npm test`; fix regressions without weakening assertions.
- [x] Run `node --check` on changed CommonJS files and Python AST parsing without writing pycache.
- [x] Run isolated Electron marketplace smoke rendering; inspect screenshot and runtime error count.
- [x] Review diffs for accidental secrets, unrelated changes, dropped functionality and temporary files. Report real provider/new-session checks as unverified unless actually performed.

## Final verification (2026-11-04)
- Full `npm test`: 442 tests, 440 passed, 0 failed, 2 environment-dependent tests skipped (missing models_cache.json; existing real config is already injected).
- 11 JavaScript syntax checks, Python AST parse and git diff whitespace checks passed.
- Real isolated Codex 0.166.0-alpha.6 strict-config and skills/list accepted the generated configuration: gptplus-imagegen enabled, built-in imagegen disabled, no skill loading errors. No model turn or paid provider request was made.
- Isolated hidden Electron UI: no renderer errors, key input blank, save footer visible; inspected marketplace/config and delivery screenshot.
- Added screenshot controls and per-request scope tests: generation overrides do not write storage or affect later/concurrent generations; omitted fields keep saved defaults.
- Initial implementation was kept in the original workspace without publishing. A later explicit user request authorizes packaging and releasing v1.7.1; real provider compatibility and natural-language selection in a new real conversation remain unverified.
