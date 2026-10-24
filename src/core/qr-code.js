'use strict';
/**
 * 二维码 → PNG data URL：QQ 登录二维码在 app 弹窗里显示用。
 * 矩阵生成用 vendored 的 qrcode-generator（MIT，见 vendor/qrcode-generator.js）；
 * PNG 编码手写（1-bit 灰度 + Node 自带 zlib），不引入任何新依赖。
 */
const zlib = require('node:zlib');
const qrcodeGenerator = require('./vendor/qrcode-generator.js');

const QUIET_ZONE = 4; // 标准要求的静区（模块数）
const SCALE = 6;      // 每模块像素数：37 格 ≈ 222px，弹窗里足够清晰

/** PNG chunk：length(4) + type(4) + data + crc32(type+data) */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 把文本编码成 PNG 缓冲（1-bit 灰度，黑=1 白=0，MSB 在前）。 */
function qrPng(text, { scale = SCALE } = {}) {
  const qr = qrcodeGenerator(0, 'M');
  qr.addData(String(text || ''), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + QUIET_ZONE * 2) * scale;
  const bytesPerRow = Math.ceil(size / 8);
  // 行数据：filter=0 + 每模块 scale 像素（黑 1/白 0）
  const raw = Buffer.alloc((bytesPerRow + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // PNG filter type 0 (None)
    offset += 1;
    const moduleRow = Math.floor(y / scale) - QUIET_ZONE;
    for (let x = 0; x < size; x += 1) {
      const moduleCol = Math.floor(x / scale) - QUIET_ZONE;
      const dark = moduleRow >= 0 && moduleRow < count && moduleCol >= 0 && moduleCol < count
        ? qr.isDark(moduleRow, moduleCol)
        : false;
      if (dark) raw[offset + (x >> 3)] |= 0x80 >> (x & 7);
    }
    offset += bytesPerRow;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 1;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { png, size, moduleCount: count };
}

/** 供渲染层 <img> 直接使用。 */
function qrPngDataUrl(text, opts) {
  const { png } = qrPng(text, opts);
  return `data:image/png;base64,${png.toString('base64')}`;
}

module.exports = { qrPng, qrPngDataUrl, crc32 };
