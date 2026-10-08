'use strict';
// Persistent signal-only scorecard. Model assumes reference entry at alert time,
// no actual exchange fill, whole position stays open until SL or TP2.
// TP1 is a milestone only. Outcomes on uncertain candles are not wins.
const MINUTE=60000;
const FIRST_SIGNAL={
  key:'SOLUSDT|SHORT|2026-10-08T10:33Z',symbol:'SOLUSDT',side:'SHORT',
  entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093,
  notifiedAt:Date.parse('2026-10-08T10:33:00Z'),
  eligibleFrom:Date.parse('2026-10-08T10:34:00Z'),
  source:'SCREENSHOT_2026-10-08_18_33_SGT',timingNote:'First alert time known only to minute; excluded that minute'
};
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
  status:'OPEN',tp1Hit:false,tp1At:null,closedAt:null,closedPrice:null,netR:null,
  lastBar:null,lastPrice:null,lastMarkedR:null
 };
}
function initScorecard(state){
 if(!state.scorecard||!Array.isArray(state.scorecard.trades)){
  state.scorecard={version:1,startAt:FIRST_SIGNAL.notifiedAt,trades:[]};
 }
 const ledger=state.scorecard;
 if(!ledger.trades.some(t=>t.key===FIRST_SIGNAL.key)){
  ledger.trades.unshift(createTrade(FIRST_SIGNAL,FIRST_SIGNAL.notifiedAt));
 }
 return ledger;
}
function netR(t,exit){
 const d=t.side==='LONG'?1:-1,risk=d*(t.entry-t.stop);
 if(!(risk>0))return null;
 // Same cost approximation as the scanner's 1.5R gate.
 const roundtripCost=0.0012*t.entry;
 return Math.round(((d*(exit-t.entry)-roundtripCost)/(risk+roundtripCost))*1000)/1000;
}
function cross(t,bar){
 const high=Number(bar.h),low=Number(bar.l);
 if(!Number.isFinite(high)||!Number.isFinite(low)||low>high)return {bad:true};
 const isLong=t.side==='LONG';
 return {
  stop:isLong?low<=t.stop:high>=t.stop,
  tp1:isLong?high>=t.tp1:low<=t.tp1,
  tp2:isLong?high>=t.tp2:low<=t.tp2
 };
}
function applyBars(trade,bars,now=Date.now()){
 if(trade.status!=='OPEN')return trade;
 const sorted=[...bars].sort((a,b)=>a.t-b.t);
 let next=trade.lastBar===null?trade.eligibleFrom:trade.lastBar+MINUTE;
 const completeThrough=Math.floor(now/MINUTE)*MINUTE;
 for(const b of sorted){
  if(b.t<next||b.t>=completeThrough)continue;
  if(b.t>next){
   // Never assume what happened during missing price history.
   trade.dataGapAt=next;break;
  }
  const hit=cross(trade,b);
  if(hit.bad){trade.dataGapAt=b.t;break;}
  if(hit.stop&&hit.tp2){
   trade.status='AMBIGUOUS';trade.closedAt=b.t+MINUTE;trade.closedPrice=null;
   trade.netR=null;trade.reason='SL_AND_TP2_SAME_MINUTE';
  }else if(hit.stop){
   trade.status='SL';trade.closedAt=b.t+MINUTE;trade.closedPrice=trade.stop;
   trade.netR=netR(trade,trade.stop);
  }else if(hit.tp2){
   trade.status='TP2';trade.closedAt=b.t+MINUTE;trade.closedPrice=trade.tp2;
   trade.netR=netR(trade,trade.tp2);
   trade.tp1Hit=true;trade.tp1At??=b.t+MINUTE;
  }else if(hit.tp1&&!trade.tp1Hit){
   trade.tp1Hit=true;trade.tp1At=b.t+MINUTE;
  }
  trade.lastBar=b.t;trade.lastPrice=b.c;
  if(trade.status==='OPEN')trade.lastMarkedR=netR(trade,Number(b.c));
  next=b.t+MINUTE;
  if(trade.status!=='OPEN')break;
 }
 return trade;
}
function stats(card){
 const trades=card?.trades||[];
 const done=trades.filter(t=>['SL','TP2'].includes(t.status)&&Number.isFinite(t.netR)).sort((a,b)=>a.closedAt-b.closedAt);
 const wins=done.filter(t=>t.netR>0).length, losses=done.filter(t=>t.netR<0).length;
 let total=0,peak=0,maxDrawdown=0,streak=0,maxLossStreak=0;
 for(const t of done){
  total+=t.netR;peak=Math.max(peak,total);
  maxDrawdown=Math.max(maxDrawdown,peak-total);
  streak=t.netR<0?streak+1:0;maxLossStreak=Math.max(maxLossStreak,streak);
 }
 return {tracked:trades.length,open:trades.filter(t=>t.status==='OPEN').length,
  uncertain:trades.filter(t=>t.status==='AMBIGUOUS').length,
  completed:done.length,wins,losses,winRate:done.length?wins/done.length:null,
  totalNetR:Math.round(total*1000)/1000,
  averageNetR:done.length?Math.round(total/done.length*1000)/1000:null,
  maxDrawdownR:Math.round(maxDrawdown*1000)/1000,maxLossStreak};
}
module.exports={FIRST_SIGNAL,createTrade,initScorecard,applyBars,stats,netR};
