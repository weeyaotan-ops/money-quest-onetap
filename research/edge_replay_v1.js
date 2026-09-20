'use strict';

// Offline, paired exit experiment. No HTTP, exchange credentials or live imports.
const POLICIES=['ORIGINAL','NET_BE_AFTER_1R'];
const numeric=x=>typeof x==='number'&&Number.isFinite(x);
function validateTrade(t,config){
 if(!t?.id||!t.symbol||!['BUY','SELL'].includes(t.side))return 'INVALID_TRADE';
 for(const k of ['decisionAt','entryAt','entryPrice','qty','riskAmount','entryCommission','exitFeeRate','exitSlippageBps','sl','tp','fundingCost'])
  if(!numeric(t[k]))return 'MISSING_EXECUTION_COST_OR_TRADE_DATA';
 if(t.entryAt<t.decisionAt||t.entryPrice<=0||t.qty<=0||t.riskAmount<=0||t.entryCommission<0||t.exitFeeRate<0||t.exitFeeRate>=.5||t.exitSlippageBps<0||t.exitSlippageBps>=5000)return 'INVALID_TRADE_VALUES';
 // This first experiment excludes funding crossings rather than assigning the
 // baseline's funding to a counterfactual that might have exited earlier.
 if(t.fundingCost!==0||t.noFundingEventDuringPath!==true)return 'FUNDING_PATH_REQUIRED';
 if(t.flatBeforeEntry!==true||t.completeQuoteHistory!==true)return 'UNVERIFIED_PATH';
 if(t.side==='BUY' ? !(t.sl<t.entryPrice&&t.entryPrice<t.tp) : !(t.tp<t.entryPrice&&t.entryPrice<t.sl))return 'INVALID_GEOMETRY';
 if(!Array.isArray(t.quotes)||!t.quotes.length)return 'QUOTE_PATH_REQUIRED';
 let previous=t.entryAt;
 for(let i=0;i<t.quotes.length;i++){
  const q=t.quotes[i];
  if(!['at','bid','ask','mark'].every(k=>numeric(q[k]))||q.bid<=0||q.ask<q.bid||q.mark<=0)return 'INVALID_QUOTE';
  if(q.at<t.entryAt||(i>0&&q.at<=previous))return 'NON_CHRONOLOGICAL_QUOTES';
  if(q.at-previous>config.maxQuoteGapMs)return 'QUOTE_GAP';
  previous=q.at;
 }
 return null;
}
function economics(t,q,stress){
 const dir=t.side==='BUY'?1:-1,slip=t.exitSlippageBps*stress/10000;
 const exitPrice=(dir===1?q.bid:q.ask)*(1-dir*slip);
 const gross=dir*(exitPrice-t.entryPrice)*t.qty;
 const fees=t.entryCommission*stress+exitPrice*t.qty*t.exitFeeRate*stress;
 return {exitPrice,gross,fees,net:gross-fees,netR:(gross-fees)/t.riskAmount};
}
function replay(t,policy,config,stress=1){
 let stop=t.sl,pending=null,activatedAt=null;
 const dir=t.side==='BUY'?1:-1;
 for(const q of t.quotes){
  const value=economics(t,q,stress);
  if(pending&&q.at>=pending.readyAt){stop=pending.stop;activatedAt=q.at;pending=null;}
  const sl=dir*(q.mark-stop)<=0,tp=dir*(q.mark-t.tp)>=0;
  if(sl||tp)return {policy,status:'CLOSED',exitAt:q.at,reason:sl?(activatedAt===null?'SL':'BREAK_EVEN_STOP'):'TP',...value};
  if(policy==='NET_BE_AFTER_1R'&&activatedAt===null&&!pending&&value.netR>=1){
   const fee=t.exitFeeRate*stress,slip=t.exitSlippageBps*stress/10000;
   // Freeze the observed mark/quote basis at activation. Later spread/basis
   // changes and gaps can still cause a negative realized return.
   const breakEvenQuote=(t.entryPrice*t.qty+dir*t.entryCommission*stress)/(t.qty*(1-dir*fee)*(1-dir*slip));
   const stopAt=breakEvenQuote+q.mark-(dir===1?q.bid:q.ask);
   if(!(stopAt>0)||dir*(stopAt-stop)<=0||dir*(q.mark-stopAt)<=0)return {policy,status:'UNSCORABLE',reason:'INVALID_BREAK_EVEN_LEVEL'};
   pending={stop:stopAt,readyAt:q.at+config.stopAmendLatencyMs};
  }
 }
 return {policy,status:'UNRESOLVED',reason:'NO_OBSERVED_EXIT'};
}
function stats(rows){
 const xs=rows.slice().sort((a,b)=>a.entryAt-b.entryAt);
 const values=xs.map(x=>x.netR),sum=values.reduce((a,b)=>a+b,0);
 const win=values.filter(x=>x>0),loss=values.filter(x=>x<0);
 let running=0,peak=0,maxDrawdownR=0;
 // Closed-trade ordering, not account-equity or intratrade drawdown.
 for(const x of xs.slice().sort((a,b)=>a.exitAt-b.exitAt)){running+=x.netR;peak=Math.max(peak,running);maxDrawdownR=Math.max(maxDrawdownR,peak-running);}
 return {n:xs.length,wins:win.length,losses:loss.length,winRate:xs.length?win.length/xs.length:null,totalR:sum,
  expectancyR:xs.length?sum/xs.length:null,profitFactor:loss.length?win.reduce((a,b)=>a+b,0)/-loss.reduce((a,b)=>a+b,0):null,
  closedTradeDrawdownR:maxDrawdownR};
}
function evaluate(dataset){
 const c=dataset?.protocol;
 if(!c||!['frozenAt','holdoutStart','holdoutEnd','maxQuoteGapMs','stopAmendLatencyMs'].every(k=>numeric(c[k]))
    ||c.frozenAt>c.holdoutStart||c.holdoutEnd<=c.holdoutStart||c.maxQuoteGapMs<=0||c.stopAmendLatencyMs<=0)
  throw Error('INVALID_FROZEN_PROTOCOL');
 if(!Array.isArray(dataset.trades))throw Error('TRADES_ARRAY_REQUIRED');
 const ids=new Set();for(const t of dataset.trades){if(ids.has(t.id))throw Error('DUPLICATE_TRADE_ID');ids.add(t.id);}
 const report={mode:'OFFLINE_ONLY',automaticPromotion:false,protocol:c,excluded:[],pairs:[],comparison:{},limitations:[
  'Recorded quote paths are sampled; intragap trigger order and market depth are not reconstructed.',
  'Exit comparisons condition on baseline entries and cannot establish entry-selection or portfolio performance.',
  'No funding crossings, liquidation model or counterfactual capacity/position reuse are supported.',
  'A declaration of complete data or untouched holdout requires independent provenance verification.'
 ]};
 for(const t of dataset.trades){
  if(!numeric(t.decisionAt)||t.decisionAt<c.holdoutStart||t.decisionAt>=c.holdoutEnd){report.excluded.push({id:t.id,reason:'OUTSIDE_FROZEN_HOLDOUT'});continue;}
  const reason=validateTrade(t,c);if(reason){report.excluded.push({id:t.id,reason});continue;}
  if(t.quotes.at(-1).at>c.holdoutEnd){report.excluded.push({id:t.id,reason:'PATH_CROSSES_HOLDOUT_END'});continue;}
  const outcomes={};
  for(const stress of [1,2])for(const policy of POLICIES)outcomes[`${policy}_COST_${stress}X`]=replay(t,policy,c,stress);
  if(Object.values(outcomes).some(x=>x.status!=='CLOSED')){report.excluded.push({id:t.id,reason:'INCOMPLETE_PAIRED_OUTCOMES',statuses:Object.fromEntries(Object.entries(outcomes).map(([k,v])=>[k,v.status]))});continue;}
  report.pairs.push({id:t.id,symbol:t.symbol,entryAt:t.entryAt,outcomes});
 }
 for(const stress of [1,2])for(const policy of POLICIES){const key=`${policy}_COST_${stress}X`;report.comparison[key]=stats(report.pairs.map(x=>({...x.outcomes[key],entryAt:x.entryAt})));}
 report.status=report.pairs.length?'DESCRIPTIVE_COMPARISON_ONLY':'INSUFFICIENT_DATA';
 report.exclusionRate=dataset.trades.length?report.excluded.length/dataset.trades.length:null;
 report.symbolCounts=Object.fromEntries([...new Set(report.pairs.map(x=>x.symbol))].map(s=>[s,report.pairs.filter(x=>x.symbol===s).length]));
 return report;
}
if(require.main===module){
 try{const fs=require('node:fs');if(!process.argv[2])throw Error('Usage: node research/edge_replay_v1.js <private-dataset.json>');console.log(JSON.stringify(evaluate(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={evaluate,replay,validateTrade,economics,stats};
