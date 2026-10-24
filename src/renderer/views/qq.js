// QQ 远程助手页：经 NapCat(OneBot 11) 收发 QQ 消息，监控与远程控制 Codex 任务。
// 页面分四张卡：运行状态 / 一键安装（未装 NapCat 时） / 当前任务 / 连接配置 / NapCat 接入说明。

const viewState = {
  draft: null,       // 用户正在编辑的配置草稿（整页重渲染时保留）
  busy: false,
  testing: false,
  test: null,
  launching: false,
  installing: false,
  revealedToken: false,
};

// 任务卡轮询句柄：页面重渲染时先清旧的，切走视图后由下次进入再清。
let tasksTimer = null;

// 扫码弹窗的动态节点（进度事件重渲染页面时不重建弹窗，只更新内容）
let qrModal = null;

const QQ_DEFAULTS = {
  enabled: false,
  apiUrl: 'http://127.0.0.1:3000',
  accessToken: '',
  eventToken: '',
  notifyQq: '',
  ownerQq: '',
  progressMinutes: 5,
  codexPath: '',
  workspaceDir: '',
  autoLaunch: false,
  launchCommand: '',
  launchQq: '',
  launch: null,
  detectedLaunch: '',
  webhookUrl: '',
  gatewayRunning: false,
  codex: null,
  install: null,
};

const TASK_BADGE = { running: '▶️', done: '✅', failed: '❌', stopped: '🛑', stale: '💤' };
const TASK_LABEL = { running: '进行中', done: '已完成', failed: '失败', stopped: '已停止', stale: '已结束' };

// 一键安装各阶段的界面文案（与主进程 napcat-install.js 的 phase 对应）
const INSTALL_PHASE_LABEL = {
  prepare: '准备安装',
  'qq-check': '检测本机 QQ',
  'qq-download': '下载 QQ 安装包',
  'qq-install': '静默安装 QQ',
  'napcat-download': '下载 NapCat',
  extract: '解压 NapCat',
  configure: '写入配置',
  launch: '启动并登录',
  done: '安装完成',
  failed: '安装失败',
};

// 扫码弹窗里 loginPhase 的界面文案
const QR_LOGIN_LABEL = {
  quick_login: '正在快速登录之前用过的 QQ…',
  waiting_qrcode: '打开手机 QQ · 扫一扫，扫描下面的二维码',
  qrcode_scanned: '已扫码，请在手机上点「确认登录」',
  initializing: '已扫码并确认，正在初始化 QQ…',
  core_ready: 'QQ 已确认登录，正在连接 OneBot…',
};

function taskDuration(task, at = Date.now()) {
  const minutes = Math.max(0, Math.round(((task.endedAt || at) - task.startedAt) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分` : `${minutes} 分钟`;
}

/** 渲染 QQ 远程助手页 */
export function renderQq(root, ctx, actions) {
  const { el, icon, state } = ctx;
  const qq = { ...QQ_DEFAULTS, ...(state.qq || {}) };
  const codex = qq.codex || {};

  const draftValue = (key, fallback) => (viewState.draft && Object.prototype.hasOwnProperty.call(viewState.draft, key)
    ? viewState.draft[key]
    : fallback);

  function collect() {
    return {
      apiUrl: String(draftValue('apiUrl', qq.apiUrl) || ''),
      accessToken: String(draftValue('accessToken', qq.accessToken) || ''),
      eventToken: String(draftValue('eventToken', qq.eventToken) || ''),
      notifyQq: String(draftValue('notifyQq', qq.notifyQq) || ''),
      ownerQq: String(draftValue('ownerQq', qq.ownerQq) || ''),
      progressMinutes: Number(draftValue('progressMinutes', qq.progressMinutes)) || 5,
      codexPath: String(draftValue('codexPath', qq.codexPath) || ''),
      workspaceDir: String(draftValue('workspaceDir', qq.workspaceDir) || ''),
      launchCommand: String(draftValue('launchCommand', qq.launchCommand) || ''),
      launchQq: String(draftValue('launchQq', qq.launchQq) || ''),
      autoLaunch: draftValue('autoLaunch', qq.autoLaunch) === true,
    };
  }

  function qqInput({ key, placeholder, type = 'text', mono = true, width = null }) {
    const value = String(draftValue(key, qq[key]) || '');
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
        },
      },
    });
  }

  async function save(patch = {}) {
    if (viewState.busy) return;
    viewState.busy = true;
    ctx.renderCurrent(true, { preserveScrollTop: true });
    let launchAfterSave = false;
    try {
      state.qq = await ctx.api.setQqBot({ ...collect(), ...patch });
      viewState.draft = null;
      ctx.toast('QQ 远程助手设置已保存', 'ok');
      // 打开开关且配置了自动拉起：保存后立即拉起 NapCat（与主进程后台拉起去重合并）。
      launchAfterSave = patch.enabled === true
        && state.qq.enabled && state.qq.autoLaunch && !!state.qq.launchCommand;
    } catch (err) {
      ctx.toastError(err, '保存 QQ 远程助手设置失败');
    } finally {
      viewState.busy = false;
      await ctx.reload('qq', { preserveScrollTop: true });
    }
    if (launchAfterSave) void launchNapCat();
  }

  async function runTest() {
    if (viewState.testing) return;
    viewState.testing = true;
    ctx.renderCurrent(true, { preserveScrollTop: true });
    try {
      const result = await ctx.api.testQqBot();
      viewState.test = { ...result, at: Date.now() };
      if (result.api && result.api.ok && result.sent && result.sent.ok) {
        ctx.toast(`NapCat 已连接（${result.api.account || '未知账号'}），测试消息已发送`, 'ok');
      } else {
        const apiPart = result.api && result.api.ok ? 'NapCat 已连接' : 'NapCat 不可用：' + ((result.api && result.api.error) || '未知错误');
        const sentPart = result.sent && result.sent.ok ? '消息已发送' : '消息发送失败：' + ((result.sent && result.sent.error) || '未知错误');
        ctx.toast(`${apiPart}；${sentPart}`, 'error');
      }
    } catch (err) {
      viewState.test = { api: { ok: false, error: ctx.describeError(err) }, sent: { ok: false }, at: Date.now() };
      ctx.toastError(err, 'QQ 远程助手测试失败');
    } finally {
      viewState.testing = false;
      ctx.renderCurrent(true, { preserveScrollTop: true });
    }
  }

  /** 拉起 NapCat 并等待登录（快速登录不行就弹二维码窗扫码）；进度经安装事件流更新。 */
  async function launchNapCat() {
    if (viewState.launching) return;
    resetQrModalDismissed();
    viewState.launching = true;
    ctx.renderCurrent(true, { preserveScrollTop: true });
    try {
      if (viewState.draft) {
        state.qq = await ctx.api.setQqBot(collect());
        viewState.draft = null;
      }
      const result = await ctx.api.launchNapCat();
      if (result && result.phase === 'done') {
        ctx.toast(`NapCat 已就绪：${result.detail || '登录成功'}`, 'ok');
      } else {
        ctx.toast(`NapCat 拉起未完成：${(result && result.error) || '请扫码后重试'}`, 'error');
      }
    } catch (err) {
      ctx.toastError(err, '拉起 NapCat 失败');
    } finally {
      viewState.launching = false;
      await ctx.reload('qq', { preserveScrollTop: true });
    }
  }

  // ---- 当前任务（局部刷新，避免整页重渲染丢掉输入草稿） ----
  const tasksBox = el('div', { class: 'qq-task-list' });
  function taskRow(task) {
    const extra = [];
    if (task.model) extra.push(task.model);
    if (task.kind === 'exec' && task.cwd) extra.push(task.cwd);
    if (task.queued) extra.push(`待插入 ${task.queued} 条`);
    return el('div', { class: 'qq-task-row' }, [
      el('span', { class: 'qq-task-badge', text: TASK_BADGE[task.status] || '·' }),
      el('div', { class: 'qq-task-main' }, [
        el('div', { class: 'qq-task-meta' }, [
          el('span', { class: 'mono', text: task.id }),
          el('span', {
            class: 'chip' + (task.status === 'running' ? ' chip-accent' : ''),
            text: TASK_LABEL[task.status] || task.status,
          }),
          el('span', { class: 'hint', text: taskDuration(task) + (extra.length ? ' · ' + extra.join(' · ') : '') }),
        ]),
        el('div', { class: 'qq-task-title', text: task.title }),
        task.lastText ? el('div', { class: 'qq-task-text hint', text: '📝 ' + task.lastText }) : null,
        task.lastError ? el('div', { class: 'qq-task-text hint', text: '⚠ ' + task.lastError }) : null,
      ]),
    ]);
  }
  function renderTasks() {
    const tasks = state.tasks || { running: [], recent: [] };
    const rows = [];
    if (tasks.running && tasks.running.length) {
      rows.push(el('div', { class: 'hint', text: `进行中（${tasks.running.length}）` }));
      for (const task of tasks.running) rows.push(taskRow(task));
    } else {
      rows.push(el('div', { class: 'hint', text: '当前没有进行中的任务。Codex 桌面端的会话会出现在这里，QQ 里直接发消息则是在和模型对话。' }));
    }
    if (tasks.recent && tasks.recent.length) {
      rows.push(el('div', { class: 'hint qq-task-gap', text: '最近结束' }));
      for (const task of tasks.recent.slice(0, 8)) rows.push(taskRow(task));
    }
    tasksBox.replaceChildren(...rows);
  }
  async function refreshTasks() {
    try {
      state.tasks = await ctx.api.getTasks();
      state.loaded.tasks = true;
      renderTasks();
      // 兜底：拉起状态事件若丢失（渲染层重载等场景），8 秒轮询把芯片拉回主进程真实状态
      if (typeof ctx.api.getQqLaunchState === 'function') {
        const launch = await ctx.api.getQqLaunchState();
        const before = state.qq && state.qq.launch ? state.qq.launch.phase : '';
        state.qq = { ...(state.qq || {}), launch };
        if (launch.phase !== before && state.view === 'qq') {
          ctx.renderCurrent(false, { preserveScrollTop: true });
        }
      }
    } catch (err) {
      ctx.toastError(err, '任务列表读取失败');
    }
  }
  renderTasks();
  // 任务完成后卡片自动跟上（QQ 里收到 ✅ 但页面还挂着「进行中」的问题就出在这）。
  if (tasksTimer) clearInterval(tasksTimer);
  tasksTimer = setInterval(() => { void refreshTasks(); }, 8000);

  // ---- 一键安装（未装 NapCat 显示安装引导；已装显示就绪状态与重新安装；进行中/失败显示进度） ----
  const install = state.napcatInstall || qq.install || null;
  const napcatMissing = !String(qq.launchCommand || '') && !String(qq.detectedLaunch || '');
  const installActive = install && install.phase && install.phase !== 'idle'
    && install.phase !== 'done' && install.phase !== 'failed';
  const installFailed = install && install.phase === 'failed';
  const loginFailed = installFailed && !!(install.qrImage || install.loginPhase || /QQ 登录|QQ login/i.test(install.error || ''));
  const installBusy = installActive || viewState.installing || viewState.launching;
  // 登录流程（拉起按钮）也走同一状态机：进行中/失败时同样在这张卡上反馈

  async function startInstall() {
    if (viewState.installing) return;
    viewState.installing = true;
    resetQrModalDismissed();
    ctx.renderCurrent(true, { preserveScrollTop: true });
    try {
      state.napcatInstall = await ctx.api.installNapCat();
    } catch (err) {
      ctx.toastError(err, '一键安装启动失败');
    } finally {
      viewState.installing = false;
      await ctx.reload('qq', { preserveScrollTop: true });
    }
  }

  let qrDismissed = false;
  function resetQrModalDismissed() {
    qrDismissed = false;
  }

  // 扫码弹窗：二维码出现时自动打开；进度事件只更新弹窗内的文字与图片，不重建。
  function syncQrModal() {
    if (!install || !install.qrImage) return;
    if (install.phase === 'done' || install.phase === 'failed') {
      if (qrModal && qrModal.statusText) {
        qrModal.statusText.textContent = install.phase === 'failed'
          ? `⚠ ${install.error || '登录失败'}`
          : install.account
            ? `✅ ${install.detail || '登录成功'}`
            : install.detail || 'NapCat 已启动，尚未完成 QQ 登录';
      }
      return;
    }
    if (qrDismissed) return;
    if (qrModal && qrModal.url === install.qrImage) {
      if (qrModal.statusText) {
        qrModal.statusText.textContent = QR_LOGIN_LABEL[install.loginPhase]
          || install.detail
          || QR_LOGIN_LABEL.waiting_qrcode;
      }
      return;
    }
    const statusText = el('div', { class: 'qq-qr-status', text: QR_LOGIN_LABEL[install.loginPhase] || install.detail || QR_LOGIN_LABEL.waiting_qrcode });
    const img = el('img', { class: 'qq-qr-img', attrs: { src: install.qrImage, alt: 'QQ 登录二维码' } });
    const modal = ctx.openModal(
      el('section', { class: 'modal modal-qr', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'QQ 扫码登录' } }, [
        el('header', { class: 'modal-head' }, [
          el('div', { class: 'modal-title', text: 'QQ 扫码登录' }),
        ]),
        el('div', { class: 'modal-body qq-qr-body' }, [
          statusText,
          img,
          el('div', { class: 'hint', text: '扫码并确认后自动完成登录与配置；NapCat 在后台静默运行' }),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: { click: () => { qrDismissed = true; ctx.closeModal(); } },
          }, [icon('x', 13), el('span', { text: '稍后再说' })]),
        ]),
      ]),
      { onClose: () => { qrModal = null; } },
    );
    qrModal = { statusText, img, url: install.qrImage, node: modal };
  }
  syncQrModal();

  /** 就绪态 chip 文案与配色：跟随拉起阶段，避免「已就绪」和「拉起中」同时出现。 */
  function launchOnlineChip(cfg) {
    const phase = cfg.launch && cfg.launch.phase;
    if (phase === 'online') return `NapCat 在线${cfg.launch.account ? `（${cfg.launch.account}）` : ''}`;
    if (phase === 'launching') return 'NapCat 拉起中…';
    if (phase === 'failed') return 'NapCat 拉起失败';
    return 'NapCat 已就绪';
  }
  function launchOnlineChipClass(cfg) {
    const phase = cfg.launch && cfg.launch.phase;
    return phase === 'launching' || phase === 'failed' ? 'chip chip-warn' : 'chip chip-ok';
  }

  // 就绪且空闲时不占大卡：状态收进「运行状态」卡右上角；只有需要展示
  // 进度/失败/安装引导时才展开完整的「一键安装」卡。
  const showFullInstallCard = installBusy || installFailed || napcatMissing;
  const installCard = showFullInstallCard ? el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('download', 14),
      el('span', { class: 'card-title', text: '一键安装' }),
      el('span', {
        class: 'card-desc',
        text: napcatMissing
          ? '自动下载安装 QQ 与 NapCat、写好配置并拉起，全程只在本机'
          : 'NapCat 已安装配置；点「拉起 NapCat」登录（快速登录或弹窗扫码）',
      }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'qq-install' }, [
        el('div', { class: 'qq-install-head' }, [
          el('span', {
            class: 'chip ' + (installFailed ? 'chip-warn' : installBusy ? 'chip-accent' : launchOnlineChipClass(qq)),
            text: installFailed ? (loginFailed ? 'QQ 登录失败' : '安装失败')
              : installBusy ? (INSTALL_PHASE_LABEL[install && install.phase] || (viewState.launching ? '启动并登录' : '准备安装…'))
              : launchOnlineChip(qq),
          }),
          install && install.detail ? el('span', { class: 'hint', text: install.detail }) : null,
        ]),
        installBusy && install && install.phase !== 'launch' && install.phase !== 'failed'
          ? el('div', { class: 'qq-install-bar' }, [
              el('div', {
                class: 'qq-install-fill',
                attrs: { style: `width:${Math.max(3, install.percent || 0)}%` },
              }),
            ])
          : null,
        installFailed ? el('div', { class: 'hint qq-install-error', text: install.error || '未知错误' }) : null,
        el('div', { class: 'qq-actions' }, [
          el('button', {
            class: 'btn btn-sm ' + (installBusy || !napcatMissing ? 'btn-ghost' : 'btn-accent'),
            type: 'button',
            disabled: installBusy ? true : null,
            on: {
              click: () => {
                if (installFailed && !napcatMissing) void launchNapCat();
                else void startInstall();
              },
            },
          }, [
            icon(installFailed ? 'refresh' : 'download', 13),
            el('span', {
              text: installBusy
                ? (INSTALL_PHASE_LABEL[install && install.phase] || (viewState.launching ? '启动并登录中…' : '准备安装…'))
                : installFailed ? (loginFailed && !napcatMissing ? '重试 QQ 登录' : '重试一键安装')
                : napcatMissing ? '一键安装 QQ + NapCat'
                : '重新安装 NapCat',
            }),
          ]),
        ]),
        el('div', {
          class: 'hint',
          text: napcatMissing
            ? '需要 QQ 桌面版与 NapCat（开源、只在本机运行）。已装 QQ 时跳过；装 QQ 会弹一次系统确认(UAC)。首次登录在弹窗扫码，之后自动快速登录。'
            : `启动命令：${qq.launchCommand || qq.detectedLaunch || '（未配置）'}。重新安装会覆盖该目录下的 NapCat（不影响 QQ 与登录状态）`,
        }),
      ]),
    ]),
  ]) : null;

  // 就绪态的右上角小组件：挂在「运行状态」卡头部（状态 chip + 重新安装小按钮）
  const installHeadExtras = showFullInstallCard ? [] : [
    el('div', { class: 'qq-head-install' }, [
      el('span', { class: launchOnlineChipClass(qq), text: launchOnlineChip(qq) }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        on: { click: () => void startInstall() },
      }, [icon('refresh', 12), el('span', { text: '重新安装' })]),
    ]),
  ];

  // ---- 卡片 ----
  const testLine = viewState.test
    ? (viewState.test.api && viewState.test.api.ok
        ? `NapCat 已连接${viewState.test.api.account ? `（${viewState.test.api.account}${viewState.test.api.nickname ? ' · ' + viewState.test.api.nickname : ''}）` : ''}`
        : `NapCat 不可用：${(viewState.test.api && viewState.test.api.error) || '未知错误'}`)
      + (viewState.test.sent && viewState.test.sent.ok ? '；测试消息已发送' : `；测试消息未发送：${(viewState.test.sent && viewState.test.sent.error) || '未配置'}`)
    : null;
  const launch = qq.launch || null;
  const launchChip = launch && launch.phase === 'online'
    ? el('span', { class: 'chip chip-ok', text: `NapCat 在线${launch.account ? `（${launch.account}）` : ''}` })
    : launch && launch.phase === 'launching'
      ? el('span', { class: 'chip chip-warn', text: 'NapCat 拉起中…' })
      : launch && launch.phase === 'failed'
        ? el('span', { class: 'chip chip-warn', text: 'NapCat 拉起失败' })
        : null;
  const launchLine = launch && launch.phase === 'failed' && launch.error
    ? `NapCat 上次自动拉起未成功：${launch.error}`
    : null;

  const statusCard = el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('zap', 14),
      el('span', { class: 'card-title', text: '运行状态' }),
      el('span', { class: 'card-desc', text: '任务完成 / 失败 / 进度推送到 QQ，主人 QQ 私聊可远程控制' }),
      ...installHeadExtras,
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title' }, [
            el('span', { text: 'QQ 远程助手' }),
            el('span', { class: 'chip ' + (qq.enabled ? 'chip-ok' : ''), text: qq.enabled ? '已开启' : '未开启' }),
            el('span', { class: 'chip ' + (qq.gatewayRunning ? 'chip-ok' : 'chip-warn'), text: qq.gatewayRunning ? '网关运行中' : '网关未运行' }),
            el('span', { class: 'chip ' + (codex.path ? 'chip-ok' : 'chip-warn'), text: codex.path ? 'codex 已就绪' : 'codex 未检测到' }),
            launchChip,
          ]),
          el('div', {
            class: 'setting-desc',
            text: codex.path
              ? `codex 引擎：${codex.path}（来源 ${codex.source}）。g_ 任务来自 ChatGPT 桌面端会话（可查看/停止），e_ 任务由 QQ 命令创建（可插入、续跑、停止）。`
              : `未检测到可用的 codex.exe${codex.error ? '（' + codex.error + '）' : ''}，QQ 创建的新任务将无法运行，可在下方配置里手动指定路径。`,
          }),
          testLine ? el('div', { class: 'hint qq-test-line', text: testLine }) : null,
          launchLine ? el('div', { class: 'hint qq-test-line', text: launchLine }) : null,
        ]),
        el('div', { class: 'setting-ctl' }, [
          el('button', {
            class: 'switch',
            type: 'button',
            role: 'switch',
            disabled: viewState.busy ? true : null,
            attrs: { 'aria-checked': qq.enabled ? 'true' : 'false', 'aria-label': '启用 QQ 远程助手' },
            on: { click: () => void save({ enabled: !qq.enabled }) },
          }),
        ]),
      ]),
      el('div', { class: 'qq-actions' }, [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          disabled: viewState.launching ? true : null,
          on: { click: () => void launchNapCat() },
        }, [icon('power', 13), el('span', { text: viewState.launching ? '拉起中…' : '拉起 NapCat' })]),
        el('button', {
          class: 'btn btn-sm btn-accent',
          type: 'button',
          disabled: viewState.testing ? true : null,
          on: { click: () => void runTest() },
        }, [icon('zap', 13), el('span', { text: viewState.testing ? '测试中…' : '测试连接并发送消息' })]),
      ]),
    ]),
  ]);

  const tasksCard = el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('activity', 14),
      el('span', { class: 'card-title', text: '当前任务' }),
      el('span', { class: 'card-desc', text: '网关会话 + QQ 创建的 Codex 任务' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'qq-tasks-head' }, [
        el('span', { class: 'hint', text: 'QQ 里发送「任务」也能随时查看这份列表' }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => void refreshTasks() },
        }, [icon('refresh', 13), el('span', { text: '刷新' })]),
      ]),
      tasksBox,
    ]),
  ]);

  const configCard = el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('plug', 14),
      el('span', { class: 'card-title', text: '连接配置' }),
      el('span', { class: 'card-desc', text: 'NapCat 地址、令牌与通知对象' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: 'NapCat HTTP 服务地址' }),
          qqInput({ key: 'apiUrl', placeholder: 'http://127.0.0.1:3000' }),
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: 'NapCat 访问令牌（可留空）' }),
          qqInput({ key: 'accessToken', placeholder: 'NapCat token', type: viewState.revealedToken ? 'text' : 'password' }),
        ]),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: '通知 QQ（接收任务消息）' }),
          qqInput({ key: 'notifyQq', placeholder: '例如 10000', mono: false }),
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: '主人 QQ（只有它能发命令）' }),
          qqInput({ key: 'ownerQq', placeholder: '与通知 QQ 相同即可', mono: false }),
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: '进度间隔（分钟）' }),
          qqInput({ key: 'progressMinutes', placeholder: '5', type: 'number', width: '90px' }),
        ]),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: 'NapCat 启动命令（留空自动识别已安装的 NapCat）' }),
          qqInput({ key: 'launchCommand', placeholder: '留空自动识别，或填 C:\\NapCat\\launcher.bat' }),
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: '快速登录 QQ（登录过一次后自动免扫码）' }),
          qqInput({ key: 'launchQq', placeholder: '机器人 QQ 号（首次登录后自动填）' }),
        ]),
      ]),
      (!String(draftValue('launchCommand', qq.launchCommand) || '') && qq.detectedLaunch)
        ? el('div', { class: 'qq-webhook-row' }, [
            el('span', { class: 'mono qq-webhook-url', text: `检测到 NapCat：${qq.detectedLaunch}` }),
            el('button', {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              on: {
                click: () => {
                  viewState.draft = { ...(viewState.draft || {}), launchCommand: qq.detectedLaunch };
                  ctx.renderCurrent(true, { preserveScrollTop: true });
                },
              },
            }, [icon('check', 13), el('span', { text: '填入' })]),
          ])
        : null,
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-main' }, [
          el('div', { class: 'setting-title' }, [
            el('span', { text: '开启助手时自动拉起 NapCat' }),
          ]),
          el('div', {
            class: 'setting-desc',
            text: 'NapCat 离线时自动启动并快速登录：优先用上面填写的命令，留空则自动识别本机已安装的 NapCat（首次登录或凭据失效时会在应用内弹出二维码）；应用每次启动也会自动尝试拉起。',
          }),
        ]),
        el('div', { class: 'setting-ctl' }, [
          el('button', {
            class: 'switch',
            type: 'button',
            role: 'switch',
            attrs: {
              'aria-checked': draftValue('autoLaunch', qq.autoLaunch) === true ? 'true' : 'false',
              'aria-label': '开启助手时自动拉起 NapCat',
            },
            on: {
              click: () => {
                viewState.draft = {
                  ...(viewState.draft || {}),
                  autoLaunch: draftValue('autoLaunch', qq.autoLaunch) !== true,
                };
                ctx.renderCurrent(true, { preserveScrollTop: true });
              },
            },
          }),
        ]),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: 'codex.exe 路径（留空自动检测）' }),
          qqInput({ key: 'codexPath', placeholder: '自动检测 ChatGPT 内置 / npm / PATH' }),
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: '新任务默认工作目录（留空用主目录）' }),
          qqInput({ key: 'workspaceDir', placeholder: 'C:\\Users\\you\\projects' }),
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'hint', text: '上报校验令牌（可选，建议设置）' }),
          qqInput({ key: 'eventToken', placeholder: '填到 NapCat 上报配置', type: viewState.revealedToken ? 'text' : 'password' }),
        ]),
      ]),
      el('div', { class: 'qq-actions' }, [
        el('button', {
          class: 'btn btn-sm btn-accent',
          type: 'button',
          disabled: viewState.busy ? true : null,
          on: { click: () => void save() },
        }, [icon('check', 13), el('span', { text: viewState.busy ? '保存中…' : '保存设置' })]),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: {
            click: () => {
              viewState.revealedToken = !viewState.revealedToken;
              ctx.renderCurrent(true, { preserveScrollTop: true });
            },
          },
        }, [icon(viewState.revealedToken ? 'eyeOff' : 'eye', 13), el('span', { text: viewState.revealedToken ? '隐藏令牌' : '显示令牌' })]),
      ]),
    ]),
  ]);

  const setupCard = el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      icon('info', 14),
      el('span', { class: 'card-title', text: '接入步骤' }),
      el('span', { class: 'card-desc', text: '全部免费开源、只在本机运行，不需要服务器和公网' }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'field' }, [
        el('div', { class: 'hint', text: '事件上报地址（一键安装会自动写入 NapCat；自装其它框架时手动填到它的「HTTP POST 上报」）' }),
        el('div', { class: 'qq-webhook-row' }, [
          el('span', { class: 'mono qq-webhook-url', text: qq.webhookUrl || '启动网关后生成' }),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: { click: () => { if (qq.webhookUrl) void ctx.copyText(qq.webhookUrl, '上报地址'); } },
          }, [icon('copy', 13), el('span', { text: '复制' })]),
        ]),
      ]),
      el('div', { class: 'hint qq-setup' }, [
        '1) 点上方「一键安装」自动装好 QQ 桌面版 + NapCat 并写全配置（已装 QQ 的只装 NapCat；也可以自己安装任意 OneBot 11 框架，把服务地址与上报配置对齐即可）；',
        '2) 首次登录在弹出的二维码窗口扫码，之后自动快速登录、应用启动时自动拉起，不再需要手动操作；',
        '3) 安装完成回到本页点「测试连接并发送消息」验证；',
        '4) 用主人 QQ 私聊机器人：直接发消息就是和模型对话（多轮，发「新对话」重置），也可以直接发图片（可配文字）让模型识别；发「任务/状态/帮助」查看信息。机器人只通报 Codex 任务状态，不会创建或干预任务；',
      ].map((line) => el('div', { text: line }))),
    ]),
  ]);

  actions.replaceChildren(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => void refreshTasks() },
    }, [icon('refresh', 13), el('span', { text: '刷新任务' })]),
  );

  root.replaceChildren(statusCard, ...(installCard ? [installCard] : []), tasksCard, configCard, setupCard);
}
