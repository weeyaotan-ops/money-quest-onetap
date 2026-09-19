'use strict';

// Forward-only evaluation model. These estimates NEVER authorize or block a trade.
// One cohort at a time avoids counting the same trades as independent evidence.
const VERSION='WIN_QUALITY_V1';
const PRIOR_N=20;
const number=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x):null;
const key=x=>String(x||'UNKNOWN').toUpperCase();
function summarize(rows){
  const values=rows.map(x=>number(x.actualR)).filter(x=>x!==null);
  const wins=values.filter(x=>x>0).length;
  return {n:values.length,wins,totalR:values.reduce((a,b)=>a+b,0)};
}
function wilson(wins,n){
  if(!n)return{low:0,high:1};
  const z=1.96,p=wins/n,d=1+z*z/n;
  const center=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return{low:Math.max(0,center-half),high:Math.min(1,center+half)};
}
function estimate(candidate,history,asOf=Date.now()){
  const valid=history.filter(t=>(t.selectionVersion||'LEGACY')===(candidate.selectionVersion||'LEGACY')&&number(t.actualR)!==null&&Number.isFinite(Date.parse(t.closedAt))&&Date.parse(t.closedAt)<asOf)
    .sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt)).slice(-100);
  const base=summarize(valid);
  const edge=key(candidate.edge||candidate.setup),tf=key(candidate.timeframe),side=key(candidate.side);
  const definitions=[
    ['EDGE_TIMEFRAME',t=>edge!=='UNKNOWN'&&tf!=='UNKNOWN'&&key(t.edge)===edge&&key(t.timeframe)===tf],
    ['EDGE',t=>edge!=='UNKNOWN'&&key(t.edge)===edge],
    ['TIMEFRAME',t=>tf!=='UNKNOWN'&&key(t.timeframe)===tf],
    ['SIDE',t=>side!=='UNKNOWN'&&key(t.side)===side]
  ];
  let scope='GLOBAL',sample=base;
  for(const [name,predicate] of definitions){
    const s=summarize(valid.filter(predicate));
    if(s.n>=12){scope=name;sample=s;break}
  }
  const baseP=(base.wins+1)/(base.n+2),baseR=base.n?base.totalR/base.n:0;
  // Global prior uses Laplace smoothing. A subgroup is shrunk toward that prior;
  // this is an estimate, not a calibrated or independent confidence claim.
  const probability=scope==='GLOBAL'?baseP:(sample.wins+PRIOR_N*baseP)/(sample.n+PRIOR_N);
  const expectedR=scope==='GLOBAL'?baseR:(sample.totalR+PRIOR_N*baseR)/(sample.n+PRIOR_N);
  const interval=wilson(sample.wins,sample.n),netRR=number(candidate._actualNetRR??candidate.netRR);
  const breakEven=netRR!==null&&netRR>0?1/(1+netRR):null;
  const supported=sample.n>=30&&expectedR>0&&breakEven!==null&&interval.low>breakEven;
  return{version:VERSION,mode:'SHADOW_ONLY',selectionVersion:candidate.selectionVersion||'LEGACY',asOf:new Date(asOf).toISOString(),scope,n:sample.n,baselineN:base.n,
    winProbability:probability,expectedR,winRateInterval95:interval,breakEvenWinRate:breakEven,
    verdict:supported?'SUPPORTED':'UNPROVEN',priorN:PRIOR_N,calibrated:false,liveExecutionChanged:false};
}
function evaluate(history){
  const rows=history.filter(t=>t.winQuality?.version===VERSION&&number(t.actualR)!==null&&
    Date.parse(t.winQuality.asOf)<Date.parse(t.closedAt));
  const supported=rows.filter(t=>t.winQuality.verdict==='SUPPORTED');
  const rejected=rows.filter(t=>t.winQuality.verdict!=='SUPPORTED');
  function stats(xs){const s=summarize(xs);return{...s,winRate:s.n?s.wins/s.n:null,expectancyR:s.n?s.totalR/s.n:null}}
  const bins=[0,.2,.4,.6,.8].map(low=>{
    const xs=rows.filter(t=>t.winQuality.winProbability>=low&&(low===.8?t.winQuality.winProbability<=1:t.winQuality.winProbability<Math.round((low+.2)*10)/10));
    return{low,high:low+.2,n:xs.length,meanPrediction:xs.length?xs.reduce((s,t)=>s+t.winQuality.winProbability,0)/xs.length:null,actualWinRate:xs.length?xs.filter(t=>t.actualR>0).length/xs.length:null};
  });
  return{version:VERSION,mode:'SHADOW_ONLY',baseline:stats(rows),supported:stats(supported),unproven:stats(rejected),
    brierScore:rows.length?rows.reduce((s,t)=>s+(t.winQuality.winProbability-(t.actualR>0?1:0))**2,0)/rows.length:null,
    calibrationBins:bins,minimumReviewSample:100,readyForReview:rows.length>=100&&supported.length>=30,
    automaticPromotion:false,liveExecutionChanged:false};
}
module.exports={VERSION,estimate,evaluate,wilson};
