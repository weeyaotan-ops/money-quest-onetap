'use strict';

const DAY_MS = 86_400_000;
const SPOT_KLINES = 'https://api.binance.com/api/v3/klines';

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(x => Array.isArray(x)
    ? { ts: Number(x[0]), open: Number(x[1]), close: Number(x[4]) }
    : { ts: Number(x.ts ?? x.openTime), open: Number(x.open ?? x.o), close: Number(x.close ?? x.c) }
  ).filter(x => [x.ts, x.open, x.close].every(Number.isFinite))
   .sort((a, b) => a.ts - b.ts);
}

function alignSeries(seriesBySymbol, symbols) {
  const normalized = Object.fromEntries(symbols.map(s => [s, normalizeRows(seriesBySymbol[s])]));
  const common = new Set(normalized[symbols[0]].map(x => x.ts));
  for (const symbol of symbols.slice(1)) {
    const own = new Set(normalized[symbol].map(x => x.ts));
    for (const ts of [...common]) if (!own.has(ts)) common.delete(ts);
  }
  const times = [...common].sort((a, b) => a - b);
  const out = {};
  for (const symbol of symbols) {
    const byTs = new Map(normalized[symbol].map(x => [x.ts, x]));
    out[symbol] = times.map(ts => byTs.get(ts));
  }
  return out;
}

function calculateShadowState(seriesBySymbol, {
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  period = 200,
  volatilityLookback = 60,
  defensiveTarget = 0.20,
  moderateTarget = 0.25,
  currentUtcDayOpen = null
} = {}) {
  const aligned = alignSeries(seriesBySymbol, symbols);
  const n = Math.min(...symbols.map(s => aligned[s].length));
  if (n < period + volatilityLookback + 3) throw new Error('INSUFFICIENT_DAILY_HISTORY');

  const latestTs = aligned[symbols[0]][n - 1].ts;
  const todayOpen = Number.isFinite(Number(currentUtcDayOpen))
    ? Number(currentUtcDayOpen)
    : Math.floor(Date.now() / DAY_MS) * DAY_MS;

  if (latestTs !== todayOpen) throw new Error('CURRENT_DAILY_OPEN_NOT_PRESENT');

  const executionIndex = n - 1;
  const signalIndex = executionIndex - 1;
  const baseWeight = 1 / symbols.length;
  const assetState = {};
  const currentBaseWeights = {};

  for (const symbol of symbols) {
    const c = aligned[symbol];
    const sma = mean(c.slice(signalIndex - period + 1, signalIndex + 1).map(x => x.close));
    const regimeOn = c[signalIndex].close > sma;
    currentBaseWeights[symbol] = regimeOn ? baseWeight : 0;
    assetState[symbol] = {
      signalCandle: new Date(c[signalIndex].ts).toISOString(),
      signalClose: c[signalIndex].close,
      sma: Number(sma.toFixed(8)),
      regime: regimeOn ? 'ON' : 'OFF',
      executionOpen: c[executionIndex].open,
      baseWeight: currentBaseWeights[symbol]
    };
  }

  const baseReturns = [];
  for (let i = period + 1; i < executionIndex; i += 1) {
    let r = 0;
    for (const symbol of symbols) {
      const c = aligned[symbol];
      const sma = mean(c.slice(i - 1 - period + 1, i).map(x => x.close));
      const weight = c[i - 1].close > sma ? baseWeight : 0;
      r += weight * (c[i + 1].open / c[i].open - 1);
    }
    baseReturns.push(r);
  }

  const history = baseReturns.slice(-volatilityLookback);
  if (history.length < volatilityLookback) throw new Error('INSUFFICIENT_PORTFOLIO_VOL_HISTORY');

  const annualizedPortfolioVolatility = stdev(history) * Math.sqrt(365.25);
  const defensiveScale = Math.min(1, defensiveTarget / Math.max(annualizedPortfolioVolatility, 1e-12));
  const moderateScale = Math.min(1, moderateTarget / Math.max(annualizedPortfolioVolatility, 1e-12));

  for (const symbol of symbols) {
    assetState[symbol].defensiveWeight = currentBaseWeights[symbol] * defensiveScale;
    assetState[symbol].moderateWeight = currentBaseWeights[symbol] * moderateScale;
  }

  return {
    mode: 'SHADOW_RESEARCH_ONLY',
    liveExecution: false,
    source: 'BINANCE_SPOT_PUBLIC_DAILY_KLINES',
    asOfOpen: new Date(todayOpen).toISOString(),
    priorCompletedDailyCandle: new Date(aligned[symbols[0]][signalIndex].ts).toISOString(),
    period,
    volatilityLookback,
    annualizedBasePortfolioVolatility,
    defensive: {
      targetAnnualizedPortfolioVolatility: defensiveTarget,
      scale: defensiveScale,
      grossWeight: Object.values(currentBaseWeights).reduce((sum, w) => sum + w * defensiveScale, 0)
    },
    moderate: {
      targetAnnualizedPortfolioVolatility: moderateTarget,
      scale: moderateScale,
      grossWeight: Object.values(currentBaseWeights).reduce((sum, w) => sum + w * moderateScale, 0)
    },
    assets: assetState
  };
}

async function fetchDaily(symbol, limit = 420) {
  const url = new URL(SPOT_KLINES);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('limit', String(limit));
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`BINANCE_HTTP_${r.status}_${await r.text()}`);
  return r.json();
}

async function main() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const series = {};
  for (const symbol of symbols) series[symbol] = await fetchDaily(symbol, 420);
  const state = calculateShadowState(series, { symbols });
  process.stdout.write(JSON.stringify(state, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('HUNTER_REBORN_SHADOW_STATE_FAILED', String(err && (err.stack || err.message) || err));
    process.exitCode = 1;
  });
}

module.exports = {
  DAY_MS,
  normalizeRows,
  alignSeries,
  calculateShadowState
};
