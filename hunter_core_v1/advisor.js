'use strict';

const { atr } = require('./core');
const { stageFromEdge } = require('./journal');

function shortSymbol(symbol) {
  return String(symbol || '').replace(/USDT$/i, '');
}

function stageVisual(result) {
  const stage = stageFromEdge(result.edge);
  if (stage === 'ACTIONABLE') {
    return result.decision === 'SHORT'
      ? { stage, icon: '🔴', label: 'SHORT NOW' }
      : { stage, icon: '🟢', label: 'LONG NOW' };
  }
  if (stage === 'ARMED') return { stage, icon: '🟠', label: 'GET READY' };
  if (stage === 'WATCH') return { stage, icon: '🟡', label: 'WATCH' };
  return { stage, icon: '⚪', label: 'WAIT' };
}

function regimeVisual(name) {
  if (name === 'TREND') return { icon: '📈', label: 'TREND' };
  if (name === 'BREAKOUT') return { icon: '🚀', label: 'BREAKOUT' };
  if (name === 'CHAOS') return { icon: '⚠️', label: 'CHAOS' };
  return { icon: '↔️', label: 'RANGE' };
}

function watchPlan(result, snapshot) {
  if (!result || !snapshot || !snapshot.candles15m?.length) return null;

  if (result.plan) {
    return {
      side: result.decision,
      zone: result.plan.entryZone,
      invalid: result.plan.stop,
      atr15m: result.plan.atr15m,
      actionable: true
    };
  }

  const last = snapshot.candles15m[snapshot.candles15m.length - 1];
  const price = Number(last.close);
  const a = atr(snapshot.candles15m, 14);
  if (!(price > 0) || !(a > 0)) return null;

  const directionalInput = Math.abs(Number(result.edge)) >= 0.05
    ? Number(result.edge)
    : Number(result.components?.trend || 0);

  if (Math.abs(directionalInput) < 0.05) return null;

  const side = directionalInput > 0 ? 'LONG' : 'SHORT';
  const dir = side === 'LONG' ? 1 : -1;
  const near = price - dir * 0.10 * a;
  const far = price - dir * 0.35 * a;
  const lo = Math.min(near, far);
  const hi = Math.max(near, far);
  const mid = (lo + hi) / 2;
  const invalid = mid - dir * 1.5 * a;

  return {
    side,
    zone: [lo, hi],
    invalid,
    atr15m: a,
    actionable: false
  };
}

function marketSynthesis(data) {
  const ranked = data?.ranked || [];
  if (!ranked.length) return null;

  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const avgTrend = avg(ranked.map((x) => Number(x.components?.trend || 0)));
  const avgFlow = avg(ranked.map((x) => Number(x.components?.flow || 0)));
  const avgDerivatives = avg(ranked.map((x) => Number(x.components?.derivatives || 0)));

  const bulls = ranked.filter((x) => Number(x.components?.trend || 0) > 0.12).length;
  const bears = ranked.filter((x) => Number(x.components?.trend || 0) < -0.12).length;
  const chaos = ranked.filter((x) => x.regime?.name === 'CHAOS').length;
  const ranges = ranked.filter((x) => x.regime?.name === 'RANGE').length;
  const trends = ranked.filter((x) => ['TREND', 'BREAKOUT'].includes(x.regime?.name)).length;

  let bias = 'MIXED';
  let biasIcon = '⚪';
  if (bulls >= 2 && avgTrend > 0.10) {
    bias = 'BULLISH';
    biasIcon = '🟢';
  } else if (bears >= 2 && avgTrend < -0.10) {
    bias = 'BEARISH';
    biasIcon = '🔴';
  }

  let risk = 'NORMAL';
  let riskIcon = '🟢';
  if (chaos > 0) {
    risk = 'HIGH';
    riskIcon = '🔴';
  } else if (ranges >= 2 || bias === 'MIXED') {
    risk = 'CAUTION';
    riskIcon = '🟡';
  }

  const best = ranked[0];
  const visual = stageVisual(best);

  let oneLiner = 'No clear market-wide edge. Waiting is the position.';
  if (chaos > 0) {
    oneLiner = 'Market is unstable. Protect capital and do not force entries.';
  } else if (ranges >= 2) {
    oneLiner = 'Most coins are sideways. Wait for expansion instead of guessing direction.';
  } else if (bias === 'BULLISH' && trends >= 2) {
    oneLiner = 'Broad trend leans up. Focus on the strongest pullback; do not chase.';
  } else if (bias === 'BEARISH' && trends >= 2) {
    oneLiner = 'Broad trend leans down. Focus on the weakest bounce; do not chase.';
  }

  if (visual.stage === 'ACTIONABLE') {
    oneLiner = `${shortSymbol(best.symbol)} is the current actionable ${best.decision} setup.`;
  } else if (visual.stage === 'ARMED') {
    oneLiner = `${shortSymbol(best.symbol)} is close. Prepare, but wait for confirmation.`;
  } else if (visual.stage === 'WATCH') {
    oneLiner = `${shortSymbol(best.symbol)} is the main watch. Conditions are forming, not confirmed.`;
  }

  return {
    bias,
    biasIcon,
    risk,
    riskIcon,
    best,
    bestVisual: visual,
    avgTrend,
    avgFlow,
    avgDerivatives,
    bulls,
    bears,
    ranges,
    trends,
    chaos,
    oneLiner
  };
}

module.exports = {
  shortSymbol,
  stageVisual,
  regimeVisual,
  watchPlan,
  marketSynthesis
};
