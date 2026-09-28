'use strict';

const assert = require('assert');
const { emptyState, stageFromEdge, processCycle, performance } = require('../hunter_core_v1/journal');

function snap(symbol, openTime, high, low, close) {
  return { symbol, candles15m: [{ openTime, high, low, close }] };
}

function result(symbol, decision, edge) {
  return {
    symbol,
    decision,
    edge,
    regime: { name: 'TREND' },
    components: { trend: 0.8, relativeStrength: 0.5, derivatives: 0.3, flow: 0.4 },
    plan: decision === 'NO_TRADE' ? null : {
      entryZone: decision === 'LONG' ? [99, 100] : [100, 101],
      entryMid: 99.5,
      stop: decision === 'LONG' ? 98 : 102,
      riskUsd: 5,
      notional: 300
    }
  };
}

assert.strictEqual(stageFromEdge(0.2), 'NO_TRADE');
assert.strictEqual(stageFromEdge(0.4), 'WATCH');
assert.strictEqual(stageFromEdge(0.55), 'ARMED');
assert.strictEqual(stageFromEdge(-0.7), 'ACTIONABLE');

let state = emptyState();
const t0 = 1000000;
let out = processCycle(state, [result('BTCUSDT', 'LONG', 0.7)], [snap('BTCUSDT', 900000, 101, 100.5, 100.8)], t0);
state = out.state;
assert.strictEqual(out.created.length, 1);
assert.strictEqual(state.signals[0].status, 'PENDING_ENTRY');

// Same setup must not duplicate.
out = processCycle(state, [result('BTCUSDT', 'LONG', 0.72)], [snap('BTCUSDT', 1800000, 101.2, 100.2, 100.9)], t0 + 900000);
assert.strictEqual(out.created.length, 0);
assert.strictEqual(state.signals.length, 1);

// Future candle touches entry but not stop -> triggered.
out = processCycle(state, [result('BTCUSDT', 'LONG', 0.68)], [snap('BTCUSDT', 2700000, 100.4, 98.8, 100.1)], t0 + 1800000);
assert.strictEqual(state.signals[0].status, 'TRIGGERED');

// After >1h, forward R is captured.
out = processCycle(state, [result('BTCUSDT', 'NO_TRADE', 0.1)], [snap('BTCUSDT', 7200000, 101.5, 99.0, 101.0)], t0 + 2 * 60 * 60 * 1000);
assert.ok(Number.isFinite(state.signals[0].r1h));

const p = performance(state);
assert.strictEqual(p.actionable, 1);
assert.strictEqual(p.triggered, 1);

console.log('hunter_journal tests: PASS');
