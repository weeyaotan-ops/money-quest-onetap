'use strict';

const SELECTION_VERSION='CONFIRMED_STRUCTURE_V1';

// Pattern eligibility, not a win-probability estimate. All inputs are closed bars.
function confirmedSetups(m){
  const p=m?.pattern;
  if(!p)return[];
  const {last:a,previous:b,priorHigh20,priorLow20,ema8,ema20,previousEma20,priorAtr14,lastTR}=p;
  if(!a||!b||![m.mom,m.er,m.vol,m.high20,m.low20,a.open,a.high,a.low,a.close,
    b.close,b.high,b.low,priorHigh20,priorLow20,ema8,ema20,previousEma20,priorAtr14,lastTR].every(Number.isFinite))return[];
  const out=[];
  const add=(edge,side,level)=>out.push({edge,side,level,invalidation:side==='BUY'?a.low:a.high});
  const up=a.close>a.open,down=a.close<a.open;
  const rising=m.mom>0,falling=m.mom<0;

  // A range midpoint alone is not a sweep. Require a boundary breach and reclaim.
  if(m.er<=.16){
    const sweptLow=a.low<m.low20,sweptHigh=a.high>m.high20;
    if(sweptLow&&!sweptHigh&&a.close>m.low20&&a.close<m.high20&&up)
      add('RANGE_SWEEP_REVERSION','BUY',m.low20);
    if(sweptHigh&&!sweptLow&&a.close<m.high20&&a.close>m.low20&&down)
      add('RANGE_SWEEP_REVERSION','SELL',m.high20);
    return out;
  }
  // The prior candle must break the earlier range; this candle must retest it.
  if(rising&&b.close>priorHigh20&&a.low<=priorHigh20&&a.close>priorHigh20&&up)
    add('BREAKOUT_RETEST','BUY',priorHigh20);
  if(falling&&b.close<priorLow20&&a.high>=priorLow20&&a.close<priorLow20&&down)
    add('BREAKOUT_RETEST','SELL',priorLow20);

  // Keep the engine's existing efficiency thresholds; confirm the actual reclaim.
  if(m.er>=.38){
    if(rising&&ema8>ema20&&b.close<=previousEma20&&a.close>ema20&&up)
      add('TREND_PULLBACK_RECLAIM','BUY',ema20);
    if(falling&&ema8<ema20&&b.close>=previousEma20&&a.close<ema20&&down)
      add('TREND_PULLBACK_RECLAIM','SELL',ema20);
  }
  if(m.er>=.28){
    if(rising&&ema8>ema20&&a.close>ema20&&a.close>b.high&&up)
      add('MOMENTUM_CONTINUATION','BUY',b.high);
    if(falling&&ema8<ema20&&a.close<ema20&&a.close<b.low&&down)
      add('MOMENTUM_CONTINUATION','SELL',b.low);
  }
  // High volatility by itself is insufficient: expansion must break a boundary.
  if(m.vol>=18&&priorAtr14>0&&lastTR>priorAtr14){
    if(rising&&a.close>m.high20&&up)add('VOLATILITY_EXPANSION','BUY',m.high20);
    if(falling&&a.close<m.low20&&down)add('VOLATILITY_EXPANSION','SELL',m.low20);
  }
  return out;
}

function stopSupportsSetup(setup,stop){
  return Number.isFinite(stop)&&Number.isFinite(setup?.invalidation)&&
    (setup.side==='BUY'?stop<setup.invalidation:setup.side==='SELL'?stop>setup.invalidation:false);
}
module.exports={SELECTION_VERSION,confirmedSetups,stopSupportsSetup};
