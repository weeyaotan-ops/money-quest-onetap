'use strict';

const http = require('node:http');

const PORT = Number(process.env.PORT || 8000);
const UPSTREAM = process.env.V2_UPSTREAM || 'https://crypto-signal-publisher-production.up.railway.app/ingest';
const BINANCE = (process.env.BINANCE_PUBLIC_REST || 'https://fapi.binance.com').replace(/\/$/, '');
const MAX_OPEN = Math.max(1, Number(process.env.SHADOW_MAX_OPEN || 8));
const TTL_MS = Math.max(30000, Number(process.env.SHADOW_ENTRY_TTL_MS || 90000));
const RISK_PCT = Number(process.env.SHADOW_RISK_PCT || 1);
const ENTRY_FEE_BPS = Number(process.env.SHADOW_ENTRY_FEE_BPS || 2);
const EXIT_FEE_BPS = Number(process.env.SHADOW_EXIT_FEE_BPS || 5);
const EXIT_SLIPPAGE_BPS = Number(process.env.SHADOW_EXIT_SLIPPAGE_BPS || 1);
const RANGE_FRICTION_BPS = Number(process.env.RANGE_FRICTION_BPS || (ENTRY_FEE_BPS + EXIT_FEE_BPS + EXIT_SLIPPAGE_BPS));
const RANGE_MAX_FRICTION_R = Number(process.env.RANGE_MAX_FRICTION_R || 0.15);
const RANGE_MIN_NET_RR = Number(process.env.RANGE_MIN_NET_RR || 1.5);
const START_BALANCE = Number(process.env.SHADOW_START_BALANCE || 1000);
const STARTED_MS = Date.now();

const state = {
  startedAt: new Date(STARTED_MS).toISOString(),
  sourceSeen: new Set(), processed: new Set(), costPass: new Set(), costRejected: new Set(), preCutoff: new Set(),
  shadowSeen: new Set(), blockedSymbol: 0, blockedCapacity: 0, pending: new Map(), open: new Map(), closed: [], recent: [], errors: [],
  balance: START_BALANCE, peak: START_BALANCE, maxDD: 0, meta: new Map(), metaAt: 0,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
function json(res, code, body){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(body));}
function log(event,data={}){const row={ts:new Date().toISOString(),event,...data};state.recent.unshift(row);if(state.recent.length>100)state.recent.length=100;console.log('MIRROR_VALIDATION_V4',JSON.stringify(row));}
function fail(where,e){const row={ts:Date.now(),where,error:String(e?.message||e)};state.errors.push(row);state.errors=state.errors.filter(x=>Date.now()-x.ts<86400000);console.error('MIRROR_VALIDATION_V4_ERR',JSON.stringify(row));}
function findTickets(x){if(Array.isArray(x))return x;if(!x||typeof x!=='object')return[];for(const k of ['tickets','signals','data','items','open']){if(Array.isArray(x[k]))return x[k];if(x[k]&&typeof x[k]==='object'){const a=findTickets(x[k]);if(a.length)return a;}}if(x.id&&x.side&&(x.symbol||x.instId))return[x];return[];}
function norm(t){const raw=String(t.binanceSymbol||t.instId||t.symbol||t.asset||'').toUpperCase().replace(/[-_/]/g,'');const base=raw.replace(/USDTSWAP$/,'').replace(/USDTPERP$/,'').replace(/USDT$/,'');return base?`${base}USDT`:'';}
function decimals(step){const s=String(step);if(s.includes('e-'))return Number(s.split('e-')[1]);return Math.max(0,(s.split('.')[1]||'').replace(/0+$/,'').length);}
function roundStep(v,step){const n=Number(v),s=Number(step);if(!Number.isFinite(n)||!Number.isFinite(s)||s<=0)return n;return Number((Math.round(n/s)*s).toFixed(decimals(step)));}

function costGate(t){
  if(String(t?.setup||'')!=='RANGE_MEAN_REVERSION') return {pass:true,reason:'NON_RANGE'};
  const entry=Number(t.entry), sl=Number(t.sl), tp=Number(t.tp), side=String(t.side||'').toUpperCase();
  if(![entry,sl,tp].every(Number.isFinite)||!(entry>0)) return {pass:false,reason:'INVALID_PRICES'};
  if(side==='BUY'&&!(sl<entry&&tp>entry)) return {pass:false,reason:'INVALID_BUY_LEVELS'};
  if(side==='SELL'&&!(sl>entry&&tp<entry)) return {pass:false,reason:'INVALID_SELL_LEVELS'};
  if(!['BUY','SELL'].includes(side)) return {pass:false,reason:'INVALID_SIDE'};
  const riskBps=Math.abs(entry-sl)/entry*10000;
  const rewardBps=Math.abs(tp-entry)/entry*10000;
  if(!(riskBps>0&&rewardBps>0)) return {pass:false,reason:'ZERO_DISTANCE',riskBps,rewardBps};
  const frictionR=RANGE_FRICTION_BPS/riskBps;
  const netRR=(rewardBps-RANGE_FRICTION_BPS)/(riskBps+RANGE_FRICTION_BPS);
  if(frictionR>RANGE_MAX_FRICTION_R) return {pass:false,reason:'COST_TOO_LARGE_VS_STOP',riskBps,rewardBps,frictionBps:RANGE_FRICTION_BPS,frictionR,netRR};
  if(!(netRR>=RANGE_MIN_NET_RR)) return {pass:false,reason:'NET_RR_TOO_LOW',riskBps,rewardBps,frictionBps:RANGE_FRICTION_BPS,frictionR,netRR};
  return {pass:true,reason:'PASS',riskBps,rewardBps,frictionBps:RANGE_FRICTION_BPS,frictionR,netRR};
}

function applyForwardGate(payload){
  const tickets=findTickets(payload);
  for(const t of tickets){
    if(t?.combinedSelected!==true||!t?.id) continue;
    const id=String(t.id); state.sourceSeen.add(id);
    const opened=Date.parse(t.openedAt||0);
    if(opened>0&&opened<STARTED_MS){
      t.combinedSelected=false; t.costAwareRejected=true; t.costAwareReason='PRE_CUTOFF';
      if(!state.preCutoff.has(id)){state.preCutoff.add(id);state.processed.add(id);log('COST_GATE_PRE_CUTOFF',{id,symbol:norm(t)});} continue;
    }
    if(state.costRejected.has(id)){t.combinedSelected=false;t.costAwareRejected=true;t.costAwareReason='CACHED_REJECT';continue;}
    if(state.costPass.has(id)){t.costAwareGate='PASS';continue;}
    const g=costGate(t); state.processed.add(id);
    if(!g.pass){
      state.costRejected.add(id);t.combinedSelected=false;t.costAwareRejected=true;t.costAwareReason=g.reason;
      console.log('COST_AWARE_RANGE_REJECT',JSON.stringify({id,symbol:norm(t),setup:t.setup,...g}));
      log('COST_GATE_REJECT',{id,symbol:norm(t),reason:g.reason,riskBps:g.riskBps,frictionR:g.frictionR,netRR:g.netRR});
    } else {
      state.costPass.add(id);t.costAwareGate='PASS';
      if(g.riskBps!=null){t.costAwareRiskBps=g.riskBps;t.costAwareFrictionR=g.frictionR;t.costAwareNetRR=g.netRR;}
      log('COST_GATE_PASS',{id,symbol:norm(t),setup:t.setup,riskBps:g.riskBps,frictionR:g.frictionR,netRR:g.netRR});
    }
  }
  return payload;
}

async function refreshMeta(force=false){if(!force&&state.meta.size&&Date.now()-state.metaAt<300000)return;const r=await fetch(`${BINANCE}/fapi/v1/exchangeInfo`);if(!r.ok)throw new Error(`exchangeInfo_${r.status}`);const j=await r.json(),m=new Map();for(const x of j.symbols||[]){if(x.status!=='TRADING'||x.contractType!=='PERPETUAL'||x.quoteAsset!=='USDT')continue;const pf=(x.filters||[]).find(f=>f.filterType==='PRICE_FILTER')||{};if(pf.tickSize)m.set(x.symbol,{tickSize:Number(pf.tickSize)});}state.meta=m;state.metaAt=Date.now();}
async function book(symbol){const r=await fetch(`${BINANCE}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);if(!r.ok)throw new Error(`book_${symbol}_${r.status}`);const x=await r.json();return{bid:Number(x.bidPrice),ask:Number(x.askPrice)};}
async function last(symbol){const r=await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`);if(!r.ok)throw new Error(`price_${symbol}_${r.status}`);const x=await r.json();return Number(x.price);}
function hasSymbol(symbol){for(const x of state.pending.values())if(x.symbol===symbol)return true;for(const x of state.open.values())if(x.symbol===symbol)return true;return false;}
async function track(t){
  if(t?.combinedSelected!==true||!t?.id)return;
  const id=String(t.id);if(state.shadowSeen.has(id))return;state.shadowSeen.add(id);
  const symbol=norm(t);if(!symbol)return;
  if(hasSymbol(symbol)){state.blockedSymbol++;log('BLOCK_SYMBOL',{id,symbol});return;}
  if(state.pending.size+state.open.size>=MAX_OPEN){state.blockedCapacity++;log('BLOCK_CAPACITY',{id,symbol,maxOpen:MAX_OPEN});return;}
  await refreshMeta();const meta=state.meta.get(symbol);if(!meta){log('BLOCK_UNSUPPORTED',{id,symbol});return;}
  const side=String(t.side||'').toUpperCase();const entry=roundStep(Number(t.entry),meta.tickSize),sl=roundStep(Number(t.sl),meta.tickSize),tp=roundStep(Number(t.tp),meta.tickSize);
  if(![entry,sl,tp].every(Number.isFinite))return;if(side==='BUY'&&!(sl<entry&&tp>entry))return;if(side==='SELL'&&!(sl>entry&&tp<entry))return;
  state.pending.set(id,{id,symbol,side,setup:String(t.setup||''),entry,sl,tp,receivedAt:Date.now(),expiresAt:Date.now()+TTL_MS});
  log('SHADOW_PENDING',{id,symbol,side,entry,sl,tp});
}
async function ingestFiltered(payload){for(const t of findTickets(payload).filter(x=>x?.combinedSelected===true&&x?.id))await track(t);}

function closeShadow(x,reason){
  const dist=Math.abs(x.entry-x.sl);if(!(dist>0))return;
  const slip=EXIT_SLIPPAGE_BPS/10000;const exit=reason==='TP'?(x.side==='BUY'?x.tp*(1-slip):x.tp*(1+slip)):(x.side==='BUY'?x.sl*(1-slip):x.sl*(1+slip));
  const grossR=x.side==='BUY'?(exit-x.entry)/dist:(x.entry-exit)/dist;
  const feeR=((x.entry*ENTRY_FEE_BPS/10000)+(Math.abs(exit)*EXIT_FEE_BPS/10000))/dist;
  const netR=grossR-feeR;const row={...x,closedAt:Date.now(),reason,grossR,feeR,netR};
  state.closed.push(row);state.open.delete(x.id);state.balance*=1+(RISK_PCT/100)*netR;state.peak=Math.max(state.peak,state.balance);state.maxDD=Math.max(state.maxDD,state.peak>0?(state.peak-state.balance)/state.peak*100:0);
  log('SHADOW_CLOSED',{id:x.id,symbol:x.symbol,reason,netR:Number(netR.toFixed(3))});
}
async function poll(){while(true){try{const now=Date.now();for(const[id,x]of[...state.pending]){if(now>x.expiresAt){state.pending.delete(id);log('SHADOW_NO_FILL',{id,symbol:x.symbol});continue;}try{const b=await book(x.symbol);const fill=x.side==='BUY'?b.ask<=x.entry:b.bid>=x.entry;if(fill){state.pending.delete(id);state.open.set(id,{...x,filledAt:Date.now()});log('SHADOW_FILLED',{id,symbol:x.symbol,entry:x.entry});}}catch(e){fail('pending:'+x.symbol,e);}}for(const[id,x]of[...state.open]){try{const p=await last(x.symbol);if(!Number.isFinite(p))continue;if(x.side==='BUY'){if(p<=x.sl)closeShadow(x,'SL');else if(p>=x.tp)closeShadow(x,'TP');}else{if(p>=x.sl)closeShadow(x,'SL');else if(p<=x.tp)closeShadow(x,'TP');}}catch(e){fail('open:'+x.symbol,e);}}}catch(e){fail('poll',e);}await sleep(1000);}}

function metrics(){
  const c=state.closed,w=c.filter(x=>x.netR>0).length,l=c.filter(x=>x.netR<0).length,net=c.reduce((a,x)=>a+x.netR,0),pos=c.filter(x=>x.netR>0).reduce((a,x)=>a+x.netR,0),neg=Math.abs(c.filter(x=>x.netR<0).reduce((a,x)=>a+x.netR,0));
  const expectancy=c.length?net/c.length:null,pf=neg>0?pos/neg:(pos>0?99:null),range=c.filter(x=>x.setup==='RANGE_MEAN_REVERSION'),rangeExp=range.length?range.reduce((a,x)=>a+x.netR,0)/range.length:null;
  const processedPct=state.sourceSeen.size?state.processed.size/state.sourceSeen.size*100:null,errors24h=state.errors.filter(x=>Date.now()-x.ts<86400000).length;
  const gates={matchedTrades:c.length>=50,sync95:processedPct!==null&&processedPct>=95,netExpectancy:expectancy!==null&&expectancy>0.10,profitFactor:pf!==null&&pf>1.15,maxDD:state.maxDD<10,errors24h:errors24h===0,rangePositive:rangeExp!==null&&rangeExp>0,costGateActive:true};
  const ready=Object.values(gates).every(Boolean);
  return{status:ready?'READY':'WATCH',liveTrading:false,version:'COST_AWARE_RANGE_V1',startedAt:state.startedAt,matchedTrades:c.length,wins:w,losses:l,winRate:c.length?w/c.length*100:null,netR:net,expectancy,profitFactor:pf,maxDDPct:state.maxDD,shadowBalance:state.balance,shadowPending:state.pending.size,shadowOpen:state.open.size,maxOpen:MAX_OPEN,ticketSyncPct:processedPct,sourceSeen:state.sourceSeen.size,costPass:state.costPass.size,costRejected:state.costRejected.size,preCutoff:state.preCutoff.size,costPassRate:(state.costPass.size+state.costRejected.size)?state.costPass.size/(state.costPass.size+state.costRejected.size)*100:null,rangeClosed:range.length,rangeExpectancy:rangeExp,errors24h,blockedSymbol:state.blockedSymbol,blockedCapacity:state.blockedCapacity,gates,recent:state.recent.slice(0,30),recentClosed:c.slice(-30).reverse().map(x=>({symbol:x.symbol,reason:x.reason,setup:x.setup,netR:x.netR})),costModel:{frictionBps:RANGE_FRICTION_BPS,maxFrictionR:RANGE_MAX_FRICTION_R,minNetRR:RANGE_MIN_NET_RR}};
}

function page(){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cost-Aware Mirror Validation</title><style>:root{color-scheme:dark}body{margin:0;background:#09111b;color:#eef4ff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}.wrap{max-width:1050px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.muted{color:#8ea0b7;font-size:12px}.badge{padding:9px 13px;border-radius:999px;background:#473711;font-weight:800}.ready{background:#143d2b}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.card{background:#111d2b;border:1px solid #24354a;border-radius:16px;padding:14px}.v{font-size:23px;font-weight:800;margin-top:4px}.gate{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #24354a}.ok{color:#6ee7a8}.wait{color:#ffc46b}.row{display:grid;grid-template-columns:90px 70px 1fr 70px;gap:8px;padding:9px 0;border-bottom:1px solid #24354a;font-size:12px}@media(min-width:760px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}h1{font-size:24px;margin:3px 0}h2{font-size:16px;margin-top:20px}</style></head><body><div class="wrap"><div class="top"><div><div class="muted">MONEY HUNTER · COST-AWARE RANGE V1</div><h1>LIVE MIRROR VALIDATION</h1><div class="muted">Fresh forward round · Real money OFF</div></div><div id="st" class="badge">WATCH</div></div><div class="grid" id="cards"></div><h2>GO / NO-GO gates</h2><div class="card" id="gates"></div><h2>Recent shadow closes</h2><div class="card"><div id="rows" class="muted">Waiting for closed trades…</div></div><h2>Cost filter</h2><div class="card muted">RANGE_MEAN_REVERSION only: estimated round-trip friction ${RANGE_FRICTION_BPS.toFixed(1)} bps, friction must be ≤ ${(RANGE_MAX_FRICTION_R*100).toFixed(0)}% of 1R, and estimated net RR must be ≥ ${RANGE_MIN_NET_RR.toFixed(2)}. Other setups are unchanged.</div></div><script>const f=(x,d=2)=>x==null?'—':Number(x).toFixed(d);async function tick(){try{const r=await fetch('/validation.json?ts='+Date.now(),{cache:'no-store'});const x=await r.json();const st=document.getElementById('st');st.textContent=x.status;st.className='badge '+(x.status==='READY'?'ready':'');const cards=[['Matched',x.matchedTrades],['Ticket sync',x.ticketSyncPct==null?'—':f(x.ticketSyncPct,1)+'%'],['Net expectancy',x.expectancy==null?'—':f(x.expectancy,3)+'R'],['Profit factor',f(x.profitFactor,2)],['Max DD',f(x.maxDDPct,2)+'%'],['Range exp.',x.rangeExpectancy==null?'—':f(x.rangeExpectancy,3)+'R'],['Cost rejected',x.costRejected],['Shadow balance','$'+f(x.shadowBalance,2)]];document.getElementById('cards').innerHTML=cards.map(([a,b])=>'<div class="card"><div class="muted">'+a+'</div><div class="v">'+b+'</div></div>').join('');document.getElementById('gates').innerHTML=Object.entries(x.gates).map(([k,v])=>'<div class="gate"><span>'+k+'</span><b class="'+(v?'ok':'wait')+'">'+(v?'PASS':'WAIT')+'</b></div>').join('');document.getElementById('rows').innerHTML=x.recentClosed.length?x.recentClosed.map(z=>'<div class="row"><b>'+z.symbol+'</b><span>'+z.reason+'</span><span>'+z.setup+'</span><span>'+f(z.netR,2)+'R</span></div>').join(''):'Waiting for closed trades…';}catch(e){document.getElementById('st').textContent='OFFLINE'}}tick();setInterval(tick,2000);</script></body></html>`;}

function selfTest(){
  const bad=costGate({setup:'RANGE_MEAN_REVERSION',side:'BUY',entry:100,sl:99.9,tp:100.2});
  const good=costGate({setup:'RANGE_MEAN_REVERSION',side:'BUY',entry:100,sl:99,tp:102});
  const other=costGate({setup:'TREND_PULLBACK',side:'BUY',entry:100,sl:99.9,tp:100.2});
  if(bad.pass||!good.pass||!other.pass)throw new Error('COST_GATE_SELFTEST_FAIL');
  console.log('COST_AWARE_RANGE_SELFTEST_PASS',JSON.stringify({frictionBps:RANGE_FRICTION_BPS,maxFrictionR:RANGE_MAX_FRICTION_R,minNetRR:RANGE_MIN_NET_RR}));
}

const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url||'/','http://localhost');const path=u.pathname.replace(/\/+$/,'')||'/';if(req.method==='GET'&&path==='/validation.json')return json(res,200,metrics());if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,service:'cost-aware-shadow-validator-v4',status:metrics().status,live:false});if(req.method==='POST'&&path==='/ingest'){const chunks=[];for await(const c of req)chunks.push(c);let payload=null;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}if(!payload)return json(res,400,{ok:false,error:'bad_json'});const filtered=applyForwardGate(payload);await ingestFiltered(filtered);let upstreamStatus=null;try{const r=await fetch(UPSTREAM,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(filtered)});upstreamStatus=r.status}catch(e){fail('forward',e)}return json(res,200,{ok:true,validator:true,costAware:true,upstreamStatus});}if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(page());}return json(res,404,{ok:false,error:'not_found'});}catch(e){fail('server',e);return json(res,500,{ok:false,error:String(e?.message||e)});}});

selfTest();poll().catch(e=>fail('pollFatal',e));server.listen(PORT,'0.0.0.0',()=>console.log('COST_AWARE_SHADOW_VALIDATOR_V4_READY',JSON.stringify({port:PORT,maxOpen:MAX_OPEN,live:false,frictionBps:RANGE_FRICTION_BPS,maxFrictionR:RANGE_MAX_FRICTION_R,minNetRR:RANGE_MIN_NET_RR})));
