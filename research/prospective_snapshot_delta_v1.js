'use strict';

// Research-only helper for evaluating FUTURE Hunter snapshots against a frozen
// training snapshot. It does not touch Hunter selection, Telegram, gateway,
// sizing, leverage, orders, or live exits.

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function deltaStat(train = {}, later = {}) {
  const n = num(later.n) - num(train.n);
  const wins = num(later.wins) - num(train.wins);
  const losses = num(later.losses) - num(train.losses);
  const breakeven = num(later.breakeven) - num(train.breakeven);
  const totalR = num(later.totalR) - num(train.totalR);
  return {
    n,
    wins,
    losses,
    breakeven,
    totalR,
    winRate: n > 0 ? wins / n : null,
    expectancyR: n > 0 ? totalR / n : null,
  };
}

function deltaTable(train = {}, later = {}) {
  const keys = new Set([...Object.keys(train || {}), ...Object.keys(later || {})]);
  const out = {};
  for (const key of keys) out[key] = deltaStat(train[key], later[key]);
  return out;
}

function evaluateHoldout(train, later) {
  if (!train || !later) throw new Error('TRAIN_AND_LATER_SNAPSHOTS_REQUIRED');
  if (train.capturedFromDeployment !== later.capturedFromDeployment) {
    throw new Error('DEPLOYMENT_CHANGED_CANNOT_SUBTRACT_CUMULATIVE_SNAPSHOTS');
  }
  const baseline = deltaStat(
    {n: train.closed, wins: train.baseline?.wins, losses: train.baseline?.losses, totalR: train.baseline?.totalR},
    {n: later.closed, wins: later.baseline?.wins, losses: later.baseline?.losses, totalR: later.baseline?.totalR},
  );

  return {
    mode: 'PROSPECTIVE_SHADOW_ONLY',
    deployment: train.capturedFromDeployment,
    trainClosed: train.closed,
    laterClosed: later.closed,
    holdout: baseline,
    exitPolicyShadow: deltaTable(train.exitPolicyShadow, later.exitPolicyShadow),
    timeframe: deltaTable(train.timeframe, later.timeframe),
    side: deltaTable(train.side, later.side),
    scoreBucket: deltaTable(train.scoreBucket, later.scoreBucket),
    spreadBucket: deltaTable(train.spreadBucket, later.spreadBucket),
    shadowStructure: deltaTable(train.shadowStructure, later.shadowStructure),
    volatility: deltaTable(train.volatility, later.volatility),
    shadowGates: deltaTable(train.shadowGates, later.shadowGates),
    warning: 'Subtract cumulative snapshots only when they come from the exact same uninterrupted deployment and identical ledger logic.',
  };
}

module.exports = { deltaStat, deltaTable, evaluateHoldout };
