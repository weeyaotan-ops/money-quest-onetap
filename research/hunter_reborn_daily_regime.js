'use strict';

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
}

function normalizeDaily(rows) {
  return (Array.isArray(rows) ? rows : []).map(x => Array.isArray(x)
    ? { ts: Number(x[0]), open: Number(x[1]), close: Number(x[4]) }
    : { ts: Number(x.ts ?? x.openTime), open: Number(x.open ?? x.o), close: Number(x.close ?? x.c) }
  ).filter(x => [x.ts, x.open, x.close].every(Number.isFinite))
   .sort((a, b) => a.ts - b.ts);
}

function buildSmaSignal(rows, period = 200) {
  const c = normalizeDaily(rows);
  const signal = Array(c.length).fill(0);
  for (let i = period; i < c.length; i += 1) {
    const sma = mean(c.slice(i - period + 1, i + 1).map(x => x.close));
    signal[i] = c[i].close > sma ? 1 : 0;
  }
  return { candles: c, signal };
}

function backtestLongCash(rows, {
  period = 200,
  costBpsPerWeightChange = 30,
  evaluationStartTs = -Infinity,
  evaluationEndTs = Infinity
} = {}) {
  const { candles, signal } = buildSmaSignal(rows, period);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let previousPosition = 0;
  let trades = 0;
  let exposed = 0;
  const returns = [];

  for (let i = period + 1; i < candles.length - 1; i += 1) {
    const tradeTs = candles[i].ts;
    if (tradeTs < evaluationStartTs || tradeTs >= evaluationEndTs) continue;
    // Previous daily close decides today's open position.
    // Return is today's open -> tomorrow's open. No same-bar lookahead.
    const position = signal[i - 1];
    let r = position * (candles[i + 1].open / candles[i].open - 1);

    if (position !== previousPosition) {
      r -= costBpsPerWeightChange / 10000;
      trades += 1;
      previousPosition = position;
    }

    equity *= Math.max(1e-9, 1 + r);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    returns.push(r);
    if (position) exposed += 1;
  }

  const years = returns.length / 365.25;
  const avg = mean(returns);
  const sd = Math.sqrt(mean(returns.map(x => (x - avg) ** 2)));
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;

  return {
    mode: 'SHADOW_RESEARCH_ONLY',
    liveExecution: false,
    period,
    costBpsPerWeightChange,
    evaluationStartTs,
    evaluationEndTs,
    returnPct: (equity - 1) * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: sd > 0 ? avg / sd * Math.sqrt(365.25) : 0,
    trades,
    exposurePct: returns.length ? exposed / returns.length * 100 : 0
  };
}

function backtestThreeSleeves(seriesBySymbol, {
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  period = 200,
  sleeveWeight = 1 / 3,
  costBpsPerWeightChange = 30,
  evaluationStartTs = -Infinity,
  evaluationEndTs = Infinity
} = {}) {
  const prepared = {};
  for (const symbol of symbols) prepared[symbol] = buildSmaSignal(seriesBySymbol[symbol], period);

  const n = Math.min(...symbols.map(s => prepared[s].candles.length));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let turnover = 0;
  const previousWeights = Object.fromEntries(symbols.map(s => [s, 0]));
  const returns = [];

  for (let i = period + 1; i < n - 1; i += 1) {
    const tradeTs = prepared[symbols[0]].candles[i].ts;
    if (tradeTs < evaluationStartTs || tradeTs >= evaluationEndTs) continue;
    let r = 0;

    for (const symbol of symbols) {
      const { candles, signal } = prepared[symbol];
      const weight = signal[i - 1] ? sleeveWeight : 0;
      r += weight * (candles[i + 1].open / candles[i].open - 1);

      const change = Math.abs(weight - previousWeights[symbol]);
      r -= change * costBpsPerWeightChange / 10000;
      turnover += change;
      previousWeights[symbol] = weight;
    }

    equity *= Math.max(1e-9, 1 + r);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    returns.push(r);
  }

  const years = returns.length / 365.25;
  const avg = mean(returns);
  const sd = Math.sqrt(mean(returns.map(x => (x - avg) ** 2)));
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;

  return {
    mode: 'SHADOW_RESEARCH_ONLY',
    liveExecution: false,
    rule: 'PRIOR_CLOSE_ABOVE_SMA_THEN_NEXT_OPEN_LONG_ELSE_CASH',
    symbols,
    period,
    sleeveWeight,
    costBpsPerWeightChange,
    evaluationStartTs,
    evaluationEndTs,
    returnPct: (equity - 1) * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: sd > 0 ? avg / sd * Math.sqrt(365.25) : 0,
    turnover
  };
}

module.exports = {
  normalizeDaily,
  buildSmaSignal,
  backtestLongCash,
  backtestThreeSleeves
};
