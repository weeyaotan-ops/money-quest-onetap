'use strict';

const DEFAULT_COST_BPS = 12;
const DEFAULT_SPLIT_RATIO = 0.70;
const DEFAULT_HORIZONS = [1, 2, 4, 16];

function finite(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / (values.length - 1));
}

function percentileRank(history, x) {
  if (!history.length) return NaN;
  let n = 0;
  for (const v of history) if (v <= x) n += 1;
  return n / history.length;
}

function normalizeCandles(rows) {
  return (Array.isArray(rows) ? rows : []).map((x) => {
    if (Array.isArray(x)) {
      return { ts: finite(x[0]), o: finite(x[1]), h: finite(x[2]), l: finite(x[3]), c: finite(x[4]), v: finite(x[5], 0) };
    }
    return {
      ts: finite(x.ts ?? x.openTime ?? x.time),
      o: finite(x.o ?? x.open),
      h: finite(x.h ?? x.high),
      l: finite(x.l ?? x.low),
      c: finite(x.c ?? x.close),
      v: finite(x.v ?? x.volume, 0)
    };
  }).filter(x => [x.ts, x.o, x.h, x.l, x.c, x.v].every(Number.isFinite))
    .sort((a, b) => a.ts - b.ts);
}

function trueRanges(candles) {
  return candles.map((x, i) => i === 0
    ? x.h - x.l
    : Math.max(x.h - x.l, Math.abs(x.h - candles[i - 1].c), Math.abs(x.l - candles[i - 1].c)));
}

function buildResearchConfigs() {
  const configs = [];
  for (const q of [0.85, 0.90, 0.95, 0.98]) {
    for (const compressionRatio of [0.65, 0.80]) {
      configs.push({ family: 'COMPRESSION_RELEASE', key: `CR_q${q}_c${compressionRatio}`, q, compressionRatio });
    }
  }
  for (const bodyMultiple of [1.0, 1.5, 2.0]) {
    for (const closeLocation of [0.65, 0.80]) {
      configs.push({ family: 'DISPLACEMENT', key: `DISP_m${bodyMultiple}_clv${closeLocation}`, bodyMultiple, closeLocation });
    }
  }
  for (const q of [0.90, 0.95, 0.98]) {
    configs.push({ family: 'VOLUME_SHOCK', key: `VOL_q${q}`, q });
  }
  for (const lookback of [12, 24, 48]) {
    configs.push({ family: 'SWEEP_RECLAIM', key: `SWEEP_n${lookback}`, lookback });
  }
  return configs;
}

function detectSide(cfg, ctx) {
  const {
    side, closeLocation, bodyAbs, medianPastTR, trRank, volumeRank,
    compressionRatio, candle, candles, index
  } = ctx;

  if (cfg.family === 'COMPRESSION_RELEASE') {
    if (!side) return 0;
    const closesAtEdge = side > 0 ? closeLocation >= 0.65 : closeLocation <= 0.35;
    return compressionRatio <= cfg.compressionRatio && trRank >= cfg.q && closesAtEdge ? side : 0;
  }

  if (cfg.family === 'DISPLACEMENT') {
    if (!side) return 0;
    const closesAtEdge = side > 0 ? closeLocation >= cfg.closeLocation : closeLocation <= 1 - cfg.closeLocation;
    return bodyAbs / Math.max(medianPastTR, 1e-12) >= cfg.bodyMultiple && closesAtEdge ? side : 0;
  }

  if (cfg.family === 'VOLUME_SHOCK') {
    if (!side) return 0;
    return volumeRank >= cfg.q && bodyAbs / Math.max(medianPastTR, 1e-12) >= 0.5 ? side : 0;
  }

  if (cfg.family === 'SWEEP_RECLAIM') {
    const prior = candles.slice(index - cfg.lookback, index);
    if (prior.length < cfg.lookback) return 0;
    const priorLow = Math.min(...prior.map(x => x.l));
    const priorHigh = Math.max(...prior.map(x => x.h));
    if (candle.l < priorLow && candle.c > priorLow) return 1;
    if (candle.h > priorHigh && candle.c < priorHigh) return -1;
  }

  return 0;
}

function extractObservations(inputRows, options = {}) {
  const candles = normalizeCandles(inputRows);
  const configs = options.configs || buildResearchConfigs();
  const horizons = options.horizons || DEFAULT_HORIZONS;
  const costBps = finite(options.costBps, DEFAULT_COST_BPS);
  const rankLookback = Math.max(20, finite(options.rankLookback, 96));
  const compressionLookback = Math.max(3, finite(options.compressionLookback, 8));
  const maxHorizon = Math.max(...horizons);
  const warmup = Math.max(rankLookback + 2, finite(options.warmup, 120));
  const tr = trueRanges(candles);
  const observations = [];

  for (let i = warmup; i < candles.length - maxHorizon; i += 1) {
    const candle = candles[i];
    const pastTR = tr.slice(i - rankLookback, i);
    const pastVolume = candles.slice(i - rankLookback, i).map(x => x.v);
    const medianPastTR = median(pastTR);
    const recentTR = tr.slice(i - compressionLookback, i);
    const compressionRatio = median(recentTR) / Math.max(medianPastTR, 1e-12);
    const trRank = percentileRank(pastTR, tr[i]);
    const volumeRank = percentileRank(pastVolume, candle.v);
    const body = candle.c - candle.o;
    const side = body > 0 ? 1 : body < 0 ? -1 : 0;
    const bodyAbs = Math.abs(body);
    const range = Math.max(candle.h - candle.l, 1e-12);
    const closeLocation = (candle.c - candle.l) / range;

    const ctx = {
      side, closeLocation, bodyAbs, medianPastTR, trRank, volumeRank,
      compressionRatio, candle, candles, index: i
    };

    for (const cfg of configs) {
      const eventSide = detectSide(cfg, ctx);
      if (!eventSide) continue;
      for (const horizon of horizons) {
        const future = candles[i + horizon];
        const grossBps = eventSide * (future.c / candle.c - 1) * 10000;
        observations.push({
          family: cfg.family,
          config: cfg.key,
          horizon,
          ts: candle.ts,
          side: eventSide > 0 ? 'LONG' : 'SHORT',
          grossBps,
          netBps: grossBps - costBps
        });
      }
    }
  }

  return { candles, configs, horizons, observations, costBps };
}

function summarize(observations) {
  if (!observations.length) return null;
  const values = observations.map(x => x.netBps);
  const n = values.length;
  const meanBps = values.reduce((a, b) => a + b, 0) / n;
  const positive = values.filter(x => x > 0);
  const negative = values.filter(x => x < 0);
  const positiveSum = positive.reduce((a, b) => a + b, 0);
  const negativeSum = -negative.reduce((a, b) => a + b, 0);
  return {
    n,
    meanBps,
    medianBps: median(values),
    winRate: positive.length / n,
    profitFactor: negativeSum > 0 ? positiveSum / negativeSum : Infinity,
    stdevBps: stdev(values)
  };
}

function roundSummary(s) {
  if (!s) return null;
  return {
    n: s.n,
    meanBps: +s.meanBps.toFixed(2),
    medianBps: +s.medianBps.toFixed(2),
    winRatePct: +(s.winRate * 100).toFixed(1),
    profitFactor: Number.isFinite(s.profitFactor) ? +s.profitFactor.toFixed(3) : null,
    stdevBps: +s.stdevBps.toFixed(2)
  };
}

function discover(inputRows, options = {}) {
  const extracted = extractObservations(inputRows, options);
  const { candles, configs, horizons, observations, costBps } = extracted;
  if (candles.length < 200) throw new Error('INSUFFICIENT_CANDLES');

  const splitRatio = Math.min(0.90, Math.max(0.50, finite(options.splitRatio, DEFAULT_SPLIT_RATIO)));
  const startTs = candles[0].ts;
  const endTs = candles[candles.length - 1].ts;
  const splitTs = startTs + (endTs - startTs) * splitRatio;
  const folds = Math.max(2, finite(options.discoveryFolds, 4));
  const minTrainN = Math.max(10, finite(options.minTrainN, 30));
  const minPositiveFolds = Math.max(1, finite(options.minPositiveFolds, 3));
  const minHoldoutN = Math.max(5, finite(options.minHoldoutN, 10));
  const trainQualified = [];

  for (const cfg of configs) {
    for (const horizon of horizons) {
      const train = observations.filter(x => x.config === cfg.key && x.horizon === horizon && x.ts < splitTs);
      if (train.length < minTrainN) continue;
      const foldStats = [];
      for (let f = 0; f < folds; f += 1) {
        const a = startTs + (splitTs - startTs) * f / folds;
        const b = startTs + (splitTs - startTs) * (f + 1) / folds;
        foldStats.push(summarize(train.filter(x => x.ts >= a && x.ts < b)));
      }
      const trainStats = summarize(train);
      const positiveFolds = foldStats.filter(x => x && x.meanBps > 0).length;
      if (trainStats.meanBps <= 0 || trainStats.profitFactor <= 1 || positiveFolds < minPositiveFolds) continue;
      trainQualified.push({ cfg, horizon, trainStats, positiveFolds });
    }
  }

  trainQualified.sort((a, b) =>
    (b.positiveFolds - a.positiveFolds) ||
    (b.trainStats.meanBps - a.trainStats.meanBps) ||
    (b.trainStats.n - a.trainStats.n));

  const selected = [];
  const usedFamilyHorizon = new Set();
  for (const row of trainQualified) {
    const key = `${row.cfg.family}|${row.horizon}`;
    if (usedFamilyHorizon.has(key)) continue;
    usedFamilyHorizon.add(key);
    const holdout = observations.filter(x => x.config === row.cfg.key && x.horizon === row.horizon && x.ts >= splitTs);
    const holdoutStats = summarize(holdout);
    selected.push({
      family: row.cfg.family,
      config: row.cfg.key,
      horizon: row.horizon,
      train: roundSummary(row.trainStats),
      positiveDiscoveryFolds: row.positiveFolds,
      holdout: roundSummary(holdoutStats),
      holdoutPass: Boolean(holdoutStats && holdoutStats.n >= minHoldoutN && holdoutStats.meanBps > 0 && holdoutStats.profitFactor > 1)
    });
  }

  return {
    version: 'HUNTER_REBORN_RESEARCH_V0',
    mode: 'SHADOW_RESEARCH_ONLY',
    liveExecution: false,
    candleCount: candles.length,
    range: { startTs, endTs, splitTs },
    assumptions: { costBps, splitRatio, folds, minTrainN, minPositiveFolds, minHoldoutN },
    configsTested: configs.length,
    selected
  };
}

module.exports = {
  DEFAULT_COST_BPS,
  DEFAULT_HORIZONS,
  median,
  percentileRank,
  normalizeCandles,
  buildResearchConfigs,
  extractObservations,
  summarize,
  discover
};
