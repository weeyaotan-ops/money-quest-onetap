'use strict';

const fs = require('fs');
const { cycle: scanMarket } = require('../adaptive_hunter_monitor');

const BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const CHAT_ID=String(process.env.TELEGRAM_CHAT_ID||'');
const STATE_PATH=process.env.ADAPTIVE_STATE_PATH||'.hunter_state/adaptive_state.json';
const VERSION='HUNTER_ADAPTIVE_V1_2026-10-01';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SCAN_EVERY_MS=Number(process.env.ADAPTIVE_SCAN_EVERY_MS||180000);
const RUNTIME_MS=Number(process.env.ADAPTIVE_RUNTIME_MS||18600000);

if(!BOT_TOKEN||!CHAT_ID){ console.error('Missing Telegram credentials'); process.exit(1); }

function load(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_PATH,'utf8'));
    return s&&typeof s==='object'?s:{};
  }catch{return {};}
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
function sideText(x){ return x==='LONG'?'做多':x==='SHORT'?'做空':''; }
function regimeText(x){
  if(x==='TREND') return '🟢 趋势';
  if(x==='RANGE') return '🟡 区间';
  if(x==='CHAOS') return '🔴 混乱';
  if(x==='STALE') return '🔴 数据过旧';
  return '⚪ 中性';
}
function modeText(x){ return x==='TREND_RETEST'?'趋势突破回踩':x==='RANGE_SWEEP'?'区间扫流动性':x||''; }
function keyboard(){
  return {inline_keyboard:[
    [{text:'🚨 现在',callback_data:'now'}],
    [{text:'🌍 市场',callback_data:'market'},{text:'📌 进行中',callback_data:'active'}],
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
      lines.push((x.side==='LONG'?'🟢 ':'🔴 ')+x.symbol+' · '+sideText(x.side));
      lines.push(modeText(x.mode));
      lines.push('进场 '+fmt(x.entry,x.symbol)+' · SL '+fmt(x.stop,x.symbol));
      lines.push('目标1 '+fmt(x.tp1,x.symbol)+' · 目标2 '+fmt(x.tp2,x.symbol));
      lines.push('');
    }
  }else lines.push('⚪ 现在没有新的确认信号','');
  const armed=scan.armed||[];
  if(armed.length){
    lines.push('👀 等回踩');
    for(const x of armed.slice(0,5)) lines.push(x.symbol+' '+sideText(x.side)+' · '+x.session);
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
    lines.push('现价 '+fmt(x.lastClose,x.symbol)+(Number.isFinite(x.adx)?' · H4 ADX '+Number(x.adx).toFixed(1):''));
    lines.push('数据 '+(x.provider||'n/a')+(Number.isFinite(x.lagMinutes)?' · 延迟 '+Number(x.lagMinutes).toFixed(1)+'分钟':''));
    if(x.regime==='STALE') lines.push('⚠️ 旧数据不会发信号');
    lines.push('');
  }
  lines.push('趋势 → 等突破回踩','区间 → 等扫流动性再收回','混乱/中性 → 不做');
  return lines.join('\n');
}
function activeText(){
  const s=load(),xs=Object.values(s.trades||{}).filter(x=>!x.terminal).sort((a,b)=>b.signalAtMs-a.signalAtMs);
  const lines=['📌 进行中',''];
  if(!xs.length) return lines.concat('⚪ 没有正在追踪的信号。').join('\n');
  for(const x of xs.slice(0,8)){
    lines.push((x.side==='LONG'?'🟢 ':'🔴 ')+x.symbol+' · '+sideText(x.side));
    lines.push(modeText(x.mode)+' · '+String(x.status||'OPEN'));
    lines.push('Entry '+fmt(x.entry,x.symbol)+' · SL '+fmt(x.stop,x.symbol));
    lines.push('TP1 '+fmt(x.tp1,x.symbol)+' · TP2 '+fmt(x.tp2,x.symbol));
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
    '只统计 Hunter Adaptive V1。'
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
    ...cohort(xs,x=>x.session).map(x=>({...x,type:'Session'}))
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
  const s=load(),scan=s.lastScan||{},age=Number(scan.at)?(Date.now()-Number(scan.at))/60000:null;
  const errs=scan.errors||[];
  const stale=Object.values(s.market||{}).filter(x=>x.regime==='STALE');
  return [
    '📡 系统','',
    '策略：Hunter Adaptive V1',
    '模式：Signal only',
    '自动下单：关闭',
    '交易市场：XAUUSD / BTC / ETH',
    'Risk：0.5% / signal',
    'Daily kill：-2R',
    '',
    '最后扫描：'+sgtTime(scan.at)+' SGT',
    Number.isFinite(age)?'扫描年龄：'+age.toFixed(1)+'分钟':null,
    Number.isFinite(age)&&age>8?'🚨 Scanner 可能卡住':'🟢 Scanner：持续扫描中',
    stale.length?'⚠️ 旧数据：'+stale.map(x=>x.symbol+'('+Number(x.lagMinutes||0).toFixed(0)+'m)').join(' / '):null,
    errs.length?'⚠️ 数据问题：'+errs.map(x=>x.symbol).join(' / '):'🟢 数据源：正常',
    scan.killed?'🛑 今日新信号已暂停':'🟢 今日风险开关：正常',
    '',
    '旧 Session Breakout 已退出 Live。'
  ].filter(Boolean).join('\n');
}
async function menu(){
  return send([
    'HUNTER ADAPTIVE V1','',
    '趋势：突破后等回踩才进',
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
async function handle(action,id){
  await answer(id);
  try{
    if(action==='start') return menu();
    if(action==='now') return send(nowText(),back('now'));
    if(action==='market') return send(marketText(),back('market'));
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
    {command:'active',description:'进行中的信号'},
    {command:'results',description:'策略成绩'},
    {command:'learn',description:'自动学习'},
    {command:'system',description:'系统状态'}
  ]});
}
let scannerBusy=false;
async function scannerLoop(stopAt){
  while(Date.now()<stopAt){
    if(!scannerBusy){
      scannerBusy=true;
      try{
        const r=await scanMarket(Date.now());
        console.log(JSON.stringify({bot:VERSION,scanner:'OK',at:r?.at,candidates:r?.candidates?.length||0,errors:r?.errors?.length||0}));
      }catch(e){
        console.error(JSON.stringify({bot:VERSION,scanner:'ERROR',error:e.message}));
      }finally{
        scannerBusy=false;
      }
    }
    const remaining=Math.max(0,stopAt-Date.now());
    if(remaining>0) await sleep(Math.min(SCAN_EVERY_MS,remaining));
  }
}

async function run(){
  await tg('deleteWebhook',{drop_pending_updates:false});await setCommands();let offset=0;
  const stopAt=Date.now()+RUNTIME_MS;
  const scannerPromise=scannerLoop(stopAt).catch(e=>console.error(JSON.stringify({bot:VERSION,scanner:'FATAL',error:e.message})));
  console.log(JSON.stringify({bot:VERSION,status:'STARTING',scannerEveryMs:SCAN_EVERY_MS,runtimeMs:RUNTIME_MS}));
  while(Date.now()<stopAt){
    try{
      const us=await getUpdates(offset);
      for(const u of us){
        offset=Math.max(offset,Number(u.update_id)+1);
        if(u.callback_query){
          if(String(u.callback_query.message&&u.callback_query.message.chat&&u.callback_query.message.chat.id)!==CHAT_ID){await answer(u.callback_query.id);continue;}
          await handle(String(u.callback_query.data||''),u.callback_query.id);
        }else if(u.message&&String(u.message.chat&&u.message.chat.id)===CHAT_ID){
          const a=normalize(u.message.text); if(a) await handle(a); else await menu();
        }
      }
    }catch(e){console.error(JSON.stringify({bot:VERSION,error:e.message}));await sleep(2500);}
  }
  await scannerPromise;
  console.log(JSON.stringify({bot:VERSION,status:'ROTATE'}));
}
run().catch(e=>{console.error(JSON.stringify({bot:VERSION,fatal:e.message}));process.exit(1);});
