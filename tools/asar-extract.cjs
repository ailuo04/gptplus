// Extract one entry (or list entries) from an Electron asar archive.
// Usage:
//   node asar-extract.cjs <asar> --list [substring]
//   node asar-extract.cjs <asar> --read <entryPath> <outFile>
//   node asar-extract.cjs <asar> --read-ctx <entryPath> <needle> <before> <after>
const fs = require('fs');

const [, , asarPath, mode, ...rest] = process.argv;

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const headerJsonSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerJsonSize);
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const dataStart = 8 + headerSize;

function find(path) {
  const parts = path.split('/');
  let node = header;
  for (const p of parts) {
    if (!node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  return node;
}

if (mode === '--list') {
  const filter = rest[0] || '';
  const out = [];
  (function walk(node, prefix) {
    for (const [name, val] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (val.files) walk(val, p);
      else if (p.includes(filter)) out.push({ p, size: Number(val.size || 0), unpacked: !!val.unpacked });
    }
  })(header, '');
  out.sort((a, b) => b.size - a.size);
  for (const e of out) console.log(String(e.size).padStart(10) + '  ' + e.p + (e.unpacked ? '  [unpacked]' : ''));
  console.log('entries: ' + out.length);
} else if (mode === '--read') {
  const [entryPath, outFile] = rest;
  const e = find(entryPath);
  if (!e) { console.error('entry not found: ' + entryPath); process.exit(2); }
  const size = Number(e.size);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, dataStart + Number(e.offset));
  fs.writeFileSync(outFile, buf);
  console.log('wrote ' + size + ' bytes -> ' + outFile);
} else if (mode === '--read-ctx') {
  const [entryPath, needle, beforeS, afterS] = rest;
  const before = Number(beforeS); const after = Number(afterS);
  const e = find(entryPath);
  if (!e) { console.error('entry not found: ' + entryPath); process.exit(2); }
  const size = Number(e.size);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, dataStart + Number(e.offset));
  const text = buf.toString('utf8');
  let idx = 0; let n = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    n++;
    console.log('--- hit ' + n + ' @' + idx + ' ---');
    console.log(text.slice(Math.max(0, idx - before), Math.min(text.length, idx + needle.length + after)));
    idx += needle.length;
  }
  console.log('hits: ' + n + ' (entry size ' + size + ')');
} else {
  console.error('unknown mode');
  process.exit(1);
}
