const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function copyRendererToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gptplus-live-usage-'));
  fs.mkdirSync(path.join(tmp, 'views'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}', 'utf8');
  for (const rel of ['app.js', 'views/home.js', 'views/providers.js', 'views/models.js', 'views/usage.js', 'views/settings.js']) {
    fs.copyFileSync(path.join(__dirname, '..', 'src', 'renderer', rel), path.join(tmp, rel));
  }
  return tmp;
}

test('usage page rerenders after a live gateway log arrives', async () => {
  const tmp = copyRendererToTemp();
  try {
    const app = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const rerenders = [];
    const entry = { at: Date.now(), providerId: 'p_demo0001', model: 'p_demo0001__m', status: 200, tokens: { total_tokens: 10 } };
    app.state.logs = [];
    app.state.view = 'usage';

    app.handleIncomingLog(entry, (...args) => rerenders.push(args));
    app.handleIncomingLog(entry, () => rerenders.push('duplicate'));

    assert.equal(rerenders.length, 1, 'usage page should rerender after a new log');
    assert.equal(rerenders[0][0], false, 'live log refresh should not play the enter animation');
    assert.deepEqual(rerenders[0][1], { preserveScrollTop: true }, 'live log refresh should preserve the usage scroll position');
    assert.equal(app.state.logs.length, 1, 'the same gateway event should only appear once');
    assert.equal(app.USAGE_REFRESH_INTERVAL_MS, 60_000, 'usage auto refresh should run every minute');

    app.state.view = 'providers';
    app.handleIncomingLog({ at: Date.now(), level: 'info', msg: 'other page log' }, () => rerenders.push('unexpected'));
    assert.equal(rerenders.includes('unexpected'), false, 'other pages should not rerender for every log');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('incremental usage refresh merges only new logs and keeps existing entries', async () => {
  const tmp = copyRendererToTemp();
  try {
    const app = await import(pathToFileURL(path.join(tmp, 'app.js')).href);
    const existing = {
      at: 1000,
      level: 'info',
      msg: '旧请求',
      providerId: 'p_demo0001',
      model: 'p_demo0001__m',
      status: 200,
      tokens: { total_tokens: 10 },
    };
    const local = { at: 1500, level: 'info', msg: '本地提示', local: true };
    const added = {
      at: 2000,
      level: 'info',
      msg: '新请求',
      providerId: 'p_demo0001',
      model: 'p_demo0001__m',
      status: 200,
      tokens: { total_tokens: 20 },
    };
    app.state.logs = [existing, local];

    assert.equal(app.mergeUsageLogs([existing, added]), 1);
    assert.deepEqual(app.state.logs, [existing, local, added]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
