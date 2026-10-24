'use strict';
/**
 * NapCat WebUI API 客户端：只实现登录相关端点（app 内扫码登录用）。
 *
 * 契约（对齐 NapCat 4.x WebUI 路由 /api/auth/login + /api/QQLogin/*）：
 * - 认证：POST /api/auth/login {"hash": sha256(token + ".napcat") 的 hex}
 *   → {code:0, data:{Credential}}；后续请求带 Authorization: Bearer <Credential>。
 * - POST /api/QQLogin/GetQQLoginQrcode → {data:{qrcode:url}}；已登录时 message="QQ Is Logined"。
 * - POST /api/QQLogin/CheckLoginStatus → {data:{isLogin,loginPhase,qrcodeurl,loginError}}。
 * - POST /api/QQLogin/GetQuickLoginListNew → {data:[{uin,isQuickLogin}]}。
 * - POST /api/QQLogin/SetQuickLogin {"uin"} → message="success"。
 * 纯 Node CommonJS，fetchImpl 可注入。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REQUEST_TIMEOUT_MS = 8000;

/** webui.json 的登录密码哈希（盐固定 ".napcat"）。 */
function webuiPasswordHash(token) {
  return crypto.createHash('sha256').update(String(token || '') + '.napcat').digest('hex');
}

/** webui.json 的 host 可能是任意绑定地址（0.0.0.0 / ::），访问时一律归一到本机回环。 */
function normalizeHost(host) {
  const raw = String(host || '').trim();
  return !raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]' ? '127.0.0.1' : raw;
}

/**
 * 读写 NapCat config/webui.json：
 * - 不存在 → 写入我们生成的 {host,port,token}（之后 WebUI 端口/令牌都在我们掌控中）；
 * - 已存在 → 读出真实 port/token 返回（尊重现有配置，也适配登录后 NapCat 刷新 token）。
 * 目录不存在返回 null（非 Shell 布局，WebUI 功能不可用）。
 */
function ensureWebUiConfig(configDir, { port = 6099, token = '' } = {}) {
  const file = path.join(String(configDir || ''), 'webui.json');
  const fallback = { host: '127.0.0.1', port: Number(port) || 6099, token: String(token || ''), loginRate: 3 };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      host: normalizeHost(data.host),
      port: Number(data.port) || fallback.port,
      token: String(data.token || ''),
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 文件损坏：读不了就让 NapCat 自己重建，我们无从得知 token，返回 null 等重试
      return null;
    }
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return { ...fallback };
    } catch {
      return null;
    }
  }
}

/** 从 NapCat 安装目录（启动脚本所在目录）读当前 webui 配置（登录后 token 可能被刷新）。 */
function readWebUiConfig(configDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(String(configDir || ''), 'webui.json'), 'utf8'));
    return {
      host: normalizeHost(data.host),
      port: Number(data.port) || 6099,
      token: String(data.token || ''),
    };
  } catch {
    return null;
  }
}

/**
 * 调一个 WebUI 端点。credential 缓存在实例里，401 时重读 webui.json 重新认证一次
 * （NapCat 登录成功后会刷新 token，缓存必然过期）。
 */
function createWebUiClient({ configDir, fetchImpl, initial = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let config = initial;
  let credential = '';
  let credentialAt = 0;
  const baseUrl = () => `http://${(config && config.host) || '127.0.0.1'}:${(config && config.port) || 6099}`;

  async function authenticate() {
    if (!config) config = readWebUiConfig(configDir);
    if (!config || !config.token) throw new Error('webui.json 不可读或缺少 token');
    const res = await doFetch(`${baseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: webuiPasswordHash(config.token) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    const cred = json && json.data && json.data.Credential;
    if (!res.ok || !cred) {
      const message = json && json.message ? json.message : `HTTP ${res.status}`;
      throw new Error(`WebUI 认证失败: ${message}`);
    }
    credential = cred;
    credentialAt = Date.now();
    return credential;
  }

  /** POST 端点；401/凭证过期自动重认证重试一次。返回 {ok, data, message}。 */
  async function call(action, body = {}) {
    if (!credential) await authenticate();
    const attempt = async () => {
      const res = await doFetch(`${baseUrl()}/api/QQLogin/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    };
    let { status, json } = await attempt().catch((err) => ({ status: 0, json: null, error: err }));
    if (status === 401 || (json && json.code === 401)) {
      credential = '';
      config = readWebUiConfig(configDir) || config;
      await authenticate();
      ({ status, json } = await attempt());
    }
    if (status === 0) return { ok: false, error: json && json.error ? String(json.error) : 'WebUI 请求失败' };
    if (status === 404) return { ok: false, error: 'WebUI 接口不存在（NapCat 版本过旧？）' };
    // NapCat 业务失败也走 HTTP 200 + {code!=0, message}，例如二维码过期或已登录。
    const httpOk = status >= 200 && status < 300;
    const businessOk = json && json.code !== undefined ? Number(json.code) === 0 : true;
    const message = (json && (json.message || json.error)) || '';
    return {
      ok: httpOk && businessOk,
      data: json && json.data,
      message: String(message),
      code: json && json.code,
      error: !httpOk || !businessOk ? String(message || `WebUI HTTP ${status}`) : '',
    };
  }

  return {
    call,
    authenticate,
    baseUrl: () => baseUrl(),
    /** 供测试观察。 */
    _state: () => ({ config, hasCredential: !!credential, credentialAt }),
  };
}

module.exports = { createWebUiClient, webuiPasswordHash, ensureWebUiConfig, readWebUiConfig };
