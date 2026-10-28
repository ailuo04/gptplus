// 微信连接页：通过微信官方 iLink Bot API 长轮询收发消息，
// 每个微信联系人映射到独立的 Codex app-server 会话。
// 页面分两张卡：个人微信连接（状态/操作/统计）与连接设置。

const WEIXIN_DEFAULTS = {
  enabled: false,
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: '',
  accountId: '',
  allowFrom: '',
  routeTag: '',
  workDir: '',
  model: '',
  sandbox: 'read-only',
  codexPath: '',
  status: {
    state: 'stopped',
    message: '微信连接未启动。',
    accountId: '',
    lastPeerId: '',
    lastMessageAtMs: 0,
    processedMessages: 0,
    hasToken: false,
  },
};

const STATUS_LABEL = {
  stopped: '已停止',
  starting: '正在启动',
  running: '运行中',
  retrying: '正在重试',
  stopping: '正在停止',
  error: '异常',
};

const RUNNING_STATES = new Set(['starting', 'running', 'retrying']);

const viewState = {
  draft: null,
  busy: false,
  starting: false,
  stopping: false,
  qrBusy: false,
  revealedToken: false,
};

let statusTimer = null;
let qrPollTimer = null;
let qrPollInFlight = false;
let qrPollGeneration = 0;

function stopQrPoll() {
  qrPollGeneration += 1;
  qrPollInFlight = false;
  if (qrPollTimer === null) return;
  clearInterval(qrPollTimer);
  qrPollTimer = null;
}

/** 渲染微信连接页 */
export function renderWeixin(root, ctx, actions) {
  const { el, icon, state } = ctx;
  const cfg = { ...WEIXIN_DEFAULTS, ...(state.weixin || {}) };
  let status = { ...WEIXIN_DEFAULTS.status, ...(cfg.status || {}) };

  const draftValue = (key, fallback) => (viewState.draft && Object.prototype.hasOwnProperty.call(viewState.draft, key)
    ? viewState.draft[key]
    : fallback);

  function collect() {
    return {
      baseUrl: String(draftValue('baseUrl', cfg.baseUrl) || ''),
      token: String(draftValue('token', cfg.token) || ''),
      accountId: String(draftValue('accountId', cfg.accountId) || ''),
      allowFrom: String(draftValue('allowFrom', cfg.allowFrom) || ''),
      routeTag: String(draftValue('routeTag', cfg.routeTag) || ''),
      workDir: String(draftValue('workDir', cfg.workDir) || ''),
      model: String(draftValue('model', cfg.model) || ''),
      sandbox: String(draftValue('sandbox', cfg.sandbox) || 'read-only'),
      codexPath: String(draftValue('codexPath', cfg.codexPath) || ''),
    };
  }

  function currentToken() {
    return String(draftValue('token', (state.weixin && state.weixin.token) || cfg.token) || '').trim();
  }

  function weixinInput({ key, placeholder, type = 'text', mono = false, width = null }) {
    const value = String(draftValue(key, cfg[key]) || '');
    return el('input', {
      class: 'input' + (mono ? ' mono' : ''),
      type,
      value,
      placeholder,
      attrs: {
        'aria-label': placeholder,
        spellcheck: 'false',
        autocomplete: 'off',
        ...(width ? { style: `width:${width}` } : {}),
      },
      on: {
        input: (event) => {
          viewState.draft = { ...(viewState.draft || {}), [key]: event.target.value };
          paintStatus();
        },
      },
    });
  }

  // ---- 状态卡 ----
  const statusBadge = el('span', { class: 'chip', text: STATUS_LABEL[status.state] || status.state });
  const statusMessage = el('div', { class: 'setting-desc weixin-status-message', text: status.message || '微信连接未启动。' });
  const accountValue = el('code', { class: 'weixin-meta-value mono' });
  const processedValue = el('strong', { class: 'weixin-meta-value' });
  const lastPeerValue = el('code', { class: 'weixin-meta-value mono' });
  const actionBox = el('div', { class: 'weixin-actions' });

  function metaCell(label, value) {
    return el('div', { class: 'weixin-meta-cell' }, [
      el('span', { class: 'weixin-meta-label', text: label }),
      value,
    ]);
  }

  function buildActions() {
    const busy = viewState.busy;
    const token = currentToken();
    const running = RUNNING_STATES.has(status.state);
    const stopping = status.state === 'stopping';
    const saveBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      disabled: busy ? true : null,
      on: { click: () => void save() },
    }, [icon('check', 13), el('span', { text: viewState.busy ? '保存中…' : '保存' })]);
    const loginBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      disabled: busy || viewState.qrBusy ? true : null,
      on: { click: () => void qrLogin() },
    }, [icon('qr', 13), el('span', { text: viewState.qrBusy ? '生成中…' : (token ? '重新登录' : '扫码登录') })]);
    const powerBtn = running || stopping
      ? el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          disabled: busy || stopping ? true : null,
          on: { click: () => void stopConnect() },
        }, [icon('power', 13), el('span', { text: stopping ? '正在停止' : '停止' })])
      : el('button', {
          class: 'btn btn-accent btn-sm',
          type: 'button',
          disabled: busy || !token ? true : null,
          on: { click: () => void startConnect() },
        }, [icon('play', 13), el('span', { text: viewState.starting ? '启动中…' : '启动' })]);
    return [saveBtn, loginBtn, powerBtn];
  }

  function paintStatus() {
    status = { ...status, ...((state.weixin && state.weixin.status) || {}) };
    const liveCfg = { ...cfg, ...(state.weixin || {}) };
    statusBadge.textContent = STATUS_LABEL[status.state] || status.state || '已停止';
    statusBadge.className = 'chip '
      + (status.state === 'running' ? 'chip-ok' : status.state === 'stopped' ? '' : 'chip-warn');
    statusMessage.textContent = status.message || '微信连接未启动。';
    const account = status.accountId || liveCfg.accountId || '未登录';
    accountValue.textContent = account;
    accountValue.title = account;
    processedValue.textContent = String(Number(status.processedMessages) || 0);
    lastPeerValue.textContent = status.lastPeerId || '暂无';
    lastPeerValue.title = status.lastPeerId || '暂无';
    actionBox.replaceChildren(...buildActions());
  }

  const statusCard = el('section', { class: 'card weixin-status-card' }, [
    el('div', { class: 'card-body weixin-status-body' }, [
      el('div', { class: 'weixin-status-head' }, [
        el('div', { class: 'weixin-status-primary' }, [
          el('div', { class: 'weixin-status-icon' }, [icon('wechat', 20)]),
          el('div', { class: 'weixin-status-copy' }, [
            el('div', { class: 'weixin-status-title-row' }, [
              el('h2', { class: 'weixin-status-title', text: '个人微信连接' }),
              statusBadge,
            ]),
            statusMessage,
          ]),
        ]),
        actionBox,
      ]),
      el('div', { class: 'weixin-meta' }, [
        metaCell('账号', accountValue),
        metaCell('已处理消息', processedValue),
        metaCell('最近联系人', lastPeerValue),
      ]),
      el('div', {
        class: 'hint weixin-command-hint',
        text: '微信里发送「帮助」查看指令；发送「新对话」清空上下文。ChatGPT 任务开始/完成会即时通知，运行中每 5 分钟提醒一次。',
      }),
      el('div', {
        class: 'hint weixin-command-hint',
        text: '图片可直接发给 Codex；本次回合在工作目录内新生成或修改的图片会自动回传，最多 3 张（需要工作目录可写）。',
      }),
    ]),
  ]);

  // ---- 连接设置 ----
  const sectionTitle = (iconName, text) => el('div', { class: 'weixin-form-section-title' }, [
    icon(iconName, 14),
    el('strong', { text }),
  ]);

  const tokenRow = el('div', { class: 'weixin-input-row' }, [
    weixinInput({
      key: 'token',
      placeholder: '扫码后自动保存，也可粘贴已有 Bearer token',
      type: viewState.revealedToken ? 'text' : 'password',
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm weixin-icon-btn',
      type: 'button',
      title: viewState.revealedToken ? '隐藏凭据' : '显示凭据',
      attrs: { 'aria-label': viewState.revealedToken ? '隐藏凭据' : '显示凭据' },
      on: {
        click: () => {
          viewState.revealedToken = !viewState.revealedToken;
          ctx.renderCurrent(true, { preserveScrollTop: true });
        },
      },
    }, [icon(viewState.revealedToken ? 'eyeOff' : 'eye', 13)]),
  ]);

  const workDirRow = el('div', { class: 'weixin-path-row' }, [
    weixinInput({ key: 'workDir', placeholder: '留空使用当前用户主目录', mono: true }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: {
        click: async () => {
          try {
            const picked = await ctx.api.pickWeixinWorkDir();
            if (!picked) return;
            viewState.draft = { ...(viewState.draft || {}), workDir: picked };
            ctx.renderCurrent(true, { preserveScrollTop: true });
          } catch (err) {
            ctx.toastError(err, '选择工作目录失败');
          }
        },
      },
    }, [icon('folder', 13), el('span', { text: '选择' })]),
  ]);

  const codexPathRow = el('div', { class: 'weixin-path-row' }, [
    weixinInput({ key: 'codexPath', placeholder: '留空自动查找 Codex CLI', mono: true }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: {
        click: async () => {
          try {
            const found = await ctx.api.detectWeixinCodex();
            if (!found || !found.path) throw new Error('没有检测到 Codex CLI');
            viewState.draft = { ...(viewState.draft || {}), codexPath: found.path };
            ctx.toast(`已检测到 Codex CLI（${found.source}）`, 'ok');
            ctx.renderCurrent(true, { preserveScrollTop: true });
          } catch (err) {
            ctx.toastError(err, '自动检测 Codex CLI 失败');
          }
        },
      },
    }, [icon('search', 13), el('span', { text: '自动检测' })]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: {
        click: async () => {
          try {
            const picked = await ctx.api.pickWeixinCodex();
            if (!picked) return;
            viewState.draft = { ...(viewState.draft || {}), codexPath: picked };
            ctx.renderCurrent(true, { preserveScrollTop: true });
          } catch (err) {
            ctx.toastError(err, '选择 Codex CLI 失败');
          }
        },
      },
    }, [icon('folder', 13), el('span', { text: '选择' })]),
  ]);

  const sandboxSelect = el('select', {
    class: 'input',
    value: String(draftValue('sandbox', cfg.sandbox) || 'read-only'),
    attrs: { 'aria-label': '沙箱权限' },
    on: {
      change: (event) => {
        viewState.draft = { ...(viewState.draft || {}), sandbox: event.target.value };
      },
    },
  }, [
    el('option', { value: 'read-only', text: '只读' }),
    el('option', { value: 'workspace-write', text: '允许修改工作目录' }),
    el('option', { value: 'danger-full-access', text: '完全访问' }),
  ]);

  const settingsCard = el('section', { class: 'card weixin-settings-card' }, [
    el('header', { class: 'card-head' }, [
      icon('plug', 14),
      el('span', { class: 'card-title', text: '连接设置' }),
      el('span', { class: 'card-desc', text: '每个微信联系人会映射到独立的 Codex 会话。' }),
    ]),
    el('div', { class: 'card-body weixin-form' }, [
      el('section', { class: 'weixin-form-section' }, [
        sectionTitle('lock', '账号'),
        el('div', { class: 'weixin-form-fields' }, [
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: 'iLink API 地址' }),
            weixinInput({ key: 'baseUrl', placeholder: 'https://ilinkai.weixin.qq.com', mono: true }),
          ]),
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: '登录凭据' }),
            tokenRow,
          ]),
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: '允许的微信用户 ID（留空允许全部，多个用逗号分隔）' }),
            weixinInput({ key: 'allowFrom', placeholder: 'user@im.wechat', mono: true }),
          ]),
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: '账号标识' }),
            weixinInput({ key: 'accountId', placeholder: '扫码后自动填写', mono: true }),
          ]),
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: 'SKRouteTag' }),
            weixinInput({ key: 'routeTag', placeholder: '仅在网关要求时填写', mono: true }),
          ]),
        ]),
      ]),
      el('section', { class: 'weixin-form-section' }, [
        sectionTitle('message', '会话管理'),
        el('div', { class: 'weixin-form-fields' }, [
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: '工作目录' }),
            workDirRow,
          ]),
          el('div', { class: 'field-row' }, [
            el('div', { class: 'field' }, [
              el('div', { class: 'hint', text: '模型' }),
              weixinInput({ key: 'model', placeholder: '留空时使用 Codex 当前默认模型' }),
            ]),
            el('div', { class: 'field' }, [
              el('div', { class: 'hint', text: '沙箱权限' }),
              sandboxSelect,
            ]),
          ]),
        ]),
      ]),
      el('section', { class: 'weixin-form-section' }, [
        sectionTitle('code', 'Codex CLI'),
        el('div', { class: 'weixin-form-fields' }, [
          el('div', { class: 'field' }, [
            el('div', { class: 'hint', text: 'Codex CLI 路径' }),
            codexPathRow,
          ]),
        ]),
      ]),
      el('div', { class: 'weixin-actions weixin-save-row' }, [
        el('button', {
          class: 'btn btn-accent btn-sm',
          type: 'button',
          disabled: viewState.busy ? true : null,
          on: { click: () => void save() },
        }, [icon('check', 13), el('span', { text: viewState.busy ? '保存中…' : '保存设置' })]),
        el('span', { class: 'hint', text: '工作目录、模型与沙箱权限在重新启动连接后生效。' }),
      ]),
    ]),
  ]);

  // ---- 操作 ----
  async function persistDraft() {
    const draftAtStart = viewState.draft;
    if (!draftAtStart) return;
    const saved = await ctx.api.setWeixin(collect());
    state.weixin = saved;
    if (viewState.draft === draftAtStart) viewState.draft = null;
  }

  async function save() {
    if (viewState.busy) return;
    viewState.busy = true;
    paintStatus();
    const wasRunning = RUNNING_STATES.has(status.state);
    try {
      await persistDraft();
      ctx.toast(wasRunning ? '设置已保存；工作目录/模型/沙箱改动在重新启动后生效' : '微信连接设置已保存', 'ok');
    } catch (err) {
      ctx.toastError(err, '保存微信连接设置失败');
    } finally {
      viewState.busy = false;
      await ctx.reload('weixin', { preserveScrollTop: true });
    }
  }

  async function startConnect() {
    if (viewState.busy || viewState.starting) return;
    viewState.busy = true;
    viewState.starting = true;
    paintStatus();
    try {
      await persistDraft();
      const result = await ctx.api.startWeixin();
      if (result && result.status) {
        state.weixin = { ...(state.weixin || {}), status: result.status };
      }
      if (result && result.ok) ctx.toast('微信连接正在启动', 'ok');
      else ctx.toast((result && result.error) || '微信连接启动失败', 'error');
    } catch (err) {
      ctx.toastError(err, '启动微信连接失败');
    } finally {
      viewState.busy = false;
      viewState.starting = false;
      paintStatus();
    }
  }

  async function stopConnect() {
    if (viewState.busy || viewState.stopping) return;
    viewState.busy = true;
    viewState.stopping = true;
    paintStatus();
    try {
      const result = await ctx.api.stopWeixin();
      if (result && result.status) {
        state.weixin = { ...(state.weixin || {}), status: result.status };
      }
      ctx.toast('微信连接已停止', 'ok');
    } catch (err) {
      ctx.toastError(err, '停止微信连接失败');
    } finally {
      viewState.busy = false;
      viewState.stopping = false;
      paintStatus();
    }
  }

  async function refreshStatus() {
    try {
      const next = await ctx.api.getWeixinStatus();
      if (!next || typeof next !== 'object') return;
      state.weixin = { ...(state.weixin || {}), status: next };
      paintStatus();
    } catch (err) {
      ctx.logLocal?.('warn', `刷新微信连接状态失败: ${ctx.describeError(err)}`);
    }
  }

  // ---- 扫码登录 ----
  function openQrModal(qr) {
    stopQrPoll();
    const statusText = el('div', { class: 'weixin-qr-status', text: '等待扫码…' });
    const img = el('img', {
      class: 'weixin-qr-img',
      attrs: { src: qr.qrImage, alt: '微信登录二维码' },
    });
    const link = el('div', { class: 'weixin-qr-link mono', text: qr.qrContent || '' });
    const modal = ctx.openModal(
      el('section', { class: 'modal weixin-qr-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '微信扫码登录' } }, [
        el('header', { class: 'modal-head' }, [
          el('div', { class: 'modal-title', text: '微信扫码登录' }),
        ]),
        el('div', { class: 'modal-body weixin-qr-body' }, [
          statusText,
          img,
          link,
          el('div', { class: 'hint', text: '在手机微信中扫码并确认登录；登录成功后会自动保存凭据。' }),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: { click: () => { void ctx.api.openWeixinLink(qr.qrContent).catch((err) => ctx.toastError(err, '打开登录链接失败')); } },
          }, [icon('external', 13), el('span', { text: '打开登录链接' })]),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: { click: () => void ctx.copyText(qr.qrContent, '登录链接') },
          }, [icon('copy', 13), el('span', { text: '复制链接' })]),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: { click: () => ctx.closeModal() },
          }, [icon('x', 13), el('span', { text: '关闭' })]),
        ]),
      ]),
      { onClose: () => stopQrPoll() },
    );
    modal.classList.add('is-weixin-qr');

    const pollGeneration = qrPollGeneration;
    qrPollTimer = setInterval(async () => {
      if (pollGeneration !== qrPollGeneration || qrPollInFlight) return;
      qrPollInFlight = true;
      try {
        const next = await ctx.api.getWeixinQrStatus();
        if (pollGeneration !== qrPollGeneration) return;
        if (!next || !next.qrStatus) return;
        if (next.qrStatus === 'confirmed') {
          stopQrPoll();
          statusText.textContent = '✅ 微信扫码登录成功';
          ctx.closeModal();
          const wasRunning = RUNNING_STATES.has(status.state);
          viewState.draft = null;
          ctx.toast(wasRunning
            ? '微信扫码登录成功；请停止并重新启动连接以使用新凭据'
            : '微信扫码登录成功', 'ok');
          await ctx.reload('weixin', { preserveScrollTop: true });
          return;
        }
        if (next.qrStatus === 'scaned') {
          statusText.textContent = '已扫码，请在手机上点「确认登录」';
        } else if (next.qrStatus === 'expired') {
          stopQrPoll();
          statusText.textContent = '⚠ 二维码已过期，请关闭后重新登录';
        } else if (next.qrStatus === 'wait') {
          statusText.textContent = '等待扫码…';
        }
      } catch (err) {
        if (pollGeneration !== qrPollGeneration) return;
        stopQrPoll();
        statusText.textContent = `⚠ ${ctx.describeError(err)}`;
      } finally {
        if (pollGeneration === qrPollGeneration) qrPollInFlight = false;
      }
    }, 1500);
    if (typeof qrPollTimer === 'object' && qrPollTimer && typeof qrPollTimer.unref === 'function') qrPollTimer.unref();
  }

  async function qrLogin() {
    if (viewState.qrBusy || viewState.busy) return;
    viewState.qrBusy = true;
    paintStatus();
    try {
      const qr = await ctx.api.startWeixinQr({
        baseUrl: String(draftValue('baseUrl', cfg.baseUrl) || ''),
        routeTag: String(draftValue('routeTag', cfg.routeTag) || ''),
      });
      if (!qr || !qr.qrImage) throw new Error('二维码响应不完整');
      openQrModal(qr);
    } catch (err) {
      ctx.toastError(err, '获取微信登录二维码失败');
    } finally {
      viewState.qrBusy = false;
      paintStatus();
    }
  }

  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => ctx.navigate('plugins') },
    }, [icon('box', 13), el('span', { text: '返回插件市场' })]),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => void refreshStatus() },
    }, [icon('refresh', 13), el('span', { text: '刷新状态' })]),
  );

  root.replaceChildren(statusCard, settingsCard);
  paintStatus();

  if (statusTimer !== null) clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    if (state.view !== 'weixin') {
      clearInterval(statusTimer);
      statusTimer = null;
      return;
    }
    void refreshStatus();
  }, 2500);
  if (typeof statusTimer === 'object' && statusTimer && typeof statusTimer.unref === 'function') statusTimer.unref();
}
