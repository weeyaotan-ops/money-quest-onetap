'use strict';
const assert=require('node:assert/strict');
const {FIRST_SIGNAL,createTrade,initScorecard,applyBars,stats}=require('../hunter_core_v1/pulse_scorecard');
const T=Date.parse('2026-10-08T10:34:00Z'),M=60000;
const short={key:'s',symbol:'SOLUSDT',side:'SHORT',entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093};
const long={key:'l',symbol:'BTCUSDT',side:'LONG',entry:100,stop:99,tp1:101,tp2:102};
const bar=(t,h,l,c)=>({t,h,l,c});
const state={},card=initScorecard(state);
assert.equal(card.version,3);
assert.equal(card.trades.length,1);
assert.equal(card.trades[0].source,FIRST_SIGNAL.source);
assert.equal(card.trades[0].eligibleFrom,T);
initScorecard(state);assert.equal(card.trades.length,1);
// TP1 reached, price revisits original entry (not breakeven stop anymore), later TP2.
const tp2=createTrade(short,T);
applyBars(tp2,[bar(T,114.7,114.3,114.4),bar(T+M,114.4,113.7,113.75)],T+3*M);
assert.equal(tp2.status,'OPEN');assert.equal(tp2.tp1Hit,true);
assert.equal(tp2.slHit,false);assert.equal(tp2.tp2Hit,false);
applyBars(tp2,[bar(T+2*M,114.7,114.2,114.5)],T+4*M);
assert.equal(tp2.status,'OPEN');
applyBars(tp2,[bar(T+3*M,113.8,113.00,113.05)],T+5*M);
assert.equal(tp2.status,'TP2');assert.equal(tp2.tp2Hit,true);assert.equal(tp2.slHit,false);
const closedAt=tp2.closedAt;
applyBars(tp2,[bar(T+4*M,120,100,110)],T+6*M);
assert.equal(tp2.closedAt,closedAt);assert.equal(tp2.slHit,false);
// TP1 followed by SL: both thresholds should count exactly once.
const tp1ThenSL=createTrade({...short,key:'tp1ThenSL'},T);
applyBars(tp1ThenSL,[bar(T,114.3,113.7,113.8),bar(T+M,115.3,114.5,115.2)],T+3*M);
assert.equal(tp1ThenSL.status,'SL');
assert.equal(tp1ThenSL.tp1Hit,true);assert.equal(tp1ThenSL.slHit,true);
assert.equal(tp1ThenSL.tp2Hit,false);
// Direct original stop; no TP1.
const stop=createTrade({...short,key:'stop'},T);
applyBars(stop,[bar(T,115.3,114.8,115.1)],T+2*M);
assert.equal(stop.status,'SL');assert.equal(stop.slHit,true);assert.equal(stop.tp1Hit,false);
// Strong bar crossing TP1+TP2 without SL should register both TP levels.
const tp2Direct=createTrade({...short,key:'tp2Direct'},T);
applyBars(tp2Direct,[bar(T,114.5,112.99,113.1)],T+2*M);
assert.equal(tp2Direct.status,'TP2');assert.equal(tp2Direct.tp1Hit,true);assert.equal(tp2Direct.tp2Hit,true);
// Same minute reaches stop + TP1: independent touches are facts, outcome ordering uncertain.
const amb=createTrade({...short,key:'amb'},T);
applyBars(amb,[bar(T,115.4,113.7,114)],T+2*M);
assert.equal(amb.status,'AMBIGUOUS');assert.equal(amb.tp1Hit,true);assert.equal(amb.slHit,true);
assert.equal(amb.reason,'SL_AND_TP1_SAME_MINUTE');
// Same minute touches SL, TP1, TP2; count all touched but not order.
const ambBoth=createTrade({...short,key:'ambBoth'},T);
applyBars(ambBoth,[bar(T,115.4,112.8,114)],T+2*M);
assert.equal(ambBoth.status,'AMBIGUOUS');
assert(ambBoth.slHit&&ambBoth.tp1Hit&&ambBoth.tp2Hit);
// Symmetry for LONG.
const longWin=createTrade(long,T);
applyBars(longWin,[bar(T,102.1,99.9,101.3)],T+2*M);
assert.equal(longWin.status,'AMBIGUOUS');assert(longWin.slHit&&longWin.tp2Hit);
const longTP2=createTrade({...long,key:'long2'},T);
applyBars(longTP2,[bar(T,102.1,100.1,101.5)],T+2*M);
assert.equal(longTP2.status,'TP2');assert(longTP2.tp1Hit&&longTP2.tp2Hit&&!longTP2.slHit);
// Don't assume anything across missing bars or incomplete 1-minute candles.
const gap=createTrade({...short,key:'gap'},T);
applyBars(gap,[bar(T+M,115.3,113,114)],T+3*M);
assert.equal(gap.status,'OPEN');assert.equal(gap.dataGapAt,T);
const partial=createTrade({...short,key:'partial'},T);
applyBars(partial,[bar(T,115.4,113,113.1)],T+30*1000);
assert.equal(partial.status,'OPEN');
// Migrate prior v2 split/BE score without deleting the original history.
const legacy=createTrade({...short,key:'legacy'},T);
legacy.accountingVersion=2;legacy.status='BE';legacy.tp1Hit=true;
legacy.lastBar=T;legacy.netR=0.33;legacy.partialNetR=0.33;
const migrate={scorecard:{version:2,trades:[legacy]}};
initScorecard(migrate);
assert.equal(legacy.accountingVersion,3);
assert.equal(legacy.status,'OPEN');assert.equal(legacy.tp1Hit,false);assert.equal(legacy.lastBar,null);
assert.equal(legacy.previousAccounting.status,'BE');assert.equal(legacy.previousAccounting.netR,0.33);
initScorecard(migrate);
assert.equal(legacy.lastBar,null);
assert.equal(migrate.scorecard.trades.filter(x=>x.key===FIRST_SIGNAL.key).length,1);
const s=stats({trades:[tp2,tp1ThenSL,stop,tp2Direct,amb,ambBoth,longWin,longTP2,gap,partial]});
assert.deepEqual({n:s.tracked,sl:s.slHits,tp1:s.tp1Hits,tp2:s.tp2Hits,uncertain:s.ambiguous,open:s.open},
 {n:10,sl:5,tp1:7,tp2:5,uncertain:3,open:2});
console.log('PULSE_SCORECARD_TEST_PASS');
