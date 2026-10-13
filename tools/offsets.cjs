// Byte-accurate needle search + context dump for text and BINARY files.
// Works in latin1 space so char index === byte offset (needles must be ASCII).
// Usage:
//   node offsets.cjs <file> lit <needle> [maxHits]
//   node offsets.cjs <file> re <regex> [maxHits]
//   node offsets.cjs <file> --ctx <offset> <before> <after>
//   node offsets.cjs <file> --ctxre <regex> <before> <after> [maxHits]
//   node offsets.cjs <file> --str <offset> <maxLen>      (print printable run at offset)
//   node offsets.cjs <file> --json <offset>              (extract balanced JSON object starting at offset)
const fs = require('fs');

const [, , file, mode, ...rest] = process.argv;
const buf = fs.readFileSync(file);
const text = buf.toString('latin1');

function sanitize(t) {
  return t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '.');
}

if (mode === '--ctx') {
  const off = Number(rest[0]); const before = Number(rest[1]); const after = Number(rest[2]);
  const s = Math.max(0, off - before);
  const e = Math.min(buf.length, off + after);
  process.stdout.write(`### ctx @${off} (range ${s}..${e})\n`);
  process.stdout.write(sanitize(text.slice(s, e)) + '\n');
} else if (mode === '--ctxre') {
  const re = new RegExp(rest[0], 'g');
  const before = Number(rest[1]); const after = Number(rest[2]);
  const max = Number(rest[3] || 1);
  let m, n = 0;
  while ((m = re.exec(text)) !== null && n < max) {
    n++;
    process.stdout.write(`### hit ${n} @${m.index} match=${JSON.stringify(m[0].slice(0, 150))}\n`);
    process.stdout.write(sanitize(text.slice(Math.max(0, m.index - before), m.index + m[0].length + after)) + '\n');
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  process.stdout.write(`hits: ${n} (file ${buf.length} bytes)\n`);
} else if (mode === '--str') {
  const off = Number(rest[0]); const maxLen = Number(rest[1] || 400);
  let i = off;
  while (i < buf.length && i < off + maxLen && buf[i] >= 0x20 && buf[i] < 0x7f) i++;
  process.stdout.write(`### printable @${off}..${i}\n` + text.slice(off, i) + '\n');
} else if (mode === '--json') {
  const off = Number(rest[0]);
  let i = off;
  let start = i;
  while (start < buf.length && buf[start] !== 0x7b) start++;
  let depth = 0, inStr = false, esc = false, end = start;
  for (; end < buf.length; end++) {
    const c = text[end];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  process.stdout.write(`### json @${start}..${end} (${end - start} bytes)\n`);
  fs.writeFileSync(rest[1] || 'C:/ailuo_own/gpt++/tools/out/extracted.json', buf.slice(start, end));
  process.stdout.write(buf.slice(start, Math.min(end, start + 400)).toString('utf8') + '\n...\n');
} else {
  const pattern = rest[0];
  const max = Number(rest[1] || 50);
  const out = [];
  let n = 0;
  if (mode === 'lit') {
    let idx = 0;
    while ((idx = text.indexOf(pattern, idx)) !== -1 && n < max) {
      n++;
      out.push(`${idx}\t${JSON.stringify(sanitize(text.slice(Math.max(0, idx - 70), idx + pattern.length + 70)))}`);
      idx += pattern.length;
    }
  } else {
    const re = new RegExp(pattern, 'g');
    let m;
    while ((m = re.exec(text)) !== null && n < max) {
      n++;
      out.push(`${m.index}\t${JSON.stringify(sanitize(text.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70)))}`);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  process.stdout.write(out.join('\n') + `\nhits: ${n} (file ${buf.length} bytes)\n`);
}
