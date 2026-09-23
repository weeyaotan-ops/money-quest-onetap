'use strict';

const EPS = 1e-9;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(v)));
const safeProb = v => clamp(Number(v), 1e-6, 1 - 1e-6);

function softmax(logScores) {
  const m = Math.max(...logScores);
  const xs = logScores.map(x => Math.exp(x - m));
  const z = xs.reduce((a, b) => a + b, 0) || 1;
  return xs.map(x => x / z);
}

function determineRegime(s = {}) {
  const trend = clamp(s.trendStrength ?? 0.5);
  const vol = clamp(s.volatilityPercentile ?? 0.5);
  const compression = clamp(s.compressionScore ?? 0.5);
  const meanRev = clamp(s.meanReversionScore ?? 0.5);
  const event = clamp(s.eventRisk ?? 0);
  const leverage = clamp(s.leverageStress ?? 0.5);

  if (event >= 0.8) return 'EVENT';
  if (compression >= 0.72 && vol <= 0.48) return 'COMPRESSION';
  if (trend >= 0.66 && vol >= 0.35) return 'TREND';
  if (meanRev >= 0.68 && trend <= 0.48) return 'MEAN_REVERSION';
  if (leverage >= 0.78) return 'LEVERAGE_STRESS';
  return 'MIXED';
}

function regimeFit(name, regime, s = {}) {
  const n = String(name || '').toUpperCase();
  const trend = clamp(s.trendStrength ?? 0.5);
  const vol = clamp(s.volatilityPercentile ?? 0.5);
  const compression = clamp(s.compressionScore ?? 0.5);
  const meanRev = clamp(s.meanReversionScore ?? 0.5);
  const event = clamp(s.eventRisk ?? 0);
  const leverage = clamp(s.leverageStress ?? 0.5);

  let fit = 0.55;
  if (n.includes('TREND')) fit = 0.25 + 0.75 * trend;
  else if (n.includes('VOL')) fit = 0.25 + 0.45 * vol + 0.30 * compression;
  else if (n.includes('MEAN')) fit = 0.20 + 0.80 * meanRev;
  else if (n.includes('ORDER')) fit = 0.50 + 0.40 * vol;
  else if (n.includes('LEVERAGE')) fit = 0.30 + 0.70 * leverage;
  else if (n.includes('RELATIVE')) fit = 0.55;
  else if (n.includes('CROSS')) fit = 0.55 + 0.25 * trend;
  else if (n.includes('EVENT')) fit = 0.20 + 0.80 * event;

  if (regime === 'EVENT' && !n.includes('EVENT') && !n.includes('VOL')) fit *= 0.65;
  if (regime === 'MIXED') fit *= 0.85;
  return clamp(fit, 0.05, 1);
}

function normalizedClassProbabilities(e = {}) {
  const raw = [
    Math.max(EPS, Number(e.pLong ?? 1 / 3)),
    Math.max(EPS, Number(e.pShort ?? 1 / 3)),
    Math.max(EPS, Number(e.pNeutral ?? 1 / 3))
  ];
  const z = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map(x => x / z);
}

function aggregateExperts(experts = [], marketState = {}, prior = [1 / 3, 1 / 3, 1 / 3]) {
  const regime = determineRegime(marketState);
  const priorSafe = prior.map(safeProb);
  const logScores = priorSafe.map(Math.log);
  const used = [];

  for (const e of experts) {
    const reliability = clamp(e.reliability ?? 0.5);
    const uncertainty = clamp(e.uncertainty ?? 0.5);
    const fit = regimeFit(e.name, regime, marketState);
    const weight = clamp(reliability * (1 - uncertainty) * fit, 0, 1);
    if (weight <= 0.01) continue;

    const p = normalizedClassProbabilities(e);
    for (let i = 0; i < 3; i++) {
      logScores[i] += weight * Math.log(safeProb(p[i]) / priorSafe[i]);
    }
    used.push({ name: e.name, weight, probabilities: p, reliability, uncertainty, fit });
  }

  const [pLong, pShort, pNeutral] = softmax(logScores);

  let disagreement = 0;
  if (used.length > 1) {
    const cols = [0, 1, 2].map(i => used.map(x => x.probabilities[i]));
    disagreement = cols.reduce((sum, col) => {
      const mean = col.reduce((a, b) => a + b, 0) / col.length;
      return sum + col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
    }, 0) / 3;
  }

  const totalW = used.reduce((a, x) => a + x.weight, 0) || 1;
  const modelUncertainty = used.reduce((a, x) => a + x.weight * x.uncertainty, 0) / totalW;
  const uncertainty = clamp(modelUncertainty + Math.sqrt(disagreement));

  return { regime, pLong, pShort, pNeutral, uncertainty, disagreement, used };
}

function actionEV(prob, plan, side) {
  const pFav = side === 'LONG' ? prob.pLong : prob.pShort;
  const pAdv = side === 'LONG' ? prob.pShort : prob.pLong;
  const pNeutral = prob.pNeutral;

  const winR = Math.max(0, Number(plan.winR ?? 0));
  const lossR = Math.max(0, Number(plan.lossR ?? 1));
  const neutralR = Number(plan.neutralR ?? -0.10);
  const costR = Math.max(0, Number(plan.costR ?? 0));

  return pFav * winR - pAdv * lossR + pNeutral * neutralR - costR;
}

function evaluateDecision(input = {}) {
  const marketState = input.marketState || {};
  const experts = Array.isArray(input.experts) ? input.experts : [];
  const aggregate = aggregateExperts(experts, marketState, input.prior);

  const longPlan = input.longPlan || {};
  const shortPlan = input.shortPlan || {};
  const longEV = actionEV(aggregate, longPlan, 'LONG');
  const shortEV = actionEV(aggregate, shortPlan, 'SHORT');

  const cfg = {
    minEVR: Number(input.config?.minEVR ?? 0.12),
    minDirectionalProbability: Number(input.config?.minDirectionalProbability ?? 0.55),
    maxUncertainty: Number(input.config?.maxUncertainty ?? 0.34),
    minEVGap: Number(input.config?.minEVGap ?? 0.05)
  };

  const candidates = [
    { action: 'LONG', evR: longEV, p: aggregate.pLong },
    { action: 'SHORT', evR: shortEV, p: aggregate.pShort }
  ].sort((a, b) => b.evR - a.evR);

  const best = candidates[0];
  const second = candidates[1];
  const reasons = [];

  if (experts.length < 2) reasons.push('INSUFFICIENT_EXPERT_DIVERSITY');
  if (aggregate.uncertainty > cfg.maxUncertainty) reasons.push('UNCERTAINTY_TOO_HIGH');
  if (best.p < cfg.minDirectionalProbability) reasons.push('DIRECTIONAL_PROBABILITY_TOO_LOW');
  if (best.evR < cfg.minEVR) reasons.push('POST_COST_EV_TOO_LOW');
  if (best.evR - second.evR < cfg.minEVGap) reasons.push('EDGE_NOT_DISTINCT_ENOUGH');

  const action = reasons.length ? 'SKIP' : best.action;
  return {
    version: 'HUNTER_PRIME_V1_SHADOW',
    action,
    regime: aggregate.regime,
    probabilities: {
      long: aggregate.pLong,
      short: aggregate.pShort,
      neutral: aggregate.pNeutral
    },
    uncertainty: aggregate.uncertainty,
    disagreement: aggregate.disagreement,
    evR: { long: longEV, short: shortEV, best: best.evR },
    reasons,
    expertsUsed: aggregate.used.map(x => ({
      name: x.name,
      weight: x.weight,
      reliability: x.reliability,
      uncertainty: x.uncertainty,
      regimeFit: x.fit
    }))
  };
}

module.exports = {
  determineRegime,
  regimeFit,
  aggregateExperts,
  actionEV,
  evaluateDecision
};
