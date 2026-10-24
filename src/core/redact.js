'use strict';

// Diagnostic output is untrusted: upstream errors may echo credentials or headers.
function redactDiagnostic(value, providers = []) {
  const secrets = new Set();
  for (const provider of providers) {
    if (!provider) continue;
    for (const secret of [provider.apiKey, provider.baseUrl, provider.remoteConnection?.baseUrl,
      provider.remoteConnection?.authToken, provider.authToken, ...Object.values(provider.headers || {})]) {
      if (typeof secret !== 'string' || !secret) continue;
      secrets.add(secret);
      try { secrets.add(encodeURIComponent(secret)); } catch { /* Malformed Unicode is still redacted verbatim. */ }
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  function redact(item) {
    if (typeof item === 'string') {
      for (const secret of ordered) item = item.split(secret).join('[REDACTED]');
      return item;
    }
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key,
        /^(apiKey|baseUrl|headers|password|passwordConfirmation|authToken|token|tokenHash)$/i.test(key) ? '[REDACTED]' : redact(entry),
      ]));
    }
    return item;
  }
  return redact(value);
}

module.exports = { redactDiagnostic };
