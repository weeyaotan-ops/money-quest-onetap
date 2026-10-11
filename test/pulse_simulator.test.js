'use strict';
const assert=require('node:assert/strict');
const sim=require('../hunter_core_v1/pulse_simulator');
const {createTrade,applyBars,initScorecard}=require('../hunter_core_v1/pulse_scorecard');
const M=60000,T=Date.parse('2026-10-11T11:00:00Z');
const long={key:'test',symbol:'BTCUSDT',side:'LONG',mode:'RETEST',
 entry:100,stop:99,tp1:101,tp2:102};
const short={...long,key:'short',side:'SHORT',entry:100,stop:101,tp1:99,tp2:98};
function b(t,h,l,c){return {t,h,l,c};}
function run(signal,bars){const t=createTrade(signal,T);applyBars(t,bars,T+(bars.length+2)*M);return t;}
const full=run(long,[b(T,101.3,100.2,101.2),b(T+M,102.1,101.1,102)]);
assert.equal(full.simulation.status,'TP2');
assert.equal(full.simulation.grossR,1.5);
assert(full.simulation.estimatedNetR<1.5,'estimated fee/slippage must be deducted');
const stop=run(long,[b(T,100.4,98.9,99.1)]);
assert.equal(stop.simulation.status,'SL');assert.equal(stop.simulation.grossR,-1);
const breakeven=run(long,[b(T,101.4,100.1,101.3),b(T+M,101.4,99.9,100.2)]);
assert.equal(breakeven.simulation.status,'BE_EXIT');assert.equal(breakeven.simulation.grossR,0.5);
const ambiguousSL=run(long,[b(T,101.4,98.5,100.5)]);
assert.equal(ambiguousSL.simulation.status,'AMBIGUOUS');
assert.equal(ambiguousSL.simulation.estimatedNetR,null);
const ambiguousBE=run(long,[b(T,101.1,99.9,101.0)]);
assert.equal(ambiguousBE.simulation.status,'AMBIGUOUS');
const ambiguousAfter=run(long,[b(T,101.2,100.1,101),b(T+M,102.2,99.8,101)]);
assert.equal(ambiguousAfter.simulation.status,'AMBIGUOUS');
const shortWinner=run(short,[b(T,99.9,98.7,99.0),b(T+M,98.9,97.9,98.1)]);
assert.equal(shortWinner.simulation.status,'TP2');
const old=createTrade({...long,key:'historical'},T);
delete old.simulation;old.status='TP2';old.tp1Hit=true;old.tp2Hit=true;
const state={scorecard:{version:3,trades:[old]}};
initScorecard(state);
assert.equal(old.status,'TP2');assert.equal(old.tp2Hit,true);
assert.equal(old.simulation.status,'HISTORICAL_UNVERIFIED');
assert.equal(sim.summarize([old,full,stop,breakeven,ambiguousSL]).closed,3);
assert.equal(sim.summarize([old,full,stop,breakeven,ambiguousSL]).uncertain,1);
assert.equal(sim.summarize([old,full,stop,breakeven,ambiguousSL]).historical,1);
assert.match(sim.paperLabel(full),/est. net/);
assert.match(sim.paperLabel(old),/not verified/);
console.log('PULSE_SIMULATOR_TEST_PASS');