---
name: gptplus-imagegen
description: Use when the user asks to generate a new raster image, draw a picture, or create an illustration, photo, cover, or bitmap asset using their configured gpt++ image provider. Supports text-to-image only; not editing existing images, SVG/code-native visuals, or image analysis.
---

# gpt++ Custom Image Generation

Use the user's configured image service through the bundled executor. URL, API key and model are read by gpt++; do not ask the user to paste credentials into chat or place credentials in prompts, commands, files or logs.

## Per-request settings
- Saved plugin settings are defaults. Determine overrides only from the current image request: pass flags only for explicitly requested output settings; omit every unspecified setting so the executor uses its saved default.
- Never persist temporary overrides or edit plugin/skill/configuration files to satisfy a generation request. Each executor invocation is stateless with respect to prior generations and other conversations.
- Do not copy output flags from a previous generation unless the user explicitly asks to reuse those settings for this request. A follow-up asking for another image or the same visual style does not by itself reuse size, ratio, quality or background overrides.
- Example: with saved 1K/square/auto/auto defaults, “4K landscape 16:9, transparent” adds only resolution, ratio and background flags for that generation. The next “draw a cat” request uses the saved defaults again, including in the same conversation. “Only change quality to high” overrides quality alone.

## Generate
1. Derive a prompt from the user's request. Preserve explicit content, composition, text and output requirements. Confirm only genuinely missing requirements.
2. Resolve a Python 3 runtime. If `python`/`python3` is unavailable, use `load_workspace_dependencies` when available to locate the app's bundled Python. Do not install dependencies or change global settings. If no runtime is available, report the prerequisite.
3. Run `scripts/generate.py` relative to THIS skill directory using that Python executable:
   `python "<skill-directory>/scripts/generate.py" --prompt "<image prompt>" --output "<absolute workspace path>/image.png"`
   For long/multiline prompts, save UTF-8 text in a temporary prompt file and pass `--prompt-file` instead. Remove that temporary file after the command completes.
   Optional parameters: `--resolution 1K|2K|4K`, `--aspect-ratio 1:1|4:3|3:4|16:9|9:16`, `--n 1` (1-4), `--quality low|medium|high|auto` and `--background auto|opaque|transparent`. Omit unspecified flags so the saved plugin defaults apply; translate the user's explicitly requested size, ratio, quality and background into these flags. The plugin maps 1K/2K/4K to a 1024/2048/4096-pixel long edge; do not promise the provider supports every resulting size. Providers may not support every size or option; report their rejection instead of silently lowering or changing the setting. There is no URL, key or model override.
4. Parse the JSON result's `paths`; inspect the generated image and render the actual saved file inline. Report its absolute path. The executor uses the returned file format and never overwrites existing files; choose a new filename if necessary.

Keep gpt++ and its local gateway running. A provider refusal, connection/authentication failure, unsupported parameter or missing configuration must be reported accurately. Do not switch to another provider or built-in image generation without the user's explicit choice. This skill does not support reference-image editing; explain that limit rather than silently generating an unrelated replacement.

The plugin's default preference disables the known built-in imagegen skill, not the underlying image tool. Automatic skill selection remains the client's/model's decision. If explicit selection is needed, the user can invoke `$gptplus-imagegen` in a new conversation after restarting the client.
