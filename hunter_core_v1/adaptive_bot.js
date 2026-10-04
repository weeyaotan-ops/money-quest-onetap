'use strict';

const fs = require('fs');
const path = require('path');
const { cycle: scanMarket, ensureTradeLifecycle, lifecycleSnapshot, lifecycleEvents, lifecycleMessage, updateTradePrice, entryDecision, queueAlert, flushAlerts } = require('../adaptive_hunter_monitor');

const BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const CHAT_ID=String(process.env.TELEGRAM_CHAT_ID||'');
const STATE_PATH=process.env.ADAPTIVE_STATE_PATH||'.hunter_state/adaptive_state.json';
const VERSION='HUNTER_ADAPTIVE_V2_2026-10-03_INTELLIGENCE';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const M15_MS=15*60*1000;
const SCAN_AFTER_CLOSE_MS=Number(process.env.ADAPTIVE_SCAN_AFTER_CLOSE_MS||1500);
const RETRY_AFTER_MS=Number(process.env.ADAPTIVE_RETRY_AFTER_MS||2000);
const MAX_CLOSE_RETRIES=Number(process.env.ADAPTIVE_MAX_CLOSE_RETRIES||8);
const RUNTIME_MS=Number(process.env.ADAPTIVE_RUNTIME_MS||18600000);
const LIFECYCLE_POLL_MS=Math.max(1000,Number(process.env.ADAPTIVE_LIFECYCLE_POLL_MS||2000));
const LIVE_PRICE_TIMEOUT_MS=Math.max(1500,Number(process.env.ADAPTIVE_LIVE_PRICE_TIMEOUT_MS||4500));
const BINANCE_BASE=process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com';
const OKX_BASE=process.env.OKX_REST_BASE||'https://www.okx.com';
const YAHOO_BASE=process.env.YAHOO_FINANCE_BASE||'https://query1.finance.yahoo.com';

if(!BOT_TOKEN||!CHAT_ID){ console.error('Missing Telegram credentials'); process.exit(1); }

function load(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_PATH,'utf8'));
    return s&&typeof s==='object'?s:{};
  }catch{return {};}
}
function save(s){
  fs.mkdirSync(path.dirname(STATE_PATH),{recursive:true});
  const tmp=STATE_PATH+'.bot.tmp';
  fs.writeFileSync(tmp,JSON.stringify(s,null,2));
  fs.renameSync(tmp,STATE_PATH);
}
let stateBusy=false;
async function withStateLock(fn){
  while(stateBusy) await sleep(50);
  stateBusy=true;
  try{return await fn();}finally{stateBusy=false;}
}
function sgtDate(ts=Date.now()){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts));
  const o={}; for(const x of p) if(x.type!=='literal') o[x.type]=x.value; return o.year+'-'+o.month+'-'+o.day;
}
function sgtTime(ts){
  if(!Number.isFinite(Number(ts))) return 'n/a';
  return new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(Number(ts)));
}
function fmt(x,symbol){
  const n=Number(x); if(!Number.isFinite(n)) return 'n/a';
  if(symbol==='XAUUSD') return n.toFixed(2);
  if(n>=1000) return n.toFixed(2);
  if(n>=10) return n.toFixed(3);
  return n.toFixed(4);
}
function fmtZone(z,symbol){
  if(!z||!Number.isFinite(Number(z.low))||!Number.isFinite(Number(z.high))) return 'n/a';
  return fmt(z.low,symbol)+' - '+fmt(z.high,symbol);
}
function biasText(x){ return x==='BULLISH'?'Bullish':x==='BEARISH'?'Bearish':'Neutral'; }
function qualityText(x){
  const score=Number(x&&x.score);
  return Number.isFinite(score)?score.toFixed(0)+'/100 · '+String(x.label||''):'n/a';
}
function sideText(x){ return x==='LONG'?'做多':x==='SHORT'?'做空':''; }
function regimeText(x){
  if(x==='TREND') return '🟢 趋势';
  if(x==='RANGE') return '🟡 区间';
  if(x==='CHAOS') return '🔴 混乱';
  if(x==='STALE') return '🔴 数据过旧';
  if(x==='CLOSED') return '⚪ 休市';
  return '⚪ 中性';
}
function modeText(x){ return x==='TREND_RETEST'?'趋势突破回踩':x==='RANGE_SWEEP'?'区间扫流动性':x||''; }
function actionStateText(x,status){
  if(x==='ACTIONABLE') return '🟢 ACTIONABLE';
  if(x==='OPEN') return '✅ IN POSITION';
  if(x==='EXPIRED') return '⏳ ENTRY EXPIRED';
  if(x==='MANAGING') return '🛡️ MANAGING';
  if(x==='RUNNER') return '🏃 RUNNER';
  if(x==='CLOSED') return String(status||'CLOSED');
  return String(status||x||'TRACKING');
}
function keyboard(){
  return {inline_keyboard:[
    [{text:'🚨 现在',callback_data:'now'}],
    [{text:'🌍 市场',callback_data:'market'},{text:'🧠 V2智能',callback_data:'intel'}],
    [{text:'📌 进行中',callback_data:'active'}],
    [{text:'💵 本金 200U',callback_data:'cap:200'},{text:'250U',callback_data:'cap:250'},{text:'300U',callback_data:'cap:300'}],
    [{text:'📊 成绩',callback_data:'results'},{text:'🧠 学习',callback_data:'learn'}],
    [{text:'📡 系统',callback_data:'system'}]
  ]};
}
function back(action){
  return {inline_keyboard:[[{text:'🔄 刷新',callback_data:action}],[{text:'🏠 主页',callback_data:'start'}]]};
}
async function tg(method,body){
  const r=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d.ok===false) throw new Error('Telegram '+method+' '+r.status);
  return d;
}
async function send(text,markup=keyboard()){ return tg('sendMessage',{chat_id:CHAT_ID,text,disable_web_page_preview:true,reply_markup:markup}); }
async function answer(id){ if(id) await tg('answerCallbackQuery',{callback_query_id:id}).catch(()=>{}); }

function nowText(){
  const s=load(),scan=s.lastScan||{},lines=['🚨 现在',''];
  if(scan.killed){
    lines.push('🛑 今日停止新信号','今天纸面结果已到 '+Number(scan.dailyR||0).toFixed(2)+'R，达到保护线。','');
  }
  const cs=scan.candidates||[];
  if(cs.length){
    lines.push('✅ 刚确认');
    for(const x of cs){
      lines.push((x.side==='LONG'?'🟢 ':'🔴 ')+x.symbol+' · '+(x.decision||sideText(x.side)));
      lines.push(modeText(x.mode)+' · '+(x.execution&&x.execution.costOk===false?'⛔ COST SKIP':'🟢 ACTIONABLE'));
      if(Number.isFinite(Number(x.qualityScore))) lines.push('🧠 Quality '+Number(x.qualityScore).toFixed(0)+'/100 · '+String(x.qualityLabel||''));
      const intel=x.intelligence||{},liq=intel.liquidity||{};
      if(intel.structure) lines.push('结构 H4 '+biasText(intel.structure.h4)+' · M15 '+biasText(intel.structure.m15));
      if(Number.isFinite(Number(liq.bsl))||Number.isFinite(Number(liq.ssl))) lines.push('BSL '+fmt(liq.bsl,x.symbol)+' · SSL '+fmt(liq.ssl,x.symbol));
      lines.push('进场 '+fmt(x.entry,x.symbol)+' · SL '+fmt(x.stop,x.symbol));
      if(Number.isFinite(Number(x.entryExpiresAtMs))) lines.push('有效到 '+sgtTime(x.entryExpiresAtMs)+' SGT');
      lines.push('目标1 '+fmt(x.tp1,x.symbol)+' · 目标2 '+fmt(x.tp2,x.symbol));
      if(x.execution&&x.execution.valid){
        lines.push('照填：Isolated · '+x.execution.leverage+'x · Qty '+Number(x.execution.quantity).toFixed(Number(x.execution.qtyDecimals||0)));
        lines.push('Initial Margin '+Number(x.execution.initialMargin).toFixed(2)+'U · Max Loss '+Number(x.execution.estMaxLoss).toFixed(2)+'U');
      }
      lines.push('');
    }
  }else lines.push('⚪ 现在没有新的确认信号','');
  const armed=scan.armed||[];
  if(armed.length){
    lines.push('👀 等回踩');
    for(const x of armed.slice(0,5)) lines.push(x.symbol+' '+sideText(x.side)+' · '+x.session+' · WAITING RETEST');
    lines.push('');
  }
  const markets=Object.values(s.market||{});
  const chaos=markets.filter(x=>x.regime==='CHAOS');
  if(chaos.length) lines.push('🔴 混乱市场：'+chaos.map(x=>x.symbol).join(' / '),'不交易。','');
  lines.push('最后扫描：'+sgtTime(scan.at)+' SGT');
  return lines.join('\n');
}
function marketText(){
  const s=load(),xs=Object.values(s.market||{}),lines=['🌍 市场',''];
  if(!xs.length) return lines.concat('还没有最新市场数据。').join('\n');
  xs.sort((a,b)=>String(a.symbol).localeCompare(String(b.symbol)));
  for(const x of xs){
    lines.push(regimeText(x.regime)+' '+x.symbol+(x.side?' · '+sideText(x.side):''));
    lines.push('M15收盘 '+fmt(x.lastClose,x.symbol)+(Number.isFinite(x.adx)?' · H4 ADX '+Number(x.adx).toFixed(1):''));
    const intel=x.intelligence||{},st=intel.structure||{},liq=intel.liquidity||{},zones=intel.zones||{};
    if(st.h4||st.m15) lines.push('结构 H4 '+biasText(st.h4)+' · M15 '+biasText(st.m15));
    if(Number.isFinite(Number(liq.bsl))||Number.isFinite(Number(liq.ssl))) lines.push('BSL '+fmt(liq.bsl,x.symbol)+' · SSL '+fmt(liq.ssl,x.symbol));
    if(zones.demand||zones.supply) lines.push('Demand '+fmtZone(zones.demand,x.symbol)+' · Supply '+fmtZone(zones.supply,x.symbol));
    const lag=Number(x.lagMinutes);
    if(x.regime==='CLOSED') lines.push('数据 '+(x.provider||'n/a')+' · 市场休市（最后收盘）');
    else lines.push('数据 '+(x.provider||'n/a')+(Number.isFinite(lag)?(lag>0.1?' · 数据源落后 '+lag.toFixed(1)+'分钟':' · M15 已同步'):''));
    if(x.regime==='STALE') lines.push('⚠️ 旧数据不会发信号');
    if(x.regime==='CLOSED') lines.push('周末休市，不会发信号');
    lines.push('');
  }
  lines.push('趋势 → 等突破回踩','区间 → 等扫流动性再收回','BSL/SSL + Supply/Demand → 作为智能上下文','Quality score → 先记录验证，不直接挡信号');
  return lines.join('\n');
}
function intelligenceText(){
  const s=load(),xs=Object.values(s.market||{}),lines=['🧠 HUNTER V2 智能层',''];
  if(!xs.length) return lines.concat('还没有最新市场数据。').join('\n');
  xs.sort((a,b)=>String(a.symbol).localeCompare(String(b.symbol)));
  for(const x of xs){
    const intel=x.intelligence||{},st=intel.structure||{},liq=intel.liquidity||{},zones=intel.zones||{};
    lines.push('• '+x.symbol);
    lines.push('Regime：'+String(x.regime||'n/a')+(x.side?' · '+sideText(x.side):''));
    lines.push('Structure：H4 '+biasText(st.h4)+' · M15 '+biasText(st.m15));
    lines.push('BSL：'+fmt(liq.bsl,x.symbol)+' · SSL：'+fmt(liq.ssl,x.symbol));
    lines.push('Demand：'+fmtZone(zones.demand,x.symbol));
    lines.push('Supply：'+fmtZone(zones.supply,x.symbol));
    lines.push('');
  }
  lines.push('V2 正在运行：结构 + 流动性 + Supply/Demand + Quality Score');
  lines.push('Quality 目前只记录验证，不会挡掉原本有效 signal。');
  return lines.join('\n');
}
function activeText(){
  const s=load(),xs=Object.values(s.trades||{}).filter(x=>!x.terminal).sort((a,b)=>b.signalAtMs-a.signalAtMs);
  const lines=['📌 进行中',''];
  if(!xs.length) return lines.concat('⚪ 没有正在追踪的信号。').join('\n');
  for(const x of xs.slice(0,8)){
    lines.push((x.side==='LONG'?'🟢 ':'🔴 ')+x.symbol+' · '+(x.decision||sideText(x.side)));
    lines.push(modeText(x.mode)+' · '+actionStateText(x.actionState,x.status));
    if(x.intelligence) lines.push('🧠 Quality '+qualityText(x.intelligence));
    lines.push('Entry '+fmt(x.entry,x.symbol)+' · SL '+fmt(x.stop,x.symbol));
    lines.push('TP1 '+fmt(x.tp1,x.symbol)+' · TP2 '+fmt(x.tp2,x.symbol));
    if(x.execution&&x.execution.costOk===false) lines.push('⛔ 成本检查：SKIP');
    if(!x.entryConfirmed){
      lines.push('等待确认：'+String(x.entryStatus||'ENTER')+' · 下单后按 ✅ 已进场');
      if(Number.isFinite(Number(x.entryExpiresAtMs))) lines.push('有效到 '+sgtTime(x.entryExpiresAtMs)+' SGT');
    }else{
      lines.push('✅ 已确认进场'+(Number.isFinite(Number(x.actualEntryPrice))?' · 当时价 '+fmt(x.actualEntryPrice,x.symbol):''));
    }
    if(x.actionState==='EXPIRED') lines.push('⏳ 未进场就跳过，不要追价');
    if(x.tp1Hit&&!x.terminal&&!x.runnerActive) lines.push('🛡️ TP1 已到 · SL 已移到 Entry（BE）');
    if(x.runnerActive) lines.push('Runner 正在跑'+(Number.isFinite(x.runnerTrail)?' · Trail '+fmt(x.runnerTrail,x.symbol):''));
    lines.push('');
  }
  return lines.join('\n');
}
function resolvedTrades(){
  const s=load();
  return Object.values(s.trades||{}).filter(x=>x.terminal&&Number.isFinite(Number(x.realizedR))).sort((a,b)=>a.signalAtMs-b.signalAtMs);
}
function calcStats(xs){
  const rs=xs.map(x=>Number(x.realizedR)); if(!rs.length) return {n:0,avg:null,wr:null,total:0,dd:0,lossStreak:0};
  let eq=0,peak=0,dd=0,ls=0,maxLs=0;
  for(const r of rs){eq+=r;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);if(r<0){ls++;maxLs=Math.max(maxLs,ls);}else ls=0;}
  return {n:rs.length,avg:rs.reduce((a,b)=>a+b,0)/rs.length,wr:rs.filter(x=>x>0).length/rs.length,total:rs.reduce((a,b)=>a+b,0),dd,lossStreak:maxLs};
}
function resultsText(){
  const all=resolvedTrades(),recent=all.slice(-20),a=calcStats(all),r=calcStats(recent),today=sgtDate();
  const todayR=all.filter(x=>sgtDate(x.signalAtMs)===today).reduce((sum,x)=>sum+Number(x.realizedR),0);
  const fr=n=>Number.isFinite(n)?(n>=0?'+':'')+n.toFixed(2)+'R':'样本不足';
  const pc=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'样本不足';
  return [
    '📊 成绩','',
    '已完成：'+a.n+'单',
    '总结果：'+fr(a.total),
    '平均：'+fr(a.avg),
    '胜率：'+pc(a.wr),
    '最大回撤：'+a.dd.toFixed(2)+'R',
    '最长连亏：'+a.lossStreak+'单',
    '',
    '最近'+r.n+'单：'+fr(r.avg)+' / 胜率 '+pc(r.wr),
    '今天：'+fr(todayR),
    '',
    '统计同一 Hunter Adaptive 核心策略；V2 开始记录 Quality。'
  ].join('\n');
}
function cohort(xs,keyFn){
  const m={}; for(const x of xs){const k=keyFn(x)||'UNKNOWN'; if(!m[k])m[k]=[];m[k].push(x);}
  return Object.entries(m).map(([key,v])=>({key,...calcStats(v)})).sort((a,b)=>(b.avg??-999)-(a.avg??-999));
}
function learnText(){
  const xs=resolvedTrades(),lines=['🧠 学习',''];
  if(xs.length<20){
    return lines.concat('⚪ 样本不足','目前只有 '+xs.length+' 个完成样本。','至少先收集 20 单，再判断哪种模式更强。','','不会自动修改 Live。').join('\n');
  }
  const groups=[
    ...cohort(xs,x=>x.symbol).map(x=>({...x,type:'市场'})),
    ...cohort(xs,x=>x.mode).map(x=>({...x,type:'模式'})),
    ...cohort(xs,x=>x.side).map(x=>({...x,type:'方向'})),
    ...cohort(xs,x=>x.session).map(x=>({...x,type:'Session'})),
    ...cohort(xs,x=>x.intelligence&&x.intelligence.label).map(x=>({...x,type:'Quality'}))
  ].filter(x=>x.n>=8&&Number.isFinite(x.avg)).sort((a,b)=>b.avg-a.avg);
  lines.push('已完成 '+xs.length+' 单','');
  if(!groups.length) lines.push('🟡 总样本够，但分组样本还太少。');
  else{
    lines.push('💪 当前强项');
    for(const g of groups.slice(0,3)) lines.push(g.type+' · '+g.key+' · '+g.n+'单 · '+(g.avg>=0?'+':'')+g.avg.toFixed(2)+'R');
    const weak=[...groups].sort((a,b)=>a.avg-b.avg).filter(x=>x.avg<0).slice(0,3);
    if(weak.length){ lines.push('','🪫 当前拖累'); for(const g of weak) lines.push(g.type+' · '+g.key+' · '+g.n+'单 · '+g.avg.toFixed(2)+'R'); }
  }
  const a=calcStats(xs),r=calcStats(xs.slice(-20));
  lines.push('');
  if(a.avg>0&&r.avg<0) lines.push('🟠 最近20单转弱，先观察，不直接改规则。');
  else if(r.avg>0) lines.push('🟢 最近样本仍为正。');
  else lines.push('🟡 还没有足够清楚的优势。');
  lines.push('','学习只负责发现问题，不会自动改 Live。');
  return lines.join('\n');
}
function systemText(){
  const s=load(),scan=s.lastScan||{},scanAt=Number(scan.at),now=Date.now();
  const equity=Math.max(1,Number(s.settings&&s.settings.equityUsdt)||250);
  const age=scanAt?(now-scanAt)/60000:null;
  const nextDue=scanAt?nextM15ScanAt(scanAt+1):null;
  const lateBy=Number.isFinite(nextDue)?(now-nextDue)/60000:null;
  const scannerStatus=!Number.isFinite(age)?'⚪ Scanner：等待首次扫描':
    (Number.isFinite(lateBy)&&lateBy>1?'🚨 Scanner 可能卡住':
    (Number.isFinite(lateBy)&&lateBy>0?'🟡 Scanner：新M15扫描稍慢':
    (age>8?'🟢 Scanner：等待下一根M15收盘':'🟢 Scanner：持续扫描中')));
  const errs=scan.errors||[];
  const stale=Object.values(s.market||{}).filter(x=>x.regime==='STALE');
  const closed=Object.values(s.market||{}).filter(x=>x.regime==='CLOSED');
  return [
    '📡 系统','',
    '策略：Hunter Adaptive V2 Intelligence',
    '模式：Signal only',
    '自动下单：关闭',
    '交易市场：XAUUSD / BTC / ETH / SOL',
    '本金：'+equity.toFixed(0)+'U',
    'Risk：0.5% / signal',
    'Daily kill：-2R',
    '',
    '最后扫描：'+sgtTime(scan.at)+' SGT',
    Number.isFinite(age)?'距上次M15扫描：'+age.toFixed(1)+'分钟':null,
    Number.isFinite(nextDue)?'下一次M15扫描：'+sgtTime(nextDue)+' SGT':null,
    scannerStatus,
    stale.length?'⚠️ 旧数据：'+stale.map(x=>x.symbol+'('+Number(x.lagMinutes||0).toFixed(0)+'m)').join(' / '):null,
    closed.length?'⚪ 休市：'+closed.map(x=>x.symbol).join(' / '):null,
    errs.length?'⚠️ 数据问题：'+errs.map(x=>x.symbol).join(' / '):'🟢 数据源：正常',
    scan.killed?'🛑 今日新信号已暂停':'🟢 今日风险开关：正常',
    '生命周期：WAITING RETEST → ACTIONABLE → TP1/BE → TP2/Runner → Closed',
    '⚡ TP/SL 实时监控：约 '+(LIFECYCLE_POLL_MS/1000).toFixed(0)+'秒一次',
    '✅ 已进场 / Skip：开启',
    '🔄 Live Entry Check：开启',
    '',
    '旧 Session Breakout 已退出 Live。'
  ].filter(Boolean).join('\n');
}
async function menu(){
  const s=load();
  const equity=Math.max(1,Number(s.settings&&s.settings.equityUsdt)||250);
  return send([
    'HUNTER ADAPTIVE V2','',
    '当前本金：'+equity.toFixed(0)+'U',
    '趋势：突破后等回踩才进',
    '智能层：H4/M15结构 + BSL/SSL + Supply/Demand + Quality',
    '区间：扫高/扫低后收回才进',
    '混乱：不交易',
    '',
    'SL：结构失效 + 波动缓冲',
    'Trend：40%@1R · 30%@2R · 30% Runner',
    'Range：50%@中线 · 50%@另一边Box',
    '',
    '0.5% risk · 当天 -2R 停止新信号'
  ].join('\n'),keyboard());
}
async function setCapital(value){
  const equity=Math.max(1,Number(value)||250);
  return withStateLock(async()=>{
    const s=load();
    if(!s.settings||typeof s.settings!=='object') s.settings={};
    s.settings.equityUsdt=equity;
    save(s);
    return send('💵 本金已设为 '+equity.toFixed(0)+'U\n之后的新 signal 会自动重算 Leverage / Quantity / Initial Margin / Max Loss。',keyboard());
  });
}
async function handle(action,id,message=null){
  await answer(id);
  try{
    if(String(action||'').startsWith('enter:')||String(action||'').startsWith('skip:')) return tradeAction(action,message);
    if(String(action||'').startsWith('cap:')) return setCapital(String(action).split(':')[1]);
    if(action==='start') return menu();
    if(action==='now') return send(nowText(),back('now'));
    if(action==='market') return send(marketText(),back('market'));
    if(action==='intel') return send(intelligenceText(),back('intel'));
    if(action==='active') return send(activeText(),back('active'));
    if(action==='results') return send(resultsText(),back('results'));
    if(action==='learn') return send(learnText(),back('learn'));
    if(action==='system') return send(systemText(),back('system'));
    return menu();
  }catch(e){console.error(e);return send('⚠️ 暂时读取失败，等一下再试。',back('start'));}
}
function normalize(t){
  const x=String(t||'').trim().toLowerCase().replace(/@\w+$/,'');
  if(['/start','start','/menu','menu'].includes(x))return'start';
  if(['/now','now','/check','check'].includes(x))return'now';
  if(['/market','market'].includes(x))return'market';
  if(['/intel','intel','v2','智能'].includes(x))return'intel';
  if(['/active','active'].includes(x))return'active';
  if(['/results','results','/performance','performance'].includes(x))return'results';
  if(['/learn','learn','学习'].includes(x))return'learn';
  if(['/system','system','/status','status'].includes(x))return'system';
  return null;
}
async function getUpdates(offset){
  const u=new URL('https://api.telegram.org/bot'+BOT_TOKEN+'/getUpdates');
  u.searchParams.set('timeout','50');u.searchParams.set('allowed_updates',JSON.stringify(['message','callback_query']));if(offset)u.searchParams.set('offset',String(offset));
  const r=await fetch(u,{signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok||!d.ok)throw new Error('getUpdates '+r.status);return d.result||[];
}
async function setCommands(){
  await tg('setMyCommands',{commands:[
    {command:'start',description:'打开主页'},
    {command:'now',description:'现在有什么机会'},
    {command:'market',description:'市场状态'},
    {command:'intel',description:'V2智能层'},
    {command:'active',description:'进行中的信号'},
    {command:'results',description:'策略成绩'},
    {command:'learn',description:'自动学习'},
    {command:'system',description:'系统状态'}
  ]});
}
function expectedM15Close(now=Date.now()){ return Math.floor(Number(now)/M15_MS)*M15_MS; }
function nextM15ScanAt(now=Date.now()){
  const base=Math.floor(Number(now)/M15_MS)*M15_MS;
  let target=base+SCAN_AFTER_CLOSE_MS;
  if(target<=now) target=base+M15_MS+SCAN_AFTER_CLOSE_MS;
  return target;
}
function behindExpectedClose(result,scanAt){
  const expected=expectedM15Close(scanAt);
  return Object.values(result?.market||{}).filter(x=>x?.regime!=='CLOSED'&&Number(x?.lastCandleClose||0)<expected);
}
const livePriceCache=new Map();
async function fastJson(url){
  const r=await fetch(url,{headers:{'user-agent':'hunter-adaptive-live/1.0'},signal:AbortSignal.timeout(LIVE_PRICE_TIMEOUT_MS)});
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
function okxId(symbol){ return String(symbol).replace(/USDT$/,'')+'-USDT-SWAP'; }
async function cryptoLivePrice(symbol){
  try{
    const q=new URLSearchParams({symbol});
    const b=await fastJson(BINANCE_BASE+'/fapi/v1/ticker/price?'+q.toString());
    const p=Number(b&&b.price);
    if(Number.isFinite(p)) return {price:p,provider:'BINANCE_FUTURES'};
  }catch(e){}
  const q=new URLSearchParams({instId:okxId(symbol)});
  const b=await fastJson(OKX_BASE+'/api/v5/market/ticker?'+q.toString());
  const p=Number(b&&b.data&&b.data[0]&&b.data[0].last);
  if(!Number.isFinite(p)) throw new Error('NO_LIVE_PRICE '+symbol);
  return {price:p,provider:'OKX_SWAP'};
}
async function xauLivePrice(){
  const now=Date.now(),cached=livePriceCache.get('XAUUSD');
  if(cached&&now-cached.at<10000) return cached.value;
  const q=new URLSearchParams({interval:'1m',range:'1d',includePrePost:'true',events:'history'});
  const b=await fastJson(YAHOO_BASE+'/v8/finance/chart/'+encodeURIComponent('XAUUSD=X')+'?'+q.toString());
  const result=b&&b.chart&&b.chart.result&&b.chart.result[0];
  const meta=Number(result&&result.meta&&result.meta.regularMarketPrice);
  let p=meta;
  if(!Number.isFinite(p)){
    const closes=result&&result.indicators&&result.indicators.quote&&result.indicators.quote[0]&&result.indicators.quote[0].close||[];
    for(let i=closes.length-1;i>=0;i-=1){ const n=Number(closes[i]); if(Number.isFinite(n)){p=n;break;} }
  }
  if(!Number.isFinite(p)) throw new Error('NO_LIVE_PRICE XAUUSD');
  const value={price:p,provider:'YAHOO_XAU_SPOT'};
  livePriceCache.set('XAUUSD',{at:now,value});
  return value;
}
async function livePrice(symbol){
  return symbol==='XAUUSD'?xauLivePrice():cryptoLivePrice(symbol);
}
function entryStateAlert(t,d){
  const p=Number(d&&d.price);
  const nowPrice=Number.isFinite(p)?fmt(p,t.symbol):'n/a';
  const guard=d&&d.guard;
  if(d.state==='DO_NOT_CHASE'){
    return ['🔴 DO NOT CHASE','',t.symbol+' · '+sideText(t.side),'当前价：'+nowPrice,
      guard?(guard.boundaryLabel+'：'+fmt(guard.chasePrice,t.symbol)):null,
      '价格已经超出追价范围。','先不要进，等它回到 Entry 区。'].filter(Boolean).join('\n');
  }
  if(d.state==='ENTER'){
    return ['🟢 ENTRY AVAILABLE','',t.symbol+' · '+sideText(t.side),'当前价：'+nowPrice,
      '价格已回到可进范围。','如果成交，马上按【✅ 已进场】。'].join('\n');
  }
  if(d.state==='EXPIRED') return ['⌛ ENTRY EXPIRED','',t.symbol+' · '+sideText(t.side),'进场时间已过。','这次跳过，不要追。'].join('\n');
  if(d.state==='INVALID') return ['⚪ SETUP INVALID','',t.symbol+' · '+sideText(t.side),'价格已经破坏原本结构。','这次不进。'].join('\n');
  return null;
}
function findTradeBySignalId(state,id){
  return Object.values(state.trades||{}).find(t=>String(t&&t.signalId||'')===String(id||''))||null;
}
async function clearSignalButtons(message){
  const messageId=Number(message&&message.message_id);
  if(!Number.isFinite(messageId)) return;
  await tg('editMessageReplyMarkup',{chat_id:CHAT_ID,message_id:messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
}
async function tradeAction(action,message){
  const raw=String(action||'');
  const parts=raw.split(':');
  const verb=parts[0],id=parts.slice(1).join(':');
  if(!id||!['enter','skip'].includes(verb)) return menu();

  if(verb==='skip'){
    let t=null;
    await withStateLock(async()=>{
      const state=load();
      t=findTradeBySignalId(state,id);
      if(!t) return;
      if(!t.terminal){
        t.status='SKIPPED_USER'; t.actionState='CLOSED'; t.terminal=true; t.skippedReason='USER';
        t.skippedAtMs=Date.now(); t.realizedR=null;
        save(state);
      }
    });
    await clearSignalButtons(message);
    if(!t) return send('⚠️ 找不到这条 signal，可能已经过期。',keyboard());
    return send('⏭️ 已 Skip '+t.symbol+'。\n这单不会再发 TP / SL 管理通知。',keyboard());
  }

  const preview=load();
  const pTrade=findTradeBySignalId(preview,id);
  if(!pTrade) return send('⚠️ 找不到这条 signal，可能已经过期。',keyboard());
  if(pTrade.terminal) return send('这条 signal 已结束，不能再确认进场。',keyboard());
  if(pTrade.entryConfirmed) return send('✅ '+pTrade.symbol+' 已经确认过进场。',keyboard());

  let quote=null;
  try{ quote=await livePrice(pTrade.symbol); }
  catch(e){ return send('⚠️ 暂时拿不到 '+pTrade.symbol+' live price，先不要乱进。等几秒再按。',keyboard()); }

  let result=null,confirmed=null;
  await withStateLock(async()=>{
    const state=load();
    const t=findTradeBySignalId(state,id);
    if(!t){result={state:'MISSING'};return;}
    result=entryDecision(t,quote.price,Date.now());
    if(result.state==='ENTER'){
      const now=Date.now();
      t.entryConfirmed=true;
      t.entryConfirmedAtMs=now;
      t.actualEntryPrice=Number(quote.price);
      t.entryStatus='CONFIRMED';
      t.status='OPEN';
      t.actionState='OPEN';
      t.lastOpenTime=Math.floor(now/M15_MS)*M15_MS;
      confirmed={...t};
      save(state);
    }else if(['EXPIRED','INVALID'].includes(result.state)){
      t.entryStatus=result.state;
      t.status=result.state;
      t.actionState='CLOSED';
      t.terminal=true;
      t.realizedR=null;
      save(state);
    }else{
      t.entryStatus=result.state;
      save(state);
    }
  });

  if(result&&result.state==='ENTER'&&confirmed){
    await clearSignalButtons(message);
    return send([
      '✅ 已记录进场','',
      confirmed.symbol+' · '+sideText(confirmed.side),
      '当时 live price：'+fmt(confirmed.actualEntryPrice,confirmed.symbol),
      'SL：'+fmt(confirmed.stop,confirmed.symbol),
      'TP1：'+fmt(confirmed.tp1,confirmed.symbol),
      'TP2：'+fmt(confirmed.tp2,confirmed.symbol),
      '',
      '从现在开始才会实时管理 TP / SL。'
    ].join('\n'),keyboard());
  }
  if(result&&result.state==='DO_NOT_CHASE'){
    return send(entryStateAlert(pTrade,result)+'\n\n没有记录为已进场。',keyboard());
  }
  if(result&&['EXPIRED','INVALID'].includes(result.state)){
    await clearSignalButtons(message);
    return send(entryStateAlert(pTrade,result),keyboard());
  }
  return send('⚠️ 现在不适合确认进场。',keyboard());
}

async function fastLifecycleOnce(){
  const preview=load();
  const active=Object.values(preview.trades||{}).filter(t=>t&&!t.terminal);
  if(!active.length) return;
  const symbols=[...new Set(active.map(t=>String(t.symbol||'')).filter(Boolean))];
  const prices={}; const errors=[];
  await Promise.all(symbols.map(async symbol=>{
    try{prices[symbol]=await livePrice(symbol);}
    catch(e){errors.push({symbol,error:e.message});}
  }));
  await withStateLock(async()=>{
    const state=load();
    if(!Array.isArray(state.pendingAlerts)) state.pendingAlerts=[];
    const now=Date.now();
    for(const t of Object.values(state.trades||{}).filter(x=>x&&!x.terminal)){
      ensureTradeLifecycle(t);
      const px=prices[t.symbol]&&prices[t.symbol].price;
      if(!t.entryConfirmed){
        const d=entryDecision(t,px,now);
        const prev=String(t.entryStatus||'');
        t.entryStatus=d.state;
        if(['EXPIRED','INVALID'].includes(d.state)){
          t.status=d.state; t.actionState='CLOSED'; t.terminal=true; t.realizedR=null;
          if(d.state==='EXPIRED') t.expiredAtMs=now;
        }else{
          t.status='ACTIONABLE'; t.actionState='ACTIONABLE';
        }
        const shouldAlert=(d.state==='DO_NOT_CHASE'&&prev!=='DO_NOT_CHASE')||
          (d.state==='ENTER'&&prev==='DO_NOT_CHASE')||
          (['EXPIRED','INVALID'].includes(d.state)&&prev!==d.state);
        if(shouldAlert){
          queueAlert(state,'ENTRY|'+t.key+'|'+d.state+'|'+now,entryStateAlert(t,d),now);
        }
        continue;
      }
      const before=lifecycleSnapshot(t);
      updateTradePrice(t,px,now);
      for(const event of lifecycleEvents(before,t)){
        queueAlert(state,'LIVE|TRADE|'+t.key+'|'+event,lifecycleMessage(t,event),now);
      }
    }
    state.liveLifecycle={
      at:now,
      pollMs:LIFECYCLE_POLL_MS,
      prices:Object.fromEntries(Object.entries(prices).map(([symbol,v])=>[symbol,{price:v.price,provider:v.provider,at:now}])),
      errors
    };
    save(state);
    await flushAlerts(state);
    save(state);
  });
}
async function fastLifecycleLoop(stopAt){
  while(Date.now()<stopAt){
    const started=Date.now();
    try{await fastLifecycleOnce();}
    catch(e){console.error(JSON.stringify({bot:VERSION,lifecycle:'ERROR',error:e.message}));}
    const wait=Math.max(250,LIFECYCLE_POLL_MS-(Date.now()-started));
    if(Date.now()+wait>=stopAt) break;
    await sleep(wait);
  }
}

async function scannerLoop(stopAt){
  let first=true;
  while(Date.now()<stopAt){
    if(!first){
      const wait=Math.max(0,nextM15ScanAt(Date.now())-Date.now());
      if(wait>0) await sleep(Math.min(wait,Math.max(0,stopAt-Date.now())));
      if(Date.now()>=stopAt) break;
    }
    first=false;
    for(let attempt=1;attempt<=MAX_CLOSE_RETRIES&&Date.now()<stopAt;attempt+=1){
      const scanAt=Date.now();
      try{
        const r=await withStateLock(()=>scanMarket(scanAt));
        const behind=behindExpectedClose(r,scanAt);
        console.log(JSON.stringify({bot:VERSION,scanner:'OK',at:r?.at,attempt,candidates:r?.candidates?.length||0,errors:r?.errors?.length||0,behind:behind.map(x=>x.symbol)}));
        if(!behind.length) break;
      }catch(e){
        console.error(JSON.stringify({bot:VERSION,scanner:'ERROR',attempt,error:e.message}));
      }
      if(attempt<MAX_CLOSE_RETRIES){
        const remaining=Math.max(0,stopAt-Date.now());
        if(remaining>0) await sleep(Math.min(RETRY_AFTER_MS,remaining));
      }
    }
  }
}

async function run(){
  await tg('deleteWebhook',{drop_pending_updates:false});await setCommands();let offset=0;
  const stopAt=Date.now()+RUNTIME_MS;
  const scannerPromise=scannerLoop(stopAt).catch(e=>console.error(JSON.stringify({bot:VERSION,scanner:'FATAL',error:e.message})));
  const lifecyclePromise=fastLifecycleLoop(stopAt).catch(e=>console.error(JSON.stringify({bot:VERSION,lifecycle:'FATAL',error:e.message})));
  console.log(JSON.stringify({bot:VERSION,status:'STARTING',scanAfterCloseMs:SCAN_AFTER_CLOSE_MS,lifecyclePollMs:LIFECYCLE_POLL_MS,retryAfterMs:RETRY_AFTER_MS,maxCloseRetries:MAX_CLOSE_RETRIES,runtimeMs:RUNTIME_MS}));
  while(Date.now()<stopAt){
    try{
      const us=await getUpdates(offset);
      for(const u of us){
        offset=Math.max(offset,Number(u.update_id)+1);
        if(u.callback_query){
          if(String(u.callback_query.message&&u.callback_query.message.chat&&u.callback_query.message.chat.id)!==CHAT_ID){await answer(u.callback_query.id);continue;}
          await handle(String(u.callback_query.data||''),u.callback_query.id,u.callback_query.message||null);
        }else if(u.message&&String(u.message.chat&&u.message.chat.id)===CHAT_ID){
          const a=normalize(u.message.text); if(a) await handle(a); else await menu();
        }
      }
    }catch(e){console.error(JSON.stringify({bot:VERSION,error:e.message}));await sleep(2500);}
  }
  await Promise.all([scannerPromise,lifecyclePromise]);
  console.log(JSON.stringify({bot:VERSION,status:'ROTATE'}));
}
run().catch(e=>{console.error(JSON.stringify({bot:VERSION,fatal:e.message}));process.exit(1);});
