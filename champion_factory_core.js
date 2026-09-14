'use strict';

const DEFAULT_GATES = Object.freeze({
  minClosed: 100,
  minExpectancy: 0.10,
  minProfitFactor: 1.20,
  maxDrawdownPct: 10,
  minLcb90: 0,
  maxSymbolConcentration: 0.55,
  maxRegimeConcentration: 0.70
});

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const finite=(x,d=0)=>Number.isFinite(+x)?+x:d;

function shannonDiversity(counts){
  const vals=Object.values(counts||{}).map(Number).filter(x=>x>0);
  const total=vals.reduce((a,b)=>a+b,0);
  if(!total||vals.length<=1)return 0;
  const h=-vals.reduce((s,n)=>{const p=n/total;return s+p*Math.log(p)},0);
  return h/Math.log(vals.length);
}

function concentration(counts){
  const vals=Object.values(counts||{}).map(Number).filter(x=>x>0);
  const total=vals.reduce((a,b)=>a+b,0);
  return total?Math.max(...vals)/total:1;
}

function classifyRegime(m={}){
  const er=finite(m.er), vol=finite(m.vol), mom=Math.abs(finite(m.mom));
  if(vol>=18)return 'HIGH_VOL';
  if(er>=0.38 && mom>=8)return 'TREND';
  if(er<=0.16)return 'RANGE';
  if(er>=0.28 && mom>=14)return 'BREAKOUT';
  return 'MIXED';
}

function normalizedEvidenceScore(stats={}){
  const n=Math.max(0,finite(stats.n));
  const exp=finite(stats.expectancy,-99);
  const pf=finite(stats.pf,0);
  const dd=Math.max(0,finite(stats.dd,100));
  const lcb=finite(stats.lcb90,-99);
  const symbolDiv=finite(stats.symbolDiversity,0);
  const regimeDiv=finite(stats.regimeDiversity,0);
  const stability=finite(stats.stability,0);

  const sample=Math.tanh(n/100);
  const expScore=clamp((exp+0.10)/0.50,0,1);
  const pfScore=clamp(Math.log1p(Math.min(pf,5))/Math.log(6),0,1);
  const ddScore=1-clamp(dd/10,0,1);
  const lcbScore=clamp((lcb+0.05)/0.25,0,1);
  const divScore=clamp((symbolDiv+regimeDiv)/2,0,1);
  const stabScore=clamp(stability,0,1);

  const parts=[expScore,pfScore,ddScore,lcbScore,divScore,stabScore,sample].map(x=>Math.max(0.02,x));
  return Math.exp(parts.reduce((s,x)=>s+Math.log(x),0)/parts.length);
}

function evaluateChampion(stats={}, gates=DEFAULT_GATES){
  const reasons=[];
  const symbolConc=finite(stats.symbolConcentration,1);
  const regimeConc=finite(stats.regimeConcentration,1);
  if(finite(stats.n)<gates.minClosed) reasons.push('MIN_CLOSED');
  if(finite(stats.expectancy,-99)<=gates.minExpectancy) reasons.push('EXPECTANCY');
  if(finite(stats.pf,0)<=gates.minProfitFactor) reasons.push('PROFIT_FACTOR');
  if(finite(stats.dd,100)>=gates.maxDrawdownPct) reasons.push('DRAWDOWN');
  if(finite(stats.lcb90,-99)<=gates.minLcb90) reasons.push('LCB90');
  if(symbolConc>gates.maxSymbolConcentration) reasons.push('SYMBOL_CONCENTRATION');
  if(regimeConc>gates.maxRegimeConcentration) reasons.push('REGIME_CONCENTRATION');
  return {eligible:reasons.length===0,reasons,score:normalizedEvidenceScore(stats)};
}

function enrichStats(base={}, trades=[]){
  const symbolCounts={}, regimeCounts={};
  const rs=[];
  for(const t of trades||[]){
    if(t.symbol)symbolCounts[t.symbol]=(symbolCounts[t.symbol]||0)+1;
    const r=t.regime||classifyRegime(t.market||{});
    regimeCounts[r]=(regimeCounts[r]||0)+1;
    if(Number.isFinite(+t.netR))rs.push(+t.netR);
  }
  let stability=0;
  if(rs.length>=20){
    const chunk=Math.max(5,Math.floor(rs.length/5));
    const means=[];
    for(let i=0;i<rs.length;i+=chunk){const a=rs.slice(i,i+chunk);means.push(a.reduce((x,y)=>x+y,0)/a.length)}
    stability=means.filter(x=>x>0).length/means.length;
  }
  return {
    ...base,
    symbolCounts,regimeCounts,
    symbolConcentration:concentration(symbolCounts),
    regimeConcentration:concentration(regimeCounts),
    symbolDiversity:shannonDiversity(symbolCounts),
    regimeDiversity:shannonDiversity(regimeCounts),
    stability
  };
}

function selectPortfolio(candidates=[]){
  const roles=['BALANCED','TREND','RANGE','BREAKOUT','HIGH_VOL'];
  const out={};
  for(const role of roles){
    const ranked=candidates
      .filter(c=>c.role===role || (role==='BALANCED'&&c.role==='MIXED'))
      .map(c=>({...c,proof:evaluateChampion(c.stats)}))
      .sort((a,b)=>Number(b.proof.eligible)-Number(a.proof.eligible)||b.proof.score-a.proof.score);
    out[role]=ranked[0]||null;
  }
  return out;
}

function routeDecision({market={},portfolio={},minTrust=0.55}={}){
  const regime=classifyRegime(market);
  const specialist=portfolio[regime];
  const balanced=portfolio.BALANCED;
  const options=[specialist,balanced].filter(Boolean).filter(x=>x.proof?.eligible);
  if(!options.length)return {action:'NO_TRADE',regime,reason:'NO_PROVEN_CHAMPION'};
  options.sort((a,b)=>b.proof.score-a.proof.score);
  const pick=options[0];
  if(pick.proof.score<minTrust)return {action:'NO_TRADE',regime,reason:'INSUFFICIENT_TRUST',trust:pick.proof.score};
  return {action:'USE_CHAMPION',regime,championId:pick.id,role:pick.role,trust:pick.proof.score};
}

module.exports={DEFAULT_GATES,classifyRegime,shannonDiversity,concentration,enrichStats,normalizedEvidenceScore,evaluateChampion,selectPortfolio,routeDecision};
