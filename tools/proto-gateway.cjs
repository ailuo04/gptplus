'use strict';
// 一次性原型：最小 Responses-API 网关 + 假上游，用来证明 codex 客户端愿意把请求打到本地网关，
// 并锁定它期望的 SSE 事件形状。不是最终实现（最终实现在 src/core/gateway/）。
//
// 用法: node tools/proto-gateway.cjs <gatewayPort> <upstreamPort>
const http = require('node:http');

const gwPort = Number(process.argv[2] || 18121);
const upPort = Number(process.argv[3] || 18122);

const seen = [];
const LOG_PATH = require('node:path').join(__dirname, '..', 'probe', 'live-traffic.jsonl');

function record(entry) {
  seen.push(entry);
  try {
    require('node:fs').appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* ignore */ }
}

// ------------------------------------------------ 假上游（OpenAI 兼容 /chat/completions）
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    record({ at: Date.now(), to: 'upstream', method: req.method, url: req.url, auth: req.headers.authorization || null, body: body.slice(0, 4000) });
    console.log('[upstream] ' + req.method + ' ' + req.url + ' auth=' + (req.headers.authorization || '-'));
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunks = ['HELLO', ' FROM', ' GATEWAY'];
      for (const c of chunks) {
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }) + '\n\n');
      }
      res.write('data: ' + JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6.1-sol', object: 'model' }] }));
      return;
    }
    res.writeHead(404).end('{}');
  });
});

// ------------------------------------------------ 网关（对外呈现 Responses API）
let seq = 0;
const nextSeq = () => ++seq;
function sse(res, obj) {
  res.write('event: ' + obj.type + '\n');
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

const gateway = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log('[gateway] ' + req.method + ' ' + req.url + ' auth=' + (req.headers.authorization || '-'));
    if (req.url.startsWith('/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note: 'proto' }));
      return;
    }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'p_test__gpt-6.1-sol', object: 'model', owned_by: 'proto' }] }));
      return;
    }
    if (!req.url.startsWith('/v1/responses')) {
      res.writeHead(404).end('{}');
      return;
    }

    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    record({ at: Date.now(), to: 'gateway', url: req.url, body: parsed });
    console.log('[gateway] model=' + parsed.model + ' stream=' + parsed.stream + ' inputItems=' + (Array.isArray(parsed.input) ? parsed.input.length : typeof parsed.input) + ' tools=' + (Array.isArray(parsed.tools) ? parsed.tools.length : 0));
    console.log('[gateway] request keys: ' + Object.keys(parsed).join(', '));

    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_proto', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
        model: parsed.model, output: [{ type: 'message', id: 'msg_proto', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'HELLO FROM GATEWAY', annotations: [] }] }],
        usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
      }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const responseId = 'resp_proto';
    const itemId = 'msg_proto';
    const base = () => ({
      id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model: parsed.model, output: [], parallel_tool_calls: true,
      tool_choice: 'auto', tools: parsed.tools || [],
    });

    sse(res, { type: 'response.created', sequence_number: nextSeq(), response: base() });
    sse(res, { type: 'response.in_progress', sequence_number: nextSeq(), response: base() });
    sse(res, { type: 'response.output_item.added', sequence_number: nextSeq(), output_index: 0, item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] } });
    sse(res, { type: 'response.content_part.added', sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const c of ['HELLO', ' FROM', ' GATEWAY']) {
      sse(res, { type: 'response.output_text.delta', sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, delta: c, logprobs: [] });
    }
    sse(res, { type: 'response.output_text.done', sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, text: 'HELLO FROM GATEWAY', logprobs: [] });
    sse(res, { type: 'response.content_part.done', sequence_number: nextSeq(), item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: 'HELLO FROM GATEWAY', annotations: [] } });
    sse(res, { type: 'response.output_item.done', sequence_number: nextSeq(), output_index: 0, item: { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'HELLO FROM GATEWAY', annotations: [] }] } });
    sse(res, {
      type: 'response.completed', sequence_number: nextSeq(),
      response: {
        ...base(), status: 'completed',
        output: [{ type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'HELLO FROM GATEWAY', annotations: [] }] }],
        usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

upstream.listen(upPort, '127.0.0.1', () => console.log('upstream on ' + upPort));
gateway.listen(gwPort, '127.0.0.1', () => console.log('gateway on ' + gwPort));

process.on('SIGTERM', () => {
  try {
    require('fs').writeFileSync(require('path').join(__dirname, '..', 'probe', 'live-traffic.json'), JSON.stringify(seen, null, 2), 'utf8');
    console.log('[proto] traffic captured -> probe/live-traffic.json (' + seen.length + ' entries)');
  } catch (e) {
    console.log('[proto] capture failed: ' + e.message);
  }
  process.exit(0);
});
process.on('SIGINT', () => process.emit('SIGTERM'));
