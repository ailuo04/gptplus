'use strict';
// 增量维护 ~/.codex/config.toml 里属于 gpt++ 的部分（契约见 spec.md 第 4、8 节）。
//
// 设计要点：
//  * 绝不整体 parse/重写 TOML —— 用户注释、顺序、缩进、其它段落逐字保留。
//  * 只动两类东西：
//      1) 顶层键 model / model_provider / model_catalog_json
//      2) 段 [model_providers.gptplus]
//  * 顶层键“就地改写”：原本存在的行保持位置，只替换值；原本不存在的行插到
//    顶层区末尾（第一个 [table] 之前）。还原时把原行原样写回 / 删除新增行，
//    因此 enable -> disable 能逐字节回到原文件。
//  * 段 [model_providers.gptplus] 以带标记的块形式追加在文件末尾；删除时按 TOML
//    表边界只移除 gptplus 表及其子表，标记之间混入的客户端配置保持原样；
//    base_url 跟随 store.get().gateway.{port,host}（用户改端口后客户端必须指向新端口），
//    applyInjection 显式传入的 port/host 优先。
//  * 原始值记录在 <BACKUP_DIR>/inject-state-<hash>.json，还原时据此恢复；
//    状态文件丢失时退化为“只删我们自己特征明显的内容”。
//  * 每次写入前备份到 <BACKUP_DIR>/config.toml.<YYYYMMDD-HHmmss>，保留最近 10 份。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANAGED_KEYS = ['model', 'model_provider', 'model_catalog_json'];
const PROVIDER_ID = 'gptplus';
const PROVIDER_NAME = 'gpt++ Gateway';
const DEFAULT_PORT = 18120;
const DEFAULT_HOST = '127.0.0.1';
const BACKUP_KEEP = 10;

const SECTION_BEGIN = '# >>> gpt++ gateway provider >>>';
const SECTION_END = '# <<< gpt++ gateway provider <<<';

const GPT_SECTION_RE = /^\s*\[\s*model_providers\s*\.\s*gptplus\s*(?:\.[^\]]*)?\]\s*$/;
const KEY_RE = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=/;

// ---------------------------------------------------------------- 文本工具

/** 按行切分，保留每行自己的行尾（不改变文件任何字节） */
function splitKeepEol(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        out.push(text.slice(start, i + 2));
        i += 1;
      } else {
        out.push(text.slice(start, i + 1));
      }
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function stripEol(line) {
  return String(line).replace(/[\r\n]+$/, '');
}

function hasEol(line) {
  return /[\r\n]$/.test(String(line));
}

function dominantEol(text) {
  const m = /[\r\n]+/.exec(text);
  return m ? m[0] : '\n';
}

/** 极简 TOML 状态机：跟踪字符串/数组深度，用于区分“表头行”和数组元素行 */
function scanLine(state, raw) {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (state.mode === 'mlb') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (raw.startsWith('"""', i)) {
        state.mode = null;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (state.mode === 'mll') {
      if (raw.startsWith("'''", i)) {
        state.mode = null;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (state.mode === 'basic') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') state.mode = null;
      i += 1;
      continue;
    }
    if (state.mode === 'literal') {
      if (ch === "'") state.mode = null;
      i += 1;
      continue;
    }
    if (ch === '#') break; // 行内注释
    if (raw.startsWith('"""', i)) {
      state.mode = 'mlb';
      i += 3;
      continue;
    }
    if (raw.startsWith("'''", i)) {
      state.mode = 'mll';
      i += 3;
      continue;
    }
    if (ch === '"') {
      state.mode = 'basic';
      i += 1;
      continue;
    }
    if (ch === "'") {
      state.mode = 'literal';
      i += 1;
      continue;
    }
    if (ch === '[' || ch === '{') state.depth += 1;
    else if (ch === ']' || ch === '}') state.depth = Math.max(0, state.depth - 1);
    i += 1;
  }
}

/** @returns {number[]} 深度 0 上的 [table] / [[array]] 行下标 */
function tableHeaderIndices(lines) {
  const state = { depth: 0, mode: null };
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripEol(lines[i]);
    if (state.mode === null && state.depth === 0 && /^\s*\[/.test(raw)) found.push(i);
    scanLine(state, raw);
  }
  return found;
}

/** 顶层区结束位置（第一个表头之前），没有表头时为 lines.length */
function topLevelEnd(lines) {
  const headers = tableHeaderIndices(lines);
  return headers.length ? headers[0] : lines.length;
}

function topLevelKey(raw) {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  let key = m[1];
  if (
    (key.startsWith('"') && key.endsWith('"') && key.length > 1) ||
    (key.startsWith("'") && key.endsWith("'") && key.length > 1)
  ) {
    key = key.slice(1, -1);
  }
  return key;
}

function findTopLevelKeyIndex(lines, key) {
  const end = topLevelEnd(lines);
  for (let i = 0; i < end; i += 1) {
    if (topLevelKey(stripEol(lines[i])) === key) return i;
  }
  return -1;
}

/** TOML basic string（Windows 路径必须转义反斜杠） */
function tomlString(value) {
  return (
    '"' +
    String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, ' ') +
    '"'
  );
}

function gatewayAuthCommand(configPath) {
  const quotedPath = String(configPath || '').replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$raw=[System.IO.File]::ReadAllText('${quotedPath}'); $config=ConvertFrom-Json -InputObject $raw -ErrorAction Stop; $token=[string]$config.gateway.token; if ([string]::IsNullOrWhiteSpace($token)) { throw 'gpt++ gateway token is empty' }; [Console]::Out.Write($token)`,
  ].join('; ');
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  };
}

/** 端口必须是 1..65535 的整数，否则回落 */
function normalizePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

/**
 * base_url 里的 host：接受 "127.0.0.1"、"localhost"、"::1"、"http://host/v1" 等形式，
 * 去掉协议/路径/误填的端口；IPv6 自动加方括号。
 */
function normalizeHost(value, fallback) {
  let host = String(value == null ? '' : value).trim();
  if (host) {
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').trim();
  }
  if (!host) return fallback;
  const withPort = /^([^:[\]]+):\d{1,5}$/.exec(host);
  if (withPort) host = withPort[1];
  if (host.startsWith('[') && host.endsWith(']')) return host;
  if (host.includes(':')) return `[${host}]`;
  return host;
}

/** YYYYMMDD-HHmmss（本地时间） */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ---------------------------------------------------------------- 工厂

/**
 * @param {{ store:any, catalog?:any, paths?:any }} deps
 */
function createCodexConfig({ store, catalog, paths } = {}) {
  const fallback = require('./paths.js');
  const p = paths && typeof paths === 'object' ? paths : {};
  const codexConfigPath = p.CODEX_CONFIG_PATH || fallback.CODEX_CONFIG_PATH;
  const backupDir = p.BACKUP_DIR || fallback.BACKUP_DIR;
  const defaultCatalogPath = p.CATALOG_PATH || fallback.CATALOG_PATH;
  const appConfigPath = p.CONFIG_PATH || store?.configPath || fallback.CONFIG_PATH;

  function readText() {
    try {
      return fs.readFileSync(codexConfigPath, 'utf8');
    } catch {
      return '';
    }
  }

  function statePath() {
    const hash = crypto
      .createHash('sha1')
      .update(path.resolve(codexConfigPath))
      .digest('hex')
      .slice(0, 8);
    return path.join(backupDir, `inject-state-${hash}.json`);
  }

  function readState() {
    try {
      const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      return state && typeof state === 'object' ? state : null;
    } catch {
      return null;
    }
  }

  function saveState(state) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  function clearState() {
    try {
      fs.rmSync(statePath(), { force: true });
    } catch {
      /* ignore */
    }
  }

  /** 只保留最近 10 份 config.toml.* 备份 */
  function pruneBackups() {
    let names;
    try {
      names = fs.readdirSync(backupDir);
    } catch {
      return;
    }
    const files = names
      .filter((n) => n.startsWith('config.toml.'))
      .filter((n) => {
        try {
          return fs.statSync(path.join(backupDir, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try {
        fs.rmSync(path.join(backupDir, name), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 选一个"比目录里所有备份都新"的文件名。
   * 同一秒内多次备份时用补零后缀（-01、-02…），保证按文件名排序 == 按时间排序，
   * 否则被删掉的 base 名会被复用，最新的一份反而被当成最旧的清掉。
   */
  function nextBackupTarget(base) {
    let names = [];
    try {
      names = fs.readdirSync(backupDir).filter((n) => n.startsWith('config.toml.'));
    } catch {
      names = [];
    }
    const max = names.length ? names.slice().sort()[names.length - 1] : '';
    if (base > max) return path.join(backupDir, base);
    for (let n = 1; ; n += 1) {
      const candidate = `${base}-${String(n).padStart(2, '0')}`;
      if (candidate > max && !fs.existsSync(path.join(backupDir, candidate))) {
        return path.join(backupDir, candidate);
      }
    }
  }

  /** @returns {string} 备份文件路径；文件不存在时返回 '' */
  function backup() {
    if (!fs.existsSync(codexConfigPath)) return '';
    const text = readText();
    fs.mkdirSync(backupDir, { recursive: true });
    const target = nextBackupTarget(`config.toml.${stamp()}`);
    fs.writeFileSync(target, text, 'utf8');
    pruneBackups();
    return target;
  }

  /**
   * 网关地址信息。端口/host 跟随 store.get().gateway（用户改端口后必须生效），
   * 调用方显式传入的 port/host 优先级更高。
   */
  function gatewayInfo(override = {}) {
    let cfg = {};
    try {
      cfg = store && typeof store.get === 'function' ? store.get() : {};
    } catch {
      cfg = {};
    }
    const g = cfg && cfg.gateway && typeof cfg.gateway === 'object' ? cfg.gateway : {};
    const port = normalizePort(override.port, normalizePort(g.port, DEFAULT_PORT));
    const host = normalizeHost(override.host, normalizeHost(g.host, DEFAULT_HOST));
    return { port, host };
  }

  function isInjected() {
    const text = readText();
    if (!text) return false;
    if (text.includes(SECTION_BEGIN)) return true;
    return splitKeepEol(text).some((l) => GPT_SECTION_RE.test(stripEol(l)));
  }

  /**
   * 删除 [model_providers.gptplus] 及其子表。
   *
   * 标记块只能说明“这块曾经由 gpt++ 创建”，不能说明块内每一行都属于 gpt++：
   * Codex 会在重启时把 model_reasoning_effort、[desktop]、[projects] 等配置
   * 插到我们段落的后面（有时落到结束标记之前）。因此删除必须按 TOML 表边界
   * 精确进行，只移除 gptplus 表本身；标记之间的其它内容原样保留。
   */
  function removeGptplusSection(lines) {
    const headers = tableHeaderIndices(lines);
    const ours = new Array(lines.length).fill(false);
    let found = false;

    for (let i = 0; i < headers.length; i += 1) {
      const at = headers[i];
      if (!GPT_SECTION_RE.test(stripEol(lines[at]))) continue;
      found = true;
      const stop = i + 1 < headers.length ? headers[i + 1] : lines.length;
      for (let j = at; j < stop; j += 1) ours[j] = true;
    }

    const begin = lines.findIndex((l) => stripEol(l).trim() === SECTION_BEGIN);
    let end = -1;
    if (begin >= 0) {
      for (let i = begin + 1; i < lines.length; i += 1) {
        if (stripEol(lines[i]).trim() === SECTION_END) {
          end = i;
          break;
        }
      }
    }

    const markers = new Set();
    if (begin >= 0) markers.add(begin);
    if (end >= 0) markers.add(end);
    if (!found && markers.size === 0) return false;

    // 标记块内只有我们的表/空行：整块删除，保证重复注入逐字节幂等。
    if (begin >= 0 && end > begin) {
      let onlyOurs = true;
      for (let i = begin; i <= end; i += 1) {
        const raw = stripEol(lines[i]);
        if (i === begin || i === end || !raw.trim() || ours[i]) continue;
        onlyOurs = false;
        break;
      }
      if (onlyOurs) {
        lines.splice(begin, end - begin + 1);
        return true;
      }
    }

    // 标记之间混入了用户/客户端配置：只删标记和 gptplus 表，其它行保留。
    const remove = new Set(markers);
    for (let i = 0; i < ours.length; i += 1) if (ours[i]) remove.add(i);
    if (remove.size === 0) return false;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (remove.has(i)) lines.splice(i, 1);
    }
    return true;
  }

  /** 该键值是否明显是 gpt++ 写的（状态文件丢失时的兜底判断） */
  function looksLikeOurValue(key, line) {
    const raw = stripEol(line);
    const eq = raw.indexOf('=');
    if (eq < 0) return false;
    const value = raw.slice(eq + 1).trim();
    if (key === 'model_catalog_json') {
      // 只有指向我们自己生成的目录文件才算我们的键。
      // 无条件返回 true 会把用户手写的 model_catalog_json 一起删掉。
      const ours = [defaultCatalogPath, p.CATALOG_PATH].filter(Boolean);
      const lower = value.replace(/^["']|["']$/g, '').toLowerCase();
      if (ours.some((c) => lower === String(c).toLowerCase())) return true;
      return ours.some((c) => lower.endsWith(path.basename(String(c), '.json').toLowerCase() + '.json'));
    }
    if (key === 'model_provider') return /^["']gptplus["']$/.test(value);
    if (key === 'model') {
      const candidate = value.replace(/^["']|["']$/g, '');
      if (/^p_[0-9a-f]{8}__/.test(candidate)) return true;
      try {
        return !!catalog && typeof catalog.buildEntries === 'function' && catalog.buildEntries().some((entry) => entry && entry.slug === candidate);
      } catch {
        return false;
      }
    }
    return false;
  }

  /** 在顶层区插入一行（优先紧跟最后一个受管键；否则放在第一个表头前） */
  function insertTopLevelLine(lines, line) {
    const text = hasEol(line) ? line : line + '\n';
    const end = topLevelEnd(lines);
    let at = end;
    for (let i = 0; i < end; i += 1) {
      const key = topLevelKey(stripEol(lines[i]));
      if (key && MANAGED_KEYS.includes(key)) at = i + 1;
    }
    if (at >= lines.length && lines.length > 0 && !hasEol(lines[lines.length - 1])) {
      lines[lines.length - 1] += '\n';
    }
    lines.splice(at, 0, text);
  }

  /**
   * 应用/撤销注入。
   * 网关地址默认取 store.get().gateway.{port,host}（用户改端口后必须生效），
   * 显式传入的 port/host 优先。
   * @param {{ enabled?:boolean, catalogPath?:string, defaultModel?:string|null,
   *           port?:number, host?:string }} opts
   * @returns {{ changed:boolean, backupPath:string }}
   */
  function applyInjection({ enabled = false, catalogPath, defaultModel, port, host } = {}) {
    const original = readText();
    const eol = dominantEol(original);
    const lines = splitKeepEol(original);
    const fileExisted = fs.existsSync(codexConfigPath);

    if (!enabled) {
      const state = readState();
      // 注入前的文件是否存在，以状态文件记录为准（否则会把我们刚创建的空文件当成"原本就有"）
      const existedBefore =
        state && typeof state.fileExisted === 'boolean' ? state.fileExisted : fileExisted;
      const record = state && state.keys ? state.keys : null;
      const restore = [];
      for (const key of MANAGED_KEYS) {
        const idx = findTopLevelKeyIndex(lines, key);
        const rec = record ? record[key] : null;
        if (rec && rec.existed && typeof rec.line === 'string') {
          if (idx >= 0) lines[idx] = rec.line;
          else restore.push(rec.line);
        } else if (rec && !rec.existed) {
          if (idx >= 0) lines.splice(idx, 1);
        } else if (!rec && idx >= 0 && looksLikeOurValue(key, lines[idx])) {
          lines.splice(idx, 1);
        }
      }
      for (const line of restore) insertTopLevelLine(lines, line);
      removeGptplusSection(lines);

      let text = lines.join('');
      // enable 时若给最后一行补过换行，这里只收回那**一个**换行符：
      // 用 [\r\n]+$ 会把用户在注入期间自己加的尾部空行一并吃掉。
      if (state && state.fixEol) text = text.replace(/(?:\r\n|\n|\r)$/, '');

      if (text === original) {
        if (state) clearState();
        return { changed: false, backupPath: '' };
      }

      // 注入前文件并不存在、还原后又空了：把我们创建的空文件删掉
      if (text === '' && !existedBefore) {
        try {
          fs.rmSync(codexConfigPath, { force: true });
        } catch {
          /* ignore */
        }
        clearState();
        return { changed: true, backupPath: '' };
      }

      const backupPath = backup();
      atomicWrite(codexConfigPath, text);
      clearState();
      return { changed: true, backupPath };
    }

    // ---- 注入 ----
    const target = catalogPath || defaultCatalogPath;
    const wanted = [];
    if (defaultModel) wanted.push(['model', String(defaultModel)]);
    wanted.push(['model_provider', PROVIDER_ID]);
    if (target) wanted.push(['model_catalog_json', String(target)]);

    const previousState = readState();
    let record = previousState && previousState.keys ? { ...previousState.keys } : null;
    if (!record) {
      record = {};
      for (const key of MANAGED_KEYS) {
        const idx = findTopLevelKeyIndex(lines, key);
        record[key] = idx >= 0 ? { existed: true, line: lines[idx] } : { existed: false, line: null };
      }
    } else {
      for (const key of MANAGED_KEYS) {
        if (!record[key]) record[key] = { existed: false, line: null };
      }
    }

    // 先摘掉旧的 gptplus 段，保证重复注入是幂等的
    removeGptplusSection(lines);

    // 就地改写 / 删除不需要的受管键
    const deletions = [];
    const pending = [];
    for (const key of MANAGED_KEYS) {
      const idx = findTopLevelKeyIndex(lines, key);
      const want = wanted.find((w) => w[0] === key);
      if (idx >= 0) {
        if (want) {
          const indent = /^[ \t]*/.exec(stripEol(lines[idx]))[0];
          lines[idx] = `${indent}${key} = ${tomlString(want[1])}${eol}`;
        } else {
          deletions.push(idx);
        }
      } else if (want) {
        pending.push(`${key} = ${tomlString(want[1])}${eol}`);
      }
    }
    for (const idx of deletions.sort((a, b) => b - a)) lines.splice(idx, 1);

    if (pending.length) {
      const end = topLevelEnd(lines);
      let at = end;
      for (let i = 0; i < end; i += 1) {
        const key = topLevelKey(stripEol(lines[i]));
        if (key && MANAGED_KEYS.includes(key)) at = i + 1;
      }
      if (at >= lines.length && lines.length > 0 && !hasEol(lines[lines.length - 1])) {
        lines[lines.length - 1] += eol;
      }
      lines.splice(at, 0, ...pending);
    }

    // 末尾追加网关 provider 段（整块带标记，可精确删除）；
    // 端口/host 跟随 store（用户可在设置页改端口），显式传入优先
    const gw = gatewayInfo({ port, host });
    const auth = gatewayAuthCommand(appConfigPath);
    const section = [
      SECTION_BEGIN,
      '',
      '[model_providers.gptplus]',
      `name = ${tomlString(PROVIDER_NAME)}`,
      `base_url = ${tomlString(`http://${gw.host}:${gw.port}/v1`)}`,
      'wire_api = "responses"',
      '[model_providers.gptplus.auth]',
      `command = ${tomlString(auth.command)}`,
      `args = [${auth.args.map(tomlString).join(', ')}]`,
      'refresh_interval_ms = 0',
      SECTION_END,
    ];
    let fixEol = false;
    if (lines.length > 0 && !hasEol(lines[lines.length - 1])) {
      lines[lines.length - 1] += eol;
      fixEol = true;
    }
    lines.push(...section.map((l) => l + eol));

    const text = lines.join('');
    const nextState = {
      version: 1,
      at: Date.now(),
      configPath: path.resolve(codexConfigPath),
      catalogPath: target || null,
      fixEol,
      fileExisted,
      keys: record,
    };

    if (text === original) {
      // 内容没变（例如重复注入），只确保状态文件是最新的
      if (JSON.stringify(previousState) !== JSON.stringify(nextState)) saveState(nextState);
      return { changed: false, backupPath: '' };
    }

    const backupPath = backup();
    atomicWrite(codexConfigPath, text);
    try {
      saveState(nextState);
    } catch {
      /* 状态写不了不阻塞注入；还原时退化为兜底策略 */
    }
    return { changed: true, backupPath };
  }

  return {
    readText,
    backup,
    applyInjection,
    isInjected,
    // 附加只读信息（非契约字段，方便排障）
    configPath: codexConfigPath,
    backupDir,
    statePath,
  };
}

module.exports = {
  createCodexConfig,
  MANAGED_KEYS,
  SECTION_BEGIN,
  SECTION_END,
  // 仅供测试/排障使用的纯函数
  _internal: {
    splitKeepEol, tableHeaderIndices, topLevelKey, tomlString, normalizePort, normalizeHost,
    gatewayAuthCommand,
  },
};
