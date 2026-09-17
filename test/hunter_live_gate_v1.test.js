'use strict';
const assert=require('node:assert');
const {HunterLiveGateV1}=require('../hunter_live_gate_v1');

const g=new HunterLiveGateV1({minSamples:4,recentWindow:6,symbolWindow:6,sideWindow:6,minProfitFactor:.9,maxRecentDrawdownR:3});
[
 {id:'1',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-1},
 {id:'2',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-.8},
 {id:'3',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-.7},
 {id:'4',symbol:'BADUSDT',side:'BUY',regime:'RANGE',actualR:-.6},
 {id:'5',symbol:'GOODUSDT',side:'SELL',regime:'TREND',actualR:1.5},
 {id:'6',symbol:'GOODUSDT',side:'SELL',regime:'TREND',actualR:1.2}
].forEach(x=>g.ingestClosedTrade(x));

const bad=g.scoreCandidate({symbol:'BADUSDT',side:'BUY',regime:'RANGE'});
assert.equal(bad.observationalOnly,true);
assert.equal(bad.liveExecutionChanged,false);
assert.ok(['REJECT','WATCH'].includes(bad.verdict));
assert.ok(bad.score<0.5);

const report=g.report();
assert.equal(report.name,'HUNTER_LIVE_GATE_V1');
assert.equal(report.mode,'OBSERVATIONAL_ONLY');
assert.equal(report.all.n,6);
assert.ok(Number.isFinite(report.all.expectancyR));
console.log('hunter_live_gate_v1.test.js PASS',JSON.stringify({badVerdict:bad.verdict,badScore:bad.score,report:report.all}));
