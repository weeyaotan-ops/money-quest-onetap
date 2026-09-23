'use strict';

const assert = require('node:assert/strict');
const { evaluateDecision } = require('../hunter_prime_core');

function expert(name, pLong, pShort, pNeutral, reliability = 0.9, uncertainty = 0.08) {
  return { name, pLong, pShort, pNeutral, reliability, uncertainty };
}

const common = {
  longPlan: { winR: 2.2, lossR: 1, neutralR: -0.12, costR: 0.05 },
  shortPlan: { winR: 2.2, lossR: 1, neutralR: -0.12, costR: 0.05 },
  config: { minEVR: 0.12, minDirectionalProbability: 0.55, maxUncertainty: 0.34, minEVGap: 0.05 }
};

{
  const r = evaluateDecision({
    ...common,
    marketState: { trendStrength: 0.9, volatilityPercentile: 0.7, compressionScore: 0.3 },
    experts: [
      expert('Trend', 0.72, 0.10, 0.18),
      expert('Volatility', 0.66, 0.12, 0.22),
      expert('OrderFlow', 0.70, 0.11, 0.19),
      expert('CrossMarket', 0.63, 0.15, 0.22)
    ]
  });
  assert.equal(r.action, 'LONG');
  assert.ok(r.evR.long > 0);
}

{
  const r = evaluateDecision({
    ...common,
    marketState: { trendStrength: 0.45, volatilityPercentile: 0.5 },
    experts: [
      expert('Trend', 0.70, 0.12, 0.18),
      expert('OrderFlow', 0.12, 0.70, 0.18),
      expert('Leverage', 0.18, 0.60, 0.22)
    ]
  });
  assert.equal(r.action, 'SKIP');
}

{
  const expensive = {
    ...common,
    longPlan: { winR: 0.8, lossR: 1, neutralR: -0.2, costR: 0.25 },
    shortPlan: { winR: 0.8, lossR: 1, neutralR: -0.2, costR: 0.25 }
  };
  const r = evaluateDecision({
    ...expensive,
    marketState: { trendStrength: 0.75, volatilityPercentile: 0.6 },
    experts: [
      expert('Trend', 0.62, 0.18, 0.20),
      expert('Volatility', 0.60, 0.18, 0.22)
    ]
  });
  assert.equal(r.action, 'SKIP');
  assert.ok(r.reasons.includes('POST_COST_EV_TOO_LOW'));
}

{
  const r = evaluateDecision({
    ...common,
    marketState: { trendStrength: 0.88, volatilityPercentile: 0.75 },
    experts: [
      expert('Trend', 0.10, 0.72, 0.18),
      expert('OrderFlow', 0.12, 0.68, 0.20),
      expert('Leverage', 0.13, 0.66, 0.21)
    ]
  });
  assert.equal(r.action, 'SHORT');
}

console.log('HUNTER_PRIME_V1_TESTS_OK');
