'use strict';

const { snapshot } = require('./binance_public');
const { rankSnapshots } = require('./core');

const SYMBOLS = (process.env.HUNTER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || 1000);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || 0.005);

function r(x, d = 3) { return Number.isFinite(x) ? Number(x.toFixed(d)) : null; }

function compact(result) {
  const p = result.plan;
  return {
    symbol: result.symbol,
    decision: result.decision,
    edge: r(result.edge),
    regime: result.regime.name,
    scores: {
      trend: r(result.components.trend),
      relativeStrength: r(result.components.relativeStrength),
      derivatives: r(result.components.derivatives),
      flow: r(result.components.flow)
    },
    trade: p ? {
      entryZone: p.entryZone.map((x) => r(x, 4)),
      stop: r(p.stop, 4),
      riskUsd: r(p.riskUsd, 2),
      quantity: r(p.quantity, 6),
      notional: r(p.notional, 2)
    } : null
  };
}

async function run() {
  const startedAt = new Date().toISOString();
  const snaps = await Promise.all(SYMBOLS.map(snapshot));
  const ranked = rankSnapshots(snaps, EQUITY, RISK_PCT);
  const actionable = ranked.find((x) => x.decision !== 'NO_TRADE');
  const payload = {
    engine: 'Hunter Core V1',
    mode: 'SIGNAL_ONLY',
    startedAt,
    equityUsd: EQUITY,
    riskPct: RISK_PCT,
    symbols: SYMBOLS,
    ranked: ranked.map(compact),
    bestActionable: actionable ? compact(actionable) : null
  };
  console.log(JSON.stringify(payload, null, 2));
}

run().catch((err) => {
  console.error(JSON.stringify({ engine: 'Hunter Core V1', ok: false, error: err.message }, null, 2));
  process.exitCode = 1;
});
