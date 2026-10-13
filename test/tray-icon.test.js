'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { APP_ICON_PATH, TRAY_ICON_DATA_URL } = require('../src/main/tray-icon.js');

function decodePng(dataUrl) {
  const prefix = 'data:image/png;base64,';
  assert.ok(dataUrl.startsWith(prefix), '托盘图标必须是 PNG data URL');
  const png = Buffer.from(dataUrl.slice(prefix.length), 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, 'PNG chunk 不应越界');
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert.ok(end <= png.length, `${type} chunk 长度必须正确`);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset = end;
  }
  assert.equal(offset, png.length, 'PNG 必须完整收口');
  return { chunks, png };
}

test('托盘图标是有效且有可见像素的 PNG', () => {
  assert.ok(fs.existsSync(APP_ICON_PATH), '原 app 图标必须作为正式资源存在');
  const { chunks } = decodePng(TRAY_ICON_DATA_URL);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  const idat = chunks.filter((chunk) => chunk.type === 'IDAT');
  const iend = chunks.at(-1);

  assert.ok(ihdr, 'PNG 必须有 IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  assert.equal(width, 32);
  assert.equal(height, 32);
  assert.equal(ihdr.data[8], 8);
  assert.equal(ihdr.data[9], 6, '托盘图标应使用 RGBA');
  assert.ok(idat.length > 0, 'PNG 必须有 IDAT');
  assert.equal(iend.type, 'IEND');

  const raw = zlib.inflateSync(Buffer.concat(idat.map((chunk) => chunk.data)));
  let offset = 0;
  let visiblePixels = 0;
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[offset], 0, '图标 PNG 应使用无过滤扫描行');
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      offset += 3;
      if (raw[offset] > 0) visiblePixels += 1;
      offset += 1;
    }
  }
  assert.equal(offset, raw.length);
  assert.ok(visiblePixels > 20, '托盘图标必须包含足够的可见像素');
});
