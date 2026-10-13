// Scan an Electron asar archive: map byte offsets of interesting strings to archive entries.
// Usage: node asar-scan.cjs <asar> <needle> [contextBytes]
const fs = require('fs');

const asarPath = process.argv[2];
const needle = process.argv[3];
const ctxLen = Number(process.argv[4] || 600);

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const headerJsonSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerJsonSize);
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));

const dataStart = 8 + headerSize;
const fileSize = fs.fstatSync(fd).size;
const dataSize = fileSize - dataStart;

// Flatten the tree into { path, offset, size } entries, offset relative to file data start.
const entries = [];
(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (val.files) walk(val, p);
    else if (typeof val.offset === 'string' || typeof val.offset === 'number') {
      entries.push({ path: p, offset: Number(val.offset), size: Number(val.size || 0), unpacked: !!val.unpacked });
    }
  }
})(header, '');

entries.sort((a, b) => a.offset - b.offset);

function entryAt(off) {
  let lo = 0, hi = entries.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    if (e.offset <= off) { best = e; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const needleBuf = Buffer.from(needle, 'utf8');
const CHUNK = 8 * 1024 * 1024;
const overlap = needleBuf.length - 1;
let pos = 0;
let carry = Buffer.alloc(0);
let hits = 0;

while (pos < dataSize) {
  const toRead = Math.min(CHUNK, dataSize - pos);
  const buf = Buffer.alloc(toRead);
  fs.readSync(fd, buf, 0, toRead, dataStart + pos);
  const hay = Buffer.concat([carry, buf]);
  let idx = hay.indexOf(needleBuf);
  while (idx !== -1) {
    const absOffset = pos - carry.length + idx; // offset within file-data region
    const e = entryAt(absOffset);
    hits++;
    const local = e ? absOffset - e.offset : -1;
    console.log('--- hit #' + hits + ' ---');
    console.log('entry: ' + (e ? e.path : '?') + (e && e.unpacked ? ' [UNPACKED]' : '') + '  entryOffset=' + local);
    if (e && !e.unpacked && local >= 0) {
      const start = Math.max(0, local - ctxLen);
      const end = Math.min(e.size, local + needle.length + ctxLen);
      const cbuf = Buffer.alloc(end - start);
      fs.readSync(fd, cbuf, 0, cbuf.length, dataStart + e.offset + start);
      console.log(cbuf.toString('utf8').replace(/\0/g, ''));
    } else {
      console.log('(unpacked entry: read from app.asar.unpacked)');
    }
    idx = hay.indexOf(needleBuf, idx + 1);
  }
  carry = hay.subarray(Math.max(0, hay.length - overlap));
  pos += toRead;
}
console.log('total hits: ' + hits + ' in ' + entries.length + ' entries; data size ' + dataSize);
