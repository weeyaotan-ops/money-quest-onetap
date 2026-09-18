'use strict';

const num=x=>Number.isFinite(Number(x))?Number(x):null;
function updateExcursion(trade={},position={},now=Date.now()){
  const pnl=num(position.unrealizedProfit??position.unRealizedProfit);
  if(pnl===null)return{lastSeenOpenAt:new Date(now).toISOString()};
  const risk=num(trade.actualRisk);
  const r=risk&&risk>0?pnl/risk:null;
  const prevMax=num(trade.maxUnrealizedPnl),prevMin=num(trade.minUnrealizedPnl);
  const out={
    lastUnrealizedPnl:pnl,
    maxUnrealizedPnl:prevMax===null?pnl:Math.max(prevMax,pnl),
    minUnrealizedPnl:prevMin===null?pnl:Math.min(prevMin,pnl),
    lastSeenOpenAt:new Date(now).toISOString()
  };
  if(r!==null){
    const prevMaxR=num(trade.maxUnrealizedR),prevMinR=num(trade.minUnrealizedR);
    out.lastUnrealizedR=r;
    out.maxUnrealizedR=prevMaxR===null?r:Math.max(prevMaxR,r);
    out.minUnrealizedR=prevMinR===null?r:Math.min(prevMinR,r);
  }
  return out;
}
function finalizeHold(trade={},closedAt=new Date().toISOString()){
  const o=Date.parse(trade.openedAt||0),c=Date.parse(closedAt||0);
  return Number.isFinite(o)&&o>0&&Number.isFinite(c)&&c>=o?{holdMs:c-o}:{};
}
module.exports={updateExcursion,finalizeHold};
