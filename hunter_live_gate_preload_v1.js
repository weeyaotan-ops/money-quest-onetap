'use strict';

// Observational-only preload for HunterLiveGateV1.
// It never blocks, edits, resizes, cancels, or submits an order.

const fs=require('node:fs');
const pathMod=require('node:path');
const http=require('node:http');
const {HunterLiveGateV1}=require('./hunter_live_gate_v1');
const gate=new HunterLiveGateV1();
const liveById=new Map();
const PORT=String(process.env.PORT||process.env.BINANCE_ONETAP_PORT||8000);
const STATE_FILE=String(process.env.HUNTER_LIVE_GATE_STATE_FILE||'/data/hunter-live-gate-v1.json');
const STATE_VERSION=1;
let persistence={loaded:false,lastLoaded:null,lastSaved:null,lastError:null};

const hasFiniteActualR=t=>t&&t.actualR!==null&&t.actualR!==undefined&&t.actualR!==''&&Number.isFinite(Number(t.actualR));
const originalLog=console.log.bind(console);
function parse(prefix,args){
  try{
    const s=args.map(String).join(' '),i=s.indexOf(prefix);
    return i<0?null:JSON.parse(s.slice(i+prefix.length).trim());
  }catch{return null}
}
function readJson(req,limit=1024*1024){
  return new Promise((resolve,reject)=>{
    let n=0,s='';
    req.setEncoding('utf8');
    req.on('data',c=>{n+=Buffer.byteLength(c);if(n>limit){reject(Error('BODY_TOO_LARGE'));req.destroy();return}s+=c});
    req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});
    req.on('error',reject);
  });
}
function json(res,status,obj){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(obj))}
function persistenceSnapshot(){
  return {
    version:STATE_VERSION,
    savedAt:new Date().toISOString(),
    gate:{
      history:gate.history.slice(-5000),
      decisions:gate.decisions.slice(-5000),
      ignoredMissingActualR:Number(gate.ignoredMissingActualR||0)
    },
    liveById:[...liveById.entries()].slice(-5000)
  };
}
function saveState(){
  try{
    fs.mkdirSync(pathMod.dirname(STATE_FILE),{recursive:true});
    const tmp=STATE_FILE+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(persistenceSnapshot()));
    fs.renameSync(tmp,STATE_FILE);
    persistence.lastSaved=new Date().toISOString();
    persistence.lastError=null;
    return true;
  }catch(e){
    persistence.lastError=String(e?.message||e);
    originalLog('HUNTER_LIVE_GATE_PERSIST_ERR',persistence.lastError);
    return false;
  }
}
function restoreState(){
  try{
    if(!fs.existsSync(STATE_FILE)){
      originalLog('HUNTER_LIVE_GATE_PERSIST_EMPTY',JSON.stringify({stateFile:STATE_FILE}));
      return false;
    }
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    const h=Array.isArray(s?.gate?.history)?s.gate.history.slice(-5000):[];
    const d=Array.isArray(s?.gate?.decisions)?s.gate.decisions.slice(-5000):[];
    gate.history=h.sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt));
    gate.seenClosed=new Set(h.map(x=>String(x?.id||'')).filter(Boolean));
    gate.decisions=d;
    gate.decisionById=new Map(d.filter(x=>x&&x.id).map(x=>[String(x.id),x]));
    gate.ignoredMissingActualR=Number(s?.gate?.ignoredMissingActualR||0);
    liveById.clear();
    for(const row of Array.isArray(s?.liveById)?s.liveById:[]){
      if(Array.isArray(row)&&row.length===2&&row[0])liveById.set(String(row[0]),row[1]);
    }
    persistence.loaded=true;
    persistence.lastLoaded=new Date().toISOString();
    persistence.lastError=null;
    originalLog('HUNTER_LIVE_GATE_PERSIST_RESTORED',JSON.stringify({stateFile:STATE_FILE,history:gate.history.length,decisions:gate.decisions.length,live:liveById.size}));
    return true;
  }catch(e){
    persistence.lastError=String(e?.message||e);
    originalLog('HUNTER_LIVE_GATE_PERSIST_LOAD_ERR',persistence.lastError);
    return false;
  }
}
restoreState();

console.log=(...args)=>{
  try{
    let x=parse('ONETAP_LIVE_EXECUTED',args);
    if(x){
      const id=String(x.id||''),old=liveById.get(id)||{};
      const c={...old,id,symbol:x.symbol||old.symbol,side:x.side||old.side,openedAt:old.openedAt||new Date().toISOString()};
      liveById.set(id,c);
      const d=gate.scoreCandidate(c);
      saveState();
      originalLog('HUNTER_LIVE_GATE_SHADOW_DECISION',JSON.stringify({id,...d,source:old.id?'PRE_EXECUTION_OBSERVATION':'EXECUTION_FALLBACK'}));
    }
    x=parse('ONETAP_POSITION_CLOSED',args);
    if(x){
      const id=String(x.id||''),old=liveById.get(id)||{};
      const t={...old,id,symbol:x.symbol||old.symbol,actualR:x.stats?.actualR,netPnl:x.stats?.net,closedAt:new Date().toISOString()};
      if(gate.ingestClosedTrade(t)){
        liveById.delete(id);
        saveState();
        originalLog('HUNTER_LIVE_GATE_INGESTED',JSON.stringify({id,symbol:t.symbol,side:t.side,regime:t.regime,actualR:t.actualR,netPnl:t.netPnl,forwardMatched:Boolean(gate.decisionById.get(id))}));
      }
    }
  }catch(e){originalLog('HUNTER_LIVE_GATE_ERR',String(e?.message||e))}
  return originalLog(...args);
};

const orig=http.createServer;
http.createServer=function(...args){
  const listener=args[0];
  if(typeof listener==='function'){
    args[0]=async function(req,res){
      const path=String(req.url||'').split('?')[0];
      if(req.method==='GET'&&path==='/hunter-live-gate/report')return json(res,200,{ok:true,...gate.report(),persistence:{...persistence,stateFile:STATE_FILE}});
      if(req.method==='POST'&&path==='/hunter-live-gate/observe-candidate'){
        try{
          const c=await readJson(req),id=String(c?.id||'');
          if(!id)return json(res,400,{ok:false,error:'MISSING_ID'});
          liveById.set(id,{...(liveById.get(id)||{}),...c,id,observedAt:new Date().toISOString()});
          const d=gate.scoreCandidate(liveById.get(id));
          saveState();
          originalLog('HUNTER_LIVE_GATE_PRE_EXECUTION_DECISION',JSON.stringify(d));
          return json(res,200,{ok:true,decision:d,observationalOnly:true,liveExecutionChanged:false,persistent:true});
        }catch(e){return json(res,400,{ok:false,error:String(e?.message||e)})}
      }
      return listener(req,res);
    };
  }
  return orig.apply(this,args);
};

let backfilling=false,lastBackfill=null;
async function backfill(){
  if(backfilling)return;
  backfilling=true;
  try{
    const r=await fetch(`http://127.0.0.1:${PORT}/real-money/positions`,{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error('REAL_MONEY_'+r.status);
    const j=await r.json(),xs=Array.isArray(j.trades)?j.trades:[];
    let added=0,ignoredMissingActualR=0;
    for(const t of xs){
      if(t.status!=='CLOSED')continue;
      if(!hasFiniteActualR(t)){ignoredMissingActualR++;continue}
      if(gate.ingestClosedTrade(t))added++;
    }
    if(added>0)saveState();
    lastBackfill=new Date().toISOString();
    originalLog('HUNTER_LIVE_GATE_BACKFILL',JSON.stringify({source:'REAL_MONEY_LEDGER',seen:xs.length,added,ignoredMissingActualR,totalClosed:gate.history.length,lastBackfill,persistent:true}));
    const snapshot=gate.report();
    originalLog('HUNTER_LIVE_GATE_EVIDENCE_SNAPSHOT',JSON.stringify({validClosed:snapshot.dataQuality.validClosedTrades,recent:snapshot.recent,evidence:snapshot.evidence,forward:snapshot.forward,winQuality:snapshot.winQuality}));
  }catch(e){originalLog('HUNTER_LIVE_GATE_BACKFILL_ERR',String(e?.message||e))}
  finally{backfilling=false}
}

setTimeout(backfill,10000).unref();
setInterval(backfill,60000).unref();
setInterval(()=>{if(gate.history.length||gate.decisions.length||liveById.size)saveState()},30000).unref();
originalLog('HUNTER_LIVE_GATE_V1_READY',JSON.stringify({mode:'OBSERVATIONAL_ONLY',report:'/hunter-live-gate/report',observe:'/hunter-live-gate/observe-candidate',backfill:'/real-money/positions',stateFile:STATE_FILE,persistent:true,winQualityModel:'WIN_QUALITY_V1',winQualityMode:'SHADOW_ONLY',liveExecutionChanged:false}));

module.exports={gate,backfill,hasFiniteActualR,saveState,restoreState,STATE_FILE};
