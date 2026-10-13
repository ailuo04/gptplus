'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyReleaseSignatures } = require('./verify-signature.cjs');

const ROOT = path.resolve(__dirname, '..');

function signingLinkFromEnvironment(env = process.env) {
  return String(env.WIN_CSC_LINK || env.CSC_LINK || '').trim();
}

function looksLikeCertificatePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('file://');
}

function resolveCertificatePath(value, root = ROOT) {
  if (!looksLikeCertificatePath(value)) return null;
  if (value.startsWith('file://')) return value.slice('file://'.length);
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function validateSigningEnvironment(env = process.env, root = ROOT) {
  const link = signingLinkFromEnvironment(env);
  if (!link) {
    return {
      ok: false,
      message: [
        '未检测到 Windows 代码签名证书。',
        '请把受 Windows 信任的 .pfx/.p12 证书放在仓库外，并设置 WIN_CSC_LINK 与 WIN_CSC_KEY_PASSWORD。',
        '例如：$env:WIN_CSC_LINK = "D:\\secrets\\gptplus-code-signing.pfx"',
        '本次未生成正式安装包；本地测试请使用 npm run dist:unsigned。',
      ].join('\n'),
    };
  }

  const certificatePath = resolveCertificatePath(link, root);
  if (certificatePath && !fs.existsSync(certificatePath)) {
    return {
      ok: false,
      message: `代码签名证书文件不存在：${certificatePath}`,
    };
  }

  return { ok: true, link };
}

function runReleaseBuild(env = process.env, spawn = spawnSync) {
  const validation = validateSigningEnvironment(env);
  if (!validation.ok) {
    console.error(`[release] ${validation.message}`);
    return 2;
  }

  const npmCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawn(npmCommand, [
    'electron-builder',
    '--win',
    'nsis',
    '--publish',
    'never',
    '--config.forceCodeSigning=true',
  ], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[release] 构建命令启动失败：${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;

  if (!verifyReleaseSignatures(ROOT)) {
    console.error('[release] 构建完成，但产物签名不是 Valid，拒绝作为正式发布包交付。');
    return 1;
  }

  console.log('[release] 安装器和主程序均已通过 Authenticode 签名验证。');
  return 0;
}

if (require.main === module) {
  process.exitCode = runReleaseBuild();
}

module.exports = {
  signingLinkFromEnvironment,
  looksLikeCertificatePath,
  resolveCertificatePath,
  validateSigningEnvironment,
  runReleaseBuild,
};
