'use strict';

// Materialize a separate local marketplace from ChatGPT's existing public
// examples. This does not access the remote catalog, install plugins, or log in.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { _internal: toml } = require('./codex-config.js');

const MARKETPLACE_ID = 'gptplus-curated';
const BEGIN = '# >>> gpt++ ChatGPT plugin catalog >>>';
const END = '# <<< gpt++ ChatGPT plugin catalog <<<';
const SNAPSHOT_MARKER = '.gptplus-snapshot.json';
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readFile(file) {
  try {
    return { exists: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, text: '' };
    throw err;
  }
}

function noEol(line) {
  return String(line).replace(/[\r\n]+$/, '');
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isChild(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function createChatGptPluginRecovery({ codexHome, configPath, appDir, backup } = {}) {
  if (!codexHome || !configPath || !appDir || typeof backup !== 'function') {
    throw new Error('缺少 ChatGPT 插件目录修复所需的路径或备份方法');
  }
  const sourcePath = path.resolve(codexHome, '.tmp', 'plugins');
  const manifestPath = path.join(sourcePath, '.agents', 'plugins', 'marketplace.json');
  const snapshotRoot = path.resolve(appDir, 'plugin-marketplaces', MARKETPLACE_ID);

  function readManifest(root, expectedName) {
    for (const directory of [root, path.join(root, '.agents'), path.join(root, '.agents', 'plugins'), path.join(root, 'plugins')]) {
      const info = fs.lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('插件目录包含符号链接或非目录');
    }
    const realRoot = fs.realpathSync(root);
    const file = path.join(root, '.agents', 'plugins', 'marketplace.json');
    if (fs.lstatSync(file).isSymbolicLink() || !isChild(realRoot, fs.realpathSync(file))) {
      throw new Error('插件目录清单不能位于插件目录之外或是符号链接');
    }
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (data.name !== expectedName || !Array.isArray(data.plugins) || data.plugins.length === 0) {
      throw new Error('插件目录格式无效或目录为空');
    }
    const seen = new Set();
    for (const item of data.plugins) {
      const name = item && item.name;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)
        || seen.has(name.toLowerCase()) || item.source?.source !== 'local'
        || item.source.path !== `./plugins/${name}`) {
        throw new Error('插件目录包含不受支持的来源或重复名称');
      }
      seen.add(name.toLowerCase());
      const pluginDir = path.join(root, 'plugins', name);
      const info = fs.lstatSync(pluginDir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('插件目录包含符号链接或缺少插件文件');
      const pluginManifest = path.join(pluginDir, '.codex-plugin', 'plugin.json');
      const pluginInfo = fs.lstatSync(pluginManifest);
      if (pluginInfo.isSymbolicLink() || !pluginInfo.isFile()
        || !isChild(realRoot, fs.realpathSync(pluginManifest))) throw new Error('插件元数据文件无效');
    }
    return { raw, data };
  }

  function catalog() {
    try {
      const manifest = readManifest(sourcePath, 'openai-curated');
      return { available: true, count: manifest.data.plugins.length, manifest, error: '' };
    } catch (err) {
      const error = err.code === 'ENOENT'
        ? '未找到完整的 ChatGPT 本机插件缓存，请先启动 ChatGPT 并检查网络，等待目录同步后重试。'
        : 'ChatGPT 本机插件缓存无法读取或格式不受支持，请先检查网络并刷新插件目录。';
      return { available: false, count: 0, manifest: null, error };
    }
  }

  // Hash both paths and bytes; reject links instead of following files outside the
  // cached marketplace. The same function verifies the finished copy.
  async function snapshotDigest(root, manifest) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    hash.update(manifest.raw, 'utf8');
    async function visit(full, relative) {
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) throw new Error('插件缓存包含符号链接，未复制或修改配置');
      hash.update(`\0${relative.replace(/\\/g, '/')}\0`);
      if (stat.isDirectory()) {
        hash.update('directory\0');
        for (const name of (await fs.promises.readdir(full)).sort()) await visit(path.join(full, name), path.join(relative, name));
        return;
      }
      if (!stat.isFile()) throw new Error('插件缓存包含不支持的文件类型，未复制或修改配置');
      bytes += stat.size;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('插件缓存超过 256 MB，未复制或修改配置');
      hash.update(`file:${stat.size}\0`);
      const fd = await fs.promises.open(full, 'r');
      try {
        for (;;) {
          const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
      } finally { await fd.close(); }
    }
    for (const { name } of manifest.data.plugins) await visit(path.join(root, 'plugins', name), path.join('plugins', name));
    return hash.digest('hex');
  }

  function inspectSnapshot(root) {
    try {
      const markerFile = path.join(root, SNAPSHOT_MARKER);
      if (fs.lstatSync(markerFile).isSymbolicLink()) throw new Error('快照标记不能是符号链接');
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      const manifest = readManifest(root, MARKETPLACE_ID);
      if (marker.version !== 1 || !/^[a-f0-9]{64}$/.test(marker.sourceDigest)
        || marker.count !== manifest.data.plugins.length) throw new Error('快照标记无效');
      return { valid: true, count: marker.count, sourceDigest: marker.sourceDigest };
    } catch {
      return { valid: false, count: 0, sourceDigest: '' };
    }
  }

  async function ensureSnapshot(manifest) {
    const fingerprint = await snapshotDigest(sourcePath, manifest);
    fs.mkdirSync(snapshotRoot, { recursive: true });
    const realAppDir = fs.realpathSync(path.resolve(appDir));
    const realRoot = fs.realpathSync(snapshotRoot);
    if (!isChild(realAppDir, realRoot) || fs.lstatSync(snapshotRoot).isSymbolicLink()) {
      throw new Error('本地插件市场目录不在 gpt++ 数据目录内，未复制或修改配置');
    }
    let dest = path.join(realRoot, `snapshot-${fingerprint.slice(0, 16)}`);
    if (fs.existsSync(dest)) {
      const existing = inspectSnapshot(dest);
      if (existing.valid && existing.sourceDigest === fingerprint) {
        try { if (await snapshotDigest(dest, manifest) === fingerprint) return dest; }
        catch { /* Preserve a damaged snapshot; create a separate copy below. */ }
      }
      dest = path.join(realRoot, `snapshot-${fingerprint.slice(0, 16)}-${crypto.randomBytes(6).toString('hex')}`);
    }
    const stage = fs.mkdtempSync(path.join(realRoot, '.stage-'));
    try {
      const parent = fs.realpathSync(path.dirname(stage));
      if (!samePath(parent, realRoot) || !path.basename(stage).startsWith('.stage-')) throw new Error('无效的临时目录');
      fs.mkdirSync(path.join(stage, 'plugins'), { recursive: true });
      for (const { name } of manifest.data.plugins) {
        await fs.promises.cp(path.join(sourcePath, 'plugins', name), path.join(stage, 'plugins', name), {
          recursive: true, errorOnExist: true, force: false, dereference: false,
          async filter(src) {
            if ((await fs.promises.lstat(src)).isSymbolicLink()) throw new Error('插件缓存包含符号链接，未复制或修改配置');
            return true;
          },
        });
      }
      if (await snapshotDigest(stage, manifest) !== fingerprint) throw new Error('复制时插件缓存发生变化，请重试');
      const manifestDir = path.join(stage, '.agents', 'plugins');
      fs.mkdirSync(manifestDir, { recursive: true });
      const copy = { ...manifest.data, name: MARKETPLACE_ID,
        interface: { ...(manifest.data.interface || {}), displayName: 'OpenAI 插件示例（本地）' } };
      fs.writeFileSync(path.join(manifestDir, 'marketplace.json'), JSON.stringify(copy, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(stage, SNAPSHOT_MARKER), JSON.stringify({ version: 1,
        sourceDigest: fingerprint, count: copy.plugins.length }) + '\n', 'utf8');
      if (!samePath(path.dirname(dest), realRoot) || !path.basename(dest).startsWith('snapshot-')) throw new Error('无效的快照目录');
      fs.renameSync(stage, dest);
      return dest;
    } finally {
      if (fs.existsSync(stage)) {
        if (!samePath(fs.realpathSync(path.dirname(stage)), realRoot) || !path.basename(stage).startsWith('.stage-')) {
          throw new Error('临时目录不在预期位置，未自动清理');
        }
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
  }

  function section(text) {
    const lines = toml.splitKeepEol(text), starts = [], ends = [];
    lines.forEach((line, i) => {
      const value = noEol(line);
      if (value === BEGIN || value.startsWith(BEGIN + ' ')) starts.push(i);
      if (value === END) ends.push(i);
    });
    if (!starts.length && !ends.length) return { present: false, lines };
    if (starts.length !== 1 || ends.length !== 1 || ends[0] !== starts[0] + 4) {
      throw new Error('gpt++ 的插件目录配置块已被修改，未更改配置；请检查 config.toml 中的标记。');
    }
    const start = starts[0];
    const marker = /^# >>> gpt\+\+ ChatGPT plugin catalog >>>(?: no-eol-sha256=([a-f0-9]{64}))?(?: source-sha256=([a-f0-9]{64}))?$/.exec(noEol(lines[start]));
    let configuredSource = '';
    try {
      const line = noEol(lines[start + 3]);
      if (!line.startsWith('source = ')) throw new Error('missing source');
      configuredSource = JSON.parse(line.slice('source = '.length));
      if (typeof configuredSource !== 'string' || !path.isAbsolute(configuredSource)) throw new Error('invalid source');
    } catch { configuredSource = ''; }
    const legacy = configuredSource && !marker?.[2] && samePath(configuredSource, sourcePath);
    const managed = configuredSource && marker?.[2] === digest(configuredSource)
      && samePath(path.dirname(configuredSource), snapshotRoot)
      && /^snapshot-[a-f0-9]{16}(?:-[a-f0-9]{12})?$/.test(path.basename(configuredSource));
    if (!marker || !toml.tableHeaderIndices(lines).includes(start + 1)
      || noEol(lines[start + 1]) !== `[marketplaces.${MARKETPLACE_ID}]`
      || noEol(lines[start + 2]) !== 'source_type = "local"' || (!legacy && !managed)) {
      throw new Error('gpt++ 的插件目录配置块已被修改，未更改配置；请检查 config.toml 中的标记。');
    }
    return { present: true, lines, start, end: ends[0], previousHash: marker[1] || '', source: configuredSource, legacy: !!legacy };
  }

  function ensureNoConflict(lines) {
    const headers = toml.tableHeaderIndices(lines);
    const firstHeader = headers.length ? headers[0] : lines.length;
    for (let i = 0; i < firstHeader; i += 1) {
      if (String(toml.topLevelKey(noEol(lines[i])) || '') === 'marketplaces') {
        throw new Error('Codex 配置已有内联 marketplaces，无法安全添加插件目录；未修改配置。');
      }
    }
    const ownHeader = /^\s*\[\[?\s*(?:marketplaces|"marketplaces"|'marketplaces')\s*\.\s*(?:gptplus-curated|"gptplus-curated"|'gptplus-curated')(?:\s*\.[^\]]*)?\s*\]\]?\s*(?:#.*)?$/;
    const ownKey = /^\s*(?:(?:marketplaces|"marketplaces"|'marketplaces')\s*\.\s*)?(?:gptplus-curated|"gptplus-curated"|'gptplus-curated')(?:\s*\.[^=]+)?\s*=/;
    if (headers.some((i) => ownHeader.test(noEol(lines[i]))) || lines.some((line) => ownKey.test(noEol(line)))) {
      throw new Error('Codex 配置中已有同名插件市场，未覆盖原配置。');
    }
  }

  function status() {
    const found = catalog();
    let existing;
    try { existing = section(readFile(configPath).text); }
    catch (err) { return { configured: false, needsMigration: false, catalogAvailable: found.available,
      catalogCount: found.count, error: err.message }; }
    const snapshot = existing.present && !existing.legacy ? inspectSnapshot(existing.source) : null;
    const configured = snapshot?.valid === true;
    const available = configured || found.available;
    return { configured, needsMigration: existing.present && !configured,
      catalogAvailable: available, catalogCount: configured ? snapshot.count : found.count,
      error: available ? '' : found.error };
  }

  // Only expose entries from our registered snapshot, never from an arbitrary path.
  function publicCatalog() {
    const existing = section(readFile(configPath).text);
    if (!existing.present || existing.legacy || !inspectSnapshot(existing.source).valid) {
      throw new Error('本地插件市场尚未注册或快照不可用');
    }
    const manifest = readManifest(existing.source, MARKETPLACE_ID);
    const plugins = manifest.data.plugins.map((item) => {
      const file = path.join(existing.source, 'plugins', item.name, '.codex-plugin', 'plugin.json');
      let metadata;
      try { metadata = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { metadata = {}; }
      const text = (value) => typeof value === 'string' ? value.trim().slice(0, 300) : '';
      return {
        name: item.name,
        displayName: text(metadata?.interface?.displayName) || item.name,
        description: text(metadata?.interface?.shortDescription) || text(metadata?.description),
        category: text(item.category) || text(metadata?.interface?.category) || 'Other',
      };
    });
    return { marketplacePath: path.join(existing.source, '.agents', 'plugins', 'marketplace.json'), plugins };
  }

  function writeChanged(before, text) {
    if (text === before.text) return { changed: false, backupPath: '' };
    const backupPath = before.exists ? backup() : '';
    const current = readFile(configPath);
    if (current.exists !== before.exists || current.text !== before.text) {
      throw new Error('Codex 配置在修复期间发生变化，未覆盖新内容，请重试。');
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.gptplus-plugin-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
      const latest = readFile(configPath);
      if (latest.exists !== before.exists || latest.text !== before.text) {
        throw new Error('Codex 配置在修复期间发生变化，未覆盖新内容，请重试。');
      }
      fs.renameSync(temp, configPath);
    } finally {
      try { fs.unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return { changed: true, backupPath, rollback: () => {
      const latest = readFile(configPath);
      if (!latest.exists || latest.text !== text) {
        throw new Error('Codex 配置在回退前发生变化，未覆盖新内容');
      }
      writeChanged(latest, before.text);
    } };
  }

  async function setEnabled(enabled) {
    const before = readFile(configPath), existing = section(before.text);
    if (enabled) {
      if (!existing.present) ensureNoConflict(existing.lines);
      const found = catalog();
      const oldSnapshot = existing.present && !existing.legacy ? inspectSnapshot(existing.source) : null;
      if (!found.available && !oldSnapshot?.valid) throw new Error(found.error);
      const nextSource = found.available ? await ensureSnapshot(found.manifest) : existing.source;
      if (existing.present && !existing.legacy && samePath(existing.source, nextSource)) {
        return { changed: false, backupPath: '', ...status() };
      }
      const eol = /\r\n|\n|\r/.exec(before.text)?.[0] || '\n';
      const needsEol = !existing.present && before.text.length > 0 && !/[\r\n]$/.test(before.text);
      const previousHash = existing.present ? existing.previousHash : needsEol ? digest(before.text) : '';
      const marker = BEGIN + (previousHash ? ` no-eol-sha256=${previousHash}` : '')
        + ` source-sha256=${digest(nextSource)}`;
      const block = [marker, `[marketplaces.${MARKETPLACE_ID}]`, 'source_type = "local"',
        `source = ${toml.tomlString(nextSource)}`, END, ''].join(eol);
      const text = existing.present
        ? existing.lines.slice(0, existing.start).join('') + block + existing.lines.slice(existing.end + 1).join('')
        : before.text + (needsEol ? eol : '') + block;
      return { ...writeChanged(before, text), ...status() };
    }
    if (!existing.present) return { changed: false, backupPath: '', ...status() };
    let prefix = existing.lines.slice(0, existing.start).join('');
    const suffix = existing.lines.slice(existing.end + 1).join('');
    if (existing.previousHash && !suffix) {
      const withoutEol = prefix.replace(/(?:\r\n|\n|\r)$/, '');
      if (digest(withoutEol) === existing.previousHash) prefix = withoutEol;
    }
    return { ...writeChanged(before, prefix + suffix), ...status() };
  }

  return { status, setEnabled, publicCatalog, sourcePath, manifestPath, snapshotRoot };
}

module.exports = { createChatGptPluginRecovery, MARKETPLACE_ID, BEGIN, END };
