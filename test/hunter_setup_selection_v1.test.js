'use strict';
const assert=require('node:assert/strict');
const {confirmedSetups,stopSupportsSetup}=require('../opportunity_hunter_setup_v1');
const {huntConfirmed:hunt}=require('../opportunity_hunter_v1');
const {closedMetrics}=require('../opportunity_hunter_quality_v1');
const base=()=>({mom:40,er:.2,vol:40,high20:110,low20:90,pattern:{
  last:{open:100,high:102,low:98,close:101},previous:{open:99,high:102,low:97,close:100},
  priorHigh20:110,priorLow20:90,ema8:101,ema20:100,previousEma20:100,priorAtr14:4,lastTR:4}});
function mirror(m){
  const r=structuredClone(m),p=r.pattern;
  r.mom=-m.mom;r.high20=200-m.low20;r.low20=200-m.high20;
  for(const field of ['last','previous']){const x=m.pattern[field];p[field]={open:200-x.open,high:200-x.low,low:200-x.high,close:200-x.close}}
  p.priorHigh20=200-m.pattern.priorLow20;p.priorLow20=200-m.pattern.priorHigh20;
  for(const field of ['ema8','ema20','previousEma20'])p[field]=200-m.pattern[field];
  return r;
}
function pair(m,edge){
  assert.ok(confirmedSetups(m).some(x=>x.edge===edge&&x.side==='BUY'),edge);
  assert.ok(confirmedSetups(mirror(m)).some(x=>x.edge===edge&&x.side==='SELL'),edge+' mirrored');
}
const range=base();range.er=.1;
assert.deepEqual(confirmedSetups(range),[],'midpoint does not establish a sweep');
range.pattern.last={open:89,high:94,low:88,close:93};
pair(range,'RANGE_SWEEP_REVERSION');
assert.equal(confirmedSetups(range).length,1,'range direction cannot be relabeled as expansion');
const both=structuredClone(range);both.pattern.last.high=111;
assert.deepEqual(confirmedSetups(both),[],'two-sided sweep is ambiguous');

const retest=base();retest.pattern.priorHigh20=100;
retest.pattern.previous={open:99,high:103,low:99,close:102};
retest.high20=103;retest.pattern.last={open:100.5,high:103.5,low:99.8,close:102};
pair(retest,'BREAKOUT_RETEST');
const noTouch=structuredClone(retest);noTouch.pattern.last.low=100.1;
assert.ok(!confirmedSetups(noTouch).some(x=>x.edge==='BREAKOUT_RETEST'));
const failed=structuredClone(retest);failed.pattern.last.close=99;
assert.ok(!confirmedSetups(failed).some(x=>x.edge==='BREAKOUT_RETEST'));
const noBreak=structuredClone(retest);noBreak.pattern.previous.close=100;
assert.ok(!confirmedSetups(noBreak).some(x=>x.edge==='BREAKOUT_RETEST'));

const reclaim=base();reclaim.er=.5;reclaim.pattern.previous.close=99;
reclaim.pattern.last={open:99,high:103,low:98,close:102};
pair(reclaim,'TREND_PULLBACK_RECLAIM');
const noReclaim=structuredClone(reclaim);noReclaim.pattern.previous.close=101;
assert.ok(!confirmedSetups(noReclaim).some(x=>x.edge==='TREND_PULLBACK_RECLAIM'));

const momentum=base();momentum.er=.4;
momentum.pattern.last={open:102,high:105,low:101,close:104};
pair(momentum,'MOMENTUM_CONTINUATION');
const against=structuredClone(momentum);against.mom=-40;
assert.deepEqual(confirmedSetups(against),[],'a rising candle does not confirm a short continuation');

const expansion=base();expansion.pattern.last={open:109,high:113,low:108,close:112};
expansion.pattern.lastTR=5;expansion.pattern.priorAtr14=2;
pair(expansion,'VOLATILITY_EXPANSION');
const noExpansion=structuredClone(expansion);noExpansion.pattern.lastTR=2;
assert.deepEqual(confirmedSetups(noExpansion),[]);
assert.deepEqual(confirmedSetups({...expansion,mom:-40}),[]);
assert.deepEqual(confirmedSetups({...expansion,pattern:undefined}),[]);

const setup=confirmedSetups(expansion)[0];
assert.equal(stopSupportsSetup(setup,107),true);
assert.equal(stopSupportsSetup(setup,108),false);
assert.equal(stopSupportsSetup(setup,109),false);
const short=confirmedSetups(mirror(expansion))[0];
assert.equal(stopSupportsSetup(short,93),true);
assert.equal(stopSupportsSetup(short,92),false);
assert.equal(stopSupportsSetup(setup,NaN),false);

const input={symbol:'TEST',sourceSide:'BUY',sourceSetup:'RANGE_SWEEP_REVERSION',spreadBps:1,rr:1.8,
  entry:100,sl:98,tp:103.6,market:{mom:40,er:.1,vol:40}};
assert.equal(hunt(input).action,'NO_TRADE','unconfirmed scores cannot create a signal');
const confirmed=hunt({...input,setupConfirmed:true});
assert.equal(confirmed.action,'ONE_TAP_CANDIDATE');
assert.equal(confirmed.edge,'RANGE_SWEEP_REVERSION');
assert.equal(hunt({...input,setupConfirmed:true,sourceSide:'SELL',sourceSetup:'VOLATILITY_EXPANSION'}).action,'NO_TRADE');

// Pattern baselines exclude the breakout and retest bars, and ignore active bars.
const now=Date.UTC(2026,0,1),bars=Array.from({length:61},(_,i)=>[now-(60-i)*60000,100,101,99,100,1,now-(60-i)*60000+59999]);
bars[58]=[bars[58][0],100,104,99,103,1,bars[58][6]];
bars[59]=[bars[59][0],102,105,100,104,1,bars[59][6]];
const metrics=closedMetrics(bars,'1m',now);
assert.equal(metrics.pattern.priorHigh20,101);assert.equal(metrics.high20,104);
assert.equal(metrics.pattern.last.close,104);assert.equal(metrics.pattern.previous.close,103);
bars[60][2]=100000;bars[60][4]=99999;
assert.deepEqual(closedMetrics(bars,'1m',now),metrics);
assert.ok(confirmedSetups(metrics).some(x=>x.edge==='BREAKOUT_RETEST'));
console.log('HUNTER_SETUP_SELECTION_V1_PASS');
