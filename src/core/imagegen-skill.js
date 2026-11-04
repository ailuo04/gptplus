'use strict';
// Installs an app-owned skill and checksum-protected skill toggles. This does not
// disable the underlying image tool or promise automatic model/tool selection.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { _internal: toml } = require('./codex-config.js');
const BEGIN = '# >>> gpt++ custom image skill';
const END = '# <<< gpt++ custom image skill <<<';
const MARKER = '.gptplus-managed.json';
const ASSETS = path.join(__dirname, 'assets', 'custom-imagegen');
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

function read(file) {
  try {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('生图配置或技能文件不是普通文件，未覆盖');
    return fs.readFileSync(file, 'utf8');
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(temporary, text, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function managedSection(text) {
  const lines = toml.splitKeepEol(text);
  const starts = [], ends = [];
  lines.forEach((line, i) => {
    if (line.startsWith(BEGIN)) starts.push(i);
    if (line.trimEnd() === END) ends.push(i);
  });
  if (!starts.length && !ends.length) return { text, state: null, start: -1, lines };
  const start = starts[0], end = ends[0];
  const match = lines[start]?.trimEnd().match(/^# >>> gpt\+\+ custom image skill sha256=([a-f0-9]{64}) >>>$/);
  if (starts.length !== 1 || ends.length !== 1 || end <= start || !match) throw new Error('生图技能配置标记已被修改，未覆盖');
  const body = lines.slice(start + 1, end).join('');
  if (digest(body) !== match[1]) throw new Error('生图技能配置校验失败，配置块已被修改，未覆盖');
  let state;
  try { state = JSON.parse(lines[start + 1].trimEnd().slice('# state: '.length)); }
  catch { throw new Error('生图技能状态无效，未覆盖'); }
  if (typeof state.enabled !== 'boolean' || typeof state.preferDefault !== 'boolean' || typeof state.builtinSkillDisabled !== 'boolean') {
    throw new Error('生图技能状态无效，未覆盖');
  }
  return { state, start, end, lines, text: lines.slice(0, start).concat(lines.slice(end + 1)).join('') };
}
function checkSkillTables(text) {
  const lines = toml.splitKeepEol(text);
  const headers = new Set(toml.tableHeaderIndices(lines));
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    if (headers.has(i)) { section = lines[i].replace(/#.*$/, '').trim().replace(/["']/g, '').replace(/\s/g, ''); continue; }
    const key = String(toml.topLevelKey(lines[i]) || '').replace(/["']/g, '').replace(/\s/g, '');
    if ((!section && (key === 'skills' || key === 'skills.config')) || (section === '[skills]' && key === 'config')) {
      throw new Error('Codex 配置已有内联 skills/config，无法安全追加技能配置；未覆盖');
    }
  }
}

function createImagegenSkill({ codexHome, configPath, appConfigPath, backup } = {}) {
  if (!codexHome || !configPath || !appConfigPath || typeof backup !== 'function') throw new Error('缺少自定义生图技能路径或备份方法');
  const skillDir = path.resolve(codexHome, 'skills', 'gptplus-imagegen');
  const skillPath = path.join(skillDir, 'SKILL.md');
  const builtinPath = path.resolve(codexHome, 'skills', '.system', 'imagegen', 'SKILL.md');
  const fileNames = ['SKILL.md', 'agents/openai.yaml', 'scripts/generate.py', 'bridge.json'];

  function safeDirectories() {
    // Follow the configured home itself, but never traverse a child junction/link
    // while writing app-managed skill assets or Codex configuration.
    for (const relative of ['skills', 'skills/gptplus-imagegen', 'skills/gptplus-imagegen/agents', 'skills/gptplus-imagegen/scripts']) {
      const dir = path.resolve(codexHome, relative);
      if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory())) {
        throw new Error('生图技能目录包含链接或非目录，未覆盖');
      }
    }
  }
  function verifyAssets() {
    if (!fs.existsSync(skillDir)) return false;
    const marker = read(path.join(skillDir, MARKER));
    if (!marker) throw new Error('同名技能不是 gpt++ 管理的技能，未覆盖');
    let hashes;
    try { hashes = JSON.parse(marker); } catch { throw new Error('生图技能标记已被修改，未覆盖'); }
    for (const name of fileNames) {
      const content = read(path.join(skillDir, name));
      if (typeof hashes[name] !== 'string' || content === null || digest(content) !== hashes[name]) {
        throw new Error('生图技能已被修改或文件缺失，未覆盖；可先停用并检查技能目录');
      }
    }
    return true;
  }
  function desiredAssets() {
    const result = new Map();
    result.set('SKILL.md', fs.readFileSync(path.join(ASSETS, 'SKILL.md'), 'utf8'));
    result.set('agents/openai.yaml', fs.readFileSync(path.join(ASSETS, 'agents', 'openai.yaml'), 'utf8'));
    result.set('scripts/generate.py', fs.readFileSync(path.join(ASSETS, 'generate.py'), 'utf8'));
    result.set('bridge.json', JSON.stringify({ configPath: path.resolve(appConfigPath) }, null, 2) + '\n');
    result.set(MARKER, JSON.stringify(Object.fromEntries([...result].map(([name, content]) => [name, digest(content)])), null, 2) + '\n');
    return result;
  }
  function status() {
    const base = { configured: false, enabled: false, preferDefault: false, builtinSkillDisabled: false,
      automaticSelectionGuaranteed: false, skillPath, error: '' };
    try {
      safeDirectories();
      const section = managedSection(read(configPath) || '');
      if (!section.state) return base;
      if (section.state.enabled && !verifyAssets()) throw new Error('自定义生图技能目录缺失，请检查技能安装状态');
      return { ...base, configured: true, ...section.state };
    } catch (err) { return { ...base, error: err.message }; }
  }
  function sync({ enabled = false, preferDefault = true } = {}) {
    safeDirectories();
    const original = read(configPath);
    const section = managedSection(original || '');
    if (!enabled && !section.state) return { changed: false, rollback() {} };
    checkSkillTables(section.text);
    if (enabled) verifyAssets();
    const state = { enabled: enabled === true, preferDefault: enabled && preferDefault !== false,
      builtinSkillDisabled: enabled && preferDefault !== false && fs.existsSync(builtinPath) };
    const eol = (original || '').includes('\r\n') ? '\r\n' : '\n';
    const lines = [`# state: ${JSON.stringify(state)}`, '[[skills.config]]', `path = ${toml.tomlString(skillPath)}`, `enabled = ${state.enabled}`];
    if (state.builtinSkillDisabled) lines.push('[[skills.config]]', `path = ${toml.tomlString(builtinPath)}`, 'enabled = false');
    const body = lines.join(eol) + eol;
    const block = `${BEGIN} sha256=${digest(body)} >>>${eol}${body}${END}${eol}`;
    const next = section.state
      ? section.lines.slice(0, section.start).join('') + block + section.lines.slice(section.end + 1).join('')
      : section.text + (section.text && !/[\r\n]$/.test(section.text) ? eol : '') + block;
    const changes = [];
    if (enabled) for (const [name, content] of desiredAssets()) {
      const file = path.join(skillDir, name);
      const previous = read(file);
      if (previous !== content) changes.push({ file, previous, next: content });
    }
    if (original !== next) changes.push({ file: configPath, previous: original, next });
    if (!changes.length) return { changed: false, rollback() {} };
    const backupPath = original !== next ? backup() : '';
    const applied = [];
    function rollback() {
      for (const change of applied) if (read(change.file) !== change.next) throw new Error('生图配置在回退前被外部修改，未覆盖；请检查备份');
      for (const change of applied.slice().reverse()) {
        if (change.previous === null) fs.rmSync(change.file, { force: true });
        else atomicWrite(change.file, change.previous);
      }
      applied.length = 0;
      // Only remove empty app-owned directories, never recursively remove a skill.
      for (const dir of [path.join(skillDir, 'agents'), path.join(skillDir, 'scripts'), skillDir]) {
        try { fs.rmdirSync(dir); } catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
      }
    }
    try {
      for (const change of changes) { atomicWrite(change.file, change.next); applied.push(change); }
    } catch (err) {
      try { rollback(); } catch (rollbackError) { throw new Error('生图技能写入和回退失败：' + rollbackError.message); }
      throw err;
    }
    return { changed: true, backupPath, rollback };
  }
  return { sync, status };
}

module.exports = { createImagegenSkill };
