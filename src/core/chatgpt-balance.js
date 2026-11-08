'use strict';

const { findChatGptDebugPort } = require('./chatgpt-launch.js');
const { findAvailablePort, listTargets, pickMainTarget, evaluate, addScriptOnNewDocument, removeScriptOnNewDocument } = require('./cdp.js');

const INJECT_TIMEOUT_MS = 15000;
const PAGE_SYNC_INTERVAL_MS = 350;
const COMMAND_TIMEOUT_MS = 5000;

function createDigitAnimationPlan(previous = {}, next = {}) {
  const previousInteger = String(previous.integer || '');
  const nextInteger = String(next.integer || '');
  const previousFraction = String(previous.fraction || '');
  const nextFraction = String(next.fraction || '');
  const integerChanges = [];
  for (let fromIndexFromRight = 0; fromIndexFromRight < nextInteger.length; fromIndexFromRight += 1) {
    const from = previousInteger[previousInteger.length - 1 - fromIndexFromRight] || '';
    const to = nextInteger[nextInteger.length - 1 - fromIndexFromRight];
    if (from !== to) integerChanges.push({ from, to, fromIndexFromRight });
  }
  const fractionChanges = [];
  for (let index = 0; index < nextFraction.length; index += 1) {
    const from = previousFraction[index] || '';
    const to = nextFraction[index];
    if (from !== to) fractionChanges.push({ from, to, index });
  }
  return { integerChanges, fractionChanges, changedCount: integerChanges.length + fractionChanges.length };
}

function formatBalanceAmount(value, currency, unit, locale = 'en-US') {
  const raw = String(value == null ? '' : value).trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return { text: String(unit || '') + raw, prefix: String(unit || ''), integer: '', fraction: '', decimal: '.', suffix: '' };
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const rounded = roundDecimalString(unsigned, 2);
  const [roundedWhole, fraction = ''] = rounded.split('.');
  const integer = roundedWhole.replace(/^0+(?=\d)/, '') || '0';
  const tiny = unsigned.includes('.') && /^0\.0+[1-9]/.test(unsigned) && rounded === '0';
  const isoCurrency = /^[A-Z]{3}$/.test(String(currency || '')) ? String(currency) : '';
  if (isoCurrency) {
    try {
      const template = new Intl.NumberFormat(locale, { style: 'currency', currency: isoCurrency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).formatToParts(1n);
      const firstInteger = template.findIndex((part) => part.type === 'integer');
      let lastInteger = -1;
      for (let i = 0; i < template.length; i += 1) if (template[i].type === 'integer') lastInteger = i;
      const prefix = template.slice(0, firstInteger).map((part) => part.value).join('');
      const suffix = template.slice(lastInteger + 1).map((part) => part.value).join('');
      const grouped = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }).format(BigInt(integer));
      const groupParts = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }).formatToParts(1000n);
      const group = groupParts.find((part) => part.type === 'group')?.value || ',';
      const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).formatToParts(1.1).find((part) => part.type === 'decimal')?.value || '.';
      const sign = negative ? '-' : '';
      const shownFraction = tiny ? '01' : fraction;
      const shownPrefix = tiny ? '<' + sign + prefix : sign + prefix;
      const text = `${shownPrefix}${tiny ? '0' : grouped}${shownFraction ? decimal + shownFraction : ''}${suffix}`;
      return { text, prefix: shownPrefix, integer: tiny ? '0' : grouped, integerDigits: tiny ? '0' : integer, group, decimal, fraction: shownFraction, suffix };
    } catch { /* unsupported currency falls through to the explicit unit */ }
  }
  const label = String(unit || '额度');
  const prefix = label === '额度' ? '' : label;
  const suffix = label === '额度' ? ' 额度' : '';
  const grouped = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }).format(BigInt(integer));
  const shownFraction = tiny ? '01' : fraction;
  const shownPrefix = tiny ? '<' + (negative ? '-' : '') + prefix : (negative ? '-' : '') + prefix;
  const text = `${shownPrefix}${tiny ? '0' : grouped}${shownFraction ? '.' + shownFraction : ''}${suffix}`;
  return { text, prefix: shownPrefix, integer: tiny ? '0' : grouped, integerDigits: tiny ? '0' : integer, group: '', decimal: '.', fraction: shownFraction, suffix };
}

/** 四舍五入到最多两位小数；只处理已校验的非负十进制字符串。 */
function roundDecimalString(value, maxFractionDigits) {
  const [whole, fraction = ''] = String(value).split('.');
  const keep = fraction.slice(0, maxFractionDigits);
  const next = fraction[maxFractionDigits] || '0';
  let digits = BigInt((whole || '0') + keep.padEnd(maxFractionDigits, '0'));
  if (next >= '5') digits += 1n;
  const scale = 10n ** BigInt(maxFractionDigits);
  const integer = digits / scale;
  const decimal = (digits % scale).toString().padStart(maxFractionDigits, '0').replace(/0+$/, '');
  return decimal ? `${integer}.${decimal}` : String(integer);
}

function computeBalanceRingProgress(snapshot = {}) {
  if (snapshot?.unlimited === true) return { percent: '100', level: 'normal' };
  const parse = (value) => {
    const text = String(value == null ? '' : value).trim();
    const match = text.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/);
    if (!match) return null;
    const fraction = match[3] || '';
    const coefficient = BigInt((match[2] + fraction).replace(/^0+(?=\d)/, '') || '0') * (match[1] ? -1n : 1n);
    return { coefficient, scale: fraction.length };
  };
  const used = parse(snapshot?.totalUsed);
  const balance = parse(snapshot?.balance);
  if (!balance || balance.coefficient < 0n) return { percent: null, level: 'normal' };
  if (snapshot?.totalUsedUnit && snapshot?.unit && String(snapshot.totalUsedUnit) !== String(snapshot.unit)) return { percent: null, level: 'normal' };
  if (!used || used.coefficient < 0n) return { percent: null, level: 'normal' };
  const scale = Math.max(used.scale, balance.scale);
  const usedAtScale = used.coefficient * (10n ** BigInt(scale - used.scale));
  const balanceAtScale = balance.coefficient * (10n ** BigInt(scale - balance.scale));
  const total = usedAtScale + balanceAtScale;
  if (total <= 0n) return { percent: null, level: 'normal' };
  const level = balanceAtScale * 20n < total ? 'danger' : balanceAtScale * 5n < total ? 'warning' : 'normal';
  const remainingAtScale = balanceAtScale > total ? total : balanceAtScale;
  const hundredths = (remainingAtScale * 10000n + total / 2n) / total;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return { percent: fraction ? `${whole}.${fraction}` : String(whole), level };
}

function buildBalanceIndicatorScript({ modelRoutes = [], readyWaitMs = INJECT_TIMEOUT_MS } = {}) {
  const routes = [];
  const seenSlugs = new Map();
  for (const raw of Array.isArray(modelRoutes) ? modelRoutes : []) {
    const slug = String(raw?.slug || '').trim();
    const providerId = String(raw?.providerId || '').trim();
    if (!slug || !providerId) continue;
    if (seenSlugs.has(slug) && seenSlugs.get(slug) !== providerId) {
      seenSlugs.set(slug, '');
      continue;
    }
    seenSlugs.set(slug, providerId);
    routes.push({ slug, providerId, providerName: String(raw?.providerName || '').trim().slice(0, 100) });
  }
  const mapping = [...seenSlugs].filter(([, providerId]) => providerId).map(([slug, providerId]) => {
    const route = routes.find((entry) => entry.slug === slug && entry.providerId === providerId);
    return { slug, providerId, providerName: route?.providerName || '' };
  });
  const mappingJson = JSON.stringify(mapping);
  const safeReadyWait = Math.max(500, Math.min(30000, Number(readyWaitMs) || INJECT_TIMEOUT_MS));
  const animationPlanSource = createDigitAnimationPlan.toString();
  const roundDecimalSource = roundDecimalString.toString();
  const ringProgressSource = computeBalanceRingProgress.toString();
  const formatSource = formatBalanceAmount.toString();
  return `(() => {
  const ROUTES = ${mappingJson};
  const READY_WAIT_MS = ${safeReadyWait};
  const SYNC_INTERVAL_MS = ${PAGE_SYNC_INTERVAL_MS};
  const ID = 'gptplus-balance-indicator';
  const STYLE_ID = 'gptplus-balance-indicator-style';
  const EXT_ATTR = 'data-gptplus-balance-indicator';
  const RUNTIME_KEY = 'gptplus-balance-indicator-v2';
  const POSITION_KEY = 'gptplus-balance-indicator-position-v1';
  const CACHE_KEY = 'gptplus-balance-last-value-v1';
  const STYLE = ${JSON.stringify(`
    #gptplus-balance-indicator-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:inherit;color:var(--text-primary,#1f1f1f);contain:layout style}
    #gptplus-balance-indicator{--gpb-ring-color:#15803d;--gpb-progress:0%;position:fixed;width:44px;height:44px;border:0;border-radius:50%;background:transparent;box-shadow:none;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:grab;padding:2px;box-sizing:border-box;touch-action:none;user-select:none}
    #gptplus-balance-indicator[data-level="warning"]{--gpb-ring-color:#ca8a04}
    #gptplus-balance-indicator[data-level="danger"],#gptplus-balance-indicator[data-state="error"]{--gpb-ring-color:#d92d20}
    #gptplus-balance-indicator[data-dragging="true"]{cursor:grabbing}
    #gptplus-balance-indicator[data-state="error"]{color:#d92d20} #gptplus-balance-indicator[data-state="loading"]{opacity:.65}
    #gptplus-balance-indicator .gpb-ring{position:absolute;inset:0;width:100%;height:100%;border-radius:50%;pointer-events:none;background:conic-gradient(from -90deg,var(--gpb-ring-color) 0% var(--gpb-progress),color-mix(in srgb,var(--gpb-ring-color) 16%,transparent) var(--gpb-progress) 100%);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 5px),#000 calc(100% - 4px));mask:radial-gradient(farthest-side,transparent calc(100% - 5px),#000 calc(100% - 4px));transition:background .22s ease}
    #gptplus-balance-indicator-value{font-size:9px;line-height:1.05;text-align:center;max-width:38px;max-height:36px;overflow:hidden;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
    #gptplus-balance-indicator-value[data-error="true"]{font-size:23px;font-weight:700;color:#d92d20}
    #gptplus-balance-indicator-toast{position:fixed;pointer-events:none;box-sizing:border-box;color:#d92d20;font-size:12px;font-weight:600;max-width:calc(100vw - 16px);white-space:nowrap;overflow-wrap:normal;text-align:center;background:var(--background-primary,#fff);border-radius:8px;padding:3px 7px;box-shadow:0 1px 6px #0002;opacity:0;transition:opacity .18s ease;z-index:2147483001}
    #gptplus-balance-indicator-toast[data-visible="true"]{opacity:1}
    #gptplus-balance-indicator-details{position:fixed;pointer-events:auto;min-width:190px;max-width:min(300px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:12px;border:1px solid var(--border-subtle,#ddd);border-radius:12px;background:var(--background-primary,#fff);box-shadow:0 5px 20px #0003;font-size:12px;line-height:1.5;display:none;z-index:2147483002}
    #gptplus-balance-indicator-details[data-open="true"]{display:block} #gptplus-balance-indicator-details button{margin-top:8px;cursor:pointer}
    #gptplus-balance-indicator-details .gpb-detail-row{display:flex;justify-content:space-between;gap:16px;padding:1px 0} #gptplus-balance-indicator-details .gpb-detail-row span:first-child{opacity:.7}
    #gptplus-balance-indicator-amount{display:inline-flex;white-space:nowrap;font-variant-numeric:tabular-nums;align-items:baseline}
    #gptplus-balance-indicator-amount .gpb-static{display:inline-block}
    #gptplus-balance-indicator-amount .gpb-track{display:inline-block;position:relative;overflow:hidden;height:1.05em;vertical-align:baseline;line-height:1.05em}
    #gptplus-balance-indicator-amount .gpb-track span{display:block;line-height:1.05em}
    #gptplus-balance-indicator-amount .gpb-track[data-animate="true"] .gpb-old{animation:gpb-out .4s ease both}
    #gptplus-balance-indicator-amount .gpb-track[data-animate="true"] .gpb-new{animation:gpb-in .4s ease both}
    @keyframes gpb-out{to{transform:translateY(-110%);opacity:0}}
    @keyframes gpb-in{from{transform:translateY(110%);opacity:0}to{transform:translateY(0);opacity:1}}
    @media(prefers-reduced-motion:reduce){#gptplus-balance-indicator-toast,#gptplus-balance-indicator .gpb-ring{transition:none}#gptplus-balance-indicator-amount .gpb-track .gpb-old,#gptplus-balance-indicator-amount .gpb-track .gpb-new{animation:none!important}}
  `)};
  const createDigitAnimationPlan = ${animationPlanSource};
  const roundDecimalString = ${roundDecimalSource};
  const computeBalanceRingProgress = ${ringProgressSource};
  const formatBalanceAmount = ${formatSource};
  if (globalThis.__gptplusBalanceRuntime === RUNTIME_KEY && globalThis.__gptplusBalance) return { ok:true,installed:true,reused:true };
  globalThis.__gptplusBalance?.dispose?.();
  globalThis.__gptplusBalanceRuntime = RUNTIME_KEY;
  const restoredBalanceCache = restoreBalanceCache();
  const state = { root:null, ring:null, value:null, toast:null, details:null, snapshot:null, current:null, previousParts:null, providerSnapshots:restoredBalanceCache.providers, lastSnapshot:restoredBalanceCache.last, providerStatuses:{}, providerList:[], disposed:false, timer:0, toastTimer:0, observer:null, resizeObserver:null, manualRefresh:0, position:loadPosition(), drag:null, suppressClick:false };

  function visible(node) { if (!node || !node.isConnected || !node.getClientRects?.().length) return false; const style=getComputedStyle(node); const rect=node.getBoundingClientRect(); return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0; }
  function reactModelSlugs(node) {
    if (!node) return [];
    const key=Object.keys(node).find((name)=>name.startsWith('__reactFiber$'));
    let fiber=key?node[key]:null; const slugs=new Set(); let depth=0;
    while(fiber&&depth++<32){
      const model=fiber.memoizedProps?.model;
      if(typeof model==='string'&&/^[^\s]+__.+$/.test(model))slugs.add(model);
      fiber=fiber.return;
    }
    return [...slugs];
  }
  function readModelSlug() {
    const labels=[...document.querySelectorAll('[class*=ModelPickerTriggerModelText]')].filter(visible);
    const active=labels.filter((label)=>{const surface=label.closest?.('[data-composer-surface-variant]');return surface&&[...surface.querySelectorAll('.ProseMirror[contenteditable="true"],textarea:not(:disabled):not([readonly]),[role="textbox"][contenteditable="true"]')].some(visible);});
    const selected=active.length?active:labels;
    const slugs=new Set();
    for(const label of selected){for(const slug of reactModelSlugs(label)){slugs.add(slug);}}
    return slugs.size===1?[...slugs][0]:'';
  }
  function resolveCurrent() {
    const slug=readModelSlug();
    if(!slug)return {modelSlug:'',providerId:'',providerName:'',reason:'无法识别当前模型'};
    const matches=ROUTES.filter((route)=>route.slug===slug);
    if(matches.length!==1)return {modelSlug:slug,providerId:'',providerName:'',reason:'当前模型没有关联的中转站'};
    return {modelSlug:slug,providerId:matches[0].providerId,providerName:matches[0].providerName,reason:''};
  }
  function anchorNode() {
    const rail=document.querySelector('[data-app-navigation-rail]');
    const buttonSelector='button,[role="button"]';
    const scope=rail?[rail,...rail.querySelectorAll(buttonSelector)]:[...document.querySelectorAll(buttonSelector)];
    const find=(pattern)=>scope.find((node)=>pattern.test(String(node.getAttribute('aria-label')||node.getAttribute('title')||'')));
    return find(/profile menu|个人资料菜单/i)||find(/settings|设置/i)||null;
  }
  function setFixed(node,left,top){node.style.position='fixed';node.style.left=Math.round(left)+'px';node.style.top=Math.round(top)+'px';}
  function clamp(value,min,max){return Math.max(min,Math.min(max,value));}
  function viewportBounds(){const vp=globalThis.visualViewport;return {left:(vp?.offsetLeft||0)+8,right:(vp?.offsetLeft||0)+(vp?.width||innerWidth)-8,top:(vp?.offsetTop||0)+8,bottom:(vp?.offsetTop||0)+(vp?.height||innerHeight)-8};}
  function loadPosition(){try{const raw=globalThis.localStorage?.getItem(POSITION_KEY);if(!raw)return null;const saved=JSON.parse(raw);const left=Number(saved?.left);const top=Number(saved?.top);return Number.isFinite(left)&&Number.isFinite(top)?{left,top}:null;}catch{return null;}}
  function savePosition(left,top){try{globalThis.localStorage?.setItem(POSITION_KEY,JSON.stringify({left:Math.round(left),top:Math.round(top)}));}catch{}}
  function clearPosition(){try{globalThis.localStorage?.removeItem(POSITION_KEY);}catch{}}
  function defaultPosition(){const anchor=anchorNode();if(!anchor)return null;const rect=anchor.getBoundingClientRect();const bounds=viewportBounds();const width=44;return {left:clamp(rect.left+(rect.width-width)/2,bounds.left,Math.max(bounds.left,bounds.right-width)),top:clamp(rect.top-width-8,bounds.top,Math.max(bounds.top,bounds.bottom-width))};}
  function positionRing(){const bounds=viewportBounds();const width=44;if(state.drag)return;if(state.position){const left=clamp(state.position.left,bounds.left,Math.max(bounds.left,bounds.right-width));const top=clamp(state.position.top,bounds.top,Math.max(bounds.top,bounds.bottom-width));setFixed(state.ring,left,top);state.position={left,top};return;}const fallback=defaultPosition();if(!fallback){state.ring.style.display='none';return;}setFixed(state.ring,fallback.left,fallback.top);}
  function updatePosition() {
    if(!state.ring||!state.root)return;
    const anchor=anchorNode(); if(!anchor&&!state.position){state.ring.style.display='none';return;}
    state.ring.style.display='flex';
    positionRing();
    state.resizeObserver?.disconnect(); if(anchor&&state.resizeObserver)state.resizeObserver.observe(anchor);
    if(state.toast?.dataset.visible==='true')positionToast();
    if(state.details?.dataset.open==='true')positionDetails();
  }
  function currencyTokens(parts) {
    const isCurrency=/^[A-Z]{3}$/.test(String(parts.currency||''));
    if(!isCurrency)return {prefix:parts.prefix||'',suffix:parts.suffix||'',group:parts.group||'',decimal:parts.decimal||'.'};
    return {prefix:parts.prefix||'',suffix:parts.suffix||'',group:parts.group||',',decimal:parts.decimal||'.'};
  }
  function staticNode(text){const node=document.createElement('span');node.className='gpb-static';node.textContent=text;return node;}
  function animatedDigit(from,to,animate){
    if(!animate||!from)return staticNode(to);
    const track=document.createElement('span');track.className='gpb-track';track.dataset.animate=String(!(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true));
    const old=document.createElement('span');old.className='gpb-old';old.textContent=from;
    const next=document.createElement('span');next.className='gpb-new';next.textContent=to;track.appendChild(old);track.appendChild(next);return track;
  }
  function groupedDigits(container,formatted,rawDigits,changes,kind){
    let digitFromLeft=0; const rawLength=rawDigits.length;
    for(const char of formatted){
      if(/[0-9]/.test(char)){
        const fromIndexFromRight=rawLength-1-digitFromLeft;
        const index=digitFromLeft;
        const change=kind==='integer'?changes.find((entry)=>entry.fromIndexFromRight===fromIndexFromRight):changes.find((entry)=>entry.index===index);
        container.appendChild(change?animatedDigit(change.from,change.to,true):staticNode(char)); digitFromLeft++;
      }else container.appendChild(staticNode(char));
    }
  }
  function makeDisplayParts(value,currency,unit){
    return formatBalanceAmount(value,currency,unit,document.documentElement?.lang||navigator.language||'en-US');
  }
  function renderAmount(snapshot){
    state.value.replaceChildren(); state.value.removeAttribute('data-error');
    if(snapshot.status==='loading'){state.value.textContent='…';return;}
    if(snapshot.status==='error'||snapshot.status==='unmapped'||snapshot.status==='unknown'||snapshot.balance==null&&!snapshot.unlimited){state.value.textContent='!';state.value.dataset.error='true';return;}
    if(snapshot.unlimited){state.value.textContent='∞';state.value.setAttribute('aria-label','不限额');return;}
    const parts=makeDisplayParts(snapshot.balance,snapshot.currency,snapshot.unit);
    const old=state.previousParts;
    const plan=createDigitAnimationPlan(old?{integer:old.integerDigits,fraction:old.fraction}:{},{integer:parts.integerDigits||'',fraction:parts.fraction||''});
    state.value.appendChild(staticNode(parts.prefix||''));
    groupedDigits(state.value,parts.integer||'',parts.integerDigits||'',plan.integerChanges,'integer');
    if(parts.fraction){state.value.appendChild(staticNode(parts.decimal||'.'));groupedDigits(state.value,parts.fraction,parts.fraction,plan.fractionChanges,'fraction');}
    state.value.appendChild(staticNode(parts.suffix||''));
    state.previousParts=parts;
    if(snapshot.currency&&/^[A-Z]{3}$/.test(snapshot.currency))state.value.setAttribute('aria-label',parts.text);
  }
  function renderCurrencyAmount(value,currency,unit){return renderAmount({balance:value,currency,unit,ok:true});}
  function renderDetails(){
    if(!state.details)return; state.details.replaceChildren();
    const current=state.current||{};
    const live=state.snapshot&&state.snapshot.providerId===current.providerId?state.snapshot:null;
    const cached=(!live||live.ok===false)?lastSnapshot(current.providerId):null;
    const snapshot=cached||live;
    const providerName=current.providerName||snapshot?.providerName||(state.providerList.find((item)=>String(item.providerId)===String(current.providerId))?.name)||'中转站余额';
    const title=document.createElement('strong');title.textContent=providerName;state.details.appendChild(title);
    const addRow=(label,value)=>{const row=document.createElement('div');row.className='gpb-detail-row';const name=document.createElement('span');name.textContent=label;const text=document.createElement('span');text.textContent=value;row.appendChild(name);row.appendChild(text);state.details.appendChild(row);return text;};
    const balanceText=snapshot?.unlimited?'不限额':snapshot?.balance!=null?makeDisplayParts(snapshot.balance,snapshot.currency,snapshot.unit).text:current.reason||'等待余额刷新';
    addRow('余额',balanceText);
    addRow('消耗值',snapshot?.totalUsed!=null?makeDisplayParts(snapshot.totalUsed,snapshot.currency,snapshot.unit).text:'暂无');
    addRow('最近一次消耗量',snapshot?.delta!=null?makeDisplayParts(snapshot.delta,snapshot.currency,snapshot.unit).text:'暂无');
    if(snapshot?.ok===false){const failure=document.createElement('div');failure.textContent=snapshot.error||current.reason||'刷新失败';failure.style.marginTop='4px';failure.style.color='#d92d20';state.details.appendChild(failure);}
    if(cached){const stale=document.createElement('div');stale.textContent='显示上一次读取值';stale.style.marginTop='4px';state.details.appendChild(stale);}
    if(cached&&live?.ok===false){const failure=document.createElement('div');failure.textContent='本次刷新失败：'+(live.error||'未知错误');failure.style.marginTop='4px';failure.style.color='#d92d20';state.details.appendChild(failure);}
    if(snapshot?.at){const time=document.createElement('div');time.textContent=(cached?'上次读取于 ':'更新于 ')+new Date(snapshot.at).toLocaleTimeString();state.details.appendChild(time);}
    if(state.providerList.length){
      const list=document.createElement('div');list.setAttribute('aria-label','已配置提供商余额');list.style.marginTop='8px';
      for(const provider of state.providerList){
        const row=document.createElement('div');row.style.display='flex';row.style.justifyContent='space-between';row.style.gap='12px';
        const name=document.createElement('span');name.textContent=provider.name||provider.providerId;
        const value=document.createElement('span');const cached=state.providerSnapshots[provider.providerId];const status=state.providerStatuses[provider.providerId];
        value.textContent=cached?.unlimited?'不限额':cached?.balance!=null?makeDisplayParts(cached.balance,cached.currency,cached.unit).text:status?.error||'尚未查询';
        row.appendChild(name);row.appendChild(value);list.appendChild(row);
      }
      state.details.appendChild(list);
    }
    const refresh=document.createElement('button');refresh.type='button';refresh.textContent='刷新';refresh.addEventListener('click',(event)=>{event.stopPropagation();state.manualRefresh+=1;});state.details.appendChild(refresh);
    positionDetails();
  }
  function positionDetails(){
    if(!state.details||!state.ring)return;const ring=state.ring.getBoundingClientRect();
    state.details.style.display='block'; const measured=state.details.getBoundingClientRect();const vp=globalThis.visualViewport;
    const leftEdge=(vp?.offsetLeft||0)+8;const rightEdge=(vp?.offsetLeft||0)+(vp?.width||innerWidth)-8;
    const topEdge=(vp?.offsetTop||0)+8;const bottomEdge=(vp?.offsetTop||0)+(vp?.height||innerHeight)-8;
    const width=Math.min(measured.width||220,rightEdge-leftEdge);const height=Math.min(measured.height||120,bottomEdge-topEdge);
    let left=ring.right+8;if(left+width>rightEdge)left=ring.left-width-8;left=clamp(left,leftEdge,Math.max(leftEdge,rightEdge-width));
    const top=clamp(ring.top+ring.height/2-height/2,topEdge,Math.max(topEdge,bottomEdge-height));
    setFixed(state.details,left,top);
  }
  function positionToast(){
    if(!state.toast||state.toast.dataset.visible!=='true'||!state.ring)return;
    const ring=state.ring.getBoundingClientRect();state.toast.style.display='block';
    const vp=globalThis.visualViewport;const leftEdge=(vp?.offsetLeft||0)+8;const rightEdge=(vp?.offsetLeft||0)+(vp?.width||innerWidth)-8;const topEdge=(vp?.offsetTop||0)+8;const bottomEdge=(vp?.offsetTop||0)+(vp?.height||innerHeight)-8;
    state.toast.style.maxWidth=(rightEdge-leftEdge)+'px';
    const width=state.toast.getBoundingClientRect().width||Math.max(48,state.toast.textContent.length*7);
    const left=clamp(ring.left+(ring.width-width)/2,leftEdge,Math.max(leftEdge,rightEdge-width));
    const height=state.toast.getBoundingClientRect().height||24;const top=clamp(ring.top-height-6,topEdge,Math.max(topEdge,bottomEdge-height));
    setFixed(state.toast,left,top);
  }
  function showToast(snapshot){
    if(!snapshot||snapshot.delta==null||!['cumulative','net-balance-change'].includes(snapshot.deltaKind))return;
    const amount=makeDisplayParts(snapshot.delta,snapshot.currency,snapshot.unit);
    state.toast.textContent='-'+amount.text.replace(/^-/, '');state.toast.dataset.visible='true';positionToast();
    clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>{state.toast.dataset.visible='false';setTimeout(()=>{if(state.toast?.dataset.visible==='false')state.toast.style.display='none';},200);},2000);
  }
  function balanceCacheValue(value,providerId){
    if(!value||typeof value!=='object'||value.ok===false)return null;
    const id=String(providerId||value.providerId||'').trim();
    const balance=value.balance==null?null:String(value.balance).trim();
    const unlimited=value.unlimited===true;
    if((balance==null||balance==='')&&!unlimited)return null;
    const at=Number(value.at);
    const providerName=String(value.providerName||'').trim().slice(0,100);
    const totalUsed=value.totalUsed==null?null:String(value.totalUsed).trim();
    const delta=value.delta==null?null:String(value.delta).trim();
    const totalUsedUnit=String(value.totalUsedUnit||'').trim().slice(0,20);
    const deltaKind=String(value.deltaKind||'').trim().slice(0,30);
    return {providerId:id,...(providerName?{providerName}:{}),...(value.adapter?{adapter:String(value.adapter)}:{}),...(balance?{balance}:{}),...(value.currency?{currency:String(value.currency)}:{}),...(value.unit?{unit:String(value.unit)}:{}),...(totalUsed?{totalUsed}:{}),...(totalUsedUnit?{totalUsedUnit}:{}),...(delta?{delta}:{}),...(deltaKind?{deltaKind}:{}),...(unlimited?{unlimited:true}:{}),...(Number.isFinite(at)?{at}:{})};
  }
  function restoreBalanceCache(){
    try{
      const parsed=JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY)||'null');
      const providers={};
      const saved=parsed?.providers&&typeof parsed.providers==='object'?parsed.providers:{};
      for(const [id,value] of Object.entries(saved)){const safe=balanceCacheValue(value,id);if(safe)providers[safe.providerId||id]=safe;}
      return {providers,last:balanceCacheValue(parsed?.last)};
    }catch{return {providers:{},last:null};}
  }
  function persistBalanceCache(){
    try{
      const providers={};
      for(const [id,value] of Object.entries(state.providerSnapshots||{}).slice(-20)){const safe=balanceCacheValue(value,id);if(safe)providers[safe.providerId||id]=safe;}
      globalThis.localStorage?.setItem(CACHE_KEY,JSON.stringify({providers,last:state.lastSnapshot||null}));
    }catch{}
  }
  function rememberSnapshot(value){
    const safe=balanceCacheValue(value,value?.providerId);
    if(!safe)return null;
    state.providerSnapshots={...(state.providerSnapshots||{}),[safe.providerId||'']:safe};
    state.lastSnapshot=safe;
    persistBalanceCache();
    return safe;
  }
  function lastSnapshot(providerId){
    const id=String(providerId||'').trim();
    const cached=id?(state.providerSnapshots||{})[id]:state.lastSnapshot;
    if(!cached)return null;
    return {...cached,providerId:cached.providerId||id,ok:true,delta:null,deltaKind:'baseline',stale:true};
  }
  function render(){
    if(!state.ring?.isConnected)return;const current=state.current||{};const live=state.snapshot&&state.snapshot.providerId===current.providerId?state.snapshot:null;
    const cached=(!live||live.ok===false)?lastSnapshot(current.providerId):null;
    const shown=cached||live;
    const error=!shown||shown.ok===false;
    const progress=computeBalanceRingProgress(shown||{});
    state.ring.dataset.state=error?'error':shown?'ready':'loading';
    state.ring.dataset.stale=String(Boolean(cached));
    state.ring.dataset.level=error?'danger':progress.level;
    if(state.ring.style?.setProperty)state.ring.style.setProperty('--gpb-progress',(progress.percent||'0')+'%');else state.ring.style['--gpb-progress']=(progress.percent||'0')+'%';
    state.value.setAttribute('aria-hidden','false');
    const percentText=progress.percent==null?'':'，剩余 '+progress.percent+'%';
    state.ring.setAttribute('aria-label',error?(live?.error||current.reason||'未关联余额提供商'):cached?'显示上一次读取的中转站余额 '+(shown?.balance??(shown?.unlimited?'不限额':''))+percentText:'中转站剩余 '+(shown?.balance??(shown?.unlimited?'不限额':''))+percentText);
    if(!shown){renderAmount({status:current.providerId&&live?.ok===false?'error':current.providerId?'loading':'unmapped'});}
    else renderAmount(shown);
    if(state.details?.dataset.open==='true')renderDetails();
    updatePosition();
  }
  function syncContext(){
    if(state.disposed)return null;
    const next=resolveCurrent();
    const changed=next.modelSlug!==(state.current?.modelSlug||'')||next.providerId!==(state.current?.providerId||'')||next.reason!==(state.current?.reason||'');
    if(changed){state.current=next;state.snapshot=null;state.previousParts=null;clearTimeout(state.toastTimer);state.toastTimer=0;if(state.toast){state.toast.dataset.visible='false';state.toast.style.display='none';}render();}
    else if(!state.current){state.current=next;render();}
    return {modelSlug:state.current?.modelSlug||'',providerId:state.current?.providerId||'',providerName:state.current?.providerName||'',reason:state.current?.reason||'',manualRefresh:state.manualRefresh,detailsOpen:state.details?.dataset.open==='true',mounted:!!state.root?.isConnected};
  }
  function apply(snapshot){
    if(state.disposed||!snapshot||typeof snapshot!=='object')return false;
    syncContext();
    if(String(snapshot.currentProviderId||snapshot.providerId||'')!==String(state.current?.providerId||''))return false;
    const incoming=snapshot.providerSnapshots&&typeof snapshot.providerSnapshots==='object'?snapshot.providerSnapshots:{};
    const merged={};for(const [id,value] of Object.entries(incoming)){const safe=balanceCacheValue(value,id);if(safe)merged[safe.providerId||id]=safe;}
    state.providerSnapshots={...(state.providerSnapshots||{}),...merged};
    state.providerStatuses=snapshot.providerStatuses&&typeof snapshot.providerStatuses==='object'?snapshot.providerStatuses:{};
    if(Array.isArray(snapshot.providerList))state.providerList=snapshot.providerList;
    if(String(snapshot.providerId||'')===String(state.current?.providerId||'')){const previousAt=state.snapshot?.at;state.snapshot={...snapshot};if(snapshot.ok!==false)rememberSnapshot({...snapshot,providerName:state.current?.providerName||snapshot.providerName});render();if(String(previousAt||'')!==String(snapshot.at||''))showToast(snapshot);}
    else if(state.details?.dataset.open==='true')renderDetails();
    return true;
  }
  function install(){
    document.getElementById(STYLE_ID)?.remove();const style=document.createElement('style');style.id=STYLE_ID;style.setAttribute(EXT_ATTR,'true');style.textContent=STYLE;document.head?.appendChild(style);
    document.getElementById(ID+'-root')?.remove();
    const root=document.createElement('div');root.id=ID+'-root';root.setAttribute(EXT_ATTR,'true');state.root=root;
    const ring=document.createElement('button');ring.id=ID;ring.type='button';ring.setAttribute(EXT_ATTR,'true');ring.setAttribute('aria-label','中转站余额');ring.setAttribute('title','拖动调整位置，双击恢复默认位置');
    ring.dataset.level='normal';if(ring.style?.setProperty)ring.style.setProperty('--gpb-progress','0%');else ring.style['--gpb-progress']='0%';
    const ringVisual=document.createElement('span');ringVisual.className='gpb-ring';ringVisual.setAttribute('aria-hidden','true');ring.appendChild(ringVisual);
    const value=document.createElement('span');value.id=ID+'-value';ring.appendChild(value);state.ring=ring;state.value=value;
    const toast=document.createElement('div');toast.id=ID+'-toast';toast.setAttribute(EXT_ATTR,'true');state.toast=toast;
    const details=document.createElement('section');details.id=ID+'-details';details.setAttribute(EXT_ATTR,'true');details.setAttribute('role','dialog');details.setAttribute('aria-label','中转站余额详情');details.dataset.open='false';state.details=details;
    const openDetails=()=>{if(state.drag)return;details.dataset.open='true';renderDetails();};
    const closeDetails=()=>{details.dataset.open='false';};
    ring.addEventListener('pointerenter',(event)=>{event.stopPropagation();if(!state.drag)openDetails();});
    ring.addEventListener('pointerleave',(event)=>{if(state.drag)return;event.stopPropagation();if(event.relatedTarget===details||details.contains?.(event.relatedTarget))return;closeDetails();});
    details.addEventListener('pointerenter',(event)=>{event.stopPropagation();openDetails();});
    details.addEventListener('pointerleave',(event)=>{event.stopPropagation();if(event.relatedTarget===ring||ring.contains?.(event.relatedTarget))return;closeDetails();});
    ring.addEventListener('click',(event)=>{event.stopPropagation();if(state.suppressClick){state.suppressClick=false;return;}openDetails();});
    ring.addEventListener('pointerdown',(event)=>{
      if(event.button!==0)return;event.preventDefault();event.stopPropagation();closeDetails();
      const rect=ring.getBoundingClientRect();
      state.drag={pointerId:event.pointerId,offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top,moved:false};
      ring.setPointerCapture?.(event.pointerId);ring.dataset.dragging='true';
    });
    const finishDrag=(event,commit)=>{
      const drag=state.drag;if(!drag||event.pointerId!==drag.pointerId)return;
      state.drag=null;ring.dataset.dragging='false';
      if(commit&&drag.moved){const bounds=viewportBounds();const left=clamp(Number(ring.style.left.replace('px',''))||0,bounds.left,Math.max(bounds.left,bounds.right-44));const top=clamp(Number(ring.style.top.replace('px',''))||0,bounds.top,Math.max(bounds.top,bounds.bottom-44));state.position={left,top};savePosition(left,top);setFixed(ring,left,top);state.suppressClick=true;if(details.dataset.open==='true')positionDetails();}
      if(!drag.moved)state.suppressClick=false;
    };
    ring.addEventListener('pointermove',(event)=>{const drag=state.drag;if(!drag||event.pointerId!==drag.pointerId)return;const bounds=viewportBounds();const left=clamp(event.clientX-drag.offsetX,bounds.left,Math.max(bounds.left,bounds.right-44));const top=clamp(event.clientY-drag.offsetY,bounds.top,Math.max(bounds.top,bounds.bottom-44));if(Math.abs(left-Number(ring.style.left.replace('px',''))||0)>2||Math.abs(top-Number(ring.style.top.replace('px',''))||0)>2)drag.moved=true;setFixed(ring,left,top);if(state.toast?.dataset.visible==='true')positionToast();if(details.dataset.open==='true')positionDetails();});
    ring.addEventListener('pointerup',(event)=>{finishDrag(event,true);if(!state.drag)openDetails();});
    ring.addEventListener('pointercancel',(event)=>finishDrag(event,false));
    ring.addEventListener('dblclick',(event)=>{event.preventDefault();event.stopPropagation();state.position=null;clearPosition();const fallback=defaultPosition();if(fallback)setFixed(ring,fallback.left,fallback.top);});
    window.addEventListener('pointerdown',(event)=>{if(details.dataset.open!=='true'||state.drag)return;if(event.target===details||details.contains?.(event.target)||event.target===ring)return;closeDetails();});
    root.appendChild(ring);root.appendChild(toast);root.appendChild(details);document.body.appendChild(root);
    state.current=resolveCurrent();render();
    state.observer=new MutationObserver(()=>{syncContext();updatePosition();});state.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true,attributeFilter:['aria-label','data-composer-navigation-target','style','class']});
    state.resizeObserver=new ResizeObserver(updatePosition);window.addEventListener('resize',updatePosition);window.addEventListener('scroll',updatePosition,true);globalThis.visualViewport?.addEventListener('resize',updatePosition);globalThis.visualViewport?.addEventListener('scroll',updatePosition);
    state.timer=setInterval(()=>{syncContext();updatePosition();},SYNC_INTERVAL_MS);
    globalThis.__gptplusBalance={apply,context:syncContext,dispose(){if(state.disposed)return;state.disposed=true;clearInterval(state.timer);clearTimeout(state.toastTimer);state.observer?.disconnect();state.resizeObserver?.disconnect();window.removeEventListener('resize',updatePosition);window.removeEventListener('scroll',updatePosition,true);globalThis.visualViewport?.removeEventListener('resize',updatePosition);globalThis.visualViewport?.removeEventListener('scroll',updatePosition);root.remove();document.getElementById(STYLE_ID)?.remove();delete globalThis.__gptplusBalance;globalThis.__gptplusBalanceRuntime='';}};
    return {ok:true,installed:true};
  }
  return new Promise((resolve)=>{const deadline=Date.now()+READY_WAIT_MS;const boot=()=>{if(state.disposed){resolve({ok:true,installed:false,disposed:true});return;}if(!document.body){if(Date.now()>=deadline){resolve({ok:true,installed:false,pending:true});return;}setTimeout(boot,100);return;}try{resolve(install());}catch(error){resolve({ok:false,error:String(error?.message||error).slice(0,200)});}};boot();});
})()`;
}

const balanceScriptIds = new Map();
let activeBalanceBridge = null;

function balanceRoutes(ctx) {
  const configured = new Map((ctx?.plugins?.config?.('provider-balance')?.providers || []).map((item) => [String(item.providerId), item.adapter]));
  const models = typeof ctx?.models === 'function' ? ctx.models() : [];
  return (Array.isArray(models) ? models : []).filter((model) => model?.enabled !== false && configured.has(String(model?.providerId || '')))
    .map((model) => ({ slug: model.slug, providerId: model.providerId, providerName: model.providerName }));
}

function balanceProviderList(ctx) {
  const configured = ctx?.plugins?.config?.('provider-balance')?.providers || [];
  const providers = typeof ctx?.store?.providers === 'function' ? ctx.store.providers() : [];
  const names = new Map(providers.map((provider) => [String(provider.id), String(provider.name || provider.id)]));
  const modelNames = new Map(balanceRoutes(ctx).map((route) => [String(route.providerId), String(route.providerName || route.providerId)]));
  return configured.map((item) => ({ providerId: String(item.providerId), adapter: String(item.adapter), name: names.get(String(item.providerId)) || modelNames.get(String(item.providerId)) || String(item.providerId) }));
}

function applyBalanceExpression(snapshot, currentProviderId = snapshot?.providerId, providerList = [], providerStatuses = {}) {
  const safe = {
    providerId: String(snapshot?.providerId || ''),
    currentProviderId: String(currentProviderId || ''),
    adapter: String(snapshot?.adapter || ''),
    ok: snapshot?.ok !== false,
    ...(snapshot?.error ? { error: String(snapshot.error).slice(0, 240) } : {}),
    ...(snapshot?.balance != null ? { balance: String(snapshot.balance) } : {}),
    ...(snapshot?.totalUsed != null ? { totalUsed: String(snapshot.totalUsed) } : {}),
    ...(snapshot?.totalUsedUnit ? { totalUsedUnit: String(snapshot.totalUsedUnit) } : {}),
    ...(snapshot?.currency ? { currency: String(snapshot.currency) } : {}),
    ...(snapshot?.unit ? { unit: String(snapshot.unit) } : {}),
    ...(snapshot?.unlimited === true ? { unlimited: true } : {}),
    ...(snapshot?.at != null ? { at: Number(snapshot.at) } : {}),
    ...(snapshot?.delta != null ? { delta: String(snapshot.delta) } : {}),
    ...(snapshot?.deltaKind ? { deltaKind: String(snapshot.deltaKind) } : {}),
    ...(snapshot?.reason ? { reason: String(snapshot.reason) } : {}),
    providerSnapshots: snapshot?.providerSnapshots || {},
    providerStatuses,
    providerList,
  };
  return 'globalThis.__gptplusBalance?.apply?.(' + JSON.stringify(safe) + ')';
}

async function ensureBalancePageScript(target, options = {}) {
  const registered = balanceScriptIds.get(target.id);
  if (!registered) {
    const script = buildBalanceIndicatorScript({ modelRoutes: options.routes || [] });
    const added = await (options.addScriptImpl || addScriptOnNewDocument)(target, script, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (added?.identifier) balanceScriptIds.set(target.id, { target, identifier: added.identifier });
  }
  return (options.evaluateImpl || evaluate)(target, buildBalanceIndicatorScript({ modelRoutes: options.routes || [] }), { timeoutMs: COMMAND_TIMEOUT_MS });
}

function startChatGptBalanceBridge({
  ctx, cdpPort, runtime = ctx?.balanceRuntime, pollMs = PAGE_SYNC_INTERVAL_MS,
  listTargetsImpl = listTargets, evaluateImpl = evaluate, ensurePageScript = null,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
} = {}) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  if (!runtime || typeof runtime.refresh !== 'function') throw new Error('中转站余额运行时不可用');
  activeBalanceBridge?.stop?.();
  const routes = balanceRoutes(ctx);
  const routeBySlug = new Map();
  const slugCounts = new Map();
  for (const route of routes) slugCounts.set(route.slug, (slugCounts.get(route.slug) || 0) + 1);
  for (const route of routes) if (slugCounts.get(route.slug) === 1) routeBySlug.set(route.slug, route);
  const prepared = new Set();
  let stopped = false;
  let running = false;
  let timer = null;
  let target = null;
  let currentProviderId = '';
  let manualRefresh = 0;
  let detailsOpen = false;
  let detailsLoaded = false;
  const providerList = balanceProviderList(ctx);
  const providerStatuses = new Map();

  function schedule() {
    if (stopped || timer !== null) return;
    timer = setTimeoutImpl(() => { timer = null; void tick(); }, Math.max(10, Number(pollMs) || PAGE_SYNC_INTERVAL_MS));
    if (typeof timer?.unref === 'function') timer.unref();
  }

  async function send(snapshot, expectedProviderId, allowOffCurrent = false) {
    if (stopped || !target || (!expectedProviderId && !allowOffCurrent) || (!allowOffCurrent && String(snapshot?.providerId || '') !== expectedProviderId)) return false;
    const safeSnapshots = runtime.getSnapshots?.() || {};
    try {
      await evaluateImpl(target, applyBalanceExpression({ ...snapshot, providerSnapshots: safeSnapshots }, expectedProviderId, providerList, Object.fromEntries(providerStatuses)), { timeoutMs: COMMAND_TIMEOUT_MS });
      return true;
    } catch {
      target = null;
      return false;
    }
  }

  async function tick() {
    if (stopped || running) { schedule(); return; }
    running = true;
    try {
      if (!target) target = pickMainTarget(await listTargetsImpl(port));
      if (!target) return;
      let pageContext = await evaluateImpl(target, 'globalThis.__gptplusBalance?.context?.()', { timeoutMs: COMMAND_TIMEOUT_MS });
      if (!pageContext || pageContext.mounted !== true) {
        const install = typeof ensurePageScript === 'function'
          ? await ensurePageScript(target, { routes })
          : await ensureBalancePageScript(target, { routes, evaluateImpl });
        if (install?.installed === true) pageContext = await evaluateImpl(target, 'globalThis.__gptplusBalance?.context?.()', { timeoutMs: COMMAND_TIMEOUT_MS });
      }
      if (!pageContext || pageContext.mounted !== true) return;
      const slug = String(pageContext.modelSlug || '');
      const route = routeBySlug.get(slug);
      const providerId = route && String(pageContext.providerId || '') === String(route.providerId) ? route.providerId : '';
      if (providerId !== currentProviderId) {
        currentProviderId = providerId;
        detailsLoaded = false;
        runtime.setCurrentProvider?.(providerId);
        if (providerId) void runtime.refresh(providerId, { reason: 'model-change' });
        if (providerId) {
          const cached = runtime.getSnapshots?.()?.[providerId];
          if (cached) await send({ ...cached, ok: true }, providerId);
        }
      }
      detailsOpen = pageContext.detailsOpen === true;
      if (detailsOpen && !detailsLoaded) {
        detailsLoaded = true;
        for (const item of providerList) if (!providerId || item.providerId !== providerId) void runtime.refresh(item.providerId, { reason: 'details' });
      }
      if (!detailsOpen) detailsLoaded = false;
      if (!providerId) return;
      const refreshCount = Number(pageContext.manualRefresh) || 0;
      if (refreshCount > manualRefresh) {
        manualRefresh = refreshCount;
        void runtime.refresh(providerId, { reason: 'manual' });
      }
      if (typeof runtime.onUpdate !== 'function' && typeof ctx?.onBalanceEvent === 'function') {
        /* subscribed once below; this branch intentionally does not poll secrets */
      }
    } catch {
      target = null;
    } finally {
      running = false;
      schedule();
    }
  }

  const onBalanceEvent = (event) => {
    if (event?.providerId !== currentProviderId && !detailsOpen) return;
    providerStatuses.set(String(event?.providerId || ''), { ok: event?.ok !== false, error: event?.error ? String(event.error).slice(0, 240) : '', at: Number(event?.at || Date.now()) });
    void send(event, currentProviderId, true);
  };
  const unsubscribe = typeof ctx?.onBalanceEvent === 'function' ? ctx.onBalanceEvent(onBalanceEvent)
    : typeof runtime.onUpdate === 'function' ? runtime.onUpdate(onBalanceEvent) : () => {};
  const bridge = {
    cdpPort: port,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
      unsubscribe?.();
      runtime.setCurrentProvider?.('');
      if (activeBalanceBridge === bridge) activeBalanceBridge = null;
    },
  };
  activeBalanceBridge = bridge;
  void tick();
  return bridge;
}

async function injectChatGptBalance({ cdpPort, target = null, timeoutMs = INJECT_TIMEOUT_MS, routes = [], listTargetsImpl = listTargets, evaluateImpl = evaluate, addScriptImpl = addScriptOnNewDocument } = {}) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error('ChatGPT 调试端口无效');
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || INJECT_TIMEOUT_MS);
  let page = target;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      page ||= pickMainTarget(await listTargetsImpl(port));
      if (page) {
        const result = await ensureBalancePageScript(page, { routes, evaluateImpl, addScriptImpl });
        if (result?.installed === true) return { ok: true, installed: true, target: page };
        lastError = new Error(result?.error || '余额圆环尚未安装');
      }
    } catch (error) { lastError = error; page = null; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError ? '注入中转站余额圆环失败：' + lastError.message : '等待 ChatGPT 页面超时');
}

async function resumeChatGptBalance({ ctx, timeoutMs = 10000, findPort = findChatGptDebugPort, listTargetsImpl = listTargets, inject = injectChatGptBalance, startBridge = startChatGptBalanceBridge } = {}) {
  if (!ctx?.plugins?.isActive?.('provider-balance')) {
    activeBalanceBridge?.stop?.();
    return { ok: false, skipped: true, disabled: true };
  }
  if (activeBalanceBridge) return { ok: true, resumed: false, active: true, cdpPort: activeBalanceBridge.cdpPort };
  const executablePath = ctx.store?.get?.()?.chatgpt?.executablePath || '';
  let port = null;
  try { port = await findPort(executablePath ? { imageName: require('node:path').win32.basename(executablePath) } : {}); } catch { port = null; }
  if (!port) return { ok: false, skipped: true };
  const target = pickMainTarget(await listTargetsImpl(port));
  if (!target || !(String(target.url || '') === 'app://-/index.html' || /codex|chatgpt/i.test(String(target.title || '') + ' ' + String(target.url || '')))) return { ok: false, skipped: true };
  try {
    const attached = await installChatGptBalanceOnPort({ ctx, cdpPort: port, target, timeoutMs, inject, startBridge: (options) => startBridge({ ...options, listTargetsImpl }) });
    return { ok: true, cdpPort: port, bridge: attached.bridge };
  } catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 240) }; }
}



async function installChatGptBalanceOnPort({ ctx, cdpPort, target = null, timeoutMs = INJECT_TIMEOUT_MS, inject = injectChatGptBalance, startBridge = startChatGptBalanceBridge } = {}) {
  const routes = balanceRoutes(ctx);
  const installed = await inject({ cdpPort, target, timeoutMs, routes });
  if (installed?.installed !== true) throw new Error('页面圆环未安装');
  const bridge = startBridge({ ctx, cdpPort, runtime: ctx?.balanceRuntime });
  return { ok: true, cdpPort: Number(cdpPort), bridge: !!bridge, target: installed.target || target || null };
}

async function launchChatGptWithBalance({ ctx, launch, launchOptions = {}, wrapperDir, findPort = findAvailablePort, inject = injectChatGptBalance, startBridge = startChatGptBalanceBridge } = {}) {
  if (typeof launch !== 'function') throw new Error('ChatGPT 启动函数不可用');
  if (!ctx?.plugins?.isActive?.('provider-balance')) throw new Error('中转站余额插件未启用');
  activeBalanceBridge?.stop?.();
  const cdpPort = await findPort(9229);
  const launched = await launch({ ...launchOptions, cdpPort, ...(wrapperDir ? { wrapperDir } : {}) });
  if (!launched?.ok) return launched || { ok: false, error: '启动 ChatGPT 失败' };
  try {
    const attached = await installChatGptBalanceOnPort({ ctx, cdpPort, inject, startBridge });
    return { ...launched, injected: true, cdpPort, bridge: attached.bridge };
  } catch (error) {
    ctx?.log?.({ level: 'warn', msg: 'ChatGPT 已启动，但中转站余额圆环注入失败: ' + String(error?.message || error) });
    return { ...launched, injected: false, cdpPort, injectError: String(error?.message || error).slice(0, 240) };
  }
}

function stopChatGptBalanceBridge() {
  activeBalanceBridge?.stop?.();
}

async function disposeChatGptBalance({ cdpPort, target = null, timeoutMs = COMMAND_TIMEOUT_MS, listTargetsImpl = listTargets, evaluateImpl = evaluate, removeScriptImpl = removeScriptOnNewDocument } = {}) {
  activeBalanceBridge?.stop?.();
  const port = Number(cdpPort);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, skipped: true };
  const page = target || pickMainTarget(await listTargetsImpl(port));
  if (!page) return { ok: false, skipped: true };
  try { await evaluateImpl(page, 'globalThis.__gptplusBalance?.dispose?.(); ({ ok: true })', { timeoutMs }); }
  finally {
    const registered = balanceScriptIds.get(page.id);
    if (registered?.identifier) {
      try { await removeScriptImpl(page, registered.identifier, { timeoutMs }); }
      finally { balanceScriptIds.delete(page.id); }
    }
  }
  return { ok: true, target: page };
}

module.exports = { buildBalanceIndicatorScript, createDigitAnimationPlan, formatBalanceAmount, computeBalanceRingProgress, PAGE_SYNC_INTERVAL_MS, injectChatGptBalance, resumeChatGptBalance, startChatGptBalanceBridge, disposeChatGptBalance, stopChatGptBalanceBridge, installChatGptBalanceOnPort, launchChatGptWithBalance, applyBalanceExpression, balanceRoutes, balanceProviderList };
