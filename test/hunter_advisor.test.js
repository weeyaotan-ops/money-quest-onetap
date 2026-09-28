'use strict';

const assert = require('assert');
const { stageVisual, watchPlan, marketSynthesis } = require('../hunter_core_v1/advisor');

function candles(price = 100) {
  const out = [];
  for (let i = 0; i < 30; i += 1) {
    const p = price + i * 0.1;
    out.push({ openTime: i, open: p, high: p + 1, low: p - 1, close: p + 0.2, volume: 100 });
  }
  return out;
}

assert.strictEqual(stageVisual({ edge: 0.7, decision: 'LONG' }).icon, '🟢');
assert.strictEqual(stageVisual({ edge: -0.7, decision: 'SHORT' }).icon, '🔴');
assert.strictEqual(stageVisual({ edge: 0.55, decision: 'NO_TRADE' }).icon, '🟠');
assert.strictEqual(stageVisual({ edge: 0.4, decision: 'NO_TRADE' }).icon, '🟡');

const r = {
  symbol: 'BTCUSDT',
  edge: 0.55,
  decision: 'NO_TRADE',
  components: { trend: 0.5, flow: 0.2, derivatives: 0.1 }
};
const wp = watchPlan(r, { candles15m: candles() });
assert.strictEqual(wp.side, 'LONG');
assert.ok(wp.zone[0] < wp.zone[1]);
assert.ok(wp.invalid < wp.zone[0]);

const data = {
  ranked: [
    { symbol:'BTCUSDT', edge:0.55, decision:'NO_TRADE', regime:{name:'TREND'}, components:{trend:0.4, flow:0.2, derivatives:0.1} },
    { symbol:'ETHUSDT', edge:0.3, decision:'NO_TRADE', regime:{name:'TREND'}, components:{trend:0.3, flow:0.1, derivatives:0.1} },
    { symbol:'SOLUSDT', edge:0.1, decision:'NO_TRADE', regime:{name:'RANGE'}, components:{trend:0.2, flow:0.0, derivatives:0.0} }
  ]
};
const s = marketSynthesis(data);
assert.strictEqual(s.bias, 'BULLISH');
assert.strictEqual(s.best.symbol, 'BTCUSDT');

console.log('hunter_advisor tests: PASS');
