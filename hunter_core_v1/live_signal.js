'use strict';

const path = require('path');
const { snapshot } = require('./market_data');
const { rankSnapshots } = require('./core');
const {
  loadState,
  saveState,
  processCycle,
  performance,
  stageFromEdge
} = require('./journal');
const { shortSymbol, watchPlan, regimeVisual } = require('./advisor');

const SYMBOLS = (process.env.HUNTER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || 1000);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || 0.005);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const STATE_PATH = process.env.HUNTER_STATE_PATH || path.join('.hunter_state', 'state.json');

const fmt = (x, d = 3) => Number.isFinite(Number(x)) ? Number(x).toFixed(d) : 'n/a';

function priceFmt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function buildMessage(x) {
  const p = x.plan;
  const isLong = x.decision === 'LONG';
  const icon = isLong ? '🟢' : '🔴';
  const [a, b] = p.entryZone;
  return [
    `${icon} HUNTER ACTIONABLE`,
    '',
    `${shortSymbol(x.symbol)} — ${x.decision}`,
    `Edge: ${fmt(x.edge, 2)}`,
    `${regimeVisual(x.regime.name).icon} Market: ${x.regime.name}`,
    '',
    `🎯 Entry: ${priceFmt(a)} - ${priceFmt(b)}`,
    `🛑 Stop: ${priceFmt(p.stop)}`,
    `Risk: ${(RISK_PCT * 100).toFixed(1)}%`,
    `Risk USD: ${fmt(p.riskUsd, 2)}`,
    '',
    '📒 Forward tracking: ON',
    'Mode: SIGNAL ONLY'
  ].join('\n');
}

function buildHeadsUp(x, snap) {
  const watch = watchPlan(x, snap);
  if (!watch) return null;
  const sideIcon = watch.side === 'LONG' ? '🟢' : '🔴';
  const price = Number(snap.lastPrice || snap.candles15m[snap.candles15m.length - 1]?.close);
  return [
    '🟠 HUNTER HEADS-UP — NOT A SIGNAL',
    '',
    `${shortSymbol(x.symbol)} may be forming ${sideIcon} ${watch.side}`,
    `Now: $${priceFmt(price)}`,
    `Edge: ${fmt(x.edge, 2)} / 0.65`,
    '',
    `👀 Watch zone: ${priceFmt(watch.zone[0])} - ${priceFmt(watch.zone[1])}`,
    `❌ Weakens beyond: ${priceFmt(watch.invalid)}`,
    `Need: Edge ${watch.side === 'LONG' ? '≥ +0.65' : '≤ -0.65'}`,
    '',
    'Prepare only. Do not enter yet.'
  ].join('\n');
}

function lifecycleMessage(event, state) {
  const s = state.signals.find((x) => x.id === event.signalId);
  const symbol = shortSymbol(event.symbol);
  if (event.type === 'ENTRY_TRIGGERED') {
    return [
      '🎯 ENTRY TRIGGERED',
      '',
      `${symbol} — ${event.side}`,
      `Tracked entry: ${priceFmt(event.entryMid)}`,
      `🛑 Stop: ${priceFmt(event.stop)}`,
      '',
      'Hunter is now measuring this setup.'
    ].join('\n');
  }
  if (event.type === 'STOP_TOUCHED') {
    return [
      '🔴 TRACKING UPDATE',
      '',
      `${symbol} — ${event.side}`,
      'Stop touched',
      'Result: -1.00R',
      '',
      'Recorded automatically.'
    ].join('\n');
  }
  if (event.type === 'FORWARD_COMPLETE') {
    const r = Number(event.finalR);
    const icon = r > 0 ? '🟢' : r < 0 ? '🔴' : '⚪';
    return [
      `${icon} 24H RESULT`,
      '',
      `${symbol} — ${event.side}`,
      `Result: ${fmt(r, 2)}R`,
      s && Number.isFinite(s.mfeR) ? `Best excursion: +${fmt(s.mfeR, 2)}R` : null,
      s && Number.isFinite(s.maeR) ? `Worst excursion: ${fmt(s.maeR, 2)}R` : null,
      '',
      'Recorded in Performance.'
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'INVALIDATED') {
    return [
      '⚪ SETUP CANCELLED',
      '',
      `${symbol} — ${event.side}`,
      'Conditions weakened before a valid entry.',
      '',
      'No trade.'
    ].join('\n');
  }
  if (event.type === 'EXPIRED') {
    return [
      '⚪ SETUP EXPIRED',
      '',
      `${symbol} — ${event.side}`,
      'Entry zone was not reached in time.',
      '',
      'No trade.'
    ].join('\n');
  }
  if (event.type === 'AMBIGUOUS') {
    return [
      '⚠️ SETUP NOT SCORED',
      '',
      `${symbol} — ${event.side}`,
      'Entry and stop were both inside the same 15m candle.',
      '',
      'Excluded rather than guessing the result.'
    ].join('\n');
  }
  return null;
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

function resetOldHeadsUps(state, ranked) {
  state.armedAlerts = state.armedAlerts || {};
  for (const x of ranked) {
    if (Math.abs(Number(x.edge)) < 0.35) delete state.armedAlerts[x.symbol];
  }
}

async function run() {
  const snaps = await Promise.all(SYMBOLS.map(snapshot));
  const ranked = rankSnapshots(snaps, EQUITY, RISK_PCT);
  const state = loadState(STATE_PATH);
  resetOldHeadsUps(state, ranked);

  const processed = processCycle(state, ranked, snaps, Date.now(), { maxNew: 1 });
  const created = processed.created;
  const events = processed.events || [];

  console.log(JSON.stringify({
    engine: 'Hunter Core V1',
    mode: 'SIGNAL_ONLY',
    at: new Date().toISOString(),
    providers: Object.fromEntries(snaps.map((s) => [s.symbol, s.provider])),
    ranked: ranked.map((x) => ({
      symbol: x.symbol,
      decision: x.decision,
      stage: stageFromEdge(x.edge),
      edge: x.edge,
      regime: x.regime.name
    })),
    lifecycleEvents: events,
    journal: performance(processed.state)
  }, null, 2));

  if (created.length) {
    const newSignal = created[0];
    const best = ranked.find((x) => x.symbol === newSignal.symbol && x.decision === newSignal.side);
    if (best) {
      const sent = await telegram(buildMessage(best));
      if (sent) {
        newSignal.deliveredAt = new Date().toISOString();
        processed.state.armedAlerts = processed.state.armedAlerts || {};
        processed.state.armedAlerts[best.symbol] = {
          side: best.decision,
          at: new Date().toISOString(),
          edge: best.edge
        };
        saveState(STATE_PATH, processed.state);
        console.log(JSON.stringify({ telegram: 'SENT_ACTIONABLE', symbol: best.symbol, decision: best.decision, edge: best.edge }));
      }
    }
  }

  // Lifecycle updates are separate from signal discovery and are capped to avoid message floods.
  let lifecycleSent = 0;
  for (const event of events) {
    if (lifecycleSent >= 2) break;
    const message = lifecycleMessage(event, processed.state);
    if (!message) continue;
    if (await telegram(message)) {
      lifecycleSent += 1;
      saveState(STATE_PATH, processed.state);
      console.log(JSON.stringify({ telegram: 'SENT_LIFECYCLE', type: event.type, symbol: event.symbol }));
    }
  }

  if (!created.length) {
    const armed = ranked.find((x) => stageFromEdge(x.edge) === 'ARMED');
    if (armed) {
      const side = Number(armed.edge) >= 0 ? 'LONG' : 'SHORT';
      const prev = processed.state.armedAlerts?.[armed.symbol];
      const shouldSend = !prev || prev.side !== side;

      if (shouldSend) {
        const snap = snaps.find((s) => s.symbol === armed.symbol);
        const message = snap ? buildHeadsUp(armed, snap) : null;
        if (message && await telegram(message)) {
          processed.state.armedAlerts = processed.state.armedAlerts || {};
          processed.state.armedAlerts[armed.symbol] = {
            side,
            at: new Date().toISOString(),
            edge: armed.edge
          };
          console.log(JSON.stringify({ telegram: 'SENT_HEADS_UP', symbol: armed.symbol, side, edge: armed.edge }));
        }
      } else {
        console.log(JSON.stringify({ telegram: 'SKIPPED', reason: 'armed heads-up already sent', symbol: armed.symbol }));
      }
    } else if (!events.length) {
      console.log(JSON.stringify({ telegram: 'SKIPPED', reason: 'no actionable, armed, or lifecycle event' }));
    }
  }

  saveState(STATE_PATH, processed.state);
}

run().catch((err) => {
  console.error(JSON.stringify({ engine: 'Hunter Core V1', ok: false, error: err.message }, null, 2));
  process.exitCode = 1;
});
