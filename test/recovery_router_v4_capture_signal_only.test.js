'use strict';

const assert = require('node:assert/strict');
const {
  authoritativeCombined,
  selectCaptureRoute,
  captureRatio,
  executionWindow
} = require('../recovery_router_v4_capture_signal_only');

function ticket(overrides = {}) {
  return {
    id: 'TEST:RANGE_MEAN_REVERSION:BUY:1',
    combinedSelected: true,
    symbol: 'TEST',
    setup: 'RANGE_MEAN_REVERSION',
    side: 'BUY',
    entry: 100,
    sl: 99.9,
    tp: 100.25,
    openedAt: new Date(Date.now() - 1000).toISOString(),
    winProb: 0.46,
    ...overrides
  };
}

const cheapVenue = {
  name: 'CHEAP', tradable: true,
  takerFee: 0.0002, makerFee: 0,
  slippageBpsPerSide: 0.2,
  takerFillProbability: 0.995,
  makerEntryFillProbability: 0.9,
  makerRoundTripFillProbability: 0.82
};

const expensiveVenue = {
  name: 'EXPENSIVE', tradable: true,
  takerFee: 0.0006, makerFee: 0.00025,
  slippageBpsPerSide: 1.5,
  takerFillProbability: 0.995,
  makerEntryFillProbability: 0.78,
  makerRoundTripFillProbability: 0.65
};

assert.equal(authoritativeCombined(ticket()), true);
assert.equal(authoritativeCombined(ticket({ combinedSelected: false })), false);

{
  const r = selectCaptureRoute(ticket({ combinedSelected: false }), [cheapVenue]);
  assert.equal(r.action, 'BLOCK');
  assert.equal(r.reason, 'NOT_AUTHORITATIVE_COMBINED');
}

{
  const r = selectCaptureRoute(ticket(), [expensiveVenue, cheapVenue], {
    minNetRRFloor: 0.5,
    minAdjustedEVR: 0,
    minFillProbability: 0.6,
    opportunityCostR: 0.02
  });
  assert.equal(r.action, 'SEND_ONETAP_SIGNAL');
  assert.equal(r.route.venue, 'CHEAP');
  assert.ok(['TAKER_IOC', 'MAKER_ENTRY', 'MAKER_ENTRY_MAKER_TP'].includes(r.route.mode));
  assert.ok(r.route.adjustedEVR >= 0);
}

{
  const impossible = ticket({ entry: 100, sl: 99.99, tp: 100.02, winProb: 0.40 });
  const r = selectCaptureRoute(impossible, [expensiveVenue], {
    minNetRRFloor: 0.5,
    minAdjustedEVR: 0,
    minFillProbability: 0.6
  });
  assert.equal(r.action, 'BLOCK_AFTER_RECOVERY_FAILS');
}

{
  const stale = ticket({ openedAt: new Date(Date.now() - 200000).toISOString() });
  const r = selectCaptureRoute(stale, [cheapVenue], { ttlMs: 90000 });
  assert.equal(r.reason, 'TICKET_EXPIRED');
}

{
  const w = executionWindow(ticket(), { ttlMs: 90000, makerWaitMs: 8000 });
  assert.equal(w.expired, false);
  assert.ok(w.makerWindowMs <= 8000);
}

assert.equal(captureRatio(8, 10), 0.8);
assert.equal(captureRatio(1, 0), null);

console.log('V4_CAPTURE_SIGNAL_ONLY_TESTS_OK');
