'use strict';
const assert=require('node:assert/strict');
const {initialize,collect,message,deliver}=require('../hunter_core_v1/pulse_hit_alerts');
const {createTrade}=require('../hunter_core_v1/pulse_scorecard');
const M=60000,T=Date.parse('2026-10-08T10:34:00Z');
const levels={key:'test|SOL|SHORT',symbol:'SOLUSDT',side:'SHORT',
 entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093};
async function run(){
 const old=createTrade({...levels,key:'old'},T-5*M);
 old.tp1Hit=true;old.tp1At=T-M;
 const state={scorecard:{trades:[old]}};
 assert.equal(initialize(state,T),true);
 assert.equal(initialize(state,T+M),false); // don't reset dedup
 assert.equal(collect(state).length,0); // historical milestone must not ping
 assert(state.hitAlerts.sent['old|TP1']);
 const fresh=createTrade({...levels,key:'fresh'},T+M);
 state.scorecard.trades.push(fresh);
 fresh.tp1Hit=true;fresh.tp1At=T+2*M;
 fresh.tp2Hit=true;fresh.tp2At=T+3*M;fresh.status='TP2';
 let events=collect(state);
 assert.deepEqual(events.map(x=>x.level),['TP1','TP2']);
 assert.match(message(events[0]),/TP1 HIT/);
 assert.match(message(events[0]),/\+1\.00R/);
 assert.match(message(events[1]),/\+2\.00R/);
 assert.match(message(events[1]),/not a Binance order close/);
 assert.equal(collect(state).length,2); // pending dedup
 const sent=[];let saves=0;
 assert.equal(await deliver(state,async m=>sent.push(m),()=>saves++,T+4*M),2);
 assert.equal(sent.length,2);assert.equal(saves,2);
 assert.equal(await deliver(state,async m=>sent.push(m),()=>saves++,T+5*M),0);
 assert.equal(sent.length,2); // no duplicates on next scan
 // TP1 followed by original stop triggers an SL alert as well.
 const later=createTrade({...levels,key:'later'},T+M);
 state.scorecard.trades.push(later);
 later.tp1Hit=true;later.tp1At=T+2*M;
 later.slHit=true;later.slAt=T+4*M;later.status='SL';
 events=collect(state);
 assert.deepEqual(events.map(x=>x.level),['TP1','SL']);
 assert.match(message(events[1]),/SL HIT/);
 assert.match(message(events[1]),/-1\.00R/);
 // A failed Telegram request remains queued for next scan.
 let throws=0;
 await deliver(state,async()=>{throws++;throw Error('network failure')},()=>saves++,T+5*M);
 assert.equal(throws,1);
 assert.equal(Object.keys(state.hitAlerts.pending).length,2);
 assert.equal(await deliver(state,async m=>sent.push(m),()=>saves++,T+5*M),2);
 assert.equal(Object.keys(state.hitAlerts.pending).length,0);
 const ambiguous=createTrade({...levels,key:'amb'},T+M);
 ambiguous.tp1Hit=true;ambiguous.tp1At=T+6*M;
 ambiguous.slHit=true;ambiguous.slAt=T+6*M;
 ambiguous.status='AMBIGUOUS';ambiguous.closedAt=T+6*M;
 ambiguous.reason='SL_AND_TP1_SAME_MINUTE';
 state.scorecard.trades.push(ambiguous);
 events=collect(state);
 assert.equal(events.length,2);
 assert.match(message(events[0]),/Hit order unknown/);
 // Stale events (e.g. after long downtime) should not spam users.
 const stale=createTrade({...levels,key:'stale'},T+M);
 stale.tp1Hit=true;stale.tp1At=T+7*M;
 state.scorecard.trades.push(stale);
 collect(state);
 const before=sent.length;
 await deliver(state,async m=>sent.push(m),()=>saves++,T+30*M);
 assert.equal(before,sent.length);assert.equal(Object.keys(state.hitAlerts.pending).length,0);
 console.log('PULSE_HIT_ALERTS_TEST_PASS');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
