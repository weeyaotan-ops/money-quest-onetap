'use strict';

const fs = require('fs');
const path = require('path');
const { getHistoricalRates } = require('dukascopy-node');
const { marketContext, scoreSignal, decisionLabel, compactIntelligence } = require('./hunter_core_v1/intelligence');
const { detect: detectV21Shadow } = require('./hunter_core_v1/v21_shadow_opportunity');

const M15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const VERSION = 'HUNTER_ADAPTIVE_V2_2026-10-07_TREND_BEAST';
const STATE_PATH = process.env.ADAPTIVE_STATE_PATH || '.hunter_state/adaptive_state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const BINANCE_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com';
const OKX_BASE = process.env.OKX_REST_BASE || 'https://www.okx.com';
const YAHOO_BASE = process.env.YAHOO_FINANCE_BASE || 'https://query1.finance.yahoo.com';
const XAUS_BASE = process.env.XAUS_API_BASE || 'https://xaus.com';
const MAX_FEED_BEHIND_MS = Number(process.env.ADAPTIVE_MAX_FEED_BEHIND_MS || 60 * 1000);
const DAILY_STOP_R = Number(process.env.ADAPTIVE_DAILY_STOP_R || -2);
const RISK_PCT = Number(process.env.ADAPTIVE_RISK_PCT || 0.0075);
const EQUITY_USDT = Math.max(1, Number(process.env.ADAPTIVE_EQUITY_USDT || 250));
const MAX_LEVERAGE = Math.max(1, Math.min(10, Math.floor(Number(process.env.ADAPTIVE_MAX_LEVERAGE || 10))));
const MAX_MARGIN_FRACTION = Math.min(0.95, Math.max(0.10, Number(process.env.ADAPTIVE_MAX_MARGIN_FRACTION || 0.60)));
const TAKER_FEE_RATE = Math.max(0, Number(process.env.ADAPTIVE_TAKER_FEE_RATE || 0.0005));
const SLIPPAGE_BUFFER_RATE = Math.max(0, Number(process.env.ADAPTIVE_SLIPPAGE_BUFFER_RATE || 0.0002));
const LIVE_LIFECYCLE = String(process.env.ADAPTIVE_LIVE_LIFECYCLE || '') === '1';
const MAX_CHASE_R = Math.min(0.25, Math.max(0, Number(process.env.ADAPTIVE_MAX_CHASE_R || 0.05)));
const ENTRY_PULLBACK_ATR = Math.min(0.50, Math.max(0.05, Number(process.env.ADAPTIVE_ENTRY_PULLBACK_ATR || 0.25)));
const ENTRY_CHASE_ATR = Math.min(0.10, Math.max(0, Number(process.env.ADAPTIVE_ENTRY_CHASE_ATR || 0.03)));
const ENTRY_REARM_ATR = Math.min(0.25, Math.max(0.01, Number(process.env.ADAPTIVE_ENTRY_REARM_ATR || 0.08)));
const BARRIER_BLOCK_ATR = Math.min(1.00, Math.max(0.05, Number(process.env.ADAPTIVE_BARRIER_BLOCK_ATR || 0.30)));
const BARRIER_BLOCK_R = Math.min(2.00, Math.max(0.10, Number(process.env.ADAPTIVE_BARRIER_BLOCK_R || 0.75)));
const RETEST_BARS = Number(process.env.ADAPTIVE_RETEST_BARS || 4);
const ENTRY_VALID_MS = Math.max(M15, Number(process.env.ADAPTIVE_ENTRY_VALID_MS || M15));
const SYMBOLS = String(process.env.ADAPTIVE_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,LINKUSDT,LTCUSDT,AVAXUSDT,SUIUSDT,NEARUSDT,ZECUSDT,XAUUSD')
  .split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
const SATELLITE_SYMBOLS = new Set(['NEARUSDT','ZECUSDT']); // kept only for metadata/backward compatibility
const MIN_QUALITY_SCORE = Math.min(100,Math.max(0,Number(process.env.ADAPTIVE_MIN_QUALITY_SCORE || 70)));

const SESSION_DEFS = {
  LONDON: { id:'LONDON', label:'London', tz:'Europe/London', hour:8, minute:0 },
  NY_CRYPTO: { id:'NY_CRYPTO', label:'New York', tz:'America/New_York', hour:9, minute:30 },
  NY_GOLD: { id:'NY_GOLD', label:'New York Gold', tz:'America/New_York', hour:8, minute:30 }
};

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function num(x){ if(x===null||x===undefined||x==='') return null; const n=Number(x); return Number.isFinite(n)?n:null; }
function priceDecimals(symbol){
  const m={
    BTCUSDT:1,ETHUSDT:2,SOLUSDT:2,XRPUSDT:4,BNBUSDT:2,DOGEUSDT:5,
    LINKUSDT:3,LTCUSDT:2,AVAXUSDT:3,SUIUSDT:4,NEARUSDT:3,ZECUSDT:2,XAUUSD:2
  };
  return m[String(symbol||'').toUpperCase()] ?? 4;
}
function fmt(x,symbol){
  if(x===null||x===undefined||x==='') return 'n/a';
  const n=Number(x); if(!Number.isFinite(n)) return 'n/a';
  return n.toFixed(priceDecimals(symbol));
}
function qtyStep(symbol){
  const m={
    BTCUSDT:0.001,ETHUSDT:0.001,SOLUSDT:0.01,XRPUSDT:0.1,BNBUSDT:0.01,DOGEUSDT:1,
    LINKUSDT:0.01,LTCUSDT:0.001,AVAXUSDT:1,SUIUSDT:0.1,NEARUSDT:1,ZECUSDT:0.001,
    XAUUSD:0.001
  };
  return m[String(symbol||'').toUpperCase()] ?? 0.001;
}
function minNotional(symbol){
  const m={
    BTCUSDT:50,ETHUSDT:20,SOLUSDT:5,XRPUSDT:5,BNBUSDT:5,DOGEUSDT:5,
    LINKUSDT:20,LTCUSDT:20,AVAXUSDT:5,SUIUSDT:5,NEARUSDT:5,ZECUSDT:5
  };
  return m[String(symbol||'').toUpperCase()] ?? 0;
}
function managementPlan(s){
  if(String(s&&s.mode||'')==='RANGE_SWEEP'){
    return {id:'RANGE',label:'Range 50/50',tp1Pct:0.50,tp2Pct:0.50,runnerPct:0,trailAtr:0,peakTrailR:null};
  }
  const saved=s&&s.management;
  if(saved&&['RUNNER','BEAST'].includes(String(saved.id))&&
     Number.isFinite(Number(saved.tp1Pct))&&Number.isFinite(Number(saved.tp2Pct))&&Number.isFinite(Number(saved.runnerPct))){
    return saved;
  }
  const side=String(s&&s.side||'').toUpperCase();
  const want=side==='LONG'?'BULLISH':side==='SHORT'?'BEARISH':null;
  const intel=s&&s.intelligence||{};
  const st=intel.structure||{};
  const score=Number(intel.score);
  const adx=Number(s&&s.adx);
  const phase=String(s&&s.regimePhase||'');
  const room=String(intel.entryRoom&&intel.entryRoom.state||'CLEAR');
  const beast=String(s&&s.mode||'')==='TREND_RETEST'&&want&&
    Number.isFinite(score)&&score>=88&&Number.isFinite(adx)&&adx>=23&&phase==='CONFIRMED'&&
    st.h4===want&&st.m15===want&&room==='CLEAR';
  if(beast){
    return {id:'BEAST',label:'🔥 Trend Beast',tp1Pct:0.20,tp2Pct:0.20,runnerPct:0.60,trailAtr:0.45,peakTrailR:2};
  }
  return {id:'RUNNER',label:'🏃 Trend Runner',tp1Pct:0.30,tp2Pct:0.30,runnerPct:0.40,trailAtr:0.15,peakTrailR:null};
}
function pctLabel(x){ return Math.round(Math.max(0,Number(x)||0)*100)+'%'; }
function tradeRAt(t,price){
  const p=Number(price),entry=Number(t&&t.entry),risk=Math.abs(Number(t&&t.riskDistance));
  if(!Number.isFinite(p)||!Number.isFinite(entry)||!(risk>0)) return null;
  return t.side==='SHORT'?(entry-p)/risk:(p-entry)/risk;
}
function updateBestR(t,price){
  const r=tradeRAt(t,price);
  if(!Number.isFinite(r)) return null;
  if(!Number.isFinite(Number(t.bestR))||r>Number(t.bestR)) t.bestR=r;
  return Number(t.bestR);
}
function runnerProtectivePrice(t){
  const entry=Number(t&&t.entry),risk=Math.abs(Number(t&&t.riskDistance));
  if(!Number.isFinite(entry)||!(risk>0)) return entry;
  const mg=managementPlan(t);
  let protective=entry;
  const structural=Number(t&&t.runnerTrail);
  if(Number.isFinite(structural)){
    protective=t.side==='SHORT'?Math.min(protective,structural):Math.max(protective,structural);
  }
  if(mg.id==='BEAST'&&Number.isFinite(Number(t.bestR))&&Number(t.bestR)>=3){
    const lockR=Math.max(0,Number(t.bestR)-Number(mg.peakTrailR||2));
    const peakFloor=t.side==='SHORT'?entry-lockR*risk:entry+lockR*risk;
    protective=t.side==='SHORT'?Math.min(protective,peakFloor):Math.max(protective,peakFloor);
  }
  return protective;
}
function floorStep(value,step){
  if(!(step>0)||!Number.isFinite(Number(value))) return Number(value);
  return Math.floor((Number(value)+1e-12)/step)*step;
}
function executionPlan(s,equityUsdt=EQUITY_USDT,riskPct=RISK_PCT){
  const entry=Number(s&&s.entry),stop=Number(s&&s.stop),tp1=Number(s&&s.tp1),tp2=Number(s&&s.tp2);
  if(![entry,stop,tp1,tp2].every(Number.isFinite)||entry<=0) return {valid:false,costOk:false};
  const stopRate=Math.abs(entry-stop)/entry;
  const frictionRate=2*TAKER_FEE_RATE+SLIPPAGE_BUFFER_RATE;
  const riskRate=stopRate+frictionRate;
  const capital=Math.max(1,Number(equityUsdt)||EQUITY_USDT);
  const appliedRiskPct=Math.min(0.02,Math.max(0.001,Number(riskPct)||RISK_PCT));
  const riskBudget=capital*appliedRiskPct;
  const maxMargin=capital*MAX_MARGIN_FRACTION;
  let notional=riskRate>0?riskBudget/riskRate:0;
  notional=Math.min(notional,maxMargin*MAX_LEVERAGE);
  let leverage=Math.ceil(notional/Math.max(maxMargin,1e-9));
  leverage=Math.max(1,Math.min(MAX_LEVERAGE,leverage));
  const step=qtyStep(s.symbol);
  let quantity=floorStep(notional/entry,step);
  if(!(quantity>0)) quantity=0;
  notional=quantity*entry;
  if(notional>0 && notional<minNotional(s.symbol)) quantity=0;
  notional=quantity*entry;
  const initialMargin=leverage>0?notional/leverage:0;
  const stopLoss=quantity*Math.abs(entry-stop);
  const estFeesToStop=quantity*(entry+stop)*TAKER_FEE_RATE;
  const estSlippage=notional*SLIPPAGE_BUFFER_RATE;
  const estMaxLoss=stopLoss+estFeesToStop+estSlippage;
  const tp1Gross=quantity*Math.abs(tp1-entry);
  const tp2Gross=quantity*Math.abs(tp2-entry);
  const tp1Fees=quantity*(entry+tp1)*TAKER_FEE_RATE;
  const tp2Fees=quantity*(entry+tp2)*TAKER_FEE_RATE;
  const tp1Net=tp1Gross-tp1Fees-estSlippage;
  const tp2Net=tp2Gross-tp2Fees-estSlippage;
  const riskDistance=Math.abs(entry-stop);
  const management=managementPlan(s);
  const p1=management.tp1Pct,p2=management.tp2Pct,pr=management.runnerPct;
  const runner3Price=s.side==='SHORT'?entry-3*riskDistance:entry+3*riskDistance;
  const stagedGrossBe=p1*quantity*Math.abs(tp1-entry)+p2*quantity*Math.abs(tp2-entry);
  const stagedFeesBe=quantity*entry*TAKER_FEE_RATE+
    p1*quantity*tp1*TAKER_FEE_RATE+
    p2*quantity*tp2*TAKER_FEE_RATE+
    pr*quantity*entry*TAKER_FEE_RATE;
  const stagedTp2Net=stagedGrossBe-stagedFeesBe-estSlippage;
  const stagedGross3R=stagedGrossBe+pr*quantity*Math.abs(runner3Price-entry);
  const stagedFees3R=quantity*entry*TAKER_FEE_RATE+
    p1*quantity*tp1*TAKER_FEE_RATE+
    p2*quantity*tp2*TAKER_FEE_RATE+
    pr*quantity*runner3Price*TAKER_FEE_RATE;
  const runner3Net=stagedGross3R-stagedFees3R-estSlippage;
  const tp1MoveRate=Math.abs(tp1-entry)/entry;
  const tp2Cost=Math.max(0,tp2Gross-tp2Net);
  const tp2CostShare=tp2Gross>0?tp2Cost/tp2Gross:1;
  const minTp2Net=0.5*riskBudget;
  let costReason='OK';
  if(!(quantity>0)) costReason='仓位太小 / 低于 Binance 最小下单金额';
  else if(!(tp1MoveRate>frictionRate&&tp1Net>0)) costReason='TP1 扣成本后不赚钱';
  else if(tp2Net<minTp2Net) costReason='TP2 净利润少于 0.5R';
  else if(tp2CostShare>0.25) costReason='交易成本超过 TP2 毛利 25%';
  const costOk=costReason==='OK';
  const qtyDecimals=step>=1?0:Math.max(0,String(step).split('.')[1]?.length||0);
  return {
    valid:true,costOk,equityUsdt:capital,riskPct:appliedRiskPct,riskBudget,
    marginMode:'ISOLATED',leverage,maxLeverage:MAX_LEVERAGE,
    maxMarginFraction:MAX_MARGIN_FRACTION,quantity,qtyDecimals,notional,initialMargin,
    takerFeeRate:TAKER_FEE_RATE,slippageBufferRate:SLIPPAGE_BUFFER_RATE,
    stopRate,frictionRate,estMaxLoss,tp1Net,tp2Net,stagedTp2Net,runner3Net,runner3Price,tp2Gross,tp2CostShare,minTp2Net,costReason,management
  };
}

function universeQualityOk(signal){
  const score=Number(signal&&signal.intelligence&&signal.intelligence.score);
  return Number.isFinite(score)&&score>=MIN_QUALITY_SCORE;
}
function rangeSideAllowed(side,context){
  const s=String(side||'').toUpperCase();
  const h4=String(context&&context.structure&&context.structure.h4||'NEUTRAL');
  if(s==='LONG'&&h4==='BEARISH') return false;
  if(s==='SHORT'&&h4==='BULLISH') return false;
  return s==='LONG'||s==='SHORT';
}
function universeRank(a,b){
  const as=Number(a&&a.intelligence&&a.intelligence.score)||0;
  const bs=Number(b&&b.intelligence&&b.intelligence.score)||0;
  if(bs!==as) return bs-as;
  return (Number(a&&a.riskAtr)||999)-(Number(b&&b.riskAtr)||999);
}
function snowballRisk(signal,equityUsdt,highWaterEquity){
  const equity=Math.max(1,Number(equityUsdt)||EQUITY_USDT);
  const peak=Math.max(equity,Number(highWaterEquity)||equity);
  const drawdown=peak>0?(peak-equity)/peak:0;
  const score=Number(signal&&signal.intelligence&&signal.intelligence.score);
  if(drawdown>=0.05) return {riskPct:0.005,label:'保护模式',drawdown,peak};
  if(Number.isFinite(score)&&score>=90) return {riskPct:0.01,label:'A+ 加速',drawdown,peak};
  return {riskPct:0.0075,label:'标准滚雪球',drawdown,peak};
}
function signalIdFor(s){
  const symbol=String(s&&s.symbol||'X').replace(/[^A-Z0-9]/gi,'').slice(0,12);
  const side=String(s&&s.side||'').toUpperCase()==='SHORT'?'S':'L';
  const ts=Math.max(0,Number(s&&s.signalAtMs)||Date.now()).toString(36);
  return symbol+'_'+ts+'_'+side;
}
function signalKeyboard(s){
  const id=String(s&&s.signalId||signalIdFor(s));
  return {inline_keyboard:[[
    {text:'✅ 我已手动进场',callback_data:'enter:'+id},
    {text:'⏭️ Skip',callback_data:'skip:'+id}
  ]]};
}
function entryZone(s){
  const entry=Number(s?.entry), stop=Number(s?.stop);
  const side=String(s?.side||'').toUpperCase();
  const riskDistance=Math.abs(entry-stop);
  const atr15=Number(s?.atr15 ?? s?.intelligence?.a15);
  const valid=Number.isFinite(entry)&&Number.isFinite(stop)&&riskDistance>0&&(side==='LONG'||side==='SHORT');
  if(!valid) return {valid:false,low:null,high:null,ideal:null,chaseDelta:0,pullbackDelta:0};
  const chaseByR=riskDistance*MAX_CHASE_R;
  const chaseByAtr=Number.isFinite(atr15)&&atr15>0?atr15*ENTRY_CHASE_ATR:chaseByR;
  const chaseDelta=Math.max(0,Math.min(chaseByR,chaseByAtr));
  const pullbackByR=riskDistance*0.35;
  const pullbackByAtr=Number.isFinite(atr15)&&atr15>0?atr15*ENTRY_PULLBACK_ATR:pullbackByR;
  const pullbackDelta=Math.max(0,Math.min(pullbackByR,pullbackByAtr));
  if(side==='LONG'){
    const low=Math.max(stop+0.10*riskDistance,entry-pullbackDelta);
    const high=entry+chaseDelta;
    const ideal=entry-Math.min(pullbackDelta*0.50,Number.isFinite(atr15)&&atr15>0?atr15*0.10:pullbackDelta*0.50);
    return {valid:true,low,high,ideal,chaseDelta,pullbackDelta,atr15:Number.isFinite(atr15)?atr15:null};
  }
  const low=entry-chaseDelta;
  const high=Math.min(stop-0.10*riskDistance,entry+pullbackDelta);
  const ideal=entry+Math.min(pullbackDelta*0.50,Number.isFinite(atr15)&&atr15>0?atr15*0.10:pullbackDelta*0.50);
  return {valid:true,low,high,ideal,chaseDelta,pullbackDelta,atr15:Number.isFinite(atr15)?atr15:null};
}
function barrierRoomAt(s,price){
  const p=Number(price);
  const entry=Number(s?.entry), stop=Number(s?.stop);
  const side=String(s?.side||'').toUpperCase();
  const barrierRaw=s?.intelligence?.entryRoom?.barrier;
  const barrier=(barrierRaw===null||barrierRaw===undefined||barrierRaw==='')?NaN:Number(barrierRaw);
  const atr15=Number(s?.atr15 ?? s?.intelligence?.a15);
  const riskDistance=Math.abs(entry-stop);
  if(!Number.isFinite(p)||!Number.isFinite(barrier)||!Number.isFinite(riskDistance)||!(riskDistance>0)) return {state:'CLEAR',barrier:null,distance:null,barrierAtr:null,barrierR:null};
  const distance=side==='SHORT'?p-barrier:barrier-p;
  if(!(distance>0)) return {state:'CLEAR',barrier,distance,barrierAtr:null,barrierR:null};
  const barrierAtr=Number.isFinite(atr15)&&atr15>0?distance/atr15:null;
  const barrierR=distance/riskDistance;
  let state='CLEAR';
  const wasBlocked=String(s?.entryStatus||'')==='BLOCKED_BARRIER';
  const blockAtr=wasBlocked?BARRIER_BLOCK_ATR+0.05:BARRIER_BLOCK_ATR;
  const blockR=wasBlocked?BARRIER_BLOCK_R+0.10:BARRIER_BLOCK_R;
  if((Number.isFinite(barrierAtr)&&barrierAtr<blockAtr)||barrierR<blockR) state='BLOCK';
  else if((Number.isFinite(barrierAtr)&&barrierAtr<0.55)||barrierR<1.00) state='TIGHT';
  return {state,barrier,distance,barrierAtr,barrierR};
}
function entryDecision(t,price,now=Date.now()){
  if(!t||typeof t!=='object') return {state:'INVALID',price:null};
  if(t.terminal) return {state:'CLOSED',price:null};
  if(t.entryConfirmed) return {state:'CONFIRMED',price:Number.isFinite(Number(price))?Number(price):null};
  if(Number.isFinite(Number(t.entryExpiresAtMs))&&Number(now)>=Number(t.entryExpiresAtMs)) return {state:'EXPIRED',price:Number.isFinite(Number(price))?Number(price):null};
  const p=(price===null||price===undefined||price==='')?NaN:Number(price);
  if(!Number.isFinite(p)) return {state:'UNKNOWN',price:null};
  const guard=chaseGuard(t);
  const zone=guard.entryZone;
  const stop=Number(t.stop);
  if(t.side==='LONG'&&Number.isFinite(stop)&&p<=stop) return {state:'INVALID',price:p,guard,zone};
  if(t.side==='SHORT'&&Number.isFinite(stop)&&p>=stop) return {state:'INVALID',price:p,guard,zone};
  const room=barrierRoomAt(t,p);
  if(room.state==='BLOCK') return {state:'BLOCKED_BARRIER',price:p,guard,zone,room};
  const atr15=Number(t?.atr15 ?? t?.intelligence?.a15);
  const rearm=Number.isFinite(atr15)&&atr15>0?atr15*ENTRY_REARM_ATR:Math.abs(Number(t.entry)-Number(t.stop))*0.10;
  const prev=String(t.entryStatus||'');
  if(t.side==='LONG'){
    if(p>zone.high || (prev==='DO_NOT_CHASE'&&p>zone.high-rearm)) return {state:'DO_NOT_CHASE',price:p,guard,zone,room};
    if(p<zone.low || (prev==='WAIT_ZONE'&&p<zone.low+rearm)) return {state:'WAIT_ZONE',price:p,guard,zone,room};
    return {state:'ENTER',price:p,guard,zone,room,priceGrade:p<=zone.ideal?'GOOD':'NORMAL'};
  }
  if(t.side==='SHORT'){
    if(p<zone.low || (prev==='DO_NOT_CHASE'&&p<zone.low+rearm)) return {state:'DO_NOT_CHASE',price:p,guard,zone,room};
    if(p>zone.high || (prev==='WAIT_ZONE'&&p>zone.high-rearm)) return {state:'WAIT_ZONE',price:p,guard,zone,room};
    return {state:'ENTER',price:p,guard,zone,room,priceGrade:p>=zone.ideal?'GOOD':'NORMAL'};
  }
  return {state:'INVALID',price:p,guard,zone,room};
}
function chaseGuard(s){
  const entry=Number(s?.entry);
  const side=String(s?.side||'').toUpperCase();
  const zone=entryZone(s);
  const chasePrice=zone.valid?(side==='SHORT'?zone.low:zone.high):entry;
  return {
    limitEntry:entry,
    chasePrice,
    maxChaseR:MAX_CHASE_R,
    entryZone:zone,
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
  if(!Number.isFinite(Number(ts))) return 'n/a';
  const ps=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(Number(ts)));
  const o={}; for(const p of ps) if(p.type!=='literal') o[p.type]=p.value;
  return o.day+'/'+o.month+', '+o.hour+':'+o.minute;
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
  const [binanceGoldResult,xausResult,dukaResult,yahooResult]=await Promise.allSettled([
    Promise.all([binanceCandles('XAUUSDT','15m',300,now),binanceCandles('XAUUSDT','4h',120,now)])
      .then(([m15,h4])=>({symbol:'XAUUSD',provider:'BINANCE_XAUUSDT',m15,h4})),
    xausGoldSnapshot(now),
    Promise.all([duka('XAUUSD','m15',7,now),duka('XAUUSD','h1',30,now)])
      .then(([m15,h1])=>({symbol:'XAUUSD',provider:'DUKASCOPY',m15,h4:aggregateH4(h1)})),
    yahooGoldSnapshot(now)
  ]);
  const candidates=[];
  if(binanceGoldResult.status==='fulfilled') candidates.push(binanceGoldResult.value);
  if(xausResult.status==='fulfilled') candidates.push(xausResult.value);
  if(dukaResult.status==='fulfilled') candidates.push(dukaResult.value);
  if(yahooResult.status==='fulfilled') candidates.push(yahooResult.value);
  const feedErrors=[
    binanceGoldResult.status==='rejected'?'BINANCE_XAU:'+(binanceGoldResult.reason?.message||'failed'):null,
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

  // Confirmed trend: classic EMA stack.
  if(c>v20&&v20>v50&&v20>v20prev&&adx>=18) return {type:'TREND',side:'LONG',phase:'CONFIRMED',adx,a15,a4,ema20:v20,ema50:v50};
  if(c<v20&&v20<v50&&v20<v20prev&&adx>=18) return {type:'TREND',side:'SHORT',phase:'CONFIRMED',adx,a15,a4,ema20:v20,ema50:v50};

  // Transition trend: allow a new move before EMA20/EMA50 fully cross.
  // LONG and SHORT use exact mirror conditions to avoid directional bias.
  const longTransition=c>v20&&c>v50&&v20>v20prev&&adx>=18;
  const shortTransition=c<v20&&c<v50&&v20<v20prev&&adx>=18;
  if(longTransition) return {type:'TREND',side:'LONG',phase:'TRANSITION',adx,a15,a4,ema20:v20,ema50:v50};
  if(shortTransition) return {type:'TREND',side:'SHORT',phase:'TRANSITION',adx,a15,a4,ema20:v20,ema50:v50};

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
function setupWatch(symbol,reg,box,session,latest){
  const base={symbol,session:session?.id||null,sessionLabel:session?.label||'',regime:reg?.type||'NEUTRAL',side:reg?.side||null};
  if(!box){
    return {...base,status:'WAIT_BOX',instruction:'等前30分钟开盘区间形成'};
  }
  const lastOpen=Number(latest?.openTime);
  if(Number.isFinite(lastOpen)&&lastOpen>=Number(box.activeUntil)){
    return {...base,status:'SESSION_DONE',boxHigh:box.high,boxLow:box.low,activeUntil:box.activeUntil};
  }
  if(Number.isFinite(lastOpen)&&lastOpen<Number(box.activeFrom)){
    return {...base,status:'WAIT_BOX_CLOSE',boxHigh:box.high,boxLow:box.low,activeFrom:box.activeFrom,activeUntil:box.activeUntil,instruction:'等前30分钟 Box 完成'};
  }
  if(reg?.type==='TREND'&&reg?.side==='LONG'){
    return {...base,status:'WAIT_BREAKOUT',trigger:box.high,boxHigh:box.high,boxLow:box.low,activeUntil:box.activeUntil,instruction:'等 M15 收盘站上 Box High，再等回踩确认'};
  }
  if(reg?.type==='TREND'&&reg?.side==='SHORT'){
    return {...base,status:'WAIT_BREAKOUT',trigger:box.low,boxHigh:box.high,boxLow:box.low,activeUntil:box.activeUntil,instruction:'等 M15 收盘跌破 Box Low，再等回踩确认'};
  }
  if(reg?.type==='RANGE'){
    return {...base,status:'WAIT_SWEEP_RECLAIM',boxHigh:box.high,boxLow:box.low,activeUntil:box.activeUntil,instruction:'等价格扫出 Box 后，M15 收回 Box 内'};
  }
  if(reg?.type==='CHAOS') return {...base,status:'WAIT_CALM',boxHigh:box.high,boxLow:box.low,activeUntil:box.activeUntil,instruction:'波动太乱，等市场恢复正常'};
  return {...base,status:'WAIT_DIRECTION',boxHigh:box.high,boxLow:box.low,activeUntil:box.activeUntil,instruction:'等方向变清楚'};
}
function freshBreakout(candles,box,trendSide){
  const cur=candles.at(-1),prev=candles.at(-2); if(!cur||!prev) return null;
  if(cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) return null;
  if(trendSide==='LONG'&&prev.close<=box.high&&cur.close>box.high) return {side:'LONG',candle:cur};
  if(trendSide==='SHORT'&&prev.close>=box.low&&cur.close<box.low) return {side:'SHORT',candle:cur};
  return null;
}
function recentBreakout(candles,box,trendSide,maxAgeBars=RETEST_BARS){
  const latest=candles.at(-1); if(!latest||!box) return null;
  const minOpen=Number(latest.openTime)-Math.max(0,Number(maxAgeBars)||0)*M15;
  for(let i=candles.length-1;i>=1;i-=1){
    const cur=candles[i],prev=candles[i-1];
    if(cur.openTime<minOpen) break;
    if(cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) continue;
    if(trendSide==='LONG'&&prev.close<=box.high&&cur.close>box.high) return {side:'LONG',candle:cur};
    if(trendSide==='SHORT'&&prev.close>=box.low&&cur.close<box.low) return {side:'SHORT',candle:cur};
  }
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
    return {mode:'TREND_RETEST',side:'LONG',entry:cur.close,stop,tp1:cur.close+risk,tp2:cur.close+2*risk,riskDistance:risk,riskAtr:gate.riskAtr,atr15:a,referenceLevel:box.high,candle:cur,plan:'30%@1R · 30%@2R · 40% Runner'};
  }else{
    const touched=cur.high>=box.low-0.25*a && cur.high<=box.low+0.60*a;
    const reclaimed=cur.close<box.low && vwapGate('SHORT',cur.close,vwap) && cur.close<=cur.open;
    if(!touched||!reclaimed) return null;
    const swing=Math.max(...xs.map(x=>x.high)); const stop=swing+0.15*a; const gate=qualityGate(cur.close,stop,a);
    if(!gate.ok) return {reject:true,reason:gate.reason};
    const risk=stop-cur.close;
    return {mode:'TREND_RETEST',side:'SHORT',entry:cur.close,stop,tp1:cur.close-risk,tp2:cur.close-2*risk,riskDistance:risk,riskAtr:gate.riskAtr,atr15:a,referenceLevel:box.low,candle:cur,plan:'30%@1R · 30%@2R · 40% Runner'};
  }
}
function rangeSignal(snap,box,reg){
  const cur=snap.m15.at(-1),prev=snap.m15.at(-2); if(!cur||!prev||cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) return null;
  const a=reg.a15; if(!(a>0)) return null;
  if(cur.low<box.low-0.10*a && cur.close>box.low && prev.low>=box.low-0.10*a){
    const stop=cur.low-0.15*a; const risk=cur.close-stop; const r1=(box.mid-cur.close)/risk, r2=(box.high-cur.close)/risk;
    if(risk<=0||r1<0.8||r2<1.5) return null;
    const gate=qualityGate(cur.close,stop,a); if(!gate.ok) return null;
    return {mode:'RANGE_SWEEP',side:'LONG',entry:cur.close,stop,tp1:box.mid,tp2:box.high,riskDistance:risk,riskAtr:gate.riskAtr,atr15:a,referenceLevel:box.low,candle:cur,plan:'50%@中线 · 50%@另一边Box'};
  }
  if(cur.high>box.high+0.10*a && cur.close<box.high && prev.high<=box.high+0.10*a){
    const stop=cur.high+0.15*a; const risk=stop-cur.close; const r1=(cur.close-box.mid)/risk, r2=(cur.close-box.low)/risk;
    if(risk<=0||r1<0.8||r2<1.5) return null;
    const gate=qualityGate(cur.close,stop,a); if(!gate.ok) return null;
    return {mode:'RANGE_SWEEP',side:'SHORT',entry:cur.close,stop,tp1:box.mid,tp2:box.low,riskDistance:risk,riskAtr:gate.riskAtr,atr15:a,referenceLevel:box.high,candle:cur,plan:'50%@中线 · 50%@另一边Box'};
  }
  return null;
}

function recentRangeSweep(candles,box,a15,maxAgeBars=RETEST_BARS){
  const latest=candles.at(-1);
  if(!latest||!box||!(a15>0)) return null;
  const minOpen=Number(latest.openTime)-Math.max(0,Number(maxAgeBars)||0)*M15;
  for(let i=candles.length-1;i>=1;i-=1){
    const cur=candles[i],prev=candles[i-1];
    if(cur.openTime<minOpen) break;
    if(cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) continue;

    let side=null;
    if(cur.low<box.low-0.10*a15 && prev.low>=box.low-0.10*a15) side='LONG';
    else if(cur.high>box.high+0.10*a15 && prev.high<=box.high+0.10*a15) side='SHORT';
    if(!side) continue;

    // Do not resurrect an old sweep whose first reclaim already happened on an earlier bar.
    const after=candles.slice(i);
    const firstReclaim=after.find(x=>side==='LONG'?x.close>box.low:x.close<box.high);
    if(firstReclaim&&firstReclaim.openTime<latest.openTime) continue;

    return {
      side,
      candle:cur,
      sweepOpenTime:cur.openTime,
      sweepExtreme:side==='LONG'?cur.low:cur.high,
      referenceLevel:side==='LONG'?box.low:box.high
    };
  }
  return null;
}

function rangeReclaimSignal(snap,armed,box,reg){
  if(!armed||String(armed.status)!=='WAITING_RECLAIM') return null;
  const a=Number(reg&&reg.a15);
  if(!(a>0)) return null;
  const xs=snap.m15.filter(x=>x.openTime>=Number(armed.sweepOpenTime)&&x.openTime<=Number(armed.expiresOpenTime));
  if(!xs.length) return null;
  const cur=xs.at(-1);

  if(armed.side==='LONG'){
    if(!(cur.close>box.low)) return null;
    const swing=Math.min(...xs.map(x=>x.low));
    const stop=swing-0.15*a;
    const risk=cur.close-stop;
    if(!(risk>0)) return {reject:true,reason:'risk invalid'};
    const r1=(box.mid-cur.close)/risk, r2=(box.high-cur.close)/risk;
    if(r1<0.8||r2<1.5) return {reject:true,reason:'RR不足'};
    const gate=qualityGate(cur.close,stop,a);
    if(!gate.ok) return {reject:true,reason:gate.reason};
    return {
      mode:'RANGE_SWEEP',side:'LONG',entry:cur.close,stop,tp1:box.mid,tp2:box.high,
      riskDistance:risk,riskAtr:gate.riskAtr,atr15:a,referenceLevel:box.low,
      candle:cur,sweepOpenTime:armed.sweepOpenTime,plan:'50%@中线 · 50%@另一边Box'
    };
  }

  if(!(cur.close<box.high)) return null;
  const swing=Math.max(...xs.map(x=>x.high));
  const stop=swing+0.15*a;
  const risk=stop-cur.close;
  if(!(risk>0)) return {reject:true,reason:'risk invalid'};
  const r1=(cur.close-box.mid)/risk, r2=(cur.close-box.low)/risk;
  if(r1<0.8||r2<1.5) return {reject:true,reason:'RR不足'};
  const gate=qualityGate(cur.close,stop,a);
  if(!gate.ok) return {reject:true,reason:gate.reason};
  return {
    mode:'RANGE_SWEEP',side:'SHORT',entry:cur.close,stop,tp1:box.mid,tp2:box.low,
    riskDistance:risk,riskAtr:gate.riskAtr,atr15:a,referenceLevel:box.high,
    candle:cur,sweepOpenTime:armed.sweepOpenTime,plan:'50%@中线 · 50%@另一边Box'
  };
}
function normalizeState(x){
  const s=x&&typeof x==='object'?x:{};
  if(!s.sent||typeof s.sent!=='object') s.sent={};
  if(!s.armed||typeof s.armed!=='object') s.armed={};
  if(!s.trades||typeof s.trades!=='object') s.trades={};
  if(!s.daily||typeof s.daily!=='object') s.daily={};
  if(!s.market||typeof s.market!=='object') s.market={};
  if(!s.alerted||typeof s.alerted!=='object') s.alerted={};
  if(!Array.isArray(s.pendingAlerts)) s.pendingAlerts=[];
  for(const t of Object.values(s.trades)) ensureTradeLifecycle(t);
  s.version=VERSION; return s;
}
function loadState(){ try{return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH,'utf8')));}catch{return normalizeState({});} }
function saveState(s){ fs.mkdirSync(path.dirname(STATE_PATH),{recursive:true}); const tmp=STATE_PATH+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(s,null,2)); fs.renameSync(tmp,STATE_PATH); }
function tradeFromSignal(sig){
  const signalId=sig.signalId||signalIdFor(sig);
  return {key:sig.key,signalId,symbol:sig.symbol,provider:sig.provider||null,session:sig.session,mode:sig.mode,side:sig.side,regimePhase:sig.regimePhase||null,adx:Number.isFinite(Number(sig.adx))?Number(sig.adx):null,signalEntry:sig.entry,entry:sig.entry,stop:sig.stop,initialStop:sig.stop,tp1:sig.tp1,tp2:sig.tp2,riskDistance:sig.riskDistance,riskAtr:sig.riskAtr,atr15:sig.atr15,referenceLevel:sig.referenceLevel,entryZone:entryZone(sig),signalAtMs:sig.signalAtMs,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:Number(sig.signalAtMs)+ENTRY_VALID_MS,expiredAtMs:null,terminal:false,entryConfirmed:false,entryConfirmedAtMs:null,actualEntryPrice:null,entryStatus:sig.intelligence?.entryRoom?.state==='BLOCK'?'BLOCKED_BARRIER':'ENTER',tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,bestR:0,management:managementPlan(sig),beActive:false,lastOpenTime:sig.candle.openTime,realizedR:null,decision:sig.decision||null,isReentry:Boolean(sig.isReentry),intelligence:sig.intelligence||null,execution:sig.execution||executionPlan(sig)};
}
function ensureTradeLifecycle(t){
  if(!t||typeof t!=='object') return t;
  if(!Number.isFinite(Number(t.initialStop))&&Number.isFinite(Number(t.stop))) t.initialStop=Number(t.stop);
  if(!Number.isFinite(Number(t.entryExpiresAtMs))&&Number.isFinite(Number(t.signalAtMs))) t.entryExpiresAtMs=Number(t.signalAtMs)+ENTRY_VALID_MS;
  if(typeof t.entryConfirmed!=='boolean') t.entryConfirmed=true;
  if(!t.signalId&&Number.isFinite(Number(t.signalAtMs))) t.signalId=signalIdFor(t);
  if(!t.management||!['RANGE','RUNNER','BEAST'].includes(String(t.management.id))) t.management=managementPlan(t);
  if(!Number.isFinite(Number(t.bestR))) t.bestR=0;
  if(!t.actionState){
    if(t.terminal) t.actionState='CLOSED';
    else if(t.runnerActive) t.actionState='RUNNER';
    else if(t.tp1Hit) t.actionState='MANAGING';
    else t.actionState=t.entryConfirmed?'OPEN':'ACTIONABLE';
  }
  if(t.entryConfirmed&&!t.terminal&&!t.tp1Hit&&t.actionState==='ACTIONABLE') t.actionState='OPEN';
  if(t.entryConfirmed&&t.status==='ACTIONABLE') t.status='OPEN';
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
  if(!text||!key) return false;
  if(!state.alerted||typeof state.alerted!=='object') state.alerted={};
  if(state.alerted[key]) return false;
  if(state.pendingAlerts.some(x=>x&&x.key===key)) return false;
  state.pendingAlerts.push({key,text,createdAtMs:now});
  return true;
}
function armedPreview(a){
  const rawLevel=(a&&a.retestLevel) ?? (a&&a.side==='LONG'?a&&a.boxHigh:a&&a.boxLow);
  const level=num(rawLevel);
  const atr15=num(a&&a.atr15);
  const side=String(a&&a.side||'').toUpperCase();
  if(level===null||!(atr15>0)||(side!=='LONG'&&side!=='SHORT')){
    return {valid:false,level,low:null,high:null,stop:null,tp2:null};
  }
  if(side==='LONG'){
    return {valid:true,level,low:level-0.60*atr15,high:level+0.25*atr15,stop:level-0.75*atr15,tp2:level+1.50*atr15};
  }
  return {valid:true,level,low:level-0.25*atr15,high:level+0.60*atr15,stop:level+0.75*atr15,tp2:level-1.50*atr15};
}
function activeArmedRows(rows,market,now=Date.now()){
  return (Array.isArray(rows)?rows:[]).filter(a=>{
    if(!a) return false;
    const exp=num(a.expiresOpenTime);
    if(exp===null||Number(now)>=exp+M15) return false;
    const m=market&&market[a.symbol];
    if(!m) return false;
    const status=String(a.status||'');
    if(status==='WAITING_RETEST') return String(m.regime)==='TREND'&&String(m.side)===String(a.side);
    if(status==='WAITING_RECLAIM'){
      const h4=String(m.intelligence&&m.intelligence.structure&&m.intelligence.structure.h4||'NEUTRAL');
      if(String(m.regime)!=='RANGE') return false;
      if(String(a.side)==='LONG'&&h4==='BEARISH') return false;
      if(String(a.side)==='SHORT'&&h4==='BULLISH') return false;
      return true;
    }
    return false;
  });
}
function armedMessage(a){
  const current=num(a.currentPrice);
  const side=a.side==='LONG'?'做多':'做空';
  const direction=a.side==='LONG'?'🟢 LONG':'🔴 SHORT';

  if(String(a.status)==='WAITING_RECLAIM'){
    const level=a.side==='LONG'?num(a.boxLow):num(a.boxHigh);
    return [
      '🟡 WATCH · '+a.symbol,
      direction+' · '+side,
      'Session：'+a.sessionLabel,
      current!==null?'现在价：'+fmt(current,a.symbol):null,
      num(a.boxLow)!==null&&num(a.boxHigh)!==null?'Box：'+fmt(a.boxLow,a.symbol)+' – '+fmt(a.boxHigh,a.symbol):null,
      level!==null?(a.side==='LONG'?'已扫破下方：':'已扫破上方：')+fmt(level,a.symbol):null,
      '',
      '现在：先不要进。',
      level!==null?'下一步：等 M15 收回 '+fmt(level,a.symbol)+(a.side==='LONG'?' 上方。':' 下方。'):'下一步：等 M15 收回 Box。',
      '确认成功 → 🟠 READY → Bot 重算最终 Entry / SL / TP。',
      '确认窗口至：'+sgtTime(a.expiresOpenTime+M15)+' SGT'
    ].filter(Boolean).join('\n');
  }

  const p=armedPreview(a);
  const zoneLabel=a.side==='LONG'?'等买区':'等卖区';
  return [
    '🟡 WATCH · '+a.symbol,
    direction+' · '+side,
    'Session：'+a.sessionLabel,
    current!==null?'现在价：'+fmt(current,a.symbol):null,
    p.valid?zoneLabel+'：'+fmt(p.low,a.symbol)+' – '+fmt(p.high,a.symbol):null,
    p.valid?'预估止损：'+fmt(p.stop,a.symbol):null,
    p.valid?'预估目标2：'+fmt(p.tp2,a.symbol):null,
    '',
    '现在：不要追。',
    p.valid?'下一步：等 M15 回踩后重新收在关键位 '+fmt(p.level,a.symbol)+(a.side==='LONG'?' 上方。':' 下方。'):'下一步：等 M15 回踩确认。',
    '确认成功 → 🟠 READY → Bot 重算最终 Entry / SL / TP。',
    '确认窗口至：'+sgtTime(a.expiresOpenTime+M15)+' SGT'
  ].filter(Boolean).join('\n');
}
function invalidReasonText(detail,isRange=false){
  const x=String(detail||'').trim();
  if(x==='RR不足') return 'RR 不够，利润空间不值得进';
  if(x==='SL太近') return 'SL 太近，容易被正常波动扫掉';
  if(x==='SL太远') return 'SL 太远，这单风险不划算';
  if(x==='risk invalid') return 'Entry / SL 风险结构不成立';
  if(x==='REGIME_CHANGED') return isRange?'市场已经离开原本区间':'趋势或方向已经改变';
  if(x==='H4_OPPOSITE') return 'H4 大方向不支持这边';
  if(x) return x;
  return isRange?'M15 收回条件没有成立':'M15 回踩确认条件没有成立';
}
function armEndMessage(a,reason='EXPIRED',detail=''){
  const isRange=String(a&&a.status)==='WAITING_RECLAIM';
  const direction=a&&a.side==='LONG'?'🟢 LONG':'🔴 SHORT';
  if(reason==='REJECTED'){
    return [
      '❌ INVALID · '+a.symbol,
      direction,
      '原因：'+invalidReasonText(detail,isRange),
      '处理：这次跳过，不追价。'
    ].join('\n');
  }
  return [
    '⌛ EXPIRED · '+a.symbol,
    direction,
    isRange?'原因：M15 收回确认窗口已结束。':'原因：M15 回踩确认窗口已结束。',
    '处理：这次机会作废，等下一次 setup。'
  ].join('\n');
}
function lifecycleMessage(t,event){
  const head=t.symbol+' · '+(t.side==='LONG'?'做多':'做空');
  const auto=Boolean(t.autoManaged);
  const mg=managementPlan(t);
  const p1=pctLabel(mg.tp1Pct),p2=pctLabel(mg.tp2Pct),pr=pctLabel(mg.runnerPct);
  const beast=mg.id==='BEAST';
  if(event==='EXPIRED') return ['⌛ 太迟了，这单不要','',head,'进场时间已经过了。','不要追，等下一单。'].join('\n');
  if(event==='TP1'){
    if(auto) return ['✅ 到目标1','',head,'Bot 已自动处理 '+p1,'止损会自动拉到入场价。'].join('\n');
    return ['✅ 到目标1','',head,'现在卖 '+p1,'止损拉到入场价，剩下继续跑。'].join('\n');
  }
  if(event==='TP2'){
    if(t.mode==='TREND_RETEST'){
      if(auto) return ['✅ 到目标2','',head,'Bot 已自动处理 '+p2,'剩下 '+pr+' 自动继续跑。',beast?'🔥 Trend Beast：不设死 TP，跟趋势。':null].filter(Boolean).join('\n');
      return ['✅ 到目标2','',head,'再卖 '+p2,'剩下 '+pr+' 继续跑，Bot 会帮你盯。',beast?'🔥 Trend Beast：不设死 TP，跟趋势。':null].filter(Boolean).join('\n');
    }
    if(auto) return ['✅ 到目标2','',head,'Bot 已自动处理剩余仓位。','这单完成。'].join('\n');
    return ['✅ 到目标2','',head,'剩下 '+p2+' 全部卖掉。','这单完成。'].join('\n');
  }
  if(event==='SL') return ['❌ 止损了','',head,auto?'Binance 保护单会自动处理。':'这单结束。','不要马上追回去。'].join('\n');
  if(event==='TP1_BE') return ['🛡️ 保本离场','',head,'目标1已经拿到，剩下仓位在入场价保护。','这单结束。'].join('\n');
  if(event==='RUNNER_EXIT') return ['🏁 Runner 已离场','',head,beast?'🔥 Trend Beast runner 已完成。':'Runner 已完成。',Number.isFinite(Number(t.realizedR))?'策略结果：'+(Number(t.realizedR)>=0?'+':'')+Number(t.realizedR).toFixed(2)+'R':null].filter(Boolean).join('\n');
  if(event==='AMBIGUOUS') return ['⚠️ 这根K线看不清先后','',head,'同一根K线同时碰到止损和目标。','Bot 不乱算结果。'].join('\n');
  if(event==='RUNNER') return [beast?'🔥 Trend Beast 启动':'🏃 Runner 启动','',head,'剩下 '+pr+' 继续跑',beast?'达到更高 R 后会自动锁住一部分浮盈，不用固定 3R/4R 就走。':(auto?'Bot 会自动跟着保护。':'Bot 继续帮你盯剩余仓位。')].join('\n');
  return null;
}
async function flushAlerts(state){
  const pending=Array.isArray(state.pendingAlerts)?state.pendingAlerts:[];
  const keep=[];
  for(const a of pending.slice(0,20)){
    try{
      if(state.alerted&&state.alerted[a.key]) continue;
      const ok=await telegram(a.text);
      if(ok){
        if(!state.alerted||typeof state.alerted!=='object') state.alerted={};
        state.alerted[a.key]=Date.now();
      }else keep.push(a);
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
  if(!t.entryConfirmed) return false;
  let changed=false;
  const mg=managementPlan(t);
  const xs=candles.filter(x=>x.openTime>t.lastOpenTime).sort((a,b)=>a.openTime-b.openTime);
  for(const c of xs){
    updateBestR(t,t.side==='LONG'?c.high:c.low);
    const stopHit=t.side==='LONG'?c.low<=t.stop:c.high>=t.stop;
    const t1=t.side==='LONG'?c.high>=t.tp1:c.low<=t.tp1;
    const t2=t.side==='LONG'?c.high>=t.tp2:c.low<=t.tp2;
    if(!t.tp1Hit && stopHit && t1){ t.status='AMBIGUOUS'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=null; changed=true; break; }
    if(!t.tp1Hit && stopHit){ t.status='SL'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=-1; changed=true; break; }
    if(!t.tp1Hit && t1){
      t.tp1Hit=true; changed=true; t.status='TP1'; t.actionState='MANAGING'; t.stop=t.entry; t.beActive=true; t.beActivatedAtMs=c.openTime+M15;
    }
    if(t.mode==='RANGE_SWEEP'){
      if(t.tp1Hit&&!t.tp2Hit&&stopHit){
        const r1=Math.abs(t.tp1-t.entry)/t.riskDistance;
        t.status='TP1_BE'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=mg.tp1Pct*r1; changed=true; break;
      }
      if(t2){
        const r1=Math.abs(t.tp1-t.entry)/t.riskDistance,r2=Math.abs(t.tp2-t.entry)/t.riskDistance;
        t.tp2Hit=true;t.status='TP2';t.actionState='CLOSED';t.terminal=true;t.realizedR=mg.tp1Pct*r1+mg.tp2Pct*r2;changed=true;break;
      }
    }else{
      if(t.tp1Hit&&!t.tp2Hit&&stopHit){
        const r1=Math.abs(t.tp1-t.entry)/t.riskDistance;
        t.status='TP1_BE';t.actionState='CLOSED';t.terminal=true;t.realizedR=mg.tp1Pct*r1;changed=true;break;
      }
      let runnerStartedThisBar=false;
      if(!t.tp2Hit&&t2){
        t.tp2Hit=true;t.runnerActive=true;t.status='RUNNER';t.actionState='RUNNER';t.stop=t.entry;changed=true;runnerStartedThisBar=true;
      }
      if(t.runnerActive){
        const history=candles.filter(x=>x.openTime<=c.openTime).slice(-30); const e20=ema20At(history); const a=atr(history,14);
        if(Number.isFinite(e20)&&Number.isFinite(a)){
          const trail=t.side==='LONG'?e20-mg.trailAtr*a:e20+mg.trailAtr*a;
          if(t.runnerTrail===null) t.runnerTrail=trail;
          else t.runnerTrail=t.side==='LONG'?Math.max(t.runnerTrail,trail):Math.min(t.runnerTrail,trail);
        }
        if(!runnerStartedThisBar){
          const protective=runnerProtectivePrice(t);
          const exitHit=t.side==='LONG'?c.low<=protective:c.high>=protective;
          if(exitHit){
            const rr=t.side==='LONG'?(protective-t.entry)/t.riskDistance:(t.entry-protective)/t.riskDistance;
            const r1=Math.abs(t.tp1-t.entry)/t.riskDistance,r2=Math.abs(t.tp2-t.entry)/t.riskDistance;
            t.status='RUNNER_EXIT';t.actionState='CLOSED';t.terminal=true;t.realizedR=mg.tp1Pct*r1+mg.tp2Pct*r2+mg.runnerPct*rr;changed=true;break;
          }
        }
      }
    }
    t.lastOpenTime=c.openTime;
  }
  if(!LIVE_LIFECYCLE&&!t.terminal&&t.actionState==='ACTIONABLE'&&Number.isFinite(Number(t.entryExpiresAtMs))&&Number(now)>=Number(t.entryExpiresAtMs)){
    t.actionState='EXPIRED'; t.expiredAtMs=Number(t.entryExpiresAtMs); if(t.status==='ACTIONABLE') t.status='EXPIRED'; changed=true;
  }
  return changed;
}
function updateTradePrice(t,price,now=Date.now()){
  if(t.terminal) return false;
  ensureTradeLifecycle(t);
  if(!t.entryConfirmed) return false;
  let changed=false;
  const mg=managementPlan(t);
  const p=(price===null||price===undefined||price==='')?NaN:Number(price);
  if(Number.isFinite(p)){
    updateBestR(t,p);
    const stopHit=t.side==='LONG'?p<=Number(t.stop):p>=Number(t.stop);
    const t1=t.side==='LONG'?p>=Number(t.tp1):p<=Number(t.tp1);
    const t2=t.side==='LONG'?p>=Number(t.tp2):p<=Number(t.tp2);

    if(!t.tp1Hit&&stopHit){
      t.status='SL'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=-1; changed=true;
    }else if(!t.terminal){
      if(!t.tp1Hit&&t1){
        t.tp1Hit=true; changed=true; t.status='TP1'; t.actionState='MANAGING';
        t.stop=t.entry; t.beActive=true; t.beActivatedAtMs=Number(now);
      }
      if(t.mode==='RANGE_SWEEP'){
        const liveStopHit=t.side==='LONG'?p<=Number(t.stop):p>=Number(t.stop);
        if(t.tp1Hit&&!t.tp2Hit&&liveStopHit){
          const r1=Math.abs(t.tp1-t.entry)/t.riskDistance;
          t.status='TP1_BE'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=mg.tp1Pct*r1; changed=true;
        }else if(!t.terminal&&t2){
          const r1=Math.abs(t.tp1-t.entry)/t.riskDistance,r2=Math.abs(t.tp2-t.entry)/t.riskDistance;
          t.tp2Hit=true; t.status='TP2'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=mg.tp1Pct*r1+mg.tp2Pct*r2; changed=true;
        }
      }else{
        const liveStopHit=t.side==='LONG'?p<=Number(t.stop):p>=Number(t.stop);
        if(t.tp1Hit&&!t.tp2Hit&&liveStopHit){
          const r1=Math.abs(t.tp1-t.entry)/t.riskDistance;
          t.status='TP1_BE'; t.actionState='CLOSED'; t.terminal=true; t.realizedR=mg.tp1Pct*r1; changed=true;
        }else if(!t.terminal&&!t.tp2Hit&&t2){
          t.tp2Hit=true; t.runnerActive=true; t.status='RUNNER'; t.actionState='RUNNER'; t.stop=t.entry; changed=true;
        }
        if(!t.terminal&&t.runnerActive){
          const protective=runnerProtectivePrice(t);
          const exitHit=t.side==='LONG'?p<=protective:p>=protective;
          if(exitHit){
            const rr=t.side==='LONG'?(protective-t.entry)/t.riskDistance:(t.entry-protective)/t.riskDistance;
            const r1=Math.abs(t.tp1-t.entry)/t.riskDistance,r2=Math.abs(t.tp2-t.entry)/t.riskDistance;
            t.status='RUNNER_EXIT'; t.actionState='CLOSED'; t.terminal=true;
            t.realizedR=mg.tp1Pct*r1+mg.tp2Pct*r2+mg.runnerPct*rr; changed=true;
          }
        }
      }
    }
    t.lastLivePrice=p;
    t.lastLivePriceAtMs=Number(now);
  }

  if(!t.terminal&&t.actionState==='ACTIONABLE'&&Number.isFinite(Number(t.entryExpiresAtMs))&&Number(now)>=Number(t.entryExpiresAtMs)){
    t.actionState='EXPIRED'; t.expiredAtMs=Number(t.entryExpiresAtMs);
    if(t.status==='ACTIONABLE') t.status='EXPIRED';
    changed=true;
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
async function telegram(text,replyMarkup=null){
  if(!BOT_TOKEN||!CHAT_ID) return false;
  const body={chat_id:CHAT_ID,text,disable_web_page_preview:true};
  if(replyMarkup) body.reply_markup=replyMarkup;
  const res=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.ok===false) throw new Error('Telegram '+res.status);
  return data;
}
function fmtZone(zone,symbol){
  if(!zone||!Number.isFinite(Number(zone.low))||!Number.isFinite(Number(zone.high))) return 'n/a';
  return fmt(zone.low,symbol)+' - '+fmt(zone.high,symbol);
}
function biasText(x){
  if(x==='BULLISH') return 'Bullish';
  if(x==='BEARISH') return 'Bearish';
  return 'Neutral';
}
function qualityText(intel){
  const score=Number(intel&&intel.score);
  if(!Number.isFinite(score)) return 'n/a';
  const label=String(intel.label||'');
  const zh=label==='HIGH'?'HIGH':label==='GOOD'?'GOOD':label==='FAIR'?'FAIR':'LOW';
  return score.toFixed(0)+'/100 · '+zh;
}
function signalMessage(s){
  const ex=s.execution||executionPlan(s);
  const mg=managementPlan(s);
  const expires=Number(s.signalAtMs)+ENTRY_VALID_MS;
  const score=Number(s.intelligence&&s.intelligence.score);
  const side=s.side==='LONG'?'做多 LONG':'做空 SHORT';
  const qtyUnit=String(s.symbol||'').replace('USDT','');
  const zone=s.entryZone||entryZone(s);
  const room=s.intelligence&&s.intelligence.entryRoom;
  const barrierLabel=s.side==='LONG'?'前方阻力':'前方支撑';
  const hasBarrier=room&&room.barrier!==null&&room.barrier!==undefined&&room.barrier!==''&&Number.isFinite(Number(room.barrier));
  const barrierLine=hasBarrier
    ?barrierLabel+'：'+fmt(room.barrier,s.symbol)+(room.barrierR!==null&&room.barrierR!==undefined&&Number.isFinite(Number(room.barrierR))?' · '+Number(room.barrierR).toFixed(2)+'R':'')
    :null;
  const roomLine=room&&room.state==='BLOCK'?'价位判断：先别进，前方空间太近':room&&room.state==='TIGHT'?'价位判断：空间偏紧，尽量等好价':'价位判断：正常';
  const signalHeader=room&&room.state==='BLOCK'
    ?'🟠 READY · '+s.symbol+' · 等安全价'
    :(s.side==='LONG'?'🟢 LONG · ':'🔴 SHORT · ')+s.symbol;
  if(!ex.costOk){
    return [
      '❌ 这单不要做',
      '',
      s.symbol+' · '+side,
      '原因：'+String(ex.costReason||'手续费和利润不划算'),
      '',
      '参考入场：'+fmt(s.entry,s.symbol),
      zone&&zone.valid?'可进区间：'+fmt(zone.low,s.symbol)+' – '+fmt(zone.high,s.symbol):null,
      barrierLine,
      '目标1：'+fmt(s.tp1,s.symbol),
      '目标2：'+fmt(s.tp2,s.symbol),
      '预计目标2净赚：'+(ex.tp2Net>=0?'+':'')+ex.tp2Net.toFixed(2)+'U',
      '',
      '结论：SKIP，等下一单。'
    ].join('\n');
  }
  return [
    signalHeader,
    '',
    '方向：'+side,
    '逐仓：Isolated',
    '杠杆：'+ex.leverage+'x',
    '数量：'+ex.quantity.toFixed(ex.qtyDecimals)+' '+qtyUnit,
    '',
    '参考入场：'+fmt(s.entry,s.symbol),
    zone&&zone.valid?'可进区间：'+fmt(zone.low,s.symbol)+' – '+fmt(zone.high,s.symbol):null,
    zone&&zone.valid?'更好价：约 '+fmt(zone.ideal,s.symbol):null,
    roomLine,
    barrierLine,
    '止损：'+fmt(s.stop,s.symbol),
    '目标1：'+fmt(s.tp1,s.symbol),
    '目标2：'+fmt(s.tp2,s.symbol),
    '',
    '本金：'+ex.equityUsdt.toFixed(0)+'U',
    '滚雪球：'+String(ex.riskLabel||'标准滚雪球')+' · '+(ex.riskPct*100).toFixed(2)+'%',
    '这单最多亏：约 '+ex.estMaxLoss.toFixed(2)+'U',
    s.mode==='TREND_RETEST'?'管理模式：'+mg.label:null,
    '目标1：到价卖 '+pctLabel(mg.tp1Pct),
    '目标2：到价'+(mg.runnerPct>0?'再卖 ':'卖剩下 ')+pctLabel(mg.tp2Pct),
    mg.runnerPct>0?'剩下：'+pctLabel(mg.runnerPct)+' 继续跑 · 不设死 TP':null,
    mg.id==='BEAST'?'🔥 Beast 条件：强趋势确认，runner 会放宽并按最高 R 动态锁利':null,
    s.mode==='TREND_RETEST'?'若剩余跑到约3R：预计整单净赚 '+(ex.runner3Net>=0?'+':'')+ex.runner3Net.toFixed(2)+'U':null,
    Number.isFinite(score)?'信号强度：'+score.toFixed(0)+'/100':null,
    '',
    '有效到：'+sgtTime(expires)+' SGT',
    room&&room.state==='BLOCK'?'先等 Bot 通知进入安全价区':'先在 Binance 手动下单',
    room&&room.state==='BLOCK'?'价格合适后再手动下单':'成交后按【✅ 我已手动进场】',
    '不做就按【⏭️ Skip】'
  ].filter(Boolean).join('\n');
}
async function cycle(now=Date.now()){
  const state=loadState(),date=sgtDate(now);
  if(!state.settings||typeof state.settings!=='object') state.settings={};
  const alertCutoff=now-7*24*HOUR;
  for(const [k,v] of Object.entries(state.alerted||{})){
    if(!Number.isFinite(Number(v))||Number(v)<alertCutoff) delete state.alerted[k];
  }
  const equityUsdt=Math.max(1,Number(state.settings.equityUsdt)||EQUITY_USDT);
  const highWaterEquity=Math.max(equityUsdt,Number(state.settings.highWaterEquity)||equityUsdt);
  state.settings.highWaterEquity=highWaterEquity;
  state.settings.snowballEnabled=true;
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
  const v21Candidates=[]; // Shadow only: never sent to Telegram or made actionable.
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
    const intelContext=marketContext(snap,reg);
    const marketEntry=state.market[snap.symbol]={
      symbol:snap.symbol,provider:snap.provider,regime:reg.type,side:reg.side||null,phase:reg.phase||null,adx:reg.adx||null,a15:reg.a15||null,lastClose:latest.close,
      lastCandleClose:lastClose,lagMinutes:feedLag/60000,candleAgeMinutes:candleAge/60000,updatedAt:now,
      feedCandidates:snap.feedCandidates||null,feedErrors:snap.feedErrors||null,
      intelligence:{structure:intelContext.structure,liquidity:intelContext.liquidity,zones:intelContext.zones},
      watches:[]
    };
    for(const sid of ['LONDON','NEW_YORK']){
      const session=sessionFor(snap.symbol,sid); const box=boxFor(snap.m15,session,latest.openTime);
      const watch=setupWatch(snap.symbol,reg,box,session,latest);
      if(watch.status!=='SESSION_DONE'){
        if(Number.isFinite(Number(watch.trigger))&&Number.isFinite(Number(reg.a15))&&Number(reg.a15)>0){
          watch.distanceAtr=Math.abs(Number(latest.close)-Number(watch.trigger))/Number(reg.a15);
        }
        marketEntry.watches.push(watch);
      }
      if(!box) continue;
      // V2.1 evaluates alternative entries in shadow independently of V2 armed lifecycle.
      // It is deliberately excluded from candidates, sent, trades and Telegram.
      if(reg.type==='TREND'&&!killed){
        const shadow=detectV21Shadow({symbol:snap.symbol,candles:snap.m15,box,regime:reg,
          atr15:reg.a15,vwap:dailyVwap(snap.m15,latest.openTime),now});
        for(const candidate of shadow){
          const shadowKey=[candidate.symbol,session.id,candidate.mode,latest.openTime,candidate.side].join('|');
          if(!state.shadowSeen||typeof state.shadowSeen!=='object')state.shadowSeen={};
          if(!state.shadowSeen[shadowKey]){
            state.shadowSeen[shadowKey]=now;
            v21Candidates.push({...candidate,session:session.id,at:now});
          }
        }
      }
      const armKey=snap.symbol+'|'+session.id+'|'+box.date;
      let arm=state.armed[armKey]||null;

      // Keep only setups that still match the current market regime.
      if(arm){
        const status=String(arm.status||'');
        const validTrend=status==='WAITING_RETEST'&&reg.type==='TREND'&&String(reg.side)===String(arm.side);
        const validRange=status==='WAITING_RECLAIM'&&reg.type==='RANGE'&&rangeSideAllowed(arm.side,intelContext);
        if(!validTrend&&!validRange){
          const origin=arm.breakoutOpenTime??arm.sweepOpenTime??0;
          const rejectDetail=status==='WAITING_RETEST'?'REGIME_CHANGED':(reg.type!=='RANGE'?'REGIME_CHANGED':'H4_OPPOSITE');
          queueAlert(state,'ARM_REJECT|'+armKey+'|'+origin,armEndMessage(arm,'REJECTED',rejectDetail),now);
          delete state.armed[armKey];
          arm=null;
        }
      }

      if(reg.type==='TREND'&&!killed){
        // Recover a breakout that happened a few M15 bars ago if the higher-timeframe
        // confirmation arrived slightly later. Final retest rules are unchanged.
        const bo=recentBreakout(snap.m15,box,reg.side,RETEST_BARS);
        if(bo){
          const withinWindow=Number(latest.openTime)<=Number(bo.candle.openTime)+RETEST_BARS*M15;
          const vwap=dailyVwap(snap.m15,bo.candle.openTime);
          const vwapOk=vwapGate(reg.side,bo.candle.close,vwap);
          if(withinWindow&&vwapOk&&!arm){
            arm={
              symbol:snap.symbol,session:session.id,sessionLabel:session.label,date:box.date,
              side:reg.side,status:'WAITING_RETEST',breakoutOpenTime:bo.candle.openTime,
              expiresOpenTime:bo.candle.openTime+RETEST_BARS*M15,
              boxHigh:box.high,boxLow:box.low,retestLevel:reg.side==='LONG'?box.high:box.low,
              currentPrice:latest.close,atr15:reg.a15
            };
            state.armed[armKey]=arm;
            queueAlert(state,'STATUS|WAITING_RETEST|'+armKey+'|'+arm.breakoutOpenTime+'|'+arm.side,armedMessage(arm),now);
          }
        }

        arm=state.armed[armKey]||null;
        if(arm){
          arm.currentPrice=latest.close;
          arm.atr15=reg.a15;
          const sig=retestSignal(snap,arm,box,reg);
          if(sig&&sig.reject){
            queueAlert(state,'ARM_REJECT|'+armKey+'|'+arm.breakoutOpenTime,armEndMessage(arm,'REJECTED',sig.reason),now);
            delete state.armed[armKey];
          }else if(sig){
            const key='ADAPT|'+armKey+'|'+sig.candle.openTime+'|'+sig.side;
            if(!state.sent[key]){
              const signalAtMs=sig.candle.openTime+M15;
              const signalVwap=dailyVwap(snap.m15,sig.candle.openTime);
              const intelligence=scoreSignal({snap,reg,sig,vwap:signalVwap,context:intelContext});
              const isReentry=Object.keys(state.sent).some(k=>k.startsWith('ADAPT|'+armKey+'|'));
              candidates.push({...sig,key,symbol:snap.symbol,provider:snap.provider,session:session.id,sessionLabel:session.label,signalAtMs,regimePhase:reg.phase||null,adx:Number.isFinite(Number(reg.adx))?Number(reg.adx):null,intelligence:compactIntelligence(intelligence),isReentry,decision:decisionLabel(sig,intelligence,isReentry)});
              delete state.armed[armKey];
            }
          }
        }
      }else if(reg.type==='RANGE'&&!killed){
        const sweep=recentRangeSweep(snap.m15,box,reg.a15,RETEST_BARS);
        const sweepAllowed=sweep?rangeSideAllowed(sweep.side,intelContext):false;
        if(sweep&&sweepAllowed&&!arm){
          arm={
            symbol:snap.symbol,session:session.id,sessionLabel:session.label,date:box.date,
            side:sweep.side,status:'WAITING_RECLAIM',sweepOpenTime:sweep.sweepOpenTime,
            expiresOpenTime:sweep.sweepOpenTime+RETEST_BARS*M15,
            boxHigh:box.high,boxLow:box.low,reclaimLevel:sweep.referenceLevel,
            sweepExtreme:sweep.sweepExtreme,currentPrice:latest.close,atr15:reg.a15
          };
          state.armed[armKey]=arm;
        }
        if(sweep&&!sweepAllowed){
          marketEntry.rangeBiasBlock={side:sweep.side,h4:intelContext.structure?.h4||'NEUTRAL',reason:'H4_OPPOSITE'};
        }

        arm=state.armed[armKey]||null;
        if(arm&&String(arm.status)==='WAITING_RECLAIM'){
          arm.currentPrice=latest.close;
          arm.atr15=reg.a15;
          const sig=rangeReclaimSignal(snap,arm,box,reg);
          if(sig&&sig.reject){
            queueAlert(state,'ARM_REJECT|'+armKey+'|'+arm.sweepOpenTime,armEndMessage(arm,'REJECTED',sig.reason),now);
            delete state.armed[armKey];
          }else if(sig){
            const key='ADAPT|'+armKey+'|RANGE|'+arm.sweepOpenTime+'|'+sig.side;
            if(!state.sent[key]){
              const signalAtMs=sig.candle.openTime+M15;
              const signalVwap=dailyVwap(snap.m15,sig.candle.openTime);
              const intelligence=scoreSignal({snap,reg,sig,vwap:signalVwap,context:intelContext});
              const isReentry=Object.keys(state.sent).some(k=>k.startsWith('ADAPT|'+armKey+'|'));
              candidates.push({...sig,key,symbol:snap.symbol,provider:snap.provider,session:session.id,sessionLabel:session.label,signalAtMs,regimePhase:reg.phase||null,adx:Number.isFinite(Number(reg.adx))?Number(reg.adx):null,intelligence:compactIntelligence(intelligence),isReentry,decision:decisionLabel(sig,intelligence,isReentry)});
              delete state.armed[armKey];
            }
          }else if(sweep&&Number(sweep.sweepOpenTime)===Number(arm.sweepOpenTime)){
            queueAlert(state,'STATUS|WAITING_RECLAIM|'+armKey+'|'+arm.sweepOpenTime+'|'+arm.side,armedMessage(arm),now);
          }
        }
      }
    }
  }

  // Expire every armed setup by absolute time, even if a feed changed regime or went stale.
  for(const [armKey,arm] of Object.entries(state.armed||{})){
    const exp=num(arm&&arm.expiresOpenTime);
    if(exp===null||Number(now)>=exp+M15){
      // Collapse same symbol/direction expiry alerts within one M15 close.
      // Setup dedup remains in alerted/pendingAlerts even after re-scanning.
      if(arm&&exp!==null){
        const timeBucket=Math.floor((exp+M15)/M15);
        const dedupKey=['ARM_EXPIRY',arm.symbol,arm.side,timeBucket].join('|');
        queueAlert(state,dedupKey,armEndMessage(arm,'EXPIRED'),now);
      }
      delete state.armed[armKey];
    }
  }

  if(!killed){
    const busySymbols=new Set(Object.values(state.trades||{}).filter(t=>t&&!t.terminal).map(t=>String(t.symbol||'')));
    for(let i=candidates.length-1;i>=0;i-=1){
      if(busySymbols.has(String(candidates[i].symbol||''))) candidates.splice(i,1);
      else if(!universeQualityOk(candidates[i])) candidates.splice(i,1);
    }
    // Do not silently keep only one crypto. Every independently valid setup may be sent.
    candidates.sort(universeRank);
  }
  await flushAlerts(state);
  for(const s of candidates){
    const risk=snowballRisk(s,equityUsdt,highWaterEquity);
    s.execution={...executionPlan(s,equityUsdt,risk.riskPct),riskLabel:risk.label,drawdown:risk.drawdown,highWaterEquity:risk.peak};
    s.signalId=signalIdFor(s);
    try{
      const sent=await telegram(signalMessage(s),s.execution&&s.execution.costOk?signalKeyboard(s):null);
      if(sent){
        state.sent[s.key]={atMs:now,symbol:s.symbol,side:s.side,costOk:Boolean(s.execution&&s.execution.costOk),signalId:s.signalId};
        if(s.execution&&s.execution.costOk){
          state.trades[s.key]={...tradeFromSignal(s),telegramMessageId:Number(sent&&sent.result&&sent.result.message_id)||null};
        }else{
          state.trades[s.key]={...tradeFromSignal(s),status:'SKIPPED_COST',actionState:'CLOSED',terminal:true,realizedR:null,skippedReason:'COST',telegramMessageId:Number(sent&&sent.result&&sent.result.message_id)||null};
        }
      }
    }catch(e){ console.error(JSON.stringify({telegram:'ERROR',error:e.message,key:s.key})); }
  }
  state.lastScan={at:now,date,errors,dailyR,killed,candidates:candidates.map(x=>({symbol:x.symbol,provider:x.provider||null,mode:x.mode,side:x.side,decision:x.decision,isReentry:Boolean(x.isReentry),regimePhase:x.regimePhase||null,adx:Number.isFinite(Number(x.adx))?Number(x.adx):null,management:managementPlan(x),qualityScore:x.intelligence?.score??null,qualityLabel:x.intelligence?.label??null,intelligence:x.intelligence,entry:x.entry,entryZone:entryZone(x),atr15:x.atr15,stop:x.stop,tp1:x.tp1,tp2:x.tp2,execution:x.execution||({...executionPlan(x,equityUsdt,snowballRisk(x,equityUsdt,highWaterEquity).riskPct),riskLabel:snowballRisk(x,equityUsdt,highWaterEquity).label}),signalAtMs:x.signalAtMs,entryExpiresAtMs:Number(x.signalAtMs)+ENTRY_VALID_MS,actionState:'ACTIONABLE'})),armed:activeArmedRows(Object.values(state.armed).map(x=>{const p=armedPreview(x),me=state.market&&state.market[x.symbol],status=String(x.status||'');return {symbol:x.symbol,session:x.sessionLabel,side:x.side,status,boxHigh:x.boxHigh,boxLow:x.boxLow,retestLevel:status==='WAITING_RETEST'?p.level:null,reclaimLevel:status==='WAITING_RECLAIM'?(x.side==='LONG'?x.boxLow:x.boxHigh):null,sweepOpenTime:x.sweepOpenTime??null,currentPrice:me&&num(me.lastClose)!==null?Number(me.lastClose):x.currentPrice,atr15:x.atr15,retestLow:status==='WAITING_RETEST'?p.low:null,retestHigh:status==='WAITING_RETEST'?p.high:null,previewStop:status==='WAITING_RETEST'?p.stop:null,previewTp2:status==='WAITING_RETEST'?p.tp2:null,expiresOpenTime:x.expiresOpenTime};}),state.market,now)};
  state.lastScan.v21Candidates=v21Candidates;
  // Prevent indefinite growth of the shadow dedup ledger.
  for(const [k,at] of Object.entries(state.shadowSeen||{})){
    if(now-Number(at)>7*DAY)delete state.shadowSeen[k];
  }
  state.stats=drawdownStats(Object.values(state.trades));
  saveState(state);
  const result={engine:VERSION,at:new Date(now).toISOString(),dailyR,killed,market:state.market,candidates:state.lastScan.candidates,v21Candidates,armed:state.lastScan.armed,stats:state.stats,errors};
  console.log(JSON.stringify(result));
  return result;
}
if(require.main===module){ cycle().catch(e=>{console.error(JSON.stringify({fatal:e.message}));process.exitCode=1;}); }
module.exports={VERSION,ENTRY_VALID_MS,MIN_QUALITY_SCORE,emaSeries,trueRanges,atr,adx14,regime,boxFor,setupWatch,freshBreakout,recentBreakout,qualityGate,retestSignal,rangeSignal,recentRangeSweep,rangeReclaimSignal,rangeSideAllowed,managementPlan,runnerProtectivePrice,ensureTradeLifecycle,lifecycleSnapshot,lifecycleEvents,lifecycleMessage,armedPreview,activeArmedRows,armedMessage,armEndMessage,updateTrade,updateTradePrice,queueAlert,flushAlerts,drawdownStats,yahooCandles,xausChartCandles,snapshotFreshness,chooseFreshestSnapshot,dailyVwap,vwapGate,goldSnapshot,xauMarketClosed,entryZone,barrierRoomAt,chaseGuard,entryDecision,signalIdFor,signalKeyboard,snowballRisk,qtyStep,minNotional,universeQualityOk,universeRank,executionPlan,signalMessage,sgtTime,cycle};
