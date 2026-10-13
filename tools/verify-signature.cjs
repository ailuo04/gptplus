'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function releaseArtifacts(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return [
    path.join(root, 'dist', `gpt-plus-${pkg.version}-setup.exe`),
    path.join(root, 'dist', 'win-unpacked', 'gpt-plus.exe'),
  ];
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function readAuthenticodeSignature(filePath, spawn = spawnSync) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, status: 'Missing', subject: '' };
  }

  const escapedPath = escapePowerShellSingleQuoted(filePath);
  const command = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    '[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('; ');
  let lastFailure = null;
  for (const executable of ['pwsh.exe', 'powershell.exe']) {
    const result = spawn(executable, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8', windowsHide: true });

    if (result.error) {
      lastFailure = result.error.message;
      continue;
    }

    const output = String(result.stdout || '').trim();
    try {
      const parsed = JSON.parse(output);
      if (parsed.Status) {
        return {
          ok: parsed.Status === 'Valid',
          status: parsed.Status,
          subject: parsed.Subject || '',
        };
      }
      lastFailure = String(result.stderr || '').trim() || 'PowerShell returned no signature status';
    } catch {
      lastFailure = String(result.stderr || '').trim() || output || `PowerShellExit${result.status ?? 'Unknown'}`;
    }
  }

  return { ok: false, status: 'PowerShellError', subject: '', error: lastFailure };
}

function verifyReleaseSignatures(root = ROOT, spawn = spawnSync) {
  const results = releaseArtifacts(root).map((filePath) => ({
    filePath,
    signature: readAuthenticodeSignature(filePath, spawn),
  }));

  for (const result of results) {
    const { signature } = result;
    const subject = signature.subject ? ` (${signature.subject})` : '';
    console.log(`[signature] ${path.relative(root, result.filePath)}: ${signature.status}${subject}`);
  }

  return results.every(({ signature }) => signature.ok);
}

if (require.main === module) {
  process.exitCode = verifyReleaseSignatures() ? 0 : 1;
}

module.exports = {
  releaseArtifacts,
  readAuthenticodeSignature,
  verifyReleaseSignatures,
  _internal: { escapePowerShellSingleQuoted },
};
