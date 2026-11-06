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
  const [whole, fraction = ''] = unsigned.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '') || '0';
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
      const text = `${negative ? '-' : ''}${prefix}${grouped}${fraction ? decimal + fraction : ''}${suffix}`;
      return { text, prefix: `${negative ? '-' : ''}${prefix}`, integer: grouped, integerDigits: integer, group, decimal, fraction, suffix };
    } catch { /* unsupported currency falls through to the explicit unit */ }
  }
  const label = String(unit || '额度');
  const prefix = label === '额度' ? '' : label;
  const suffix = label === '额度' ? ' 额度' : '';
  const text = `${negative ? '-' : ''}${prefix}${integer}${fraction ? '.' + fraction : ''}${suffix}`;
  return { text, prefix: `${negative ? '-' : ''}${prefix}`, integer, integerDigits: integer, group: '', decimal: '.', fraction, suffix };
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
  const formatSource = formatBalanceAmount.toString();
  return `(() => {
  const ROUTES = ${mappingJson};
  const READY_WAIT_MS = ${safeReadyWait};
  const SYNC_INTERVAL_MS = ${PAGE_SYNC_INTERVAL_MS};
  const ID = 'gptplus-balance-indicator';
  const STYLE_ID = 'gptplus-balance-indicator-style';
  const EXT_ATTR = 'data-gptplus-balance-indicator';
  const RUNTIME_KEY = 'gptplus-balance-indicator-v1';
  const STYLE = ${JSON.stringify(`
    #gptplus-balance-indicator-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:inherit;color:var(--text-primary,#1f1f1f)}
    #gptplus-balance-indicator{position:fixed;width:44px;height:44px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:50%;background:var(--background-primary,#fff);box-shadow:0 2px 10px #0003;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;padding:2px;box-sizing:border-box}
    #gptplus-balance-indicator[data-state="error"]{border-color:#d92d20;color:#d92d20} #gptplus-balance-indicator[data-state="loading"]{opacity:.65}
    #gptplus-balance-indicator-value{font-size:9px;line-height:1.05;text-align:center;max-width:38px;max-height:36px;overflow:hidden;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
    #gptplus-balance-indicator-value[data-error="true"]{font-size:23px;font-weight:700;color:#d92d20}
    #gptplus-balance-indicator-toast{position:fixed;pointer-events:none;color:#d92d20;font-size:12px;font-weight:600;max-width:calc(100vw - 16px);white-space:normal;overflow-wrap:anywhere;text-align:center;background:var(--background-primary,#fff);border-radius:8px;padding:3px 7px;box-shadow:0 1px 6px #0002;opacity:0;transition:opacity .18s ease;z-index:2147483001}
    #gptplus-balance-indicator-toast[data-visible="true"]{opacity:1}
    #gptplus-balance-indicator-details{position:fixed;pointer-events:auto;min-width:190px;max-width:min(300px,calc(100vw - 16px));padding:12px;border:1px solid var(--border-subtle,#ddd);border-radius:12px;background:var(--background-primary,#fff);box-shadow:0 5px 20px #0003;font-size:12px;line-height:1.5;display:none;z-index:2147483002}
    #gptplus-balance-indicator-details[data-open="true"]{display:block} #gptplus-balance-indicator-details button{margin-top:8px;cursor:pointer}
    #gptplus-balance-indicator-amount{display:inline-flex;white-space:nowrap;font-variant-numeric:tabular-nums;align-items:baseline}
    #gptplus-balance-indicator-amount .gpb-static{display:inline-block}
    #gptplus-balance-indicator-amount .gpb-track{display:inline-block;position:relative;overflow:hidden;height:1.05em;vertical-align:baseline;line-height:1.05em}
    #gptplus-balance-indicator-amount .gpb-track span{display:block;line-height:1.05em}
    #gptplus-balance-indicator-amount .gpb-track[data-animate="true"] .gpb-old{animation:gpb-out .4s ease both}
    #gptplus-balance-indicator-amount .gpb-track[data-animate="true"] .gpb-new{animation:gpb-in .4s ease both}
    @keyframes gpb-out{to{transform:translateY(-110%);opacity:0}}
    @keyframes gpb-in{from{transform:translateY(110%);opacity:0}to{transform:translateY(0);opacity:1}}
    @media(prefers-reduced-motion:reduce){#gptplus-balance-indicator-toast{transition:none}#gptplus-balance-indicator-amount .gpb-track .gpb-old,#gptplus-balance-indicator-amount .gpb-track .gpb-new{animation:none!important}}
  `)};
  const createDigitAnimationPlan = ${animationPlanSource};
  const formatBalanceAmount = ${formatSource};
  if (globalThis.__gptplusBalanceRuntime === RUNTIME_KEY && globalThis.__gptplusBalance) return { ok:true,installed:true,reused:true };
  globalThis.__gptplusBalance?.dispose?.();
  globalThis.__gptplusBalanceRuntime = RUNTIME_KEY;
  const state = { root:null, ring:null, value:null, toast:null, details:null, snapshot:null, current:null, previousParts:null, providerSnapshots:{}, providerStatuses:{}, providerList:[], disposed:false, timer:0, toastTimer:0, observer:null, resizeObserver:null, manualRefresh:0 };

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
    const candidates=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const find=(pattern)=>candidates.find((node)=>pattern.test(String(node.getAttribute('aria-label')||node.getAttribute('title')||'')));
    return find(/settings|设置/i)||find(/profile menu|个人资料菜单/i)||null;
  }
  function setFixed(node,left,top){node.style.position='fixed';node.style.left=Math.round(left)+'px';node.style.top=Math.round(top)+'px';}
  function clamp(value,min,max){return Math.max(min,Math.min(max,value));}
  function updatePosition() {
    if(!state.ring||!state.root)return;
    const anchor=anchorNode(); if(!anchor){state.ring.style.display='none';return;}
    state.ring.style.display='flex';
    const rect=anchor.getBoundingClientRect(); const vp=globalThis.visualViewport;
    const leftEdge=(vp?.offsetLeft||0)+8; const rightEdge=(vp?.offsetLeft||0)+(vp?.width||innerWidth)-8;
    const width=44; const left=clamp(rect.left+(rect.width-width)/2,leftEdge,Math.max(leftEdge,rightEdge-width));
    const top=clamp(rect.top-width-8,8,Math.max(8,(vp?.offsetTop||0)+(vp?.height||innerHeight)-width-8));
    setFixed(state.ring,left,top);
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
  function renderDetails(){
    if(!state.details)return; state.details.replaceChildren();
    const snapshot=state.snapshot; const current=state.current||{};
    const title=document.createElement('strong');title.textContent=current.providerName||'中转站余额';state.details.appendChild(title);
    const line=document.createElement('div');
    if(snapshot?.ok===false)line.textContent=snapshot.error||current.reason||'刷新失败';
    else if(snapshot?.unlimited)line.textContent='不限额';
    else if(snapshot?.balance!=null){line.textContent=makeDisplayParts(snapshot.balance,snapshot.currency,snapshot.unit).text;}
    else line.textContent=current.reason||'等待余额刷新';
    state.details.appendChild(line);
    if(snapshot?.at){const time=document.createElement('div');time.textContent='更新于 '+new Date(snapshot.at).toLocaleTimeString();state.details.appendChild(time);}
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
    const left=clamp(ring.right+8,leftEdge,Math.max(leftEdge,rightEdge-(measured.width||220)));
    const top=clamp(ring.bottom-(measured.height||120),topEdge,Math.max(topEdge,bottomEdge-(measured.height||120)));
    setFixed(state.details,left,top);
  }
  function positionToast(){
    if(!state.toast||state.toast.dataset.visible!=='true'||!state.ring)return;
    const ring=state.ring.getBoundingClientRect();state.toast.style.display='block';const width=state.toast.getBoundingClientRect().width||Math.max(48,state.toast.textContent.length*7);
    const vp=globalThis.visualViewport;const leftEdge=(vp?.offsetLeft||0)+8;const rightEdge=(vp?.offsetLeft||0)+(vp?.width||innerWidth)-8;
    const left=clamp(ring.left+(ring.width-width)/2,leftEdge,Math.max(leftEdge,rightEdge-width));
    setFixed(state.toast,left,Math.max(8,ring.top-29));
  }
  function showToast(snapshot){
    if(!snapshot||snapshot.delta==null||!['cumulative','net-balance-change'].includes(snapshot.deltaKind))return;
    const amount=makeDisplayParts(snapshot.delta,snapshot.currency,snapshot.unit);
    state.toast.textContent='-'+amount.text.replace(/^-/, '');state.toast.dataset.visible='true';positionToast();
    clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>{state.toast.dataset.visible='false';setTimeout(()=>{if(state.toast?.dataset.visible==='false')state.toast.style.display='none';},200);},2000);
  }
  function render(){
    if(!state.ring?.isConnected)return;const current=state.current||{};const snapshot=state.snapshot;
    const error=!current.providerId||snapshot?.ok===false;
    state.ring.dataset.state=error?'error':snapshot?'ready':'loading';
    state.value.setAttribute('aria-hidden','false');
    state.ring.setAttribute('aria-label',error?(snapshot?.error||current.reason||'未关联余额提供商'):'中转站剩余 '+(snapshot?.balance??(snapshot?.unlimited?'不限额':'')));
    if(!snapshot||snapshot.providerId!==current.providerId){renderAmount({status:current.providerId?'loading':'unmapped'});}
    else if(snapshot.ok===false){renderAmount({status:'error'});}
    else renderAmount(snapshot);
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
    state.providerSnapshots=snapshot.providerSnapshots&&typeof snapshot.providerSnapshots==='object'?snapshot.providerSnapshots:{};
    state.providerStatuses=snapshot.providerStatuses&&typeof snapshot.providerStatuses==='object'?snapshot.providerStatuses:{};
    state.providerList=Array.isArray(snapshot.providerList)?snapshot.providerList:[];
    if(String(snapshot.providerId||'')===String(state.current?.providerId||'')){state.snapshot={...snapshot};render();showToast(snapshot);}
    else if(state.details?.dataset.open==='true')renderDetails();
    return true;
  }
  function install(){
    if(!document.getElementById(STYLE_ID)){const style=document.createElement('style');style.id=STYLE_ID;style.setAttribute(EXT_ATTR,'true');style.textContent=STYLE;document.head?.appendChild(style);}
    document.getElementById(ID+'-root')?.remove();
    const root=document.createElement('div');root.id=ID+'-root';root.setAttribute(EXT_ATTR,'true');state.root=root;
    const ring=document.createElement('button');ring.id=ID;ring.type='button';ring.setAttribute(EXT_ATTR,'true');ring.setAttribute('aria-label','中转站余额');
    const value=document.createElement('span');value.id=ID+'-value';ring.appendChild(value);state.ring=ring;state.value=value;
    const toast=document.createElement('div');toast.id=ID+'-toast';toast.setAttribute(EXT_ATTR,'true');state.toast=toast;
    const details=document.createElement('section');details.id=ID+'-details';details.setAttribute(EXT_ATTR,'true');details.setAttribute('role','dialog');details.setAttribute('aria-label','中转站余额详情');state.details=details;
    ring.addEventListener('click',(event)=>{event.stopPropagation();details.dataset.open=details.dataset.open==='true'?'false':'true';renderDetails();});
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

module.exports = { buildBalanceIndicatorScript, createDigitAnimationPlan, formatBalanceAmount, PAGE_SYNC_INTERVAL_MS, injectChatGptBalance, resumeChatGptBalance, startChatGptBalanceBridge, disposeChatGptBalance, stopChatGptBalanceBridge, installChatGptBalanceOnPort, launchChatGptWithBalance, applyBalanceExpression, balanceRoutes, balanceProviderList };
