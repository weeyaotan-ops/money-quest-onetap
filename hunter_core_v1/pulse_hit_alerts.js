'use strict';
// Price-level Telegram milestones, deliberately separate from the trade scanner.
// Uses an on-disk durable pending queue and one notification per trade+level.
// Historical events prior to activation are not retroactively sent.
const LEVELS=[['TP1','tp1Hit','tp1At','tp1'],['TP2','tp2Hit','tp2At','tp2'],['SL','slHit','slAt','stop']];
const MINUTE=60000;
function initialize(state,now=Date.now()){
 if(state.hitAlerts?.version===1)return false;
 const sent={};
 for(const t of (state.scorecard?.trades||[])){
  for(const [level,hit] of LEVELS){
   if(t[hit])sent[t.key+'|'+level]=Number(t[level.toLowerCase()+'At']||now);
  }
 }
 state.hitAlerts={version:1,startedAt:now,pending:{},sent};
 return true;
}
function collect(state){
 const out=state.hitAlerts;if(!out)throw Error('Call initialize first');
 for(const t of (state.scorecard?.trades||[])){
  for(const [level,hit,timeKey] of LEVELS){
   if(!t[hit]||!Number.isFinite(Number(t[timeKey])))continue;
   const at=Number(t[timeKey]),key=t.key+'|'+level;
   if(at<out.startedAt||out.sent[key]||out.pending[key])continue;
   out.pending[key]={key,signalKey:t.key,symbol:t.symbol,side:t.side,
     level,entry:t.entry,stop:t.stop,tp1:t.tp1,tp2:t.tp2,
     at,ambiguous:t.status==='AMBIGUOUS'&&t.closedAt===at,
     reason:t.reason||null,queuedAt:Date.now()};
  }
 }
 return Object.values(out.pending).sort((a,b)=>a.at-b.at||
  (a.level==='TP1'?-1:b.level==='TP1'?1:0));
}
function number(v){return Number(v).toLocaleString('en-US',{useGrouping:false,maximumSignificantDigits:8});}
function levelR(x){
 const risk=Math.abs(x.entry-x.stop);
 if(!(risk>0))return 'N/A';
 const dir=x.side==='LONG'?1:-1;
 const value=x.level==='SL'?x.stop:x.level==='TP1'?x.tp1:x.tp2;
 const r=dir*(value-x.entry)/risk;
 return (r>=0?'+':'')+r.toFixed(2)+'R';
}
function message(event){
 const title=event.level==='SL'?'🛑 SL HIT':event.level==='TP1'?'🎯 TP1 HIT':'🎯 TP2 HIT';
 const price=event.level==='SL'?event.stop:event.level==='TP1'?event.tp1:event.tp2;
 const time=new Date(event.at).toLocaleString('en-GB',{timeZone:'Asia/Singapore',hour12:false,
    day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
 return [
  title+' · '+event.symbol+' '+event.side,
  'Level: '+number(price),
  'RR level: '+levelR(event),
  '1m candle closed: '+time+' SGT',
  event.ambiguous?'⚠ Same 1m candle also touched opposite threshold. Hit order unknown.':null,
  'Price-level hit only · not a Binance order close or actual PnL.'
 ].filter(Boolean).join('\n');
}
async function deliver(state,send,save,now=Date.now()){
 if(!state.hitAlerts)throw Error('Not initialized');
 let count=0;
 const queue=Object.values(state.hitAlerts.pending).sort((a,b)=>a.at-b.at||
   (a.level==='TP1'?-1:b.level==='TP1'?1:0));
 for(const evt of queue){
  if(state.hitAlerts.sent[evt.key]){delete state.hitAlerts.pending[evt.key];continue;}
  // Skip stale events instead of waking users with yesterday's price touches.
  if(now-evt.at>15*MINUTE){
   state.hitAlerts.sent[evt.key]=now;
   delete state.hitAlerts.pending[evt.key];
   save(state);continue;
  }
  try{
   await send(message(evt));
   state.hitAlerts.sent[evt.key]=Date.now();
   delete state.hitAlerts.pending[evt.key];
   save(state);
   count++;
  }catch(e){
   console.error('Hit notification retry pending',evt.symbol,evt.level,String(e.message||e));
   break;
  }
 }
 return count;
}
module.exports={initialize,collect,message,deliver,levelR};
