'use strict';
// Fixed-route Images API executor. Neither callers nor upstream errors can change
// provider/model/credentials, and diagnostic messages never include response bodies.
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const IMAGE_ROUTE = '/gptplus/images/generations';

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function imageEndpoint(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw failure('请填写有效的生图 API URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure('生图 API URL 只支持不含凭据、查询参数或片段的 HTTP(S) 地址');
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith('/images/generations') ? basePath : basePath + '/images/generations';
  return url.href;
}

const IMAGE_RATIOS = Object.freeze({
  '1:1': [1, 1], '4:3': [4, 3], '3:4': [3, 4], '16:9': [16, 9], '9:16': [9, 16],
});
const IMAGE_RESOLUTIONS = Object.freeze({ '1K': 1024, '2K': 2048, '4K': 4096 });
function selectImageSize(resolution = '1K', aspectRatio = '1:1') {
  if (!Object.prototype.hasOwnProperty.call(IMAGE_RESOLUTIONS, resolution)) throw failure('不支持的图片尺寸');
  const ratio = Object.prototype.hasOwnProperty.call(IMAGE_RATIOS, aspectRatio) ? IMAGE_RATIOS[aspectRatio] : null;
  if (!ratio) throw failure('不支持的图片比例');
  const longest = IMAGE_RESOLUTIONS[resolution];
  const [rw, rh] = ratio;
  const scale = longest / Math.max(rw, rh);
  const round = (value) => Math.max(64, Math.round(value / 8) * 8);
  return round(rw * scale) + 'x' + round(rh * scale);
}

function validateImageConfig(config) {
  const endpoint = imageEndpoint(config?.baseUrl);
  if (!config?.apiKey || /[\r\n]/.test(config.apiKey)) throw failure('请先配置有效的生图 API Key');
  if (!config?.model) throw failure('请先配置生图模型');
  return endpoint;
}

async function readLimited(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw failure('生图服务响应大小过大', 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('生图服务返回空响应', 502);
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw failure('生图服务响应大小过大', 502);
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw failure('生图服务返回的内容不是支持的 PNG、JPEG 或 WebP 图片', 502);
}

function createImageGeneration({ plugins, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  async function generate(input = {}) {
    if (!plugins?.isActive('custom-imagegen')) throw failure('自定义生图插件未启用', 403);
    const config = plugins.config('custom-imagegen');
    const endpoint = validateImageConfig(config);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['prompt', 'size', 'n', 'quality', 'resolution', 'aspectRatio', 'background'].includes(key))) {
      throw failure('不允许覆盖 URL、模型、API Key 或使用不支持的生图参数');
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 32000) throw failure('生图提示词不能为空且不能超过 32000 字符');
    const n = input.n === undefined ? 1 : input.n;
    if (!Number.isInteger(n) || n < 1 || n > 4) throw failure('生图数量需为 1-4 之间的整数');
    const resolution = input.resolution ?? config.resolution ?? '1K';
    const aspectRatio = input.aspectRatio ?? config.aspectRatio ?? '1:1';
    const quality = input.quality ?? config.quality ?? 'auto';
    const background = input.background ?? config.background ?? 'auto';
    const presetSize = selectImageSize(resolution, aspectRatio);
    if (!['auto', 'low', 'medium', 'high'].includes(quality)) throw failure('不支持的图片画质');
    if (!['auto', 'opaque', 'transparent'].includes(background)) throw failure('不支持的图片背景');
    const payload = { model: config.model, prompt, n, size: input.size ?? presetSize, quality, background };
    if (background === 'transparent') payload.output_format = 'png';
    if (input.size !== undefined) {
      if (typeof input.size !== 'string' || !/^(?:auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(input.size)) throw failure('图片尺寸格式需为 auto 或 宽x高');
      payload.size = input.size;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(`生图服务返回 HTTP ${response.status}，未切换提供商`, 502);
      }
      const bytes = await readLimited(response, MAX_RESPONSE_BYTES);
      let json;
      try { json = JSON.parse(bytes.toString('utf8')); }
      catch { throw failure('生图服务返回了无效 JSON', 502); }
      if (!Array.isArray(json.data) || json.data.length < 1 || json.data.length > n) throw failure('生图服务未返回有效的图片列表', 502);
      const data = [];
      for (const image of json.data) {
        let imageBytes;
        if (typeof image?.b64_json === 'string') {
          if (image.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) {
            throw failure('生图服务返回的图片编码无效或过大', 502);
          }
          imageBytes = Buffer.from(image.b64_json, 'base64');
        } else if (typeof image?.url === 'string') {
          let url;
          try { url = new URL(image.url); } catch { throw failure('生图服务返回的图片 URL 无效', 502); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('图片 URL 只支持不含凭据的 HTTP(S) 地址', 502);
          // Signed image links carry their own authorization. Never forward API keys.
          const download = await fetchImpl(url.href, { signal, redirect: 'error' });
          if (!download.ok) { await download.body?.cancel(); throw failure(`图片下载返回 HTTP ${download.status}`, 502); }
          imageBytes = await readLimited(download, MAX_IMAGE_BYTES);
        } else throw failure('生图服务未返回图片数据', 502);
        if (imageBytes.length > MAX_IMAGE_BYTES) throw failure('生图服务返回的图片过大', 502);
        data.push({ b64_json: imageBytes.toString('base64'), format: imageFormat(imageBytes) });
      }
      return { model: config.model, data };
    } catch (err) {
      if (err.statusCode) throw err;
      throw failure(signal.aborted ? '生图请求超时，未切换提供商' : '生图请求或图片下载失败，未切换提供商', 502);
    }
  }
  return { generate };
}

module.exports = { createImageGeneration, validateImageConfig, imageEndpoint, selectImageSize, IMAGE_ROUTE };
