'use strict';
const assert=require('node:assert/strict');
const {sampleExcursion}=require('../exit_excursion_sampler_v1');

const t={openedAt:'2026-09-18T00:00:00Z',actualRisk:2,mfeR:.4,maeR:-.2,peakUnrealizedPnl:.8,troughUnrealizedPnl:-.4,excursionSamples:3,holdSec:60};
const p={unrealizedProfit:1.2};
const x=sampleExcursion(t,p,Date.parse('2026-09-18T00:10:00Z'));
assert.equal(x.mfeR,.6);
assert.equal(x.maeR,-.2);
assert.equal(x.peakUnrealizedPnl,1.2);
assert.equal(x.troughUnrealizedPnl,-.4);
assert.equal(x.excursionSamples,4);
assert.equal(x.holdSec,600);

const y=sampleExcursion({...t,mfeR:null,maeR:null,peakUnrealizedPnl:null,troughUnrealizedPnl:null,excursionSamples:0},{unrealizedProfit:-1},Date.parse('2026-09-18T00:01:00Z'));
assert.equal(y.mfeR,0);
assert.equal(y.maeR,-.5);
assert.equal(y.peakUnrealizedPnl,0);
assert.equal(y.troughUnrealizedPnl,-1);
assert.equal(y.excursionSamples,1);
assert.equal(y.holdSec,60);

assert.deepEqual(sampleExcursion({actualRisk:null},{unrealizedProfit:1}),{});
console.log('EXIT_EXCURSION_SAMPLER_V1_TEST_OK');
