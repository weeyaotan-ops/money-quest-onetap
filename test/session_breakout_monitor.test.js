'use strict';

const assert = require('assert');
const { localParts, ema50Bias, evaluate, rawBreakoutEvent, shadowTradeFromBreakout, shadowSummary, tradeFromSignal, updateTradeFromCandles, resultSummary } = require('../session_breakout_monitor');

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


(function h4RuleUsesPriceVsEma50WithoutSlopeGate() {
  const end = Date.parse('2026-09-30T07:30:00Z');
  const bars = [];
  let px = 100;
  for (let i = 0; i < 55; i += 1) {
    px += 1;
    bars.push({ openTime: end - (55 - i) * 4 * 3600_000, close: px });
  }
  // Last close stays above EMA while the final EMA slope can flatten/soften.
  bars.push({ openTime: end, close: px - 0.1 });
  const state = ema50Bias(bars);
  assert.strictEqual(state.bias, 'BULLISH');
  assert.ok(state.close > state.ema50);
})();

(function shadowCapturesRawBreakoutEvenWhenFilterBlocksIt() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) bars.push(c(t, 100, 101, 99, 100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));

  const bearishH4 = trend4h(Date.parse('2026-09-30T07:30:00Z'), true);
  const snap = { symbol: 'ETHUSDT', provider: 'TEST', candles15m: bars, candles4h: bearishH4 };
  const ev = rawBreakoutEvent(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(ev, 'raw breakout should be recorded');
  assert.strictEqual(ev.side, 'LONG');
  assert.strictEqual(ev.h4Pass, false);
  assert.strictEqual(ev.liveQualified, false);
  assert.ok(ev.blockedBy.includes('H4_EMA50'));
  assert.strictEqual(evaluate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z')), null);
})();

(function shadowDoesNotDoubleCountContinuousOutsideBars() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += M15) bars.push(c(t, 100, 101, 99, 100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));
  bars.push(c(Date.parse('2026-09-30T07:45:00Z'), 106, 109, 105.5, 107, 150));

  const snap = { symbol: 'ETHUSDT', provider: 'TEST', candles15m: bars, candles4h: trend4h(Date.parse('2026-09-30T07:45:00Z')) };
  const ev = rawBreakoutEvent(snap, 'LONDON', Date.parse('2026-09-30T08:01:00Z'));
  assert.strictEqual(ev, null, 'second bar already outside the box is not a new breakout event');
})();

(function shadowCohortsSummarizeFilterValue() {
  function mk(key, vwapPass, h4Pass, status) {
    const t = shadowTradeFromBreakout({
      key,
      symbol: 'TEST',
      provider: 'TEST',
      session: 'LONDON',
      sessionLabel: 'London',
      side: 'LONG',
      candleOpenTime: Date.parse('2026-09-30T07:30:00Z'),
      candleCloseTime: Date.parse('2026-09-30T07:45:00Z'),
      entry: 100,
      stop: 95,
      boxHigh: 99,
      boxLow: 95,
      vwap: 98,
      h4Bias: h4Pass ? 'BULLISH' : 'BEARISH',
      h4Ema50: 97,
      emaSlope: 0,
      vwapPass,
      h4Pass,
      liveQualified: vwapPass && h4Pass,
      blockedBy: []
    });
    if (status === 'TP2') {
      t.milestones.tp1.hit = true;
      t.milestones.tp2.hit = true;
      t.status = 'TP2';
      t.terminal = true;
    } else if (status === 'SL') {
      t.milestones.sl.hit = true;
      t.status = 'SL';
      t.terminal = true;
    }
    return t;
  }

  const state = { shadow: {
    a: mk('a', true, true, 'TP2'),
    b: mk('b', true, false, 'SL'),
    c: mk('c', false, true, 'SL')
  }};
  const sum = shadowSummary(state);
  assert.strictEqual(sum.raw.n, 3);
  assert.strictEqual(sum.vwapOnly.n, 2);
  assert.strictEqual(sum.h4Only.n, 2);
  assert.strictEqual(sum.both.n, 1);
  assert.strictEqual(sum.both.tp2, 1);
  assert.strictEqual(sum.blocked.n, 2);
})();

console.log('session_breakout_monitor tests: PASS');
