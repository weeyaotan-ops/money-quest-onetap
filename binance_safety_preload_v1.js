'use strict';

// Safety-only preload for Binance live execution.
// IMPORTANT: never rewrite Binance request URLs here. Requests are already signed
// before global.fetch() is called; changing any signed query parameter after that
// invalidates the Binance signature.
//
// This preload only corrects closed-trade Actual-R from the actual sized risk
// emitted at live execution. STOP/TP request parameters must be chosen inside the
// gateway before signature generation.

const actualRiskById=new Map();
const originalLog=console.log.bind(console);

function parse(prefix,args){
  try{
    const s=args.map(String).join(' '),i=s.indexOf(prefix);
    return i<0?null:JSON.parse(s.slice(i+prefix.length).trim());
  }catch{return null}
}

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

originalLog('BINANCE_SAFETY_PRELOAD_READY',JSON.stringify({signedUrlMutation:false,actualRUsesActualSizedRisk:true}));

module.exports={signedUrlMutation:false};
