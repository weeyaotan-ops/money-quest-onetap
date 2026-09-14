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
const SLIPPAGE_BPS = Number(process.env.SHADOW_EXIT_SLIPPAGE_BPS || 1);
const START_BALANCE = Number(process.env.SHADOW_START_BALANCE || 1000);

const state = {
  startedAt: new Date().toISOString(), seen: new Set(), accepted: 0,
  blockedSymbol: 0, blockedCapacity: 0, pending: new Map(), open: new Map(),
  closed: [], recent: [], sourceOpen: new Set(), prevSourceOpen: new Set(),
  sourceBalance: null, prevSourceBalance: null, sourceRById: new Map(), errors: [],
  balance: START_BALANCE, peak: START_BALANCE, maxDD: 0, meta: new Map(), metaAt: 0,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (res, code, body) => {
  res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(JSON.stringify(body));
};
function recent(event, data={}) {
  const row = {ts:new Date().toISOString(), event, ...data};
  state.recent.unshift(row); if (state.recent.length > 80) state.recent.length = 80;
  console.log('MIRROR_VALIDATION_V3', JSON.stringify(row));
}
function err(where, e) {
  const row={ts:Date.now(),where,error:String(e?.message||e)};
  state.errors.push(row); state.errors=state.errors.filter(x=>Date.now()-x.ts<86400000);
  console.error('MIRROR_VALIDATION_V3_ERR',JSON.stringify(row));
}
function findTickets(x){
  if(Array.isArray(x)) return x;
  if(!x||typeof x!=='object') return [];
  for(const k of ['tickets','signals','data','items','open']){
    if(Array.isArray(x[k])) return x[k];
    if(x[k]&&typeof x[k]==='object'){const a=findTickets(x[k]);if(a.length)return a;}
  }
  if(x.id&&x.side&&(x.symbol||x.instId)) return [x];
  return [];
}
function findCombinedBalance(x,d=0){
  if(!x||typeof x!=='object'||d>6)return null;
  if(Number.isFinite(Number(x.combinedBalance))) return Number(x.combinedBalance);
  for(const v of Object.values(x)){if(v&&typeof v==='object'){const b=findCombinedBalance(v,d+1);if(Number.isFinite(b))return b;}}
  return null;
}
function norm(t){
  const raw=String(t.binanceSymbol||t.instId||t.symbol||t.asset||'').toUpperCase().replace(/[-_/]/g,'');
  const base=raw.replace(/USDTSWAP$/,'').replace(/USDTPERP$/,'').replace(/USDT$/,'');
  return base?`${base}USDT`:'';
}
function decimals(step){const s=String(step);if(s.includes('e-'))return Number(s.split('e-')[1]);return Math.max(0,(s.split('.')[1]||'').replace(/0+$/,'').length);}
function roundStep(v,step){const n=Number(v),s=Number(step);if(!Number.isFinite(n)||!Number.isFinite(s)||s<=0)return n;return Number((Math.round(n/s)*s).toFixed(decimals(step)));}
async function refreshMeta(force=false){
  if(!force&&state.meta.size&&Date.now()-state.metaAt<300000)return;
  const r=await fetch(`${BINANCE}/fapi/v1/exchangeInfo`); if(!r.ok)throw new Error(`exchangeInfo_${r.status}`);
  const j=await r.json(),m=new Map();
  for(const x of j.symbols||[]){
    if(x.status!=='TRADING'||x.contractType!=='PERPETUAL'||x.quoteAsset!=='USDT')continue;
    const pf=(x.filters||[]).find(f=>f.filterType==='PRICE_FILTER')||{};
    if(pf.tickSize)m.set(x.symbol,{tickSize:Number(pf.tickSize)});
  }
  state.meta=m;state.metaAt=Date.now();
}
async function book(symbol){const r=await fetch(`${BINANCE}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);if(!r.ok)throw new Error(`book_${symbol}_${r.status}`);const x=await r.json();return{bid:Number(x.bidPrice),ask:Number(x.askPrice)};}
async function last(symbol){const r=await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`);if(!r.ok)throw new Error(`price_${symbol}_${r.status}`);const x=await r.json();return Number(x.price);}
function hasSymbol(symbol){for(const x of state.pending.values())if(x.symbol===symbol)return true;for(const x of state.open.values())if(x.symbol===symbol)return true;return false;}
async function track(t){
  if(t?.combinedSelected!==true)return;
  const id=String(t.id||''); if(!id||state.seen.has(id))return; state.seen.add(id);
  const opened=Date.parse(t.openedAt||0); if(opened>0&&Date.now()-opened>120000){recent('STALE_IGNORED',{id});return;}
  const symbol=norm(t); if(!symbol)return;
  if(hasSymbol(symbol)){state.blockedSymbol++;recent('BLOCK_SYMBOL',{id,symbol});return;}
  if(state.pending.size+state.open.size>=MAX_OPEN){state.blockedCapacity++;recent('BLOCK_CAPACITY',{id,symbol,maxOpen:MAX_OPEN});return;}
  await refreshMeta(); const meta=state.meta.get(symbol); if(!meta){recent('BLOCK_UNSUPPORTED',{id,symbol});return;}
  const side=String(t.side||'').toUpperCase(); const entry=roundStep(Number(t.entry),meta.tickSize),sl=roundStep(Number(t.sl),meta.tickSize),tp=roundStep(Number(t.tp),meta.tickSize);
  if(![entry,sl,tp].every(Number.isFinite))return;
  if(side==='BUY'&&!(sl<entry&&tp>entry))return; if(side==='SELL'&&!(sl>entry&&tp<entry))return;
  state.pending.set(id,{id,symbol,side,setup:String(t.setup||''),entry,sl,tp,receivedAt:Date.now(),expiresAt:Date.now()+TTL_MS,sourceOpenedAt:t.openedAt||null});
  state.accepted++;recent('SHADOW_PENDING',{id,symbol,side,entry,sl,tp});
}
function inferSource(newIds,newBal){
  const dropped=[...state.prevSourceOpen].filter(id=>!newIds.has(id));
  if(dropped.length===1&&Number.isFinite(state.prevSourceBalance)&&Number.isFinite(newBal)&&state.prevSourceBalance>0){
    const raw=((newBal/state.prevSourceBalance)-1)/(RISK_PCT/100); const cand=[-1,2,2.1,2.2]; let best=cand[0];
    for(const c of cand)if(Math.abs(raw-c)<Math.abs(raw-best))best=c;
    if(Math.abs(raw-best)<=0.35){state.sourceRById.set(dropped[0],best);recent('SOURCE_CLOSED_INFERRED',{id:dropped[0],sourceR:best,rawR:Number(raw.toFixed(3))});}
  }
}
async function ingest(payload){
  const tickets=findTickets(payload); const selected=tickets.filter(t=>t?.combinedSelected===true&&t?.id); const ids=new Set(selected.map(t=>String(t.id))); const bal=findCombinedBalance(payload);
  inferSource(ids,bal); state.prevSourceOpen=state.sourceOpen; state.sourceOpen=ids; state.prevSourceBalance=state.sourceBalance; if(Number.isFinite(bal))state.sourceBalance=bal;
  for(const t of selected)await track(t);
}
function closeShadow(x,reason){
  const dist=Math.abs(x.entry-x.sl);if(!(dist>0))return;
  const slip=SLIPPAGE_BPS/10000; let exit;
  if(reason==='TP') exit=x.side==='BUY'?x.tp*(1-slip):x.tp*(1+slip); else exit=x.side==='BUY'?x.sl*(1-slip):x.sl*(1+slip);
  const gross=x.side==='BUY'?(exit-x.entry)/dist:(x.entry-exit)/dist;
  const fee=((x.entry*ENTRY_FEE_BPS/10000)+(Math.abs(exit)*EXIT_FEE_BPS/10000))/dist;
  const netR=gross-fee,sourceR=state.sourceRById.get(x.id);
  const row={...x,closedAt:Date.now(),reason,grossR:gross,feeR:fee,netR,sourceR:Number.isFinite(sourceR)?sourceR:null,sourceOutcomeMatch:Number.isFinite(sourceR)?Math.sign(sourceR)===Math.sign(netR):null};
  state.closed.push(row);state.open.delete(x.id);state.balance*=1+(RISK_PCT/100)*netR;state.peak=Math.max(state.peak,state.balance);state.maxDD=Math.max(state.maxDD,state.peak>0?(state.peak-state.balance)/state.peak*100:0);
  recent('SHADOW_CLOSED',{id:x.id,symbol:x.symbol,reason,netR:Number(netR.toFixed(3)),sourceR:row.sourceR});
}
async function poll(){
  while(true){
    try{
      const now=Date.now();
      for(const[id,x]of[...state.pending]){
        if(now>x.expiresAt){state.pending.delete(id);recent('SHADOW_NO_FILL',{id,symbol:x.symbol});continue;}
        try{const b=await book(x.symbol);const fill=x.side==='BUY'?b.ask<=x.entry:b.bid>=x.entry;if(fill){state.pending.delete(id);state.open.set(id,{...x,filledAt:Date.now(),fillPrice:x.entry});recent('SHADOW_FILLED',{id,symbol:x.symbol,entry:x.entry});}}catch(e){err('pending:'+x.symbol,e);}
      }
      for(const[id,x]of[...state.open]){
        try{const p=await last(x.symbol);if(!Number.isFinite(p))continue;if(x.side==='BUY'){if(p<=x.sl)closeShadow(x,'SL');else if(p>=x.tp)closeShadow(x,'TP');}else{if(p>=x.sl)closeShadow(x,'SL');else if(p<=x.tp)closeShadow(x,'TP');}}catch(e){err('open:'+x.symbol,e);}
      }
    }catch(e){err('poll',e);} await sleep(1000);
  }
}
function metrics(){
  const c=state.closed,w=c.filter(x=>x.netR>0).length,l=c.filter(x=>x.netR<0).length,net=c.reduce((a,x)=>a+x.netR,0),pos=c.filter(x=>x.netR>0).reduce((a,x)=>a+x.netR,0),neg=Math.abs(c.filter(x=>x.netR<0).reduce((a,x)=>a+x.netR,0));
  const exp=c.length?net/c.length:null,pf=neg>0?pos/neg:(pos>0?99:null),range=c.filter(x=>x.setup==='RANGE_MEAN_REVERSION'),rangeExp=range.length?range.reduce((a,x)=>a+x.netR,0)/range.length:null,comp=c.filter(x=>Number.isFinite(x.sourceR)),match=comp.filter(x=>x.sourceOutcomeMatch===true).length,matchPct=comp.length?match/comp.length*100:null,sync=state.seen.size?state.accepted/state.seen.size*100:null,errors24=state.errors.filter(x=>Date.now()-x.ts<86400000).length;
  const gates={matchedTrades:c.length>=50,sync95:sync!==null&&sync>=95,netExpectancy:exp!==null&&exp>0.10,profitFactor:pf!==null&&pf>1.15,maxDD:state.maxDD<10,errors24h:errors24===0,rangePositive:rangeExp!==null&&rangeExp>0};
  const ready=Object.values(gates).every(Boolean);
  return{status:ready?'READY':'WATCH',liveTrading:false,startedAt:state.startedAt,matchedTrades:c.length,wins:w,losses:l,winRate:c.length?w/c.length*100:null,netR:net,expectancy:exp,profitFactor:pf,maxDDPct:state.maxDD,shadowBalance:state.balance,sourceBalance:state.sourceBalance,sourceOpen:state.sourceOpen.size,shadowPending:state.pending.size,shadowOpen:state.open.size,maxOpen:MAX_OPEN,seenTickets:state.seen.size,acceptedTickets:state.accepted,ticketSyncPct:sync,comparableOutcomes:comp.length,outcomeMatchPct:matchPct,rangeClosed:range.length,rangeExpectancy:rangeExp,errors24h:errors24,blockedSymbol:state.blockedSymbol,blockedCapacity:state.blockedCapacity,gates,recent:state.recent.slice(0,30),recentClosed:c.slice(-30).reverse().map(x=>({id:x.id,symbol:x.symbol,side:x.side,setup:x.setup,reason:x.reason,netR:x.netR,sourceR:x.sourceR,match:x.sourceOutcomeMatch}))};
}
function page(){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Mirror Validation</title><style>:root{color-scheme:dark}body{margin:0;background:#09111b;color:#eef4ff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}.wrap{max-width:1050px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.muted{color:#8ea0b7;font-size:12px}.badge{padding:9px 13px;border-radius:999px;background:#473711;font-weight:800}.ready{background:#143d2b}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.card{background:#111d2b;border:1px solid #24354a;border-radius:16px;padding:14px}.v{font-size:23px;font-weight:800;margin-top:4px}.gate{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #24354a}.ok{color:#6ee7a8}.wait{color:#ffc46b}.row{display:grid;grid-template-columns:90px 70px 1fr 70px;gap:8px;padding:9px 0;border-bottom:1px solid #24354a;font-size:12px}@media(min-width:760px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}h1{font-size:24px;margin:3px 0}h2{font-size:16px;margin-top:20px}</style></head><body><div class="wrap"><div class="top"><div><div class="muted">MONEY HUNTER · EXACT MIRROR V2</div><h1>LIVE MIRROR VALIDATION</h1><div class="muted">Synchronized Shadow · Real money OFF</div></div><div id="st" class="badge">WATCH</div></div><div class="grid" id="cards"></div><h2>GO / NO-GO gates</h2><div class="card" id="gates"></div><h2>Recent shadow closes</h2><div class="card"><div id="rows" class="muted">Waiting for closed trades…</div></div></div><script>const f=(x,d=2)=>x==null?'—':Number(x).toFixed(d);async function tick(){try{const r=await fetch('/validation.json?ts='+Date.now(),{cache:'no-store'});const x=await r.json();const st=document.getElementById('st');st.textContent=x.status;st.className='badge '+(x.status==='READY'?'ready':'');const cards=[['Matched',x.matchedTrades],['Ticket sync',x.ticketSyncPct==null?'—':f(x.ticketSyncPct,1)+'%'],['Net expectancy',x.expectancy==null?'—':f(x.expectancy,3)+'R'],['Profit factor',f(x.profitFactor,2)],['Max DD',f(x.maxDDPct,2)+'%'],['Range exp.',x.rangeExpectancy==null?'—':f(x.rangeExpectancy,3)+'R'],['Outcome match',x.outcomeMatchPct==null?'—':f(x.outcomeMatchPct,1)+'%'],['Shadow balance','$'+f(x.shadowBalance,2)]];document.getElementById('cards').innerHTML=cards.map(([a,b])=>'<div class="card"><div class="muted">'+a+'</div><div class="v">'+b+'</div></div>').join('');document.getElementById('gates').innerHTML=Object.entries(x.gates).map(([k,v])=>'<div class="gate"><span>'+k+'</span><b class="'+(v?'ok':'wait')+'">'+(v?'PASS':'WAIT')+'</b></div>').join('');document.getElementById('rows').innerHTML=x.recentClosed.length?x.recentClosed.map(z=>'<div class="row"><b>'+z.symbol+'</b><span>'+z.reason+'</span><span>'+z.setup+'</span><span>'+f(z.netR,2)+'R</span></div>').join(''):'Waiting for closed trades…';}catch(e){document.getElementById('st').textContent='OFFLINE'}}tick();setInterval(tick,2000);</script></body></html>`;}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/','http://localhost'); const path=u.pathname.replace(/\/+$/,'')||'/';
    if(req.method==='GET'&&path==='/validation.json')return json(res,200,metrics());
    if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,service:'synchronized-shadow-validator-v3',status:metrics().status});
    if(req.method==='POST'&&path==='/ingest'){
      const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8');let payload=null;try{payload=JSON.parse(raw)}catch{}
      if(payload)await ingest(payload);
      let upstreamStatus=null;try{const r=await fetch(UPSTREAM,{method:'POST',headers:{'content-type':'application/json'},body:raw});upstreamStatus=r.status}catch(e){err('forward',e)}
      return json(res,200,{ok:true,validator:true,upstreamStatus});
    }
    if(req.method==='GET'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(page());
    }
    return json(res,404,{ok:false,error:'not_found'});
  }catch(e){err('server',e);return json(res,500,{ok:false,error:String(e?.message||e)});}
});

poll().catch(e=>err('pollFatal',e));
server.listen(PORT,'0.0.0.0',()=>console.log('SYNCHRONIZED_SHADOW_VALIDATOR_V3_READY',JSON.stringify({port:PORT,maxOpen:MAX_OPEN,live:false})));
