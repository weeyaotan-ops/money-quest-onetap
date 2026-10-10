'use strict';
// 24/7 major-crypto signal-only scanner. NO account access or order execution.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {initScorecard,createTrade,applyBars,stats:scoreStats}=require('./pulse_scorecard');
const {initialize:initializeHitAlerts,collect:collectHitAlerts,deliver:deliverHitAlerts}=require('./pulse_hit_alerts');
const API=process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com';
const TOKEN=process.env.TELEGRAM_BOT_TOKEN,CHAT=process.env.TELEGRAM_CHAT_ID;
const STORE=process.env.OPPORTUNITY_STATE_PATH||'/data/opportunity_signals.json';
const POLL=Math.max(60000,Number(process.env.OPPORTUNITY_POLL_MS)||60000);
const COINS=(process.env.OPPORTUNITY_SYMBOLS||'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,SUIUSDT,NEARUSDT,ZECUSDT,APTUSDT,ATOMUSDT,BCHUSDT,TRXUSDT,ETCUSDT,UNIUSDT,FILUSDT,ICPUSDT,HBARUSDT,OPUSDT,ARBUSDT,INJUSDT').split(',').map(x=>x.trim()).filter(Boolean);

const ALT_SLOTS=Math.max(0,Math.min(12,Number(process.env.OPPORTUNITY_ALT_SLOTS)||10));
const ALT_REFRESH_MS=10*60000;
let altCache={symbols:[],hot:[],early:[],preScreen:[],hotDetails:[],earlyDetails:[],updatedAt:0,error:null};
// Alternative-coin radar uses only active USDT perpetuals with liquid order books.
// It does not send a trade until the existing M15 breakout system confirms one.
function selectAltcoins(tickers,exchange,books,core=COINS,now=Date.now(),slots=ALT_SLOTS){
 const listed=new Map((exchange.symbols||[]).filter(x=>x.status==='TRADING'&&
   x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT').map(x=>[x.symbol,x]));
 const orderbook=new Map((books||[]).map(x=>[x.symbol,x]));
 const existing=new Set(core);
 const selected=(tickers||[]).filter(x=>{
  if(!listed.has(x.symbol)||existing.has(x.symbol)||!/^[A-Z0-9]+USDT$/.test(x.symbol))return false;
  const listing=listed.get(x.symbol),book=orderbook.get(x.symbol);
  const volume=Number(x.quoteVolume),move=Math.abs(Number(x.priceChangePercent)),trades=Number(x.count);
  const bid=Number(book?.bidPrice),ask=Number(book?.askPrice);
  const listedFor=now-Number(listing.onboardDate);
  const spread=100*(ask-bid)/((ask+bid)/2);
  return volume>=20000000&&move>=8&&move<=120&&trades>=3000&&
    listedFor>=5*86400000&&ask>bid&&bid>0&&spread<=0.20;
 }).map(x=>{
  const volume=Number(x.quoteVolume),move=Math.abs(Number(x.priceChangePercent));
  return {symbol:x.symbol,changePct:Number(x.priceChangePercent),volume,
    rank:move+Math.log10(volume/1000000)*4};
 });
 // Give a qualifying OGNUSDT a reserved slot so the requested coin is never
 // crowded out by unrelated movers; OGN must still pass every risk filter.
 selected.sort((a,b)=>(b.symbol==='OGNUSDT')-(a.symbol==='OGNUSDT')||
   b.rank-a.rank||a.symbol.localeCompare(b.symbol));
 return selected.slice(0,slots);
}
// Early Movers: liquid but not yet heavily extended (0.8% to <8% 24h change).
// 24h ticker is pre-screen only; a completed hourly bar must show both
// extra volume and price near a recent breakout level before it is watchlisted.
function earlyPool(tickers,exchange,books,excluded,now=Date.now(),limit=24){
 const listed=new Map((exchange.symbols||[]).filter(x=>x.status==='TRADING'&&
   x.quoteAsset==='USDT'&&x.contractType==='PERPETUAL').map(x=>[x.symbol,x]));
 const orderbook=new Map((books||[]).map(x=>[x.symbol,x]));
 const skip=new Set(excluded);
 return (tickers||[]).filter(x=>{
  if(skip.has(x.symbol)||!listed.has(x.symbol)||!/^[A-Z0-9]+USDT$/.test(x.symbol))return false;
  const vol=Number(x.quoteVolume),move=Math.abs(Number(x.priceChangePercent));
  const count=Number(x.count),book=orderbook.get(x.symbol),bid=Number(book?.bidPrice),ask=Number(book?.askPrice);
  const spread=(ask-bid)*200/(ask+bid);
  return vol>=25000000&&Number.isFinite(move)&&move>=0.8&&move<8&&count>=3000&&
    now-Number(listed.get(x.symbol).onboardDate)>=5*86400000&&
    bid>0&&ask>bid&&spread<=0.15;
 }).sort((a,b)=>{
  const rank=x=>Math.log10(Number(x.quoteVolume)/1000000)*4+Math.abs(Number(x.priceChangePercent));
  return rank(b)-rank(a)||a.symbol.localeCompare(b.symbol);
 }).slice(0,limit);
}
function analyzeEarlyBars(raw,now=Date.now()){
 if(!Array.isArray(raw))return null;
 const bars=rows(raw).filter(x=>x.t+3600000<=now);
 if(bars.length<18)return null;
 const recent=bars.at(-1),previous=bars.slice(-13,-1);
 const avg=previous.slice(-8).reduce((a,b)=>a+b.v,0)/8;
 const ratio=recent.v/avg,range=atr(bars,14);
 if(!(avg>0)||!(range>0)||!Number.isFinite(ratio)||ratio<1.2)return null;
 const high=Math.max(...previous.map(x=>x.h)),low=Math.min(...previous.map(x=>x.l));
 const nearHigh=(high-recent.c)/range,nearLow=(recent.c-low)/range;
 // No chasing an hourly bar that has already exploded far beyond its previous range.
 const notExtended=Math.abs(recent.c-recent.o)<=2.2*range;
 const up=notExtended&&recent.c>previous.at(-1).c&&nearHigh>=-0.35&&nearHigh<=0.75;
 const down=notExtended&&recent.c<previous.at(-1).c&&nearLow>=-0.35&&nearLow<=0.75;
 if(!up&&!down)return null;
 const side=up&&(!down||nearHigh<=nearLow)?'WATCH LONG':'WATCH SHORT';
 const gap=side==='WATCH LONG'?nearHigh:nearLow;
 return {side,volumeRatio:ratio,gapAtr:gap,barClosedAt:recent.t+3600000};
}
function selectEarlyMovers(tickers,exchange,books,barsBySymbol,exclude=COINS,
  now=Date.now(),slots=8){
 const pool=earlyPool(tickers,exchange,books,exclude,now);
 return pool.map(x=>{
  const setup=analyzeEarlyBars(barsBySymbol[x.symbol],now);
  if(!setup)return null;
  const pct=Number(x.priceChangePercent),volume=Number(x.quoteVolume);
  return {symbol:x.symbol,changePct:pct,volume,...setup,
    rank:setup.volumeRatio*5+Math.log10(volume/1000000)*3+
      Math.abs(pct)*0.3-Math.max(0,setup.gapAtr)*2};
 }).filter(Boolean).sort((a,b)=>b.rank-a.rank||a.symbol.localeCompare(b.symbol))
  .slice(0,Math.max(0,slots));
}
async function optionalOiChange(symbol){
 try{
  // Binance can deny historical OI in some regions; this is NEVER a hard gate.
  const url=API+'/futures/data/openInterestHist?symbol='+encodeURIComponent(symbol)+
    '&period=1h&limit=2';
  const r=await fetch(url,{signal:AbortSignal.timeout(2500)});
  if(!r.ok)return null;
  const j=await r.json();
  const a=Number(j?.[0]?.sumOpenInterestValue),b=Number(j?.at(-1)?.sumOpenInterestValue);
  return Array.isArray(j)&&j.length>=2&&a>0&&Number.isFinite(b)?
    Math.round((b/a-1)*10000)/100:null;
 }catch{return null;}
}
async function refreshAltcoins(now=Date.now()){
 if(altCache.updatedAt&&now-altCache.updatedAt<ALT_REFRESH_MS)return altCache;
 try{
  const [ticker,exchange,books]=await Promise.all([
   request(API+'/fapi/v1/ticker/24hr'),request(API+'/fapi/v1/exchangeInfo'),
   request(API+'/fapi/v1/ticker/bookTicker')
  ]);
  const hotDetails=selectAltcoins(ticker,exchange,books,COINS,now);
  const hot=hotDetails.map(x=>x.symbol);
  const pool=earlyPool(ticker,exchange,books,[...COINS,...hot],now);
  const barsBySymbol={};
  // Four requests at a time; unsuccessful symbols are skipped, never guessed.
  for(let i=0;i<pool.length;i+=4){
   await Promise.all(pool.slice(i,i+4).map(async x=>{
    try{barsBySymbol[x.symbol]=await request(API+'/fapi/v1/klines?symbol='+
      encodeURIComponent(x.symbol)+'&interval=1h&limit=40');}
    catch(e){console.error('early bars',x.symbol,String(e.message||e));}
   }));
  }
  const earlyDetails=selectEarlyMovers(ticker,exchange,books,barsBySymbol,
    [...COINS,...hot],now,8);
  await Promise.all(earlyDetails.slice(0,4).map(async x=>{
   x.oiChangePct=await optionalOiChange(x.symbol);
  }));
  const early=earlyDetails.map(x=>x.symbol);
  const preScreen=pool.map(x=>x.symbol); // liquid early candidates are scanned even without an H1 watch badge
  altCache={symbols:[...hot,...early],hot,early,preScreen,hotDetails,earlyDetails,
   updatedAt:Date.now(),error:null};
  console.log(JSON.stringify({altRadar:'DUAL_UPDATED',hot,early,
   earlyOI:earlyDetails.map(x=>({symbol:x.symbol,oiChangePct:x.oiChangePct??null}))}));
 }catch(e){
  // Keep the last valid watchlist and the main scanner alive on a network failure.
  altCache={...altCache,updatedAt:Date.now(),error:String(e.message||e)};
  console.error('dual radar refresh failed',altCache.error);
 }
 return altCache;
}

const wait=ms=>new Promise(r=>setTimeout(r,ms));
function ema(a,n){if(a.length<n)return null;let v=a.slice(0,n).reduce((s,x)=>s+x,0)/n;const k=2/(n+1);for(let i=n;i<a.length;i++)v=a[i]*k+v*(1-k);return v;}
function atr(c,n=14){if(c.length<n+1)return null;return c.slice(-n).reduce((s,x,i)=>{const prev=c[c.length-n-1+i];return s+Math.max(x.h-x.l,Math.abs(x.h-prev.c),Math.abs(x.l-prev.c))},0)/n;}
function signal(symbol,m15,h1,now=Date.now()){
 if(m15.length<80||h1.length<80)return null;
 const a=m15.filter(x=>x.t+900000<=now),b=h1.filter(x=>x.t+3600000<=now);
 if(a.length<70||b.length<70)return null;
 const c=a.at(-1),prev=a.at(-2);if(now-(c.t+900000)>180000)return null;
 const h=b.map(x=>x.c),h20=ema(h,20),h50=ema(h,50),vol=atr(a);
 if(!(vol>0)||!(h20>0)||!(h50>0))return null;
 const long=h.at(-1)>h20&&h20>h50,short=h.at(-1)<h20&&h20<h50;
 const history=a.slice(-21,-1),hi=Math.max(...history.map(x=>x.h)),lo=Math.min(...history.map(x=>x.l));
 const avgVol=history.reduce((s,x)=>s+x.v,0)/history.length;
 const buy=long&&prev.c<=hi&&c.c>hi&&c.c-c.o>0.35*vol;
 const sell=short&&prev.c>=lo&&c.c<lo&&c.o-c.c>0.35*vol;
 if(!buy&&!sell)return null;
 if(c.v<avgVol*1.20)return null;
 const side=buy?'LONG':'SHORT',dir=buy?1:-1;
 const extension=buy?c.c-hi:lo-c.c;
 if(extension>0.7*vol)return null;
 const stop=buy?Math.min(lo+0.45*(hi-lo),c.c-1.2*vol):Math.max(hi-0.45*(hi-lo),c.c+1.2*vol);
 const risk=dir*(c.c-stop);
 if(risk<0.7*vol||risk>2.2*vol)return null;
 const tp1=c.c+dir*risk,tp2=c.c+dir*2*risk;
 // Conservative round-trip taker fee + slippage, in R.
 const fee=0.0012*c.c,netR=(2*risk-fee)/(risk+fee);
 if(netR<1.5)return null;
 const body=Math.abs(c.c-c.o),range=c.h-c.l;
 if(!(range>0)||body/range<0.50)return null;
 return {symbol,side,entry:c.c,stop,tp1,tp2,netR,at:c.t+900000,key:symbol+'|'+side+'|'+(c.t+900000)};
}

// Diagnostic mirror of signal(). Do not loosen ANY order-entry condition.
// Evaluate at each M15 close, so the report also catches qualified bars that
// become too old before an API scan can send an actionable alert.
function explainSignal(symbol,m15,h1,now=Date.now()){
 if(m15.length<80||h1.length<80)return {reason:'INSUFFICIENT_DATA'};
 const a=m15.filter(x=>x.t+900000<=now),b=h1.filter(x=>x.t+3600000<=now);
 if(a.length<70||b.length<70)return {reason:'INSUFFICIENT_DATA'};
 const c=a.at(-1),prev=a.at(-2);
 if(now-(c.t+900000)>180000)return {reason:'OUTSIDE_ALERT_WINDOW'};
 const h=b.map(x=>x.c),h20=ema(h,20),h50=ema(h,50),vol=atr(a);
 if(!(vol>0)||!(h20>0)||!(h50>0))return {reason:'INSUFFICIENT_DATA'};
 const long=h.at(-1)>h20&&h20>h50,short=h.at(-1)<h20&&h20<h50;
 if(!long&&!short)return {reason:'NO_H1_TREND'};
 const history=a.slice(-21,-1),hi=Math.max(...history.map(x=>x.h)),lo=Math.min(...history.map(x=>x.l));
 const avgVol=history.reduce((s,x)=>s+x.v,0)/history.length;
 const buy=long&&prev.c<=hi&&c.c>hi&&c.c-c.o>0.35*vol;
 const sell=short&&prev.c>=lo&&c.c<lo&&c.o-c.c>0.35*vol;
 if(!buy&&!sell)return {reason:'NO_M15_BREAKOUT'};
 if(c.v<avgVol*1.20)return {reason:'LOW_VOLUME'};
 const dir=buy?1:-1,extension=buy?c.c-hi:lo-c.c;
 if(extension>0.7*vol)return {reason:'OVEREXTENDED'};
 const stop=buy?Math.min(lo+0.45*(hi-lo),c.c-1.2*vol):Math.max(hi-0.45*(hi-lo),c.c+1.2*vol);
 const risk=dir*(c.c-stop);
 if(risk<0.7*vol||risk>2.2*vol)return {reason:'STOP_TOO_WIDE_OR_TIGHT'};
 const fee=0.0012*c.c,netR=(2*risk-fee)/(risk+fee);
 if(netR<1.5)return {reason:'LOW_NET_R'};
 const body=Math.abs(c.c-c.o),range=c.h-c.l;
 if(!(range>0)||body/range<0.50)return {reason:'WEAK_CANDLE'};
 // Final authority is the unchanged production signal function.
 const s=signal(symbol,m15,h1,now);
 return s?{reason:'QUALIFIED',signal:s}:{reason:'CHECK_MISMATCH'};
}
const DIAG_LABELS={
 NO_H1_TREND:'H1 trend unclear',
 NO_M15_BREAKOUT:'No M15 breakout',
 LOW_VOLUME:'Volume too low',
 OVEREXTENDED:'Already too far from breakout',
 STOP_TOO_WIDE_OR_TIGHT:'Stop distance outside limits',
 LOW_NET_R:'Reward/risk too low',
 WEAK_CANDLE:'Candle body too weak',
 INSUFFICIENT_DATA:'Not enough price history',
 MISSED_AGE:'Valid setup missed alert window',
 QUALIFIED:'Qualified',
 CHECK_MISMATCH:'Diagnostic mismatch'
};
function recordDiagnostic(state,symbol,m15,h1,now=Date.now()){
 const bars=m15.filter(x=>x.t+900000<=now);
 if(!bars.length)return;
 const closedAt=bars.at(-1).t+900000;
 state.diagnostics||={lastBar:{},samples:[]};
 const diag=state.diagnostics;
 diag.lastBar||={};diag.samples||=[];
 if(diag.lastBar[symbol]===closedAt)return;
 // Never replay old signals; this is reporting only.
 const evaluated=explainSignal(symbol,m15,h1,closedAt+1000);
 const late=now-closedAt>180000;
 const reason=late&&evaluated.reason==='QUALIFIED'?'MISSED_AGE':evaluated.reason;
 diag.lastBar[symbol]=closedAt;
 diag.samples.push({symbol,at:closedAt,reason});
 if(diag.samples.length>1800)diag.samples=diag.samples.slice(-1800);
}
function diagnosis(state,now=Date.now()){
 const samples=(state.diagnostics?.samples||[]).filter(x=>x.at>=now-24*3600000);
 const counts={};for(const x of samples)counts[x.reason]=(counts[x.reason]||0)+1;
 const top=Object.entries(counts).filter(([k])=>k!=='QUALIFIED')
   .sort((a,b)=>b[1]-a[1]).slice(0,3);
 const close=new Set(['LOW_VOLUME','OVEREXTENDED','STOP_TOO_WIDE_OR_TIGHT','LOW_NET_R','WEAK_CANDLE','MISSED_AGE']);
 const nearby=samples.filter(x=>close.has(x.reason)&&x.at>=now-2*3600000)
   .sort((a,b)=>b.at-a.at).slice(0,3);
 return {sampled:samples.length,qualified:counts.QUALIFIED||0,missed:counts.MISSED_AGE||0,
   top,nearby};
}

function rows(x){return x.map(y=>({t:Number(y[0]),o:+y[1],h:+y[2],l:+y[3],c:+y[4],v:+y[5]}));}
async function request(url){const r=await fetch(url,{signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('API '+r.status);return r.json();}
async function candles(symbol,tf){return rows(await request(API+'/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+'&interval='+tf+'&limit=140'));}
async function trackScorecard(state,now=Date.now()){
 const card=initScorecard(state);
 const grouped=new Map();
 for(const t of card.trades){
  if(t.status!=='OPEN')continue;
  const from=t.lastBar===null?t.eligibleFrom:t.lastBar+60000;
  if(from>=Math.floor(now/60000)*60000)continue;
  if(!grouped.has(t.symbol))grouped.set(t.symbol,[]);
  grouped.get(t.symbol).push(t);
 }
 for(const [symbol,trades] of grouped){
  const start=Math.min(...trades.map(t=>t.lastBar===null?t.eligibleFrom:t.lastBar+60000));
  try{
   const raw=await request(API+'/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+'&interval=1m&startTime='+start+'&limit=1000');
   const bars=rows(raw).filter(x=>x.t+60000<=now);
   if(!bars.length)continue;
   for(const t of trades)applyBars(t,bars,now);
  }catch(e){
   console.error('scorecard feed',symbol,String(e.message||e));
   card.lastFeedError={symbol,at:now,message:String(e.message||e)};
  }
 }
 card.lastCheckedAt=now;
}
async function telegram(msg,extra={}){if(!TOKEN||!CHAT)throw Error('Telegram credentials missing');const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text:msg,disable_web_page_preview:true,...extra}),signal:AbortSignal.timeout(10000)});const j=await r.json();if(!r.ok||!j.ok)throw Error('Telegram rejected message');}
function fmt(v){return Number(v).toLocaleString('en-US',{useGrouping:false,maximumSignificantDigits:8});}
// Display only: keep all saved timestamps and trading logic in UTC.
// Format Last scan for the Telegram user in Singapore local time (UTC+8).
function formatScanTime(ms){
 const parts=new Intl.DateTimeFormat('en-US',{
  timeZone:'Asia/Singapore',day:'2-digit',month:'short',year:'numeric',
  hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true
 }).formatToParts(new Date(ms));
 const part=type=>parts.find(x=>x.type===type).value;
 return part('day')+' '+part('month')+' '+part('year')+', '+
   part('hour')+':'+part('minute')+':'+part('second')+' '+part('dayPeriod').toUpperCase()+' SGT';
}
function message(s){return ['🚨 '+s.symbol+' · '+s.side,'','Entry: '+fmt(s.entry),'SL: '+fmt(s.stop),'TP1 (1R): '+fmt(s.tp1),'TP2 (2R): '+fmt(s.tp2),'Expected net R at TP2: '+s.netR.toFixed(2),'','15m candle confirmed · H1 trend aligned','Manual trade only · signal may be invalid if price moves'].join('\n');}
function load(){
 if(!fs.existsSync(STORE)){
  if(fs.existsSync(STORE+'.bak'))return JSON.parse(fs.readFileSync(STORE+'.bak','utf8'));
  return {sent:{}};
 }
 try{return JSON.parse(fs.readFileSync(STORE,'utf8'));}
 catch(e){
  if(fs.existsSync(STORE+'.bak')){
   console.error('Primary state unreadable: loading last backup; no silent score reset');
   return JSON.parse(fs.readFileSync(STORE+'.bak','utf8'));
  }
  throw new Error('State corrupted; refusing to reset historical scores: '+e.message);
 }
}
function save(s){
 fs.mkdirSync(path.dirname(STORE),{recursive:true});
 const tmp=STORE+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(s));
 if(fs.existsSync(STORE)){
  try{JSON.parse(fs.readFileSync(STORE,'utf8'));fs.copyFileSync(STORE,STORE+'.bak');}
  catch(e){console.error('Backup skipped, unreadable prior state: '+e.message);}
 }
 fs.renameSync(tmp,STORE);
}
let lastScan=0,lastErrors=0,lastMatches=0,inProgress=false;
let latestCandidates=[];
async function scan(){if(inProgress)return;inProgress=true;try{
 const state=load();state.sent||={};initScorecard(state);let errors=0,matches=0;const current=[];
 delete state.oneTapHealth; // discard obsolete One-Tap state
 const alt=await refreshAltcoins();
 const scanCoins=[...new Set([...COINS,...alt.symbols,...(alt.preScreen||[])])];
 state.universe={symbols:scanCoins,altcoins:alt.symbols,core:COINS.length,
   hot:alt.hot,early:alt.early,preScreen:alt.preScreen||[],hotDetails:alt.hotDetails,earlyDetails:alt.earlyDetails,
   updatedAt:alt.updatedAt,radarError:alt.error};
 // Baseline pre-existing milestones before scanning to avoid retroactive spam.
 if(initializeHitAlerts(state)){save(state);console.log('HIT_ALERTS_BASELINE_READY');}
 await trackScorecard(state);
 const queued=collectHitAlerts(state);
 if(queued.length)save(state); // durable outbox before Telegram network request
 const delivered=await deliverHitAlerts(state,telegram,save);
 if(queued.length||delivered)console.log(JSON.stringify({hitAlerts:'TRACKED_LEVELS',queued:queued.length,delivered,pending:Object.keys(state.hitAlerts.pending).length}));
 const score=scoreStats(state.scorecard);
 console.log(JSON.stringify({scorecard:'PULSE_LEVEL_TOUCH_V3',tracked:score.tracked,
  slHits:score.slHits,tp1Hits:score.tp1Hits,tp2Hits:score.tp2Hits,open:score.open,
  ambiguous:score.ambiguous,
  recent:state.scorecard.trades.slice(-3).map(t=>({symbol:t.symbol,side:t.side,
   status:t.status,sl:t.slHit,tp1:t.tp1Hit,tp2:t.tp2Hit}))}));
 for(let i=0;i<scanCoins.length;i+=5){
   await Promise.all(scanCoins.slice(i,i+5).map(async symbol=>{
     try{const [a,b]=await Promise.all([candles(symbol,'15m'),candles(symbol,'1h')]);
       const checkedAt=Date.now();
       recordDiagnostic(state,symbol,a,b,checkedAt);
       const s=signal(symbol,a,b,checkedAt);if(!s)return;
       matches++;current.push(s);if(state.sent[s.key])return;
       // Informational signal only; no exchange order can be placed here.
       await telegram(message(s));
       const sentAt=Date.now();
       state.sent[s.key]=sentAt;
       if(!state.scorecard.trades.some(t=>t.key===s.key)){
         state.scorecard.trades.push(createTrade(s,sentAt));
       }
       save(state);
     }catch(e){errors++;console.error('scan',symbol,String(e.message||e));}
   }));
 }
 const cutoff=Date.now()-8*86400000;for(const [k,t] of Object.entries(state.sent))if(t<cutoff)delete state.sent[k];
 latestCandidates=current.sort((a,b)=>b.netR-a.netR);state.latestCandidates=latestCandidates;state.lastScan=Date.now();state.errors=errors;state.matches=matches;
 const audit=diagnosis(state,state.lastScan);
 save(state);lastScan=state.lastScan;lastErrors=errors;lastMatches=matches;
 console.log(JSON.stringify({scanner:'OPPORTUNITY_24_7',symbols:scanCoins.length,hot:alt.hot.length,early:alt.early.length,prescreen:(alt.preScreen||[]).length,altcoins:alt.symbols.length,at:new Date(lastScan).toISOString(),matches,errors,diagnosed:audit.sampled,lateQualified:audit.missed}));
 }finally{inProgress=false;}}
// Only three public commands. Telegram's old message keyboards cannot be deleted retroactively.
async function botApi(method,body){
 const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(!r.ok||!j.ok)throw Error('Telegram '+method+' failed: '+r.status);return j.result;
}
async function respond(chat,text){
 return botApi('sendMessage',{chat_id:chat,text,reply_markup:{remove_keyboard:true}});
}
// Gross price-distance R (reward/risk), not realized PnL or net R.
function rrAtLevel(t,level){
 const entry=Number(t.entry),stop=Number(t.stop),target=Number(level);
 const d=t.side==='LONG'?1:t.side==='SHORT'?-1:0;
 const risk=d*(entry-stop);
 if(!Number.isFinite(entry)||!Number.isFinite(stop)||!Number.isFinite(target)||
    !(risk>0)||!d)return null;
 const r=d*(target-entry)/risk;
 return Number.isFinite(r)?r:null;
}
function formatReachedR(t){
 const level=t.tp2Hit?t.tp2:t.tp1Hit?t.tp1:null;
 if(level===null)return t.slHit?'SL reached (−1.00R)':'—';
 const r=rrAtLevel(t,level);
 return r===null?'unknown':(r>=0?'+':'')+r.toFixed(2)+'R';
}
function diagnosticLines(state,now=Date.now()){
 const d=diagnosis(state,now);
 if(!d.sampled)return ['Signal diagnostics: waiting for closed M15 data'];
 return [
  'Signal checks (24h): '+d.sampled+' closed M15 bars',
  'Main blocks: '+(d.top.length?d.top.map(([k,n])=>(DIAG_LABELS[k]||k)+' '+n).join(' | '):'none'),
  ...(d.missed?['Missed alert window: '+d.missed+' (historical, NOT fresh entry)']:[]),
  ...(d.nearby.length?['Almost qualified (last 2h): '+
   d.nearby.map(x=>x.symbol.replace('USDT','')+' '+(DIAG_LABELS[x.reason]||x.reason)).join('; ')]:[])
 ];
}

function commandAnswer(command,state,now=Date.now(),page=1){
 const candidates=(state.latestCandidates||[]).filter(x=>now-Number(x.at)<30*60000).sort((a,b)=>b.netR-a.netR);
 if(command==='/scan')return ['📡 '+(state.universe?.symbols?.length||COINS.length)+' coins · latest confirmed scan',
   'Altcoin radar: '+(state.universe?.altcoins?.length||0)+' active movers',
   ...(state.universe?.hot?[
    'Early Movers · WATCH ONLY ('+(state.universe.early?.length||0)+'):',
    ...(state.universe.earlyDetails||[]).slice(0,3).map(x=>
      x.symbol+' '+x.side+' | 24h '+x.changePct.toFixed(1)+'% | H1 volume ×'+x.volumeRatio.toFixed(1)+
      (Number.isFinite(x.oiChangePct)?' | OI '+(x.oiChangePct>=0?'+':'')+x.oiChangePct.toFixed(1)+'%':'')),
    'Hot Movers · WATCH ONLY ('+(state.universe.hot?.length||0)+'): '+
      (state.universe.hot||[]).slice(0,5).join(', '),
    'Early pre-screen scanned: '+(state.universe.preScreen?.length||0)
   ]:state.universe?.altcoins?.length?
    ['Watchlist (not entry signals): '+state.universe.altcoins.slice(0,7).join(', ')]:[]),
   ...(state.universe?.radarError?['Altcoin data temporarily unavailable; core scanner continues.']:[]),
   'Last scan: '+(state.lastScan?formatScanTime(state.lastScan):'not yet'),
   ...diagnosticLines(state,now),
   ...(candidates.length?candidates.slice(0,3).map((x,i)=>(i+1)+'. '+x.symbol+' '+x.side+' · '+x.netR.toFixed(2)+' net R'):['No qualified setups now.']),
   'Only closed M15 candles qualify.'].join('\n');
 if(command==='/signals')return candidates.length?
   candidates.slice(0,3).map(message).join('\n\n────────\n\n'):
   'No active confirmed signals. Bot will automatically alert when a setup qualifies.';
 if(command==='/status'){
  const all=state.scorecard?.trades||[];
  const scored=scoreStats(state.scorecard||{trades:[]});
  const size=6,maxPage=Math.max(1,Math.ceil(all.length/size));
  const selectedPage=Math.max(1,Math.min(maxPage,Number(page)||1));
  const results=[...all].sort((a,b)=>b.notifiedAt-a.notifiedAt)
    .slice((selectedPage-1)*size,selectedPage*size);
  const hit=x=>x?'✓':'—';
  return [
   '📊 HTR Pulse V1.0 · Hit Count',
   'Scanner: 24/7 · '+(state.universe?.symbols?.length||COINS.length)+' coins',
   'Altcoin radar: '+(state.universe?.altcoins?.length||0)+' active movers',
   ...(state.universe?.hot?['Early watch: '+(state.universe.early?.length||0)+' | Hot watch: '+(state.universe.hot?.length||0)]:[]),
   'Last scan: '+(state.lastScan?formatScanTime(state.lastScan):'pending'),
   'Scan errors: '+(state.errors??'unknown'),
   'Diagnostics (24h): '+diagnosis(state,now).sampled+' completed M15 checks'+
     ' | Late qualified: '+diagnosis(state,now).missed,
   '',
   'Total signals: '+scored.tracked,
   '🛑 SL hit: '+scored.slHits+' (−1R level)',
   '🎯 TP1 hit: '+scored.tp1Hits+' (1R target)',
   '🎯 TP2 hit: '+scored.tp2Hits+' (2R target)',
   'Still tracking: '+scored.open,
   scored.ambiguous?'Both sides touched in same minute (order unknown): '+scored.ambiguous:null,
   scored.dataGaps?'Incomplete price history: '+scored.dataGaps:null,
   '',
   'History ('+selectedPage+'/'+maxPage+'):',
   ...results.map(t=>t.symbol+' '+t.side+
       ' | SL '+hit(t.slHit)+' | TP1 '+hit(t.tp1Hit)+' | TP2 '+hit(t.tp2Hit)+
       ' | RR '+formatReachedR(t)+
       (t.status==='OPEN'?' | Tracking':'')+
       (t.status==='AMBIGUOUS'?' | Sequence unknown':'')),
   maxPage>selectedPage?'Older: /status '+(selectedPage+1):null,
   '',
   'RR = furthest target touched ÷ original SL risk (gross, not profit).',
   'TP2 also counts TP1. Hits are independent; no simulated exits or PnL.'
  ].filter(x=>x!==null).join('\n');
 }
 return 'HTR Signal Bot\n/scan — scan results\n/signals — confirmed entries\n/status — scanner health';
}
// Use Telegram webhook instead of competing getUpdates polling clients.
// Telegram routes command updates to this HTTPS endpoint even if an older bot
// instance is still attempting getUpdates (old poller will receive 409).
const crypto=require('node:crypto');
const HOOK_DOMAIN=process.env.OPPORTUNITY_WEBHOOK_DOMAIN||'crypto-signal-publisher-production.up.railway.app';
const HOOK_SECRET=TOKEN?crypto.createHash('sha256').update(TOKEN+'|HTR-V3-WEBHOOK').digest('hex'):'';
const HOOK_PATH='/telegram/'+HOOK_SECRET;
const HOOK_REQUEST_TOKEN=TOKEN?crypto.createHash('sha256').update(TOKEN+'|HTR-ONE-TAP-SECRET').digest('hex'):'';
// Previously sent Telegram messages can still contain historical CONFIRM buttons.
// Acknowledge and remove those buttons without calling an exchange.
async function rejectLegacyTap(q){
 try{await botApi('answerCallbackQuery',{callback_query_id:q.id,
   text:'One-Tap removed. No trade executed.',show_alert:true});}
 catch(e){console.error('legacy button acknowledgement',String(e.message||e));}
 const chat=String(q.message?.chat?.id||'');
 const messageId=q.message?.message_id;
 if(chat!==String(CHAT)||!messageId)return;
 try{await botApi('editMessageReplyMarkup',{chat_id:chat,message_id:messageId,
   reply_markup:{inline_keyboard:[]}});}
 catch(e){console.error('legacy button cleanup',String(e.message||e));}
}
let commandQueue=Promise.resolve();
function handleWebhook(req,res){
 if(req.method!=='POST'||req.url!==HOOK_PATH){return false;}
 if(HOOK_REQUEST_TOKEN&&req.headers['x-telegram-bot-api-secret-token']!==HOOK_REQUEST_TOKEN){res.writeHead(403);res.end();return true;}
 if(req.headers['content-type']?.split(';')[0]!=='application/json'){
  res.writeHead(415);res.end();return true;
 }
 let body='',large=false;
 req.on('data',chunk=>{body+=chunk;if(body.length>65536){large=true;req.destroy();}});
 req.on('end',()=>{
  if(large){res.writeHead(413);res.end();return;}
  let u;try{u=JSON.parse(body)}catch{res.writeHead(400);res.end();return;}
  res.writeHead(200);res.end('OK');
  if(u.callback_query&&String(u.callback_query.data||'').startsWith('htrtap:')){
   commandQueue=commandQueue.catch(()=>{}).then(()=>rejectLegacyTap(u.callback_query))
    .catch(e=>console.error('legacy button rejected',String(e.message||e)));
   return;
  }
  const chat=String(u.message?.chat?.id||'');
  if(chat!==String(CHAT))return;
  const cmd=String(u.message?.text||'').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if(!['/scan','/signals','/status','/start'].includes(cmd))return;
  const page=cmd==='/status'?Number(String(u.message?.text||'').trim().split(/\s+/)[1])||1:1;
  commandQueue=commandQueue.catch(()=>{}).then(()=>respond(chat,commandAnswer(cmd,load(),Date.now(),page)))
    .catch(e=>console.error('command response',e.message));
 });
 return true;
}
async function setupWebhook(){
 if(!TOKEN||!CHAT){console.error('Telegram command registration disabled: missing credentials');return;}
 await botApi('setMyCommands',{commands:[
  {command:'scan',description:'Core + Early / Hot Movers radar'},
  {command:'signals',description:'Confirmed LONG / SHORT signals'},
  {command:'status',description:'Scanner status'}]});
 await botApi('setWebhook',{url:'https://'+HOOK_DOMAIN+HOOK_PATH,
   allowed_updates:['message','callback_query'],secret_token:HOOK_REQUEST_TOKEN,drop_pending_updates:false,max_connections:5});
 const info=await botApi('getWebhookInfo',{});
 console.log(JSON.stringify({telegramWebhook:info.url?'SET':'NOT_SET',
   pending:info.pending_update_count,lastError:info.last_error_message||null}));
}

if(require.main===module){
 http.createServer((req,res)=>{if(handleWebhook(req,res))return;const ok=lastScan&&Date.now()-lastScan<3600000;res.writeHead(ok?200:503,{'content-type':'application/json'});res.end(JSON.stringify({ok:!!ok,scanner:'OPPORTUNITY_24_7',lastScan,errors:lastErrors,matches:lastMatches}));}).listen(Number(process.env.PORT||3000),'0.0.0.0');
 const loop=async()=>{for(;;){try{await scan()}catch(e){console.error('scan fatal',e)}await wait(POLL)}};
 loop();
 setupWebhook().catch(e=>console.error('webhook setup',e.message));
}
module.exports={signal,explainSignal,recordDiagnostic,diagnosis,diagnosticLines,rows,message,commandAnswer,trackScorecard,rrAtLevel,formatReachedR,selectAltcoins,earlyPool,analyzeEarlyBars,selectEarlyMovers};
