'use strict';

const fs=require('fs');
const path=require('path');
const {scan}=require('./scanner');

const DIR=__dirname;
const ACCOUNT_PATH=path.join(DIR,'paper_account.json');
const STATE_PATH=path.join(DIR,'state.json');
const DECISIONS_PATH=path.join(DIR,'decisions.ndjson');

const CFG={
  startingCash:100,
  allocPct:.15,
  minTrade:10,
  maxTrade:20,
  maxOpen:4,
  entrySlip:.015,
  exitSlip:.015,
  fee:.03,
  tp:.50,
  sl:-.30,
  maxHoldMs:6*60*60*1000
};
const DEX='https://api.dexscreener.com';
const num=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d;
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');

async function getJson(url){
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'solana-paper-gha-v1'}});
  if(!r.ok) throw new Error('HTTP_'+r.status+' '+url);
  return r.json();
}
function bestPair(rows,mint){
  const a=(rows||[]).filter(p=>p?.chainId==='solana'&&p?.baseToken?.address===mint);
  a.sort((x,y)=>num(y?.liquidity?.usd)-num(x?.liquidity?.usd));
  return a[0]||null;
}
async function fetchPairs(mints){
  const out=new Map();
  for(let i=0;i<mints.length;i+=30){
    const chunk=mints.slice(i,i+30);
    if(!chunk.length) continue;
    const rows=await getJson(DEX+'/tokens/v1/solana/'+chunk.join(','));
    for(const m of chunk) out.set(m,bestPair(rows,m));
  }
  return out;
}
function liquidationValue(pos,price){
  return Math.max(0,pos.qty*price*(1-CFG.exitSlip)-CFG.fee);
}
function equity(a){
  return a.cashUsdt+(a.openPositions||[]).reduce((s,p)=>s+num(p.lastMarkNet,p.notionalUsdt),0);
}
function recompute(a){
  const closed=a.closedTrades||[];
  const wins=closed.filter(x=>x.pnlUsdt>0);
  const losses=closed.filter(x=>x.pnlUsdt<0);
  const gp=wins.reduce((s,x)=>s+x.pnlUsdt,0);
  const gl=Math.abs(losses.reduce((s,x)=>s+x.pnlUsdt,0));
  a.stats.entries=(a.openPositions||[]).length+closed.length;
  a.stats.closed=closed.length;
  a.stats.wins=wins.length;
  a.stats.losses=losses.length;
  a.stats.breakeven=closed.length-wins.length-losses.length;
  a.stats.winRate=closed.length?wins.length/closed.length:null;
  a.stats.profitFactor=gl>0?gp/gl:(gp>0?999:null);
  a.stats.largestWinUsdt=closed.length?Math.max(...closed.map(x=>x.pnlUsdt)):null;
  a.stats.largestLossUsdt=closed.length?Math.min(...closed.map(x=>x.pnlUsdt)):null;
  a.equityUsdt=equity(a);
  a.unrealizedPnlUsdt=(a.openPositions||[]).reduce((s,p)=>s+(num(p.lastMarkNet,p.notionalUsdt)-p.costBasisUsdt),0);
  a.returnPct=(a.equityUsdt/a.startingCashUsdt-1)*100;
  a.peakEquityUsdt=Math.max(num(a.peakEquityUsdt,a.startingCashUsdt),a.equityUsdt);
  const dd=a.peakEquityUsdt>0?(a.peakEquityUsdt-a.equityUsdt)/a.peakEquityUsdt*100:0;
  a.maxDrawdownPct=Math.max(num(a.maxDrawdownPct),dd);
}
function appendDecision(d){
  fs.appendFileSync(DECISIONS_PATH,JSON.stringify(d)+'\n');
}

async function main(){
  const now=new Date();
  const a=read(ACCOUNT_PATH);
  const st=read(STATE_PATH);
  a.stats=a.stats||{};
  a.openPositions=a.openPositions||[];
  a.closedTrades=a.closedTrades||[];
  st.counts=st.counts||{};
  st.signals=st.signals||[];
  st.seenEligibleMints=st.seenEligibleMints||{};

  // 1) Mark / resolve existing paper positions using current observable DEX data.
  if(a.openPositions.length){
    const pairs=await fetchPairs(a.openPositions.map(p=>p.mint));
    const keep=[];
    for(const p of a.openPositions){
      const pair=pairs.get(p.mint);
      const price=num(pair?.priceUsd,NaN);
      const liq=num(pair?.liquidity?.usd,0);
      if(!Number.isFinite(price)||price<=0){
        a.stats.noFillOrBadQuote=(a.stats.noFillOrBadQuote||0)+1;
        keep.push(p); continue;
      }
      p.lastObservedAt=now.toISOString();
      p.lastObservedPrice=price;
      p.lastLiquidityUsd=liq;
      p.lastMarkNet=liquidationValue(p,price);
      const ret=p.lastMarkNet/p.costBasisUsdt-1;
      const age=now-Date.parse(p.enteredAt);
      const liqCollapse=p.liquidityAtEntryUsd>0&&liq/p.liquidityAtEntryUsd<=.30;
      const rug=(price/p.entryReferencePrice-1)<=-.80||liqCollapse;
      const exit=rug||ret>=CFG.tp||ret<=CFG.sl||age>=CFG.maxHoldMs;
      if(!exit){keep.push(p);continue;}
      const proceeds=p.lastMarkNet;
      const pnl=proceeds-p.costBasisUsdt;
      a.cashUsdt+=proceeds;
      a.realizedPnlUsdt+=pnl;
      const reason=rug?'RUG_OR_LIQUIDITY_COLLAPSE':ret>=CFG.tp?'TP':ret<=CFG.sl?'SL':'MAX_HOLD';
      const c={...p,exitedAt:now.toISOString(),exitObservedPrice:price,exitLiquidityUsd:liq,exitNetProceedsUsdt:proceeds,pnlUsdt:pnl,returnPct:pnl/p.costBasisUsdt*100,exitReason:reason};
      a.closedTrades.push(c);
      if(rug)a.stats.rugLosses=(a.stats.rugLosses||0)+1;
      console.log('PAPER_EXIT',JSON.stringify({symbol:p.symbol,mint:p.mint,pnl:+pnl.toFixed(4),reason}));
    }
    a.openPositions=keep;
  }

  // 2) Run a fresh prospective market scan.
  const s=await scan();
  st.counts.scans=(st.counts.scans||0)+1;
  st.counts.discovered=(st.counts.discovered||0)+num(s.discovered);
  st.lastRunAt=now.toISOString();
  st.lastScanSummary={startedAt:s.startedAt,finishedAt:s.finishedAt,discovered:s.discovered,eligible:s.eligible};

  const decisions=[];
  for(const r of s.rows||[]){
    const d={
      observedAt:r.observedAt||now.toISOString(),
      mint:r.mint||null,symbol:r.symbol||null,pairAddress:r.pairAddress||null,
      priceUsd:Number.isFinite(r.priceUsd)?r.priceUsd:null,
      liquidityUsd:num(r.liquidityUsd),marketCapUsd:num(r.marketCapUsd),
      ageMin:num(r.ageMin),volume5mUsd:num(r.volume5mUsd),volume1hUsd:num(r.volume1hUsd),
      buys5m:num(r.buys5m),sells5m:num(r.sells5m),buySellRatio5m:num(r.buySellRatio5m),
      volumeAcceleration:num(r.volumeAcceleration),priceChange5mPct:num(r.priceChange5mPct),
      priceChange1hPct:num(r.priceChange1hPct),score:num(r.score),action:r.action,
      reasons:r.reasons||[],audit:r.audit||null
    };
    decisions.push(d);
    appendDecision(d);
  }
  st.counts.candidateDecisions=(st.counts.candidateDecisions||0)+decisions.length;
  st.counts.eligibleSignals=(st.counts.eligibleSignals||0)+decisions.filter(x=>x.action==='ELIGIBLE').length;

  // 3) Prospectively enter eligible tokens not already seen/opened.
  recompute(a);
  for(const d of decisions.filter(x=>x.action==='ELIGIBLE').sort((x,y)=>y.score-x.score)){
    if(st.seenEligibleMints[d.mint]) continue;
    st.seenEligibleMints[d.mint]=d.observedAt;
    st.signals.push({...d,recordedAt:now.toISOString()});
    if(a.openPositions.some(p=>p.mint===d.mint)) continue;
    if(a.openPositions.length>=CFG.maxOpen){
      a.stats.rejectedForCashOrCapacity=(a.stats.rejectedForCashOrCapacity||0)+1;continue;
    }
    recompute(a);
    const notional=clamp(a.equityUsdt*CFG.allocPct,CFG.minTrade,CFG.maxTrade);
    if(a.cashUsdt<notional+CFG.fee){
      a.stats.rejectedForCashOrCapacity=(a.stats.rejectedForCashOrCapacity||0)+1;continue;
    }
    if(!Number.isFinite(d.priceUsd)||d.priceUsd<=0){
      a.stats.noFillOrBadQuote=(a.stats.noFillOrBadQuote||0)+1;continue;
    }
    const effective=d.priceUsd*(1+CFG.entrySlip);
    const qty=notional/effective;
    a.cashUsdt-=notional+CFG.fee;
    const p={
      id:d.mint+'@'+now.getTime(),mint:d.mint,symbol:d.symbol,pairAddress:d.pairAddress,
      enteredAt:now.toISOString(),sourceDecisionAt:d.observedAt,score:d.score,
      entryReferencePrice:d.priceUsd,effectiveEntryPrice:effective,qty,
      notionalUsdt:notional,entryFeeUsdt:CFG.fee,costBasisUsdt:notional+CFG.fee,
      liquidityAtEntryUsd:d.liquidityUsd,marketCapAtEntryUsd:d.marketCapUsd,
      lastObservedAt:now.toISOString(),lastObservedPrice:d.priceUsd,
      lastLiquidityUsd:d.liquidityUsd,lastMarkNet:liquidationValue({qty},d.priceUsd)
    };
    a.openPositions.push(p);
    console.log('PAPER_ENTRY',JSON.stringify({symbol:p.symbol,mint:p.mint,notional:+notional.toFixed(2),entry:d.priceUsd,score:d.score}));
  }

  recompute(a);
  a.lastRunAt=now.toISOString();
  a.scanCount=(a.scanCount||0)+1;
  a.lastScanSummary=st.lastScanSummary;

  // keep state performance aligned with the USDT paper account
  st.performance=st.performance||{};
  st.performance.paperEquityUsdt=a.equityUsdt;
  st.performance.paperReturnPct=a.returnPct;
  st.performance.paperClosedTrades=a.stats.closed;
  st.performance.paperWins=a.stats.wins;
  st.performance.paperLosses=a.stats.losses;
  st.performance.paperMaxDrawdownPct=a.maxDrawdownPct;
  st.performance.paperProfitFactor=a.stats.profitFactor;
  st.performance.paperOpenPositions=a.openPositions.length;

  write(ACCOUNT_PATH,a);
  write(STATE_PATH,st);
  console.log('PAPER_STATUS',JSON.stringify({scan:a.scanCount,discovered:s.discovered,eligible:s.eligible,cash:+a.cashUsdt.toFixed(4),equity:+a.equityUsdt.toFixed(4),open:a.openPositions.length,closed:a.stats.closed,returnPct:+a.returnPct.toFixed(3)}));
}

main().catch(e=>{console.error('FATAL',e&&e.stack||e);process.exit(1)});
