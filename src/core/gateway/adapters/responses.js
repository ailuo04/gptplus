'use strict';
/**
 * OpenAI Responses 原生上游适配器（透传，spec 第 6 节）。
 *
 * 适用：本身就实现 POST {baseUrl}/responses 的上游（官方 api.openai.com、
 * 部分新一代中转）。与 openai 适配器（Responses -> chat/completions 转换）的
 * 区别：
 *   - buildRequest 不做协议翻译：请求体原样转发，只把 slug 改写成真实
 *     modelId（客户端不校验 model 回显，spec 第 6 节）；
 *   - 流式响应不走「内部事件」翻译，由 server 检测 `passthrough` 标记后
 *     逐字节转发上游 SSE（responses.js 的 pipeResponsesSse），保住
 *     encrypted reasoning、原生事件序列等转换会丢失的信息。多轮工具调用时
 *     客户端要回传上游给的 reasoning 项（store:false 场景），转换模式会
 *     把它们丢掉导致上游报错——这是透传模式存在的核心理由；
 *   - compat 重试（去掉可选参数重发）对透传无意义：网关没有注入任何
 *     可选参数，server 会跳过。
 */
const { joinApiUrl } = require('../responses.js');
const { buildHeaders } = require('./openai.js');

function buildRequest({ provider, modelId, body = {} }) {
  return {
    url: joinApiUrl(provider.baseUrl, '/responses'),
    headers: buildHeaders(provider),
    payload: { ...body, model: modelId },
  };
}

function createResponsesAdapter() {
  return {
    name: 'responses',
    passthrough: true,
    endpoint: (provider) => joinApiUrl(provider.baseUrl, '/responses'),
    buildHeaders,
    buildRequest,
  };
}

module.exports = { createResponsesAdapter, buildRequest };
