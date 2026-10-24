'use strict';
// 提供商连通性测试 / 远端模型拉取（契约见 spec.md 第 8 节）。
// 纯 Node CommonJS，自动跟随 Windows 系统代理，绝不把异常抛给调用方。
const DEFAULT_TIMEOUT = 10000;

const { stripEndpoint } = require('./base-url.js');
const { redactDiagnostic } = require('./redact.js');
const { createSystemProxyFetch } = require('./system-proxy.js');
const { buildRequest: buildChatRequest } = require('./gateway/adapters/openai.js');
const { buildRequest: buildResponsesRequest } = require('./gateway/adapters/responses.js');
const { buildRequest: buildAnthropicRequest } = require('./gateway/adapters/anthropic.js');

function trimBase(baseUrl) {
  // 老配置里可能存了完整端点 URL（.../v1/chat/completions），剥成 base 再拼 /models
  return stripEndpoint(baseUrl);
}

function httpMessage(status, statusText) {
  const suffix = statusText ? ` ${statusText}` : '';
  const hint =
    status === 401 || status === 403
      ? '认证失败，请检查 API Key'
      : status === 404
        ? '接口不存在，请检查 Base URL'
        : status === 429
          ? '请求过于频繁（被限流）'
          : status >= 500
            ? '上游服务错误'
            : '请求失败';
  return `HTTP ${status}${suffix}（${hint}）`;
}

function describeError(err, timeoutMs) {
  const raw = err && typeof err === 'object' ? err : {};
  const code = String(raw.code || (raw.cause && raw.cause.code) || '');
  if (raw.name === 'AbortError' || raw.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒）`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `域名解析失败（${code}）`;
  if (/ECONNREFUSED/.test(code)) return `无法连接上游（${code}）`;
  if (/ECONNRESET/.test(code)) return `连接被重置（${code}）`;
  if (/CERT|TLS|SSL/i.test(code)) return `TLS 握手失败（${code}）`;
  return raw.message ? String(raw.message) : String(err);
}

function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.models)) return json.models;
  }
  return null;
}

function normalizeList(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: id });
      continue;
    }
    if (typeof item !== 'object') continue;
    const id = String(item.id != null ? item.id : item.slug != null ? item.slug : item.model != null ? item.model : item.name != null ? item.name : '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(item.display_name || item.label || item.name || id).trim() || id;
    out.push({ id, label });
  }
  return out;
}

function isCompleteModelList(list) {
  return Array.isArray(list) && list.every((item) => {
    if (typeof item === 'string') return !!item.trim();
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const candidate = item.id ?? item.slug ?? item.model ?? item.name;
    return typeof candidate === 'string' && !!candidate.trim();
  });
}

function setHeader(headers, name, value) {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  headers[name] = value;
}

function requestHeaders(provider) {
  const headers = {};
  setHeader(headers, 'Accept', 'application/json');
  setHeader(headers, 'Content-Type', 'application/json');
  if (provider.api === 'anthropic') {
    if (provider.apiKey) setHeader(headers, 'x-api-key', provider.apiKey);
    setHeader(headers, 'anthropic-version', '2023-06-01');
  } else if (provider.apiKey) {
    setHeader(headers, 'Authorization', `Bearer ${provider.apiKey}`);
  }
  // 用户自定义请求头最后应用，可以覆盖默认头。
  for (const [k, v] of Object.entries(provider.headers || {})) {
    const key = String(k).trim();
    if (!key) continue;
    setHeader(headers, key, String(v == null ? '' : v));
  }
  return headers;
}

function generationError(api, json) {
  const upstreamError = json && typeof json === 'object'
    ? json.error?.message || json.error?.error?.message || json.message || (typeof json.error === 'string' ? json.error : '')
    : '';
  if (upstreamError) return String(upstreamError).slice(0, 500);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return '上游没有返回有效的模型结果';
  if (api === 'anthropic' && !Array.isArray(json.content)) return '上游响应缺少 content';
  if (api === 'responses' && json.status === 'failed') return '模型生成失败';
  if (api === 'responses' && !Array.isArray(json.output) && !json.id) return '上游响应缺少生成结果';
  if (api !== 'anthropic' && api !== 'responses' && (!Array.isArray(json.choices) || !json.choices.length)) {
    return '上游响应缺少 choices';
  }
  return '';
}

/** 创建提供商客户端，默认让 /models 请求自动跟随 Windows 系统代理。 */
/**
 * @param {{ store:any, timeoutMs?:number, fetchImpl?:Function }} deps
 */
function createProviderClient({ store, timeoutMs = DEFAULT_TIMEOUT, fetchImpl } = {}) {
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : createSystemProxyFetch();

  function getProvider(id) {
    try {
      return store && typeof store.getProvider === 'function' ? store.getProvider(id) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * GET {baseUrl}/models
   * @returns {Promise<{ok:boolean, status?:number, latencyMs:number, error?:string, json?:any, text?:string}>}
   */
  async function requestModels(id) {
    const started = Date.now();
    const fail = (error, extra) => ({
      ok: false,
      latencyMs: Date.now() - started,
      error,
      ...(extra || {}),
    });

    if (!doFetch) return fail('当前 Node 运行时没有可用的 fetch');

    const provider = getProvider(id);
    if (!provider) return fail(`提供商不存在: ${id}`);

    const base = trimBase(provider.baseUrl);
    if (!base) return fail('未配置 Base URL');

    const url = `${base}/models`;
    const headers = requestHeaders(provider);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      const res = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        return fail(describeError(err, limit), { status: res.status });
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          latencyMs,
          error: httpMessage(res.status, res.statusText),
          json,
          text,
        };
      }
      return { ok: true, status: res.status, latencyMs, json, text };
    } catch (err) {
      return fail(describeError(err, limit));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 连通性测试：GET {baseUrl}/models
   * @returns {Promise<{ok:boolean, status?:number, latencyMs:number, error?:string}>}
   */
  async function testProvider(id) {
    try {
      const r = await requestModels(id);
      const out = { ok: !!r.ok, latencyMs: r.latencyMs };
      if (typeof r.status === 'number') out.status = r.status;
      if (!r.ok) out.error = r.error || '请求失败';
      return out;
    } catch (err) {
      return { ok: false, latencyMs: 0, error: describeError(err, limit) };
    }
  }

  /**
   * 对指定模型发送一个最小非流式生成请求，确认模型本身可用并记录各自延时。
   * @returns {Promise<{ok:boolean, results:Array<{modelId:string,ok:boolean,status?:number,latencyMs:number,error?:string}>, error?:string}>}
   */
  async function testProviderModels(id, modelIds) {
    const provider = getProvider(id);
    const ids = [];
    const seen = new Set();
    for (const raw of Array.isArray(modelIds) ? modelIds : []) {
      const modelId = String(raw == null ? '' : raw).trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      ids.push(modelId);
    }
    if (!ids.length) return { ok: false, results: [], error: '请至少选择一个模型' };
    if (!provider) {
      return {
        ok: false,
        results: ids.map((modelId) => ({ modelId, ok: false, latencyMs: 0, error: `提供商不存在: ${id}` })),
        error: `提供商不存在: ${id}`,
      };
    }

    const configuredModels = new Set((provider.models || []).map((model) => String(model?.id || '').trim()).filter(Boolean));
    const unknown = ids.filter((modelId) => !configuredModels.has(modelId));
    if (unknown.length) {
      return {
        ok: false,
        results: ids.map((modelId) => ({
          modelId,
          ok: false,
          latencyMs: 0,
          error: configuredModels.has(modelId) ? '未测试' : '模型不在该渠道的配置清单中',
        })),
        error: '所选模型已不属于该渠道的配置清单',
      };
    }

    const base = trimBase(provider.baseUrl);
    if (!base) {
      return {
        ok: false,
        results: ids.map((modelId) => ({ modelId, ok: false, latencyMs: 0, error: '未配置 Base URL' })),
        error: '未配置 Base URL',
      };
    }
    if (!doFetch) {
      return {
        ok: false,
        results: ids.map((modelId) => ({ modelId, ok: false, latencyMs: 0, error: '当前 Node 运行时没有可用的 fetch' })),
        error: '当前 Node 运行时没有可用的 fetch',
      };
    }

    const results = [];
    for (const modelId of ids) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limit);
      try {
        const body = { input: 'Reply OK.', max_output_tokens: 1, stream: false };
        const builder = provider.api === 'anthropic'
          ? buildAnthropicRequest
          : provider.api === 'responses' ? buildResponsesRequest : buildChatRequest;
        const request = builder({ provider: { ...provider, baseUrl: base }, modelId, body, stream: false });
        const res = await doFetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.payload),
          signal: controller.signal,
        });
        let text = '';
        try {
          text = await res.text();
        } catch (err) {
          results.push({
            modelId,
            ok: false,
            status: res.status,
            latencyMs: Date.now() - started,
            error: describeError(err, limit),
          });
          continue;
        }
        const latencyMs = Date.now() - started;
        if (!res.ok) {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* 上游不一定返回 JSON */ }
          results.push({ modelId, ok: false, status: res.status, latencyMs, error: generationError(provider.api, json) || httpMessage(res.status, res.statusText) });
        } else {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* 成功状态仍需校验响应体 */ }
          const error = generationError(provider.api, json);
          results.push({ modelId, ok: !error, status: res.status, latencyMs, ...(error ? { error } : {}) });
        }
      } catch (err) {
        results.push({ modelId, ok: false, latencyMs: Date.now() - started, error: describeError(err, limit) });
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: results.every((result) => result.ok), results };
  }

  /**
   * 拉取远端模型列表
   * @returns {Promise<{ok:boolean, models:{id:string,label:string}[], error?:string}>}
   */
  async function fetchRemoteModels(id) {
    try {
      const r = await requestModels(id);
      if (!r.ok) return { ok: false, models: [], error: r.error || '请求失败' };
      const list = extractList(r.json);
      if (!list) return { ok: false, models: [], error: '响应不是模型列表（缺少 data 数组）' };
      if (!isCompleteModelList(list)) return { ok: false, models: [], error: '模型列表含无效条目，未更新本地模型状态' };
      return { ok: true, models: normalizeList(list) };
    } catch (err) {
      return { ok: false, models: [], error: describeError(err, limit) };
    }
  }

  function safeResult(result, id) {
    const provider = getProvider(id);
    const out = { ...result };
    if (out.error) out.error = redactDiagnostic(out.error, [provider]);
    if (Array.isArray(out.results)) {
      out.results = out.results.map((item) => item.error
        ? { ...item, error: redactDiagnostic(item.error, [provider]) } : item);
    }
    return out;
  }

  return {
    testProvider: async (id) => safeResult(await testProvider(id), id),
    testProviderModels: async (id, ids) => safeResult(await testProviderModels(id, ids), id),
    fetchRemoteModels: async (id) => {
      const result = await fetchRemoteModels(id);
      return result.ok ? result : redactDiagnostic(result, [getProvider(id)]);
    },
    timeoutMs: limit,
  };
}

module.exports = { createProviderClient, normalizeList, isCompleteModelList, DEFAULT_TIMEOUT };
