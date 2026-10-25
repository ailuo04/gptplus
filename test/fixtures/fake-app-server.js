'use strict';
// Codex app-server 测试替身：实现 initialize / thread / turn 的最小 JSON-RPC，
// 并验证客户端会拒绝工具审批请求，而不是让 turn 卡住。
let buffer = '';

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake-app-server' } });
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } });
    return;
  }
  if (message.method === 'turn/start') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        turn: { id: 'turn-1' },
        model: 'fake-model',
        tokenUsage: { last: { totalTokens: 25 }, modelContextWindow: 100 },
      },
    });
    send({
      jsonrpc: '2.0',
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    return;
  }
  if (message.id === 900) {
    if (message.result && message.result.decision === 'decline') {
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: 'hello from fake' } },
      });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: 'turn-1' } });
    } else {
      send({ jsonrpc: '2.0', method: 'error', params: { message: 'approval was not declined' } });
    }
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore malformed */ }
  }
});
process.stdin.resume();
