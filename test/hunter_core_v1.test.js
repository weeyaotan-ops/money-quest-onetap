'use strict';

const assert = require('assert');
const { rankSnapshots, calculatePosition, classifyRegime } = require('../hunter_core_v1/core');

function candles({ n = 180, start = 100, drift = 0.0025, noise = 0.001, volumeBase = 1000, chaosAtEnd = false }) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i += 1) {
    const wave = Math.sin(i * 0.7) * noise;
    const o = px;
    const c = px * Math.exp(drift + wave);
    const spread = px * (0.002 + Math.abs(wave));
    let h = Math.max(o, c) + spread;
    let l = Math.min(o, c) - spread;
    if (chaosAtEnd && i === n - 1) { h = c * 1.10; l = c * 0.90; }
    out.push({ open: o, high: h, low: l, close: c, volume: volumeBase * (1 + 0.05 * Math.sin(i)), openTime: i, closeTime: i + 1 });
    px = c;
  }
  return out;
}

function snapshot(symbol, strength = 1, bearish = false, chaos = false) {
  const dir = bearish ? -1 : 1;
  const d4 = dir * 0.0045 * strength;
  const d1 = dir * 0.0030 * strength;
  const d15 = dir * 0.0022 * strength;
  const base = {
    symbol,
    candles4h: candles({ drift: d4, noise: 0.00035 }),
    candles1h: candles({ drift: d1, noise: 0.00045 }),
    candles15m: candles({ drift: d15, noise: 0.00055, chaosAtEnd: chaos }),
    funding: [],
    openInterestHistory: [],
    basis: [],
    taker: []
  };
  for (let i = 0; i < 30; i += 1) {
    const crowded = bearish ? -0.00003 : 0.00003;
    base.funding.push({ time: i, rate: crowded + (i === 29 ? -dir * 0.00008 : 0) });
    base.openInterestHistory.push({ time: i, value: 100000 * (1 + i * 0.003) });
    base.basis.push({ time: i, rate: -dir * 0.0002 });
    base.taker.push({ time: i, buySellRatio: bearish ? 0.65 : 1.55 });
  }
  return base;
}

(function testSizing() {
  const s = calculatePosition({ equity: 1000, riskPct: 0.005, entry: 100, stop: 98 });
  assert.strictEqual(Number(s.riskUsd.toFixed(2)), 5.00);
  assert.strictEqual(Number(s.quantity.toFixed(4)), 2.5);
})();

(function testLongRanking() {
  const ranked = rankSnapshots([
    snapshot('BTCUSDT', 0.7, false),
    snapshot('ETHUSDT', 0.35, false),
    snapshot('SOLUSDT', 1.4, false)
  ], 1000, 0.005);
  assert.strictEqual(ranked[0].symbol, 'SOLUSDT');
  assert.ok(ranked[0].edge > 0.65, `expected actionable long edge, got ${ranked[0].edge}`);
  assert.strictEqual(ranked[0].decision, 'LONG');
  assert.ok(ranked[0].plan && ranked[0].plan.riskUsd === 5);
})();

(function testShort() {
  const ranked = rankSnapshots([
    snapshot('BTCUSDT', 1.4, true),
    snapshot('ETHUSDT', 0.4, true),
    snapshot('SOLUSDT', 0.2, false)
  ], 2000, 0.005);
  const btc = ranked.find((x) => x.symbol === 'BTCUSDT');
  assert.ok(btc.edge < -0.65, `expected actionable short edge, got ${btc.edge}`);
  assert.strictEqual(btc.decision, 'SHORT');
  assert.strictEqual(btc.plan.riskUsd, 10);
})();

(function testChaosVeto() {
  const s = snapshot('BTCUSDT', 1.5, false, true);
  const regime = classifyRegime(s);
  assert.strictEqual(regime.name, 'CHAOS');
  const ranked = rankSnapshots([s, snapshot('ETHUSDT', 0.2), snapshot('SOLUSDT', 0.1)], 1000, 0.005);
  const btc = ranked.find((x) => x.symbol === 'BTCUSDT');
  assert.strictEqual(btc.edge, 0);
  assert.strictEqual(btc.decision, 'NO_TRADE');
})();

console.log('hunter_core_v1 tests: PASS');
