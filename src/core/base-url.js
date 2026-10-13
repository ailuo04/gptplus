'use strict';
// Base URL 归一化的唯一实现：ipc.js（写入配置）、gateway（拼上游地址）、
// provider-client（拼 /models）必须用同一套规则，否则「保存时补了 /v1、
// 请求时又补一次」这类分歧会让上游地址悄悄跑偏。
const TRAILING_ENDPOINT_RE = /\/(chat\/completions|completions|responses|messages|models)$/i;

/** 用户常常直接粘贴完整端点 URL，先把尾部端点路径剥掉，只留 base */
function stripEndpoint(base) {
  let out = String(base == null ? '' : base).trim().replace(/\/+$/, '');
  let next = out;
  while ((next = out.replace(TRAILING_ENDPOINT_RE, '')) !== out) out = next;
  return out;
}

/**
 * 补出版本段：已有 `/vN`（含 `/v1beta` 这类后缀）就原样保留，否则补 `/v1`。
 * 剥掉端点尾巴后仍然带路径的 base（如 `.../v1/chat`）不动它——那是用户写的路径。
 */
function ensureApiVersion(base) {
  const stripped = stripEndpoint(base);
  if (!stripped) return stripped;
  if (/\/v\d+(?:[A-Za-z0-9._-]*)?(?:\/|$)/i.test(stripped)) return stripped;
  return `${stripped}/v1`;
}

/** 补协议、剥端点尾巴、保证版本段；空输入原样返回（由调用方判空） */
function normalizeBaseUrl(raw) {
  let base = String(raw == null ? '' : raw).trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return ensureApiVersion(base);
}

module.exports = { normalizeBaseUrl, ensureApiVersion, stripEndpoint };
