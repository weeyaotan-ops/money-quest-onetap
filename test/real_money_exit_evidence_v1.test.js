'use strict';
const assert=require('node:assert/strict');
const {updateExcursion,finalizeHold}=require('../real_money_exit_evidence_v1');

let t={actualRisk:2,openedAt:'2026-09-18T00:00:00.000Z'};
let p={unrealizedProfit:'1.0'};
let x=updateExcursion(t,p,Date.parse('2026-09-18T00:05:00.000Z'));
assert.equal(x.lastUnrealizedR,0.5);
assert.equal(x.maxUnrealizedR,0.5);
assert.equal(x.minUnrealizedR,0.5);

t={...t,...x};
p={unrealizedProfit:'-0.8'};
x=updateExcursion(t,p,Date.parse('2026-09-18T00:10:00.000Z'));
assert.equal(x.maxUnrealizedR,0.5);
assert.equal(x.minUnrealizedR,-0.4);
assert.equal(x.lastUnrealizedR,-0.4);

const h=finalizeHold(t,'2026-09-18T00:30:00.000Z');
assert.equal(h.holdMs,30*60*1000);
console.log('REAL_MONEY_EXIT_EVIDENCE_V1_TEST_PASS');
