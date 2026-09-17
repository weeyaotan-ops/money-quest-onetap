'use strict';

// Observational-only preload for HunterLiveGateV1.
// It never blocks, edits, resizes, cancels, or submits an order.
// V1.1 adds restart-safe state persistence and Binance-history Actual-R recovery.

const http=require('node:http');
const crypto=require('node:crypto');
const {HunterLiveGateV1}=require('./hunter_live_gate_v1');
const gate=new HunterLiveGateV1();
const liveById=new Map();
const PORT=String(process.env.PORT||process.env.BINANCE_ONETAP_PORT||8000);
const STORE_URL=String(process.env.HUNTER_GATE_STATE_URL||'http://signal-analytics-engine.railway.internal:9011/state');
const STORE_TOKEN=String(process.env.HUNTER_GATE_STATE_TOKEN||'');
const REST=String(process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com').replace(/\/$/,'');
const API_KEY=String(process.env.BINANCE_API_KEY||'');
const PRIV=String(process.env.BINANCE_ED25519_PRIVATE_KEY_PEM||'');
const FALLBACK_FEE=Math.max(0,Number(process.env.EST_FEE_BPS_PER_SIDE||5))/10000;
const SLIP_SIDE=Math.max(0,Number(process.env.EST_SLIPPAGE_BPS_PER_SIDE||1))/10000;
const MAX_RISK_RECOVER_PER_BACKFILL=Math.max(1,Math.min(30,Number(process.env.HUNTER_GATE_RISK_RECOVER_BATCH||8)));

const hasFiniteActualR=t=>t&&t.actualR!==null&&t.actualR!==undefined&&t.actualR!==''&&Number.isFinite(Number(t.actualR));
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const originalLog=console.log.bind(console);
const originalWarn=console.warn.bind(console);
const originalError=console.error.bind(console);

const bootstrapDecisions=[
  {id:'hunter_cbcab8540601ed61689adc36',at:'2026-09-17T19:31:24.860Z',symbol:'MARSCOINUSDT',side:'BUY',regime:'HIGH_VOL',timeframe:'5m',edge:'MOMENTUM_CONTINUATION',score:0.5,verdict:'WATCH',reasons:['RECENT_SAMPLE_SMALL','SYMBOL_SAMPLE_SMALL'],observationalOnly:true,liveExecutionChanged:false},
  {id:'hunter_32c5dc5aa24bee165ba9c659',at:'2026-09-17T19:31:26.348Z',symbol:'UNIUSDT',side:'BUY',regime:'HIGH_VOL',timeframe:'15m',edge:'MOMENTUM_CONTINUATION',score:0.5,verdict:'WATCH',reasons:['RECENT_SAMPLE_SMALL','SYMBOL_SAMPLE_SMALL'],observationalOnly:true,liveExecutionChanged:false},
  {id:'hunter_b0bba26dda8da36010a0261f',at:'2026-09-17T19:35:38.462Z',symbol:'牛来USDT',side:'BUY',regime:'HIGH_VOL',timeframe:'15m',edge:'MOMENTUM_CONTINUATION',score:0.5,verdict:'WATCH',reasons:['RECENT_SAMPLE_SMALL','SYMBOL_SAMPLE_SMALL'],observationalOnly:true,liveExecutionChanged:false},
  {id:'hunter_3f31ee24ce1b4e1cd36a27d1',at:'2026-09-17T20:07:07.969Z',symbol:'ARBUSDT',side:'SELL',regime:'HIGH_VOL',timeframe:'15m',edge:'BREAKOUT_RETEST',score:0.6,verdict:'WATCH',reasons:['RECENT_POSITIVE_EXPECTANCY','SYMBOL_SAMPLE_SMALL'],observationalOnly:true,liveExecutionChanged:false}
];

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
function qs(p){return Object.entries(p).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>`${k}=${encodeURIComponent(String(v))}`).join('&')}
function sign(s){return crypto.sign(null,Buffer.from(s),crypto.createPrivateKey(PRIV)).toString('base64')}
async function signedGet(path,params={}){
  if(!API_KEY||!PRIV)throw Error('BINANCE_AUTH_NOT_CONFIGURED');
  const p={...params,recvWindow:5000,timestamp:Date.now()},base=qs(p);
  const r=await fetch(`${REST}${path}?${base}&signature=${encodeURIComponent(sign(base))}`,{headers:{'X-MBX-APIKEY':API_KEY},signal:AbortSignal.timeout(7000)});
  const text=await r.text();let j;try{j=JSON.parse(text)}catch{j=text}
  if(!r.ok)throw Error(`BINANCE_${r.status}_${j?.code||''}_${j?.msg||text}`);
  return j;
}
function safeId(prefix,id){return(prefix+crypto.createHash('sha256').update(String(id)).digest('hex')).slice(0,36)}

let persistentLoaded=false,loadAttempted=false,lastLoad=null,lastSave=null,lastPersistError=null,saveTimer=null,saving=false,saveAgain=false,loadInFlight=null;
function restoreState(x){
  const history=Array.isArray(x?.history)?x.history.slice(-5000):[];
  const decisions=Array.isArray(x?.decisions)?x.decisions.slice(-5000):[];
  gate.history=history;
  gate.seenClosed=new Set(history.map(t=>String(t?.id||'')).filter(Boolean));
  gate.decisions=decisions;
  gate.decisionById=new Map(decisions.filter(d=>d&&d.id).map(d=>[String(d.id),d]));
  gate.ignoredMissingActualR=Math.max(0,Number(x?.ignoredMissingActualR||0));
  liveById.clear();
  if(Array.isArray(x?.live))for(const t of x.live)if(t&&t.id)liveById.set(String(t.id),t);
}
function snapshot(){
  return {version:1,history:gate.history.slice(-5000),decisions:gate.decisions.slice(-5000),live:[...liveById.values()].slice(-5000),ignoredMissingActualR:gate.ignoredMissingActualR};
}
function addBootstrapDecisions(){
  let added=0;
  for(const d of bootstrapDecisions){
    if(gate.decisionById.has(d.id))continue;
    gate.decisions.push(d);gate.decisionById.set(d.id,d);added++;
  }
  return added;
}
async function loadPersistent(force=false){
  if(persistentLoaded&&!force)return true;
  if(loadInFlight)return loadInFlight;
  if(!STORE_TOKEN){lastPersistError='STATE_TOKEN_MISSING';return false}
  loadAttempted=true;
  loadInFlight=(async()=>{
    try{
      const r=await fetch(STORE_URL,{headers:{authorization:`Bearer ${STORE_TOKEN}`},cache:'no-store',signal:AbortSignal.timeout(3500)});
      if(!r.ok)throw Error('STATE_GET_'+r.status);
      const x=await r.json();
      restoreState(x);
      const bootstrapAdded=addBootstrapDecisions();
      persistentLoaded=true;lastLoad=new Date().toISOString();lastPersistError=null;
      originalLog('HUNTER_GATE_STATE_LOADED',JSON.stringify({history:gate.history.length,decisions:gate.decisions.length,live:liveById.size,bootstrapAdded,lastLoad}));
      if(bootstrapAdded)scheduleSave();
      return true;
    }catch(e){lastPersistError=String(e?.message||e);originalWarn('HUNTER_GATE_STATE_LOAD_ERR',lastPersistError);return false}
  })();
  try{return await loadInFlight}finally{loadInFlight=null}
}
async function persistNow(){
  if(!persistentLoaded||!STORE_TOKEN)return false;
  if(saving){saveAgain=true;return false}
  saving=true;
  try{
    const r=await fetch(STORE_URL,{method:'PUT',headers:{authorization:`Bearer ${STORE_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(snapshot()),signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error('STATE_PUT_'+r.status);
    lastSave=new Date().toISOString();lastPersistError=null;return true;
  }catch(e){lastPersistError=String(e?.message||e);originalWarn('HUNTER_GATE_STATE_SAVE_ERR',lastPersistError);return false}
  finally{saving=false;if(saveAgain){saveAgain=false;scheduleSave(250)}}
}
function scheduleSave(ms=1000){
  if(!persistentLoaded)return;
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;persistNow().catch(()=>{})},ms);saveTimer.unref?.();
}
addBootstrapDecisions();
const loadPromise=loadPersistent(false);
setInterval(()=>{if(!persistentLoaded)loadPersistent(false).catch(()=>{})},30000).unref();

function canonicalTrade(t){
  if(!t)return t;
  const rawId=String(t.id||'');
  if(rawId&&gate.decisionById.has(rawId))return t;
  const client=String(t.clientOrderId||'');
  if(client){
    for(const d of gate.decisions){
      if(d?.id&&safeId('mh_',d.id)===client)return {...t,id:String(d.id),ledgerId:rawId||null};
    }
  }
  return t;
}
const feeCache=new Map();
async function commissionRate(symbol){
  const c=feeCache.get(symbol);if(c&&Date.now()-c.at<300000)return c.rate;
  let rate=FALLBACK_FEE;
  try{const j=await signedGet('/fapi/v1/commissionRate',{symbol}),x=Number(j?.takerCommissionRate);if(Number.isFinite(x)&&x>=0)rate=x}catch(e){originalWarn('HUNTER_GATE_FEE_FALLBACK',JSON.stringify({symbol,error:String(e?.message||e)}))}
  feeCache.set(symbol,{rate,at:Date.now()});return rate;
}
const riskRecoveryAttempt=new Map();
function expectedSlClient(t){
  const id=String(t.id||'');
  if(id&&id.startsWith('hunter_'))return safeId('mhsl_',id);
  const c=String(t.clientOrderId||'');
  if(c.startsWith('mh_'))return('mhsl_'+c.slice(3)).slice(0,36);
  return '';
}
async function recoverActualR(raw){
  let t=canonicalTrade(raw);
  if(hasFiniteActualR(t))return t;
  if(String(t?.status)!=='CLOSED')return t;
  const net=finite(t?.netPnl),qty=finite(t?.qty),entry=finite(t?.avgPrice),symbol=String(t?.symbol||''),opened=Date.parse(t?.openedAt||0);
  if(net===null||qty===null||!(qty>0)||entry===null||!(entry>0)||!symbol||!Number.isFinite(opened)||opened<=0)return t;
  const k=String(t.id||t.clientOrderId||symbol+'_'+opened),last=riskRecoveryAttempt.get(k)||0;
  if(Date.now()-last<10*60*1000)return t;
  riskRecoveryAttempt.set(k,Date.now());
  try{
    const start=Math.max(0,opened-60000),end=Math.min(Date.now(),opened+6*60*60*1000);
    const rows=await signedGet('/fapi/v1/allAlgoOrders',{symbol,startTime:start,endTime:end,limit:1000});
    const expected=expectedSlClient(t);
    const arr=Array.isArray(rows)?rows:(Array.isArray(rows?.orders)?rows.orders:[]);
    let slOrder=arr.find(o=>String(o.clientAlgoId||o.clientOrderId||'')===expected);
    if(!slOrder&&String(t.clientOrderId||'').startsWith('mh_')){
      const hash=String(t.clientOrderId).slice(3,34);
      slOrder=arr.find(o=>{const c=String(o.clientAlgoId||o.clientOrderId||'');return c.startsWith('mhsl_')&&c.slice(5)===hash});
    }
    if(!slOrder)return t;
    const sl=finite(slOrder.triggerPrice??slOrder.stopPrice??slOrder.price);
    if(sl===null||!(sl>0)||sl===entry)return t;
    const fee=await commissionRate(symbol),lossPerUnit=Math.abs(entry-sl)+(entry+sl)*(fee+SLIP_SIDE),risk=qty*lossPerUnit;
    if(!(risk>0))return t;
    const actualR=net/risk;
    originalLog('HUNTER_GATE_ACTUAL_R_RECOVERED',JSON.stringify({id:t.id,ledgerId:t.ledgerId||null,symbol,actualRisk:risk,actualR,source:'BINANCE_ALGO_SL'}));
    return {...t,sl,actualRisk:risk,actualR,riskRecovery:'BINANCE_ALGO_SL'};
  }catch(e){originalWarn('HUNTER_GATE_ACTUAL_R_RECOVERY_ERR',JSON.stringify({id:t?.id,symbol,error:String(e?.message||e)}));return t}
}

async function onExecuted(x){
  await loadPersistent(false);
  const id=String(x?.id||'');if(!id)return;
  const old=liveById.get(id)||{};
  const c={...old,id,symbol:x.symbol||old.symbol,side:x.side||old.side,qty:x.qty??old.qty,avgPrice:x.avgPrice??old.avgPrice,actualRisk:x.actualRisk??old.actualRisk,netRR:x.netRR??old.netRR,leverage:x.lev??x.leverage??old.leverage,openedAt:old.openedAt||new Date().toISOString()};
  liveById.set(id,c);
  const d=gate.scoreCandidate(c);
  originalLog('HUNTER_LIVE_GATE_SHADOW_DECISION',JSON.stringify({id,...d,source:old.id?'PRE_EXECUTION_OBSERVATION':'EXECUTION_FALLBACK'}));
  scheduleSave();
}
async function onClosed(x){
  await loadPersistent(false);
  const id=String(x?.id||'');if(!id)return;
  const old=liveById.get(id)||{};
  const risk=finite(old.actualRisk);
  const net=finite(x?.stats?.net);
  const supplied=finite(x?.stats?.actualR);
  const actualR=supplied!==null?supplied:(risk!==null&&risk>0&&net!==null?net/risk:null);
  const t={...old,id,symbol:x.symbol||old.symbol,actualRisk:risk,actualR,netPnl:net,closedAt:new Date().toISOString()};
  if(gate.ingestClosedTrade(t)){
    liveById.delete(id);
    originalLog('HUNTER_LIVE_GATE_INGESTED',JSON.stringify({id,symbol:t.symbol,side:t.side,regime:t.regime,actualR:t.actualR,netPnl:t.netPnl,forwardMatched:Boolean(gate.decisionById.get(id))}));
    scheduleSave();
  }
}
console.log=(...args)=>{
  try{
    const e=parse('ONETAP_LIVE_EXECUTED',args);if(e)queueMicrotask(()=>onExecuted(e).catch(err=>originalError('HUNTER_LIVE_GATE_ERR',String(err?.message||err))));
    const c=parse('ONETAP_POSITION_CLOSED',args);if(c)queueMicrotask(()=>onClosed(c).catch(err=>originalError('HUNTER_LIVE_GATE_ERR',String(err?.message||err))));
  }catch(e){originalError('HUNTER_LIVE_GATE_ERR',String(e?.message||e))}
  return originalLog(...args);
};

const orig=http.createServer;
http.createServer=function(...args){
  const listener=args[0];
  if(typeof listener==='function'){
    args[0]=async function(req,res){
      const path=String(req.url||'').split('?')[0];
      if(req.method==='GET'&&path==='/hunter-live-gate/report'){
        await loadPersistent(false);
        return json(res,200,{ok:true,...gate.report(),persistence:{configured:Boolean(STORE_TOKEN),loaded:persistentLoaded,loadAttempted,lastLoad,lastSave,lastError:lastPersistError,store:'INTERNAL_PERSISTENT_VOLUME'},riskRecovery:{source:'BINANCE_ALGO_SL',batch:MAX_RISK_RECOVER_PER_BACKFILL}});
      }
      if(req.method==='POST'&&path==='/hunter-live-gate/observe-candidate'){
        try{
          await loadPersistent(false);
          const c=await readJson(req),id=String(c?.id||'');
          if(!id)return json(res,400,{ok:false,error:'MISSING_ID'});
          liveById.set(id,{...(liveById.get(id)||{}),...c,id,observedAt:new Date().toISOString()});
          const d=gate.scoreCandidate(liveById.get(id));
          originalLog('HUNTER_LIVE_GATE_PRE_EXECUTION_DECISION',JSON.stringify(d));
          scheduleSave();
          return json(res,200,{ok:true,decision:d,observationalOnly:true,liveExecutionChanged:false});
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
    await loadPersistent(false);
    const r=await fetch(`http://127.0.0.1:${PORT}/real-money/positions`,{cache:'no-store',signal:AbortSignal.timeout(6000)});
    if(!r.ok)throw Error('REAL_MONEY_'+r.status);
    const j=await r.json(),xs=Array.isArray(j.trades)?j.trades:[];
    let added=0,recoveredRisk=0,skippedMissingActualR=0,recoveryBudget=MAX_RISK_RECOVER_PER_BACKFILL;
    for(const raw of xs){
      if(raw.status!=='CLOSED')continue;
      let t=canonicalTrade(raw);
      if(gate.seenClosed.has(String(t?.id||'')))continue;
      if(!hasFiniteActualR(t)&&recoveryBudget>0){const before=hasFiniteActualR(t);t=await recoverActualR(t);recoveryBudget--;if(!before&&hasFiniteActualR(t))recoveredRisk++}
      if(!hasFiniteActualR(t)){skippedMissingActualR++;continue}
      if(gate.ingestClosedTrade(t))added++;
    }
    lastBackfill=new Date().toISOString();
    originalLog('HUNTER_LIVE_GATE_BACKFILL',JSON.stringify({source:'REAL_MONEY_LEDGER',seen:xs.length,added,recoveredRisk,skippedMissingActualR,totalClosed:gate.history.length,lastBackfill}));
    if(added)scheduleSave();
  }catch(e){originalWarn('HUNTER_LIVE_GATE_BACKFILL_ERR',String(e?.message||e))}
  finally{backfilling=false}
}

setTimeout(backfill,10000).unref();
setInterval(backfill,60000).unref();
originalLog('HUNTER_LIVE_GATE_V1_READY',JSON.stringify({mode:'OBSERVATIONAL_ONLY',report:'/hunter-live-gate/report',observe:'/hunter-live-gate/observe-candidate',backfill:'/real-money/positions',persistence:'INTERNAL_PERSISTENT_VOLUME',riskRecovery:'BINANCE_ALGO_SL',liveExecutionChanged:false}));

module.exports={gate,backfill,hasFiniteActualR,loadPersistent,persistNow,recoverActualR,canonicalTrade,safeId};
