'use strict';

// Money Hunter Adaptive Opportunity Hunter V2.
// Market-adaptive signal scoring only. Execution remains user-confirmed downstream.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const finite=(x,d=0)=>Number.isFinite(+x)?+x:d;

function regimeOf(m={}){
  const er=finite(m.er),vol=finite(m.vol),mom=Math.abs(finite(m.mom));
  if(vol>=18)return'HIGH_VOL';
  if(er>=.38&&mom>=8)return'TREND';
  if(er>=.28&&mom>=14)return'BREAKOUT';
  if(er<=.16)return'RANGE';
  return'MIXED';
}

const FIT={
 TREND:{TREND_PULLBACK_RECLAIM:1.12,MOMENTUM_CONTINUATION:1.06,BREAKOUT_RETEST:1.02,VOLATILITY_EXPANSION:.96,RANGE_SWEEP_REVERSION:.78},
 BREAKOUT:{BREAKOUT_RETEST:1.14,MOMENTUM_CONTINUATION:1.08,VOLATILITY_EXPANSION:1.04,TREND_PULLBACK_RECLAIM:.98,RANGE_SWEEP_REVERSION:.76},
 RANGE:{RANGE_SWEEP_REVERSION:1.16,TREND_PULLBACK_RECLAIM:.80,BREAKOUT_RETEST:.78,MOMENTUM_CONTINUATION:.82,VOLATILITY_EXPANSION:.86},
 HIGH_VOL:{VOLATILITY_EXPANSION:1.12,BREAKOUT_RETEST:1.07,MOMENTUM_CONTINUATION:1.04,TREND_PULLBACK_RECLAIM:.94,RANGE_SWEEP_REVERSION:.82},
 MIXED:{TREND_PULLBACK_RECLAIM:1,BREAKOUT_RETEST:1,RANGE_SWEEP_REVERSION:1,MOMENTUM_CONTINUATION:1,VOLATILITY_EXPANSION:1}
};

function edgeScores({market={},sourceSide='BUY',sourceSetup='',spreadBps=0,rr=0}={}){
  const er=finite(market.er),vol=finite(market.vol),mom=finite(market.mom),absMom=Math.abs(mom);
  const setup=String(sourceSetup).toUpperCase(),dir=sourceSide==='SELL'?-1:1,align=dir*Math.sign(mom||dir);
  const trend=clamp(.35+er*.8+absMom/70+(align>0?.20:-.20)+((setup.includes('PULLBACK')||setup.includes('RECLAIM'))?.18:0),0,1);
  const breakout=clamp(.20+er*.75+absMom/55+vol/80+((setup.includes('BREAKOUT')||setup.includes('RETEST'))?.22:0),0,1);
  const range=clamp(.25+(1-er)*.55+(align<0?.18:0)+((setup.includes('SWEEP')||setup.includes('MEAN')||setup.includes('RANGE'))?.22:0),0,1);
  const momentum=clamp(.18+absMom/45+er*.45+vol/100+(align>0?.18:-.12),0,1);
  const volExpansion=clamp(.12+vol/35+absMom/85+er*.35,0,1);
  const friction=clamp(finite(spreadBps)/12,0,.65),rrBonus=clamp((finite(rr)-1)/5,0,.20);
  return [['TREND_PULLBACK_RECLAIM',trend],['BREAKOUT_RETEST',breakout],['RANGE_SWEEP_REVERSION',range],['MOMENTUM_CONTINUATION',momentum],['VOLATILITY_EXPANSION',volExpansion]]
    .map(([edge,raw])=>({edge,raw,baseScore:clamp(raw-friction+rrBonus,0,1)}));
}

function adaptiveScore(edge,base,regime,learning={}){
 const fit=finite(FIT[regime]?.[edge],1),stat=learning[edge]||{},n=Math.max(0,finite(stat.n)),exp=finite(stat.expectancyR),win=finite(stat.winRate,.5);
 // Shrunk forward feedback: small samples cannot dominate; evidence gradually earns influence.
 const trust=clamp(n/40,0,.75),quality=clamp(.5+exp*.22+(win-.5)*.22,.25,.80),learnMultiplier=(1-trust)+trust*(quality/.5);
 const uncertainty=clamp((12-n)/60,0,.12);
 return clamp(base*fit*learnMultiplier-uncertainty,0,1);
}

function hunt(input={},opts={}){
  const floor=finite(opts.minScore,.62),minRR=finite(opts.minRR,1.20),maxSpreadBps=finite(opts.maxSpreadBps,8),learning=opts.learning||{};
  const spread=finite(input.spreadBps,99),rr=finite(input.rr,0),regime=regimeOf(input.market||{});
  // Rank only the detected pattern; unrelated high scores cannot relabel its side.
  const direction=input.sourceSide==='BUY'?1:input.sourceSide==='SELL'?-1:0;
  const edges=edgeScores(input).filter(x=>input.setupConfirmed===true&&direction&&x.edge===input.sourceSetup&&
      (x.edge==='RANGE_SWEEP_REVERSION'||Math.sign(finite(input.market?.mom))===direction))
    .map(x=>({...x,regimeFit:finite(FIT[regime]?.[x.edge],1),score:adaptiveScore(x.edge,x.baseScore,regime,learning)})).sort((a,b)=>b.score-a.score),best=edges[0];
  // Dynamic hurdle: active regimes can hunt harder; mixed/uncertain regimes demand more evidence.
  const regimeHurdle={TREND:.64,BREAKOUT:.65,RANGE:.63,HIGH_VOL:.66,MIXED:.70}[regime]||.70;
  const hurdle=Math.max(floor,regimeHurdle),reasons=[];
  if(!edges.length)reasons.push('SETUP_NOT_CONFIRMED');
  if(spread>maxSpreadBps)reasons.push('SPREAD_TOO_WIDE');
  if(rr<minRR)reasons.push('RR_TOO_LOW');
  if(!best||best.score<hurdle)reasons.push('EDGE_VALUE_TOO_LOW');
  if(reasons.length)return{action:'NO_TRADE',regime,hurdle,reasons,edges};
  return{action:'ONE_TAP_CANDIDATE',regime,edge:best.edge,score:best.score,baseScore:best.baseScore,hurdle,side:input.sourceSide,symbol:input.symbol,entry:input.entry,sl:input.sl,tp:input.tp,rr,spreadBps:spread,edges};
}

module.exports={regimeOf,edgeScores,adaptiveScore,hunt};
