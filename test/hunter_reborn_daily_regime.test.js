'use strict';

const assert = require('node:assert/strict');
const { buildSmaSignal, backtestLongCash, backtestThreeSleeves, backtestBtcMarketGate, backtestVolatilityThrottle, backtestPortfolioVolatilityTarget } = require('../research/hunter_reborn_daily_regime');

function series(n = 500, drift = 0.001) {
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const open = px;
    px *= 1 + drift + (i % 17 === 0 ? -0.002 : 0);
    out.push({ ts: i * 86400000, open, close: px });
  }
  return out;
}

{
  const r = buildSmaSignal(series(), 50);
  assert.equal(r.signal.length, 500);
  assert.equal(r.signal.slice(100).every(x => x === 1), true);
}

{
  const r = backtestLongCash(series(), { period: 50, costBpsPerWeightChange: 30 });
  assert.equal(r.liveExecution, false);
  assert.equal(r.mode, 'SHADOW_RESEARCH_ONLY');
  assert.ok(r.cagrPct > 0);
  assert.ok(r.maxDrawdownPct <= 0);
}

{
  const s = series();
  const r = backtestThreeSleeves({ BTCUSDT: s, ETHUSDT: s, SOLUSDT: s }, { period: 50 });
  assert.equal(r.liveExecution, false);
  assert.ok(r.cagrPct > 0);
}

{
  const s = series(600);
  const evalStart = 350 * 86400000;
  const r = backtestLongCash(s, { period: 200, evaluationStartTs: evalStart });
  assert.equal(r.evaluationStartTs, evalStart);
  assert.ok(r.exposurePct > 0);
  assert.ok(r.trades >= 1);
}

{
  const s = series(650);
  const r = backtestBtcMarketGate(
    { BTCUSDT: s, ETHUSDT: s, SOLUSDT: s },
    { gatePeriod: 200, assetPeriod: 200, evaluationStartTs: 350 * 86400000 }
  );
  assert.equal(r.liveExecution, false);
  assert.equal(r.rule, 'BTC_MARKET_GATE_AND_OWN_SMA_LONG_CASH');
  assert.ok(r.cagrPct > 0);
}

{
  const s = series(700);
  const r = backtestVolatilityThrottle(
    { BTCUSDT: s, ETHUSDT: s, SOLUSDT: s },
    {
      period: 200,
      volatilityLookback: 60,
      targetAnnualizedVolatility: 0.40,
      evaluationStartTs: 350 * 86400000
    }
  );
  assert.equal(r.liveExecution, false);
  assert.equal(r.rule, 'OWN_SMA_LONG_CASH_WITH_VOLATILITY_THROTTLE');
  assert.ok(r.averageExposurePct >= 0);
  assert.ok(r.averageExposurePct <= 100);
  assert.ok(r.turnover >= 0);
}

{
  const s = series(720);
  const r = backtestPortfolioVolatilityTarget(
    { BTCUSDT: s, ETHUSDT: s, SOLUSDT: s },
    {
      period: 200,
      volatilityLookback: 60,
      targetAnnualizedPortfolioVolatility: 0.20,
      evaluationStartTs: 350 * 86400000
    }
  );
  assert.equal(r.liveExecution, false);
  assert.equal(r.rule, 'OWN_SMA_LONG_CASH_WITH_PORTFOLIO_VOL_TARGET');
  assert.ok(r.averageScale > 0);
  assert.ok(r.averageScale <= 1);
  assert.ok(r.averageExposurePct >= 0);
  assert.ok(r.averageExposurePct <= 100);
}

{
  const s = series(720);
  const r = backtestPortfolioVolatilityTarget(
    { BTCUSDT: s, ETHUSDT: s, SOLUSDT: s },
    {
      period: 200,
      volatilityLookback: 60,
      targetAnnualizedPortfolioVolatility: 0.20,
      scaleDeadband: 0.05,
      evaluationStartTs: 350 * 86400000
    }
  );
  assert.equal(r.liveExecution, false);
  assert.equal(r.scaleDeadband, 0.05);
  assert.ok(r.averageScale > 0 && r.averageScale <= 1);
  assert.ok(r.scaleChanges >= 0);
}

console.log('HUNTER_REBORN_DAILY_REGIME_TESTS_OK');
