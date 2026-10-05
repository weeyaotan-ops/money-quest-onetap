'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cycle: scanMarket, ensureTradeLifecycle, lifecycleSnapshot, lifecycleEvents, lifecycleMessage, updateTradePrice, entryDecision, queueAlert, flushAlerts, executionPlan, snowballRisk } = require('../adaptive_hunter_monitor');

const BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const CHAT_ID=String(process.env.TELEGRAM_CHAT_ID||'');
const AUTH_USER_ID=String(process.env.TELEGRAM_AUTH_USER_ID||'');
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
const BINANCE_API_KEY=String(process.env.BINANCE_API_KEY||process.env.EXCHANGE_API_KEY||'');
const BINANCE_API_SECRET=String(process.env.BINANCE_API_SECRET||process.env.EXCHANGE_API_SECRET||'');
const BINANCE_ED25519_PRIVATE_KEY_PEM=String(process.env.BINANCE_ED25519_PRIVATE_KEY_PEM||'');
const BINANCE_LIVE_TRADING=String(process.env.BINANCE_LIVE_TRADING||'0')==='1';
const BINANCE_AUTO_BALANCE=String(process.env.BINANCE_AUTO_BALANCE||'1')==='1';

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
  const d={
    BTCUSDT:1,ETHUSDT:2,SOLUSDT:2,XRPUSDT:4,BNBUSDT:2,DOGEUSDT:5,
    LINKUSDT:3,LTCUSDT:2,AVAXUSDT:3,SUIUSDT:4,NEARUSDT:3,ZECUSDT:2,XAUUSD:2
  }[String(symbol||'').toUpperCase()] ?? 4;
  return n.toFixed(d);
}
function fmtZone(z,symbol){
  if(!z||!Number.isFinite(Number(z.low))||!Number.isFinite(Number(z.high))) return 'n/a';
  return fmt(z.low,symbol)+' - '+fmt(z.high,symbol);
}
function biasText(x){ return x==='BULLISH'?'多头':x==='BEARISH'?'空头':'中性'; }
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
function simpleMarketStatus(x){
  const symbol=String(x&&x.symbol||'市场');
  const regime=String(x&&x.regime||'NEUTRAL');
  const side=String(x&&x.side||'');
  if(regime==='CLOSED') return '⚪ '+symbol+' · 休市 · 不下';
  if(regime==='STALE') return '🔴 '+symbol+' · 数据过旧 · 不下';
  if(regime==='CHAOS') return '🔴 '+symbol+' · 市场太乱 · 不下';
  if(regime==='RANGE') return '🟡 '+symbol+' · 区间 · 等扫流动性再收回';
  if(regime==='TREND'&&side){
    const want=side==='LONG'?'BULLISH':'BEARISH';
    const st=x&&x.intelligence&&x.intelligence.structure||{};
    const direction=side==='LONG'?'偏多':'偏空';
    if(st.h4===want&&st.m15===want) return '🟡 '+symbol+' · '+direction+' · 等突破 + 回踩确认';
    if(st.h4===want||st.m15===want) return '🟡 '+symbol+' · '+direction+' · 结构还没完全确认，继续等';
    return '🟡 '+symbol+' · '+direction+' · 结构未确认，先不下';
  }
  return '⚪ '+symbol+' · 暂时没方向 · 等';
}
function modeText(x){ return x==='TREND_RETEST'?'趋势突破回踩':x==='RANGE_SWEEP'?'区间扫流动性':x||''; }
function actionStateText(x,status){
  if(x==='ACTIONABLE') return '等你决定';
  if(x==='OPEN') return '已进场';
  if(x==='EXPIRED') return '太迟了，不做';
  if(x==='MANAGING') return '目标1已到';
  if(x==='RUNNER') return '剩余仓位继续跑';
  if(x==='CLOSED') return '已结束';
  return String(status||x||'追踪中');
}
function keyboard(){
  return {inline_keyboard:[
    [{text:'🚨 现在能不能下',callback_data:'now'}],
    [{text:'📌 我的单',callback_data:'active'},{text:'📊 成绩',callback_data:'results'}],
    [{text:'⚙️ 设置',callback_data:'settings'}]
  ]};
}
function settingsKeyboard(){
  return {inline_keyboard:[
    [{text:'💵 200U',callback_data:'cap:200'},{text:'💵 250U',callback_data:'cap:250'},{text:'💵 300U',callback_data:'cap:300'}],
    [{text:'✏️ 输入实际资金',callback_data:'cap:custom'}],
    [{text:'🌍 市场资料',callback_data:'market'},{text:'🧠 高级分析',callback_data:'intel'}],
    [{text:'📡 系统状态',callback_data:'system'},{text:'📚 学习数据',callback_data:'learn'}],
    [{text:'🏠 主页',callback_data:'start'}]
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
  const s=load(),scan=s.lastScan||{},lines=['🚨 现在能不能下',''];
  if(scan.killed){
    return ['🛑 今天先停','已经碰到今天的亏损保护线。','不要再开新单。'].join('\n');
  }
  const cs=scan.candidates||[];
  if(cs.length){
    for(const x of cs){
      const ex=x.execution||{};
      const side=x.side==='LONG'?'做多 LONG':'做空 SHORT';
      if(ex.costOk===false){
        lines.push('❌ '+x.symbol+' 不做');
        lines.push('原因：'+String(ex.costReason||'手续费和利润不划算'));
        lines.push('');
        continue;
      }
      lines.push('✅ '+x.symbol+' 可以进');
      lines.push('');
      lines.push('方向：'+side);
      if(ex.valid){
        lines.push('逐仓：Isolated');
        lines.push('杠杆：'+ex.leverage+'x');
        lines.push('数量：'+Number(ex.quantity).toFixed(Number(ex.qtyDecimals||0))+' '+String(x.symbol||'').replace('USDT',''));
      }
      lines.push('入场：'+fmt(x.entry,x.symbol));
      lines.push('止损：'+fmt(x.stop,x.symbol));
      lines.push('目标1：'+fmt(x.tp1,x.symbol));
      lines.push('目标2：'+fmt(x.tp2,x.symbol));
      if(x.mode==='TREND_RETEST') lines.push('到目标1卖30% · 目标2再卖30% · 剩40%继续跑');
      if(ex.valid){
        lines.push('风险模式：'+String(ex.riskLabel||'标准滚雪球')+' · '+(Number(ex.riskPct||0.0075)*100).toFixed(2)+'%');
        lines.push('最多亏：约 '+Number(ex.estMaxLoss).toFixed(2)+'U');
        if(x.mode==='TREND_RETEST'){
          lines.push('目标1：到价卖30%');
          lines.push('目标2：到价再卖30%');
          lines.push('剩下40%继续跑');
          if(Number.isFinite(Number(ex.runner3Net))) lines.push('如果剩下跑到约3R：整单约 '+(Number(ex.runner3Net)>=0?'+':'')+Number(ex.runner3Net).toFixed(2)+'U');
        }
      }
      if(Number.isFinite(Number(x.qualityScore))) lines.push('信号强度：'+Number(x.qualityScore).toFixed(0)+'/100');
      if(Number.isFinite(Number(x.entryExpiresAtMs))) lines.push('有效到：'+sgtTime(x.entryExpiresAtMs)+' SGT');
      lines.push('');
    }
    return lines.join('\n');
  }
  const armed=scan.armed||[];
  if(armed.length){
    lines.push('🟡 现在还不能下');
    lines.push('现在：不要下。');
    lines.push('突破已经发生，Bot 正在等回踩确认。');
    for(const x of armed.slice(0,4)) lines.push('• '+x.symbol+' · '+(x.side==='LONG'?'偏多':'偏空')+' · 等回踩');
    return lines.join('\n');
  }
  lines.push('⚪ 现在没有可以下的单');
  lines.push('现在：不要下。');
  const watches=Object.values(s.market||{}).filter(x=>x&&x.regime!=='CLOSED'&&x.regime!=='STALE');
  watches.sort((a,b)=>{
    const score=x=>(x.symbol==='XAUUSD'?3:0)+(x.regime==='TREND'?2:x.regime==='RANGE'?1:0);
    return score(b)-score(a)||String(a.symbol).localeCompare(String(b.symbol));
  });
  if(watches.length){
    lines.push('');
    lines.push('最接近条件：');
    for(const x of watches.slice(0,4)) lines.push(simpleMarketStatus(x));
  }
  lines.push('');
  lines.push('有确认时 Bot 会直接给 Entry / SL / TP。');
  return lines.join('\n');
}
function marketText(){
  const s=load(),xs=Object.values(s.market||{}),lines=['🌍 市场',''];
  if(!xs.length) return lines.concat('还没有最新市场数据。').join('\n');
  xs.sort((a,b)=>String(a.symbol).localeCompare(String(b.symbol)));
  for(const x of xs){
    lines.push(simpleMarketStatus(x));
    lines.push('M15 收盘：'+fmt(x.lastClose,x.symbol)+(Number.isFinite(x.adx)?' · H4 ADX '+Number(x.adx).toFixed(1):''));
    const intel=x.intelligence||{},st=intel.structure||{},liq=intel.liquidity||{},zones=intel.zones||{};
    if(st.h4||st.m15) lines.push('结构：H4 '+biasText(st.h4)+' · M15 '+biasText(st.m15));
    if(Number.isFinite(Number(liq.bsl))||Number.isFinite(Number(liq.ssl))) lines.push('流动性：上方 '+fmt(liq.bsl,x.symbol)+' · 下方 '+fmt(liq.ssl,x.symbol));
    if(zones.invalid){
      lines.push('区域：⚠️ Demand / Supply 重叠 '+Math.round((Number(zones.overlapRatio)||0)*100)+'% · 已忽略');
    }else if(zones.demand||zones.supply){
      lines.push('Demand '+fmtZone(zones.demand,x.symbol)+' · Supply '+fmtZone(zones.supply,x.symbol));
    }
    const lag=Number(x.lagMinutes);
    if(x.regime==='CLOSED') lines.push('数据：'+(x.provider||'n/a')+' · 市场休市（最后收盘）');
    else lines.push('数据：'+(x.provider||'n/a')+(Number.isFinite(lag)?(lag>0.1?' · 落后 '+lag.toFixed(1)+'分钟':' · M15 已同步'):''));
    if(x.regime==='STALE') lines.push('⚠️ 旧数据不会发信号');
    if(x.regime==='CLOSED') lines.push('周末休市，不会发信号');
    lines.push('');
  }
  lines.push('趋势：等突破 + 回踩确认','区间：等扫流动性再收回','Demand / Supply 重叠过多会自动作废','Quality Score 继续只做记录验证，不挡原本有效 signal');
  return lines.join('\n');
}
function intelligenceText(){
  const s=load(),xs=Object.values(s.market||{}),lines=['🧠 HUNTER V2 智能层',''];
  if(!xs.length) return lines.concat('还没有最新市场数据。').join('\n');
  xs.sort((a,b)=>String(a.symbol).localeCompare(String(b.symbol)));
  for(const x of xs){
    const intel=x.intelligence||{},st=intel.structure||{},liq=intel.liquidity||{},zones=intel.zones||{};
    lines.push(simpleMarketStatus(x));
    lines.push('大方向：'+(x.regime==='TREND'?'趋势':x.regime==='RANGE'?'区间':x.regime==='CHAOS'?'混乱':x.regime==='CLOSED'?'休市':'中性')+(x.side?' · '+(x.side==='LONG'?'偏多':'偏空'):''));
    lines.push('结构确认：H4 '+biasText(st.h4)+' · M15 '+biasText(st.m15));
    lines.push('上方流动性：'+fmt(liq.bsl,x.symbol)+' · 下方流动性：'+fmt(liq.ssl,x.symbol));
    if(zones.invalid){
      lines.push('区域：⚠️ Demand / Supply 重叠 '+Math.round((Number(zones.overlapRatio)||0)*100)+'% · Zone Invalid · 不采用');
    }else{
      lines.push('Demand：'+fmtZone(zones.demand,x.symbol));
      lines.push('Supply：'+fmtZone(zones.supply,x.symbol));
    }
    lines.push('');
  }
  lines.push('V2 正在运行：结构 + 流动性 + Supply/Demand + Quality Score');
  lines.push('重叠过多的 Zone 会自动作废；Quality 继续只记录验证，不会挡掉原本有效 signal。');
  return lines.join('\n');
}
function activeText(){
  const s=load(),xs=Object.values(s.trades||{}).filter(x=>!x.terminal).sort((a,b)=>b.signalAtMs-a.signalAtMs);
  const lines=['📌 我的单',''];
  if(!xs.length) return lines.concat('⚪ 现在没有进行中的单。').join('\n');
  for(const x of xs.slice(0,8)){
    lines.push((x.side==='LONG'?'🟢 ':'🔴 ')+x.symbol+' · '+(x.side==='LONG'?'做多':'做空'));
    lines.push('状态：'+actionStateText(x.actionState,x.status));
    if(!x.entryConfirmed){
      const st=String(x.entryStatus||'ENTER');
      if(st==='DO_NOT_CHASE') lines.push('⛔ 现在太贵/太低，不要追');
      else lines.push('⏳ 等你按 One Tap');
      if(Number.isFinite(Number(x.entryExpiresAtMs))) lines.push('最迟：'+sgtTime(x.entryExpiresAtMs)+' SGT');
    }else{
      if(Number.isFinite(Number(x.actualEntryPrice))) lines.push('实际成交价：'+fmt(x.actualEntryPrice,x.symbol));
      lines.push('止损：'+fmt(x.stop,x.symbol));
      lines.push('目标1：'+fmt(x.tp1,x.symbol));
      lines.push('目标2：'+fmt(x.tp2,x.symbol));
      if(x.tp1Hit&&!x.runnerActive) lines.push('✅ 目标1已到，止损已拉到保本');
      if(x.runnerActive) lines.push('🏃 剩下仓位继续跑');
    }
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
  const all=resolvedTrades(),today=sgtDate();
  const wins=all.filter(x=>Number(x.realizedR)>0).length;
  const losses=all.filter(x=>Number(x.realizedR)<0).length;
  const flat=all.length-wins-losses;
  const todayTrades=all.filter(x=>sgtDate(x.signalAtMs)===today);
  const todayWins=todayTrades.filter(x=>Number(x.realizedR)>0).length;
  const todayLosses=todayTrades.filter(x=>Number(x.realizedR)<0).length;
  const wr=all.length?wins/all.length:null;
  const recent=all.slice(-20);
  const recentWins=recent.filter(x=>Number(x.realizedR)>0).length;
  const recentWr=recent.length?recentWins/recent.length:null;
  const a=calcStats(all);
  return [
    '📊 成绩','',
    '完成：'+all.length+' 单',
    '赢：'+wins+' 单',
    '输：'+losses+' 单',
    flat?'打平：'+flat+' 单':null,
    '胜率：'+(Number.isFinite(wr)?(wr*100).toFixed(1)+'%':'还没数据'),
    '',
    '今天：'+todayWins+' 赢 / '+todayLosses+' 输',
    recent.length?'最近 '+recent.length+' 单胜率：'+(recentWr*100).toFixed(1)+'%':null,
    '最长连续亏：'+a.lossStreak+' 单',
    '',
    '这里只看 Bot 策略成绩，不等于 Binance 实际 USDT 盈亏。'
  ].filter(Boolean).join('\n');
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
function snowballUiStatus(state){
  const equity=Math.max(1,Number(state&&state.settings&&state.settings.equityUsdt)||250);
  const peak=Math.max(equity,Number(state&&state.settings&&state.settings.highWaterEquity)||equity);
  const dd=peak>0?(peak-equity)/peak:0;
  if(dd>=0.05) return {label:'🛡️ 保护模式',riskPct:0.005,peak,dd};
  return {label:'🚀 滚雪球 ON',riskPct:0.0075,peak,dd};
}
function settingsText(){
  const s=load();
  const equity=Math.max(1,Number(s.settings&&s.settings.equityUsdt)||250);
  const sb=snowballUiStatus(s);
  return [
    '⚙️ 设置','',
    '交易方式：✋ 手动交易',
    '自动下单：关闭',
    '💰 当前计算资金：'+equity.toFixed(2)+'U',
    '🏔️ 最高资金：'+sb.peak.toFixed(2)+'U',
    sb.label,
    sb.dd>0?'离最高点：-'+(sb.dd*100).toFixed(1)+'%':null,
    '',
    '普通好单：0.75%',
    'A+ 好单：1.00%',
    '跌超 5%：自动降到 0.50%',
    '杠杆：Bot 自动算最低够用 · 最高 10x',
    '',
    'Binance 余额有变化时，按【✏️ 输入实际资金】更新。',
    'Bot 只给你要填的数字，不会替你下单。'
  ].filter(Boolean).join('\n');
}
function systemText(){
  const s=load(),scan=s.lastScan||{},scanAt=Number(scan.at),now=Date.now();
  const equity=Math.max(1,Number(s.settings&&s.settings.equityUsdt)||250);
  const sb=snowballUiStatus(s);
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
    '交易市场：XAU / BTC / ETH / SOL / XRP / BNB / DOGE / LINK / LTC / AVAX / SUI / NEAR / ZEC',
    '本金：'+equity.toFixed(2)+'U',
    'Snowball：ON',
    '资金：手动更新',
    'Risk：'+(sb.riskPct*100).toFixed(2)+'% base · A+最高 1.00%',
    'Leverage：自动选最低够用 · Hard cap 10x',
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
    '✅ 手动进场确认 / Skip：开启',
    '🔄 Live Entry Check：开启',
    '',
    '旧 Session Breakout 已退出 Live。'
  ].filter(Boolean).join('\n');
}
async function menu(){
  const s=load();
  const equity=Math.max(1,Number(s.settings&&s.settings.equityUsdt)||250);
  const sb=snowballUiStatus(s);
  return send([
    'HUNTER','',
    '资金：'+equity.toFixed(2)+'U',
    sb.label,
    '普通单最多亏：约 '+(equity*0.0075).toFixed(2)+'U',
    'A+ 单最多亏：约 '+(equity*0.01).toFixed(2)+'U',
    '',
    '你只需要看 4 个按钮：',
    '🚨 现在能不能下',
    '📌 我的单',
    '📊 成绩',
    '⚙️ 设置',
    '',
    '有好单 Bot 会直接告诉你要填什么数字。'
  ].join('\n'),keyboard());
}
async function setCapital(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<20||n>1000000){
    return send('⚠️ 资金数字不对。\n例如直接输入：268.50',settingsKeyboard());
  }
  const equity=Math.round(n*100)/100;
  return withStateLock(async()=>{
    const s=load();
    if(!s.settings||typeof s.settings!=='object') s.settings={};
    s.settings.equityUsdt=equity;
    s.settings.highWaterEquity=Math.max(equity,Number(s.settings.highWaterEquity)||equity);
    s.settings.awaitingCapital=false;
    s.settings.snowballEnabled=true;
    save(s);
    const peak=Number(s.settings.highWaterEquity);
    const dd=peak>0?(peak-equity)/peak:0;
    const mode=dd>=0.05?'🛡️ 保护模式：下一单最多 0.50%':'🚀 滚雪球：普通 0.75% · A+ 1.00%';
    return send('✅ 资金更新：'+equity.toFixed(2)+'U\n'+mode+'\n下一单会自动重新算数量。',settingsKeyboard());
  });
}
async function beginCapitalInput(){
  await withStateLock(async()=>{
    const s=load();
    if(!s.settings||typeof s.settings!=='object') s.settings={};
    s.settings.awaitingCapital=true;
    save(s);
  });
  return send('✏️ 直接发我你 Binance Futures 现在的实际资金。\n\n例如：268.50',settingsKeyboard());
}
async function handleTextInput(text){
  const raw=String(text||'').trim();
  const direct=raw.match(/^\/?capital\s+([0-9]+(?:\.[0-9]+)?)$/i);
  if(direct) return setCapital(direct[1]);
  const s=load();
  if(s.settings&&s.settings.awaitingCapital){
    const m=raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:u|usdt)?$/i);
    if(m) return setCapital(m[1]);
    return send('只要发数字就可以。\n例如：268.50',settingsKeyboard());
  }
  return null;
}
async function manualBalanceSync(){
  if(!binanceReady()) return send('⚠️ Binance API 还没连接。',settingsKeyboard());
  try{
    const b=await syncBinanceBalance();
    return send('✅ Binance 资金已同步\n钱包：'+b.wallet.toFixed(2)+'U\n可用：'+b.available.toFixed(2)+'U',settingsKeyboard());
  }catch(e){
    return send('❌ Binance 资金同步失败\n'+String(e.message||e),settingsKeyboard());
  }
}
async function handle(action,id,message=null){
  await answer(id);
  try{
    if(String(action||'').startsWith('enter:')||String(action||'').startsWith('skip:')) return tradeAction(action,message);
    if(action==='cap:custom') return beginCapitalInput();
    if(String(action||'').startsWith('cap:')) return setCapital(String(action).split(':')[1]);
    if(action==='start') return menu();
    if(action==='settings') return send(settingsText(),settingsKeyboard());
    if(action==='now') return send(nowText(),back('now'));
    if(action==='market') return send(marketText(),{inline_keyboard:[[{text:'🔄 刷新',callback_data:'market'}],[{text:'⚙️ 返回设置',callback_data:'settings'}]]});
    if(action==='intel') return send(intelligenceText(),{inline_keyboard:[[{text:'🔄 刷新',callback_data:'intel'}],[{text:'⚙️ 返回设置',callback_data:'settings'}]]});
    if(action==='active') return send(activeText(),back('active'));
    if(action==='results') return send(resultsText(),back('results'));
    if(action==='learn') return send(learnText(),{inline_keyboard:[[{text:'🔄 刷新',callback_data:'learn'}],[{text:'⚙️ 返回设置',callback_data:'settings'}]]});
    if(action==='system') return send(systemText(),{inline_keyboard:[[{text:'🔄 刷新',callback_data:'system'}],[{text:'⚙️ 返回设置',callback_data:'settings'}]]});
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
  if(['/settings','settings','设置'].includes(x))return'settings';
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
    {command:'start',description:'主页'},
    {command:'now',description:'现在能不能下'},
    {command:'active',description:'我的单'},
    {command:'results',description:'成绩'},
    {command:'settings',description:'设置'},
    {command:'capital',description:'更新实际资金，例如 /capital 268.5'}
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
  if(symbol==='XAUUSD'){
    try{return await cryptoLivePrice('XAUUSDT');}
    catch(e){return xauLivePrice();}
  }
  return cryptoLivePrice(symbol);
}

function binanceSymbol(symbol){ return symbol==='XAUUSD'?'XAUUSDT':String(symbol||''); }
function binanceReady(){ return Boolean(BINANCE_API_KEY&&(BINANCE_API_SECRET||BINANCE_ED25519_PRIVATE_KEY_PEM)); }
function binanceTradeReady(){ return binanceReady()&&BINANCE_LIVE_TRADING; }
let binanceClockOffsetMs=0;
let exchangeInfoCache={at:0,body:null};

async function syncBinanceClock(){
  const d=await fastJson(BINANCE_BASE+'/fapi/v1/time');
  const serverTime=Number(d&&d.serverTime);
  if(Number.isFinite(serverTime)) binanceClockOffsetMs=serverTime-Date.now();
  return binanceClockOffsetMs;
}
function cleanParams(params){
  const out={};
  for(const [k,v] of Object.entries(params||{})){
    if(v===undefined||v===null||v==='') continue;
    out[k]=typeof v==='boolean'?(v?'true':'false'):String(v);
  }
  return out;
}
async function binanceSignedOnce(method,endpoint,params={}){
  if(!binanceReady()) throw new Error('BINANCE_API_NOT_CONFIGURED');
  const p=cleanParams({...params,timestamp:Date.now()+binanceClockOffsetMs,recvWindow:5000});
  const q=new URLSearchParams(p);
  const payload=q.toString();
  const signature=BINANCE_ED25519_PRIVATE_KEY_PEM
    ? crypto.sign(null,Buffer.from(payload),BINANCE_ED25519_PRIVATE_KEY_PEM).toString('base64')
    : crypto.createHmac('sha256',BINANCE_API_SECRET).update(payload).digest('hex');
  q.set('signature',signature);
  const upper=String(method||'GET').toUpperCase();
  const headers={'X-MBX-APIKEY':BINANCE_API_KEY};
  let url=BINANCE_BASE+endpoint,body;
  if(upper==='GET'||upper==='DELETE') url+='?'+q.toString();
  else{
    headers['content-type']='application/x-www-form-urlencoded';
    body=q.toString();
  }
  const r=await fetch(url,{method:upper,headers,body,signal:AbortSignal.timeout(10000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||Number(d&&d.code)<0){
    const e=new Error('BINANCE '+String(d&&d.code||r.status)+' '+String(d&&d.msg||'request failed'));
    e.code=Number(d&&d.code); e.binance=d; throw e;
  }
  return d;
}
async function binanceSigned(method,endpoint,params={}){
  try{return await binanceSignedOnce(method,endpoint,params);}
  catch(e){
    if(Number(e&&e.code)===-1021){
      await syncBinanceClock();
      return binanceSignedOnce(method,endpoint,params);
    }
    throw e;
  }
}
async function binanceBalance(){
  const rows=await binanceSigned('GET','/fapi/v3/balance');
  const usdt=(Array.isArray(rows)?rows:[]).find(x=>String(x&&x.asset)==='USDT');
  if(!usdt) throw new Error('BINANCE_USDT_BALANCE_MISSING');
  const wallet=Number(usdt.balance),available=Number(usdt.availableBalance);
  if(!Number.isFinite(wallet)||!Number.isFinite(available)) throw new Error('BINANCE_BALANCE_INVALID');
  return {wallet,available,crossWallet:Number(usdt.crossWalletBalance),at:Date.now()};
}
async function syncBinanceBalance(){
  if(!binanceReady()||!BINANCE_AUTO_BALANCE) return null;
  const b=await binanceBalance();
  await withStateLock(async()=>{
    const st=load();
    if(!st.settings||typeof st.settings!=='object') st.settings={};
    st.settings.equityUsdt=Math.max(1,b.wallet);
    st.settings.highWaterEquity=Math.max(b.wallet,Number(st.settings.highWaterEquity)||b.wallet);
    st.settings.balanceSource='BINANCE';
    st.settings.balanceSyncedAtMs=b.at;
    st.settings.availableBalanceUsdt=b.available;
    st.settings.snowballEnabled=true;
    st.settings.awaitingCapital=false;
    save(st);
  });
  return b;
}
async function binanceExchangeInfo(){
  if(exchangeInfoCache.body&&Date.now()-exchangeInfoCache.at<10*60*1000) return exchangeInfoCache.body;
  const body=await fastJson(BINANCE_BASE+'/fapi/v1/exchangeInfo');
  exchangeInfoCache={at:Date.now(),body};
  return body;
}
function decimalsFromStep(step){
  const x=String(step);
  if(!x.includes('.')) return 0;
  return x.replace(/0+$/,'').split('.')[1]?.length||0;
}
function floorToStep(value,step){
  const v=Number(value),s=Number(step);
  if(!(s>0)||!Number.isFinite(v)) return v;
  return Math.floor((v+1e-12)/s)*s;
}
function roundToStep(value,step){
  const v=Number(value),s=Number(step);
  if(!(s>0)||!Number.isFinite(v)) return v;
  return Math.round(v/s)*s;
}
function fixedStep(value,step){
  return Number(value).toFixed(decimalsFromStep(step));
}
async function binanceRules(symbol){
  const ex=await binanceExchangeInfo();
  const bs=binanceSymbol(symbol);
  const row=(ex.symbols||[]).find(x=>x.symbol===bs);
  if(!row||row.status!=='TRADING') throw new Error('BINANCE_SYMBOL_NOT_TRADING '+bs);
  const f=Object.fromEntries((row.filters||[]).map(x=>[x.filterType,x]));
  const lot=f.MARKET_LOT_SIZE||f.LOT_SIZE||{};
  const price=f.PRICE_FILTER||{};
  const notional=f.MIN_NOTIONAL||{};
  return {
    symbol:bs,
    qtyStep:Number(lot.stepSize),
    minQty:Number(lot.minQty),
    maxQty:Number(lot.maxQty),
    tickSize:Number(price.tickSize),
    minNotional:Number(notional.notional||notional.minNotional||0),
    quantityPrecision:Number(row.quantityPrecision),
    pricePrecision:Number(row.pricePrecision)
  };
}
async function binancePositionMode(){
  const d=await binanceSigned('GET','/fapi/v1/positionSide/dual');
  return Boolean(d&&d.dualSidePosition);
}
async function setBinanceIsolated(symbol){
  try{return await binanceSigned('POST','/fapi/v1/marginType',{symbol:binanceSymbol(symbol),marginType:'ISOLATED'});}
  catch(e){ if(Number(e&&e.code)===-4046) return {code:-4046,msg:'already isolated'}; throw e; }
}
async function setBinanceLeverage(symbol,leverage){
  return binanceSigned('POST','/fapi/v1/leverage',{symbol:binanceSymbol(symbol),leverage:Math.max(1,Math.min(5,Math.floor(Number(leverage)||1)))});
}
function clientId(prefix,id){
  return (String(prefix||'H')+'_'+String(id||Date.now()).replace(/[^A-Za-z0-9_-]/g,'')).slice(0,36);
}
async function placeBinanceOrder(params){
  return binanceSigned('POST','/fapi/v1/order',params);
}
async function getBinanceOrderByClientId(symbol,clientOrderId){
  return binanceSigned('GET','/fapi/v1/order',{symbol:binanceSymbol(symbol),origClientOrderId:clientOrderId});
}
async function cancelBinanceOrder(symbol,orderId){
  if(!orderId) return;
  return binanceSigned('DELETE','/fapi/v1/order',{symbol:binanceSymbol(symbol),orderId}).catch(()=>null);
}
async function placeBinanceAlgo(params){
  return binanceSigned('POST','/fapi/v1/algoOrder',params);
}
async function cancelBinanceAlgo(algoId){
  if(!algoId) return;
  return binanceSigned('DELETE','/fapi/v1/algoOrder',{algoId}).catch(()=>null);
}
async function emergencyClose(symbol,side,positionSide,quantity,rules){
  const qty=floorToStep(quantity,rules.qtyStep);
  if(!(qty>=rules.minQty)) return null;
  const p={
    symbol:rules.symbol,
    side:side==='LONG'?'SELL':'BUY',
    type:'MARKET',
    quantity:fixedStep(qty,rules.qtyStep),
    newOrderRespType:'RESULT',
    newClientOrderId:clientId('H_EMERG',Date.now())
  };
  if(positionSide==='BOTH') p.reduceOnly='true';
  else p.positionSide=positionSide;
  return placeBinanceOrder(p);
}
function actualFillPrice(order,fallback){
  const avg=Number(order&&order.avgPrice);
  if(avg>0) return avg;
  const qty=Number(order&&order.executedQty),quote=Number(order&&order.cumQuote);
  if(qty>0&&quote>0) return quote/qty;
  return Number(fallback);
}
function splitExitQty(total,rules,mode){
  const fractions=mode==='TREND_RETEST'?[0.30,0.30]:[0.50,0.50];
  const q1=floorToStep(total*fractions[0],rules.qtyStep);
  const q2=floorToStep(total*fractions[1],rules.qtyStep);
  const remainder=Math.max(0,total-q1-q2);
  if(q1<rules.minQty||q2<rules.minQty) throw new Error('仓位太小，无法自动分批止盈');
  return {q1,q2,remainder};
}
async function executeOneTap(t,quotePrice){
  if(!binanceTradeReady()) throw new Error('BINANCE_LIVE_TRADING_NOT_READY');
  if(t.symbol==='XAUUSD'&&String(t.provider||'')!=='BINANCE_XAUUSDT') throw new Error('XAU 当前 signal 不是 Binance XAUUSDT 数据，One Tap 已安全阻止');
  const b=await syncBinanceBalance();
  const st=load();
  const equity=Math.max(1,Number(st.settings&&st.settings.equityUsdt)||b.wallet);
  const peak=Math.max(equity,Number(st.settings&&st.settings.highWaterEquity)||equity);
  const risk=snowballRisk(t,equity,peak);
  const liveSignal={...t,entry:Number(quotePrice)};
  const plan=executionPlan(liveSignal,equity,risk.riskPct);
  if(!plan.valid||!plan.costOk) throw new Error('现在成本不划算：'+String(plan.costReason||'SKIP'));
  const rules=await binanceRules(t.symbol);
  let quantity=floorToStep(plan.quantity,rules.qtyStep);
  if(!(quantity>=rules.minQty)) throw new Error('仓位低于 Binance 最小数量');
  if(quantity*Number(quotePrice)<rules.minNotional) throw new Error('仓位低于 Binance 最小下单金额');
  const initialMargin=quantity*Number(quotePrice)/Math.max(1,plan.leverage);
  if(initialMargin>b.available*0.95) throw new Error('可用资金不足，不能安全下这单');

  const hedge=await binancePositionMode();
  const positionSide=hedge?(t.side==='LONG'?'LONG':'SHORT'):'BOTH';
  const existing=await binanceSigned('GET','/fapi/v3/positionRisk',{symbol:rules.symbol});
  const existingRows=Array.isArray(existing)?existing:[existing];
  if(existingRows.some(x=>Math.abs(Number(x&&x.positionAmt)||0)>=rules.minQty)){
    throw new Error('这个币已经有持仓，One Tap 不会自动叠加仓位');
  }
  await setBinanceIsolated(t.symbol);
  await setBinanceLeverage(t.symbol,plan.leverage);
  const entrySide=t.side==='LONG'?'BUY':'SELL';
  const exitSide=t.side==='LONG'?'SELL':'BUY';
  const entryParams={
    symbol:rules.symbol,side:entrySide,type:'MARKET',
    quantity:fixedStep(quantity,rules.qtyStep),
    newOrderRespType:'RESULT',
    newClientOrderId:clientId('H_ENTRY',t.signalId)
  };
  if(hedge) entryParams.positionSide=positionSide;
  let entryOrder=null;
  try{ entryOrder=await placeBinanceOrder(entryParams); }
  catch(e){
    // If the HTTP response was lost after Binance accepted the order, recover it by deterministic client id.
    await sleep(350);
    entryOrder=await getBinanceOrderByClientId(t.symbol,entryParams.newClientOrderId).catch(()=>null);
    if(!entryOrder) throw e;
  }
  const filledQty=floorToStep(Number(entryOrder.executedQty)||quantity,rules.qtyStep);
  const fillPrice=actualFillPrice(entryOrder,quotePrice);
  let stopOrder=null,tp1Order=null,tp2Order=null;
  try{
    const stopPrice=roundToStep(Number(t.stop),rules.tickSize);
    const tp1Price=roundToStep(Number(t.tp1),rules.tickSize);
    const tp2Price=roundToStep(Number(t.tp2),rules.tickSize);
    stopOrder=await placeBinanceAlgo({
      algoType:'CONDITIONAL',symbol:rules.symbol,side:exitSide,
      positionSide,type:'STOP_MARKET',
      triggerPrice:fixedStep(stopPrice,rules.tickSize),
      closePosition:'true',workingType:'MARK_PRICE',
      clientAlgoId:clientId('H_SL',t.signalId)
    });
    const split=splitExitQty(filledQty,rules,t.mode);
    const tpBase={symbol:rules.symbol,side:exitSide,type:'LIMIT',timeInForce:'GTC'};
    if(hedge) tpBase.positionSide=positionSide;
    else tpBase.reduceOnly='true';
    tp1Order=await placeBinanceOrder({
      ...tpBase,quantity:fixedStep(split.q1,rules.qtyStep),price:fixedStep(tp1Price,rules.tickSize),
      newClientOrderId:clientId('H_TP1',t.signalId)
    });
    tp2Order=await placeBinanceOrder({
      ...tpBase,quantity:fixedStep(split.q2,rules.qtyStep),price:fixedStep(tp2Price,rules.tickSize),
      newClientOrderId:clientId('H_TP2',t.signalId)
    });
    return {
      balance:b,plan:{...plan,riskLabel:risk.label},rules,hedge,positionSide,
      entryOrder,entryOrderId:entryOrder.orderId,filledQty,fillPrice,
      stopAlgoId:stopOrder.algoId||stopOrder.orderId||null,
      tp1OrderId:tp1Order.orderId||null,tp2OrderId:tp2Order.orderId||null,
      stopPrice,tp1Price,tp2Price
    };
  }catch(e){
    await cancelBinanceOrder(t.symbol,tp1Order&&tp1Order.orderId);
    await cancelBinanceOrder(t.symbol,tp2Order&&tp2Order.orderId);
    await cancelBinanceAlgo(stopOrder&&(stopOrder.algoId||stopOrder.orderId));
    await emergencyClose(t.symbol,t.side,positionSide,filledQty,rules).catch(()=>null);
    throw new Error('保护单设置失败，已尝试紧急平仓：'+e.message);
  }
}
async function binancePositionQty(t){
  if(!t||!t.binance) return 0;
  const rows=await binanceSigned('GET','/fapi/v3/positionRisk',{symbol:t.binance.symbol||binanceSymbol(t.symbol)});
  const xs=Array.isArray(rows)?rows:[rows];
  const ps=String(t.binance.positionSide||'BOTH');
  const row=xs.find(x=>String(x&&x.positionSide||'BOTH')===ps)||xs[0];
  return Math.abs(Number(row&&row.positionAmt)||0);
}
async function replaceAutoStop(t,triggerPrice,label='BE'){
  if(!t||!t.autoManaged||!t.binance) return false;
  const rules=await binanceRules(t.symbol);
  const price=roundToStep(Number(triggerPrice),rules.tickSize);
  if(!(price>0)) return false;
  const old=t.binance.slAlgoId;
  const side=t.side==='LONG'?'SELL':'BUY';
  const newStop=await placeBinanceAlgo({
    algoType:'CONDITIONAL',
    symbol:rules.symbol,
    side,
    positionSide:t.binance.positionSide||'BOTH',
    type:'STOP_MARKET',
    triggerPrice:fixedStep(price,rules.tickSize),
    closePosition:'true',
    workingType:'MARK_PRICE',
    clientAlgoId:clientId('H_'+label,t.signalId+'_'+Date.now().toString(36))
  });
  t.binance.slAlgoId=newStop.algoId||newStop.orderId||null;
  t.binance.exchangeStopPrice=price;
  if(old&&old!==t.binance.slAlgoId) await cancelBinanceAlgo(old);
  return true;
}
async function syncAutoProtection(t,state){
  if(!t||!t.autoManaged||!t.binance||t.terminal) return;
  if(t.tp1Hit&&!t.binance.beStopSynced){
    try{
      await replaceAutoStop(t,t.entry,'BE');
      t.binance.beStopSynced=true;
    }catch(e){
      if(state) queueAlert(state,'AUTO_BE_FAIL|'+t.key,'⚠️ '+t.symbol+' 保本止损同步失败，请检查 Binance。',Date.now());
      console.error(JSON.stringify({bot:VERSION,autoProtect:'BE_FAIL',symbol:t.symbol,error:e.message}));
    }
  }
  if(t.runnerActive&&Number.isFinite(Number(t.runnerTrail))){
    const next=Number(t.runnerTrail),last=Number(t.binance.runnerStopSynced);
    const rules=await binanceRules(t.symbol);
    if(!Number.isFinite(last)||Math.abs(next-last)>=rules.tickSize*0.5){
      try{
        await replaceAutoStop(t,next,'TRAIL');
        t.binance.runnerStopSynced=next;
      }catch(e){
        console.error(JSON.stringify({bot:VERSION,autoProtect:'TRAIL_FAIL',symbol:t.symbol,error:e.message}));
      }
    }
  }
}
async function cleanupAutoIfFlat(t){
  if(!t||!t.autoManaged||!t.binance) return;
  try{
    const q=await binancePositionQty(t);
    if(q>0) return;
    await Promise.all([
      cancelBinanceOrder(t.symbol,t.binance.tp1OrderId),
      cancelBinanceOrder(t.symbol,t.binance.tp2OrderId),
      cancelBinanceAlgo(t.binance.slAlgoId)
    ]);
    t.binance.cleanedAtMs=Date.now();
  }catch(e){
    console.error(JSON.stringify({bot:VERSION,autoCleanup:'ERROR',symbol:t.symbol,error:e.message}));
  }
}
function entryStateAlert(t,d){
  const p=Number(d&&d.price);
  const nowPrice=Number.isFinite(p)?fmt(p,t.symbol):'n/a';
  if(d.state==='DO_NOT_CHASE'){
    return ['⛔ 先别进 '+t.symbol,'','现在价格：'+nowPrice,'跑太远了，不要追。','等价格回来，Bot 会再通知。'].join('\n');
  }
  if(d.state==='ENTER'){
    return ['✅ '+t.symbol+' 价格回来了','','现在价格：'+nowPrice,'现在又可以考虑进。','成交后按【✅ 已进场】。'].join('\n');
  }
  if(d.state==='EXPIRED') return ['⌛ '+t.symbol+' 太迟了','','这单不要了。','等下一单。'].join('\n');
  if(d.state==='INVALID') return ['❌ '+t.symbol+' 这单失效','','价格已经走坏。','不要进。'].join('\n');
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
        t.status='SKIPPED_USER';
        t.actionState='CLOSED';
        t.terminal=true;
        t.skippedReason='USER';
        t.skippedAtMs=Date.now();
        t.realizedR=null;
        t.autoTradePending=false;
        t.autoManaged=false;
        save(state);
      }
    });
    await clearSignalButtons(message);
    if(!t) return send('⚠️ 找不到这单，可能已经过期。',keyboard());
    return send('⏭️ 已放弃 '+t.symbol+'。\n这单不会再通知你。',keyboard());
  }

  const preview=load();
  const pTrade=findTradeBySignalId(preview,id);
  if(!pTrade) return send('⚠️ 找不到这条 signal，可能已经过期。',keyboard());
  if(pTrade.terminal) return send('这单已经结束，不能再进。',keyboard());
  if(pTrade.entryConfirmed) return send('✅ '+pTrade.symbol+' 已经记录为已进场。',keyboard());

  let quote=null;
  try{ quote=await livePrice(pTrade.symbol); }
  catch(e){ return send('⚠️ 暂时拿不到 '+pTrade.symbol+' 现在价格，先不要进。等几秒再按。',keyboard()); }

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
      t.autoTradePending=false;
      t.autoManaged=false;
      t.lastOpenTime=Math.floor(now/M15_MS)*M15_MS;
      confirmed={...t};
      save(state);
    }else if(['EXPIRED','INVALID'].includes(result.state)){
      t.entryStatus=result.state;
      t.status=result.state;
      t.actionState='CLOSED';
      t.terminal=true;
      t.realizedR=null;
      t.autoTradePending=false;
      t.autoManaged=false;
      save(state);
    }else{
      t.entryStatus=result.state;
      save(state);
    }
  });

  if(result&&result.state==='ENTER'&&confirmed){
    await clearSignalButtons(message);
    return send([
      '✅ 已记录手动进场','',
      confirmed.symbol+' · '+sideText(confirmed.side),
      '确认时价格：'+fmt(confirmed.actualEntryPrice,confirmed.symbol),
      '止损：'+fmt(confirmed.stop,confirmed.symbol),
      '目标1：'+fmt(confirmed.tp1,confirmed.symbol),
      '目标2：'+fmt(confirmed.tp2,confirmed.symbol),
      '',
      'Bot 不会操作你的 Binance。',
      '从现在开始只帮你盯止损和目标。'
    ].join('\n'),keyboard());
  }
  if(result&&['DO_NOT_CHASE','EXPIRED','INVALID'].includes(result.state)){
    if(['EXPIRED','INVALID'].includes(result.state)) await clearSignalButtons(message);
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
        if(shouldAlert) queueAlert(state,'ENTRY|'+t.key+'|'+d.state+'|'+now,entryStateAlert(t,d),now);
        continue;
      }
      const before=lifecycleSnapshot(t);
      updateTradePrice(t,px,now);
      if(t.autoManaged){
        try{await syncAutoProtection(t,state);}
        catch(e){console.error(JSON.stringify({bot:VERSION,autoProtect:'ERROR',symbol:t.symbol,error:e.message}));}
      }
      const events=lifecycleEvents(before,t);
      for(const event of events){
        queueAlert(state,'LIVE|TRADE|'+t.key+'|'+event,lifecycleMessage(t,event),now);
      }
      if(t.autoManaged&&t.terminal){
        await cleanupAutoIfFlat(t);
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
  console.log(JSON.stringify({bot:VERSION,status:'STARTING',scanAfterCloseMs:SCAN_AFTER_CLOSE_MS,lifecyclePollMs:LIFECYCLE_POLL_MS,retryAfterMs:RETRY_AFTER_MS,maxCloseRetries:MAX_CLOSE_RETRIES,runtimeMs:RUNTIME_MS,executionMode:'MANUAL',liveTrading:false,autoBalance:false}));
  while(Date.now()<stopAt){
    try{
      const us=await getUpdates(offset);
      for(const u of us){
        offset=Math.max(offset,Number(u.update_id)+1);
        if(u.callback_query){
          const chatOk=String(u.callback_query.message&&u.callback_query.message.chat&&u.callback_query.message.chat.id)===CHAT_ID;
          const userOk=!AUTH_USER_ID||String(u.callback_query.from&&u.callback_query.from.id)===AUTH_USER_ID;
          if(!chatOk||!userOk){await answer(u.callback_query.id);continue;}
          await handle(String(u.callback_query.data||''),u.callback_query.id,u.callback_query.message||null);
        }else if(u.message&&String(u.message.chat&&u.message.chat.id)===CHAT_ID&&(!AUTH_USER_ID||String(u.message.from&&u.message.from.id)===AUTH_USER_ID)){
          const handled=await handleTextInput(u.message.text);
          if(handled) continue;
          const a=normalize(u.message.text); if(a) await handle(a); else await menu();
        }
      }
    }catch(e){console.error(JSON.stringify({bot:VERSION,error:e.message}));await sleep(2500);}
  }
  await Promise.all([scannerPromise,lifecyclePromise]);
  console.log(JSON.stringify({bot:VERSION,status:'ROTATE'}));
}
run().catch(e=>{console.error(JSON.stringify({bot:VERSION,fatal:e.message}));process.exit(1);});
