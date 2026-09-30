'use strict';

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const logReturn = (a, b) => (a > 0 && b > 0) ? Math.log(b / a) : 0;

function closes(candles) { return candles.map((c) => Number(c.close)); }
function highs(candles) { return candles.map((c) => Number(c.high)); }
function lows(candles) { return candles.map((c) => Number(c.low)); }
function volumes(candles) { return candles.map((c) => Number(c.volume)); }

function returnsFromCloses(xs) {
  const out = [];
  for (let i = 1; i < xs.length; i += 1) out.push(logReturn(xs[i - 1], xs[i]));
  return out;
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const pc = Number(candles[i - 1].close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return mean(trs.slice(-period));
}

function normalizedMomentum(candles, lookback) {
  const xs = closes(candles);
  if (xs.length <= lookback) return 0;
  const slice = xs.slice(-(lookback + 1));
  const r = logReturn(slice[0], slice[slice.length - 1]);
  const rs = returnsFromCloses(slice);
  const vol = stdev(rs) * Math.sqrt(Math.max(lookback, 1));
  if (vol < 1e-12) return 0;
  return clamp((r / vol) / 2.5);
}

function efficiencyRatio(candles, lookback = 20) {
  const xs = closes(candles);
  if (xs.length <= lookback) return 0;
  const s = xs.slice(-(lookback + 1));
  const net = Math.abs(s[s.length - 1] - s[0]);
  let path = 0;
  for (let i = 1; i < s.length; i += 1) path += Math.abs(s[i] - s[i - 1]);
  return path > 0 ? clamp(net / path, 0, 1) : 0;
}

function recentVolatility(candles, lookback = 20) {
  const rs = returnsFromCloses(closes(candles));
  return stdev(rs.slice(-lookback));
}

function volumeZ(candles, lookback = 30) {
  const vs = volumes(candles);
  if (vs.length < 3) return 0;
  const hist = vs.slice(-lookback - 1, -1);
  const sd = stdev(hist);
  return sd > 0 ? (vs[vs.length - 1] - mean(hist)) / sd : 0;
}

function breakoutDirection(candles, lookback = 20) {
  if (candles.length <= lookback) return 0;
  const prior = candles.slice(-(lookback + 1), -1);
  const last = candles[candles.length - 1];
  const maxH = Math.max(...highs(prior));
  const minL = Math.min(...lows(prior));
  if (Number(last.close) > maxH) return 1;
  if (Number(last.close) < minL) return -1;
  return 0;
}

function trendScore(snapshot) {
  return clamp(
    0.50 * normalizedMomentum(snapshot.candles4h, 12) +
    0.30 * normalizedMomentum(snapshot.candles1h, 24) +
    0.20 * normalizedMomentum(snapshot.candles15m, 16)
  );
}

function classifyRegime(snapshot, tScore = trendScore(snapshot)) {
  const c15 = snapshot.candles15m;
  const er = efficiencyRatio(snapshot.candles1h, 20);
  const vShort = recentVolatility(c15, 8);
  const vLong = recentVolatility(c15, 40) || 1e-12;
  const volRatio = vShort / vLong;
  const a = atr(c15, 14);
  const last = c15[c15.length - 1];
  const lastRange = last ? Number(last.high) - Number(last.low) : 0;
  const br = breakoutDirection(c15, 20);
  const vz = volumeZ(c15, 30);

  if (volRatio > 2.25 || (a > 0 && lastRange > 3.25 * a)) {
    return { name: 'CHAOS', multiplier: 0, diagnostics: { er, volRatio, breakout: br, volumeZ: vz } };
  }
  if (br !== 0 && vz > 0.25 && Math.sign(tScore || br) === br) {
    return { name: 'BREAKOUT', multiplier: 0.8, diagnostics: { er, volRatio, breakout: br, volumeZ: vz } };
  }
  if (er >= 0.34 && Math.abs(tScore) >= 0.28) {
    return { name: 'TREND', multiplier: 1.0, diagnostics: { er, volRatio, breakout: br, volumeZ: vz } };
  }
  return { name: 'RANGE', multiplier: 0.25, diagnostics: { er, volRatio, breakout: br, volumeZ: vz } };
}

function riskAdjustedReturn(candles, lookback = 24) {
  const xs = closes(candles);
  if (xs.length <= lookback) return 0;
  const r = logReturn(xs[xs.length - 1 - lookback], xs[xs.length - 1]);
  const rs = returnsFromCloses(xs.slice(-(lookback + 1)));
  const vol = stdev(rs) * Math.sqrt(lookback);
  return vol > 1e-12 ? r / vol : 0;
}

function relativeStrengthScores(snapshots) {
  const raw = snapshots.map((s) => ({ symbol: s.symbol, value: riskAdjustedReturn(s.candles1h, 24) }));
  const vals = raw.map((x) => x.value);
  const m = mean(vals);
  const sd = stdev(vals);
  const out = {};
  for (const x of raw) {
    const z = sd > 1e-12 ? (x.value - m) / sd : 0;
    out[x.symbol] = clamp(Math.tanh(z / 1.25));
  }
  return out;
}

function zScoreLatest(values) {
  if (!values || values.length < 3) return 0;
  const hist = values.slice(0, -1);
  const sd = stdev(hist);
  return sd > 1e-12 ? (values[values.length - 1] - mean(hist)) / sd : 0;
}

function derivativesScore(snapshot, tScore = trendScore(snapshot)) {
  const fundingRates = (snapshot.funding || []).map((x) => Number(x.rate)).filter(Number.isFinite);
  const fundingZ = zScoreLatest(fundingRates.slice(-30));
  const fundingComponent = clamp(-Math.tanh(fundingZ / 2));

  const oi = snapshot.openInterestHistory || [];
  let oiChange = 0;
  if (oi.length >= 2) {
    const a = Number(oi[oi.length - 2].value);
    const b = Number(oi[oi.length - 1].value);
    if (a > 0 && b > 0) oiChange = Math.log(b / a);
  }
  const oiMagnitude = clamp(Math.abs(oiChange) / 0.025, 0, 1);
  const oiComponent = oiChange > 0 ? Math.sign(tScore) * oiMagnitude : 0;

  const basisRates = (snapshot.basis || []).map((x) => Number(x.rate)).filter(Number.isFinite);
  const latestBasis = basisRates.length ? basisRates[basisRates.length - 1] : 0;
  const basisComponent = clamp(-Math.tanh(latestBasis / 0.0015));

  const score = clamp(0.40 * fundingComponent + 0.40 * oiComponent + 0.20 * basisComponent);
  return { score, fundingZ, oiChange, latestBasis, components: { fundingComponent, oiComponent, basisComponent } };
}

function flowScore(snapshot) {
  const rows = snapshot.taker || [];
  if (!rows.length) return 0;
  const recent = rows.slice(-8).map((x) => Number(x.buySellRatio)).filter((x) => Number.isFinite(x) && x > 0);
  if (!recent.length) return 0;
  const avgLogRatio = mean(recent.map((x) => Math.log(x)));
  return clamp(Math.tanh(avgLogRatio / 0.35));
}

function calculatePosition({ equity, riskPct = 0.005, entry, stop }) {
  const e = Number(equity);
  const en = Number(entry);
  const st = Number(stop);
  const perUnitRisk = Math.abs(en - st);
  if (!(e > 0) || !(perUnitRisk > 0)) return { riskUsd: 0, quantity: 0, notional: 0 };
  const riskUsd = e * riskPct;
  const quantity = riskUsd / perUnitRisk;
  return { riskUsd, quantity, notional: quantity * en };
}

function buildTradePlan(snapshot, side, equity = 1000, riskPct = 0.005) {
  const price = Number(snapshot.candles15m[snapshot.candles15m.length - 1].close);
  const a = atr(snapshot.candles15m, 14);
  if (!(price > 0) || !(a > 0)) return null;
  const dir = side === 'LONG' ? 1 : -1;
  const entryNear = price - dir * 0.10 * a;
  const entryFar = price - dir * 0.35 * a;
  const lo = Math.min(entryNear, entryFar);
  const hi = Math.max(entryNear, entryFar);
  const entryMid = (lo + hi) / 2;
  const stop = entryMid - dir * 1.5 * a;
  const sizing = calculatePosition({ equity, riskPct, entry: entryMid, stop });
  return { entryZone: [lo, hi], entryMid, stop, atr15m: a, ...sizing };
}

function scoreSnapshot(snapshot, relativeStrength = 0, equity = 1000, riskPct = 0.005) {
  const trend = trendScore(snapshot);
  const regime = classifyRegime(snapshot, trend);
  const deriv = derivativesScore(snapshot, trend);
  const flow = flowScore(snapshot);
  const edgeRaw = clamp(0.40 * trend + 0.25 * relativeStrength + 0.20 * deriv.score + 0.15 * flow);
  const edge = clamp(edgeRaw * regime.multiplier);
  let decision = 'NO_TRADE';
  if (edge >= 0.65) decision = 'LONG';
  if (edge <= -0.65) decision = 'SHORT';
  const plan = decision === 'NO_TRADE' ? null : buildTradePlan(snapshot, decision, equity, riskPct);

  return {
    symbol: snapshot.symbol,
    decision,
    edge,
    edgeRaw,
    regime,
    components: {
      trend,
      relativeStrength,
      derivatives: deriv.score,
      flow
    },
    derivativesDiagnostics: deriv,
    plan
  };
}

function rankSnapshots(snapshots, equity = 1000, riskPct = 0.005) {
  const rs = relativeStrengthScores(snapshots);
  return snapshots
    .map((s) => scoreSnapshot(s, rs[s.symbol] || 0, equity, riskPct))
    .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

module.exports = {
  clamp,
  mean,
  stdev,
  atr,
  normalizedMomentum,
  efficiencyRatio,
  trendScore,
  classifyRegime,
  relativeStrengthScores,
  derivativesScore,
  flowScore,
  calculatePosition,
  buildTradePlan,
  scoreSnapshot,
  rankSnapshots
};
