'use strict';

const assert = require('assert');
const { inspectSession } = require('../session_breakout_check');

const M15 = 15 * 60_000;

function c(openTime, open, high, low, close, volume = 100) {
  return { openTime, open, high, low, close, volume };
}

function bullishH4(endTime) {
  const rows = [];
  let px = 100;
  for (let i = 0; i < 60; i += 1) {
    const open = px;
    px += 0.5;
    rows.push({
      openTime: endTime - (60 - i) * 4 * 60 * 60_000,
      open,
      high: px + 1,
      low: open - 1,
      close: px,
      volume: 1000
    });
  }
  return rows;
}

(function freshBreakoutOnly() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) {
    bars.push(c(t, 100, 101, 99, 100));
  }

  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));

  const fresh = {
    symbol: 'ETHUSDT',
    provider: 'OKX',
    candles15m: bars,
    candles4h: bullishH4(Date.parse('2026-09-30T07:30:00Z'))
  };

  const signal = inspectSession(fresh, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.strictEqual(signal.status, 'SIGNAL');
  assert.strictEqual(signal.fresh, true);

  const laterBars = [...bars, c(Date.parse('2026-09-30T07:45:00Z'), 106, 110, 105.5, 108, 150)];
  const old = { ...fresh, candles15m: laterBars };
  const oldStatus = inspectSession(old, 'LONDON', Date.parse('2026-09-30T08:01:00Z'));

  assert.ok(['ACTIVE', 'EXTENDED'].includes(oldStatus.status));
  assert.strictEqual(oldStatus.fresh, false);
})();

console.log('session_breakout_bot_status tests: PASS');
