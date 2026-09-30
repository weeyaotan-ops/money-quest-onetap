'use strict';

const fs=require('fs');

const BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const CHAT_ID=String(process.env.TELEGRAM_CHAT_ID||'');
const STATE_PATH=process.env.HUNTER_ADAPTIVE_STATE_PATH||'.hunter_state/hunter_adaptive_state.json';

if(!BOT_TOKEN||!CHAT_ID){
  console.error('Missing Telegram credentials');
  process.exit(1);
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadState(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_PATH,'utf8'));
    if(!s.trades)s.trades={};
    if(!s.pending)s.pending={};
    if(!Array.isArray(s.blocked))s.blocked=[];
    return s;
  }catch{
    return {trades:{},pending:{},blocked:[],lastScan:null};
  }
}

function sgtDate(ts=Date.now()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts));
  const o={};for(const p of parts)if(p.type!=='literal')o[p.type]=p.value;
  return o.year+'-'+o.month+'-'+o.day;
}

function sgtTime(ts){
  if(!Number.isFinite(Number(ts)))return 'n/a';
  return new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(Number(ts)));
}

function fmt(x,symbol=''){
  const n=Number(x);if(!Number.isFinite(n))return 'n/a';
  if(symbol==='XAUUSD')return n.toFixed(2);
  if(n>=1000)return n.toFixed(2);
  if(n>=10)return n.toFixed(3);
  return n.toFixed(4);
}

function sideCn(side){return side==='LONG'?'做多':side==='SHORT'?'做空':'';}
function kindCn(kind){return kind==='TREND'?'趋势回踩':'区间扫流动性';}
function statusCn(t){
  if(t.terminal){
    if(t.status==='SL')return '❌ 止损';
    if(t.status==='TARGET')return '✅ 到最终目标';
    if(t.status==='RUNNER_EXIT')return '🏁 Runner 已结束';
    if(t.status==='BE_AFTER_TP1')return '🟡 1R后保本结束';
    if(t.status==='AMBIGUOUS')return '⚠️ 同根M15无法判断先后';
    return '✅ 已结束';
  }
  if(t.status==='RUNNER')return '🚀 Runner 进行中';
  if(t.status==='TP1')return '✅ 已到 TP1';
  return '⏳ 进行中';
}

function keyboard(){
  return {inline_keyboard:[
    [{text:'🚨 现在',callback_data:'now'}],
    [{text:'📌 进行中',callback_data:'active'},{text:'📒 记录',callback_data:'records'}],
    [{text:'📊 成绩',callback_data:'results'},{text:'🧠 一键学习',callback_data:'learn'}],
    [{text:'🩺 策略体检',callback_data:'health'},{text:'📡 系统',callback_data:'system'}]
  ]};
}
function home(){return {inline_keyboard:[[{text:'🏠 主页',callback_data:'start'}]]};}
function refresh(action){return {inline_keyboard:[[{text:'🔄 刷新',callback_data:action}],[{text:'🏠 主页',callback_data:'start'}]]};}

function regimeCn(x){
  if(x==='TREND_UP')return '🟢 趋势上涨';
  if(x==='TREND_DOWN')return '🔴 趋势下跌';
  if(x==='RANGE')return '🟡 区间';
  return '⚪ 不做 / 过渡';
}

function nowText(){
  const s=loadState(),scan=s.lastScan;
  const lines=['🚨 现在',''];
  if(!scan)return lines.concat('还没有最新扫描数据。').join('\n');

  if(scan.killSwitch)lines.push('🛑 今日 Kill Switch 已触发 · 今天不再开新单','');
  if((scan.newSignals||[]).length){
    lines.push('✅ 最新确认');
    for(const x of scan.newSignals){
      lines.push((x.side==='LONG'?'🟢 ':'🔴 ')+x.symbol+' · '+sideCn(x.side)+' · '+kindCn(x.kind)+' · '+x.grade);
    }
    lines.push('');
  }

  const pending=Object.values(s.pending||{});
  if(pending.length){
    lines.push('👀 等回踩');
    for(const p of pending.slice(0,5))lines.push(p.symbol+' · '+sideCn(p.side)+' · 关键位 '+fmt(p.breakoutLevel,p.symbol)+' · 不追');
    lines.push('');
  }

  lines.push('市场状态');
  const seen=new Set();
  for(const m of scan.market||[]){
    const key=m.symbol+'|'+m.regime;
    if(seen.has(key))continue;
    seen.add(key);
    lines.push(m.symbol+' · '+regimeCn(m.regime)+(Number.isFinite(m.adx)?' · ADX '+m.adx.toFixed(1):''));
  }

  if((scan.blocked||[]).length){
    lines.push('','⛔ 最近被挡掉');
    for(const b of scan.blocked.slice(-3))lines.push(b.symbol+' · '+b.reason);
  }

  lines.push('','扫描：'+sgtTime(scan.atMs)+' SGT');
  return lines.join('\n');
}

function activeText(){
  const s=loadState();
  const xs=Object.values(s.trades||{}).filter(t=>!t.terminal).sort((a,b)=>Number(b.signalAtMs)-Number(a.signalAtMs));
  if(!xs.length)return '📌 进行中\n\n⚪ 现在没有还在跑的交易。';
  const lines=['📌 进行中',''];
  for(const t of xs){
    lines.push(
      (t.side==='LONG'?'🟢 ':'🔴 ')+t.symbol+' · '+sideCn(t.side)+' · '+t.grade,
      kindCn(t.kind)+' · '+statusCn(t),
      'Entry '+fmt(t.entry,t.symbol)+' · SL '+fmt(t.stop,t.symbol),
      t.kind==='TREND'
        ? 'TP1 '+fmt(t.tp1,t.symbol)+' · TP2 '+fmt(t.tp2,t.symbol)+' · Runner 30%'
        : 'TP1 '+fmt(t.tp1,t.symbol)+' · Final '+fmt(t.finalTarget,t.symbol),
      t.runnerActive&&Number.isFinite(Number(t.runnerStop))?'Runner SL '+fmt(t.runnerStop,t.symbol):null,
      ''
    );
  }
  return lines.filter(Boolean).join('\n');
}

function recordsText(){
  const s=loadState();
  const xs=Object.values(s.trades||{}).sort((a,b)=>Number(b.signalAtMs)-Number(a.signalAtMs));
  if(!xs.length)return '📒 记录\n\n还没有交易记录。';
  const lines=['📒 记录',''];
  for(const t of xs.slice(0,12)){
    const r=Number.isFinite(Number(t.finalR))?(Number(t.finalR)>=0?'+':'')+Number(t.finalR).toFixed(2)+'R':'进行中';
    lines.push(t.symbol+' · '+sideCn(t.side)+' · '+kindCn(t.kind)+' · '+t.grade,'结果：'+r+' · '+statusCn(t),'');
  }
  return lines.join('\n');
}

function finalTrades(){
  return Object.values(loadState().trades||{}).filter(t=>Number.isFinite(Number(t.finalR))).sort((a,b)=>Number(a.signalAtMs)-Number(b.signalAtMs));
}

function groupStats(xs,keyFn){
  const m={};
  for(const t of xs){
    const k=String(keyFn(t)||'UNKNOWN');
    if(!m[k])m[k]=[];
    m[k].push(t);
  }
  return Object.fromEntries(Object.entries(m).map(([k,rows])=>{
    const total=rows.reduce((a,t)=>a+Number(t.finalR),0);
    return [k,{n:rows.length,totalR:total,avgR:rows.length?total/rows.length:null,winRate:rows.length?rows.filter(t=>Number(t.finalR)>0).length/rows.length:null}];
  }));
}

function resultsText(){
  const xs=finalTrades();
  const today=sgtDate();
  const td=xs.filter(t=>sgtDate(Number(t.signalAtMs))===today);
  const sum=rows=>{
    const r=rows.reduce((a,t)=>a+Number(t.finalR),0);
    return {n:rows.length,r,avg:rows.length?r/rows.length:null,w:rows.filter(t=>Number(t.finalR)>0).length};
  };
  const a=sum(td),b=sum(xs);
  return [
    '📊 成绩','',
    '今天',
    '完成 '+a.n+' 单 · 净 '+(a.r>=0?'+':'')+a.r.toFixed(2)+'R'+(a.n?' · Avg '+(a.avg>=0?'+':'')+a.avg.toFixed(2)+'R':''),
    '',
    '全部',
    '完成 '+b.n+' 单 · 净 '+(b.r>=0?'+':'')+b.r.toFixed(2)+'R'+(b.n?' · Avg '+(b.avg>=0?'+':'')+b.avg.toFixed(2)+'R':''),
    b.n?'胜率 '+(b.w/b.n*100).toFixed(1)+'%':'样本不足'
  ].join('\n');
}

function learnText(){
  const xs=finalTrades();
  const lines=['🧠 一键学习',''];
  if(xs.length<12)return lines.concat('⚪ 样本不足\n先让新策略累积至少 12 个完成交易。\n\nLive 不会因为几单输赢自己乱改。').join('\n');

  const pools=[
    ...Object.entries(groupStats(xs,t=>t.symbol)).map(([k,v])=>({name:k,...v})),
    ...Object.entries(groupStats(xs,t=>kindCn(t.kind))).map(([k,v])=>({name:k,...v})),
    ...Object.entries(groupStats(xs,t=>sideCn(t.side))).map(([k,v])=>({name:k,...v})),
    ...Object.entries(groupStats(xs,t=>t.grade)).map(([k,v])=>({name:k+'级',...v}))
  ].filter(x=>x.n>=6&&Number.isFinite(x.avgR));

  pools.sort((a,b)=>b.avgR-a.avgR);
  const strong=pools.filter(x=>x.avgR>0).slice(0,2);
  const weak=[...pools].sort((a,b)=>a.avgR-b.avgR).filter(x=>x.avgR<0).slice(0,2);

  lines.push('Bot 已检查：市场 / Setup / 方向 / Grade');
  if(strong.length){
    lines.push('','💪 当前强项');
    for(const x of strong)lines.push(x.name+' · '+x.n+'单 · Avg '+(x.avgR>=0?'+':'')+x.avgR.toFixed(2)+'R');
  }
  if(weak.length){
    lines.push('','🪫 当前拖累');
    for(const x of weak)lines.push(x.name+' · '+x.n+'单 · Avg '+x.avgR.toFixed(2)+'R');
  }
  lines.push('','下一步');
  if(weak[0]&&weak[0].n>=12&&weak[0].avgR<=-0.20)lines.push('🟡 值得建立 Challenger：暂时排除 '+weak[0].name+'，先做 Shadow 比较。');
  else lines.push('🟢 暂时没有足够证据需要改 Live。');
  lines.push('','不会自动改策略。');
  return lines.join('\n');
}

function healthText(){
  const xs=finalTrades();
  const rs=xs.map(t=>Number(t.finalR));
  const recent=rs.slice(-20);
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  let eq=0,peak=0,dd=0,streak=0,maxStreak=0;
  for(const r of rs){
    eq+=r;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);
    if(r<0){streak++;maxStreak=Math.max(maxStreak,streak);}else streak=0;
  }
  let label='⚪ 样本不足';
  if(xs.length>=20){
    const ra=avg(recent);
    label=ra>=0.15?'🟢 最近表现正常':ra>0?'🟡 优势变薄':avg(rs)>0?'🟠 最近转弱':'🔴 当前样本偏弱';
  }
  return [
    '🩺 策略体检','',label,
    '完成样本：'+xs.length,
    Number.isFinite(avg(rs))?'全部 Avg：'+(avg(rs)>=0?'+':'')+avg(rs).toFixed(2)+'R':'全部 Avg：样本不足',
    Number.isFinite(avg(recent))?'最近'+recent.length+'单：'+(avg(recent)>=0?'+':'')+avg(recent).toFixed(2)+'R':null,
    '最大回撤：'+dd.toFixed(2)+'R',
    '最长连亏：'+maxStreak+'单',
    '',
    xs.length<20?'结论：继续收集，不要因为几单输赢改策略。':'结论：只在长期证据变差时才建立 Challenger。'
  ].filter(Boolean).join('\n');
}

function systemText(){
  const s=loadState(),scan=s.lastScan;
  if(!scan)return '📡 系统\n\n🔴 没有扫描数据。';
  const age=(Date.now()-Number(scan.atMs))/60000;
  return [
    '📡 系统','',
    age<=20?'🟢 正常':'🟠 扫描可能过旧',
    '策略：Hunter Adaptive V1',
    '扫描：'+sgtTime(scan.atMs)+' SGT（'+Math.max(0,age).toFixed(1)+'分钟前）',
    '数据错误：'+((scan.errors||[]).length),
    '今日净R：'+(Number(scan.dayR)>=0?'+':'')+Number(scan.dayR||0).toFixed(2)+'R',
    'Kill Switch：'+(scan.killSwitch?'已触发':'未触发'),
    '',
    '只发信号，不自动下单。'
  ].join('\n');
}

async function tg(method,body){
  const res=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.ok===false)throw new Error('Telegram '+method+' failed');
  return data;
}
async function send(text,reply_markup=keyboard()){
  return tg('sendMessage',{chat_id:CHAT_ID,text,disable_web_page_preview:true,reply_markup});
}
async function ack(id){if(id)await tg('answerCallbackQuery',{callback_query_id:id}).catch(()=>{});}

async function menu(){
  return send([
    'HUNTER ADAPTIVE','',
    '趋势市场 → Breakout 后等 Retest',
    '区间市场 → Sweep + Reclaim',
    '混乱市场 → 不做','',
    'SL 放结构失效位',
    'Trend：1R / 2R / Runner',
    'Range：1R / 区间另一边','',
    'A+ 风险 0.50% · A 风险 0.25%',
    '当天 -2R 自动停止新单'
  ].join('\n'),keyboard());
}

async function action(a,id){
  await ack(id);
  try{
    if(a==='start')return menu();
    if(a==='now')return send(nowText(),refresh('now'));
    if(a==='active')return send(activeText(),refresh('active'));
    if(a==='records')return send(recordsText(),refresh('records'));
    if(a==='results')return send(resultsText(),refresh('results'));
    if(a==='learn')return send(learnText(),refresh('learn'));
    if(a==='health')return send(healthText(),refresh('health'));
    if(a==='system')return send(systemText(),refresh('system'));
    return menu();
  }catch(err){
    console.error(JSON.stringify({action:a,error:err.message}));
    return send('⚠️ 暂时读取失败，等一下再试。',home());
  }
}

function normalize(text){
  const t=String(text||'').trim().toLowerCase().replace(/@\w+$/,'');
  if(['/start','start','/menu','menu'].includes(t))return 'start';
  if(['/now','now','现在'].includes(t))return 'now';
  if(['/active','active','进行中'].includes(t))return 'active';
  if(['/records','records','记录'].includes(t))return 'records';
  if(['/results','results','成绩'].includes(t))return 'results';
  if(['/learn','learn','学习','一键学习'].includes(t))return 'learn';
  if(['/health','health','体检'].includes(t))return 'health';
  if(['/system','system','系统'].includes(t))return 'system';
  return null;
}

async function setCommands(){
  await tg('setMyCommands',{commands:[
    {command:'start',description:'主页'},
    {command:'now',description:'现在'},
    {command:'active',description:'进行中'},
    {command:'records',description:'记录'},
    {command:'results',description:'成绩'},
    {command:'learn',description:'一键学习'},
    {command:'health',description:'策略体检'},
    {command:'system',description:'系统'}
  ]});
}

async function run(){
  await tg('deleteWebhook',{drop_pending_updates:false});
  await setCommands();
  let offset=0;
  while(true){
    try{
      const u=new URL('https://api.telegram.org/bot'+BOT_TOKEN+'/getUpdates');
      u.searchParams.set('timeout','50');
      u.searchParams.set('allowed_updates',JSON.stringify(['message','callback_query']));
      if(offset)u.searchParams.set('offset',String(offset));
      const res=await fetch(u,{signal:AbortSignal.timeout(60000)});
      const body=await res.json();
      for(const x of body.result||[]){
        offset=Math.max(offset,Number(x.update_id)+1);
        if(x.callback_query){
          if(String(x.callback_query.message?.chat?.id||'')===CHAT_ID)await action(String(x.callback_query.data||''),x.callback_query.id);
          else await ack(x.callback_query.id);
        }else if(x.message&&String(x.message.chat?.id||'')===CHAT_ID){
          const a=normalize(x.message.text);
          if(a)await action(a);else await menu();
        }
      }
    }catch(err){
      console.error(JSON.stringify({bot:'Hunter Adaptive',error:err.message}));
      await sleep(2500);
    }
  }
}

run().catch(err=>{console.error(JSON.stringify({fatal:err.message}));process.exit(1);});
