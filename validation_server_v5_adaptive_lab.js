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
const FRICTION_BPS = Number(process.env.RANGE_FRICTION_BPS || (ENTRY_FEE_BPS + EXIT_FEE_BPS + EXIT_SLIPPAGE_BPS));
const START_BALANCE = Number(process.env.SHADOW_START_BALANCE || 1000);
const STARTED_MS = Date.now();
const STARTED_AT = new Date(STARTED_MS).toISOString();
const CHAMPION_ID = 'V4_CHAMPION';
const MAX_BRAINS = Math.max(10, Number(process.env.EDGE_LAB_MAX_BRAINS || 16));
const EVOLVE_AFTER = Math.max(50, Number(process.env.EDGE_LAB_EVOLVE_AFTER || 100));
const EVOLVE_EVERY = Math.max(25, Number(process.env.EDGE_LAB_EVOLVE_EVERY || 50));

const BASE_PROFILES = [
  {id:'RAW_CONTROL', name:'RAW Control', maxFrictionR:Infinity, minNetRR:-Infinity, minRiskBps:0, maxSpreadR:Infinity},
  {id:'V4_CHAMPION', name:'V4 Champion', maxFrictionR:0.15, minNetRR:1.50, minRiskBps:0, maxSpreadR:Infinity},
  {id:'BALANCED', name:'Balanced Edge', maxFrictionR:0.12, minNetRR:1.60, minRiskBps:0, maxSpreadR:0.08},
  {id:'STRICT', name:'Strict Edge', maxFrictionR:0.10, minNetRR:1.80, minRiskBps:0, maxSpreadR:0.06},
  {id:'ELITE', name:'Elite Cost Edge', maxFrictionR:0.08, minNetRR:2.00, minRiskBps:0, maxSpreadR:0.05},
  {id:'WIDE60', name:'Wide Stop 60bps', maxFrictionR:0.15, minNetRR:1.50, minRiskBps:60, maxSpreadR:0.08},
  {id:'WIDE80', name:'Wide Stop 80bps', maxFrictionR:0.15, minNetRR:1.60, minRiskBps:80, maxSpreadR:0.08},
  {id:'RR20', name:'Net RR 2.0', maxFrictionR:0.15, minNetRR:2.00, minRiskBps:0, maxSpreadR:0.08},
  {id:'SPREAD05', name:'Spread ≤5% Stop', maxFrictionR:0.15, minNetRR:1.50, minRiskBps:0, maxSpreadR:0.05},
  {id:'SPREAD03', name:'Spread ≤3% Stop', maxFrictionR:0.12, minNetRR:1.60, minRiskBps:0, maxSpreadR:0.03},
];

const globalState = {
  sourceSeen: new Set(), sourceFresh: new Set(), errors: [], recent: [], meta: new Map(), metaAt: 0,
  brains: new Map(), generation: 0, nextEvolutionAt: EVOLVE_AFTER, liveTrading: false,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x,a=0,b=1) => Math.max(a, Math.min(b, x));
function json(res, code, body){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(body));}
function log(event,data={}){const row={ts:new Date().toISOString(),event,...data};globalState.recent.unshift(row);if(globalState.recent.length>120)globalState.recent.length=120;console.log('ADAPTIVE_EDGE_LAB',JSON.stringify(row));}
function fail(where,e){const row={ts:Date.now(),where,error:String(e?.message||e)};globalState.errors.push(row);globalState.errors=globalState.errors.filter(x=>Date.now()-x.ts<86400000);console.error('ADAPTIVE_EDGE_LAB_ERR',JSON.stringify(row));}
function findTickets(x){if(Array.isArray(x))return x;if(!x||typeof x!=='object')return[];for(const k of ['tickets','signals','data','items','open']){if(Array.isArray(x[k]))return x[k];if(x[k]&&typeof x[k]==='object'){const a=findTickets(x[k]);if(a.length)return a;}}if(x.id&&x.side&&(x.symbol||x.instId))return[x];return[];}
function norm(t){const raw=String(t.binanceSymbol||t.instId||t.symbol||t.asset||'').toUpperCase().replace(/[-_/]/g,'');const base=raw.replace(/USDTSWAP$/,'').replace(/USDTPERP$/,'').replace(/USDT$/,'');return base?`${base}USDT`:'';}
function decimals(step){const s=String(step);if(s.includes('e-'))return Number(s.split('e-')[1]);return Math.max(0,(s.split('.')[1]||'').replace(/0+$/,'').length);}
function roundStep(v,step){const n=Number(v),s=Number(step);if(!Number.isFinite(n)||!Number.isFinite(s)||s<=0)return n;return Number((Math.round(n/s)*s).toFixed(decimals(step)));}

function makeBrain(p,dynamic=false,parent=null){
  return {
    ...p, dynamic, parent, bornAt:new Date().toISOString(), seen:new Set(), passed:0, rejected:0,
    pending:new Map(), open:new Map(), closed:[], balance:START_BALANCE, peak:START_BALANCE, maxDD:0,
    blockedSymbol:0, blockedCapacity:0, rejectReasons:{},
  };
}
for(const p of BASE_PROFILES) globalState.brains.set(p.id, makeBrain(p));

async function refreshMeta(force=false){
  if(!force&&globalState.meta.size&&Date.now()-globalState.metaAt<300000)return;
  const r=await fetch(`${BINANCE}/fapi/v1/exchangeInfo`);if(!r.ok)throw new Error(`exchangeInfo_${r.status}`);
  const j=await r.json(),m=new Map();
  for(const x of j.symbols||[]){if(x.status!=='TRADING'||x.contractType!=='PERPETUAL'||x.quoteAsset!=='USDT')continue;const pf=(x.filters||[]).find(f=>f.filterType==='PRICE_FILTER')||{};if(pf.tickSize)m.set(x.symbol,{tickSize:Number(pf.tickSize)});}
  globalState.meta=m;globalState.metaAt=Date.now();
}
async function book(symbol){const r=await fetch(`${BINANCE}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);if(!r.ok)throw new Error(`book_${symbol}_${r.status}`);const x=await r.json();return{bid:Number(x.bidPrice),ask:Number(x.askPrice)};}
async function last(symbol){const r=await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`);if(!r.ok)throw new Error(`price_${symbol}_${r.status}`);const x=await r.json();return Number(x.price);}
function spreadBpsFromBook(b){if(!b||!(b.bid>0)||!(b.ask>0)||b.ask<b.bid)return null;const mid=(b.ask+b.bid)/2;return (b.ask-b.bid)/mid*10000;}

function gate(brain,t,spreadBps){
  if(String(t?.setup||'')!=='RANGE_MEAN_REVERSION')return{pass:true,reason:'NON_RANGE'};
  if(brain.id==='RAW_CONTROL')return{pass:true,reason:'RAW'};
  const entry=Number(t.entry),sl=Number(t.sl),tp=Number(t.tp),side=String(t.side||'').toUpperCase();
  if(![entry,sl,tp].every(Number.isFinite)||!(entry>0))return{pass:false,reason:'INVALID_PRICES'};
  if(side==='BUY'&&!(sl<entry&&tp>entry))return{pass:false,reason:'INVALID_BUY_LEVELS'};
  if(side==='SELL'&&!(sl>entry&&tp<entry))return{pass:false,reason:'INVALID_SELL_LEVELS'};
  if(!['BUY','SELL'].includes(side))return{pass:false,reason:'INVALID_SIDE'};
  const riskBps=Math.abs(entry-sl)/entry*10000,rewardBps=Math.abs(tp-entry)/entry*10000;
  if(!(riskBps>0&&rewardBps>0))return{pass:false,reason:'ZERO_DISTANCE',riskBps,rewardBps};
  const frictionR=FRICTION_BPS/riskBps;
  const netRR=(rewardBps-FRICTION_BPS)/(riskBps+FRICTION_BPS);
  const spreadR=Number.isFinite(spreadBps)?spreadBps/riskBps:null;
  if(riskBps<brain.minRiskBps)return{pass:false,reason:'STOP_TOO_NARROW',riskBps,rewardBps,frictionR,netRR,spreadR};
  if(frictionR>brain.maxFrictionR)return{pass:false,reason:'COST_TOO_LARGE_VS_STOP',riskBps,rewardBps,frictionR,netRR,spreadR};
  if(netRR<brain.minNetRR)return{pass:false,reason:'NET_RR_TOO_LOW',riskBps,rewardBps,frictionR,netRR,spreadR};
  if(Number.isFinite(brain.maxSpreadR)){
    if(!Number.isFinite(spreadR))return{pass:false,reason:'SPREAD_UNAVAILABLE',riskBps,rewardBps,frictionR,netRR,spreadR};
    if(spreadR>brain.maxSpreadR)return{pass:false,reason:'SPREAD_TOO_LARGE_VS_STOP',riskBps,rewardBps,frictionR,netRR,spreadR};
  }
  return{pass:true,reason:'PASS',riskBps,rewardBps,frictionR,netRR,spreadR};
}
function hasSymbol(brain,symbol){for(const x of brain.pending.values())if(x.symbol===symbol)return true;for(const x of brain.open.values())if(x.symbol===symbol)return true;return false;}
async function trackBrain(brain,t,g){
  const id=String(t.id||'');if(!id||brain.seen.has(id))return;brain.seen.add(id);
  if(!g.pass){brain.rejected++;brain.rejectReasons[g.reason]=(brain.rejectReasons[g.reason]||0)+1;return;}
  brain.passed++;
  const symbol=norm(t);if(!symbol)return;
  if(hasSymbol(brain,symbol)){brain.blockedSymbol++;return;}
  if(brain.pending.size+brain.open.size>=MAX_OPEN){brain.blockedCapacity++;return;}
  await refreshMeta();const meta=globalState.meta.get(symbol);if(!meta)return;
  const side=String(t.side||'').toUpperCase(),entry=roundStep(Number(t.entry),meta.tickSize),sl=roundStep(Number(t.sl),meta.tickSize),tp=roundStep(Number(t.tp),meta.tickSize);
  if(![entry,sl,tp].every(Number.isFinite))return;if(side==='BUY'&&!(sl<entry&&tp>entry))return;if(side==='SELL'&&!(sl>entry&&tp<entry))return;
  brain.pending.set(id,{id,symbol,side,setup:String(t.setup||''),entry,sl,tp,receivedAt:Date.now(),expiresAt:Date.now()+TTL_MS,gate:g});
}
function closeBrain(brain,x,reason){
  const dist=Math.abs(x.entry-x.sl);if(!(dist>0))return;
  const slip=EXIT_SLIPPAGE_BPS/10000;
  const exit=reason==='TP'?(x.side==='BUY'?x.tp*(1-slip):x.tp*(1+slip)):(x.side==='BUY'?x.sl*(1-slip):x.sl*(1+slip));
  const grossR=x.side==='BUY'?(exit-x.entry)/dist:(x.entry-exit)/dist;
  const feeR=((x.entry*ENTRY_FEE_BPS/10000)+(Math.abs(exit)*EXIT_FEE_BPS/10000))/dist;
  const netR=grossR-feeR,row={...x,closedAt:Date.now(),reason,grossR,feeR,netR};
  brain.closed.push(row);if(brain.closed.length>1000)brain.closed.shift();brain.open.delete(x.id);
  brain.balance*=1+(RISK_PCT/100)*netR;brain.peak=Math.max(brain.peak,brain.balance);brain.maxDD=Math.max(brain.maxDD,brain.peak>0?(brain.peak-brain.balance)/brain.peak*100:0);
  if(brain.id===CHAMPION_ID)log('CHAMPION_CLOSE',{symbol:x.symbol,reason,netR:Number(netR.toFixed(3)),balance:Number(brain.balance.toFixed(2))});
}

function brainStats(brain){
  const c=brain.closed,n=c.length,w=c.filter(x=>x.netR>0).length,l=c.filter(x=>x.netR<0).length,net=c.reduce((a,x)=>a+x.netR,0),pos=c.filter(x=>x.netR>0).reduce((a,x)=>a+x.netR,0),neg=Math.abs(c.filter(x=>x.netR<0).reduce((a,x)=>a+x.netR,0));
  const exp=n?net/n:null,pf=neg>0?pos/neg:(pos>0?99:null);
  let sd=null,lcb90=null;if(n>1){const v=c.reduce((a,x)=>a+(x.netR-exp)**2,0)/(n-1);sd=Math.sqrt(v);lcb90=exp-1.282*sd/Math.sqrt(n);}
  const passRate=(brain.passed+brain.rejected)?brain.passed/(brain.passed+brain.rejected)*100:null;
  const proven=n>=50&&exp>0.10&&pf>1.15&&brain.maxDD<10&&lcb90!==null&&lcb90>0;
  const promising=n>=20&&exp>0.10&&pf>1.15&&brain.maxDD<10;
  const failing=n>=20&&(exp<=0||pf<0.9||brain.maxDD>=15);
  const status=proven?'PROVEN':failing?'FAILING':promising?'PROMISING':'LEARNING';
  const sampleP=clamp(n/50),expP=exp==null?0:clamp((exp+0.10)/0.20),pfP=pf==null?0:clamp((pf-0.80)/0.35),ddP=clamp((15-brain.maxDD)/5),lcbP=lcb90==null?0:clamp((lcb90+0.05)/0.10);
  const proofProgress=100*(0.45*sampleP+0.20*expP+0.15*pfP+0.10*ddP+0.10*lcbP);
  const evidenceScore=n<5?-999:(lcb90??(exp??-9))*Math.min(1,n/30)-Math.max(0,brain.maxDD-10)*0.02;
  return {id:brain.id,name:brain.name,dynamic:brain.dynamic,parent:brain.parent,bornAt:brain.bornAt,trades:n,wins:w,losses:l,winRate:n?w/n*100:null,netR:net,expectancy:exp,profitFactor:pf,maxDDPct:brain.maxDD,balance:brain.balance,passRate,passed:brain.passed,rejected:brain.rejected,pending:brain.pending.size,open:brain.open.size,lcb90,sd,status,proofProgress,evidenceScore,params:{maxFrictionR:brain.maxFrictionR,minNetRR:brain.minNetRR,minRiskBps:brain.minRiskBps,maxSpreadR:Number.isFinite(brain.maxSpreadR)?brain.maxSpreadR:null},rejectReasons:brain.rejectReasons};
}
function rankedStats(){return [...globalState.brains.values()].map(brainStats).sort((a,b)=>b.evidenceScore-a.evidenceScore||b.proofProgress-a.proofProgress);}

function maybeEvolve(){
  const count=globalState.sourceFresh.size;if(count<globalState.nextEvolutionAt)return;
  globalState.nextEvolutionAt+=EVOLVE_EVERY;
  const ranked=rankedStats().filter(x=>x.id!=='RAW_CONTROL'&&x.trades>=20&&x.status!=='FAILING');if(!ranked.length){log('EVOLVE_WAIT',{sourceFresh:count,reason:'NO_QUALIFIED_PARENT'});return;}
  const parent=globalState.brains.get(ranked[0].id);if(!parent)return;
  globalState.generation++;
  const gen=globalState.generation;
  const candidates=[
    {id:`M${gen}_COST`,name:`Mutant ${gen} Cost`,maxFrictionR:clamp(parent.maxFrictionR*0.9,0.05,0.25),minNetRR:clamp(parent.minNetRR+0.10,1.2,2.5),minRiskBps:parent.minRiskBps,maxSpreadR:parent.maxSpreadR},
    {id:`M${gen}_SPEED`,name:`Mutant ${gen} Speed`,maxFrictionR:clamp(parent.maxFrictionR+0.02,0.05,0.25),minNetRR:clamp(parent.minNetRR-0.10,1.2,2.5),minRiskBps:Math.max(0,parent.minRiskBps-10),maxSpreadR:parent.maxSpreadR},
    {id:`M${gen}_SPREAD`,name:`Mutant ${gen} Spread`,maxFrictionR:parent.maxFrictionR,minNetRR:parent.minNetRR,minRiskBps:parent.minRiskBps+10,maxSpreadR:Number.isFinite(parent.maxSpreadR)?clamp(parent.maxSpreadR*0.8,0.015,0.20):0.06},
  ];
  while(globalState.brains.size+candidates.length>MAX_BRAINS){const disposable=rankedStats().reverse().find(x=>x.dynamic&&x.trades>=20);if(!disposable)break;globalState.brains.delete(disposable.id);log('BRAIN_RETIRED',{id:disposable.id,status:disposable.status,exp:disposable.expectancy});}
  for(const p of candidates){if(globalState.brains.size>=MAX_BRAINS)break;globalState.brains.set(p.id,makeBrain(p,true,parent.id));log('BRAIN_SPAWNED',{id:p.id,parent:parent.id,params:p});}
}

async function ingest(payload){
  const tickets=findTickets(payload);const selected=tickets.filter(t=>t?.combinedSelected===true&&t?.id);
  if(!selected.length)return {forwardPayload:payload,forwarded:0};
  await refreshMeta();
  const spreadBySymbol=new Map();
  const symbols=[...new Set(selected.map(norm).filter(Boolean))];
  await Promise.all(symbols.map(async s=>{try{spreadBySymbol.set(s,spreadBpsFromBook(await book(s)));}catch(e){spreadBySymbol.set(s,null);fail('spread:'+s,e);}}));
  const championPass=new Map();
  for(const t of selected){
    const id=String(t.id),opened=Date.parse(t.openedAt||0),fresh=!(opened>0&&opened<STARTED_MS);globalState.sourceSeen.add(id);if(fresh)globalState.sourceFresh.add(id);
    const sb=spreadBySymbol.get(norm(t));
    for(const brain of globalState.brains.values()){
      if(brain.seen.has(id))continue;
      const g=fresh?gate(brain,t,sb):{pass:false,reason:'PRE_CUTOFF'};
      await trackBrain(brain,t,g);
      if(brain.id===CHAMPION_ID)championPass.set(id,g.pass);
    }
  }
  const forwardPayload=JSON.parse(JSON.stringify(payload));let forwarded=0;
  for(const t of findTickets(forwardPayload)){
    if(t?.combinedSelected!==true||!t?.id)continue;const pass=championPass.get(String(t.id))===true;
    if(!pass){t.combinedSelected=false;t.adaptiveRejected=true;t.adaptiveReason='V4_CHAMPION_GATE';}else{t.adaptiveChampion='V4_CHAMPION';forwarded++;}
  }
  maybeEvolve();
  return {forwardPayload,forwarded};
}

async function poll(){
  while(true){
    try{
      const now=Date.now(),pendingSymbols=new Set(),openSymbols=new Set();
      for(const b of globalState.brains.values()){for(const x of b.pending.values())pendingSymbols.add(x.symbol);for(const x of b.open.values())openSymbols.add(x.symbol);}
      const books=new Map(),prices=new Map();
      await Promise.all([...pendingSymbols].map(async s=>{try{books.set(s,await book(s));}catch(e){fail('pendingBook:'+s,e);}}));
      await Promise.all([...openSymbols].map(async s=>{try{prices.set(s,await last(s));}catch(e){fail('openPrice:'+s,e);}}));
      for(const brain of globalState.brains.values()){
        for(const[id,x]of[...brain.pending]){
          if(now>x.expiresAt){brain.pending.delete(id);continue;}
          const b=books.get(x.symbol);if(!b)continue;const fill=x.side==='BUY'?b.ask<=x.entry:b.bid>=x.entry;if(fill){brain.pending.delete(id);brain.open.set(id,{...x,filledAt:Date.now()});}
        }
        for(const[id,x]of[...brain.open]){
          const p=prices.get(x.symbol);if(!Number.isFinite(p))continue;if(x.side==='BUY'){if(p<=x.sl)closeBrain(brain,x,'SL');else if(p>=x.tp)closeBrain(brain,x,'TP');}else{if(p>=x.sl)closeBrain(brain,x,'SL');else if(p<=x.tp)closeBrain(brain,x,'TP');}
        }
      }
    }catch(e){fail('poll',e);}await sleep(1000);
  }
}

function metrics(){
  const ranked=rankedStats(),leader=ranked.find(x=>x.id!=='RAW_CONTROL'&&x.trades>=5)||ranked.find(x=>x.id!=='RAW_CONTROL')||null,champion=ranked.find(x=>x.id===CHAMPION_ID)||null,errors24h=globalState.errors.filter(x=>Date.now()-x.ts<86400000).length;
  const proven=ranked.filter(x=>x.status==='PROVEN');
  return {status:proven.length?'EDGE_PROVEN':'HUNTING',liveTrading:false,version:'ADAPTIVE_EDGE_LAB_V1',startedAt:STARTED_AT,sourceSeen:globalState.sourceSeen.size,sourceFresh:globalState.sourceFresh.size,brainCount:globalState.brains.size,generation:globalState.generation,frictionBps:FRICTION_BPS,maxOpen:MAX_OPEN,errors24h,leader,champion,proven:proven.map(x=>x.id),brains:ranked,recent:globalState.recent.slice(0,40)};
}

function page(){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adaptive Edge Lab</title><style>:root{color-scheme:dark}body{margin:0;background:#07101a;color:#edf4ff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}.wrap{max-width:1180px;margin:auto;padding:16px}.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.muted{color:#8ca0b8;font-size:12px}.badge{padding:9px 13px;border-radius:999px;background:#423515;font-weight:800}.proven{background:#153f2c}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:14px}.card{background:#101c2a;border:1px solid #24364a;border-radius:15px;padding:13px}.v{font-size:21px;font-weight:800;margin-top:4px}.brain{display:grid;grid-template-columns:1.5fr .7fr .8fr .7fr .7fr .7fr;gap:7px;padding:10px 0;border-bottom:1px solid #24364a;font-size:12px;align-items:center}.name{font-weight:800}.tag{font-size:10px;padding:3px 6px;border-radius:999px;background:#24364a;display:inline-block}.good{color:#6ee7a8}.bad{color:#ff8f8f}.warn{color:#ffc46b}.bar{height:6px;background:#223246;border-radius:6px;overflow:hidden;margin-top:5px}.bar>i{display:block;height:100%;background:#8fb6ff}.small{font-size:11px}@media(min-width:760px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:720px){.brain{grid-template-columns:1.4fr .7fr .7fr .7fr}.hideM{display:none}}h1{font-size:24px;margin:3px 0}h2{font-size:16px;margin:18px 0 8px}</style></head><body><div class="wrap"><div class="top"><div><div class="muted">MONEY HUNTER · BINANCE-REALISTIC SHADOW</div><h1>ADAPTIVE EDGE LAB</h1><div class="muted">Parallel challengers · Auto-rank · Auto-mutate · Real money OFF</div></div><div id="st" class="badge">HUNTING</div></div><div class="grid" id="cards"></div><h2>Fastest proving edges</h2><div class="card"><div class="brain muted"><span>Brain</span><span>Trades</span><span>Exp</span><span>PF</span><span class="hideM">DD</span><span class="hideM">Proof</span></div><div id="brains"></div></div><h2>Current leader</h2><div class="card" id="leader">Waiting for evidence…</div><h2>Rules</h2><div class="card small muted">Each brain sees the same fresh Combined tickets, but applies a different execution-cost filter. Every accepted trade is shadow-filled from live Binance Futures quotes with the same fee/slippage model. No challenger can touch real money. A brain is only PROVEN after ≥50 closed trades, expectancy &gt; +0.10R, PF &gt; 1.15, DD &lt; 10%, and a positive 90% lower confidence bound. The lab periodically spawns fresh mutants around the strongest qualified brain; mutants start from zero and only see future tickets.</div></div><script>const f=(x,d=2)=>x==null?'—':Number(x).toFixed(d);function cls(s){return s==='PROVEN'||s==='PROMISING'?'good':s==='FAILING'?'bad':'warn'}async function tick(){try{const r=await fetch('/lab.json?ts='+Date.now(),{cache:'no-store'}),x=await r.json(),st=document.getElementById('st');st.textContent=x.status;st.className='badge '+(x.status==='EDGE_PROVEN'?'proven':'');const L=x.leader||{},C=x.champion||{};const cards=[['Source tickets',x.sourceFresh],['Brains',x.brainCount],['Leader',L.name||'—'],['Leader exp',L.expectancy==null?'—':f(L.expectancy,3)+'R'],['Leader PF',f(L.profitFactor,2)],['Leader DD',L.maxDDPct==null?'—':f(L.maxDDPct,2)+'%'],['Champion exp',C.expectancy==null?'—':f(C.expectancy,3)+'R'],['Generation',x.generation]];document.getElementById('cards').innerHTML=cards.map(([a,b])=>'<div class="card"><div class="muted">'+a+'</div><div class="v">'+b+'</div></div>').join('');document.getElementById('brains').innerHTML=x.brains.map(b=>'<div class="brain"><span><span class="name">'+b.name+'</span><br><span class="tag '+cls(b.status)+'">'+b.status+'</span></span><span>'+b.trades+'</span><span>'+ (b.expectancy==null?'—':f(b.expectancy,3)+'R')+'</span><span>'+f(b.profitFactor,2)+'</span><span class="hideM">'+f(b.maxDDPct,1)+'%</span><span class="hideM">'+f(b.proofProgress,0)+'%<div class="bar"><i style="width:'+Math.min(100,b.proofProgress)+'%"></i></div></span></div>').join('');document.getElementById('leader').innerHTML=L.id?'<b>'+L.name+'</b> · '+L.status+'<br><span class="muted">'+L.trades+' trades · '+f(L.expectancy,3)+'R expectancy · PF '+f(L.profitFactor,2)+' · DD '+f(L.maxDDPct,2)+'% · 90% LCB '+f(L.lcb90,3)+'R · pass rate '+f(L.passRate,1)+'%</span>':'Waiting for evidence…';}catch(e){document.getElementById('st').textContent='OFFLINE'}}tick();setInterval(tick,2000);</script></body></html>`;}

function selfTest(){
  const t={setup:'RANGE_MEAN_REVERSION',side:'BUY',entry:100,sl:99,tp:102.2};
  const v4=globalState.brains.get(CHAMPION_ID),g=gate(v4,t,1);
  if(!g.pass)throw new Error('selftest_v4_should_pass');
  const narrow={...t,sl:99.95,tp:100.2};if(gate(v4,narrow,1).pass)throw new Error('selftest_narrow_should_reject');
  console.log('ADAPTIVE_EDGE_LAB_SELFTEST_PASS',JSON.stringify({brains:globalState.brains.size,frictionBps:FRICTION_BPS,champion:CHAMPION_ID}));
}
selfTest();

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/','http://localhost'),path=u.pathname.replace(/\/+$/,'')||'/';
    if(req.method==='GET'&&(path==='/lab.json'||path==='/validation.json'))return json(res,200,metrics());
    if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,service:'adaptive-edge-lab-v1',status:metrics().status,live:false});
    if(req.method==='POST'&&path==='/ingest'){
      const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8');let payload=null;try{payload=JSON.parse(raw)}catch{}
      if(!payload)return json(res,400,{ok:false,error:'invalid_json'});
      const {forwardPayload,forwarded}=await ingest(payload);let upstreamStatus=null;
      try{const r=await fetch(UPSTREAM,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(forwardPayload)});upstreamStatus=r.status;}catch(e){fail('forward',e);}
      return json(res,200,{ok:true,lab:true,forwarded,upstreamStatus});
    }
    if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(page());}
    return json(res,404,{ok:false,error:'not_found'});
  }catch(e){fail('server',e);return json(res,500,{ok:false,error:String(e?.message||e)});}
});

poll().catch(e=>fail('pollFatal',e));
server.listen(PORT,'0.0.0.0',()=>console.log('ADAPTIVE_EDGE_LAB_V1_READY',JSON.stringify({port:PORT,live:false,brains:globalState.brains.size,maxOpen:MAX_OPEN,champion:CHAMPION_ID,frictionBps:FRICTION_BPS})));