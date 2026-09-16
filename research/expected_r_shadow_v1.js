'use strict';

// RESEARCH-ONLY Expected-R ranker.
// This file is intentionally not wired into Hunter, Telegram, gateway, sizing, or live execution.
// It consumes an observational snapshot and produces a conservative, shrinkage-based shadow score.

const DEFAULT_PRIOR_N = 30;
const DIMENSION_WEIGHTS = Object.freeze({
  spreadBucket: 0.30,
  scoreBucket: 0.25,
  timeframe: 0.15,
  side: 0.15,
  shadowStructure: 0.10,
  volatility: 0.05,
});

function finite(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function scoreBucket(score) {
  const s = finite(score, NaN);
  if (!Number.isFinite(s)) return 'UNKNOWN';
  const lo = Math.floor(s * 20) / 20;
  return `${lo.toFixed(2)}-${(lo + 0.05).toFixed(2)}`;
}

function spreadBucket(spreadBps) {
  const s = finite(spreadBps, NaN);
  if (!Number.isFinite(s)) return 'UNKNOWN';
  if (s < 0.5) return '<0.5bps';
  if (s < 1) return '0.5-1bps';
  if (s < 2) return '1-2bps';
  if (s < 4) return '2-4bps';
  return '4bps+';
}

function shrinkMean(stat, priorMean, priorN = DEFAULT_PRIOR_N) {
  if (!stat || !Number.isFinite(Number(stat.n)) || stat.n <= 0) {
    return { mean: priorMean, reliability: 0, n: 0, raw: null };
  }
  const n = finite(stat.n);
  const raw = finite(stat.expectancyR);
  const k = Math.max(1, finite(priorN, DEFAULT_PRIOR_N));
  return {
    mean: (n * raw + k * priorMean) / (n + k),
    reliability: n / (n + k),
    n,
    raw,
  };
}

function candidateKeys(t = {}) {
  return {
    timeframe: String(t.timeframe || 'UNKNOWN'),
    side: String(t.side || 'UNKNOWN').toUpperCase(),
    scoreBucket: scoreBucket(t.score ?? t.edgeScore ?? t.confidence),
    spreadBucket: spreadBucket(t.spreadBps),
    shadowStructure: String(t.shadowStructureRegime || t.shadowStructure || 'UNKNOWN').toUpperCase(),
    volatility: String(t.volatilityBand || t.volatility || 'UNKNOWN').toUpperCase(),
  };
}

function estimateCandidateR(t, snapshot, opts = {}) {
  if (!snapshot || !snapshot.baseline) throw new Error('SNAPSHOT_REQUIRED');
  const globalMean = finite(snapshot.baseline.expectancyR);
  const priorN = Math.max(1, finite(opts.priorN, DEFAULT_PRIOR_N));
  const keys = candidateKeys(t);
  const evidence = [];
  let delta = 0;
  let support = 0;
  let availableWeight = 0;

  for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    const table = snapshot[dimension] || {};
    const key = keys[dimension];
    const stat = table[key];
    if (!stat) continue;
    const s = shrinkMean(stat, globalMean, priorN);
    // Correlated dimensions are deliberately damped: a feature can only move the
    // global mean by its allocated weight * reliability * shrunk residual.
    const residual = s.mean - globalMean;
    delta += weight * s.reliability * residual;
    support += weight * s.reliability;
    availableWeight += weight;
    evidence.push({dimension, key, weight, ...s, residual});
  }

  // Avoid rewarding candidates just because some dimensions are missing.
  const coverage = clamp(availableWeight, 0, 1);
  const expectedR = globalMean + delta;
  const supportScore = clamp(support, 0, 1) * coverage;

  return {
    mode: 'SHADOW_ONLY',
    expectedR,
    baselineR: globalMean,
    liftVsBaselineR: expectedR - globalMean,
    supportScore,
    coverage,
    priorN,
    keys,
    evidence,
    warning: 'Observational aggregate model. No causal claim; no live execution authority.',
  };
}

function rankShadow(candidates, snapshot, opts = {}) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => ({candidate, estimate: estimateCandidateR(candidate, snapshot, opts)}))
    .sort((a, b) => b.estimate.expectedR - a.estimate.expectedR);
}

function snapshotEvidenceSummary(snapshot) {
  const baseline = finite(snapshot?.baseline?.expectancyR);
  const rows = [];
  for (const dimension of Object.keys(DIMENSION_WEIGHTS)) {
    for (const [key, stat] of Object.entries(snapshot?.[dimension] || {})) {
      const s = shrinkMean(stat, baseline, DEFAULT_PRIOR_N);
      rows.push({dimension, key, n:s.n, rawR:s.raw, shrunkR:s.mean, reliability:s.reliability});
    }
  }
  return rows.sort((a,b) => b.shrunkR - a.shrunkR);
}

module.exports = {
  DEFAULT_PRIOR_N,
  DIMENSION_WEIGHTS,
  scoreBucket,
  spreadBucket,
  shrinkMean,
  candidateKeys,
  estimateCandidateR,
  rankShadow,
  snapshotEvidenceSummary,
};
