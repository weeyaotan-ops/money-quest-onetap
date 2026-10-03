'use strict';

function finite(x){ return Number.isFinite(Number(x)); }
function n(x){ return Number(x); }
function clamp(x,min,max){ return Math.max(min,Math.min(max,x)); }
function round(x,d=2){ if(!finite(x)) return null; const p=10**d; return Math.round(Number(x)*p)/p; }

function confirmedSwings(candles,left=2,right=2,lookback=180){
  const xs=(candles||[]).slice(-Math.max(lookback,left+right+5));
  const highs=[]; const lows=[];
  for(let i=left;i<xs.length-right;i+=1){
    const c=xs[i];
    if(!c||![c.high,c.low].every(finite)) continue;
    let isHigh=true,isLow=true;
    for(let j=i-left;j<=i+right;j+=1){
      if(j===i) continue;
      if(n(xs[j]?.high)>=n(c.high)) isHigh=false;
      if(n(xs[j]?.low)<=n(c.low)) isLow=false;
      if(!isHigh&&!isLow) break;
    }
    if(isHigh) highs.push({price:n(c.high),openTime:n(c.openTime),index:i});
    if(isLow) lows.push({price:n(c.low),openTime:n(c.openTime),index:i});
  }
  return {highs,lows};
}

function structureBias(candles){
  const {highs,lows}=confirmedSwings(candles,2,2,220);
  const h=highs.slice(-2),l=lows.slice(-2);
  if(h.length>=2&&l.length>=2){
    if(h[1].price>h[0].price&&l[1].price>l[0].price) return {bias:'BULLISH',highs:h,lows:l};
    if(h[1].price<h[0].price&&l[1].price<l[0].price) return {bias:'BEARISH',highs:h,lows:l};
  }
  return {bias:'NEUTRAL',highs:h,lows:l};
}

function nearestLiquidity(candles,price){
  const p=n(price); const {highs,lows}=confirmedSwings(candles,2,2,180);
  const above=highs.filter(x=>x.price>p).sort((a,b)=>a.price-b.price);
  const below=lows.filter(x=>x.price<p).sort((a,b)=>b.price-a.price);
  const recent=(candles||[]).slice(-48);
  const fallbackHigh=recent.length?Math.max(...recent.map(x=>n(x.high)).filter(Number.isFinite)):null;
  const fallbackLow=recent.length?Math.min(...recent.map(x=>n(x.low)).filter(Number.isFinite)):null;
  return {
    bsl:above[0]?.price ?? (finite(fallbackHigh)&&fallbackHigh>p?fallbackHigh:null),
    ssl:below[0]?.price ?? (finite(fallbackLow)&&fallbackLow<p?fallbackLow:null),
    bslTime:above[0]?.openTime ?? null,
    sslTime:below[0]?.openTime ?? null
  };
}

function localAtr(candles,period=14){
  const xs=(candles||[]).slice(-(period+1)); if(xs.length<period+1) return null;
  const tr=[];
  for(let i=1;i<xs.length;i+=1){
    const c=xs[i],p=xs[i-1];
    tr.push(Math.max(n(c.high)-n(c.low),Math.abs(n(c.high)-n(p.close)),Math.abs(n(c.low)-n(p.close))));
  }
  return tr.length?tr.reduce((a,b)=>a+b,0)/tr.length:null;
}

function latestOrderBlocks(candles,a15=null){
  const xs=(candles||[]).slice(-140);
  const atr=finite(a15)&&n(a15)>0?n(a15):localAtr(xs,14);
  if(!(atr>0)||xs.length<12) return {demand:null,supply:null};
  let demand=null,supply=null;
  for(let i=6;i<xs.length;i+=1){
    const c=xs[i]; const prior=xs.slice(i-6,i);
    const priorHigh=Math.max(...prior.map(x=>n(x.high)));
    const priorLow=Math.min(...prior.map(x=>n(x.low)));
    const body=Math.abs(n(c.close)-n(c.open));
    const range=n(c.high)-n(c.low);
    const bull=n(c.close)>n(c.open)&&n(c.close)>priorHigh&&body>=0.55*atr&&range>=0.90*atr;
    const bear=n(c.close)<n(c.open)&&n(c.close)<priorLow&&body>=0.55*atr&&range>=0.90*atr;
    if(bull){
      const base=[...prior].reverse().find(x=>n(x.close)<n(x.open));
      if(base) demand={kind:'DEMAND',low:n(base.low),high:Math.max(n(base.open),n(base.close)),originTime:n(base.openTime),confirmedAt:n(c.openTime)};
    }
    if(bear){
      const base=[...prior].reverse().find(x=>n(x.close)>n(x.open));
      if(base) supply={kind:'SUPPLY',low:Math.min(n(base.open),n(base.close)),high:n(base.high),originTime:n(base.openTime),confirmedAt:n(c.openTime)};
    }
  }
  return {demand,supply};
}

function zoneDistance(price,zone){
  if(!zone||!finite(price)) return null;
  const p=n(price),lo=n(zone.low),hi=n(zone.high);
  if(p>=lo&&p<=hi) return 0;
  if(p<lo) return lo-p;
  return p-hi;
}

function recentSweep(candles,level,side,a15){
  if(!finite(level)||!(n(a15)>0)) return false;
  const xs=(candles||[]).slice(-5);
  if(side==='LONG') return xs.some(c=>n(c.low)<n(level)-0.02*n(a15)&&n(c.close)>n(level));
  if(side==='SHORT') return xs.some(c=>n(c.high)>n(level)+0.02*n(a15)&&n(c.close)<n(level));
  return false;
}

function marketContext(snap,reg={}){
  const m15=snap?.m15||[],h4=snap?.h4||[]; const last=m15.at(-1); const price=n(last?.close);
  const a15=finite(reg?.a15)&&n(reg.a15)>0?n(reg.a15):localAtr(m15,14);
  const m15s=structureBias(m15),h4s=structureBias(h4);
  const liq=nearestLiquidity(m15,price); const zones=latestOrderBlocks(m15,a15);
  return {
    price,
    a15,
    structure:{m15:m15s.bias,h4:h4s.bias},
    liquidity:{
      bsl:liq.bsl,ssl:liq.ssl,
      bslAtr:finite(liq.bsl)&&a15>0?round((n(liq.bsl)-price)/a15,2):null,
      sslAtr:finite(liq.ssl)&&a15>0?round((price-n(liq.ssl))/a15,2):null
    },
    zones,
    regime:reg?.type||null,
    regimeSide:reg?.side||null
  };
}

function scoreSignal({snap,reg={},sig={},vwap=null,context=null}){
  const ctx=context||marketContext(snap,reg); const side=String(sig.side||'').toUpperCase();
  const isLong=side==='LONG',want=isLong?'BULLISH':'BEARISH';
  const parts={regime:0,h4Structure:0,m15Structure:0,vwap:0,liquidity:0,zone:0,risk:0};
  if(reg.type==='TREND'&&reg.side===side) parts.regime=20;
  else if(reg.type==='RANGE'&&sig.mode==='RANGE_SWEEP') parts.regime=20;
  else if(reg.type==='NEUTRAL') parts.regime=5;
  parts.h4Structure=ctx.structure.h4===want?15:(ctx.structure.h4==='NEUTRAL'?7:0);
  parts.m15Structure=ctx.structure.m15===want?10:(ctx.structure.m15==='NEUTRAL'?5:0);
  if(finite(vwap)&&finite(sig.entry)) parts.vwap=(isLong?n(sig.entry)>n(vwap):n(sig.entry)<n(vwap))?15:0;
  else if(sig.mode==='RANGE_SWEEP') parts.vwap=8;

  const a15=n(ctx.a15); const liq=ctx.liquidity||{};
  const sweptOpposite=isLong?recentSweep(snap?.m15,liq.ssl,'LONG',a15):recentSweep(snap?.m15,liq.bsl,'SHORT',a15);
  const roomToTarget=isLong?n(liq.bsl)-n(sig.entry):n(sig.entry)-n(liq.ssl);
  if(sweptOpposite) parts.liquidity=15;
  else if(finite(roomToTarget)&&a15>0&&roomToTarget>=0.8*a15) parts.liquidity=11;
  else if(sig.mode==='RANGE_SWEEP') parts.liquidity=12;
  else parts.liquidity=5;

  const supportZone=isLong?ctx.zones?.demand:ctx.zones?.supply;
  const zd=zoneDistance(sig.entry,supportZone);
  if(finite(zd)&&a15>0&&zd<=0.35*a15) parts.zone=15;
  else if(supportZone) parts.zone=7;

  const riskAtr=n(sig.riskAtr);
  if(finite(riskAtr)&&riskAtr>=0.60&&riskAtr<=1.40) parts.risk=10;
  else if(finite(riskAtr)&&riskAtr>=0.35&&riskAtr<=1.80) parts.risk=6;

  const score=clamp(Object.values(parts).reduce((a,b)=>a+b,0),0,100);
  const label=score>=82?'HIGH':score>=70?'GOOD':score>=58?'FAIR':'LOW';
  return {...ctx,score,label,parts,sweptOpposite};
}

function decisionLabel(sig,intel,isReentry=false){
  const side=String(sig?.side||'').toUpperCase();
  if(isReentry) return side==='LONG'?'RE-BUY':'RE-SELL';
  return side==='LONG'?'BUY':'SELL';
}

function compactIntelligence(intel){
  if(!intel) return null;
  return {
    score:intel.score,label:intel.label,structure:intel.structure,
    liquidity:intel.liquidity,
    zones:{demand:intel.zones?.demand||null,supply:intel.zones?.supply||null},
    sweptOpposite:Boolean(intel.sweptOpposite)
  };
}

module.exports={confirmedSwings,structureBias,nearestLiquidity,latestOrderBlocks,zoneDistance,recentSweep,marketContext,scoreSignal,decisionLabel,compactIntelligence,localAtr};
