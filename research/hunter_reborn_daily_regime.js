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


function backtestBtcMarketGate(seriesBySymbol, {
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  gateSymbol = 'BTCUSDT',
  gatePeriod = 200,
  assetPeriod = 200,
  sleeveWeight = 1 / 3,
  costBpsPerWeightChange = 30,
  evaluationStartTs = -Infinity,
  evaluationEndTs = Infinity
} = {}) {
  const prepared = {};
  for (const symbol of symbols) prepared[symbol] = buildSmaSignal(seriesBySymbol[symbol], assetPeriod);
  const gate = buildSmaSignal(seriesBySymbol[gateSymbol], gatePeriod);

  const n = Math.min(
    gate.candles.length,
    ...symbols.map(s => prepared[s].candles.length)
  );
  const warmup = Math.max(gatePeriod, assetPeriod) + 1;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let turnover = 0;
  const previousWeights = Object.fromEntries(symbols.map(s => [s, 0]));
  const returns = [];

  for (let i = warmup; i < n - 1; i += 1) {
    const tradeTs = gate.candles[i].ts;
    if (tradeTs < evaluationStartTs || tradeTs >= evaluationEndTs) continue;

    const gateOn = Boolean(gate.signal[i - 1]);
    let r = 0;

    for (const symbol of symbols) {
      const { candles, signal } = prepared[symbol];
      const ownOn = Boolean(signal[i - 1]);
      const active = symbol === gateSymbol ? gateOn : (gateOn && ownOn);
      const weight = active ? sleeveWeight : 0;

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
    rule: 'BTC_MARKET_GATE_AND_OWN_SMA_LONG_CASH',
    symbols,
    gateSymbol,
    gatePeriod,
    assetPeriod,
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


function backtestVolatilityThrottle(seriesBySymbol, {
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  period = 200,
  volatilityLookback = 60,
  targetAnnualizedVolatility = 0.40,
  sleeveWeight = 1 / 3,
  costBpsPerWeightChange = 30,
  evaluationStartTs = -Infinity,
  evaluationEndTs = Infinity
} = {}) {
  const prepared = {};
  for (const symbol of symbols) prepared[symbol] = buildSmaSignal(seriesBySymbol[symbol], period);

  const n = Math.min(...symbols.map(s => prepared[s].candles.length));
  const warmup = Math.max(period, volatilityLookback) + 1;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let turnover = 0;
  let exposureSum = 0;
  let exposureDays = 0;
  const previousWeights = Object.fromEntries(symbols.map(s => [s, 0]));
  const returns = [];

  for (let i = warmup; i < n - 1; i += 1) {
    const tradeTs = prepared[symbols[0]].candles[i].ts;
    if (tradeTs < evaluationStartTs || tradeTs >= evaluationEndTs) continue;

    let r = 0;
    let dayExposure = 0;

    for (const symbol of symbols) {
      const { candles, signal } = prepared[symbol];
      let weight = 0;

      if (signal[i - 1]) {
        const logReturns = [];
        for (let j = i - 1 - volatilityLookback + 1; j <= i - 1; j += 1) {
          if (j <= 0) continue;
          logReturns.push(Math.log(candles[j].close / candles[j - 1].close));
        }

        const avg = mean(logReturns);
        const variance = logReturns.length > 1
          ? logReturns.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (logReturns.length - 1)
          : 0;
        const annualizedVolatility = Math.sqrt(variance) * Math.sqrt(365.25);
        const throttle = annualizedVolatility > 0
          ? Math.min(1, targetAnnualizedVolatility / annualizedVolatility)
          : 1;

        weight = sleeveWeight * throttle;
      }

      r += weight * (candles[i + 1].open / candles[i].open - 1);

      const change = Math.abs(weight - previousWeights[symbol]);
      r -= change * costBpsPerWeightChange / 10000;
      turnover += change;
      previousWeights[symbol] = weight;
      dayExposure += weight;
    }

    equity *= Math.max(1e-9, 1 + r);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    returns.push(r);
    exposureSum += dayExposure;
    exposureDays += 1;
  }

  const years = returns.length / 365.25;
  const avg = mean(returns);
  const sd = Math.sqrt(mean(returns.map(x => (x - avg) ** 2)));
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;

  return {
    mode: 'SHADOW_RESEARCH_ONLY',
    liveExecution: false,
    rule: 'OWN_SMA_LONG_CASH_WITH_VOLATILITY_THROTTLE',
    symbols,
    period,
    volatilityLookback,
    targetAnnualizedVolatility,
    sleeveWeight,
    costBpsPerWeightChange,
    evaluationStartTs,
    evaluationEndTs,
    returnPct: (equity - 1) * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: sd > 0 ? avg / sd * Math.sqrt(365.25) : 0,
    calmar: maxDrawdown < 0 ? cagr / Math.abs(maxDrawdown) : 0,
    turnover,
    averageExposurePct: exposureDays ? exposureSum / exposureDays * 100 : 0
  };
}


function backtestPortfolioVolatilityTarget(seriesBySymbol, {
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  period = 200,
  volatilityLookback = 60,
  targetAnnualizedPortfolioVolatility = 0.20,
  scaleDeadband = 0,
  sleeveWeight = 1 / 3,
  costBpsPerWeightChange = 30,
  evaluationStartTs = -Infinity,
  evaluationEndTs = Infinity
} = {}) {
  const prepared = {};
  for (const symbol of symbols) prepared[symbol] = buildSmaSignal(seriesBySymbol[symbol], period);

  const n = Math.min(...symbols.map(s => prepared[s].candles.length));
  const baseReturns = Array(n).fill(0);

  // Build the unthrottled core portfolio return history first. The volatility
  // scalar for day i uses only baseReturns strictly before i.
  for (let i = period + 1; i < n - 1; i += 1) {
    let r = 0;
    for (const symbol of symbols) {
      const { candles, signal } = prepared[symbol];
      const weight = signal[i - 1] ? sleeveWeight : 0;
      r += weight * (candles[i + 1].open / candles[i].open - 1);
    }
    baseReturns[i] = r;
  }

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let turnover = 0;
  let scaleSum = 0;
  let currentScale = 1;
  let scaleChanges = 0;
  let exposureSum = 0;
  let days = 0;
  const previousWeights = Object.fromEntries(symbols.map(s => [s, 0]));
  const returns = [];

  for (let i = period + 1; i < n - 1; i += 1) {
    const tradeTs = prepared[symbols[0]].candles[i].ts;
    if (tradeTs < evaluationStartTs || tradeTs >= evaluationEndTs) continue;

    const history = [];
    for (let j = i - volatilityLookback; j < i; j += 1) {
      if (j >= period + 1) history.push(baseReturns[j]);
    }

    let desiredScale = 1;
    if (history.length >= Math.max(20, Math.floor(volatilityLookback * 0.8))) {
      const avg = mean(history);
      const variance = history.length > 1
        ? history.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (history.length - 1)
        : 0;
      const annualizedPortfolioVolatility = Math.sqrt(variance) * Math.sqrt(365.25);
      if (annualizedPortfolioVolatility > 0) {
        desiredScale = Math.min(1, targetAnnualizedPortfolioVolatility / annualizedPortfolioVolatility);
      }
    }

    if (Math.abs(desiredScale - currentScale) >= scaleDeadband) {
      currentScale = desiredScale;
      scaleChanges += 1;
    }
    const scale = currentScale;

    let r = 0;
    let dayExposure = 0;

    for (const symbol of symbols) {
      const { candles, signal } = prepared[symbol];
      const baseWeight = signal[i - 1] ? sleeveWeight : 0;
      const weight = baseWeight * scale;

      r += weight * (candles[i + 1].open / candles[i].open - 1);

      const change = Math.abs(weight - previousWeights[symbol]);
      r -= change * costBpsPerWeightChange / 10000;
      turnover += change;
      previousWeights[symbol] = weight;
      dayExposure += weight;
    }

    equity *= Math.max(1e-9, 1 + r);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    returns.push(r);
    scaleSum += scale;
    exposureSum += dayExposure;
    days += 1;
  }

  const years = returns.length / 365.25;
  const avg = mean(returns);
  const sd = Math.sqrt(mean(returns.map(x => (x - avg) ** 2)));
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;

  return {
    mode: 'SHADOW_RESEARCH_ONLY',
    liveExecution: false,
    rule: 'OWN_SMA_LONG_CASH_WITH_PORTFOLIO_VOL_TARGET',
    symbols,
    period,
    volatilityLookback,
    targetAnnualizedPortfolioVolatility,
    scaleDeadband,
    sleeveWeight,
    costBpsPerWeightChange,
    evaluationStartTs,
    evaluationEndTs,
    returnPct: (equity - 1) * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe: sd > 0 ? avg / sd * Math.sqrt(365.25) : 0,
    calmar: maxDrawdown < 0 ? cagr / Math.abs(maxDrawdown) : 0,
    turnover,
    averageScale: days ? scaleSum / days : 1,
    scaleChanges,
    averageExposurePct: days ? exposureSum / days * 100 : 0
  };
}

module.exports = {
  normalizeDaily,
  buildSmaSignal,
  backtestLongCash,
  backtestThreeSleeves,
  backtestBtcMarketGate,
  backtestVolatilityThrottle,
  backtestPortfolioVolatilityTarget
};
