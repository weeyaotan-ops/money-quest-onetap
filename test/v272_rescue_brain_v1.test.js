'use strict';

const assert = require('node:assert/strict');
const brain = require('../research/v272_rescue_brain_v1');

const valid = brain.executionGate({
  side: 'SELL', entry: 100, sl: 101, tp: 98,
  frictionBps: 12, spreadBps: 1.2, quoteAgeMs: 100
});
assert.equal(valid.pass, true);

const narrow = brain.executionGate({
  side: 'BUY', entry: 100, sl: 99.95, tp: 100.10,
  frictionBps: 12, spreadBps: 0.8, quoteAgeMs: 100
});
assert.equal(narrow.pass, false);
assert.ok(narrow.reasons.includes('STOP_TOO_NARROW_FOR_COSTS'));

const wideSpread = brain.executionGate({
  side: 'SELL', entry: 100, sl: 101, tp: 98,
  frictionBps: 12, spreadBps: 3.0, quoteAgeMs: 100
});
assert.equal(wideSpread.pass, false);
assert.ok(wideSpread.reasons.includes('SPREAD_TOO_WIDE'));

console.log('V272_RESCUE_BRAIN_V1_TESTS_PASS');
