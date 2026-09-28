'use strict';

const { snapshot } = require('./market_data');
const { rankSnapshots } = require('./core');

const SYMBOLS = (process.env.HUNTER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || 1000);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || 0.005);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const fmt = (x, d = 3) => Number.isFinite(x) ? Number(x).toFixed(d) : 'n/a';

function buildMessage(x) {
  const p = x.plan;
  const side = x.decision === 'LONG' ? 'LONG' : 'SHORT';
  const [a, b] = p.entryZone;
  return [
    'HUNTER CORE V1',
    '',
    `${x.symbol} — ${side}`,
    `Edge: ${fmt(x.edge, 3)}`,
    `Regime: ${x.regime.name}`,
    '',
    `Trend: ${fmt(x.components.trend, 3)}`,
    `Relative Strength: ${fmt(x.components.relativeStrength, 3)}`,
    `Derivatives: ${fmt(x.components.derivatives, 3)}`,
    `Flow: ${fmt(x.components.flow, 3)}`,
    '',
    `Entry: ${fmt(a, 4)} – ${fmt(b, 4)}`,
    `Stop: ${fmt(p.stop, 4)}`,
    `Risk: ${(RISK_PCT * 100).toFixed(2)}% equity`,
    `Risk USD: ${fmt(p.riskUsd, 2)}`,
    `Position: ${fmt(p.notional, 2)} USDT`,
    '',
    'Mode: SIGNAL ONLY'
  ].join('\n');
}

async function telegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(JSON.stringify({ telegram: 'SKIPPED', reason: 'missing GitHub Actions secrets' }));
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return true;
}

async function run() {
  const snaps = await Promise.all(SYMBOLS.map(snapshot));
  const ranked = rankSnapshots(snaps, EQUITY, RISK_PCT);
  const actionable = ranked.filter((x) => x.decision !== 'NO_TRADE');

  console.log(JSON.stringify({
    engine: 'Hunter Core V1',
    mode: 'SIGNAL_ONLY',
    at: new Date().toISOString(),
    ranked: ranked.map((x) => ({
      symbol: x.symbol,
      decision: x.decision,
      edge: x.edge,
      regime: x.regime.name
    }))
  }, null, 2));

  if (!actionable.length) {
    console.log(JSON.stringify({ telegram: 'SKIPPED', reason: 'no actionable edge' }));
    return;
  }

  // Only notify the strongest actionable market per cycle.
  const best = actionable[0];
  const sent = await telegram(buildMessage(best));
  if (sent) console.log(JSON.stringify({ telegram: 'SENT', symbol: best.symbol, decision: best.decision, edge: best.edge }));
}

run().catch((err) => {
  console.error(JSON.stringify({ engine: 'Hunter Core V1', ok: false, error: err.message }, null, 2));
  process.exitCode = 1;
});
