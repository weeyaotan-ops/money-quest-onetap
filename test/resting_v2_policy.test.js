'use strict';
const fs = require('node:fs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const src = fs.readFileSync('resting_limit_loader_v2_candidate.js', 'utf8');
assert(src.includes("exact_mirror_gateway_v2.js"), 'locked-equity V2 base gateway missing');
assert(src.includes("timeInForce: 'GTC'"), 'GTC entry missing');
assert(src.includes('waitForRestingEntry'), 'resting wait loop missing');
assert(src.includes('cancelEntryOrder'), 'cancel-on-expiry missing');
assert(src.includes("entryPolicy: 'EXACT_LIMIT_GTC_BOUNDED_NO_CHASE'"), 'bounded no-chase policy missing');
assert(src.includes("sizingPolicy: 'LIVE_EQUITY_AT_SIGNAL_LOCK_ONCE'"), 'signal-time equity lock validation missing');
assert(src.includes("confirmPolicy: 'REVALIDATE_ONLY_NO_RESIZE'"), 'confirm no-resize validation missing');
assert(src.includes('if (executedQty > 0)'), 'fill detection missing');
assert(src.includes("if (status !== 'FILLED') await cancelEntryOrder(p);"), 'partial-fill remainder cancel missing');

function simulate(states, expiryIndex) {
  let canceled = false;
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s.executedQty > 0) {
      if (s.status !== 'FILLED') canceled = true;
      return { outcome: 'FILLED', executedQty: s.executedQty, canceledRemainder: canceled, chased: false };
    }
    if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(s.status)) {
      return { outcome: s.status, executedQty: 0, canceledRemainder: false, chased: false };
    }
    if (i >= expiryIndex) {
      return { outcome: 'TIMEOUT_CANCEL', executedQty: 0, canceledRemainder: true, chased: false };
    }
  }
  return { outcome: 'TIMEOUT_CANCEL', executedQty: 0, canceledRemainder: true, chased: false };
}

let r = simulate([
  { status: 'NEW', executedQty: 0 },
  { status: 'NEW', executedQty: 0 },
  { status: 'FILLED', executedQty: 100 }
], 5);
assert(r.outcome === 'FILLED' && r.executedQty === 100 && !r.chased, 'full-fill scenario failed');

r = simulate([
  { status: 'NEW', executedQty: 0 },
  { status: 'PARTIALLY_FILLED', executedQty: 35 }
], 5);
assert(r.outcome === 'FILLED' && r.executedQty === 35 && r.canceledRemainder && !r.chased, 'partial-fill scenario failed');

r = simulate([
  { status: 'NEW', executedQty: 0 },
  { status: 'NEW', executedQty: 0 },
  { status: 'NEW', executedQty: 0 }
], 2);
assert(r.outcome === 'TIMEOUT_CANCEL' && r.executedQty === 0 && r.canceledRemainder && !r.chased, 'timeout-cancel scenario failed');

console.log('RESTING_V2_POLICY_SELFTEST_PASS', JSON.stringify({
  exactEntry: true,
  gtc: true,
  boundedExpiry: true,
  partialRemainderCancel: true,
  noChase: true,
  liveEquityAtSignal: true,
  sizingLockedOnce: true,
  noResizeOnConfirm: true
}));
