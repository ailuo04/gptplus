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

/** Images 配置沿用提供商补全规则，但完整生图端点必须原样保留。 */
function normalizeImageBaseUrl(raw) {
  let base = String(raw == null ? '' : raw).trim();
  if (!base) return '';
  // 保留显式协议供生图 URL 校验拒绝；host:port 不视为协议。
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(base) && !/^[^/:]+:\d+(?:\/|$)/.test(base);
  if (!hasScheme) base = 'https://' + base;
  let url;
  try { url = new URL(base); } catch { return base; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return base;
  base = base.replace(/\/+$/, '');
  if (/\/images\/generations$/i.test(url.pathname.replace(/\/+$/, ''))) return base;
  return normalizeBaseUrl(base);
}

module.exports = { normalizeBaseUrl, normalizeImageBaseUrl, ensureApiVersion, stripEndpoint };
