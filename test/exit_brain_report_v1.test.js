'use strict';
const assert=require('node:assert');
const {buildExitBrainReport}=require('../exit_brain_report_v1');

const rows=[
 {id:'a',status:'CLOSED',side:'BUY',regime:'HIGH_VOL',timeframe:'5m',edge:'X',actualR:-1,mfeR:.7,maeR:-1.1,holdSec:600,excursionSamples:12,closedAt:'2026-01-01T00:00:00Z'},
 {id:'b',status:'CLOSED',side:'BUY',regime:'HIGH_VOL',timeframe:'5m',edge:'X',actualR:1.2,mfeR:1.9,maeR:-.2,holdSec:300,excursionSamples:8,closedAt:'2026-01-01T01:00:00Z'},
 {id:'c',status:'CLOSED',side:'SELL',regime:'TREND',timeframe:'15m',edge:'Y',actualR:-.8,mfeR:.1,maeR:-.9,holdSec:420,excursionSamples:9,closedAt:'2026-01-01T02:00:00Z'},
 {id:'d',status:'CLOSED',side:'SELL',regime:'TREND',timeframe:'15m',edge:'Y',actualR:2,mfeR:2.1,maeR:-.1,holdSec:720,excursionSamples:15,closedAt:'2026-01-01T03:00:00Z'},
 {id:'missing',status:'CLOSED',side:'BUY',actualR:-1,mfeR:null,maeR:null,excursionSamples:0}
];
const r=buildExitBrainReport(rows);
assert.equal(r.mode,'OBSERVATIONAL_ONLY');
assert.equal(r.liveExecutionChanged,false);
assert.equal(r.dataQuality.usableClosed,4);
assert.equal(r.dataQuality.totalClosed,5);
assert.equal(r.overall.n,4);
assert.equal(r.overall.wins,2);
assert.equal(r.overall.losses,2);
assert.equal(r.overall.lostAfterProfit.n,1);
assert.equal(r.overall.neverWorked.n,1);
assert.equal(r.overall.winnerGiveback.n,1);
assert.equal(r.evidence.side.find(x=>x.key==='BUY').n,2);
assert.equal(r.proofProgress.minimum,30);
console.log('exit_brain_report_v1.test.js PASS',JSON.stringify(r.overall));
