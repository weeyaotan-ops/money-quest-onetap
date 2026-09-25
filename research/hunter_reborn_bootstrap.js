'use strict';

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

function quantile(xs, q) {
  if (!Array.isArray(xs) || xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const p = (s.length - 1) * q;
  const i = Math.floor(p);
  const f = p - i;
  return s[i] * (1 - f) + s[Math.min(i + 1, s.length - 1)] * f;
}

function strategyMetrics(returns, annualization = 365.25) {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const r of returns) {
    equity *= Math.max(1e-9, 1 + Number(r));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }

  const years = returns.length / annualization;
  const avg = mean(returns);
  const sd = stdev(returns);
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;

  return {
    cagr,
    maxDrawdown,
    sharpe: sd > 0 ? avg / sd * Math.sqrt(annualization) : 0,
    endingEquity: equity
  };
}

function makeLcg(seed = 20260926) {
  let x = Number(seed) >>> 0;
  return function random() {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function pairedBlockBootstrap(coreReturns, defensiveReturns, {
  blockLength = 7,
  replicates = 5000,
  seed = 20260926,
  annualization = 365.25
} = {}) {
  if (!Array.isArray(coreReturns) || !Array.isArray(defensiveReturns)) {
    throw new Error('RETURNS_MUST_BE_ARRAYS');
  }
  if (coreReturns.length !== defensiveReturns.length || coreReturns.length < 2) {
    throw new Error('PAIRED_RETURNS_LENGTH_MISMATCH');
  }
  if (!(blockLength >= 1) || !(replicates >= 1)) {
    throw new Error('INVALID_BOOTSTRAP_CONFIG');
  }

  const n = coreReturns.length;
  const maxStart = Math.max(1, n - blockLength + 1);
  const random = makeLcg(seed + blockLength);
  const samples = [];

  for (let b = 0; b < replicates; b += 1) {
    const corePath = [];
    const defensivePath = [];

    while (corePath.length < n) {
      const start = Math.floor(random() * maxStart);
      for (let k = 0; k < blockLength && corePath.length < n; k += 1) {
        corePath.push(Number(coreReturns[start + k]));
        defensivePath.push(Number(defensiveReturns[start + k]));
      }
    }

    const core = strategyMetrics(corePath, annualization);
    const defensive = strategyMetrics(defensivePath, annualization);

    samples.push({
      coreCagr: core.cagr,
      defensiveCagr: defensive.cagr,
      coreMaxDrawdown: core.maxDrawdown,
      defensiveMaxDrawdown: defensive.maxDrawdown,
      coreSharpe: core.sharpe,
      defensiveSharpe: defensive.sharpe
    });
  }

  return samples;
}

function summarizePairedBootstrap(samples) {
  const pick = key => samples.map(x => Number(x[key]));
  const summary = key => ({
    p05: quantile(pick(key), 0.05),
    median: quantile(pick(key), 0.50),
    p95: quantile(pick(key), 0.95)
  });

  return {
    replicates: samples.length,
    core: {
      cagr: summary('coreCagr'),
      maxDrawdown: summary('coreMaxDrawdown'),
      sharpe: summary('coreSharpe')
    },
    defensive: {
      cagr: summary('defensiveCagr'),
      maxDrawdown: summary('defensiveMaxDrawdown'),
      sharpe: summary('defensiveSharpe')
    },
    paired: {
      defensiveShallowerDrawdownRate: samples.filter(x => x.defensiveMaxDrawdown > x.coreMaxDrawdown).length / samples.length,
      defensiveHigherSharpeRate: samples.filter(x => x.defensiveSharpe > x.coreSharpe).length / samples.length,
      defensiveHigherCagrRate: samples.filter(x => x.defensiveCagr > x.coreCagr).length / samples.length,
      defensivePositiveCagrRate: samples.filter(x => x.defensiveCagr > 0).length / samples.length,
      corePositiveCagrRate: samples.filter(x => x.coreCagr > 0).length / samples.length
    }
  };
}

module.exports = {
  mean,
  stdev,
  quantile,
  strategyMetrics,
  makeLcg,
  pairedBlockBootstrap,
  summarizePairedBootstrap
};
