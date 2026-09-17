'use strict';

// Safety-only preload for Binance live execution.
// 1) Hard STOP_MARKET orders default to priceProtect=false so a mark/contract
//    dislocation cannot suppress a stop trigger. Set BINANCE_STOP_PRICE_PROTECT=1
//    to restore the old behavior.
// 2) Recompute closed-trade Actual-R from the actual sized risk emitted at entry.

const STOP_PRICE_PROTECT=process.env.BINANCE_STOP_PRICE_PROTECT==='1';
const actualRiskById=new Map();
const originalFetch=global.fetch.bind(global);
const originalLog=console.log.bind(console);

function parse(prefix,args){
  try{
    const s=args.map(String).join(' '),i=s.indexOf(prefix);
    return i<0?null:JSON.parse(s.slice(i+prefix.length).trim());
  }catch{return null}
}

function rewriteStopProtect(input){
  try{
    const raw=typeof input==='string'?input:input instanceof URL?input.toString():null;
    if(!raw||!raw.includes('/fapi/v1/algoOrder'))return input;
    const u=new URL(raw);
    if(String(u.searchParams.get('type')||'').toUpperCase()!=='STOP_MARKET')return input;
    u.searchParams.set('priceProtect',STOP_PRICE_PROTECT?'TRUE':'FALSE');
    return typeof input==='string'?u.toString():u;
  }catch{return input}
}

global.fetch=function(input,init){
  return originalFetch(rewriteStopProtect(input),init);
};

console.log=(...args)=>{
  try{
    const opened=parse('ONETAP_LIVE_EXECUTED',args);
    if(opened){
      const id=String(opened.id||''),risk=Number(opened.actualRisk);
      if(id&&Number.isFinite(risk)&&risk>0)actualRiskById.set(id,risk);
    }

    const closed=parse('ONETAP_POSITION_CLOSED',args);
    if(closed){
      const id=String(closed.id||''),risk=actualRiskById.get(id),net=Number(closed.stats?.net);
      if(id&&Number.isFinite(risk)&&risk>0&&Number.isFinite(net)){
        const actualR=net/risk;
        const corrected={...closed,stats:{...(closed.stats||{}),actualR}};
        args=['ONETAP_POSITION_CLOSED',JSON.stringify(corrected)];
        actualRiskById.delete(id);
        originalLog('BINANCE_SAFETY_ACTUAL_R_CORRECTED',JSON.stringify({id,symbol:closed.symbol,actualRisk:risk,net,actualR}));
      }
    }
  }catch(e){
    originalLog('BINANCE_SAFETY_PRELOAD_ERR',String(e?.message||e));
  }
  return originalLog(...args);
};

originalLog('BINANCE_SAFETY_PRELOAD_READY',JSON.stringify({stopMarketPriceProtect:STOP_PRICE_PROTECT,actualRUsesActualSizedRisk:true}));

module.exports={rewriteStopProtect};
