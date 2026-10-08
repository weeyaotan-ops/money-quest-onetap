'use strict';
// V2.1 shadow-only opportunity engine. No order placement, Telegram publishing,
// or changes to the currently deployed Hunter V2 scanner.
const M15 = 15 * 60 * 1000;
const n = x => Number.isFinite(Number(x)) ? Number(x) : null;
function evaluate({symbol, side, mode, entry, stop, tp1, tp2, feeRate=0.0005, slipRate=0.0002,
  minNetR=1.15, timestamp=Date.now(), expiresAt, score=0}) {
  const e=n(entry), sl=n(stop), p1=n(tp1), p2=n(tp2), fee=n(feeRate), slip=n(slipRate);
  if (![e,sl,p1,p2,fee,slip].every(v=>v!==null) || e<=0 || fee<0 || slip<0)
    return {status:'SKIP',reason:'BAD_NUMBERS',symbol,mode};
  if (!['LONG','SHORT'].includes(side)) return {status:'SKIP',reason:'BAD_SIDE',symbol,mode};
  const dir=side==='LONG'?1:-1, risk=dir*(e-sl);
  if (!(risk>0 && dir*(p1-e)>0 && dir*(p2-p1)>0))
    return {status:'SKIP',reason:'BAD_STRUCTURE',symbol,mode};
  if (n(expiresAt)!==null && timestamp>=Number(expiresAt))
    return {status:'EXPIRED',reason:'TIMEOUT',symbol,mode};
  // Full round-trip conservative taker fees and slippage (per unit).
  const gross=dir*(p2-e);
  const friction=fee*(e+p2)+slip*e;
  const stopFriction=fee*(e+sl)+slip*e;
  const netR=(gross-friction)/(risk+stopFriction);
  const costShare=friction/gross;
  const status=netR>=minNetR && costShare<=0.25 ? 'SHADOW_CANDIDATE' : 'SKIP';
  return {symbol,side,mode,status,reason:status==='SKIP'?'NET_EDGE_TOO_LOW':'OK',
    entry:e,stop:sl,tp1:p1,tp2:p2,netR:+netR.toFixed(4),
    costShare:+costShare.toFixed(4),score,expiresAt};
}
function detect({symbol,candles,box,regime,atr15,vwap,now=Date.now()}) {
  const out=[];
  if (!Array.isArray(candles)||candles.length<5||!box||!regime||regime.type!=='TREND') return out;
  const side=regime.side,dir=side==='LONG'?1:side==='SHORT'?-1:0;
  const atr=n(atr15), line=n(side==='LONG'?box.high:box.low), vw=n(vwap);
  if(!dir||!(atr>0)||line===null||vw===null) return out;
  const cur=candles.at(-1),prev=candles.at(-2);
  if(!cur||!prev||!(n(cur.close)>0)||!(n(prev.close)>0)) return out;
  if(now-(cur.openTime+M15)>M15 || cur.openTime+M15>now) return out;
  if(cur.openTime<(box.activeFrom||0)||cur.openTime>=(box.activeUntil||Infinity)) return out;
  const aligned=dir*(cur.close-vw)>0;
  if(!aligned) return out;
  const candleRange=cur.high-cur.low;
  const body=Math.abs(cur.close-cur.open);
  // Strong breakout: only newly crosses the box, closes decisively past it,
  // and isn't excessively extended. This is a candidate, never a live order.
  const fresh=dir*(prev.close-line)<=0 && dir*(cur.close-line)>0;
  const distance=dir*(cur.close-line);
  if(fresh && distance>=0.15*atr && distance<=0.75*atr &&
     candleRange>0 && body/candleRange>=0.55 && dir*(cur.close-cur.open)>0){
    const stop=side==='LONG'?Math.min(line-0.35*atr,cur.low-0.05*atr):Math.max(line+0.35*atr,cur.high+0.05*atr);
    const risk=Math.abs(cur.close-stop);
    out.push(evaluate({symbol,side,mode:'BREAKOUT_DIRECT',entry:cur.close,stop,
      tp1:cur.close+dir*risk,tp2:cur.close+dir*2*risk, timestamp:now,
      expiresAt:cur.openTime+2*M15}));
  }
  // Continuation: pullback and reclaim of 9-bar midpoint, without
  // relying on session box retest; no candle may have invalidated the box.
  if(candles.length>=10){
    const prior=candles.slice(-10,-1);
    const recentHi=Math.max(...prior.map(x=>x.high));
    const recentLo=Math.min(...prior.map(x=>x.low));
    const midpoint=(recentHi+recentLo)/2;
    const reclaimed=dir*(prev.close-midpoint)<=0 && dir*(cur.close-midpoint)>0;
    const structureHeld=side==='LONG'?Math.min(...candles.slice(-4).map(x=>x.low))>box.low:
      Math.max(...candles.slice(-4).map(x=>x.high))<box.high;
    const extension=dir*(cur.close-line);
    if(reclaimed && structureHeld && extension>=0.1*atr && extension<=2*atr &&
      dir*(cur.close-cur.open)>0){
      const stop=side==='LONG'?Math.min(recentLo,midpoint-0.5*atr):Math.max(recentHi,midpoint+0.5*atr);
      const risk=Math.abs(cur.close-stop);
      out.push(evaluate({symbol,side,mode:'TREND_CONTINUATION',entry:cur.close,stop,
        tp1:cur.close+dir*risk,tp2:cur.close+dir*2*risk, timestamp:now,
        expiresAt:cur.openTime+2*M15}));
    }
  }
  return out;
}
module.exports={evaluate,detect};
