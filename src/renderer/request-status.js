// HTTP 结果说明在主页和使用记录中保持一致。
export function requestStatusHint(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return { tone: 'ok', title: '请求正常', message: '上游已成功响应。' };
  if (code >= 300 && code < 400) return { tone: 'error', title: '收到重定向', message: '可能是渠道 API 地址或接口路径不匹配，请检查渠道配置。' };
  const known = {
    400: ['请求参数无效', '可能是模型名、请求内容或接口协议不匹配，请检查请求配置。'],
    401: ['身份验证失败', '可能是 API Key 无效或过期，请检查渠道密钥。'],
    403: ['访问被拒绝', '可能是账号权限不足或模型未获授权，请检查渠道权限。'],
    404: ['接口或模型不存在', '可能是 API 地址或模型名称不正确，请检查渠道配置。'],
    408: ['请求超时', '上游处理时间过长，建议稍后重试并检查网络状态。'],
    413: ['请求内容过大', '可能超过上游请求或上下文限制，请缩短内容后重试。'],
    422: ['请求内容无法处理', '参数格式可能不符合模型要求，请检查请求设置。'],
    429: ['请求触发限制', '可能触发限流或额度不足，请稍后重试。'],
    499: ['请求已中断', '客户端已取消或断开请求；如果是主动停止，属于正常中断。'],
    500: ['上游服务异常', '上游服务内部出错，建议稍后重试或检查服务状态。'],
    502: ['上游服务异常', '可能是上游不可用或接口地址异常，请检查服务状态。'],
    503: ['上游暂不可用', '可能正在维护或暂时过载，请稍后重试。'],
    504: ['上游响应超时', '上游处理超时，建议稍后重试或检查网络状态。'],
  }[code];
  if (known) return { tone: 'error', title: known[0], message: known[1] };
  if (code >= 400 && code < 500) return { tone: 'error', title: '请求未被接受', message: '可能与请求参数、认证或权限有关，请查看错误详情。' };
  if (code >= 500 && code < 600) return { tone: 'error', title: '上游服务异常', message: '可能是上游故障、负载过高或网络问题，请稍后重试。' };
  return { tone: 'error', title: '请求未成功', message: '可在全部记录中查看错误详情。' };
}

export function requestStatusDetails(ctx, status, id) {
  const { el } = ctx;
  const hint = requestStatusHint(status);
  return el('span', {
    class: 'home-recent-status',
    attrs: { tabindex: '0', 'aria-describedby': id },
  }, [
    el('span', { class: 'chip ' + (hint.tone === 'ok' ? 'chip-ok' : 'chip-err') + ' home-recent-status-chip', text: `HTTP ${status}` }),
    el('span', { class: `home-recent-status-tip home-recent-status-tip-${hint.tone}`, attrs: { id, role: 'tooltip' } }, [
      el('span', { class: 'home-recent-status-tip-head' }, [
        el('strong', { text: hint.title }),
        el('span', { class: 'home-recent-status-tip-code mono', text: `HTTP ${status}` }),
      ]),
      ...(hint.message ? [el('span', { class: 'home-recent-status-tip-copy', text: hint.message })] : []),
    ]),
  ]);
}
