'use strict';

function launchThenRestore({ launch, prerequisites, restore } = {}) {
  if (typeof launch !== 'function' || typeof restore !== 'function') {
    throw new Error('启动和插件恢复函数不可用');
  }
  const launchTask = Promise.resolve().then(launch);
  return Promise.all([launchTask, Promise.resolve(prerequisites)])
    .then(([result]) => restore(result));
}

async function restoreEnabledPagePlugins({
  ctx,
  cdpPort,
  timeoutMs = 8000,
  resumeUsageStatusline,
  resumeChatGptBalance,
  resumeVoiceInput,
} = {}) {
  const active = (id) => ctx?.plugins?.isActive?.(id) === true;
  const steps = [];
  if (active('usage-statusline')) {
    steps.push(['usage-statusline', resumeUsageStatusline]);
    if (ctx.plugins.config?.('usage-statusline')?.balance?.enabled === true) {
      steps.push(['balance', resumeChatGptBalance]);
    }
  }
  if (active('voice-input')) steps.push(['voice-input', resumeVoiceInput]);

  const options = { ctx, timeoutMs };
  if (Number.isInteger(cdpPort) && cdpPort > 0) options.findPort = async () => cdpPort;
  const results = [];
  for (const [id, restore] of steps) {
    try {
      if (typeof restore !== 'function') throw new Error('插件注入器不可用');
      results.push({ id, ...(await restore(options)) });
    } catch (error) {
      const message = error?.message || String(error);
      ctx?.log?.({ level: 'warn', msg: `插件「${id}」恢复失败: ${message}` });
      results.push({ id, ok: false, error: message });
    }
  }
  return results;
}

module.exports = { launchThenRestore, restoreEnabledPagePlugins };
