'use strict';

// RESEARCH ONLY. NOT CONNECTED TO LIVE EXECUTION.
// V2.7.2 Rescue Brain v1 keeps the useful idea of selective admission,
// but replaces "always choose something" with explicit ABSTAIN and execution-cost gates.
//
// It intentionally does NOT recreate the original V2.7.2 selector byte-for-byte.
// The original upstream selector source is still unavailable from the redacted Railway payload.
// This module is a prospective rescue candidate built from the verified post-mortem evidence.

const truth = require('./truth_seeking_master_brain_v3');

const CONFIG = Object.freeze({
  roundTripFrictionBps: 12.0,   // conservative fallback: taker/taker + slippage
  minRiskBps: 80.0,             // keeps default friction <= 0.15R
  minNetRR: 1.50,
  minSupport: 0.35,
  maxSlowFastDisagreementR: 0.25,
  minNetTruthScoreR: 0.10,
  maxSpreadBps: 2.0,
  maxQuoteAgeMs: 5000,
});

const finite = (x, d = NaN) => Number.isFinite(Number(x)) ? Number(x) : d;

function geometry(candidate = {}) {
  const side = String(candidate.side || candidate.direction || '').toUpperCase();
  const entry = finite(candidate.entry);
  const sl = finite(candidate.sl ?? candidate.stop);
  const tp = finite(candidate.tp ?? candidate.takeProfit);
  if (![entry, sl, tp].every(Number.isFinite) || !(entry > 0)) {
    return { ok: false, reason: 'INVALID_PRICES' };
  }
  if (side === 'BUY' || side === 'LONG') {
    if (!(sl < entry && tp > entry)) return { ok: false, reason: 'INVALID_LONG_GEOMETRY' };
  } else if (side === 'SELL' || side === 'SHORT') {
    if (!(sl > entry && tp < entry)) return { ok: false, reason: 'INVALID_SHORT_GEOMETRY' };
  } else {
    return { ok: false, reason: 'INVALID_SIDE' };
  }

  const riskBps = Math.abs(entry - sl) / entry * 10000;
  const rewardBps = Math.abs(tp - entry) / entry * 10000;
  const frictionBps = Math.max(0, finite(candidate.frictionBps, CONFIG.roundTripFrictionBps));
  const costR = riskBps > 0 ? frictionBps / riskBps : Infinity;
  const grossRR = riskBps > 0 ? rewardBps / riskBps : 0;
  const netRR = (riskBps > 0 && rewardBps > frictionBps)
    ? (rewardBps - frictionBps) / (riskBps + frictionBps)
    : -Infinity;

  return { ok: true, side, entry, sl, tp, riskBps, rewardBps, frictionBps, costR, grossRR, netRR };
}

function executionGate(candidate = {}) {
  const g = geometry(candidate);
  const reasons = [];
  if (!g.ok) reasons.push(g.reason);

  const spreadBps = finite(candidate.spreadBps);
  const quoteAgeMs = finite(candidate.quoteAgeMs);

  if (g.ok) {
    if (g.riskBps < CONFIG.minRiskBps) reasons.push('STOP_TOO_NARROW_FOR_COSTS');
    if (g.netRR < CONFIG.minNetRR) reasons.push('NET_RR_TOO_LOW');
    if (g.costR > 0.15) reasons.push('FRICTION_TOO_LARGE_VS_RISK');
  }
  if (!Number.isFinite(spreadBps)) reasons.push('UNKNOWN_SPREAD');
  else if (spreadBps > CONFIG.maxSpreadBps) reasons.push('SPREAD_TOO_WIDE');

  if (Number.isFinite(quoteAgeMs) && quoteAgeMs > CONFIG.maxQuoteAgeMs) reasons.push('STALE_QUOTE');

  return {
    pass: reasons.length === 0,
    reasons,
    spreadBps: Number.isFinite(spreadBps) ? spreadBps : null,
    quoteAgeMs: Number.isFinite(quoteAgeMs) ? quoteAgeMs : null,
    geometry: g,
  };
}

function assess(candidate, anchorSnapshot, latestSnapshot) {
  const ex = executionGate(candidate);
  const t = truth.estimateTruth(candidate, anchorSnapshot, latestSnapshot);

  const costR = ex.geometry?.ok ? ex.geometry.costR : Infinity;
  const netTruthScoreR = Number.isFinite(costR)
    ? finite(t.truthScoreR, -Infinity) - costR
    : -Infinity;

  const reasons = [...ex.reasons, ...(t.abstainReasons || [])];

  if (finite(t.support, 0) < CONFIG.minSupport) reasons.push('RESCUE_LOW_SUPPORT');
  if (finite(t.disagreementR, Infinity) > CONFIG.maxSlowFastDisagreementR) reasons.push('RESCUE_MODEL_CONFLICT');
  if (!(netTruthScoreR >= CONFIG.minNetTruthScoreR)) reasons.push('NET_TRUTH_SCORE_BELOW_HURDLE');

  // Preserve every reason but remove duplicates for auditability.
  const uniqueReasons = [...new Set(reasons)];

  return {
    mode: 'V272_RESCUE_BRAIN_V1_RESEARCH_ONLY',
    action: uniqueReasons.length ? 'ABSTAIN' : 'ELIGIBLE',
    abstainReasons: uniqueReasons,
    netTruthScoreR: Number.isFinite(netTruthScoreR) ? netTruthScoreR : null,
    truth: t,
    execution: ex,
    config: CONFIG,
    warning: 'Research only. No live-order authority. Promotion requires a new prospective Binance-realistic holdout.'
  };
}

function rank(candidates, anchorSnapshot, latestSnapshot) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => ({ candidate, assessment: assess(candidate, anchorSnapshot, latestSnapshot) }))
    .sort((a, b) => {
      if (a.assessment.action !== b.assessment.action) return a.assessment.action === 'ELIGIBLE' ? -1 : 1;
      return finite(b.assessment.netTruthScoreR, -Infinity) - finite(a.assessment.netTruthScoreR, -Infinity);
    });
}

function chooseOne(candidates, anchorSnapshot, latestSnapshot) {
  const ranked = rank(candidates, anchorSnapshot, latestSnapshot);
  return ranked.find(x => x.assessment.action === 'ELIGIBLE') || {
    candidate: null,
    assessment: {
      mode: 'V272_RESCUE_BRAIN_V1_RESEARCH_ONLY',
      action: 'ABSTAIN',
      abstainReasons: ['NO_COST_AWARE_SUPPORTED_POSITIVE_EDGE']
    }
  };
}

module.exports = {
  CONFIG,
  geometry,
  executionGate,
  assess,
  rank,
  chooseOne,
};
