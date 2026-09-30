'use strict';

const assert = require('assert');
const { evaluateSession, localParts } = require('../hunter_core_v1/session_breakout_monitor');

function m15(openTime, o, h, l, c, volume = 100) {
  return { openTime, open: o, high: h, low: l, close: c, volume };
}

function trend4h({ bearish = false, endTime }) {
  const out = [];
  let px = bearish ? 200 : 100;
  const step = bearish ? -0.5 : 0.5;
  for (let i = 0; i < 60; i += 1) {
    px += step;
    out.push({ openTime: endTime - (60 - i) * 4 * 3600_000, open: px - step, high: px + 1, low: px - 1, close: px, volume: 1000 });
  }
  return out;
}

(function testTimezoneMapping() {
  const london = localParts(Date.parse('2026-09-30T07:00:00Z'), 'Europe/London');
  assert.strictEqual(london.hour, 8);
  const ny = localParts(Date.parse('2026-09-30T13:30:00Z'), 'America/New_York');
  assert.strictEqual(ny.hour, 9);
  assert.strictEqual(ny.minute, 30);
})();

(function testLondonLong() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  c.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  c.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));
  const snap = { symbol: 'ETHUSDT', candles15m: c, candles4h: trend4h({ endTime: Date.parse('2026-09-30T07:30:00Z') }) };
  const s = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'), { tpR: 2, equity: 1000, riskPct: 0.005 });
  assert.ok(s, 'expected London long signal');
  assert.strictEqual(s.side, 'LONG');
  assert.strictEqual(s.boxHigh, 105);
  assert.strictEqual(s.stop, 99);
  assert.strictEqual(s.target, 120);
})();

(function testWickOnlyDoesNotTrigger() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  c.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  c.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 104, 150));
  const snap = { symbol: 'ETHUSDT', candles15m: c, candles4h: trend4h({ endTime: Date.parse('2026-09-30T07:30:00Z') }) };
  const s = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.strictEqual(s, null);
})();

(function testNewYorkShort() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T13:30:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T13:30:00Z'), 100, 102, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T13:45:00Z'), 100, 101, 98, 99, 100));
  c.push(m15(Date.parse('2026-09-30T14:00:00Z'), 99, 100, 96, 97, 150));
  const snap = { symbol: 'BTCUSDT', candles15m: c, candles4h: trend4h({ bearish: true, endTime: Date.parse('2026-09-30T14:00:00Z') }) };
  const s = evaluateSession(snap, 'NEW_YORK', Date.parse('2026-09-30T14:16:00Z'), { tpR: 2 });
  assert.ok(s, 'expected New York short signal');
  assert.strictEqual(s.side, 'SHORT');
  assert.strictEqual(s.boxLow, 98);
  assert.strictEqual(s.stop, 102);
  assert.strictEqual(s.target, 87);
})();

console.log('hunter_session_breakout tests: PASS');
