'use strict';
// 系统代理解析与实际 HTTP CONNECT 路由测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { fetch } = require('undici');
const {
  createSystemProxyFetch,
  detectSystemProxy,
  isProxyBypassed,
  normalizeProxyUrl,
  parseProxyServer,
  parseRegistrySettings,
} = require('../src/core/system-proxy.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

test('system-proxy: 解析 WinINET、映射端口和直连例外', () => {
  const settings = parseRegistrySettings([
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    127.0.0.1:7890',
    '    ProxyOverride  REG_SZ    localhost;127.*;<local>',
  ].join('\r\n'));
  assert.deepEqual(settings, {
    proxyEnable: '0x1',
    proxyServer: '127.0.0.1:7890',
    proxyOverride: 'localhost;127.*;<local>',
  });
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(parseProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891', 'https://example.com'), 'http://127.0.0.1:7891/');
  assert.equal(isProxyBypassed('127.0.0.1', 'localhost;127.*'), true);
  assert.equal(isProxyBypassed('api.example.com', 'localhost;127.*'), false);
  assert.equal(
    detectSystemProxy('https://api.example.com', {
      proxyEnable: '0x1',
      proxyServer: '127.0.0.1:7890',
      proxyOverride: 'localhost;127.*',
    }),
    'http://127.0.0.1:7890/',
  );
});

test('system-proxy: 代理模式可真实切换，代理连接复用且直连不经过代理', async (t) => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('target-ok');
  });
  const targetPort = await listen(target);
  t.after(() => close(target));

  let connectCount = 0;
  const proxy = http.createServer();
  proxy.on('connect', (request, clientSocket, head) => {
    connectCount += 1;
    const [host, rawPort] = String(request.url).split(':');
    const upstreamSocket = net.connect(Number(rawPort), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', () => clientSocket.destroy());
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const targetUrl = `http://127.0.0.1:${targetPort}/probe`;
  const fetcher = createSystemProxyFetch({
    mode: 'system',
    fetchImpl: fetch,
    detectProxy: () => `http://127.0.0.1:${proxyPort}/`,
  });
  t.after(() => fetcher.close());

  const proxied = await fetcher(targetUrl);
  assert.equal(await proxied.text(), 'target-ok');
  assert.equal(connectCount, 1, '系统代理模式必须通过 HTTP CONNECT');

  fetcher.setMode('direct');
  const direct = await fetcher(targetUrl);
  assert.equal(await direct.text(), 'target-ok');
  assert.equal(connectCount, 1, '直连模式不能继续使用代理连接');
});

test('system-proxy: 同一 origin 的检测结果在短窗口内缓存', async () => {
  let detectCount = 0;
  const calls = [];
  const fetcher = createSystemProxyFetch({
    mode: 'system',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
    detectProxy: () => {
      detectCount += 1;
      return null;
    },
  });
  await fetcher('https://example.com/a');
  await fetcher('https://example.com/b');
  assert.equal(detectCount, 1);
  assert.equal(calls.length, 2);
  await fetcher.close();
});
