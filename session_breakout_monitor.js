'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BINANCE_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com';
const OKX_BASE = process.env.OKX_REST_BASE || process.env.OKX_API_BASE || 'https://www.okx.com';

const SYMBOLS = (process.env.HUNTER_SYMBOLS || process.env.CRYPTO_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,SUIUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const SESSION_DEFS = {
  ASIA: { id: 'ASIA', label: 'Asia', tz: 'Asia/Tokyo', hour: 9, minute: 0 },
  LONDON: { id: 'LONDON', label: 'London', tz: 'Europe/London', hour: 8, minute: 0 },
  NEW_YORK: { id: 'NEW_YORK', label: 'New York', tz: 'America/New_York', hour: 9, minute: 30 }
};

const SESSION_IDS = (process.env.HUNTER_SESSIONS || 'LONDON,NEW_YORK')
  .split(',').map(s => s.trim().toUpperCase()).filter(s => SESSION_DEFS[s]);

const TP_R = Number(process.env.HUNTER_TP_R || 2);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || process.env.CRYPTO_RISK_PCT || 0.005);
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || process.env.CRYPTO_EQUITY_USDT || 1000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const STATE_PATH = process.env.HUNTER_STATE_PATH || '/data/session_breakout_state.json';
const MAX_SIGNAL_AGE_MS = Number(process.env.HUNTER_MAX_SIGNAL_AGE_MS || 20 * 60 * 1000);
const PORT = Number(process.env.PORT || 3000);
const MT5_FEED_URL = process.env.MT5_FEED_URL || '';
const MT5_FEED_TOKEN = process.env.MT5_FEED_TOKEN || '';
const MT5_SYMBOLS = (process.env.MT5_SYMBOLS || 'XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCHF,USDCAD,NZDUSD')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const STARTUP_NOTICE = ['1','true','yes'].includes(String(process.env.TELEGRAM_STARTUP_NOTICE || '').toLowerCase());
const RUN_ONCE = ['1','true','yes'].includes(String(process.env.HUNTER_RUN_ONCE || '').toLowerCase());

function fmtPrice(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

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

function sgtTime(ts) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ts));
}

function utcDate(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'money-quest-session-breakout/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function mapBinanceKlines(rows, now = Date.now()) {
  return rows.map(r => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[6])
  })).filter(c => Number.isFinite(c.closeTime) && c.closeTime <= now);
}

async function binanceKlines(symbol, interval, limit, now = Date.now()) {
  const qs = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const rows = await getJson(`${BINANCE_BASE}/fapi/v1/klines?${qs.toString()}`);
  return mapBinanceKlines(rows, now);
}

function okxInstId(symbol) {
  return `${String(symbol).replace(/USDT$/i, '')}-USDT-SWAP`;
}

function mapOkxCandles(rows) {
  return rows.filter(r => String(r[8] ?? '1') === '1').map(r => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[0]) + M15_MS - 1
  })).sort((a, b) => a.openTime - b.openTime);
}

async function okxCandles(symbol, bar, limit = 300) {
  const qs = new URLSearchParams({ instId: okxInstId(symbol), bar, limit: String(Math.min(limit, 300)) });
  const body = await getJson(`${OKX_BASE}/api/v5/market/candles?${qs.toString()}`);
  if (body.code !== '0') throw new Error(`OKX ${body.code}: ${body.msg || 'unknown'}`);
  return mapOkxCandles(body.data || []);
}

async function snapshot(symbol, now = Date.now()) {
  try {
    const [candles15m, candles4h] = await Promise.all([
      binanceKlines(symbol, '15m', 300, now),
      binanceKlines(symbol, '4h', 100, now)
    ]);
    return { symbol, provider: 'BINANCE', candles15m, candles4h };
  } catch (error) {
    console.warn(JSON.stringify({ symbol, provider: 'BINANCE', fallback: true, error: error.message }));
    const [candles15m, candles4h] = await Promise.all([
      okxCandles(symbol, '15m', 300),
      okxCandles(symbol, '4H', 100)
    ]);
    return { symbol, provider: 'OKX_FALLBACK', candles15m, candles4h };
  }
}

function normalizeMt5Candle(x) {
  const openTime = Number(x.openTime ?? x.time ?? x.timestamp);
  return {
    openTime,
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume ?? x.tickVolume ?? 0),
    closeTime: Number(x.closeTime ?? (openTime + M15_MS - 1))
  };
}

async function mt5Snapshots() {
  if (!MT5_FEED_URL) return [];
  const headers = { 'user-agent': 'money-quest-session-breakout/1.0' };
  if (MT5_FEED_TOKEN) headers.authorization = `Bearer ${MT5_FEED_TOKEN}`;
  const res = await fetch(MT5_FEED_URL, { headers });
  if (!res.ok) throw new Error(`MT5 feed HTTP ${res.status}`);
  const body = await res.json();
  const root = body.symbols || body.data || body;
  const out = [];
  for (const symbol of MT5_SYMBOLS) {
    const row = root[symbol];
    if (!row) continue;
    const candles15m = (row.candles15m || row.m15 || []).map(normalizeMt5Candle)
      .filter(x => Number.isFinite(x.openTime) && [x.open,x.high,x.low,x.close].every(Number.isFinite))
      .sort((a,b)=>a.openTime-b.openTime);
    const candles4h = (row.candles4h || row.h4 || []).map(normalizeMt5Candle)
      .filter(x => Number.isFinite(x.openTime) && [x.open,x.high,x.low,x.close].every(Number.isFinite))
      .sort((a,b)=>a.openTime-b.openTime);
    if (candles15m.length >= 20 && candles4h.length >= 51) {
      out.push({ symbol, provider: 'MT5', candles15m, candles4h });
    }
  }
  return out;
}

function ema50Bias(candles4h) {
  const xs = [...(candles4h || [])].sort((a, b) => a.openTime - b.openTime);
  if (xs.length < 51) return { bias: 'FLAT', ema50: null };
  const alpha = 2 / 51;
  let ema = Number(xs[0].close);
  let prev = ema;
  for (let i = 1; i < xs.length; i += 1) {
    prev = ema;
    ema = alpha * Number(xs[i].close) + (1 - alpha) * ema;
  }
  const close = Number(xs[xs.length - 1].close);
  const slope = ema - prev;
  if (close > ema && slope > 0) return { bias: 'BULLISH', ema50: ema, slope, close };
  if (close < ema && slope < 0) return { bias: 'BEARISH', ema50: ema, slope, close };
  return { bias: 'FLAT', ema50: ema, slope, close };
}

function dailyVwap(candles15m, targetOpenTime) {
  const day = utcDate(targetOpenTime);
  let pv = 0, volume = 0;
  for (const c of candles15m || []) {
    if (c.openTime > targetOpenTime || utcDate(c.openTime) !== day) continue;
    const v = Number(c.volume);
    if (!(v > 0)) continue;
    const typical = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    pv += typical * v;
    volume += v;
  }
  return volume > 0 ? pv / volume : null;
}

function sessionBox(candles15m, latestOpenTime, session) {
  const local = localParts(latestOpenTime, session.tz);
  let h2 = session.hour;
  let m2 = session.minute + 15;
  if (m2 >= 60) { m2 -= 60; h2 += 1; }

  let first = null, second = null;
  for (const c of candles15m || []) {
    const p = localParts(c.openTime, session.tz);
    if (p.date !== local.date) continue;
    if (p.hour === session.hour && p.minute === session.minute) first = c;
    if (p.hour === h2 && p.minute === m2) second = c;
  }
  if (!first || !second) return null;
  return {
    date: local.date,
    high: Math.max(first.high, second.high),
    low: Math.min(first.low, second.low),
    activeFrom: second.openTime + M15_MS,
    activeUntil: second.openTime + 6 * HOUR_MS
  };
}

function evaluate(snapshotData, sessionId, now = Date.now()) {
  const session = SESSION_DEFS[sessionId];
  if (!session) return null;
  const c15 = [...(snapshotData.candles15m || [])].sort((a, b) => a.openTime - b.openTime);
  const latest = c15[c15.length - 1];
  if (!latest) return null;

  const expectedClose = latest.openTime + M15_MS;
  const age = now - expectedClose;
  if (age < -60000 || age > MAX_SIGNAL_AGE_MS) return null;

  const box = sessionBox(c15, latest.openTime, session);
  if (!box || latest.openTime < box.activeFrom || latest.openTime >= box.activeUntil) return null;

  const vwap = dailyVwap(c15, latest.openTime);
  const trend = ema50Bias(snapshotData.candles4h);
  if (!Number.isFinite(vwap)) return null;

  const close = Number(latest.close);
  let side = null;
  if (close > box.high && close > vwap && trend.bias === 'BULLISH') side = 'LONG';
  if (close < box.low && close < vwap && trend.bias === 'BEARISH') side = 'SHORT';
  if (!side) return null;

  const entry = close;
  const stop = side === 'LONG' ? box.low : box.high;
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;
  const target = side === 'LONG' ? entry + TP_R * riskDistance : entry - TP_R * riskDistance;
  const riskUsd = EQUITY > 0 && RISK_PCT > 0 ? EQUITY * RISK_PCT : null;
  const quantity = Number.isFinite(riskUsd) ? riskUsd / riskDistance : null;

  return {
    key: `${snapshotData.symbol}|${session.id}|${box.date}`,
    symbol: snapshotData.symbol,
    provider: snapshotData.provider,
    session: session.id,
    sessionLabel: session.label,
    side,
    candleOpenTime: latest.openTime,
    candleCloseTime: expectedClose,
    close,
    boxHigh: box.high,
    boxLow: box.low,
    vwap,
    trend: trend.bias,
    ema50: trend.ema50,
    entry,
    stop,
    target,
    riskUsd,
    quantity
  };
}

function buildMessage(s) {
  const icon = s.side === 'LONG' ? '🟢' : '🔴';
  return [
    `${icon} SESSION BREAKOUT SIGNAL`,
    '',
    `${s.symbol} — ${s.side}`,
    `Session: ${s.sessionLabel}`,
    `M15 close: ${fmtPrice(s.close)}`,
    `Box: ${fmtPrice(s.boxLow)} - ${fmtPrice(s.boxHigh)}`,
    `H4 trend: ${s.trend}`,
    `VWAP: ${fmtPrice(s.vwap)}`,
    '',
    `🎯 Entry: ~${fmtPrice(s.entry)}`,
    `🛑 SL: ${fmtPrice(s.stop)}`,
    `✅ TP: ${fmtPrice(s.target)} (${TP_R.toFixed(1)}R)`,
    Number.isFinite(s.riskUsd) ? `Risk: ${(RISK_PCT * 100).toFixed(1)}% (~$${s.riskUsd.toFixed(2)})` : null,
    '',
    `Confirmed M15 close: ${sgtTime(s.candleCloseTime)} SGT`,
    `Data: ${s.provider}`,
    ['BTCUSDT','ETHUSDT','SOLUSDT'].includes(s.symbol) ? 'Backtest: 2Y tested' : 'Backtest: not yet validated',
    'Mode: SIGNAL ONLY'
  ].filter(Boolean).join('\n');
}

async function telegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed.sent === 'object' ? parsed : { sent: {} };
  } catch {
    return { sent: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const cutoff = Date.now() - 10 * 24 * HOUR_MS;
  for (const [k, v] of Object.entries(state.sent || {})) {
    if (!v || Number(v.atMs || 0) < cutoff) delete state.sent[k];
  }
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

let health = { ok: true, lastCycleAt: null, lastError: null, lastCandidates: 0 };

async function cycle() {
  const now = Date.now();
  const state = loadState();
  const cryptoResults = await Promise.allSettled(SYMBOLS.map(s => snapshot(s, now)));
  const snaps = [];
  for (let i = 0; i < cryptoResults.length; i += 1) {
    const r = cryptoResults[i];
    if (r.status === 'fulfilled') snaps.push(r.value);
    else console.error(JSON.stringify({ symbol: SYMBOLS[i], marketData: 'ERROR', error: String(r.reason?.message || r.reason) }));
  }
  try {
    snaps.push(...await mt5Snapshots());
  } catch (error) {
    console.error(JSON.stringify({ provider: 'MT5', marketData: 'ERROR', error: error.message }));
  }

  const signals = [];

  for (const snap of snaps) {
    for (const sessionId of SESSION_IDS) {
      const signal = evaluate(snap, sessionId, now);
      if (signal && !state.sent[signal.key]) signals.push(signal);
    }
  }

  for (const s of signals) {
    try {
      await telegram(buildMessage(s));
      state.sent[s.key] = { at: new Date().toISOString(), atMs: Date.now(), side: s.side, candleOpenTime: s.candleOpenTime };
      saveState(state);
      console.log(JSON.stringify({ telegram: 'SENT', key: s.key, symbol: s.symbol, session: s.session, side: s.side }));
    } catch (error) {
      console.error(JSON.stringify({ telegram: 'ERROR', key: s.key, error: error.message }));
    }
  }

  health = { ok: true, lastCycleAt: new Date(now).toISOString(), lastError: null, lastCandidates: signals.length };
  console.log(JSON.stringify({
    engine: 'Session Breakout Monitor V1',
    mode: 'SIGNAL_ONLY',
    at: health.lastCycleAt,
    symbols: SYMBOLS,
    mt5Symbols: MT5_SYMBOLS,
    mt5FeedConfigured: Boolean(MT5_FEED_URL),
    sessions: SESSION_IDS,
    providers: Object.fromEntries(snaps.map(s => [s.symbol, s.provider])),
    candidates: signals.map(s => ({ symbol: s.symbol, session: s.session, side: s.side, close: s.close, vwap: s.vwap, trend: s.trend }))
  }));

  saveState(state);
}

function nextDelay() {
  const now = Date.now();
  const nextQuarter = (Math.floor(now / M15_MS) + 1) * M15_MS;
  return Math.max(5000, nextQuarter + 12000 - now);
}

function schedule() {
  const wait = nextDelay();
  setTimeout(async () => {
    try {
      await cycle();
    } catch (error) {
      health.ok = false;
      health.lastError = error.message;
      console.error(JSON.stringify({ cycle: 'ERROR', error: error.message }));
    }
    schedule();
  }, wait);
}

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...health, engine: 'Session Breakout Monitor V1', mode: 'SIGNAL_ONLY' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Session Breakout Monitor V1\n');
  }).listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ http: 'LISTENING', port: PORT }));
  });
}

async function main() {
  if (!RUN_ONCE) startHealthServer();
  console.log(JSON.stringify({ engine: 'Session Breakout Monitor V1', status: 'STARTING', runOnce: RUN_ONCE, symbols: SYMBOLS, mt5Symbols: MT5_SYMBOLS, mt5FeedConfigured: Boolean(MT5_FEED_URL), sessions: SESSION_IDS, tpR: TP_R }));

  if (STARTUP_NOTICE) {
    try {
      await telegram([
        '✅ Session Breakout Monitor ONLINE',
        '',
        `Symbols: ${SYMBOLS.join(', ')}`,
        `Sessions: ${SESSION_IDS.join(', ')}`,
        'Rule: first 2×M15 box → M15 close breakout → VWAP + H4 EMA50 confirmation',
        `TP: ${TP_R.toFixed(1)}R`,
        'Mode: SIGNAL ONLY'
      ].join('\n'));
    } catch (error) {
      console.error(JSON.stringify({ startupTelegram: 'ERROR', error: error.message }));
    }
  }

  try { await cycle(); }
  catch (error) {
    health.ok = false;
    health.lastError = error.message;
    console.error(JSON.stringify({ cycle: 'ERROR', error: error.message }));
    if (RUN_ONCE) throw error;
  }

  if (RUN_ONCE) return;
  schedule();
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ fatal: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { localParts, ema50Bias, dailyVwap, sessionBox, evaluate, mapBinanceKlines };
