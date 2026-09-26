'use strict';

const http = require('http');
const { scan } = require('./scanner');

const PORT = Number(process.env.PORT || 8080);
const CANDIDATE_SCAN_MS = Number(process.env.CANDIDATE_SCAN_MS || 5*60*1000);
const MARK_INTERVAL_MS = Number(process.env.MARK_INTERVAL_MS || 60*60*1000);

const CFG = Object.freeze({
  startingCash: 100,
  allocPct: 0.15,
  minTrade: 10,
  maxTrade: 20,
  maxOpen: 4,
  entrySlip: 0.015,
  exitSlip: 0.015,
  fee: 0.03,
  tp: 0.50,
  sl: -0.30,
  maxHoldMs: 6*60*60*1000,
});

const DEX='https://api.dexscreener.com';

let state={
  kind:'SOLANA_MEME_PAPER_RUNTIME_V1',
  startedAt:new Date().toISOString(),
  lastCandidateScanAt:null,
  lastMarkAt:null,
  scans:0,
  cash:CFG.startingCash,
  realizedPnl:0,
  peakEquity:CFG.startingCash,
  maxDrawdownPct:0,
  open:[],
  closed:[],
  seenDecisionKeys:{},
  stats:{entries:0,closed:0,wins:0,losses:0,breakeven:0,rugs:0,noFill:0,rejectedCapacity:0},
  lastScanSummary:null,
  errors:[]
};

const num=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d;
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const keyOf=r=>[r.mint,r.pairAddress,r.observedAt].join('|');

async function getJson(url){
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'solana-paper-runtime-v1'}});
  if(!r.ok) throw new Error('HTTP_'+r.status+' '+url);
  return r.json();
}
function bestPair(pairs,mint){
  const a=(pairs||[]).filter(p=>p?.chainId==='solana' && p?.baseToken?.address===mint);
  a.sort((x,y)=>num(y?.liquidity?.usd)-num(x?.liquidity?.usd));
  return a[0]||null;
}
async function fetchPairs(mints){
  const out=new Map();
  for(let i=0;i<mints.length;i+=30){
    const chunk=mints.slice(i,i+30);
    if(!chunk.length) continue;
    const rows=await getJson(DEX+'/tokens/v1/solana/'+chunk.join(','));
    for(const mint of chunk) out.set(mint,bestPair(rows,mint));
  }
  return out;
}
function markValue(pos,price){
  const gross=pos.qty*price*(1-CFG.exitSlip);
  const net=Math.max(0,gross-CFG.fee);
  return net;
}
function equity(){
  const openNet=state.open.reduce((s,p)=>s+(Number.isFinite(p.lastMarkNet)?p.lastMarkNet:p.notional),0);
  return state.cash+openNet;
}
function updateDrawdown(){
  const e=equity();
  state.peakEquity=Math.max(state.peakEquity,e);
  if(state.peakEquity>0){
    const dd=(state.peakEquity-e)/state.peakEquity*100;
    state.maxDrawdownPct=Math.max(state.maxDrawdownPct,dd);
  }
}
function snapshot(){
  const e=equity();
  const grossProfit=state.closed.filter(x=>x.pnl>0).reduce((s,x)=>s+x.pnl,0);
  const grossLoss=Math.abs(state.closed.filter(x=>x.pnl<0).reduce((s,x)=>s+x.pnl,0));
  return {
    kind:state.kind,
    startedAt:state.startedAt,
    lastCandidateScanAt:state.lastCandidateScanAt,
    lastMarkAt:state.lastMarkAt,
    scans:state.scans,
    cashUsdt:+state.cash.toFixed(4),
    equityUsdt:+e.toFixed(4),
    realizedPnlUsdt:+state.realizedPnl.toFixed(4),
    unrealizedPnlUsdt:+(e-state.cash-state.open.reduce((s,p)=>s+p.costBasis,0)+state.open.reduce((s,p)=>s+p.costBasis,0)).toFixed(4),
    returnPct:+((e/CFG.startingCash-1)*100).toFixed(4),
    peakEquityUsdt:+state.peakEquity.toFixed(4),
    maxDrawdownPct:+state.maxDrawdownPct.toFixed(4),
    openPositions:state.open,
    closedTrades:state.closed.slice(-100),
    stats:{
      ...state.stats,
      winRate:state.stats.closed?state.stats.wins/state.stats.closed:null,
      profitFactor:grossLoss>0?grossProfit/grossLoss:(grossProfit>0?Infinity:null),
      largestWinUsdt:state.closed.length?Math.max(...state.closed.map(x=>x.pnl)):null,
      largestLossUsdt:state.closed.length?Math.min(...state.closed.map(x=>x.pnl)):null
    },
    lastScanSummary:state.lastScanSummary,
    recentErrors:state.errors.slice(-10)
  };
}
function log(type,payload={}){
  process.stdout.write(JSON.stringify({ts:new Date().toISOString(),type,...payload})+'\n');
}
async function enter(row){
  if(state.open.some(p=>p.mint===row.mint)) return;
  if(state.open.length>=CFG.maxOpen){ state.stats.rejectedCapacity++; return; }
  const e=equity();
  const notional=clamp(e*CFG.allocPct,CFG.minTrade,CFG.maxTrade);
  if(state.cash<notional+CFG.fee){ state.stats.rejectedCapacity++; return; }
  const ref=num(row.priceUsd,NaN);
  if(!Number.isFinite(ref)||ref<=0){state.stats.noFill++;return;}
  const eff=ref*(1+CFG.entrySlip);
  const qty=notional/eff;
  state.cash-=notional+CFG.fee;
  const now=Date.now();
  const pos={
    id:row.mint+'@'+now,
    mint:row.mint,
    symbol:row.symbol,
    pairAddress:row.pairAddress,
    enteredAt:new Date(now).toISOString(),
    entryReferencePrice:ref,
    effectiveEntryPrice:eff,
    qty,
    notional,
    entryFee:CFG.fee,
    costBasis:notional+CFG.fee,
    lastObservedPrice:ref,
    lastMarkNet:markValue({qty},ref),
    liquidityAtEntry:num(row.liquidityUsd),
    marketCapAtEntry:num(row.marketCapUsd),
    score:row.score,
    reasons:row.reasons||[],
    sourceDecisionAt:row.observedAt
  };
  state.open.push(pos);
  state.stats.entries++;
  updateDrawdown();
  log('PAPER_ENTRY',{position:pos,cash:state.cash,equity:equity()});
}
async function candidateScan(){
  try{
    const s=await scan();
    state.scans++;
    state.lastCandidateScanAt=new Date().toISOString();
    state.lastScanSummary={
      discovered:s.discovered,
      eligible:s.eligible,
      finishedAt:s.finishedAt,
      top:(s.rows||[]).filter(x=>x.action==='ELIGIBLE').slice(0,10).map(x=>({mint:x.mint,symbol:x.symbol,score:x.score,priceUsd:x.priceUsd,liquidityUsd:x.liquidityUsd,marketCapUsd:x.marketCapUsd}))
    };
    for(const r of s.rows||[]){
      const k=keyOf(r);
      if(state.seenDecisionKeys[k]) continue;
      state.seenDecisionKeys[k]=true;
      log('CANDIDATE_DECISION',{mint:r.mint,symbol:r.symbol,action:r.action,score:r.score,reasons:r.reasons,priceUsd:r.priceUsd,liquidityUsd:r.liquidityUsd,marketCapUsd:r.marketCapUsd,observedAt:r.observedAt});
      if(r.action==='ELIGIBLE') await enter(r);
    }
    log('SCAN_DONE',state.lastScanSummary);
  }catch(e){
    state.errors.push({at:new Date().toISOString(),where:'candidateScan',error:String(e.message||e)});
    log('SCAN_ERROR',{error:String(e.message||e)});
  }
}
async function markAndExit(){
  try{
    if(!state.open.length){state.lastMarkAt=new Date().toISOString();return;}
    const pairs=await fetchPairs(state.open.map(p=>p.mint));
    const now=Date.now();
    const survivors=[];
    for(const p of state.open){
      const pair=pairs.get(p.mint);
      const price=num(pair?.priceUsd,NaN);
      const liq=num(pair?.liquidity?.usd,0);
      if(!Number.isFinite(price)||price<=0){
        survivors.push(p); state.stats.noFill++; continue;
      }
      p.lastObservedPrice=price;
      p.lastObservedAt=new Date(now).toISOString();
      p.lastLiquidityUsd=liq;
      p.lastMarkNet=markValue(p,price);
      const effRet=p.lastMarkNet/p.costBasis-1;
      const age=now-Date.parse(p.enteredAt);
      const liqCollapse=p.liquidityAtEntry>0 && liq/p.liquidityAtEntry<=0.30;
      const rug=(price/p.entryReferencePrice-1)<=-0.80 || liqCollapse;
      const shouldExit=rug || effRet>=CFG.tp || effRet<=CFG.sl || age>=CFG.maxHoldMs;
      if(!shouldExit){survivors.push(p);continue;}
      const proceeds=p.lastMarkNet;
      state.cash+=proceeds;
      const pnl=proceeds-p.costBasis;
      state.realizedPnl+=pnl;
      const reason=rug?'RUG_OR_LIQUIDITY_COLLAPSE':(effRet>=CFG.tp?'TP':(effRet<=CFG.sl?'SL':'MAX_HOLD'));
      const closed={...p,exitedAt:new Date(now).toISOString(),exitObservedPrice:price,exitLiquidityUsd:liq,exitNetProceeds:proceeds,pnl,returnPct:pnl/p.costBasis*100,reason};
      state.closed.push(closed);
      state.stats.closed++;
      if(pnl>0)state.stats.wins++; else if(pnl<0)state.stats.losses++; else state.stats.breakeven++;
      if(rug)state.stats.rugs++;
      log('PAPER_EXIT',{trade:closed,cash:state.cash,equity:equity()});
    }
    state.open=survivors;
    state.lastMarkAt=new Date().toISOString();
    updateDrawdown();
    log('MARK_DONE',{open:state.open.length,cash:state.cash,equity:equity(),realizedPnl:state.realizedPnl,maxDrawdownPct:state.maxDrawdownPct});
  }catch(e){
    state.errors.push({at:new Date().toISOString(),where:'markAndExit',error:String(e.message||e)});
    log('MARK_ERROR',{error:String(e.message||e)});
  }
}
let candidateBusy=false, markBusy=false;
async function safeCandidate(){if(candidateBusy)return;candidateBusy=true;try{await candidateScan()}finally{candidateBusy=false}}
async function safeMark(){if(markBusy)return;markBusy=true;try{await markAndExit()}finally{markBusy=false}}

http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,startedAt:state.startedAt}));}
  if(req.url==='/status'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(snapshot(),null,2));}
  res.writeHead(200,{'content-type':'text/plain'});res.end('Solana Meme Paper Runtime V1\n/status\n/health\n');
}).listen(PORT,()=>log('SERVICE_STARTED',{port:PORT,candidateScanMs:CANDIDATE_SCAN_MS,markIntervalMs:MARK_INTERVAL_MS}));

safeCandidate();
safeMark();
setInterval(safeCandidate,CANDIDATE_SCAN_MS).unref();
setInterval(safeMark,MARK_INTERVAL_MS).unref();
