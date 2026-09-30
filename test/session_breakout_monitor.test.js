'use strict';

const assert = require('assert');
const { localParts, evaluate, tradeFromSignal, updateTradeFromCandles, resultSummary } = require('../session_breakout_monitor');

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


(function resultTracking() {
  const s = {
    key: 'TEST|LONDON|2026-09-30',
    symbol: 'TEST',
    provider: 'TEST',
    session: 'LONDON',
    sessionLabel: 'London',
    side: 'LONG',
    candleOpenTime: Date.parse('2026-09-30T07:30:00Z'),
    candleCloseTime: Date.parse('2026-09-30T07:45:00Z'),
    entry: 100,
    stop: 95
  };
  const t = tradeFromSignal(s);
  assert.strictEqual(t.tp1, 105);
  assert.strictEqual(t.tp2, 110);

  const next = [
    c(Date.parse('2026-09-30T07:45:00Z'), 100, 106, 99, 104),
    c(Date.parse('2026-09-30T08:00:00Z'), 104, 111, 103, 109)
  ];
  assert.strictEqual(updateTradeFromCandles(t, next), true);
  assert.strictEqual(t.milestones.tp1.hit, true);
  assert.strictEqual(t.milestones.tp2.hit, true);
  assert.strictEqual(t.milestones.sl.hit, false);
  assert.strictEqual(t.status, 'TP2');
  assert.strictEqual(t.terminal, true);

  const state = { trades: { [t.key]: t } };
  const sum = resultSummary(state);
  assert.deepStrictEqual(sum, { signals: 1, tp1: 1, tp2: 1, sl: 0, open: 0, ambiguousSameM15: 0 });
})();

(function sameBarAmbiguityRecorded() {
  const s = {
    key: 'TEST2|LONDON|2026-09-30',
    symbol: 'TEST2',
    provider: 'TEST',
    session: 'LONDON',
    sessionLabel: 'London',
    side: 'LONG',
    candleOpenTime: Date.parse('2026-09-30T07:30:00Z'),
    candleCloseTime: Date.parse('2026-09-30T07:45:00Z'),
    entry: 100,
    stop: 95
  };
  const t = tradeFromSignal(s);
  const bar = [c(Date.parse('2026-09-30T07:45:00Z'), 100, 106, 94, 100)];
  updateTradeFromCandles(t, bar);
  assert.strictEqual(t.milestones.tp1.hit, true);
  assert.strictEqual(t.milestones.sl.hit, true);
  assert.strictEqual(t.status, 'TP1_AND_SL_SAME_M15');
  assert.strictEqual(t.terminal, true);
})();

console.log('session_breakout_monitor tests: PASS');
