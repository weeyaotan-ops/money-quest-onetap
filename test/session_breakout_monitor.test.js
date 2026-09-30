'use strict';

const assert = require('assert');
const { localParts, evaluate } = require('../session_breakout_monitor');

const M15 = 15 * 60 * 1000;

function c(t, o, h, l, close, v = 100) {
  return { openTime: t, open: o, high: h, low: l, close, volume: v, closeTime: t + M15 - 1 };
}

function trend4h(end, bearish = false) {
  const out = [];
  let px = bearish ? 200 : 100;
  for (let i = 0; i < 60; i += 1) {
    px += bearish ? -0.5 : 0.5;
    out.push({ openTime: end - (60 - i) * 4 * 3600_000, close: px });
  }
  return out;
}

(function timezoneChecks() {
  let p = localParts(Date.parse('2026-09-30T07:00:00Z'), 'Europe/London');
  assert.strictEqual(p.hour, 8);
  p = localParts(Date.parse('2026-09-30T13:30:00Z'), 'America/New_York');
  assert.strictEqual(p.hour, 9);
  assert.strictEqual(p.minute, 30);
})();

(function londonLong() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) bars.push(c(t, 100, 101, 99, 100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));
  const snap = { symbol: 'ETHUSDT', provider: 'TEST', candles15m: bars, candles4h: trend4h(Date.parse('2026-09-30T07:30:00Z')) };
  const s = evaluate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(s);
  assert.strictEqual(s.side, 'LONG');
  assert.strictEqual(s.boxHigh, 105);
  assert.strictEqual(s.stop, 99);
})();

(function wickDoesNotTrigger() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) bars.push(c(t, 100, 101, 99, 100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 104, 150));
  const snap = { symbol: 'ETHUSDT', provider: 'TEST', candles15m: bars, candles4h: trend4h(Date.parse('2026-09-30T07:30:00Z')) };
  assert.strictEqual(evaluate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z')), null);
})();

console.log('session_breakout_monitor tests: PASS');
