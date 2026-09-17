'use strict';

// Observational-only preload that mirrors confirmed live trades into HunterLiveGateV1.
// It never blocks, edits, resizes, cancels, or submits any order.

const http=require('node:http');
const {HunterLiveGateV1}=require('./hunter_live_gate_v1');
const gate=new HunterLiveGateV1();
const liveById=new Map();

const originalLog=console.log.bind(console);
function parse(prefix,args){
  try{
    const s=args.map(String).join(' '),i=s.indexOf(prefix);
    return i<0?null:JSON.parse(s.slice(i+prefix.length).trim());
  }catch{return null}
}

console.log=(...args)=>{
  try{
    let x=parse('ONETAP_LIVE_EXECUTED',args);
    if(x){
      const id=String(x.id||'');
      const c={id,symbol:x.symbol,side:x.side,regime:x.regime||x.shadowStructureRegime||'UNKNOWN',openedAt:new Date().toISOString()};
      liveById.set(id,c);
      const d=gate.scoreCandidate(c);
      originalLog('HUNTER_LIVE_GATE_SHADOW_DECISION',JSON.stringify({id,...d}));
    }
    x=parse('ONETAP_POSITION_CLOSED',args);
    if(x){
      const id=String(x.id||''), old=liveById.get(id)||{};
      const t={...old,id,symbol:x.symbol||old.symbol,actualR:x.stats?.actualR,netPnl:x.stats?.net,closedAt:new Date().toISOString()};
      if(gate.ingestClosedTrade(t)) originalLog('HUNTER_LIVE_GATE_INGESTED',JSON.stringify({id,symbol:t.symbol,actualR:t.actualR,netPnl:t.netPnl}));
    }
  }catch(e){originalLog('HUNTER_LIVE_GATE_ERR',String(e?.message||e))}
  return originalLog(...args);
};

const orig=http.createServer;
http.createServer=function(...args){
  const listener=args[0];
  if(typeof listener==='function'){
    args[0]=function(req,res){
      const path=String(req.url||'').split('?')[0];
      if(req.method==='GET'&&path==='/hunter-live-gate/report'){
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        return res.end(JSON.stringify({ok:true,...gate.report()}));
      }
      return listener(req,res);
    };
  }
  return orig.apply(this,args);
};

originalLog('HUNTER_LIVE_GATE_V1_READY',JSON.stringify({mode:'OBSERVATIONAL_ONLY',route:'/hunter-live-gate/report',liveExecutionChanged:false}));

module.exports={gate};
