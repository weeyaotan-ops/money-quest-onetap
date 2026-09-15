'use strict';

// Money Hunter Opportunity Hunter V1
// Deterministic multi-edge scorer. Signal generation only; no exchange order submission.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const finite=(x,d=0)=>Number.isFinite(+x)?+x:d;

function regimeOf(m={}){
  const er=finite(m.er),vol=finite(m.vol),mom=Math.abs(finite(m.mom));
  if(vol>=18)return'HIGH_VOL';
  if(er>=.38&&mom>=8)return'TREND';
  if(er<=.16)return'RANGE';
  if(er>=.28&&mom>=14)return'BREAKOUT';
  return'MIXED';
}

function edgeScores({market={},sourceSide='BUY',sourceSetup='',spreadBps=0,rr=0}={}){
  const er=finite(market.er),vol=finite(market.vol),mom=finite(market.mom),absMom=Math.abs(mom);
  const setup=String(sourceSetup).toUpperCase();
  const dir=sourceSide==='SELL'?-1:1;
  const align=dir*Math.sign(mom||dir);
  const trend=clamp(.35+er*.8+absMom/70+(align>0?.20:-.20)+(setup.includes('PULLBACK')||setup.includes('RECLAIM')?.18:0),0,1);
  const breakout=clamp(.20+er*.75+absMom/55+vol/80+(setup.includes('BREAKOUT')||setup.includes('RETEST')?.22:0),0,1);
  const range=clamp(.25+(1-er)*.55+(align<0?.18:0)+(setup.includes('SWEEP')||setup.includes('MEAN')||setup.includes('RANGE')?.22:0),0,1);
  const momentum=clamp(.18+absMom/45+er*.45+vol/100+(align>0?.18:-.12),0,1);
  const volExpansion=clamp(.12+vol/35+absMom/85+er*.35,0,1);
  const friction=clamp(finite(spreadBps)/12,0,.65);
  const rrBonus=clamp((finite(rr)-1)/5,0,.20);
  return [
    ['TREND_PULLBACK_RECLAIM',trend],['BREAKOUT_RETEST',breakout],['RANGE_SWEEP_REVERSION',range],
    ['MOMENTUM_CONTINUATION',momentum],['VOLATILITY_EXPANSION',volExpansion]
  ].map(([edge,raw])=>({edge,raw,netScore:clamp(raw-friction+rrBonus,0,1)})).sort((a,b)=>b.netScore-a.netScore);
}

function hunt(input={},opts={}){
  const minScore=finite(opts.minScore,.72),minRR=finite(opts.minRR,1.20),maxSpreadBps=finite(opts.maxSpreadBps,8);
  const spread=finite(input.spreadBps,99),rr=finite(input.rr,0);
  const edges=edgeScores(input),best=edges[0];
  const regime=regimeOf(input.market||{});
  const reasons=[];
  if(spread>maxSpreadBps)reasons.push('SPREAD_TOO_WIDE');
  if(rr<minRR)reasons.push('RR_TOO_LOW');
  if(!best||best.netScore<minScore)reasons.push('EDGE_TOO_WEAK');
  if(reasons.length)return{action:'NO_TRADE',regime,reasons,edges};
  return{action:'ONE_TAP_CANDIDATE',regime,edge:best.edge,score:best.netScore,side:input.sourceSide,symbol:input.symbol,entry:input.entry,sl:input.sl,tp:input.tp,rr,spreadBps:spread,edges};
}

module.exports={regimeOf,edgeScores,hunt};
