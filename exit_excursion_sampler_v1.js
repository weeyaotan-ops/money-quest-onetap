'use strict';

const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;

function sampleExcursion(trade,position,now=Date.now()){
  const risk=finite(trade?.actualRisk),u=finite(position?.unrealizedProfit);
  if(!(risk>0)||u===null)return{};
  const ur=u/risk;
  const prevMfe=finite(trade?.mfeR),prevMae=finite(trade?.maeR);
  const prevPeak=finite(trade?.peakUnrealizedPnl),prevTrough=finite(trade?.troughUnrealizedPnl);
  const opened=Date.parse(trade?.openedAt||'');
  return {
    mfeR:prevMfe===null?Math.max(0,ur):Math.max(prevMfe,ur),
    maeR:prevMae===null?Math.min(0,ur):Math.min(prevMae,ur),
    peakUnrealizedPnl:prevPeak===null?Math.max(0,u):Math.max(prevPeak,u),
    troughUnrealizedPnl:prevTrough===null?Math.min(0,u):Math.min(prevTrough,u),
    excursionSamples:Math.max(0,Number(trade?.excursionSamples||0))+1,
    holdSec:Number.isFinite(opened)?Math.max(0,Math.round((now-opened)/1000)):finite(trade?.holdSec)
  };
}

module.exports={finite,sampleExcursion};
