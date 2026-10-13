'use strict';
// 自动读取 Windows WinINET 系统代理，并为 Node fetch 注入 undici ProxyAgent。
// Clash Verge 开启“系统代理”时，会把 ProxyEnable/ProxyServer 写到这里。
const { execFileSync } = require('node:child_process');
const { URL } = require('node:url');
const { ProxyAgent } = require('undici');

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PROXY_CACHE_MS = 500;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 归一化网络模式：system 自动读取 Windows 代理，direct 永远直连。 */
function normalizeProxyMode(mode) {
  return mode === 'direct' ? 'direct' : 'system';
}

/** 读取单个 Windows 注册表值，供诊断和测试复用。 */
function readRegistryValue(name, execFileSyncImpl = execFileSync) {
  try {
    const output = execFileSyncImpl('reg.exe', ['query', INTERNET_SETTINGS_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = String(output).match(new RegExp(`\\s${name}\\s+REG_\\w+\\s+(.+)`, 'i'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/** 把注册表输出解析成 WinINET 代理设置。 */
function parseRegistrySettings(output) {
  const read = (name) => {
    const match = String(output || '').match(new RegExp(`\\s${name}\\s+REG_\\w+\\s+(.+)`, 'i'));
    return match ? match[1].trim() : '';
  };
  return {
    proxyEnable: read('ProxyEnable'),
    proxyServer: read('ProxyServer'),
    proxyOverride: read('ProxyOverride'),
  };
}

/** 一次读取全部 WinINET 设置，避免每次请求启动多个 reg.exe。 */
function readRegistrySettings(execFileSyncImpl = execFileSync) {
  try {
    const output = execFileSyncImpl('reg.exe', ['query', INTERNET_SETTINGS_KEY], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegistrySettings(output);
  } catch {
    return { proxyEnable: '', proxyServer: '', proxyOverride: '' };
  }
}

/** 把 Windows ProxyOverride 通配符匹配到目标主机。 */
function wildcardMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

/** 判断目标主机是否应遵守系统代理的直连例外。 */
function isProxyBypassed(hostname, override) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (LOOPBACK_HOSTS.has(host)) return true;

  for (const raw of String(override || '').split(';')) {
    const item = raw.trim();
    if (!item || item === '<-loopback>') continue;
    if (item === '<local>' && !host.includes('.')) return true;
    const pattern = item.replace(/^\[|\]$/g, '').split(':')[0];
    if (wildcardMatch(host, pattern)) return true;
  }
  return false;
}

/** 把注册表里的 host:port 或带协议地址规范化成 ProxyAgent URL。 */
function normalizeProxyUrl(value) {
  let raw = String(value || '').trim();
  if (!raw || /^direct$/i.test(raw)) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 从 ProxyServer 的默认值或 http/https 映射中选出目标代理。 */
function parseProxyServer(value, targetUrl) {
  const entries = String(value || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!entries.length) return null;

  const mapped = new Map();
  let fallback = '';
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator === -1) {
      if (!fallback) fallback = entry;
      continue;
    }
    const protocol = entry.slice(0, separator).trim().toLowerCase();
    const proxy = entry.slice(separator + 1).trim();
    if (protocol && proxy) mapped.set(protocol, proxy);
  }

  let protocol = 'http';
  try {
    protocol = new URL(String(targetUrl)).protocol === 'https:' ? 'https' : 'http';
  } catch {
    /* 非 URL 输入由 fetch 自己负责报错 */
  }
  return normalizeProxyUrl(mapped.get(protocol) || mapped.get('https') || mapped.get('http') || fallback);
}

/** 根据 Windows 当前 WinINET 设置解析目标 URL 的代理地址。 */
function detectSystemProxy(targetUrl, options = {}) {
  if (process.platform !== 'win32') return null;

  const execFileSyncImpl = options.execFileSync || execFileSync;
  const settings =
    options.proxyEnable !== undefined || options.proxyServer !== undefined || options.proxyOverride !== undefined
      ? {
          proxyEnable: options.proxyEnable ?? readRegistryValue('ProxyEnable', execFileSyncImpl),
          proxyServer: options.proxyServer ?? readRegistryValue('ProxyServer', execFileSyncImpl),
          proxyOverride: options.proxyOverride ?? readRegistryValue('ProxyOverride', execFileSyncImpl),
        }
      : readRegistrySettings(execFileSyncImpl);
  const proxyEnable = settings.proxyEnable;
  if (Number(proxyEnable) !== 1) return null;

  let url;
  try {
    url = new URL(String(targetUrl));
  } catch {
    return null;
  }
  if (isProxyBypassed(url.hostname, settings.proxyOverride)) return null;

  return parseProxyServer(settings.proxyServer, url.href);
}

/**
 * 创建跟随 Windows 系统代理的 fetch。
 * @param {{ fetchImpl?:Function, detectProxy?:(url:string)=>string|null }} [options]
 * @returns {Function & { close:()=>Promise<void> }}
 */
function createSystemProxyFetch(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时没有可用的 fetch，请升级到 Node 18+');
  const detectProxy = options.detectProxy || ((url) => detectSystemProxy(url));
  let mode = normalizeProxyMode(options.mode);
  const agents = new Map();
  const detected = new Map();

  /** 用 origin 作为缓存键，避免请求路径变化触发重复的系统代理检测。 */
  function cacheKey(url) {
    try {
      return new URL(url).origin;
    } catch {
      return String(url || '');
    }
  }

  const fetchWithProxy = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input && input.url;
    const target = String(url || '');
    const key = cacheKey(target);
    const now = Date.now();
    let proxy = mode === 'system' && !init.dispatcher ? detected.get(key) : null;
    const cached = detected.get(`${key}\u0000time`);
    if (mode === 'system' && !init.dispatcher && (!cached || now - cached > PROXY_CACHE_MS)) {
      proxy = detectProxy(target);
      detected.set(key, proxy || null);
      detected.set(`${key}\u0000time`, now);
    }
    if (!proxy) return fetchImpl(input, init);
    let dispatcher = agents.get(proxy);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxy);
      agents.set(proxy, dispatcher);
    }
    return fetchImpl(input, { ...init, dispatcher });
  };

  fetchWithProxy.close = async () => {
    await Promise.all([...agents.values()].map((agent) => agent.close().catch(() => {})));
    agents.clear();
    detected.clear();
  };
  fetchWithProxy.getMode = () => mode;
  fetchWithProxy.setMode = (nextMode) => {
    mode = normalizeProxyMode(nextMode);
    detected.clear();
    return mode;
  };
  return fetchWithProxy;
}

module.exports = {
  INTERNET_SETTINGS_KEY,
  createSystemProxyFetch,
  detectSystemProxy,
  isProxyBypassed,
  normalizeProxyMode,
  normalizeProxyUrl,
  parseProxyServer,
  parseRegistrySettings,
  readRegistryValue,
  readRegistrySettings,
};
