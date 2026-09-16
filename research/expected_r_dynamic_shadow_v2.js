'use strict';

// RESEARCH ONLY. Not connected to Hunter, Telegram, gateway, sizing, or live execution.
// V2 is frozen at the N250 checkpoint and may only use information available BEFORE
// each future candidate. The update rule is fixed so N250->N500 can be a real
// prospective test of an online, regime-responsive Expected-R model.

const v1 = require('./expected_r_shadow_v1');

const FAST_PRIOR_N = 80;
const MAX_FAST_WEIGHT = 0.35;
const MAX_DYNAMIC_SHIFT_R = 0.20;

const finite = (x, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function statDelta(oldStat, newStat) {
  const oldN = finite(oldStat?.n);
  const newN = finite(newStat?.n);
  const n = Math.max(0, newN - oldN);
  const totalR = finite(newStat?.totalR) - finite(oldStat?.totalR);
  return { n, totalR, expectancyR: n ? totalR / n : null };
}

function tableDelta(oldTable = {}, newTable = {}) {
  const keys = new Set([...Object.keys(oldTable || {}), ...Object.keys(newTable || {})]);
  const out = {};
  for (const key of keys) {
    const d = statDelta(oldTable?.[key], newTable?.[key]);
    if (d.n > 0) out[key] = d;
  }
  return out;
}

function snapshotDelta(anchor, later) {
  const baseline = statDelta(anchor?.baseline, later?.baseline);
  return {
    baseline,
    timeframe: tableDelta(anchor?.timeframe, later?.timeframe),
    side: tableDelta(anchor?.side, later?.side),
    scoreBucket: tableDelta(anchor?.scoreBucket, later?.scoreBucket),
    spreadBucket: tableDelta(anchor?.spreadBucket, later?.spreadBucket),
    shadowStructure: tableDelta(anchor?.shadowStructure, later?.shadowStructure),
    volatility: tableDelta(anchor?.volatility, later?.volatility),
  };
}

function fastWeight(recentN) {
  const n = Math.max(0, finite(recentN));
  return Math.min(MAX_FAST_WEIGHT, MAX_FAST_WEIGHT * (n / (n + FAST_PRIOR_N)));
}

function estimateCandidateRDynamic(candidate, anchorSnapshot, latestSnapshot) {
  if (!anchorSnapshot?.baseline || !latestSnapshot?.baseline) throw new Error('ANCHOR_AND_LATEST_REQUIRED');

  // Slow model: frozen N250 evidence.
  const slow = v1.estimateCandidateR(candidate, anchorSnapshot, { priorN: 30 });

  // Fast model: only observations accrued AFTER N250. It is heavily shrunk and
  // cannot dominate until substantial fresh support exists.
  const recent = snapshotDelta(anchorSnapshot, latestSnapshot);
  const recentN = finite(recent?.baseline?.n);
  if (recentN <= 0 || !Number.isFinite(Number(recent?.baseline?.expectancyR))) {
    return {
      mode: 'DYNAMIC_SHADOW_V2',
      expectedR: slow.expectedR,
      slowExpectedR: slow.expectedR,
      fastExpectedR: null,
      fastWeight: 0,
      recentN: 0,
      dynamicShiftR: 0,
      slow,
      warning: 'Research only; no live authority.'
    };
  }

  const fastSnapshot = {
    baseline: recent.baseline,
    timeframe: recent.timeframe,
    side: recent.side,
    scoreBucket: recent.scoreBucket,
    spreadBucket: recent.spreadBucket,
    shadowStructure: recent.shadowStructure,
    volatility: recent.volatility,
  };
  const fast = v1.estimateCandidateR(candidate, fastSnapshot, { priorN: FAST_PRIOR_N });
  const w = fastWeight(recentN);
  const rawShift = w * (fast.expectedR - slow.expectedR);
  const shift = clamp(rawShift, -MAX_DYNAMIC_SHIFT_R, MAX_DYNAMIC_SHIFT_R);

  return {
    mode: 'DYNAMIC_SHADOW_V2',
    expectedR: slow.expectedR + shift,
    slowExpectedR: slow.expectedR,
    fastExpectedR: fast.expectedR,
    fastWeight: w,
    recentN,
    dynamicShiftR: shift,
    slow,
    fast,
    warning: 'Prospective research model only; do not use for live execution before frozen N500 evaluation.'
  };
}

function rankShadowDynamic(candidates, anchorSnapshot, latestSnapshot) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => ({ candidate, estimate: estimateCandidateRDynamic(candidate, anchorSnapshot, latestSnapshot) }))
    .sort((a, b) => b.estimate.expectedR - a.estimate.expectedR);
}

module.exports = {
  FAST_PRIOR_N,
  MAX_FAST_WEIGHT,
  MAX_DYNAMIC_SHIFT_R,
  statDelta,
  tableDelta,
  snapshotDelta,
  fastWeight,
  estimateCandidateRDynamic,
  rankShadowDynamic,
};
