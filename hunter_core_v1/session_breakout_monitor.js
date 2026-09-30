'use strict';

const fs = require('fs');
const path = require('path');
const binance = require('./binance_public');
const okx = require('./okx_public');

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const SESSION_DEFS = {
  ASIA: { id: 'ASIA', label: 'Asia', tz: 'Asia/Tokyo', hour: 9, minute: 0 },
  LONDON: { id: 'LONDON', label: 'London', tz: 'Europe/London', hour: 8, minute: 0 },
  NEW_YORK: { id: 'NEW_YORK', label: 'New York', tz: 'America/New_York', hour: 9, minute: 30 }
};

const SYMBOLS = (process.env.HUNTER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const SESSION_IDS = (process.env.HUNTER_SESSIONS || 'LONDON,NEW_YORK')
  .split(',').map((s) => s.trim().toUpperCase()).filter((s) => SESSION_DEFS[s]);
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || process.env.CRYPTO_EQUITY_USDT || 1000);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || process.env.CRYPTO_RISK_PCT || 0.005);
const TP_R = Number(process.env.HUNTER_TP_R || 2);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const STATE_PATH = process.env.HUNTER_STATE_PATH || '/data/session_breakout_state.json';
const MAX_SIGNAL_AGE_MS = Number(process.env.HUNTER_MAX_SIGNAL_AGE_MS || 20 * 60 * 1000);
const STARTUP_NOTICE = String(process.env.TELEGRAM_STARTUP_NOTICE || '').toLowerCase() === 'true' || process.env.TELEGRAM_STARTUP_NOTICE === '1';

function localParts(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ts));
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = p.value;
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    hour: Number(out.hour),
    minute: Number(out.minute)
  };
}

function singaporeTime(ts) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ts));
}

function ema(values, period = 50) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  const alpha = 2 / (period + 1);
  let current = Number(values[0]);
  let previous = current;
  for (let i = 1; i < values.length; i += 1) {
    previous = current;
    current = alpha * Number(values[i]) + (1 - alpha) * current;
  }
  return { current, previous };
}

function h4Bias(candles4h) {
  const xs = [...(candles4h || [])].sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const closes = xs.map((c) => Number(c.close)).filter(Number.isFinite);
  const e = ema(closes, 50);
  if (!e || !closes.length) return { bias: 'FLAT', ema50: null, slope: null, close: closes.at(-1) ?? null };
  const close = closes[closes.length - 1];
  const slope = e.current - e.previous;
  if (close > e.current && slope > 0) return { bias: 'BULLISH', ema50: e.current, slope, close };
  if (close < e.current && slope < 0) return { bias: 'BEARISH', ema50: e.current, slope, close };
  return { bias: 'FLAT', ema50: e.current, slope, close };
}

function utcDate(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

function dailyVwap(candles15m, targetOpenTime) {
  const targetDay = utcDate(targetOpenTime);
  let pv = 0;
  let vol = 0;
  for (const c of candles15m || []) {
    const t = Number(c.openTime);
    if (!Number.isFinite(t) || t > targetOpenTime || utcDate(t) !== targetDay) continue;
    const h = Number(c.high), l = Number(c.low), cl = Number(c.close), v = Number(c.volume);
    if (![h, l, cl, v].every(Number.isFinite) || v <= 0) continue;
    const typical = (h + l + cl) / 3;
    pv += typical * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

function sessionBox(candles15m, candidateOpenTime, session) {
  const candidateLocal = localParts(candidateOpenTime, session.tz);
  const sorted = [...(candles15m || [])].sort((a, b) => Number(a.openTime) - Number(b.openTime));
  let first = null;
  let second = null;
  let secondHour = session.hour;
  let secondMinute = session.minute + 15;
  if (secondMinute >= 60) { secondMinute -= 60; secondHour += 1; }

  for (const c of sorted) {
    const p = localParts(Number(c.openTime), session.tz);
    if (p.date !== candidateLocal.date) continue;
    if (p.hour === session.hour && p.minute === session.minute) first = c;
    if (p.hour === secondHour && p.minute === secondMinute) second = c;
  }
  if (!first || !second) return null;
  return {
    date: candidateLocal.date,
    first,
    second,
    high: Math.max(Number(first.high), Number(second.high)),
    low: Math.min(Number(first.low), Number(second.low)),
    activeFrom: Number(second.openTime) + M15_MS,
    activeUntil: Number(second.openTime) + 6 * HOUR_MS
  };
}

function evaluateSession(snapshot, sessionId, now = Date.now(), opts = {}) {
  const session = SESSION_DEFS[sessionId];
  if (!session) return null;
  const c15 = [...(snapshot.candles15m || [])].sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const latest = c15[c15.length - 1];
  if (!latest) return null;

  const latestOpen = Number(latest.openTime);
  const inferredClose = latestOpen + M15_MS;
  const age = now - inferredClose;
  const maxAge = Number(opts.maxSignalAgeMs ?? MAX_SIGNAL_AGE_MS);
  if (age < -60_000 || age > maxAge) return null;

  const box = sessionBox(c15, latestOpen, session);
  if (!box) return null;
  if (latestOpen < box.activeFrom || latestOpen >= box.activeUntil) return null;

  const h4 = h4Bias(snapshot.candles4h || []);
  const vwap = dailyVwap(c15, latestOpen);
  if (!Number.isFinite(vwap)) return null;

  const close = Number(latest.close);
  let side = null;
  if (close > box.high && close > vwap && h4.bias === 'BULLISH') side = 'LONG';
  if (close < box.low && close < vwap && h4.bias === 'BEARISH') side = 'SHORT';
  if (!side) return null;

  const entry = close;
  const stop = side === 'LONG' ? box.low : box.high;
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;
  const tpR = Number(opts.tpR ?? TP_R);
  const target = side === 'LONG' ? entry + tpR * riskDistance : entry - tpR * riskDistance;
  const equity = Number(opts.equity ?? EQUITY);
  const riskPct = Number(opts.riskPct ?? RISK_PCT);
  const riskUsd = equity > 0 && riskPct > 0 ? equity * riskPct : null;
  const quantity = Number.isFinite(riskUsd) && riskDistance > 0 ? riskUsd / riskDistance : null;

  return {
    key: `${snapshot.symbol}|${session.id}|${box.date}`,
    symbol: snapshot.symbol,
    provider: snapshot.provider || 'UNKNOWN',
    session: session.id,
    sessionLabel: session.label,
    localSessionDate: box.date,
    side,
    candleOpenTime: latestOpen,
    candleCloseTime: inferredClose,
    close,
    vwap,
    h4Bias: h4.bias,
    h4Ema50: h4.ema50,
    boxHigh: box.high,
    boxLow: box.low,
    entry,
    stop,
    target,
    tpR,
    riskDistance,
    riskUsd,
    quantity
  };
}

function priceFmt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function buildMessage(s) {
  const icon = s.side === 'LONG' ? '🟢' : '🔴';
  const breakText = s.side === 'LONG'
    ? `${priceFmt(s.close)} > ${priceFmt(s.boxHigh)}`
    : `${priceFmt(s.close)} < ${priceFmt(s.boxLow)}`;
  return [
    `${icon} SESSION BREAKOUT SIGNAL`,
    '',
    `${s.symbol} — ${s.side}`,
    `Session: ${s.sessionLabel}`,
    `M15 close: ${breakText}`,
    `H4 trend: ${s.h4Bias}`,
    `VWAP: ${priceFmt(s.vwap)} (${s.side === 'LONG' ? 'price above' : 'price below'})`,
    '',
    `🎯 Entry: ~${priceFmt(s.entry)}`,
    `🛑 SL: ${priceFmt(s.stop)}`,
    `✅ TP: ${priceFmt(s.target)} (${s.tpR.toFixed(1)}R)`,
    Number.isFinite(s.riskUsd) ? `Risk: ${(RISK_PCT * 100).toFixed(1)}% (~$${s.riskUsd.toFixed(2)})` : null,
    '',
    `Closed: ${singaporeTime(s.candleCloseTime)} SGT`,
    'Mode: SIGNAL ONLY'
  ].filter(Boolean).join('\n');
}

async function telegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(JSON.stringify({ telegram: 'SKIPPED', reason: 'missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' }));
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return true;
}

function loadState(file = STATE_PATH) {
  try {
    if (!fs.existsSync(file)) return { sent: {} };
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    return x && typeof x.sent === 'object' ? x : { sent: {} };
  } catch {
    return { sent: {} };
  }
}

function saveState(state, file = STATE_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cutoff = Date.now() - 10 * 24 * HOUR_MS;
  for (const [k, v] of Object.entries(state.sent || {})) {
    if (!v || Number(v.atMs || 0) < cutoff) delete state.sent[k];
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

async function marketSnapshot(symbol) {
  try {
    const [candles15m, candles4h] = await Promise.all([
      binance.klines(symbol, '15m', 180),
      binance.klines(symbol, '4h', 90)
    ]);
    return { symbol, provider: 'BINANCE', candles15m, candles4h };
  } catch (err) {
    console.warn(JSON.stringify({ provider: 'BINANCE', symbol, status: 'FALLBACK', error: err.message }));
    const [candles15m, candles4h] = await Promise.all([
      okx.candles(symbol, '15m', 180),
      okx.candles(symbol, '4h', 90)
    ]);
    return { symbol, provider: 'OKX_FALLBACK', candles15m, candles4h };
  }
}

async function cycle() {
  const now = Date.now();
  const state = loadState();
  const snapshots = await Promise.all(SYMBOLS.map(marketSnapshot));
  const candidates = [];

  for (const snap of snapshots) {
    for (const sessionId of SESSION_IDS) {
      const signal = evaluateSession(snap, sessionId, now);
      if (signal && !state.sent[signal.key]) candidates.push(signal);
    }
  }

  console.log(JSON.stringify({
    engine: 'Session Breakout Monitor V1',
    mode: 'SIGNAL_ONLY',
    at: new Date(now).toISOString(),
    symbols: SYMBOLS,
    sessions: SESSION_IDS,
    providers: Object.fromEntries(snapshots.map((s) => [s.symbol, s.provider])),
    candidates: candidates.map((s) => ({ symbol: s.symbol, session: s.session, side: s.side, close: s.close, vwap: s.vwap, h4Bias: s.h4Bias }))
  }, null, 2));

  for (const signal of candidates) {
    try {
      if (await telegram(buildMessage(signal))) {
        state.sent[signal.key] = { at: new Date().toISOString(), atMs: Date.now(), side: signal.side, candleOpenTime: signal.candleOpenTime };
        saveState(state);
        console.log(JSON.stringify({ telegram: 'SENT', key: signal.key, symbol: signal.symbol, session: signal.session, side: signal.side }));
      }
    } catch (err) {
      console.error(JSON.stringify({ telegram: 'ERROR', key: signal.key, error: err.message }));
    }
  }

  saveState(state);
}

function delayToNextQuarter(offsetMs = 8_000) {
  const now = Date.now();
  const next = (Math.floor(now / M15_MS) + 1) * M15_MS + offsetMs;
  return Math.max(5_000, next - now);
}

async function start() {
  console.log(JSON.stringify({
    engine: 'Session Breakout Monitor V1',
    status: 'STARTING',
    symbols: SYMBOLS,
    sessions: SESSION_IDS,
    tpR: TP_R,
    riskPct: RISK_PCT
  }));

  if (STARTUP_NOTICE) {
    try {
      await telegram(`✅ Session Breakout Monitor ONLINE\n\nSymbols: ${SYMBOLS.join(', ')}\nSessions: ${SESSION_IDS.join(', ')}\nRule: M15 close outside box + H4 EMA50 + VWAP\nMode: SIGNAL ONLY`);
    } catch (err) {
      console.error(JSON.stringify({ telegram: 'STARTUP_ERROR', error: err.message }));
    }
  }

  try { await cycle(); } catch (err) { console.error(JSON.stringify({ cycle: 'ERROR', error: err.message })); }

  const loop = () => {
    const wait = delayToNextQuarter();
    console.log(JSON.stringify({ nextScanInMs: wait, nextScanAt: new Date(Date.now() + wait).toISOString() }));
    setTimeout(async () => {
      try { await cycle(); } catch (err) { console.error(JSON.stringify({ cycle: 'ERROR', error: err.message })); }
      loop();
    }, wait);
  };
  loop();
}

if (require.main === module) {
  start().catch((err) => {
    console.error(JSON.stringify({ engine: 'Session Breakout Monitor V1', fatal: err.message }));
    process.exitCode = 1;
  });
}

module.exports = {
  SESSION_DEFS,
  localParts,
  ema,
  h4Bias,
  dailyVwap,
  sessionBox,
  evaluateSession,
  buildMessage,
  delayToNextQuarter
};
