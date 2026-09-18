'use strict';
const assert=require('node:assert');
const {HunterLiveGateV1,finiteNumber}=require('../hunter_live_gate_v1');

// Regression: missing Actual-R must never be coerced into a fake 0R sample.
assert.equal(finiteNumber(null),null);
assert.equal(finiteNumber(undefined),null);
assert.equal(finiteNumber(''),null);
assert.equal(finiteNumber(0),0);
assert.equal(finiteNumber('0'),0);

const quality=new HunterLiveGateV1();
assert.equal(quality.ingestClosedTrade({id:'missing-null',symbol:'XUSDT',actualR:null}),false);
assert.equal(quality.ingestClosedTrade({id:'missing-undefined',symbol:'XUSDT'}),false);
assert.equal(quality.ingestClosedTrade({id:'missing-empty',symbol:'XUSDT',actualR:''}),false);
assert.equal(quality.history.length,0);
assert.equal(quality.report().dataQuality.ignoredMissingActualR,3);
assert.equal(quality.ingestClosedTrade({id:'real-zero',symbol:'XUSDT',actualR:0}),true);
assert.equal(quality.history.length,1);
assert.equal(quality.report().historicalBackfill.n,1);

const g=new HunterLiveGateV1({minSamples:2,recentWindow:4,symbolWindow:6,sideWindow:6,minProfitFactor:.9,maxRecentDrawdownR:3,negativeExpectancyR:-0.15,positiveExpectancyR:0.15});
[
 {id:'h1',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-1},
 {id:'h2',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-1},
 {id:'h3',symbol:'GOODUSDT',side:'SELL',regime:'TREND',actualR:1},
 {id:'h4',symbol:'GOODUSDT',side:'SELL',regime:'TREND',actualR:1.2}
].forEach(x=>g.ingestClosedTrade(x));

const bad=g.scoreCandidate({id:'m1',symbol:'BADUSDT',side:'BUY',regime:'RANGE',timeframe:'1m',edge:'RANGE_SWEEP_REVERSION'});
const good=g.scoreCandidate({id:'m2',symbol:'GOODUSDT',side:'SELL',regime:'TREND',timeframe:'1m',edge:'TREND_PULLBACK_RECLAIM'});
assert.equal(bad.observationalOnly,true);
assert.equal(bad.liveExecutionChanged,false);
assert.equal(bad.verdict,'REJECT');
assert.equal(good.verdict,'PASS');

assert.equal(g.ingestClosedTrade({id:'m1',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-1.2,netPnl:-3}),true);
assert.equal(g.ingestClosedTrade({id:'m2',symbol:'GOODUSDT',side:'SELL',regime:'TREND',actualR:1.4,netPnl:4}),true);
assert.equal(g.ingestClosedTrade({id:'m2',symbol:'GOODUSDT',side:'SELL',regime:'TREND',actualR:1.4,netPnl:4}),false);

const report=g.report();
assert.equal(report.name,'HUNTER_LIVE_GATE_V1');
assert.equal(report.mode,'OBSERVATIONAL_ONLY');
assert.equal(report.liveExecutionChanged,false);
assert.equal(report.historicalBackfill.n,6);
assert.equal(report.forward.matched,2);
assert.equal(report.forward.rejected.n,1);
assert.equal(report.forward.rejected.totalR,-1.2);
assert.equal(report.forward.pass.n,1);
assert.equal(report.forward.pass.totalR,1.4);
assert.ok(Number.isFinite(report.forward.baseline.expectancyR));
assert.ok(report.evidence);
assert.ok(report.evidence.side.some(x=>x.key==='BUY'));
assert.ok(report.evidence.regime.some(x=>x.key==='RANGE'));
assert.ok(Array.isArray(report.evidence.timeframe));
assert.ok(Array.isArray(report.evidence.edge));
assert.ok(Array.isArray(report.evidence.sideRegime));
assert.ok(Array.isArray(report.evidence.edgeTimeframe));
assert.ok(bad.scopes.timeframe);
assert.ok(bad.scopes.edge);
assert.equal(bad.policyVersion,'V1_1_NEUTRAL_BAND');
console.log('hunter_live_gate_v1.test.js PASS',JSON.stringify({nullRegression:true,bad:bad.verdict,good:good.verdict,forward:report.forward}));

// Neutral-band regression: a tiny negative expectancy is noise, not a REJECT by itself.
const neutral=new HunterLiveGateV1({minSamples:4,recentWindow:4,symbolWindow:4,sideWindow:4,negativeExpectancyR:-0.15,positiveExpectancyR:0.15});
[-0.02,-0.01,0.01,0.02].forEach((r,i)=>neutral.ingestClosedTrade({id:'n'+i,symbol:'MIXUSDT',side:i%2?'SELL':'BUY',regime:'HIGH_VOL',timeframe:'5m',edge:'BREAKOUT_RETEST',actualR:r}));
const nd=neutral.scoreCandidate({id:'neutral-candidate',symbol:'NEWUSDT',side:'BUY',regime:'LOW_VOL',timeframe:'15m',edge:'BREAKOUT_RETEST'});
assert.equal(nd.verdict,'WATCH');
assert.ok(nd.reasons.includes('RECENT_EXPECTANCY_NEUTRAL'));
assert.equal(nd.negativeSignals,0);

// Strong REJECT requires at least two independent negative signals.
const strong=new HunterLiveGateV1({minSamples:4,recentWindow:8,symbolWindow:8,sideWindow:8,negativeExpectancyR:-0.15,positiveExpectancyR:0.15});
for(let i=0;i<8;i++)strong.ingestClosedTrade({id:'s'+i,symbol:'BAD2USDT',side:'SELL',regime:'HIGH_VOL',timeframe:'5m',edge:'BREAKOUT_RETEST',actualR:-1});
const sd=strong.scoreCandidate({id:'strong-candidate',symbol:'BAD2USDT',side:'SELL',regime:'HIGH_VOL',timeframe:'5m',edge:'BREAKOUT_RETEST'});
assert.equal(sd.verdict,'REJECT');
assert.ok(sd.negativeSignals>=2);
