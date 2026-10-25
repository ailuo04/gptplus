'use strict';
// 微信图片：AES/CDN、入站图片传给 Codex、回合新增图片回传微信。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/core/store.js');
const {
  createWeixinConnect,
  createWeixinClient,
  createStateStore,
  extractImageSources,
  findRecentOutputImages,
  encryptAesEcb,
  decryptAesEcb,
  parseMediaAesKey,
} = require('../src/core/weixin-connect.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
const IMAGE_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function message(overrides = {}) {
  return {
    seq: 1,
    message_id: 3001,
    from_user_id: 'owner@im.wechat',
    client_id: 'image-client-1',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: '把这张图改成蓝色调' } }],
    context_token: 'ctx-image',
    ...overrides,
  };
}

function makeStore(dir, extra = {}) {
  const store = createStore({ configPath: path.join(dir, 'config.json') });
  store.update((draft) => {
    draft.weixin = {
      ...draft.weixin,
      token: 'bot-token',
      accountId: 'bot@im.bot',
      allowFrom: 'owner@im.wechat',
      workDir: dir,
      ...extra,
    };
  });
  return store;
}

async function waitFor(check, { timeoutMs = 4000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时: ${label}`);
}

test('weixin image: AES-ECB 往返、密钥解析与图片段提取', () => {
  const encrypted = encryptAesEcb(PNG_1PX, IMAGE_KEY);
  assert.notDeepEqual(encrypted, PNG_1PX);
  assert.deepEqual(decryptAesEcb(encrypted, IMAGE_KEY), PNG_1PX);
  assert.equal(parseMediaAesKey(IMAGE_KEY.toString('base64')).toString('hex'), IMAGE_KEY.toString('hex'));
  assert.equal(
    parseMediaAesKey(Buffer.from(IMAGE_KEY.toString('hex'), 'utf8').toString('base64')).toString('hex'),
    IMAGE_KEY.toString('hex'),
  );
  const sources = extractImageSources({
    item_list: [{
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'q-1', aes_key: IMAGE_KEY.toString('base64') },
        aeskey: IMAGE_KEY.toString('hex'),
        mid_size: PNG_1PX.length,
      },
    }],
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].encryptedQueryParam, 'q-1');
  assert.equal(sources[0].aesKeyBase64, IMAGE_KEY.toString('base64'));
  assert.equal(sources[0].aesKeyHex, IMAGE_KEY.toString('hex'));
});

test('weixin image: 只回传本次回合工作目录内新写入的图片', () => {
  const dir = tmpDir('gptplus-weixin-output-scan-');
  try {
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(project, 'weixin-media'), { recursive: true });
    const now = Date.now();
    const recent = path.join(project, 'new.png');
    const nested = path.join(project, 'sub', 'edited.jpg');
    const old = path.join(project, 'old.png');
    const hidden = path.join(project, '.git', 'ignored.png');
    const modules = path.join(project, 'node_modules', 'ignored.png');
    const inbound = path.join(project, 'weixin-media', 'input.png');
    for (const file of [recent, nested, old, hidden, modules, inbound]) fs.writeFileSync(file, PNG_1PX);
    fs.utimesSync(old, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));

    const found = findRecentOutputImages(project, now - 10_000, {
      limit: 3,
      exclude: [path.join(project, 'weixin-media')],
    });
    assert.ok(found.includes(recent));
    assert.ok(found.includes(nested));
    assert.equal(found.includes(old), false);
    assert.equal(found.includes(hidden), false);
    assert.equal(found.includes(modules), false);
    assert.equal(found.includes(inbound), false);
  } finally {
    cleanup(dir);
  }
});

test('weixin image client: 下载解密、上传加密并发送 image_item', async () => {
  let uploadBody = null;
  let uploadCiphertext = null;
  let imageMessage = null;
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.includes('/c2c/download')) {
      return new Response(encryptAesEcb(PNG_1PX, IMAGE_KEY), { status: 200 });
    }
    if (target.includes('/ilink/bot/getuploadurl')) {
      uploadBody = JSON.parse(init.body);
      return jsonResponse({
        ret: 0,
        errcode: 0,
        upload_full_url: 'https://cdn.test/c2c/upload?encrypted_query_param=upload-1&filekey=fk-1',
      });
    }
    if (target.includes('/c2c/upload')) {
      uploadCiphertext = Buffer.from(init.body);
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-1' } });
    }
    if (target.includes('/ilink/bot/sendmessage')) {
      imageMessage = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${target}`);
  };
  const client = createWeixinClient({
    baseUrl: 'https://ilink.test',
    token: 'bot-token',
    cdnBaseUrl: 'https://cdn.test/c2c',
    fetchImpl,
  });
  const downloaded = await client.downloadImageSource({
    encryptedQueryParam: 'download-in',
    aesKeyBase64: IMAGE_KEY.toString('base64'),
  });
  assert.deepEqual(downloaded.buffer, PNG_1PX);
  assert.equal(downloaded.mime, 'image/png');

  const dir = tmpDir('gptplus-weixin-image-send-');
  try {
    const file = path.join(dir, 'out.png');
    fs.writeFileSync(file, PNG_1PX);
    await client.sendImage('peer@im.wechat', file, 'ctx-image');
  } finally {
    cleanup(dir);
  }
  assert.equal(uploadBody.media_type, 1);
  assert.equal(uploadBody.rawsize, PNG_1PX.length);
  assert.equal(uploadBody.filesize, Math.ceil((PNG_1PX.length + 1) / 16) * 16);
  assert.match(uploadBody.aeskey, /^[0-9a-f]{32}$/);
  const key = Buffer.from(uploadBody.aeskey, 'hex');
  assert.deepEqual(decryptAesEcb(uploadCiphertext, key), PNG_1PX);
  const item = imageMessage.msg.item_list[0];
  assert.equal(item.type, 2);
  assert.equal(item.image_item.media.encrypt_query_param, 'download-1');
  assert.equal(item.image_item.media.aes_key, Buffer.from(uploadBody.aeskey, 'utf8').toString('base64'));
  assert.equal(item.image_item.mid_size, uploadBody.filesize);
  assert.equal(imageMessage.msg.context_token, 'ctx-image');
});

test('weixin image: 入站图片传给 Codex，回合新增图片自动回传微信', async () => {
  const dir = tmpDir('gptplus-weixin-image-e2e-');
  const stateDir = path.join(dir, 'state');
  const project = path.join(dir, 'project');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(project);
  const store = makeStore(dir, { workDir: project });
  const fetchCalls = { download: 0, upload: 0 };
  const sentText = [];
  const sentImages = [];
  let polls = 0;
  const inbound = message({
    context_token: 'ctx-image',
    item_list: [
      { type: 1, text_item: { text: '把这张图改成蓝色调' } },
      {
        type: 2,
        image_item: {
          media: { encrypt_query_param: 'in-q', aes_key: IMAGE_KEY.toString('base64') },
          mid_size: PNG_1PX.length,
        },
      },
    ],
  });
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.includes('/ilink/bot/getupdates')) {
      polls += 1;
      return jsonResponse({
        ret: 0, errcode: 0, msgs: polls === 1 ? [inbound] : [],
        get_updates_buf: 'cursor', longpolling_timeout_ms: 1000,
      });
    }
    if (target.includes('/c2c/download')) {
      fetchCalls.download += 1;
      return new Response(encryptAesEcb(PNG_1PX, IMAGE_KEY), { status: 200 });
    }
    if (target.includes('/ilink/bot/getuploadurl')) {
      return jsonResponse({ ret: 0, errcode: 0, upload_param: 'out-upload' });
    }
    if (target.includes('/c2c/upload')) {
      fetchCalls.upload += 1;
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'out-download' } });
    }
    if (target.includes('/ilink/bot/sendmessage')) {
      const body = JSON.parse(init.body);
      const item = body.msg.item_list[0];
      if (item.type === 1) sentText.push(item.text_item.text);
      else if (item.type === 2) sentImages.push(body);
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${target}`);
  };
  let turnOptions = null;
  const server = {
    async prepareThread(id) { return id || 'thread-image'; },
    async runTurn(threadId, prompt, options) {
      turnOptions = { threadId, prompt, options };
      fs.writeFileSync(path.join(project, 'output.png'), PNG_1PX);
      return { reply: '图片已处理', model: 'm1', usage: { contextUsed: 10, contextWindow: 100 } };
    },
    async close() {},
    isRunning() { return true; },
  };
  const connect = createWeixinConnect({
    store,
    stateDir,
    fetchImpl,
    appServerFactory: async () => server,
    resolveCli: async () => ({ path: 'codex.exe', source: 'test' }),
    log: () => {},
  });
  try {
    await connect.start();
    await waitFor(() => sentImages.length === 1, { label: '回传图片' });
    assert.equal(fetchCalls.download, 1, '应下载并解密入站图片');
    assert.equal(fetchCalls.upload, 1, '应上传回传图片');
    assert.equal(turnOptions.prompt, '把这张图改成蓝色调');
    assert.equal(turnOptions.options.images.length, 1);
    assert.match(turnOptions.options.images[0], /^file:\/\/\//);
    const mediaFile = new URL(turnOptions.options.images[0]);
    assert.ok(fs.existsSync(mediaFile), '入站图片应保存到微信媒体目录');
    assert.ok(mediaFile.pathname.includes('/weixin-media/'));
    assert.match(sentText[0], /^图片已处理\n\nm1 · ctx 10%/);
    assert.equal(sentImages[0].msg.item_list[0].type, 2);
    assert.equal(sentImages[0].msg.context_token, 'ctx-image');
    assert.equal(connect.getStatus().processedMessages, 1);
    const state = createStateStore({ dir: stateDir, accountId: 'bot@im.bot' }).load();
    assert.equal(state.threadIds['owner@im.wechat'], 'thread-image');
  } finally {
    await connect.stop();
    cleanup(dir);
  }
});
