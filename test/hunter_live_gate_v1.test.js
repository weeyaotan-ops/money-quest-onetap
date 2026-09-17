'use strict';
const assert=require('node:assert');
const {HunterLiveGateV1}=require('../hunter_live_gate_v1');

const g=new HunterLiveGateV1({minSamples:2,recentWindow:4,symbolWindow:6,sideWindow:6,minProfitFactor:.9,maxRecentDrawdownR:3});
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
console.log('hunter_live_gate_v1.test.js PASS',JSON.stringify({bad:bad.verdict,good:good.verdict,forward:report.forward}));
