'use strict';
// HTR Pulse paper-only scorecard v2. Each signal is scored as:
// 50% exits at TP1, remaining 50% stops at entry (BE) or exits at TP2.
// Fees/slippage are estimated, and ambiguous 1m-bar ordering is NOT a win.
const MINUTE=60000;
const VERSION=2;
const FIRST_SIGNAL={
 key:'SOLUSDT|SHORT|2026-10-08T10:33Z',symbol:'SOLUSDT',side:'SHORT',
 entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093,
 notifiedAt:Date.parse('2026-10-08T10:33:00Z'),
 eligibleFrom:Date.parse('2026-10-08T10:34:00Z'),
 source:'SCREENSHOT_2026-10-08_18_33_SGT',
 timingNote:'First alert time known only to minute; excluded that minute'
};
const round3=v=>Math.round(v*1000)/1000;
function createTrade(s,notifiedAt=Date.now()){
 const side=s.side;
 if(!['LONG','SHORT'].includes(side))throw Error('invalid side');
 const [entry,stop,tp1,tp2]=[s.entry,s.stop,s.tp1,s.tp2].map(Number);
 const dir=side==='LONG'?1:-1;
 if(![entry,stop,tp1,tp2].every(Number.isFinite)||entry<=0||
   !(dir*(entry-stop)>0&&dir*(tp1-entry)>0&&dir*(tp2-tp1)>0))
   throw Error('invalid trade levels');
 const received=Number(notifiedAt);
 if(!Number.isFinite(received))throw Error('invalid alert time');
 return {
  key:String(s.key),symbol:String(s.symbol),side,entry,stop,tp1,tp2,
  notifiedAt:received,eligibleFrom:Number(s.eligibleFrom)||Math.ceil(received/MINUTE)*MINUTE,
  source:s.source||'HTR_PULSE_TELEGRAM',timingNote:s.timingNote||null,
  accountingVersion:VERSION,policy:'TP1_HALF_RUNNER_BE',
  status:'OPEN',tp1Hit:false,tp1At:null,partialNetR:0,runnerStop:null,
  closedAt:null,closedPrice:null,netR:null,reason:null,
  lastBar:null,lastPrice:null,lastMarkedR:null
 };
}
function upgradeTrade(t){
 if(t.accountingVersion===VERSION)return t;
 // Historical v1 marks are incompatible with the new accounting.
 // Preserve an audit copy; rewind and replay original 1-minute candles.
 t.legacyAccounting={
  version:t.accountingVersion||1,status:t.status,netR:t.netR,
  tp1Hit:!!t.tp1Hit,tp1At:t.tp1At,lastBar:t.lastBar
 };
 const fresh=createTrade(t,t.notifiedAt);
 // Keep unchanged original signal fields and source metadata.
 Object.assign(t,{
  accountingVersion:VERSION,policy:fresh.policy,status:'OPEN',
  tp1Hit:false,tp1At:null,partialNetR:0,runnerStop:null,
  closedAt:null,closedPrice:null,netR:null,reason:null,
  lastBar:null,lastPrice:null,lastMarkedR:null
 });
 return t;
}
function initScorecard(state){
 if(!state.scorecard||!Array.isArray(state.scorecard.trades)){
  state.scorecard={version:VERSION,startAt:FIRST_SIGNAL.notifiedAt,trades:[]};
 }
 const ledger=state.scorecard;
 if(!ledger.trades.some(t=>t.key===FIRST_SIGNAL.key))
  ledger.trades.unshift(createTrade(FIRST_SIGNAL,FIRST_SIGNAL.notifiedAt));
 for(const t of ledger.trades)upgradeTrade(t);
 ledger.version=VERSION;
 return ledger;
}
function netR(t,exit){
 const d=t.side==='LONG'?1:-1,risk=d*(t.entry-t.stop);
 if(!(risk>0))return null;
 // Same conservative round-trip estimated fees/slippage used by original scanner.
 const roundtripCost=0.0012*t.entry;
 return round3((d*(exit-t.entry)-roundtripCost)/(risk+roundtripCost));
}
function crossed(t,bar,level){
 const h=Number(bar.h),l=Number(bar.l);
 return t.side==='LONG'?h>=level:l<=level;
}
function touchedStop(t,bar,level){
 return t.side==='LONG'?Number(bar.l)<=level:Number(bar.h)>=level;
}
function validBar(b){
 return Number.isFinite(Number(b.t))&&Number.isFinite(Number(b.h))&&
   Number.isFinite(Number(b.l))&&Number.isFinite(Number(b.c))&&
   Number(b.l)<=Number(b.h)&&Number(b.c)>=Number(b.l)&&Number(b.c)<=Number(b.h);
}
function finish(t,status,price,bar,reason=null){
 t.status=status;
 t.closedAt=bar.t+MINUTE;
 t.closedPrice=price;
 t.reason=reason;
 if(status==='AMBIGUOUS')t.netR=null;
 else if(status==='SL')t.netR=netR(t,t.stop);
 else t.netR=round3(t.partialNetR+0.5*netR(t,price));
}
function applyBars(trade,bars,now=Date.now()){
 if(trade.status!=='OPEN')return trade;
 const sorted=[...bars].sort((a,b)=>a.t-b.t);
 let next=trade.lastBar===null?trade.eligibleFrom:trade.lastBar+MINUTE;
 const completeThrough=Math.floor(now/MINUTE)*MINUTE;
 for(const b of sorted){
  if(b.t<next||b.t>=completeThrough)continue;
  if(b.t>next){trade.dataGapAt=next;break;}
  if(!validBar(b)){trade.dataGapAt=b.t;break;}
  const slHit=touchedStop(trade,b,trade.stop);
  const tp1Hit=crossed(trade,b,trade.tp1);
  const tp2Hit=crossed(trade,b,trade.tp2);
  const entryRevisit=touchedStop(trade,b,trade.entry);
  if(!trade.tp1Hit){
   if(slHit&&tp1Hit)
    finish(trade,'AMBIGUOUS',null,b,'SL_AND_TP1_SAME_MINUTE');
   else if(slHit)
    finish(trade,'SL',trade.stop,b);
   else if(tp1Hit){
    trade.tp1Hit=true;
    trade.tp1At=b.t+MINUTE;
    trade.runnerStop=trade.entry;
    trade.partialNetR=round3(0.5*netR(trade,trade.tp1));
    // Same minute TP1+return to entry lacks reliable intrabar ordering.
    if(entryRevisit)
     finish(trade,'AMBIGUOUS',null,b,'TP1_AND_BE_SAME_MINUTE');
    else if(tp2Hit)
     finish(trade,'TP2',trade.tp2,b);
   }
  }else{
   const beHit=touchedStop(trade,b,trade.entry);
   if(beHit&&tp2Hit)
    finish(trade,'AMBIGUOUS',null,b,'BE_AND_TP2_SAME_MINUTE');
   else if(beHit)
    finish(trade,'BE',trade.entry,b);
   else if(tp2Hit)
    finish(trade,'TP2',trade.tp2,b);
  }
  trade.lastBar=b.t;
  trade.lastPrice=Number(b.c);
  if(trade.status==='OPEN'){
   trade.lastMarkedR=trade.tp1Hit?
     round3(trade.partialNetR+0.5*netR(trade,Number(b.c))):
     netR(trade,Number(b.c));
  }
  next=b.t+MINUTE;
  if(trade.status!=='OPEN')break;
 }
 return trade;
}
function stats(card){
 const trades=card?.trades||[];
 const done=trades.filter(t=>['SL','BE','TP2'].includes(t.status)&&Number.isFinite(t.netR)).sort((a,b)=>a.closedAt-b.closedAt);
 const wins=done.filter(t=>t.netR>0).length,losses=done.filter(t=>t.netR<0).length,flat=done.length-wins-losses;
 let total=0,peak=0,maxDrawdown=0,streak=0,maxLossStreak=0;
 for(const t of done){
  total+=t.netR;peak=Math.max(peak,total);
  maxDrawdown=Math.max(maxDrawdown,peak-total);
  streak=t.netR<0?streak+1:0;maxLossStreak=Math.max(maxLossStreak,streak);
 }
 return {
  tracked:trades.length,open:trades.filter(t=>t.status==='OPEN').length,
  uncertain:trades.filter(t=>t.status==='AMBIGUOUS').length,
  completed:done.length,wins,losses,flat,
  tp1Secured:trades.filter(t=>t.status==='OPEN'&&t.tp1Hit).reduce((s,t)=>s+t.partialNetR,0),
  winRate:done.length?wins/done.length:null,
  totalNetR:round3(total),averageNetR:done.length?round3(total/done.length):null,
  maxDrawdownR:round3(maxDrawdown),maxLossStreak
 };
}
module.exports={FIRST_SIGNAL,createTrade,upgradeTrade,initScorecard,applyBars,stats,netR};
