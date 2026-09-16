'use strict';

// RESEARCH ONLY. NOT CONNECTED TO LIVE HUNTER, TELEGRAM, GATEWAY, SIZING OR EXECUTION.
// This is a post-N500 candidate architecture. It must NOT change the frozen N250->N500 test.
// Goal: move from "pick the highest score" to "act only when edge is positive, supported,
// calibrated, and not contradicted by regime drift".

const dynamic = require('./expected_r_dynamic_shadow_v2');

const CONFIG = Object.freeze({
  minSupport: 0.30,
  maxSlowFastDisagreementR: 0.35,
  noTradeExpectedR: 0.00,
  noTradeTruthScore: 0.00,
  uncertaintyWeight: 0.55,
  lowSupportPenaltyR: 0.18,
  driftPenaltyR: 0.12,
  extremeDriftThreshold: 0.75,
});

const finite = (x, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function supportOf(est) {
  const slow = finite(est?.slow?.supportScore, 0);
  const fast = finite(est?.fast?.supportScore, 0);
  const fw = clamp(finite(est?.fastWeight, 0), 0, 1);
  return clamp((1 - fw) * slow + fw * fast, 0, 1);
}

function driftState(anchorSnapshot, latestSnapshot) {
  const recent = dynamic.snapshotDelta(anchorSnapshot, latestSnapshot);
  const oldR = finite(anchorSnapshot?.baseline?.expectancyR, 0);
  const newR = finite(recent?.baseline?.expectancyR, oldR);
  const recentN = finite(recent?.baseline?.n, 0);

  // Large sign reversals and large absolute moves matter more as fresh support grows.
  const signFlip = oldR !== 0 && newR !== 0 && Math.sign(oldR) !== Math.sign(newR);
  const move = Math.abs(newR - oldR);
  const evidence = clamp(recentN / (recentN + 80), 0, 1);
  const severity = clamp((move / 0.40) * evidence + (signFlip ? 0.25 * evidence : 0), 0, 1);

  return { recentN, anchorExpectancyR: oldR, recentExpectancyR: newR, signFlip, severity };
}

function estimateTruth(candidate, anchorSnapshot, latestSnapshot) {
  const est = dynamic.estimateCandidateRDynamic(candidate, anchorSnapshot, latestSnapshot);
  const support = supportOf(est);
  const disagreementR = Number.isFinite(Number(est.fastExpectedR))
    ? Math.abs(finite(est.slowExpectedR) - finite(est.fastExpectedR))
    : 0;
  const drift = driftState(anchorSnapshot, latestSnapshot);

  const uncertaintyPenaltyR =
    CONFIG.uncertaintyWeight * disagreementR +
    CONFIG.lowSupportPenaltyR * (1 - support);
  const regimePenaltyR = CONFIG.driftPenaltyR * drift.severity;
  const truthScoreR = finite(est.expectedR) - uncertaintyPenaltyR - regimePenaltyR;

  const reasons = [];
  if (finite(est.expectedR) <= CONFIG.noTradeExpectedR) reasons.push('NON_POSITIVE_EXPECTED_R');
  if (support < CONFIG.minSupport) reasons.push('LOW_SUPPORT');
  if (disagreementR > CONFIG.maxSlowFastDisagreementR) reasons.push('SLOW_FAST_CONFLICT');
  if (drift.severity >= CONFIG.extremeDriftThreshold) reasons.push('EXTREME_REGIME_DRIFT');
  if (truthScoreR <= CONFIG.noTradeTruthScore) reasons.push('NON_POSITIVE_TRUTH_SCORE');

  return {
    mode: 'TRUTH_SEEKING_MASTER_BRAIN_V3_SHADOW',
    expectedR: est.expectedR,
    truthScoreR,
    support,
    disagreementR,
    uncertaintyPenaltyR,
    regimePenaltyR,
    drift,
    action: reasons.length ? 'ABSTAIN' : 'ELIGIBLE',
    abstainReasons: reasons,
    dynamicEstimate: est,
    warning: 'Post-N500 research candidate only. A strong brain must be able to say NO TRADE when it does not know enough.'
  };
}

function rankTruth(candidates, anchorSnapshot, latestSnapshot) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => ({ candidate, estimate: estimateTruth(candidate, anchorSnapshot, latestSnapshot) }))
    .sort((a, b) => {
      if (a.estimate.action !== b.estimate.action) return a.estimate.action === 'ELIGIBLE' ? -1 : 1;
      return b.estimate.truthScoreR - a.estimate.truthScoreR;
    });
}

function chooseOne(candidates, anchorSnapshot, latestSnapshot) {
  const ranked = rankTruth(candidates, anchorSnapshot, latestSnapshot);
  const best = ranked.find(x => x.estimate.action === 'ELIGIBLE');
  return best || { candidate: null, estimate: { action: 'ABSTAIN', abstainReasons: ['NO_SUPPORTED_POSITIVE_EDGE'] } };
}

module.exports = {
  CONFIG,
  supportOf,
  driftState,
  estimateTruth,
  rankTruth,
  chooseOne,
};
