'use strict';

const fs = require('fs');
const path = require('path');
const { getHistoricalRates } = require('dukascopy-node');

const VERSION = 'HUNTER_ADAPTIVE_V1_2026-10-01';
const M15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const SYMBOLS = ['BTCUSDT','ETHUSDT','XAUUSD'];
const SESSION_IDS = ['LONDON','NEW_YORK'];
const STATE_PATH = process.env.HUNTER_ADAPTIVE_STATE_PATH || '.hunter_state/hunter_adaptive_state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const RUN_ONCE = ['1','true','yes'].includes(String(process.env.HUNTER_RUN_ONCE || 'true').toLowerCase());
const FETCH_TIMEOUT_MS = Number(process.env.HUNTER_FETCH_TIMEOUT_MS || 12000);
const FETCH_RETRIES = Math.max(0, Math.min(3, Number(process.env.HUNTER_FETCH_RETRIES || 2)));

const BINANCE_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com';
const OKX_BASE = process.env.OKX_REST_BASE || 'https://www.okx.com';

const SESSION_DEFS = {
  LONDON: { id:'LONDON', label:'London', tz:'Europe/London', hour:8, minute:0 },
  NEW_YORK_CRYPTO: { id:'NEW_YORK_CRYPTO', label:'New York Crypto', tz:'America/New_York', hour:9, minute:30 },
  NEW_YORK_GOLD: { id:'NEW_YORK_GOLD', label:'New York Gold', tz:'America/New_York', hour:8, minute:30 }
};

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function getJson(url){
  let last;
  for(let i=0;i<=FETCH_RETRIES;i+=1){
    try{
      const res=await fetch(url,{headers:{'user-agent':'hunter-adaptive/1.0'},signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
      if(!res.ok) throw new Error('HTTP '+res.status+' '+url);
      return await res.json();
    }catch(err){
      last=err;
      if(i<FETCH_RETRIES) await sleep(250*(2**i));
    }
  }
  throw last || new Error('FETCH_FAILED');
}

function localParts(ts,timeZone){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date(ts));
  const o={};
  for(const p of parts) if(p.type!=='literal') o[p.type]=p.value;
  return {date:o.year+'-'+o.month+'-'+o.day,hour:Number(o.hour),minute:Number(o.minute)};
}

function sgtParts(ts=Date.now()){
  return localParts(ts,'Asia/Singapore');
}

function sgtTime(ts){
  return new Intl.DateTimeFormat('en-SG',{
    timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hour12:false
  }).format(new Date(ts));
}

function sessionFor(symbol,id){
  if(id==='LONDON') return SESSION_DEFS.LONDON;
  if(id==='NEW_YORK') return symbol==='XAUUSD' ? SESSION_DEFS.NEW_YORK_GOLD : SESSION_DEFS.NEW_YORK_CRYPTO;
  return null;
}

function ema(values,period){
  if(!Array.isArray(values)||values.length<period) return null;
  const a=2/(period+1);
  let e=Number(values[0]);
  for(let i=1;i<values.length;i+=1) e=a*Number(values[i])+(1-a)*e;
  return e;
}

function atr(candles,period=14){
  const xs=[...(candles||[])].sort((a,b)=>a.openTime-b.openTime);
  if(xs.length<period+1) return null;
  const trs=[];
  for(let i=1;i<xs.length;i+=1){
    const h=Number(xs[i].high),l=Number(xs[i].low),pc=Number(xs[i-1].close);
    if(![h,l,pc].every(Number.isFinite)) continue;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  const tail=trs.slice(-period);
  return tail.length===period ? tail.reduce((a,b)=>a+b,0)/period : null;
}

function adx(candles,period=14){
  const xs=[...(candles||[])].sort((a,b)=>a.openTime-b.openTime);
  if(xs.length<period*2+2) return null;
  const tr=[],plus=[],minus=[];
  for(let i=1;i<xs.length;i+=1){
    const cur=xs[i],prev=xs[i-1];
    const h=Number(cur.high),l=Number(cur.low),ph=Number(prev.high),pl=Number(prev.low),pc=Number(prev.close);
    if(![h,l,ph,pl,pc].every(Number.isFinite)) continue;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,down=pl-l;
    plus.push(up>down&&up>0?up:0);
    minus.push(down>up&&down>0?down:0);
  }
  if(tr.length<period*2) return null;
  const dx=[];
  for(let end=period;end<=tr.length;end+=1){
    const trSum=tr.slice(end-period,end).reduce((a,b)=>a+b,0);
    if(!(trSum>0)) continue;
    const p=100*plus.slice(end-period,end).reduce((a,b)=>a+b,0)/trSum;
    const m=100*minus.slice(end-period,end).reduce((a,b)=>a+b,0)/trSum;
    if(p+m===0) dx.push(0);
    else dx.push(100*Math.abs(p-m)/(p+m));
  }
  const tail=dx.slice(-period);
  return tail.length===period ? tail.reduce((a,b)=>a+b,0)/period : null;
}

function classifyRegime(candles4h,candles15m){
  const h4=[...(candles4h||[])].sort((a,b)=>a.openTime-b.openTime);
  const closes=h4.map(x=>Number(x.close)).filter(Number.isFinite);
  if(closes.length<55) return {type:'CHAOS',reason:'H4样本不足'};
  const e20=ema(closes.slice(-70),20);
  const e50=ema(closes.slice(-90),50);
  const a14=atr(h4.slice(-50),14);
  const d14=adx(h4.slice(-60),14);
  const close=closes.at(-1);
  const a15=atr((candles15m||[]).slice(-40),14);
  const last15=(candles15m||[]).at(-1);
  const shock=a15&&last15 ? (Number(last15.high)-Number(last15.low))/a15 : null;

  if([e20,e50,a14,d14,close].some(x=>!Number.isFinite(x)) || !(a14>0)){
    return {type:'CHAOS',reason:'指标不足',ema20:e20,ema50:e50,adx:d14,atr4h:a14,atr15:a15};
  }
  if(Number.isFinite(shock) && shock>=2.8){
    return {type:'CHAOS',reason:'M15波动异常',ema20:e20,ema50:e50,adx:d14,atr4h:a14,atr15:a15,shock};
  }
  if(close>e20 && e20>e50 && d14>=20){
    return {type:'TREND_UP',label:'趋势上涨',direction:'LONG',ema20:e20,ema50:e50,adx:d14,atr4h:a14,atr15:a15,shock};
  }
  if(close<e20 && e20<e50 && d14>=20){
    return {type:'TREND_DOWN',label:'趋势下跌',direction:'SHORT',ema20:e20,ema50:e50,adx:d14,atr4h:a14,atr15:a15,shock};
  }
  const spread=Math.abs(e20-e50)/a14;
  if(d14<=18 && spread<=0.75){
    return {type:'RANGE',label:'区间',direction:null,ema20:e20,ema50:e50,adx:d14,atr4h:a14,atr15:a15,shock,spread};
  }
  return {type:'CHAOS',label:'混乱/过渡',direction:null,ema20:e20,ema50:e50,adx:d14,atr4h:a14,atr15:a15,shock,spread};
}

function sessionBox(candles15m,latestOpenTime,session){
  const lp=localParts(latestOpenTime,session.tz);
  let h2=session.hour,m2=session.minute+15;
  if(m2>=60){m2-=60;h2+=1;}
  let first=null,second=null;
  for(const c of candles15m||[]){
    const p=localParts(Number(c.openTime),session.tz);
    if(p.date!==lp.date) continue;
    if(p.hour===session.hour&&p.minute===session.minute) first=c;
    if(p.hour===h2&&p.minute===m2) second=c;
  }
  if(!first||!second) return null;
  return {
    date:lp.date,
    high:Math.max(Number(first.high),Number(second.high)),
    low:Math.min(Number(first.low),Number(second.low)),
    activeFrom:Number(second.openTime)+M15,
    activeUntil:Number(second.openTime)+6*HOUR
  };
}

function rejectionScore(c,side){
  const h=Number(c.high),l=Number(c.low),cl=Number(c.close);
  const r=h-l;
  if(!(r>0)) return 0;
  return side==='LONG' ? (cl-l)/r : (h-cl)/r;
}

function nextLiquidity(candles,beforeTime,side,entry){
  const xs=(candles||[]).filter(x=>Number(x.openTime)<beforeTime).slice(-48);
  const levels=[];
  for(let i=1;i<xs.length-1;i+=1){
    if(side==='LONG'){
      const h=Number(xs[i].high);
      if(h>Number(xs[i-1].high)&&h>=Number(xs[i+1].high)&&h>entry) levels.push(h);
    }else{
      const l=Number(xs[i].low);
      if(l<Number(xs[i-1].low)&&l<=Number(xs[i+1].low)&&l<entry) levels.push(l);
    }
  }
  if(!levels.length) return null;
  return side==='LONG' ? Math.min(...levels) : Math.max(...levels);
}

function gradeSetup({kind,regime,riskAtr,rejection,roomR}){
  if(kind==='TREND'){
    if(Number(regime.adx)>=25 && riskAtr>=0.5 && riskAtr<=1.25 && rejection>=0.70 && (!Number.isFinite(roomR)||roomR>=2)) return 'A+';
    return 'A';
  }
  if(kind==='RANGE' && rejection>=0.70 && roomR>=2) return 'A+';
  return 'A';
}

function riskPctForGrade(grade){
  return grade==='A+' ? 0.005 : 0.0025;
}

function dailyRealizedR(state,now=Date.now()){
  const date=sgtParts(now).date;
  let total=0;
  for(const t of Object.values(state.trades||{})){
    if(!Number.isFinite(Number(t.signalAtMs))||sgtParts(Number(t.signalAtMs)).date!==date) continue;
    if(Number.isFinite(Number(t.finalR))) total+=Number(t.finalR);
  }
  return total;
}

function correlationBlock(state,signal){
  if(!['BTCUSDT','ETHUSDT'].includes(signal.symbol)) return null;
  for(const t of Object.values(state.trades||{})){
    if(t.terminal) continue;
    if(!['BTCUSDT','ETHUSDT'].includes(t.symbol)) continue;
    if(t.symbol!==signal.symbol && t.side===signal.side){
      return '已有 '+t.symbol+' '+(t.side==='LONG'?'做多':'做空')+'，避免重复押同一个 Crypto 方向';
    }
  }
  return null;
}

function trendBreakout(snapshot,session,regime,now){
  if(!['TREND_UP','TREND_DOWN'].includes(regime.type)) return null;
  const xs=[...(snapshot.candles15m||[])].sort((a,b)=>a.openTime-b.openTime);
  const cur=xs.at(-1),prev=xs.at(-2);
  if(!cur||!prev) return null;
  const box=sessionBox(xs,cur.openTime,session);
  if(!box||cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) return null;
  const side=regime.type==='TREND_UP'?'LONG':'SHORT';
  const fresh=side==='LONG'
    ? Number(prev.close)<=box.high && Number(cur.close)>box.high
    : Number(prev.close)>=box.low && Number(cur.close)<box.low;
  if(!fresh) return null;
  const a15=regime.atr15 || atr(xs.slice(-40),14);
  if(!(a15>0)) return null;
  const level=side==='LONG'?box.high:box.low;
  const extension=Math.abs(Number(cur.close)-level)/a15;
  if(extension>1.25) return {blocked:true,reason:'突破 candle 已经冲太远',side,box,level,extension};
  return {
    key:'PENDING|'+snapshot.symbol+'|'+session.id+'|'+box.date+'|'+side,
    symbol:snapshot.symbol,session:session.id,sessionLabel:session.label,date:box.date,
    side,kind:'TREND',breakoutOpenTime:Number(cur.openTime),breakoutCloseTime:Number(cur.openTime)+M15,
    breakoutLevel:level,boxHigh:box.high,boxLow:box.low,atr15:a15,adx:regime.adx,
    expiresAt:Number(cur.openTime)+5*M15,provider:snapshot.provider
  };
}

function confirmRetest(snapshot,pending,regime,now){
  const xs=[...(snapshot.candles15m||[])].sort((a,b)=>a.openTime-b.openTime);
  const cur=xs.at(-1);
  if(!cur || Number(cur.openTime)<=Number(pending.breakoutOpenTime)) return null;
  if(Number(cur.openTime)>Number(pending.breakoutOpenTime)+4*M15) return {expired:true};
  const a15=Number(pending.atr15);
  const level=Number(pending.breakoutLevel);
  const side=pending.side;
  const low=Number(cur.low),high=Number(cur.high),close=Number(cur.close),open=Number(cur.open);
  const touched=side==='LONG'
    ? low<=level+0.25*a15 && low>=level-0.60*a15
    : high>=level-0.25*a15 && high<=level+0.60*a15;
  const reclaimed=side==='LONG' ? close>level && close>open : close<level && close<open;
  if(!touched||!reclaimed) return null;

  const seq=xs.filter(x=>Number(x.openTime)>=Number(pending.breakoutOpenTime)&&Number(x.openTime)<=Number(cur.openTime));
  const structure=side==='LONG' ? Math.min(...seq.map(x=>Number(x.low))) : Math.max(...seq.map(x=>Number(x.high)));
  const stop=side==='LONG' ? structure-0.15*a15 : structure+0.15*a15;
  const entry=close;
  const risk=Math.abs(entry-stop);
  const riskAtr=risk/a15;
  if(riskAtr<0.35) return {blocked:true,reason:'SL 太近，容易被正常波动扫掉'};
  if(riskAtr>1.80) return {blocked:true,reason:'SL 太远，不值得做'};

  const liq=nextLiquidity(xs,Number(pending.breakoutOpenTime),side,entry);
  const roomR=Number.isFinite(liq) ? Math.abs(liq-entry)/risk : null;
  if(Number.isFinite(roomR)&&roomR<1.5) return {blocked:true,reason:'前方结构太近，Reward 不够'};

  const rejection=rejectionScore(cur,side);
  if(rejection<0.55) return {blocked:true,reason:'回踩 candle 收得不够强'};
  const grade=gradeSetup({kind:'TREND',regime,riskAtr,rejection,roomR});
  const tp1=side==='LONG'?entry+risk:entry-risk;
  const tp2=side==='LONG'?entry+2*risk:entry-2*risk;
  return {
    key:'TREND|'+pending.symbol+'|'+pending.session+'|'+pending.date+'|'+pending.breakoutOpenTime+'|'+cur.openTime,
    version:VERSION,symbol:pending.symbol,provider:pending.provider,session:pending.session,sessionLabel:pending.sessionLabel,
    kind:'TREND',regime:regime.type,side,grade,signalAtMs:Number(cur.openTime)+M15,candleOpenTime:Number(cur.openTime),
    entry,stop,riskDistance:risk,riskAtr,tp1,tp2,runnerPct:0.30,rejection,roomR,nextLiquidity:liq,
    riskPct:riskPctForGrade(grade),
    plan:'40% @ 1R · 30% @ 2R · 30% Runner',
    thesis:'Breakout 后第一次有效回踩确认'
  };
}

function rangeSweep(snapshot,session,regime,now){
  if(regime.type!=='RANGE') return null;
  const xs=[...(snapshot.candles15m||[])].sort((a,b)=>a.openTime-b.openTime);
  const cur=xs.at(-1);
  if(!cur) return null;
  const box=sessionBox(xs,cur.openTime,session);
  if(!box||cur.openTime<box.activeFrom||cur.openTime>=box.activeUntil) return null;
  const a15=regime.atr15||atr(xs.slice(-40),14);
  if(!(a15>0)) return null;
  const o=Number(cur.open),h=Number(cur.high),l=Number(cur.low),cl=Number(cur.close);
  let side=null;
  if(l<box.low-0.10*a15 && cl>box.low && cl>o) side='LONG';
  if(h>box.high+0.10*a15 && cl<box.high && cl<o) side='SHORT';
  if(!side) return null;

  const stop=side==='LONG'?l-0.15*a15:h+0.15*a15;
  const entry=cl;
  const risk=Math.abs(entry-stop);
  const riskAtr=risk/a15;
  if(riskAtr<0.30||riskAtr>1.50) return {blocked:true,reason:riskAtr<0.30?'SL 太近':'SL 太远',side,box};
  const finalTarget=side==='LONG'?box.high:box.low;
  const targetR=Math.abs(finalTarget-entry)/risk;
  if(targetR<1.20) return {blocked:true,reason:'回到区间另一边的空间不足',side,box};
  const rejection=rejectionScore(cur,side);
  if(rejection<0.55) return {blocked:true,reason:'Reclaim 不够强',side,box};
  const grade=gradeSetup({kind:'RANGE',regime,riskAtr,rejection,roomR:targetR});
  const tp1=side==='LONG'?entry+risk:entry-risk;
  return {
    key:'RANGE|'+snapshot.symbol+'|'+session.id+'|'+box.date+'|'+side+'|'+cur.openTime,
    version:VERSION,symbol:snapshot.symbol,provider:snapshot.provider,session:session.id,sessionLabel:session.label,
    kind:'RANGE',regime:'RANGE',side,grade,signalAtMs:Number(cur.openTime)+M15,candleOpenTime:Number(cur.openTime),
    entry,stop,riskDistance:risk,riskAtr,tp1,finalTarget,targetR,rejection,
    riskPct:riskPctForGrade(grade),
    plan:'50% @ 1R · 50% @ 区间另一边',
    thesis:'Liquidity sweep + reclaim'
  };
}

function tradeFromSignal(s){
  return {
    ...s,
    status:'OPEN',terminal:false,finalR:null,lastTrackedOpenTime:Number(s.candleOpenTime),
    tp1Hit:false,tp2Hit:false,runnerActive:false,runnerStop:null,realizedBaseR:0,
    ambiguous:false
  };
}

function updateTrendTrade(t,candles){
  const xs=[...(candles||[])].sort((a,b)=>a.openTime-b.openTime);
  for(let i=0;i<xs.length;i+=1){
    const c=xs[i],ot=Number(c.openTime);
    if(ot<=Number(t.lastTrackedOpenTime||0)||ot<=Number(t.candleOpenTime)) continue;
    const h=Number(c.high),l=Number(c.low);
    const hit=(price)=>t.side==='LONG'?h>=price:l<=price;
    const hitDown=(price)=>t.side==='LONG'?l<=price:h>=price;

    if(t.runnerActive){
      const prev=xs.filter(x=>Number(x.openTime)<ot&&Number(x.openTime)>=Number(t.candleOpenTime)).slice(-2);
      if(prev.length===2){
        const candidate=t.side==='LONG'
          ? Math.min(...prev.map(x=>Number(x.low)))
          : Math.max(...prev.map(x=>Number(x.high)));
        t.runnerStop=t.side==='LONG'
          ? Math.max(Number(t.runnerStop),candidate)
          : Math.min(Number(t.runnerStop),candidate);
      }
      if(hitDown(Number(t.runnerStop))){
        const runnerR=t.side==='LONG'
          ? (Number(t.runnerStop)-t.entry)/t.riskDistance
          : (t.entry-Number(t.runnerStop))/t.riskDistance;
        t.finalR=1.0+0.30*runnerR;
        t.status='RUNNER_EXIT';t.terminal=true;t.lastTrackedOpenTime=ot;
        return true;
      }
      t.lastTrackedOpenTime=ot;
      continue;
    }

    if(!t.tp1Hit){
      const sl=hitDown(t.stop),p1=hit(t.tp1),p2=hit(t.tp2);
      if(sl&&(p1||p2)){
        t.status='AMBIGUOUS';t.ambiguous=true;t.terminal=true;t.lastTrackedOpenTime=ot;return true;
      }
      if(sl){
        t.status='SL';t.finalR=-1;t.terminal=true;t.lastTrackedOpenTime=ot;return true;
      }
      if(p2){
        if(hitDown(t.entry)){t.status='AMBIGUOUS';t.ambiguous=true;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
        t.tp1Hit=true;t.tp2Hit=true;t.realizedBaseR=1.0;t.runnerActive=true;t.runnerStop=t.entry;t.status='RUNNER';
        t.lastTrackedOpenTime=ot;continue;
      }
      if(p1){
        if(hitDown(t.entry)){t.status='AMBIGUOUS';t.ambiguous=true;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
        t.tp1Hit=true;t.realizedBaseR=0.4;t.status='TP1';t.lastTrackedOpenTime=ot;continue;
      }
    }else if(!t.tp2Hit){
      const be=hitDown(t.entry),p2=hit(t.tp2);
      if(be&&p2){t.status='AMBIGUOUS';t.ambiguous=true;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(be){t.status='BE_AFTER_TP1';t.finalR=0.4;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(p2){t.tp2Hit=true;t.realizedBaseR=1.0;t.runnerActive=true;t.runnerStop=t.entry;t.status='RUNNER';t.lastTrackedOpenTime=ot;continue;}
    }
    t.lastTrackedOpenTime=ot;
  }
  return false;
}

function updateRangeTrade(t,candles){
  const xs=[...(candles||[])].sort((a,b)=>a.openTime-b.openTime);
  for(const c of xs){
    const ot=Number(c.openTime);
    if(ot<=Number(t.lastTrackedOpenTime||0)||ot<=Number(t.candleOpenTime)) continue;
    const h=Number(c.high),l=Number(c.low);
    const favorable=(price)=>t.side==='LONG'?h>=price:l<=price;
    const adverse=(price)=>t.side==='LONG'?l<=price:h>=price;

    if(!t.tp1Hit){
      const sl=adverse(t.stop),p1=favorable(t.tp1),fin=favorable(t.finalTarget);
      if(sl&&(p1||fin)){t.status='AMBIGUOUS';t.ambiguous=true;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(sl){t.status='SL';t.finalR=-1;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(fin){t.tp1Hit=true;t.status='TARGET';t.finalR=0.5+0.5*t.targetR;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(p1){t.tp1Hit=true;t.status='TP1';t.realizedBaseR=0.5;t.lastTrackedOpenTime=ot;continue;}
    }else{
      const be=adverse(t.entry),fin=favorable(t.finalTarget);
      if(be&&fin){t.status='AMBIGUOUS';t.ambiguous=true;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(fin){t.status='TARGET';t.finalR=0.5+0.5*t.targetR;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
      if(be){t.status='BE_AFTER_TP1';t.finalR=0.5;t.terminal=true;t.lastTrackedOpenTime=ot;return true;}
    }
    t.lastTrackedOpenTime=ot;
  }
  return false;
}

function updateTrades(state,snapshots){
  const by=Object.fromEntries((snapshots||[]).map(s=>[s.symbol,s]));
  let changed=false;
  for(const t of Object.values(state.trades||{})){
    if(t.terminal) continue;
    const snap=by[t.symbol];
    if(!snap) continue;
    const before=JSON.stringify([t.status,t.terminal,t.finalR,t.lastTrackedOpenTime,t.runnerStop]);
    if(t.kind==='TREND') updateTrendTrade(t,snap.candles15m||[]);
    else updateRangeTrade(t,snap.candles15m||[]);
    const after=JSON.stringify([t.status,t.terminal,t.finalR,t.lastTrackedOpenTime,t.runnerStop]);
    if(before!==after) changed=true;
  }
  return changed;
}

function normalizeState(x){
  const s=x&&typeof x==='object'?x:{};
  if(!s.pending||typeof s.pending!=='object') s.pending={};
  if(!s.trades||typeof s.trades!=='object') s.trades={};
  if(!s.seen||typeof s.seen!=='object') s.seen={};
  if(!s.ops||typeof s.ops!=='object') s.ops={};
  if(!s.blocked||!Array.isArray(s.blocked)) s.blocked=[];
  s.version=VERSION;
  return s;
}

function loadState(){
  try{return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH,'utf8')));}
  catch{return normalizeState({});}
}

function saveState(state){
  const s=normalizeState(state);
  fs.mkdirSync(path.dirname(STATE_PATH),{recursive:true});
  const cutoff=Date.now()-180*DAY;
  for(const [k,t] of Object.entries(s.trades)) if(Number(t.signalAtMs||0)<cutoff) delete s.trades[k];
  for(const [k,p] of Object.entries(s.pending)) if(Number(p.expiresAt||0)<Date.now()-DAY) delete s.pending[k];
  s.blocked=s.blocked.filter(x=>Number(x.atMs||0)>=Date.now()-14*DAY).slice(-500);
  const tmp=STATE_PATH+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(s,null,2));
  fs.renameSync(tmp,STATE_PATH);
}

async function telegram(text){
  if(!BOT_TOKEN||!CHAT_ID) return false;
  const res=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:CHAT_ID,text,disable_web_page_preview:true})
  });
  if(!res.ok) throw new Error('Telegram '+res.status);
  return true;
}

function fmt(x,symbol){
  const n=Number(x);
  if(!Number.isFinite(n)) return 'n/a';
  if(symbol==='XAUUSD') return n.toFixed(2);
  if(n>=1000) return n.toFixed(2);
  if(n>=10) return n.toFixed(3);
  return n.toFixed(4);
}

function signalMessage(s){
  const dir=s.side==='LONG'?'做多':'做空';
  const lines=[
    (s.side==='LONG'?'🟢':'🔴')+' HUNTER '+s.grade+' 信号',
    '',
    s.symbol+' — '+dir,
    '模式：'+(s.kind==='TREND'?'趋势 · Breakout + Retest':'区间 · Sweep + Reclaim'),
    'Session：'+s.sessionLabel,
    '',
    '进场：约 '+fmt(s.entry,s.symbol),
    '止损：'+fmt(s.stop,s.symbol),
    '风险距离：'+s.riskAtr.toFixed(2)+'× M15 ATR',
    '建议风险：'+(s.riskPct*100).toFixed(2)+'% equity',
    '',
    s.kind==='TREND'
      ? 'TP1：'+fmt(s.tp1,s.symbol)+'（40%）\nTP2：'+fmt(s.tp2,s.symbol)+'（30%）\nRunner：30% 跟趋势'
      : 'TP1：'+fmt(s.tp1,s.symbol)+'（50%）\n最终目标：'+fmt(s.finalTarget,s.symbol)+'（50%）',
    '',
    '逻辑：'+s.thesis,
    '确认：'+sgtTime(s.signalAtMs)+' SGT',
    '模式：只发信号，不自动下单'
  ];
  return lines.join('\n');
}

function pendingMessage(p){
  return [
    '👀 等回踩，不追价',
    '',
    p.symbol+' — '+(p.side==='LONG'?'做多方向':'做空方向'),
    'Session：'+p.sessionLabel,
    'Breakout 已确认',
    '关键位：'+fmt(p.breakoutLevel,p.symbol),
    '',
    '接下来只等第一次有效 Retest。',
    '没有漂亮回踩 = 不做。'
  ].join('\n');
}

function recordBlocked(state,row){
  state.blocked.push({at:new Date().toISOString(),atMs:Date.now(),...row});
}

function completedStats(state){
  const xs=Object.values(state.trades||{}).filter(t=>Number.isFinite(Number(t.finalR)));
  const totalR=xs.reduce((a,t)=>a+Number(t.finalR),0);
  return {
    completed:xs.length,totalR,avgR:xs.length?totalR/xs.length:null,
    wins:xs.filter(t=>Number(t.finalR)>0).length,
    losses:xs.filter(t=>Number(t.finalR)<0).length
  };
}

async function binanceSnapshot(symbol,now=Date.now()){
  const map=(rows,intervalMs)=>rows.map(r=>({
    openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),
    closeTime:Number(r[6])
  })).filter(x=>x.closeTime<=now);
  const q15=new URLSearchParams({symbol,interval:'15m',limit:'300'});
  const q4=new URLSearchParams({symbol,interval:'4h',limit:'120'});
  const [a,b]=await Promise.all([
    getJson(BINANCE_BASE+'/fapi/v1/klines?'+q15),
    getJson(BINANCE_BASE+'/fapi/v1/klines?'+q4)
  ]);
  return {symbol,provider:'BINANCE',candles15m:map(a,M15),candles4h:map(b,4*HOUR)};
}

function okxInst(symbol){return symbol.replace('USDT','')+'-USDT-SWAP';}
async function okxSnapshot(symbol,now=Date.now()){
  async function fetchBar(bar,intervalMs,limit){
    const q=new URLSearchParams({instId:okxInst(symbol),bar,limit:String(limit)});
    const body=await getJson(OKX_BASE+'/api/v5/market/candles?'+q);
    if(body.code!=='0') throw new Error('OKX '+body.code);
    return (body.data||[]).filter(r=>String(r[8]??'1')==='1').map(r=>({
      openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),
      closeTime:Number(r[0])+intervalMs-1
    })).filter(x=>x.closeTime<=now).sort((a,b)=>a.openTime-b.openTime);
  }
  const [m,h]=await Promise.all([fetchBar('15m',M15,300),fetchBar('4H',4*HOUR,120)]);
  return {symbol,provider:'OKX',candles15m:m,candles4h:h};
}

async function cryptoSnapshot(symbol,now=Date.now()){
  try{return await binanceSnapshot(symbol,now);}
  catch{return await okxSnapshot(symbol,now);}
}

async function duka(symbol,timeframe,days,now=Date.now()){
  const ms=timeframe==='h1'?HOUR:M15;
  const rows=await getHistoricalRates({
    instrument:symbol.toLowerCase(),
    dates:{from:new Date(now-days*DAY),to:new Date(now+HOUR)},
    timeframe,format:'json',priceType:'bid',ignoreFlats:true
  });
  return (rows||[]).map(x=>({
    openTime:Number(x.timestamp),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0),
    closeTime:Number(x.timestamp)+ms-1
  })).filter(x=>[x.openTime,x.open,x.high,x.low,x.close].every(Number.isFinite)&&x.openTime+ms<=now)
    .sort((a,b)=>a.openTime-b.openTime);
}

function aggregateH4(h1){
  const g=new Map();
  for(const x of h1||[]){
    const t=Math.floor(Number(x.openTime)/(4*HOUR))*(4*HOUR);
    if(!g.has(t)) g.set(t,{openTime:t,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume||0,closeTime:t+4*HOUR-1});
    else{
      const y=g.get(t);y.high=Math.max(y.high,x.high);y.low=Math.min(y.low,x.low);y.close=x.close;y.volume+=x.volume||0;
    }
  }
  return [...g.values()].sort((a,b)=>a.openTime-b.openTime);
}

async function goldSnapshot(now=Date.now()){
  const [m15,h1]=await Promise.all([duka('XAUUSD','m15',7,now),duka('XAUUSD','h1',20,now)]);
  return {symbol:'XAUUSD',provider:'DUKASCOPY',candles15m:m15,candles4h:aggregateH4(h1)};
}

async function getSnapshots(now=Date.now()){
  const res=await Promise.allSettled([cryptoSnapshot('BTCUSDT',now),cryptoSnapshot('ETHUSDT',now),goldSnapshot(now)]);
  const snaps=[],errors=[];
  for(let i=0;i<res.length;i+=1){
    if(res[i].status==='fulfilled') snaps.push(res[i].value);
    else errors.push({symbol:SYMBOLS[i],error:String(res[i].reason?.message||res[i].reason)});
  }
  return {snaps,errors};
}

function marketRow(snapshot,regime,session,pending){
  return {
    symbol:snapshot.symbol,provider:snapshot.provider,regime:regime.type,regimeLabel:regime.label||regime.type,
    adx:Number.isFinite(regime.adx)?regime.adx:null,session:session?.label||null,
    pending:pending?{side:pending.side,level:pending.breakoutLevel,expiresAt:pending.expiresAt}:null
  };
}

async function cycle(now=Date.now()){
  const state=loadState();
  const {snaps,errors}=await getSnapshots(now);
  updateTrades(state,snaps);

  const dayR=dailyRealizedR(state,now);
  const killSwitch=dayR<=-2;
  const newSignals=[];
  const newPending=[];
  const market=[];
  const blocked=[];

  for(const snap of snaps){
    const regime=classifyRegime(snap.candles4h,snap.candles15m);
    for(const id of SESSION_IDS){
      const session=sessionFor(snap.symbol,id);
      if(!session) continue;

      const pendingRows=Object.values(state.pending).filter(p=>p.symbol===snap.symbol&&p.session===session.id);
      let pendingForRow=pendingRows.at(-1)||null;

      for(const p of pendingRows){
        const out=confirmRetest(snap,p,regime,now);
        if(out?.expired){
          delete state.pending[p.key];
          state.seen[p.key]='EXPIRED';
          pendingForRow=null;
          continue;
        }
        if(out?.blocked){
          recordBlocked(state,{symbol:p.symbol,session:p.session,kind:'TREND',reason:out.reason});
          blocked.push({symbol:p.symbol,session:p.sessionLabel,reason:out.reason});
          delete state.pending[p.key];
          state.seen[p.key]='BLOCKED';
          pendingForRow=null;
          continue;
        }
        if(out?.key){
          if(killSwitch){
            blocked.push({symbol:out.symbol,session:out.sessionLabel,reason:'今天已到 -2R Kill Switch'});
            recordBlocked(state,{symbol:out.symbol,session:out.session,kind:out.kind,reason:'DAILY_KILL_SWITCH'});
          }else{
            const corr=correlationBlock(state,out);
            if(corr){
              blocked.push({symbol:out.symbol,session:out.sessionLabel,reason:corr});
              recordBlocked(state,{symbol:out.symbol,session:out.session,kind:out.kind,reason:corr});
            }else if(!state.trades[out.key]){
              state.trades[out.key]=tradeFromSignal(out);
              newSignals.push(out);
            }
          }
          delete state.pending[p.key];
          state.seen[p.key]='RESOLVED';
          pendingForRow=null;
        }
      }

      const breakout=trendBreakout(snap,session,regime,now);
      if(breakout?.blocked){
        blocked.push({symbol:snap.symbol,session:session.label,reason:breakout.reason});
      }else if(breakout?.key && !state.pending[breakout.key] && !state.seen[breakout.key]){
        state.pending[breakout.key]=breakout;
        newPending.push(breakout);
        pendingForRow=breakout;
      }

      const sweep=rangeSweep(snap,session,regime,now);
      if(sweep?.blocked){
        blocked.push({symbol:snap.symbol,session:session.label,reason:sweep.reason});
      }else if(sweep?.key && !state.trades[sweep.key] && !state.seen[sweep.key]){
        if(killSwitch){
          blocked.push({symbol:sweep.symbol,session:sweep.sessionLabel,reason:'今天已到 -2R Kill Switch'});
          recordBlocked(state,{symbol:sweep.symbol,session:sweep.session,kind:sweep.kind,reason:'DAILY_KILL_SWITCH'});
        }else{
          const corr=correlationBlock(state,sweep);
          if(corr){
            blocked.push({symbol:sweep.symbol,session:sweep.sessionLabel,reason:corr});
            recordBlocked(state,{symbol:sweep.symbol,session:sweep.session,kind:sweep.kind,reason:corr});
          }else{
            state.trades[sweep.key]=tradeFromSignal(sweep);
            newSignals.push(sweep);
          }
        }
        state.seen[sweep.key]='SEEN';
      }

      market.push(marketRow(snap,regime,session,pendingForRow));
    }
  }

  state.lastScan={
    atMs:now,at:new Date(now).toISOString(),version:VERSION,dayR,killSwitch,
    errors,market,newSignals:newSignals.map(x=>({key:x.key,symbol:x.symbol,side:x.side,kind:x.kind,grade:x.grade,entry:x.entry,stop:x.stop,signalAtMs:x.signalAtMs})),
    pending:newPending.map(x=>({key:x.key,symbol:x.symbol,side:x.side,session:x.sessionLabel,level:x.breakoutLevel})),
    blocked:blocked.slice(-20),
    stats:completedStats(state)
  };

  saveState(state);

  for(const p of newPending){
    try{await telegram(pendingMessage(p));}catch(e){console.error(JSON.stringify({telegram:'PENDING_ERROR',error:e.message}));}
  }
  for(const s of newSignals){
    try{await telegram(signalMessage(s));}catch(e){console.error(JSON.stringify({telegram:'SIGNAL_ERROR',error:e.message}));}
  }

  console.log(JSON.stringify({
    engine:'Hunter Adaptive V1',version:VERSION,mode:'SIGNAL_ONLY',
    at:new Date(now).toISOString(),dayR,killSwitch,
    providers:Object.fromEntries(snaps.map(s=>[s.symbol,s.provider])),
    regimes:market.map(x=>({symbol:x.symbol,session:x.session,regime:x.regime})),
    pending:newPending.map(x=>x.key),signals:newSignals.map(x=>x.key),blocked,errors,
    stats:completedStats(state)
  },null,2));

  return state.lastScan;
}

async function main(){
  try{await cycle(Date.now());}
  catch(err){
    console.error(JSON.stringify({engine:'Hunter Adaptive V1',fatal:err.message}));
    process.exitCode=1;
  }
}

if(require.main===module) main();

module.exports={
  VERSION,SESSION_DEFS,localParts,ema,atr,adx,classifyRegime,sessionBox,rejectionScore,nextLiquidity,
  gradeSetup,riskPctForGrade,dailyRealizedR,correlationBlock,trendBreakout,confirmRetest,rangeSweep,
  tradeFromSignal,updateTrendTrade,updateRangeTrade,updateTrades,completedStats,cycle
};
