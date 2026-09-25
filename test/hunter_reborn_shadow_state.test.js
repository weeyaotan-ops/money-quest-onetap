'use strict';

const assert = require('node:assert/strict');
const { DAY_MS, calculateShadowState } = require('../research/hunter_reborn_shadow_state');

function makeSeries(n = 420, phase = 0) {
  const out = [];
  let px = 100 + phase;
  for (let i = 0; i < n; i += 1) {
    const open = px;
    const shock = i % 9 === 0 ? -0.025 : (i % 7 === 0 ? 0.03 : 0.002);
    px = Math.max(1, px * (1 + shock));
    out.push({ ts: i * DAY_MS, open, close: px });
  }
  return out;
}

{
  const series = {
    BTCUSDT: makeSeries(420, 0),
    ETHUSDT: makeSeries(420, 5),
    SOLUSDT: makeSeries(420, 10)
  };
  const currentUtcDayOpen = 419 * DAY_MS;
  const r = calculateShadowState(series, { currentUtcDayOpen });

  assert.equal(r.mode, 'SHADOW_RESEARCH_ONLY');
  assert.equal(r.liveExecution, false);
  assert.ok(r.annualizedBasePortfolioVolatility >= 0);
  assert.ok(r.defensive.scale > 0 && r.defensive.scale <= 1);
  assert.ok(r.moderate.scale > 0 && r.moderate.scale <= 1);
  assert.ok(r.defensive.scale <= r.moderate.scale);

  for (const asset of Object.values(r.assets)) {
    assert.ok(asset.defensiveWeight <= asset.baseWeight + 1e-12);
    assert.ok(asset.moderateWeight <= asset.baseWeight + 1e-12);
  }
}

console.log('HUNTER_REBORN_SHADOW_STATE_TESTS_OK');
