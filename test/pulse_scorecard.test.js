'use strict';
const assert=require('node:assert/strict');
const {FIRST_SIGNAL,createTrade,initScorecard,applyBars,stats,netR}=require('../hunter_core_v1/pulse_scorecard');
const T=Date.parse('2026-10-08T10:34:00Z'),M=60000;
const short={key:'s',symbol:'SOLUSDT',side:'SHORT',entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093};
const long={key:'l',symbol:'BTCUSDT',side:'LONG',entry:100,stop:99,tp1:101,tp2:102};
const b=(time,high,low,close)=>({t:time,h:high,l:low,c:close});
const closeTo=(actual,expected)=>assert(Math.abs(actual-expected)<0.002,'expected '+expected+', got '+actual);
const state={},card=initScorecard(state);
assert.equal(card.version,2);assert.equal(card.trades.length,1);
assert.equal(card.trades[0].source,FIRST_SIGNAL.source);
assert.equal(card.trades[0].eligibleFrom,T);
initScorecard(state);assert.equal(card.trades.length,1);

// TP1 locks exactly 50%, then runner exits at TP2.
const tp2=createTrade(short,T);
applyBars(tp2,[b(T,114.7,114.30,114.4),b(T+M,114.4,113.7,113.75)],T+3*M);
assert.equal(tp2.status,'OPEN');
assert.equal(tp2.tp1Hit,true);assert.equal(tp2.runnerStop,tp2.entry);
closeTo(tp2.partialNetR,0.5*netR(tp2,tp2.tp1));
applyBars(tp2,[b(T+2*M,113.8,113.00,113.05)],T+4*M);
assert.equal(tp2.status,'TP2');
closeTo(tp2.netR,0.5*netR(tp2,tp2.tp1)+0.5*netR(tp2,tp2.tp2));
const finished=tp2.netR;applyBars(tp2,[b(T+3*M,120,100,110)],T+5*M);
assert.equal(tp2.netR,finished); // closed trades cannot change

// TP1 then return to entry -> BE on runner; entry BE isn't fee-free.
const be=createTrade(short,T);
applyBars(be,[b(T,114.3,113.7,113.8)],T+2*M);
assert.equal(be.status,'OPEN');assert.equal(be.tp1Hit,true);
applyBars(be,[b(T+M,114.6,113.9,114.55)],T+3*M);
assert.equal(be.status,'BE');closeTo(be.netR,0.5*netR(be,be.tp1)+0.5*netR(be,be.entry));
assert(be.netR>0&&be.netR<0.5);

// STOP before TP1 = 100% original risk.
const stop=createTrade(short,T);
applyBars(stop,[b(T,115.3,114.8,115.1)],T+2*M);
assert.equal(stop.status,'SL');assert.equal(stop.netR,-1);assert.equal(stop.tp1Hit,false);

// TP1 and original stop in one unknown minute: do NOT count a winner.
const ambiguousInitial=createTrade(short,T);
applyBars(ambiguousInitial,[b(T,115.4,113.7,114)],T+2*M);
assert.equal(ambiguousInitial.status,'AMBIGUOUS');
assert.equal(ambiguousInitial.reason,'SL_AND_TP1_SAME_MINUTE');
assert.equal(ambiguousInitial.netR,null);

// Newly triggered TP1 + BE in SAME minute: unknown intrabar order.
const ambiguousFirst=createTrade(short,T);
applyBars(ambiguousFirst,[b(T,114.6,113.7,113.8)],T+2*M);
assert.equal(ambiguousFirst.status,'AMBIGUOUS');
assert.equal(ambiguousFirst.reason,'TP1_AND_BE_SAME_MINUTE');

// Existing runner sees BE and TP2 in same minute: cannot select favorable first hit.
const ambiguousRunner=createTrade(short,T);
applyBars(ambiguousRunner,[b(T,114.3,113.7,113.8)],T+2*M);
applyBars(ambiguousRunner,[b(T+M,114.6,113,113.5)],T+3*M);
assert.equal(ambiguousRunner.status,'AMBIGUOUS');
assert.equal(ambiguousRunner.reason,'BE_AND_TP2_SAME_MINUTE');

// LONG symmetry, TP1 then BE and TP1 then TP2.
const longBE=createTrade(long,T);
applyBars(longBE,[b(T,101.2,100.1,101.1),b(T+M,101.3,99.99,100)],T+3*M);
assert.equal(longBE.status,'BE');
const longTP2=createTrade({...long,key:'l2'},T);
applyBars(longTP2,[b(T,101.2,100.1,101.1),b(T+M,102.1,101.1,102.05)],T+3*M);
assert.equal(longTP2.status,'TP2');

// Strict candle sequencing, incomplete candles, missing history, and v1 migration.
const gap=createTrade({...short,key:'gap'},T);
applyBars(gap,[b(T+M,115.3,113,114)],T+3*M);
assert.equal(gap.status,'OPEN');assert.equal(gap.dataGapAt,T);
const wait=createTrade({...short,key:'wait'},T);
applyBars(wait,[b(T,115.4,113,113.1)],T+30*1000);
assert.equal(wait.status,'OPEN');
const legacy=createTrade({...short,key:'legacy'},T);
legacy.accountingVersion=undefined;legacy.tp1Hit=true;legacy.tp1At=T+M;legacy.lastBar=T;
const migrateCard={scorecard:{version:1,trades:[legacy]}};
initScorecard(migrateCard);
assert.equal(legacy.accountingVersion,2);
assert.equal(legacy.status,'OPEN');assert.equal(legacy.lastBar,null);
assert.equal(legacy.tp1Hit,false);
assert.equal(legacy.legacyAccounting.tp1Hit,true);
initScorecard(migrateCard);
assert.equal(legacy.lastBar,null);
assert.equal(migrateCard.scorecard.trades.filter(x=>x.key===FIRST_SIGNAL.key).length,1);
const summary=stats({trades:[tp2,be,stop,ambiguousFirst,ambiguousInitial,ambiguousRunner,gap]});
assert.equal(summary.tracked,7);assert.equal(summary.completed,3);
assert.equal(summary.wins,2);assert.equal(summary.losses,1);assert.equal(summary.uncertain,3);
assert.equal(summary.open,1);assert(summary.maxDrawdownR>=0);
assert(summary.tp1Secured===0);
console.log('PULSE_SCORECARD_TEST_PASS');
