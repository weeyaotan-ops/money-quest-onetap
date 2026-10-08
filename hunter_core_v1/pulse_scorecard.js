'use strict';
// HTR Pulse V1.0 — price-level touches, NOT simulated position management.
// A signal can count TP1 and SL (or TP1 and TP2) because each is a separate
// threshold milestone. SL/TP2 ends observation; same 1m bar extremes prove
// both prices were reached but cannot resolve which occurred first.
const MINUTE=60000;
const VERSION=3;
const FIRST_SIGNAL={
 key:'SOLUSDT|SHORT|2026-10-08T10:33Z',symbol:'SOLUSDT',side:'SHORT',
 entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093,
 notifiedAt:Date.parse('2026-10-08T10:33:00Z'),
 eligibleFrom:Date.parse('2026-10-08T10:34:00Z'),
 source:'SCREENSHOT_2026-10-08_18_33_SGT',
 timingNote:'First alert known only to minute; exclude that minute'
};
function createTrade(s,notifiedAt=Date.now()){
 const side=s.side;
 if(!['LONG','SHORT'].includes(side))throw Error('invalid side');
 const [entry,stop,tp1,tp2]=[s.entry,s.stop,s.tp1,s.tp2].map(Number);
 const dir=side==='LONG'?1:-1;
 if(![entry,stop,tp1,tp2].every(Number.isFinite)||entry<=0||
    !(dir*(entry-stop)>0&&dir*(tp1-entry)>0&&dir*(tp2-tp1)>0))
   throw Error('invalid signal levels');
 const received=Number(notifiedAt);
 if(!Number.isFinite(received))throw Error('invalid notification time');
 return {
  key:String(s.key),symbol:String(s.symbol),side,entry,stop,tp1,tp2,
  notifiedAt:received,eligibleFrom:Number(s.eligibleFrom)||Math.ceil(received/MINUTE)*MINUTE,
  source:s.source||'HTR_PULSE_TELEGRAM',timingNote:s.timingNote||null,
  accountingVersion:VERSION,policy:'LEVEL_TOUCH_ONLY',
  status:'OPEN',tp1Hit:false,tp2Hit:false,slHit:false,
  tp1At:null,tp2At:null,slAt:null,closedAt:null,reason:null,
  lastBar:null,lastPrice:null,dataGapAt:null
 };
}
function upgradeTrade(t){
 if(t.accountingVersion===VERSION)return t;
 // The old TP1-half + break-even settlement could terminate even though
 // price later reached TP2. Retain audit snapshot and replay raw 1m bars.
 t.previousAccounting={
  version:t.accountingVersion||1,status:t.status,netR:t.netR,
  tp1Hit:!!t.tp1Hit,tp1At:t.tp1At,closedAt:t.closedAt,
  lastBar:t.lastBar,partialNetR:t.partialNetR??null,
  earlierSnapshot:t.legacyAccounting||null
 };
 const fresh=createTrade(t,t.notifiedAt);
 Object.assign(t,{
  accountingVersion:VERSION,policy:fresh.policy,status:'OPEN',
  tp1Hit:false,tp2Hit:false,slHit:false,tp1At:null,tp2At:null,slAt:null,
  closedAt:null,reason:null,lastBar:null,lastPrice:null,dataGapAt:null
 });
 delete t.runnerStop;delete t.partialNetR;delete t.netR;delete t.lastMarkedR;
 delete t.closedPrice;
 return t;
}
function initScorecard(state){
 if(!state.scorecard||!Array.isArray(state.scorecard.trades))
   state.scorecard={version:VERSION,startAt:FIRST_SIGNAL.notifiedAt,trades:[]};
 const card=state.scorecard;
 if(!card.trades.some(t=>t.key===FIRST_SIGNAL.key))
   card.trades.unshift(createTrade(FIRST_SIGNAL,FIRST_SIGNAL.notifiedAt));
 for(const t of card.trades)upgradeTrade(t);
 card.version=VERSION;
 return card;
}
function validBar(b){
 return Number.isFinite(Number(b.t))&&Number.isFinite(Number(b.h))&&
   Number.isFinite(Number(b.l))&&Number.isFinite(Number(b.c))&&
   Number(b.l)<=Number(b.h)&&Number(b.c)>=Number(b.l)&&Number(b.c)<=Number(b.h);
}
function reached(trade,bar,level,isTarget){
 return isTarget?
  (trade.side==='LONG'?Number(bar.h)>=level:Number(bar.l)<=level):
  (trade.side==='LONG'?Number(bar.l)<=level:Number(bar.h)>=level);
}
function applyBars(trade,bars,now=Date.now()){
 if(trade.status!=='OPEN')return trade;
 const sorted=[...bars].sort((a,b)=>a.t-b.t);
 let next=trade.lastBar===null?trade.eligibleFrom:trade.lastBar+MINUTE;
 const completeThrough=Math.floor(now/MINUTE)*MINUTE;
 for(const bar of sorted){
  if(bar.t<next||bar.t>=completeThrough)continue;
  if(bar.t>next){trade.dataGapAt=next;break;}
  if(!validBar(bar)){trade.dataGapAt=bar.t;break;}
  const sl=reached(trade,bar,trade.stop,false);
  const tp1=reached(trade,bar,trade.tp1,true);
  const tp2=reached(trade,bar,trade.tp2,true);
  // Record milestones only once. TP2 also implies TP1's threshold was
  // achieved; gaps can skip the exact TP1 trade price.
  if(tp1||tp2){
   if(!trade.tp1Hit){trade.tp1Hit=true;trade.tp1At=bar.t+MINUTE;}
  }
  if(tp2&&!trade.tp2Hit){trade.tp2Hit=true;trade.tp2At=bar.t+MINUTE;}
  if(sl&&!trade.slHit){trade.slHit=true;trade.slAt=bar.t+MINUTE;}
  if(sl&&tp1){
   trade.status='AMBIGUOUS';
   trade.reason=tp2?'SL_AND_TP2_SAME_MINUTE':'SL_AND_TP1_SAME_MINUTE';
   trade.closedAt=bar.t+MINUTE;
  }else if(sl){
   trade.status='SL';trade.closedAt=bar.t+MINUTE;
  }else if(tp2){
   trade.status='TP2';trade.closedAt=bar.t+MINUTE;
  }
  trade.lastBar=bar.t;
  trade.lastPrice=Number(bar.c);
  next=bar.t+MINUTE;
  if(trade.status!=='OPEN')break;
 }
 return trade;
}
function stats(card){
 const trades=card?.trades||[];
 return {
  tracked:trades.length,
  open:trades.filter(t=>t.status==='OPEN').length,
  finished:trades.filter(t=>t.status!=='OPEN').length,
  slHits:trades.filter(t=>t.slHit).length,
  tp1Hits:trades.filter(t=>t.tp1Hit).length,
  tp2Hits:trades.filter(t=>t.tp2Hit).length,
  ambiguous:trades.filter(t=>t.status==='AMBIGUOUS').length,
  dataGaps:trades.filter(t=>t.status==='OPEN'&&t.dataGapAt!==null&&t.dataGapAt!==undefined).length
 };
}
module.exports={FIRST_SIGNAL,createTrade,upgradeTrade,initScorecard,applyBars,stats};
