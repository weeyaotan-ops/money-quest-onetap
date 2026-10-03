'use strict';

const fs = require('fs');
const path = require('path');
const { getHistoricalRates } = require('dukascopy-node');

const M15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const VERSION = 'HUNTER_ADAPTIVE_V1_2026-10-02_LIFECYCLE_V2';
const STATE_PATH = process.env.ADAPTIVE_STATE_PATH || '.hunter_state/adaptive_state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const BINANCE_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com';
const OKX_BASE = process.env.OKX_REST_BASE || 'https://www.okx.com';
const YAHOO_BASE = process.env.YAHOO_FINANCE_BASE || 'https://query1.finance.yahoo.com';
const XAUS_BASE = process.env.XAUS_API_BASE || 'https://xaus.com';
const MAX_FEED_BEHIND_MS = Number(process.env.ADAPTIVE_MAX_FEED_BEHIND_MS || 60 * 1000);
const DAILY_STOP_R = Number(process.env.ADAPTIVE_DAILY_STOP_R || -2);
const RISK_PCT = Number(process.env.ADAPTIVE_RISK_PCT || 0.005);
const MAX_CHASE_R = Math.min(0.25, Math.max(0, Number(process.env.ADAPTIVE_MAX_CHASE_R || 0.05)));
const RETEST_BARS = Number(process.env.ADAPTIVE_RETEST_BARS || 4);
const ENTRY_VALID_MS = Math.max(M15, Number(process.env.ADAPTIVE_ENTRY_VALID_MS || M15));
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XAUUSD'];

const SESSION_DEFS = {
  LONDON: { id:'LONDON', label:'London', tz:'Europe/London', hour:8, minute:0 },
  NY_CRYPTO: { id:'NY_CRYPTO', label:'New York', tz:'America/New_York', hour:9, minute:30 },
  NY_GOLD: { id:'NY_GOLD', label:'New York Gold', tz:'America/New_York', hour:8, minute:30 }
};

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function num(x){ const n=Number(x); return Number.isFinite(n)?n:null; }
function fmt(x,symbol){
  const n=Number(x); if(!Number.isFinite(n)) return 'n/a';
  if(symbol==='XAUUSD') return n.toFixed(2);
  if(n>=1000) return n.toFixed(2);
  if(n>=10) return n.toFixed(3);
  return n.toFixed(4);
}
function chaseGuard(s){
  const entry=Number(s?.entry), stop=Number(s?.stop);
  const riskDistance=Math.abs(entry-stop);
  const side=String(s?.side||'').toUpperCase();
  const valid=Number.isFinite(entry)&&Number.isFinite(stop)&&Number.isFinite(riskDistance)&&riskDistance>0;
  const delta=valid?riskDistance*MAX_CHASE_R:0;
  const chasePrice=side==='SHORT'?entry-delta:entry+delta;
  return {
    limitEntry:entry,
    chasePrice,
    maxChaseR:MAX_CHASE_R,
    boundaryLabel:side==='SHORT'?'追价下限':'追价上限',
    skipLabel:side==='SHORT'?'跌破追价下限：SKIP / 等回踩':'超过追价上限：SKIP / 等回踩'
  };
}
function localParts(ts,tz){
  const ps=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts));
  const o={}; for(const p of ps) if(p.type!=='literal') o[p.type]=p.value;
  return {date:o.year+'-'+o.month+'-'+o.day,hour:Number(o.hour),minute:Number(o.minute)};
}
function sgtDate(ts=Date.now()){
  const ps=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts));
  const o={}; for(const p of ps) if(p.type!=='literal') o[p.type]=p.value;
  return o.year+'-'+o.month+'-'+o.day;
}
function sgtTime(ts){
  return new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ts));
}
function utcDay(ts){ return new Date(Number(ts)).toISOString().slice(0,10); }

function xauMarketClosed(now=Date.now()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(Number(now)));
  const o={}; for(const p of parts) if(p.type!=='literal') o[p.type]=p.value;
  const minuteOfDay=Number(o.hour)*60+Number(o.minute);
  if(o.weekday==='Sat') return true;
  if(o.weekday==='Fri'&&minuteOfDay>=17*60) return true;
  if(o.weekday==='Sun'&&minuteOfDay<18*60) return true;
  return false;
}

async function getJson(url){
  let last=null;
  for(let i=0;i<3;i+=1){
    try{
      const res=await fetch(url,{headers:{'user-agent':'hunter-adaptive/1.0'},signal:AbortSignal.timeout(12000)});
      if(!res.ok) throw new Error('HTTP '+res.status+' '+url);
      return await res.json();
    }catch(e){ last=e; if(i<2) await sleep(250*Math.pow(2,i)); }
  }
  throw last || new Error('fetch failed');
}
function mapBinance(rows,intervalMs,now){
  return (rows||[]).map(r=>({openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),closeTime:Number(r[6])}))
    .filter(x=>x.closeTime<=now && [x.open,x.high,x.low,x.close].every(Number.isFinite));
}
async function binanceCandles(symbol,interval,limit,now){
  const ms=interval==='4h'?4*HOUR:M15;
  const q=new URLSearchParams({symbol,interval,limit:String(limit)});
  return mapBinance(await getJson(BINANCE_BASE+'/fapi/v1/klines?'+q.toString()),ms,now);
}
function okxId(symbol){ return symbol.replace(/USDT$/,'')+'-USDT-SWAP'; }
async function okxCandles(symbol,bar,limit){
  const q=new URLSearchParams({instId:okxId(symbol),bar,limit:String(Math.min(300,limit))});
  const b=await getJson(OKX_BASE+'/api/v5/market/candles?'+q.toString());
  if(b.code!=='0') throw new Error('OKX '+b.code);
  const ms=bar==='4H'?4*HOUR:M15;
  return (b.data||[]).filter(r=>String(r[8]||'1')==='1').map(r=>({openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),closeTime:Number(r[0])+ms-1})).sort((a,b)=>a.openTime-b.openTime);
}
function chooseFreshestSnapshot(candidates,now=Date.now()){
  const xs=(candidates||[]).filter(x=>x&&Array.isArray(x.m15)&&x.m15.length);
  if(!xs.length) return null;
  return [...xs].sort((a,b)=>snapshotFreshness(a,now)-snapshotFreshness(b,now))[0];
}
async function cryptoSnapshot(symbol,now){
  const [binanceResult,okxResult]=await Promise.allSettled([
    Promise.all([binanceCandles(symbol,'15m',300,now),binanceCandles(symbol,'4h',120,now)])
      .then(([m15,h4])=>({symbol,provider:'BINANCE',m15,h4})),
    Promise.all([okxCandles(symbol,'15m',300),okxCandles(symbol,'4H',120)])
      .then(([m15,h4])=>({symbol,provider:'OKX',m15,h4}))
  ]);
  const candidates=[];
  if(binanceResult.status==='fulfilled') candidates.push(binanceResult.value);
  if(okxResult.status==='fulfilled') candidates.push(okxResult.value);
  const errors=[
    binanceResult.status==='rejected'?'BINANCE:'+(binanceResult.reason?.message||'failed'):null,
    okxResult.status==='rejected'?'OKX:'+(okxResult.reason?.message||'failed'):null
  ].filter(Boolean);
  const best=chooseFreshestSnapshot(candidates,now);
  if(!best) throw new Error('CRYPTO_ALL_FEEDS_FAILED '+symbol+' '+errors.join(' | '));
  best.feedCandidates=candidates.map(x=>({provider:x.provider,lagMinutes:snapshotFreshness(x,now)/60000}));
  best.feedErrors=errors;
  return best;
}
async function duka(symbol,timeframe,days,now){
  const ms=timeframe==='h1'?HOUR:M15;
  const rows=await getHistoricalRates({instrument:symbol.toLowerCase(),dates:{from:new Date(now-days*DAY),to:new Date(now+HOUR)},timeframe,format:'json',priceType:'bid',ignoreFlats:true});
  return (rows||[]).map(x=>({openTime:Number(x.timestamp),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0),closeTime:Number(x.timestamp)+ms-1}))
    .filter(x=>x.openTime+ms<=now && [x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>a.openTime-b.openTime);
}
function aggregateH4(h1){
  const m=new Map();
  for(const x of h1){
    const t=Math.floor(x.openTime/(4*HOUR))*(4*HOUR);
    if(!m.has(t)) m.set(t,{openTime:t,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume,closeTime:t+4*HOUR-1});
    else{ const g=m.get(t); g.high=Math.max(g.high,x.high); g.low=Math.min(g.low,x.low); g.close=x.close; g.volume+=x.volume; }
  }
  return [...m.values()].sort((a,b)=>a.openTime-b.openTime);
}

function yahooIntervalMs(interval){
  if(interval==='1h') return HOUR;
  if(interval==='15m') return M15;
  throw new Error('Unsupported Yahoo interval '+interval);
}
async function yahooCandles(symbol,interval,range,now=Date.now()){
  const q=new URLSearchParams({interval,range,includePrePost:'true',events:'history'});
  const url=YAHOO_BASE+'/v8/finance/chart/'+encodeURIComponent(symbol)+'?'+q.toString();
  const body=await getJson(url);
  const result=body?.chart?.result?.[0];
  if(!result) throw new Error('YAHOO_NO_RESULT '+symbol);
  const ts=result.timestamp||[];
  const quote=result.indicators?.quote?.[0]||{};
  const ms=yahooIntervalMs(interval);
  const out=[];
  for(let i=0;i<ts.length;i+=1){
    const openTime=Number(ts[i])*1000;
    const row={openTime,open:Number(quote.open?.[i]),high:Number(quote.high?.[i]),low:Number(quote.low?.[i]),close:Number(quote.close?.[i]),volume:Number(quote.volume?.[i]||0),closeTime:openTime+ms-1};
    if(openTime+ms<=now && [row.open,row.high,row.low,row.close].every(Number.isFinite)) out.push(row);
  }
  return out.sort((a,b)=>a.openTime-b.openTime);
}
function expectedClosedM15(now=Date.now()){ return Math.floor(Number(now)/M15)*M15; }
function snapshotFreshness(snap,now=Date.now()){
  const last=snap?.m15?.at(-1);
  if(!last) return Infinity;
  const lastClose=Number(last.openTime)+M15;
  return Math.max(0,expectedClosedM15(now)-lastClose);
}
function candleAgeMs(snap,now=Date.now()){
  const last=snap?.m15?.at(-1);
  if(!last) return Infinity;
  return now-(Number(last.openTime)+M15);
}
async function yahooGoldSnapshot(now){
  const [m15,h1]=await Promise.all([
    yahooCandles('XAUUSD=X','15m','5d',now),
    yahooCandles('XAUUSD=X','1h','1mo',now)
  ]);
  const h4=aggregateH4(h1);
  if(m15.length<30 || h4.length<51) throw new Error('YAHOO_XAU_INSUFFICIENT m15='+m15.length+' h4='+h4.length);
  return {symbol:'XAUUSD',provider:'YAHOO_SPOT',m15,h4};
}

function xausPointTime(t){
  const n=Number(t);
  if(!Number.isFinite(n)) return null;
  return n<1e12?n*1000:n;
}
async function xausChartCandles(interval,range,now=Date.now()){
  const q=new URLSearchParams({symbol:'xau',range,interval});
  const body=await getJson(XAUS_BASE+'/api/v1/chart?'+q.toString());
  if(body?.data_state?.status==='unavailable') throw new Error('XAUS_UNAVAILABLE');
  const points=body?.points||body?.data||body?.series||[];
  const ms=interval==='1h'?HOUR:M15;
  return (points||[]).map(p=>{
    const openTime=xausPointTime(p.t??p.timestamp??p.time);
    return {
      openTime,
      open:Number(p.o??p.open),
      high:Number(p.h??p.high),
      low:Number(p.l??p.low),
      close:Number(p.c??p.close),
      volume:Number(p.v??p.volume??0),
      closeTime:Number(openTime)+ms-1
    };
  }).filter(x=>Number.isFinite(x.openTime)&&x.openTime+ms<=now&&[x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>a.openTime-b.openTime);
}
async function xausGoldSnapshot(now){
  const [m15,h1]=await Promise.all([
    xausChartCandles('15m','5d',now),
    xausChartCandles('1h','1mo',now)
  ]);
  const h4=aggregateH4(h1);
  if(m15.length<30||h4.length<51) throw new Error('XAUS_INSUFFICIENT m15='+m15.length+' h4='+h4.length);
  return {symbol:'XAUUSD',provider:'XAUS_SPOT',m15,h4};
}
async function goldSnapshot(now){
  const [xausResult,dukaResult,yahooResult]=await Promise.allSettled([
    xausGoldSnapshot(now),
    Promise.all([duka('XAUUSD','m15',7,now),duka('XAUUSD','h1',30,now)])
      .then(([m15,h1])=>({symbol:'XAUUSD',provider:'DUKASCOPY',m15,h4:aggregateH4(h1)})),
    yahooGoldSnapshot(now)
  ]);
  const candidates=[];
  if(xausResult.status==='fulfilled') candidates.push(xausResult.value);
  if(dukaResult.status==='fulfilled') candidates.push(dukaResult.value);
  if(yahooResult.status==='fulfilled') candidates.push(yahooResult.value);
  const feedErrors=[
    xausResult.status==='rejected'?'XAUS:'+(xausResult.reason?.message||'failed'):null,
    dukaResult.status==='rejected'?'DUKA:'+(dukaResult.reason?.message||'failed'):null,
    yahooResult.status==='rejected'?'YAHOO:'+(yahooResult.reason?.message||'failed'):null
  ].filter(Boolean);
  if(!candidates.length) throw new Error('XAU_ALL_FEEDS_FAILED '+feedErrors.join(' | '));
  candidates.sort((a,b)=>snapshotFreshness(a,now)-snapshotFreshness(b,now));
  const best=candidates[0];
  best.feedCandidates=candidates.map(x=>({provider:x.provider,lagMinutes:snapshotFreshness(x,now)/60000}));
  best.feedErrors=feedErrors;
  return best;
}
async function snapshot(symbol,now){ return symbol==='XAUUSD'?goldSnapshot(now):cryptoSnapshot(symbol,now); }

function emaSeries(values,period){
  if(values.length<period+2) return null;
  const a=2/(period+1); let e=Number(values[0]); const out=[e];
  for(let i=1;i<values.length;i+=1){ e=a*Number(values[i])+(1-a)*e; out.push(e); }
  return out;
}
function trueRanges(candles){
  const out=[];
  for(let i=1;i<candles.length;i+=1){
    const h=Number(candles[i].high),l=Number(candles[i].low),pc=Number(candles[i-1].close);
    out.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return out;
}
function avg(xs){ return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null; }
function median(xs){
  if(!xs.length) return null; const s=[...xs].sort((a,b)=>a-b); const i=Math.floor(s.length/2);
  return s.length%2?s[i]:(s[i-1]+s[i])/2;
}
function atr(candles,period=14){
  const trs=trueRanges(candles); if(trs.length<period) return null; return avg(trs.slice(-period));
}
function adx14(candles){
  if(candles.length<35) return null;
  const tr=[],plus=[],minus=[];
  for(let i=1;i<candles.length;i+=1){
    const c=candles[i],p=candles[i-1];
    const up=c.high-p.high,down=p.low-c.low;
    plus.push(up>down&&up>0?up:0); minus.push(down>up&&down>0?down:0);
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  const n=14; let atrSm=tr.slice(0,n).reduce((a,b)=>a+b,0),pSm=plus.slice(0,n).reduce((a,b)=>a+b,0),mSm=minus.slice(0,n).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=n;i<tr.length;i+=1){
    atrSm=atrSm-atrSm/n+tr[i]; pSm=pSm-pSm/n+plus[i]; mSm=mSm-mSm/n+minus[i];
    const pdi=atrSm?100*pSm/atrSm:0, mdi=atrSm?100*mSm/atrSm:0;
    dx.push((pdi+mdi)?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  }
  if(dx.length<n) return null;
  let adx=avg(dx.slice(0,n));
  for(let i=n;i<dx.length;i+=1) adx=(adx*(n-1)+dx[i])/n;
  return adx;
}
function dailyVwap(candles,target){
  const day=utcDay(target); let pv=0,v=0;
  for(const c of candles){
    if(c.openTime>target||utcDay(c.openTime)!==day) continue;
    const vol=Number(c.volume); if(!(vol>0)) continue;
    const tp=(c.high+c.low+c.close)/3; pv+=tp*vol; v+=vol;
  }
  return v>0?pv/v:null;
}
function vwapGate(side,price,vwap){
  const p=Number(price),v=Number(vwap);
  if(!Number.isFinite(p)||!Number.isFinite(v)||vwap===null) return false;
  if(side==='LONG') return p>v;
  if(side==='SHORT') return p<v;
  return false;
}
function regime(snap){
  const h4=snap.h4; const m15=snap.m15;
  const closes=h4.map(x=>x.close); const e20=emaSeries(closes,20),e50=emaSeries(closes,50);
  const a4=atr(h4,14), a15=atr(m15,14), adx=adx14(h4);
  if(!e20||!e50||!a4||!a15||!Number.isFinite(adx)) return {type:'CHAOS',reason:'指标数据不足'};
  const c=closes.at(-1),v20=e20.at(-1),v20prev=e20.at(-3),v50=e50.at(-1);
  const recentTr=trueRanges(m15.slice(-30)); const med=median(recentTr.slice(0,-1)); const lastTr=recentTr.at(-1);
  if(med&&lastTr>2.4*med) return {type:'CHAOS',reason:'短线波动突然放大',adx,a15,a4};
  if(c>v20&&v20>v50&&v20>v20prev&&adx>=18) return {type:'TREND',side:'LONG',adx,a15,a4,ema20:v20,ema50:v50};
  if(c<v20&&v20<v50&&v20<v20prev&&adx>=18) return {type:'TREND',side:'SHORT',adx,a15,a4,ema20:v20,ema50:v50};
  const spread=Math.abs(v20-v50)/a4;
  if(adx<18||spread<0.35) return {type:'RANGE',adx,a15,a4,ema20:v20,ema50:v50};
  return {type:'NEUTRAL',adx,a15,a4,ema20:v20,ema50:v50};
}
function sessionFor(symbol,id){
  if(id==='LONDON') return SESSION_DEFS.LONDON;
  if(symbol==='XAUUSD') return SESSION_DEFS.NY_GOLD;
  return SESSION_DEFS.NY_CRYPTO;
}
function boxFor(candles,session,candidateTime){
  const lp=localParts(candidateTime,session.tz); let h2=session.hour,m2=session.minute+15;
  if(m2>=60){m2-=60;h2+=1;}
  let a=null,b=null;
  for(const c of candles){
    const p=localParts(c.openTime,session.tz); if(p.date!==lp.date) continue;
    if(p.hour===session.hour&&p.minute===session.minute) a=c;
    if(p.hour===h2&&p.minute===m2) b=c;
  }
  if(!a||!b) return null;
  return {date:lp.date,high:Math.max(a.high,b.high),low:Math.min(a.low,b.low),mid:(Math.max(a.high,b.high)+Math.min(a.low,b.low))/2,activeFrom:b.openTime+M15,activeUntil:b.openTime+6*HOUR};
}
function freshBreakout(candles,box,trendSide){
  const cur=candles.at(-1),prev=candles.at(-2); if(!cur||!prev) return null;
  if(cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) return null;
  if(trendSide==='LONG'&&prev.close<=box.high&&cur.close>box.high) return {side:'LONG',candle:cur};
  if(trendSide==='SHORT'&&prev.close>=box.low&&cur.close<box.low) return {side:'SHORT',candle:cur};
  return null;
}
function qualityGate(entry,stop,a15){
  const d=Math.abs(entry-stop); if(!(a15>0)||!(d>0)) return {ok:false,reason:'risk invalid'};
  const r=d/a15;
  if(r<0.35) return {ok:false,reason:'SL太近'};
  if(r>1.8) return {ok:false,reason:'SL太远'};
  return {ok:true,riskAtr:r};
}
function retestSignal(snap,armed,box,reg){
  const xs=snap.m15.filter(x=>x.openTime>armed.breakoutOpenTime).slice(0,RETEST_BARS);
  if(!xs.length) return null;
  const cur=xs.at(-1); const a=reg.a15; const vwap=dailyVwap(snap.m15,cur.openTime);
  if(!Number.isFinite(vwap)) return null;
  if(armed.side==='LONG'){
    const touched=cur.low<=box.high+0.25*a && cur.low>=box.high-0.60*a;
    const reclaimed=cur.close>box.high && vwapGate('LONG',cur.close,vwap) && cur.close>=cur.open;
    if(!touched||!reclaimed) return null;
    const swing=Math.min(...xs.map(x=>x.low)); const stop=swing-0.15*a; const gate=qualityGate(cur.close,stop,a);
    if(!gate.ok) return {reject:true,reason:gate.reason};
    const risk=cur.close-stop;
    return {mode:'TREND_RETEST',side:'LONG',entry:cur.close,stop,tp1:cur.close+risk,tp2:cur.close+2*risk,riskDistance:risk,riskAtr:gate.riskAtr,candle:cur,plan:'40%@1R · 30%@2R · 30% Runner'};
  }else{
    const touched=cur.high>=box.low-0.25*a && cur.high<=box.low+0.60*a;
    const reclaimed=cur.close<box.low && vwapGate('SHORT',cur.close,vwap) && cur.close<=cur.open;
    if(!touched||!reclaimed) return null;
    const swing=Math.max(...xs.map(x=>x.high)); const stop=swing+0.15*a; const gate=qualityGate(cur.close,stop,a);
    if(!gate.ok) return {reject:true,reason:gate.reason};
    const risk=stop-cur.close;
    return {mode:'TREND_RETEST',side:'SHORT',entry:cur.close,stop,tp1:cur.close-risk,tp2:cur.close-2*risk,riskDistance:risk,riskAtr:gate.riskAtr,candle:cur,plan:'40%@1R · 30%@2R · 30% Runner'};
  }
}
function rangeSignal(snap,box,reg){
  const cur=snap.m15.at(-1),prev=snap.m15.at(-2); if(!cur||!prev||cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) return null;
  const a=reg.a15; if(!(a>0)) return null;
  if(cur.low<box.low-0.10*a && cur.close>box.low && prev.low>=box.low-0.10*a){
    const stop=cur.low-0.15*a; const risk=cur.close-stop; const r1=(box.mid-cur.close)/risk, r2=(box.high-cur.close)/risk;
    if(risk<=0||r1<0.8||r2<1.5) return null;
    const gate=qualityGate(cur.close,stop,a); if(!gate.ok) return null;
    return {mode:'RANGE_SWEEP',side:'LONG',entry:cur.close,stop,tp1:box.mid,tp2:box.high,riskDistance:risk,riskAtr:gate.riskAtr,candle:cur,plan:'50%@中线 · 50%@另一边Box'};
  }
  if(cur.high>box.high+0.10*a && cur.close<box.high && prev.high<=box.high+0.10*a){
    const stop=cur.high+0.15*a; const risk=stop-cur.close; const r1=(cur.close-box.mid)/risk, r2=(cur.close-box.low)/risk;
    if(risk<=0||r1<0.8||r2<1.5) return null;
    const gate=qualityGate(cur.close,stop,a); if(!gate.ok) return null;
    return {mode:'RANGE_SWEEP',side:'SHORT',entry:cur.close,stop,tp1:box.mid,tp2:box.low,riskDistance:risk,riskAtr:gate.riskAtr,candle:cur,plan:'50%@中线 · 50%@另一边Box'};
  }
  return null;
}
function normalizeState(x){
  const s=x&&typeof x==='object'?x:{};
  if(!s.sent||typeof s.sent!=='object') s.sent={};
  if(!s.armed||typeof s.armed!=='object') s.armed={};
  if(!s.trades||typeof s.trades!=='object') s.trades={};
  if(!s.daily||typeof s.daily!=='object') s.daily={};
  if(!s.market||typeof s.market!=='object') s.market={};
  if(!Array.isArray(s.pendingAlerts)) s.pendingAlerts=[];
  for(const t of Object.values(s.trades)) ensureTradeLifecycle(t);
  s.version=VERSION; return s;
}
function loadState(){ try{return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH,'utf8')));}catch{return normalizeState({});} }
function saveState(s){ fs.mkdirSync(path.dirname(STATE_PATH),{recursive:true}); const tmp=STATE_PATH+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(s,null,2)); fs.renameSync(tmp,STATE_PATH); }
function tradeFromSignal(sig){
  return {key:sig.key,symbol:sig.symbol,session:sig.session,mode:sig.mode,side:sig.side,entry:sig.entry,stop:sig.stop,initialStop:sig.stop,tp1:sig.tp1,tp2:sig.tp2,riskDistance:sig.riskDistance,signalAtMs:sig.signalAtMs,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:Number(sig.signalAtMs)+ENTRY_VALID_MS,expiredAtMs:null,terminal:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,beActive:false,lastOpenTime:sig.candle.openTime,realizedR:null};
}
function ensureTradeLifecycle(t){
  if(!t||typeof t!=='object') return t;
  if(!Number.isFinite(Number(t.initialStop))&&Number.isFinite(Number(t.stop))) t.initialStop=Number(t.stop);
  if(!Number.isFinite(Number(t.entryExpiresAtMs))&&Number.isFinite(Number(t.signalAtMs))) t.entryExpiresAtMs=Number(t.signalAtMs)+ENTRY_VALID_MS;
  if(!t.actionState){
    if(t.terminal) t.actionState='CLOSED';
    else if(t.runnerActive) t.actionState='RUNNER';
    else if(t.tp1Hit) t.actionState='MANAGING';
    else t.actionState='ACTIONABLE';
  }
  if(t.status==='OPEN') t.status=t.tp1Hit?'TP1':'ACTIONABLE';
  return t;
}
function lifecycleSnapshot(t){
  return {status:t.status,actionState:t.actionState,terminal:Boolean(t.terminal),tp1Hit:Boolean(t.tp1Hit),tp2Hit:Boolean(t.tp2Hit),runnerActive:Boolean(t.runnerActive)};
}
function lifecycleEvents(before,t){
  const out=[];
  if(before.actionState!==t.actionState&&t.actionState==='EXPIRED') out.push('EXPIRED');
  if(!before.tp1Hit&&t.tp1Hit) out.push('TP1');
  if(!before.tp2Hit&&t.tp2Hit) out.push('TP2');
  if(!before.terminal&&t.terminal&&t.status!=='TP2') out.push(String(t.status||'CLOSED'));
  if(!before.runnerActive&&t.runnerActive&&!out.includes('TP2')) out.push('RUNNER');
  return [...new Set(out.filter(Boolean))];
}
function queueAlert(state,key,text,now=Date.now()){
  if(!text||!key) return;
  if(state.pendingAlerts.some(x=>x&&x.key===key)) return;
  state.pendingAlerts.push({key,text,createdAtMs:now});
}
function armedMessage(a){
  return [
    '👀 WAITING RETEST','',
    a.symbol+' · '+(a.side==='LONG'?'做多':'做空'),
    'Session：'+a.sessionLabel,
    '突破已确认，但还不能追。',
    '等回踩确认后才会变成 ACTIONABLE。',
    '回踩窗口至：'+sgtTime(a.expiresOpenTime+M15)+' SGT'
  ].join('\n');
}
function armEndMessage(a,reason='EXPIRED'){
  return [
    reason==='REJECTED'?'⚪ SETUP INVALID':'⌛ SETUP EXPIRED','',
    a.symbol+' · '+(a.side==='LONG'?'做多':'做空'),
    reason==='REJECTED'?'回踩后的结构不再合格，这次跳过。':'回踩窗口结束，这次机会作废。',
    '不要追价，等下一次 setup。'
  ].join('\n');
}
function lifecycleMessage(t,event){
  const head=t.symbol+' · '+(t.side==='LONG'?'做多':'做空');
  if(event==='EXPIRED') return ['⌛ ENTRY EXPIRED','',head,'进场窗口已结束。','未进场：跳过，不要追。','已进场：继续按原 SL / TP 管理。'].join('\n');
  if(event==='TP1'){
    const pct=t.mode==='TREND_RETEST'?'40%':'50%';
    return ['✅ TP1 HIT','',head,'先止盈 '+pct,'SL → Entry（BE）','剩余仓位继续跑 TP2。'].join('\n');
  }
  if(event==='TP2'){
    if(t.mode==='TREND_RETEST') return ['✅ TP2 HIT','',head,'再止盈 30%','剩余 30% → Runner','Runner 用动态 Trail 管理。'].join('\n');
    return ['✅ TP2 HIT','',head,'剩余 50% 止盈。','这单完成。'].join('\n');
  }
  if(event==='SL') return ['❌ SL HIT','',head,'结构失效，停止这单。','纸面结果：-1R'].join('\n');
  if(event==='TP1_BE') return ['🟦 BE EXIT','',head,'TP1 已拿到，剩余仓位在 Entry 保本离场。','这单结束。'].join('\n');
  if(event==='RUNNER_EXIT'){
    const rr=Number(t.realizedR);
    return ['🏁 RUNNER EXIT','',head,Number.isFinite(rr)?'纸面结果：'+(rr>=0?'+':'')+rr.toFixed(2)+'R':'Runner 已触发动态退出。','这单完成。'].join('\n');
  }
  if(event==='AMBIGUOUS') return ['⚠️ CANDLE AMBIGUOUS','',head,'同一根 M15 同时触及 SL / TP，无法确认先后。','这单不计入确定结果。'].join('\n');
  if(event==='RUNNER') return ['🏃 RUNNER ACTIVE','',head,'TP2 已完成，剩余仓位进入 Runner。'].join('\n');
  return null;
}
async function flushAlerts(state){
  const pending=Array.isArray(state.pendingAlerts)?state.pendingAlerts:[];
  const keep=[];
  for(const a of pending.slice(0,20)){
    try{
      const ok=await telegram(a.text);
      if(!ok) keep.push(a);
    }catch(e){
      keep.push(a);
      console.error(JSON.stringify({telegram:'LIFECYCLE_ERROR',key:a.key,error:e.message}));
    }
  }
  state.pendingAlerts=keep.concat(pending.slice(20));
}
function ema20At(candles){
  const e=emaSeries(candles.map(x=>x.close),20); return e?e.at(-1):null;
}
function updateTrade(t,candles,now=Date.now()){
  if(t.terminal) return false;
  ensureTradeLifecycle(t);
  let changed=false;
  const xs=candles.filter(x=>x.openTime>t.lastOpenTime).sort((a,b)=>a.openTime-b.openTime);
  for(const c of xs){
    const stopHit=t.side==='LONG'?c.low<=t.stop:c.high>=t.stop;
    const t1=t.side==='LONG'?c.high>=t.tp1:c.low<=t.tp1;
    const t2=t.side==='LONG'?c.high>=t.tp2:c.low<=t.tp2;
    if(!t.tp1Hit && stopHit && t1){ t.status='AMBIGUOUS'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=null; changed=true; break; }
    if(!t.tp1Hit && stopHit){ t.status='SL'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=-1; changed=true; break; }
    if(!t.tp1Hit && t1){
      t.tp1Hit=true; changed=true; t.status='TP1'; t.actionState='MANAGING'; t.stop=t.entry; t.beActive=true; t.beActivatedAtMs=c.openTime+M15;
    }
    if(t.mode==='RANGE_SWEEP'){
      if(t.tp1Hit&&!t.tp2Hit&&stopHit){ const r1=Math.abs(t.tp1-t.entry)/t.riskDistance; t.status='TP1_BE'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=0.5*r1; changed=true; break; }
      if(t2){ const r1=Math.abs(t.tp1-t.entry)/t.riskDistance,r2=Math.abs(t.tp2-t.entry)/t.riskDistance; t.tp2Hit=true;t.status='TP2';t.actionState='CLOSED';t.terminal=true;t.realizedR=0.5*r1+0.5*r2;changed=true;break; }
    }else{
      if(t.tp1Hit&&!t.tp2Hit&&stopHit){ t.status='TP1_BE';t.actionState='CLOSED';t.terminal=true;t.realizedR=0.4;changed=true;break; }
      if(!t.tp2Hit&&t2){ t.tp2Hit=true;t.runnerActive=true;t.status='RUNNER';t.actionState='RUNNER';t.stop=t.entry;changed=true; }
      if(t.runnerActive){
        const history=candles.filter(x=>x.openTime<=c.openTime).slice(-30); const e20=ema20At(history); const a=atr(history,14);
        if(Number.isFinite(e20)&&Number.isFinite(a)){
          const trail=t.side==='LONG'?e20-0.15*a:e20+0.15*a;
          if(t.runnerTrail===null) t.runnerTrail=trail;
          else t.runnerTrail=t.side==='LONG'?Math.max(t.runnerTrail,trail):Math.min(t.runnerTrail,trail);
          const trailHit=t.side==='LONG'?c.low<=t.runnerTrail:c.high>=t.runnerTrail;
          if(trailHit){
            const rr=t.side==='LONG'?(t.runnerTrail-t.entry)/t.riskDistance:(t.entry-t.runnerTrail)/t.riskDistance;
            t.status='RUNNER_EXIT';t.actionState='CLOSED';t.terminal=true;t.realizedR=0.4+0.6+0.3*rr;changed=true;break;
          }
        }
      }
    }
    t.lastOpenTime=c.openTime;
  }
  if(!t.terminal&&t.actionState==='ACTIONABLE'&&Number.isFinite(Number(t.entryExpiresAtMs))&&Number(now)>=Number(t.entryExpiresAtMs)){
    t.actionState='EXPIRED'; t.expiredAtMs=Number(t.entryExpiresAtMs); if(t.status==='ACTIONABLE') t.status='EXPIRED'; changed=true;
  }
  return changed;
}
function dailyResolvedR(state,date){
  return Object.values(state.trades).filter(t=>t.terminal&&Number.isFinite(t.realizedR)&&sgtDate(t.signalAtMs)===date).reduce((a,t)=>a+t.realizedR,0);
}
function drawdownStats(trades){
  const rs=trades.filter(t=>t.terminal&&Number.isFinite(t.realizedR)).sort((a,b)=>a.signalAtMs-b.signalAtMs).map(t=>t.realizedR);
  let eq=0,peak=0,dd=0,ls=0,maxLs=0;
  for(const r of rs){eq+=r;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);if(r<0){ls++;maxLs=Math.max(maxLs,ls);}else ls=0;}
  return {resolved:rs.length,totalR:rs.reduce((a,b)=>a+b,0),avgR:rs.length?avg(rs):null,winRate:rs.length?rs.filter(x=>x>0).length/rs.length:null,maxDrawdownR:dd,maxLossStreak:maxLs};
}
async function telegram(text){
  if(!BOT_TOKEN||!CHAT_ID) return false;
  const res=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT_ID,text,disable_web_page_preview:true})});
  if(!res.ok) throw new Error('Telegram '+res.status); return true;
}
function signalMessage(s){
  const icon=s.side==='LONG'?'🟢':'🔴';
  const guard=chaseGuard(s);
  const expires=Number(s.signalAtMs)+ENTRY_VALID_MS;
  return [
    icon+' HUNTER ADAPTIVE',
    '状态：🟢 ACTIONABLE',
    '',
    s.symbol+' · '+(s.side==='LONG'?'做多':'做空'),
    '模式：'+(s.mode==='TREND_RETEST'?'趋势突破回踩':'区间扫流动性'),
    'Session：'+s.sessionLabel,
    '',
    '进场：'+fmt(s.entry,s.symbol),
    'Limit Entry：'+fmt(guard.limitEntry,s.symbol),
    guard.boundaryLabel+'：'+fmt(guard.chasePrice,s.symbol)+'（最多 '+guard.maxChaseR.toFixed(2)+'R）',
    guard.skipLabel,
    '止损：'+fmt(s.stop,s.symbol),
    '目标1：'+fmt(s.tp1,s.symbol),
    '目标2：'+fmt(s.tp2,s.symbol),
    '管理：'+s.plan,
    '风险：'+(RISK_PCT*100).toFixed(2)+'% equity',
    '',
    '结构SL：约 '+s.riskAtr.toFixed(2)+'× M15 ATR',
    '确认：'+sgtTime(s.signalAtMs)+' SGT',
    '有效到：'+sgtTime(expires)+' SGT（约 '+Math.round(ENTRY_VALID_MS/60000)+'分钟）',
    '过期后不要追，等下一次 setup。',
    '',
    'Signal only · 不自动下单'
  ].join('\n');
}
async function cycle(now=Date.now()){
  const state=loadState(),date=sgtDate(now);
  const results=await Promise.allSettled(SYMBOLS.map(s=>snapshot(s,now)));
  const snaps=[]; const errors=[];
  results.forEach((r,i)=>{if(r.status==='fulfilled')snaps.push(r.value);else errors.push({symbol:SYMBOLS[i],error:String(r.reason&&r.reason.message||r.reason)});});
  for(const snap of snaps){
    for(const t of Object.values(state.trades).filter(x=>x.symbol===snap.symbol&&!x.terminal)){
      ensureTradeLifecycle(t);
      const before=lifecycleSnapshot(t);
      updateTrade(t,snap.m15,now);
      for(const event of lifecycleEvents(before,t)) queueAlert(state,'TRADE|'+t.key+'|'+event,lifecycleMessage(t,event),now);
    }
  }
  const dailyR=dailyResolvedR(state,date); const killed=dailyR<=DAILY_STOP_R;
  const candidates=[];
  for(const snap of snaps){
    const latest=snap.m15.at(-1); if(!latest) continue;
    const lastClose=latest.openTime+M15;
    const expectedClose=expectedClosedM15(now);
    const feedLag=Math.max(0,expectedClose-lastClose);
    const candleAge=now-lastClose;
    if(snap.symbol==='XAUUSD'&&xauMarketClosed(now)){
      state.market[snap.symbol]={
        symbol:snap.symbol,provider:snap.provider,regime:'CLOSED',side:null,adx:null,lastClose:latest.close,
        lastCandleClose:lastClose,lagMinutes:feedLag/60000,candleAgeMinutes:candleAge/60000,updatedAt:now,
        marketClosed:true,feedCandidates:snap.feedCandidates||null,feedErrors:snap.feedErrors||null
      };
      continue;
    }
    if(feedLag>MAX_FEED_BEHIND_MS||candleAge<-60000){
      state.market[snap.symbol]={
        symbol:snap.symbol,provider:snap.provider,regime:'STALE',side:null,adx:null,lastClose:latest.close,
        lastCandleClose:lastClose,lagMinutes:feedLag/60000,candleAgeMinutes:candleAge/60000,updatedAt:now,
        feedCandidates:snap.feedCandidates||null,feedErrors:snap.feedErrors||null
      };
      errors.push({symbol:snap.symbol,error:'STALE_'+snap.provider+'_'+(feedLag/60000).toFixed(1)+'m'});
      continue;
    }
    const reg=regime(snap);
    state.market[snap.symbol]={symbol:snap.symbol,provider:snap.provider,regime:reg.type,side:reg.side||null,adx:reg.adx||null,lastClose:latest.close,lastCandleClose:lastClose,lagMinutes:feedLag/60000,candleAgeMinutes:candleAge/60000,updatedAt:now,feedCandidates:snap.feedCandidates||null,feedErrors:snap.feedErrors||null};
    for(const sid of ['LONDON','NEW_YORK']){
      const session=sessionFor(snap.symbol,sid); const box=boxFor(snap.m15,session,latest.openTime); if(!box) continue;
      const armKey=snap.symbol+'|'+session.id+'|'+box.date;
      if(reg.type==='TREND'&&!killed){
        const bo=freshBreakout(snap.m15,box,reg.side);
        if(bo){
          const vwap=dailyVwap(snap.m15,bo.candle.openTime);
          const vwapOk=vwapGate(reg.side,bo.candle.close,vwap);
          if(vwapOk&&!state.armed[armKey]){
            const arm={symbol:snap.symbol,session:session.id,sessionLabel:session.label,date:box.date,side:reg.side,status:'WAITING_RETEST',breakoutOpenTime:bo.candle.openTime,expiresOpenTime:bo.candle.openTime+RETEST_BARS*M15,boxHigh:box.high,boxLow:box.low};
            state.armed[armKey]=arm;
            queueAlert(state,'ARMED|'+armKey+'|'+arm.breakoutOpenTime,armedMessage(arm),now);
          }
        }
        const arm=state.armed[armKey];
        if(arm){
          if(latest.openTime>arm.expiresOpenTime){
            queueAlert(state,'ARM_END|'+armKey+'|'+arm.breakoutOpenTime,armEndMessage(arm,'EXPIRED'),now);
            delete state.armed[armKey];
          }
          else{
            const sig=retestSignal(snap,arm,box,reg);
            if(sig&&sig.reject){
              queueAlert(state,'ARM_REJECT|'+armKey+'|'+arm.breakoutOpenTime,armEndMessage(arm,'REJECTED'),now);
              delete state.armed[armKey];
            }
            else if(sig){
              const key='ADAPT|'+armKey+'|'+sig.candle.openTime+'|'+sig.side;
              if(!state.sent[key]){
                candidates.push({...sig,key,symbol:snap.symbol,session:session.id,sessionLabel:session.label,signalAtMs:sig.candle.openTime+M15});
                delete state.armed[armKey];
              }
            }
          }
        }
      }else if(reg.type==='RANGE'&&!killed){
        const sig=rangeSignal(snap,box,reg);
        if(sig){
          const key='ADAPT|'+armKey+'|'+sig.candle.openTime+'|'+sig.side;
          if(!state.sent[key]) candidates.push({...sig,key,symbol:snap.symbol,session:session.id,sessionLabel:session.label,signalAtMs:sig.candle.openTime+M15});
        }
      }
    }
  }
  if(!killed){
    const crypto=candidates.filter(x=>x.symbol!=='XAUUSD');
    if(crypto.length>1){
      crypto.sort((a,b)=>a.riskAtr-b.riskAtr);
      const keep=crypto[0].key;
      for(let i=candidates.length-1;i>=0;i-=1) if(candidates[i].symbol!=='XAUUSD'&&candidates[i].key!==keep) candidates.splice(i,1);
    }
  }
  await flushAlerts(state);
  for(const s of candidates){
    try{
      if(await telegram(signalMessage(s))){
        state.sent[s.key]={atMs:now,symbol:s.symbol,side:s.side};
        state.trades[s.key]=tradeFromSignal(s);
      }
    }catch(e){ console.error(JSON.stringify({telegram:'ERROR',error:e.message,key:s.key})); }
  }
  state.lastScan={at:now,date,errors,dailyR,killed,candidates:candidates.map(x=>({symbol:x.symbol,mode:x.mode,side:x.side,entry:x.entry,stop:x.stop,tp1:x.tp1,tp2:x.tp2,signalAtMs:x.signalAtMs,entryExpiresAtMs:Number(x.signalAtMs)+ENTRY_VALID_MS,actionState:'ACTIONABLE'})),armed:Object.values(state.armed).map(x=>({symbol:x.symbol,session:x.sessionLabel,side:x.side,status:'WAITING_RETEST',expiresOpenTime:x.expiresOpenTime}))};
  state.stats=drawdownStats(Object.values(state.trades));
  saveState(state);
  const result={engine:VERSION,at:new Date(now).toISOString(),dailyR,killed,market:state.market,candidates:state.lastScan.candidates,armed:state.lastScan.armed,stats:state.stats,errors};
  console.log(JSON.stringify(result));
  return result;
}
if(require.main===module){ cycle().catch(e=>{console.error(JSON.stringify({fatal:e.message}));process.exitCode=1;}); }
module.exports={VERSION,ENTRY_VALID_MS,emaSeries,trueRanges,atr,adx14,regime,boxFor,freshBreakout,qualityGate,retestSignal,rangeSignal,ensureTradeLifecycle,lifecycleSnapshot,lifecycleEvents,lifecycleMessage,armedMessage,armEndMessage,updateTrade,drawdownStats,yahooCandles,xausChartCandles,snapshotFreshness,chooseFreshestSnapshot,dailyVwap,vwapGate,goldSnapshot,xauMarketClosed,chaseGuard,signalMessage,cycle};
