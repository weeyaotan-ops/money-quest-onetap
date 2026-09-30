'use strict';

const assert = require('assert');
const {
  localParts,
  evaluate,
  evaluateShadowBreakout,
  tradeFromSignal,
  shadowTradeFromCandidate,
  updateTradeFromCandles,
  shadowSummary,
  resultSummary
} = require('../session_breakout_monitor');

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



(function shadowLabRecordsFilteredBreakout() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  // Heavy earlier volume at higher prices forces VWAP above the eventual breakout close.
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) {
    bars.push(c(t, 120, 121, 119, 120, 1000));
  }
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 100));

  const snap = {
    symbol: 'ETHUSDT',
    provider: 'TEST',
    candles15m: bars,
    candles4h: trend4h(Date.parse('2026-09-30T07:30:00Z'))
  };

  const shadow = evaluateShadowBreakout(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(shadow, 'raw breakout should be recorded');
  assert.strictEqual(shadow.side, 'LONG');
  assert.strictEqual(shadow.filters.raw, true);
  assert.strictEqual(shadow.filters.vwap, false);
  assert.strictEqual(shadow.filters.h4, true);
  assert.strictEqual(shadow.filters.both, false);

  // Live strategy must remain blocked by VWAP.
  assert.strictEqual(evaluate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z')), null);
})();

(function shadowLabOutcomeSummary() {
  const s = {
    key: 'SHADOW|ETHUSDT|LONDON|1|LONG',
    symbol: 'ETHUSDT',
    provider: 'TEST',
    session: 'LONDON',
    sessionLabel: 'London',
    side: 'LONG',
    candleOpenTime: Date.parse('2026-09-30T07:30:00Z'),
    candleCloseTime: Date.parse('2026-09-30T07:45:00Z'),
    entry: 100,
    stop: 95,
    filters: { raw: true, vwap: false, h4: true, both: false }
  };
  const t = shadowTradeFromCandidate(s);
  updateTradeFromCandles(t, [
    c(Date.parse('2026-09-30T07:45:00Z'), 100, 111, 99, 109)
  ]);

  const summary = shadowSummary({ shadowTrades: { [t.key]: t } });
  assert.strictEqual(summary.mode, 'OBSERVATIONAL_ONLY');
  assert.strictEqual(summary.variants.raw.n, 1);
  assert.strictEqual(summary.variants.raw.tp2, 1);
  assert.strictEqual(summary.variants.h4.n, 1);
  assert.strictEqual(summary.variants.vwap.n, 0);
  assert.strictEqual(summary.variants.both.n, 0);
  assert.strictEqual(summary.rejectedBy.vwap.tp2, 1);
  assert.strictEqual(summary.rejectedBy.both.tp2, 1);
})();

(function h4RuleIsPriceVsEmaOnly() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) bars.push(c(t, 100, 101, 99, 100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));

  // Construct H4 closes above EMA50 while the last EMA step is slightly down.
  const h4 = [];
  const end = Date.parse('2026-09-30T07:30:00Z');
  for (let i = 0; i < 60; i += 1) {
    const close = i < 58 ? 100 + i * 0.2 : (i === 58 ? 112 : 111.9);
    h4.push({ openTime: end - (60 - i) * 4 * 3600_000, close });
  }
  const snap = { symbol: 'ETHUSDT', provider: 'TEST', candles15m: bars, candles4h: h4 };
  const s = evaluate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(s, 'price above EMA50 should be bullish even without EMA slope gate');
})();


(function shadowCapturesFilteredOutRawBreakout() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) bars.push(c(t, 100, 101, 99, 100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));

  const snap = {
    symbol: 'ETHUSDT',
    provider: 'TEST',
    candles15m: bars,
    candles4h: trend4h(Date.parse('2026-09-30T07:30:00Z'), true)
  };

  assert.strictEqual(evaluate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z')), null);

  const shadow = evaluateShadowBreakout(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(shadow, 'raw breakout should still be captured by shadow lab');
  assert.strictEqual(shadow.side, 'LONG');
  assert.strictEqual(shadow.filters.raw, true);
  assert.strictEqual(shadow.filters.vwap, true);
  assert.strictEqual(shadow.filters.h4, false);
  assert.strictEqual(shadow.filters.both, false);
})();

(function shadowSummarySeparatesFilters() {
  const a = shadowTradeFromCandidate({
    key: 'SHADOW|A|LONDON|1|LONG',
    symbol: 'A',
    provider: 'TEST',
    session: 'LONDON',
    sessionLabel: 'London',
    side: 'LONG',
    candleOpenTime: Date.parse('2026-09-30T07:30:00Z'),
    candleCloseTime: Date.parse('2026-09-30T07:45:00Z'),
    entry: 100,
    stop: 95,
    filters: { raw: true, vwap: true, h4: false, both: false }
  });
  updateTradeFromCandles(a, [
    c(Date.parse('2026-09-30T07:45:00Z'), 100, 101, 94, 95)
  ]);

  const b = shadowTradeFromCandidate({
    key: 'SHADOW|B|LONDON|2|LONG',
    symbol: 'B',
    provider: 'TEST',
    session: 'LONDON',
    sessionLabel: 'London',
    side: 'LONG',
    candleOpenTime: Date.parse('2026-09-30T07:30:00Z'),
    candleCloseTime: Date.parse('2026-09-30T07:45:00Z'),
    entry: 100,
    stop: 95,
    filters: { raw: true, vwap: true, h4: true, both: true }
  });
  updateTradeFromCandles(b, [
    c(Date.parse('2026-09-30T07:45:00Z'), 100, 111, 99, 110)
  ]);

  const sum = shadowSummary({ shadowTrades: { [a.key]: a, [b.key]: b } });
  assert.strictEqual(sum.mode, 'OBSERVATIONAL_ONLY');
  assert.strictEqual(sum.totalRawBreakouts, 2);
  assert.strictEqual(sum.variants.raw.n, 2);
  assert.strictEqual(sum.variants.raw.sl, 1);
  assert.strictEqual(sum.variants.raw.tp2, 1);
  assert.strictEqual(sum.variants.both.n, 1);
  assert.strictEqual(sum.variants.both.tp2, 1);
  assert.strictEqual(sum.rejectedBy.h4.n, 1);
})();


console.log('session_breakout_monitor tests: PASS');
