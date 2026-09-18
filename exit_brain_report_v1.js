'use strict';

const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;

function usable(t){
  return String(t?.status||'').toUpperCase()==='CLOSED'
    && finite(t?.actualR)!==null
    && finite(t?.mfeR)!==null
    && finite(t?.maeR)!==null
    && Number(t?.excursionSamples||0)>0;
}
function stats(rows){
  const xs=(rows||[]).filter(usable);
  const actual=xs.map(x=>finite(x.actualR));
  const mfe=xs.map(x=>finite(x.mfeR));
  const mae=xs.map(x=>finite(x.maeR));
  const hold=xs.map(x=>finite(x.holdSec)).filter(x=>x!==null);
  const giveback=xs.map(x=>finite(x.mfeR)-finite(x.actualR));
  const winners=xs.filter(x=>finite(x.actualR)>0);
  const losers=xs.filter(x=>finite(x.actualR)<0);
  const lostAfterProfit=losers.filter(x=>finite(x.mfeR)>=0.5);
  const neverWorked=losers.filter(x=>finite(x.mfeR)<0.25);
  const winnerGiveback=winners.filter(x=>finite(x.mfeR)-finite(x.actualR)>=0.5);
  return {
    n:xs.length,wins:winners.length,losses:losers.length,
    winRate:xs.length?winners.length/xs.length:0,
    expectancyR:mean(actual),avgMfeR:mean(mfe),avgMaeR:mean(mae),avgHoldSec:mean(hold),avgGivebackR:mean(giveback),
    lostAfterProfit:{n:lostAfterProfit.length,rate:losers.length?lostAfterProfit.length/losers.length:0},
    neverWorked:{n:neverWorked.length,rate:losers.length?neverWorked.length/losers.length:0},
    winnerGiveback:{n:winnerGiveback.length,rate:winners.length?winnerGiveback.length/winners.length:0}
  };
}
function breakdown(rows,keyFn){
  const m=new Map();
  for(const x of (rows||[]).filter(usable)){
    const k=String(keyFn(x)||'UNKNOWN');
    if(!m.has(k))m.set(k,[]);
    m.get(k).push(x);
  }
  return [...m.entries()].map(([key,xs])=>({key,...stats(xs)})).sort((a,b)=>b.n-a.n||String(a.key).localeCompare(String(b.key)));
}
function buildExitBrainReport(rows){
  const xs=(rows||[]).filter(usable).sort((a,b)=>Date.parse(a.closedAt||0)-Date.parse(b.closedAt||0));
  const recent=xs.slice(-30);
  return {
    name:'EXIT_BRAIN_OBSERVER_V1',mode:'OBSERVATIONAL_ONLY',liveExecutionChanged:false,
    dataQuality:{usableClosed:xs.length,totalClosed:(rows||[]).filter(x=>String(x?.status||'').toUpperCase()==='CLOSED').length},
    overall:stats(xs),recent:stats(recent),
    evidence:{
      side:breakdown(xs,x=>x.side),
      regime:breakdown(xs,x=>x.regime),
      timeframe:breakdown(xs,x=>x.timeframe),
      edge:breakdown(xs,x=>x.edge||x.setup)
    },
    proofProgress:{minimum:30,target:60,current:xs.length},
    latest:xs.slice(-50).reverse().map(x=>({
      id:x.id,symbol:x.symbol,side:x.side,regime:x.regime,timeframe:x.timeframe,edge:x.edge||x.setup,
      actualR:finite(x.actualR),mfeR:finite(x.mfeR),maeR:finite(x.maeR),holdSec:finite(x.holdSec),
      givebackR:finite(x.mfeR)-finite(x.actualR),closedAt:x.closedAt
    }))
  };
}
module.exports={finite,usable,stats,breakdown,buildExitBrainReport};
