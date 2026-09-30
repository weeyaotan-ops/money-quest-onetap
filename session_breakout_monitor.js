'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BINANCE_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com';
const OKX_BASE = process.env.OKX_REST_BASE || process.env.OKX_API_BASE || 'https://www.okx.com';
const { getHistoricalRates } = require('dukascopy-node');

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
const FX_SYMBOLS = (process.env.FX_SYMBOLS || 'XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCHF,USDCAD,NZDUSD')
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

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'money-quest-session-breakout/1.0', ...extraHeaders } });
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

async function dukascopyCandles(symbol, timeframe, lookbackDays, now = Date.now()) {
  const intervalMs = timeframe === 'h4' ? 4 * HOUR_MS : timeframe === 'h1' ? HOUR_MS : M15_MS;
  const rows = await getHistoricalRates({
    instrument: String(symbol).toLowerCase(),
    dates: {
      from: new Date(now - lookbackDays * 24 * HOUR_MS),
      to: new Date(now + HOUR_MS)
    },
    timeframe,
    format: 'json',
    priceType: 'bid',
    ignoreFlats: true
  });
  return (rows || []).map(x => ({
    openTime: Number(x.timestamp),
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume || 0),
    closeTime: Number(x.timestamp) + intervalMs - 1
  })).filter(x =>
    Number.isFinite(x.openTime) &&
    [x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite) &&
    x.openTime + intervalMs <= now
  ).sort((a,b) => a.openTime - b.openTime);
}

function aggregateH4FromH1(rows) {
  const groups = new Map();
  for (const x of rows || []) {
    const t = Math.floor(Number(x.openTime) / (4 * HOUR_MS)) * (4 * HOUR_MS);
    if (!groups.has(t)) {
      groups.set(t, { openTime: t, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, closeTime: t + 4 * HOUR_MS - 1 });
    } else {
      const g = groups.get(t);
      g.high = Math.max(g.high, x.high);
      g.low = Math.min(g.low, x.low);
      g.close = x.close;
      g.volume += x.volume;
    }
  }
  return [...groups.values()].sort((a,b) => a.openTime - b.openTime);
}

async function publicFxSnapshot(symbol, now = Date.now()) {
  const [candles15m, candles1h] = await Promise.all([
    dukascopyCandles(symbol, 'm15', 5, now),
    dukascopyCandles(symbol, 'h1', 14, now)
  ]);
  const candles4h = aggregateH4FromH1(candles1h);
  if (candles15m.length < 20 || candles4h.length < 51) {
    throw new Error(`DUKASCOPY_INSUFFICIENT_DATA ${symbol} m15=${candles15m.length} h4=${candles4h.length}`);
  }
  return { symbol, provider: 'DUKASCOPY', candles15m, candles4h };
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
  if (close > ema) return { bias: 'BULLISH', ema50: ema, slope, close };
  if (close < ema) return { bias: 'BEARISH', ema50: ema, slope, close };
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

function resolveSession(snapshotData, sessionId) {
  const base = SESSION_DEFS[sessionId];
  if (!base) return null;
  if (sessionId !== 'NEW_YORK') return base;
  if (snapshotData.provider === 'DUKASCOPY') {
    if (snapshotData.symbol === 'XAUUSD') {
      return { ...base, id: 'NEW_YORK_GOLD', label: 'New York Gold', hour: 8, minute: 30 };
    }
    return { ...base, id: 'NEW_YORK_FX', label: 'New York FX', hour: 8, minute: 0 };
  }
  return { ...base, id: 'NEW_YORK_CRYPTO', label: 'New York', hour: 9, minute: 30 };
}

function evaluate(snapshotData, sessionId, now = Date.now()) {
  const session = resolveSession(snapshotData, sessionId);
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

function evaluateWatch(snapshotData, sessionId, now = Date.now()) {
  const session = resolveSession(snapshotData, sessionId);
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
  const close = Number(latest.close);
  const width = Number(box.high) - Number(box.low);
  if (!Number.isFinite(vwap) || !(width > 0)) return null;

  let side = null, trigger = null, invalidation = null, distance = null;
  if (trend.bias === 'BULLISH' && close > vwap && close <= box.high) {
    side = 'LONG'; trigger = box.high; invalidation = box.low; distance = box.high - close;
  } else if (trend.bias === 'BEARISH' && close < vwap && close >= box.low) {
    side = 'SHORT'; trigger = box.low; invalidation = box.high; distance = close - box.low;
  } else {
    return null;
  }

  const boxFraction = Math.max(0, distance / width);
  if (boxFraction > 0.20) return null;

  return {
    key: `WATCH|${snapshotData.symbol}|${session.id}|${box.date}|${side}`,
    symbol: snapshotData.symbol,
    provider: snapshotData.provider,
    session: session.id,
    sessionLabel: session.label,
    side,
    current: close,
    trigger,
    invalidation,
    boxHigh: box.high,
    boxLow: box.low,
    vwap,
    trend: trend.bias,
    distancePct: close > 0 ? distance / close * 100 : null,
    candleCloseTime: expectedClose
  };
}


function rawBreakoutEvent(snapshotData, sessionId, now = Date.now()) {
  const session = resolveSession(snapshotData, sessionId);
  if (!session) return null;
  const c15 = [...(snapshotData.candles15m || [])].sort((a, b) => a.openTime - b.openTime);
  const latest = c15[c15.length - 1];
  const previous = c15[c15.length - 2];
  if (!latest || !previous) return null;

  const expectedClose = latest.openTime + M15_MS;
  const age = now - expectedClose;
  if (age < -60000 || age > MAX_SIGNAL_AGE_MS) return null;

  const box = sessionBox(c15, latest.openTime, session);
  if (!box || latest.openTime < box.activeFrom || latest.openTime >= box.activeUntil) return null;

  const close = Number(latest.close);
  const prevClose = Number(previous.close);
  let side = null;
  if (close > box.high && prevClose <= box.high) side = 'LONG';
  if (close < box.low && prevClose >= box.low) side = 'SHORT';
  if (!side) return null;

  const vwap = dailyVwap(c15, latest.openTime);
  const trend = ema50Bias(snapshotData.candles4h);
  if (!Number.isFinite(vwap) || !Number.isFinite(trend.ema50)) return null;

  const vwapPass = side === 'LONG' ? close > vwap : close < vwap;
  const h4Pass = side === 'LONG' ? trend.bias === 'BULLISH' : trend.bias === 'BEARISH';
  const entry = close;
  const stop = side === 'LONG' ? box.low : box.high;
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;

  return {
    key: `SHADOW|${snapshotData.symbol}|${session.id}|${box.date}|${latest.openTime}|${side}`,
    symbol: snapshotData.symbol,
    provider: snapshotData.provider,
    session: session.id,
    sessionLabel: session.label,
    side,
    candleOpenTime: latest.openTime,
    candleCloseTime: expectedClose,
    entry,
    stop,
    boxHigh: box.high,
    boxLow: box.low,
    vwap,
    h4Bias: trend.bias,
    h4Ema50: trend.ema50,
    emaSlope: trend.slope,
    vwapPass,
    h4Pass,
    liveQualified: vwapPass && h4Pass,
    blockedBy: [
      ...(vwapPass ? [] : ['VWAP']),
      ...(h4Pass ? [] : ['H4_EMA50'])
    ]
  };
}

function shadowTradeFromBreakout(event) {
  const t = tradeFromSignal(event);
  t.shadow = true;
  t.filters = {
    vwapPass: Boolean(event.vwapPass),
    h4Pass: Boolean(event.h4Pass),
    liveQualified: Boolean(event.liveQualified)
  };
  t.blockedBy = [...(event.blockedBy || [])];
  t.context = {
    boxHigh: Number(event.boxHigh),
    boxLow: Number(event.boxLow),
    vwap: Number(event.vwap),
    h4Bias: event.h4Bias,
    h4Ema50: Number(event.h4Ema50),
    emaSlope: Number(event.emaSlope)
  };
  return t;
}

function captureShadowBreakouts(state, snaps, now = Date.now()) {
  state = normalizeState(state);
  let added = 0;
  for (const snap of snaps || []) {
    for (const sessionId of SESSION_IDS) {
      const event = rawBreakoutEvent(snap, sessionId, now);
      if (!event || state.shadow[event.key]) continue;
      state.shadow[event.key] = shadowTradeFromBreakout(event);
      added += 1;
    }
  }
  return added;
}

function trackShadowTrades(state, snaps) {
  state = normalizeState(state);
  const bySymbol = Object.fromEntries((snaps || []).map(s => [s.symbol, s]));
  let changed = false;
  for (const trade of Object.values(state.shadow || {})) {
    const snap = bySymbol[trade.symbol];
    if (!snap) continue;
    if (updateTradeFromCandles(trade, snap.candles15m || [])) changed = true;
  }
  return changed;
}

function pruneShadow(state) {
  const cutoff = Date.now() - 365 * 24 * HOUR_MS;
  const entries = Object.entries(state.shadow || {})
    .sort((a,b) => Number(b[1]?.signalAtMs || 0) - Number(a[1]?.signalAtMs || 0));
  const keep = new Set(entries
    .filter(([,t], idx) => idx < 10000 && Number(t?.signalAtMs || 0) >= cutoff)
    .map(([k]) => k));
  for (const key of Object.keys(state.shadow || {})) if (!keep.has(key)) delete state.shadow[key];
}

function summarizeShadowTrades(trades) {
  const xs = trades || [];
  return {
    n: xs.length,
    tp1: xs.filter(t => t.milestones?.tp1?.hit).length,
    tp2: xs.filter(t => t.milestones?.tp2?.hit).length,
    sl: xs.filter(t => t.milestones?.sl?.hit).length,
    open: xs.filter(t => !t.terminal).length,
    ambiguous: xs.filter(t => String(t.status || '').includes('SAME_M15')).length
  };
}

function shadowSummary(state) {
  state = normalizeState(state);
  const all = Object.values(state.shadow || {});
  return {
    raw: summarizeShadowTrades(all),
    vwapOnly: summarizeShadowTrades(all.filter(t => t.filters?.vwapPass)),
    h4Only: summarizeShadowTrades(all.filter(t => t.filters?.h4Pass)),
    both: summarizeShadowTrades(all.filter(t => t.filters?.liveQualified)),
    blocked: summarizeShadowTrades(all.filter(t => !t.filters?.liveQualified))
  };
}

function buildWatchMessage(w) {
  const arrow = w.side === 'LONG' ? 'ABOVE' : 'BELOW';
  return [
    '👀 KEY PRICE ALERT',
    '',
    `${w.symbol} — ${w.side} BIAS`,
    `Session: ${w.sessionLabel}`,
    '',
    `🔥 WATCH: ${fmtPrice(w.trigger)}`,
    `Now: ${fmtPrice(w.current)}`,
    Number.isFinite(w.distancePct) ? `Distance: ${w.distancePct.toFixed(2)}%` : null,
    '',
    `WAIT for M15 CLOSE ${arrow} ${fmtPrice(w.trigger)}`,
    `If confirmed, opposite box side: ${fmtPrice(w.invalidation)}`,
    '',
    'NOT AN ENTRY YET',
    `Data: ${w.provider}`
  ].filter(Boolean).join('\n');
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
    `✅ TP1: ${fmtPrice(s.side === 'LONG' ? s.entry + Math.abs(s.entry - s.stop) : s.entry - Math.abs(s.entry - s.stop))} (1.0R)`,
    `✅ TP2: ${fmtPrice(s.side === 'LONG' ? s.entry + 2 * Math.abs(s.entry - s.stop) : s.entry - 2 * Math.abs(s.entry - s.stop))} (2.0R)`,
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

function normalizeState(parsed) {
  const state = parsed && typeof parsed === 'object' ? parsed : {};
  if (!state.sent || typeof state.sent !== 'object') state.sent = {};
  if (!state.trades || typeof state.trades !== 'object') state.trades = {};
  if (!state.shadow || typeof state.shadow !== 'object') state.shadow = {};
  return state;
}

function tradeFromSignal(s) {
  const riskDistance = Math.abs(Number(s.entry) - Number(s.stop));
  const tp1 = s.side === 'LONG' ? Number(s.entry) + riskDistance : Number(s.entry) - riskDistance;
  const tp2 = s.side === 'LONG' ? Number(s.entry) + 2 * riskDistance : Number(s.entry) - 2 * riskDistance;
  return {
    key: s.key,
    symbol: s.symbol,
    provider: s.provider,
    session: s.session,
    sessionLabel: s.sessionLabel,
    side: s.side,
    signalAt: new Date(s.candleCloseTime).toISOString(),
    signalAtMs: Number(s.candleCloseTime),
    candleOpenTime: Number(s.candleOpenTime),
    entry: Number(s.entry),
    stop: Number(s.stop),
    tp1,
    tp2,
    riskDistance,
    status: 'OPEN',
    terminal: false,
    lastTrackedOpenTime: Number(s.candleOpenTime),
    milestones: {
      tp1: { hit: false, at: null, candleOpenTime: null, sameBar: false },
      tp2: { hit: false, at: null, candleOpenTime: null, sameBar: false },
      sl:  { hit: false, at: null, candleOpenTime: null, sameBar: false }
    }
  };
}

function reconstructTradeFromSent(key, meta, snap) {
  if (!meta || meta.watch || !Number.isFinite(Number(meta.candleOpenTime))) return null;
  const parts = String(key).split('|');
  const symbol = parts[0];
  const sessionKey = parts[1] || '';
  if (!snap || snap.symbol !== symbol) return null;
  const baseSessionId = sessionKey.startsWith('NEW_YORK') ? 'NEW_YORK' : sessionKey === 'LONDON' ? 'LONDON' : null;
  if (!baseSessionId) return null;
  const session = resolveSession(snap, baseSessionId);
  if (!session) return null;
  const candleOpenTime = Number(meta.candleOpenTime);
  const candle = (snap.candles15m || []).find(x => Number(x.openTime) === candleOpenTime);
  if (!candle) return null;
  const box = sessionBox(snap.candles15m || [], candleOpenTime, session);
  if (!box) return null;
  const entry = Number(candle.close);
  const stop = String(meta.side).toUpperCase() === 'LONG' ? Number(box.low) : Number(box.high);
  if (![entry, stop].every(Number.isFinite) || entry === stop) return null;
  return tradeFromSignal({
    key,
    symbol,
    provider: snap.provider,
    session: session.id,
    sessionLabel: session.label,
    side: String(meta.side).toUpperCase(),
    candleOpenTime,
    candleCloseTime: candleOpenTime + M15_MS,
    entry,
    stop
  });
}

function milestoneHit(trade, candle, kind) {
  const side = trade.side;
  const high = Number(candle.high), low = Number(candle.low);
  if (kind === 'sl') return side === 'LONG' ? low <= trade.stop : high >= trade.stop;
  if (kind === 'tp1') return side === 'LONG' ? high >= trade.tp1 : low <= trade.tp1;
  if (kind === 'tp2') return side === 'LONG' ? high >= trade.tp2 : low <= trade.tp2;
  return false;
}

function updateTradeFromCandles(trade, candles) {
  if (!trade || trade.terminal) return false;
  let changed = false;
  const start = Number(trade.candleOpenTime) + M15_MS;
  const sorted = [...(candles || [])].sort((a,b) => a.openTime - b.openTime);

  for (const candle of sorted) {
    if (trade.terminal) break;
    if (Number(candle.openTime) < start) continue;
    if (Number(candle.openTime) <= Number(trade.lastTrackedOpenTime || 0)) continue;

    const hits = {
      tp1: !trade.milestones.tp1.hit && milestoneHit(trade, candle, 'tp1'),
      tp2: !trade.milestones.tp2.hit && milestoneHit(trade, candle, 'tp2'),
      sl: !trade.milestones.sl.hit && milestoneHit(trade, candle, 'sl')
    };

    // A 2R touch necessarily crosses 1R inside the same bar unless there is a gap.
    if (hits.tp2 && !trade.milestones.tp1.hit) hits.tp1 = true;

    const newKinds = Object.entries(hits).filter(([,v]) => v).map(([k]) => k);
    const sameBar = newKinds.length > 1;
    const at = new Date(Number(candle.openTime) + M15_MS).toISOString();

    for (const kind of newKinds) {
      trade.milestones[kind] = {
        hit: true,
        at,
        candleOpenTime: Number(candle.openTime),
        sameBar
      };
      changed = true;
    }

    if (hits.sl && hits.tp2) {
      trade.status = 'TP2_AND_SL_SAME_M15';
      trade.terminal = true;
    } else if (hits.sl && hits.tp1) {
      trade.status = 'TP1_AND_SL_SAME_M15';
      trade.terminal = true;
    } else if (hits.sl) {
      trade.status = trade.milestones.tp1.hit ? 'TP1_THEN_SL' : 'SL';
      trade.terminal = true;
    } else if (hits.tp2) {
      trade.status = 'TP2';
      trade.terminal = true;
    } else if (hits.tp1) {
      trade.status = 'TP1';
    }

    trade.lastTrackedOpenTime = Number(candle.openTime);
  }
  return changed;
}

function trackTrades(state, snaps) {
  state = normalizeState(state);
  const bySymbol = Object.fromEntries((snaps || []).map(s => [s.symbol, s]));
  let changed = false;

  // Migrate signals sent before result tracking was added.
  for (const [key, meta] of Object.entries(state.sent || {})) {
    if (meta?.watch || state.trades[key]) continue;
    const symbol = String(key).split('|')[0];
    const trade = reconstructTradeFromSent(key, meta, bySymbol[symbol]);
    if (trade) {
      state.trades[key] = trade;
      changed = true;
    }
  }

  for (const trade of Object.values(state.trades || {})) {
    const snap = bySymbol[trade.symbol];
    if (!snap) continue;
    if (updateTradeFromCandles(trade, snap.candles15m || [])) changed = true;
  }
  return changed;
}

function pruneTrades(state) {
  const cutoff = Date.now() - 180 * 24 * HOUR_MS;
  const entries = Object.entries(state.trades || {}).sort((a,b) => Number(b[1]?.signalAtMs || 0) - Number(a[1]?.signalAtMs || 0));
  const keep = new Set(entries.filter(([,t], idx) => idx < 1000 && Number(t?.signalAtMs || 0) >= cutoff).map(([k]) => k));
  for (const key of Object.keys(state.trades || {})) if (!keep.has(key)) delete state.trades[key];
}

function resultSummary(state) {
  const trades = Object.values(state.trades || {});
  return {
    signals: trades.length,
    tp1: trades.filter(t => t.milestones?.tp1?.hit).length,
    tp2: trades.filter(t => t.milestones?.tp2?.hit).length,
    sl: trades.filter(t => t.milestones?.sl?.hit).length,
    open: trades.filter(t => !t.terminal).length,
    ambiguousSameM15: trades.filter(t => String(t.status || '').includes('SAME_M15')).length
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch {
    return normalizeState({});
  }
}

function saveState(state) {
  state = normalizeState(state);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const cutoff = Date.now() - 10 * 24 * HOUR_MS;
  for (const [k, v] of Object.entries(state.sent || {})) {
    if (!v || Number(v.atMs || 0) < cutoff) delete state.sent[k];
  }
  pruneTrades(state);
  pruneShadow(state);
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
  const fxResults = await Promise.allSettled(FX_SYMBOLS.map(s => publicFxSnapshot(s, now)));
  for (let i = 0; i < fxResults.length; i += 1) {
    const r = fxResults[i];
    if (r.status === 'fulfilled') snaps.push(r.value);
    else console.error(JSON.stringify({ symbol: FX_SYMBOLS[i], provider: 'DUKASCOPY', marketData: 'ERROR', error: String(r.reason?.message || r.reason) }));
  }

  const outcomeChanged = trackTrades(state, snaps);
  const shadowAdded = captureShadowBreakouts(state, snaps, now);
  const shadowChanged = trackShadowTrades(state, snaps);
  if (outcomeChanged || shadowAdded || shadowChanged) saveState(state);

  const signals = [];
  const watches = [];

  for (const snap of snaps) {
    for (const sessionId of SESSION_IDS) {
      const signal = evaluate(snap, sessionId, now);
      if (signal && !state.sent[signal.key]) {
        signals.push(signal);
        continue;
      }
      if (!signal) {
        const watch = evaluateWatch(snap, sessionId, now);
        if (watch && !state.sent[watch.key]) watches.push(watch);
      }
    }
  }

  for (const w of watches) {
    try {
      await telegram(buildWatchMessage(w));
      state.sent[w.key] = { at: new Date().toISOString(), atMs: Date.now(), side: w.side, watch: true };
      saveState(state);
      console.log(JSON.stringify({ telegram: 'WATCH_SENT', key: w.key, symbol: w.symbol, session: w.session, side: w.side, trigger: w.trigger }));
    } catch (error) {
      console.error(JSON.stringify({ telegram: 'WATCH_ERROR', key: w.key, error: error.message }));
    }
  }

  for (const s of signals) {
    try {
      await telegram(buildMessage(s));
      state.sent[s.key] = { at: new Date().toISOString(), atMs: Date.now(), side: s.side, candleOpenTime: s.candleOpenTime };
      state.trades[s.key] = tradeFromSignal(s);
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
    fxSymbols: FX_SYMBOLS,
    publicFxFeed: 'DUKASCOPY',
    sessions: SESSION_IDS,
    providers: Object.fromEntries(snaps.map(s => [s.symbol, s.provider])),
    watches: watches.map(w => ({ symbol: w.symbol, session: w.session, side: w.side, current: w.current, trigger: w.trigger })),
    candidates: signals.map(s => ({ symbol: s.symbol, session: s.session, side: s.side, close: s.close, vwap: s.vwap, trend: s.trend })),
    results: resultSummary(state),
    shadowAdded,
    shadow: shadowSummary(state)
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
  console.log(JSON.stringify({ engine: 'Session Breakout Monitor V1', status: 'STARTING', runOnce: RUN_ONCE, symbols: SYMBOLS, fxSymbols: FX_SYMBOLS, publicFxFeed: 'DUKASCOPY', sessions: SESSION_IDS, tpR: TP_R }));

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

module.exports = { localParts, ema50Bias, dailyVwap, sessionBox, evaluate, evaluateWatch, rawBreakoutEvent, shadowTradeFromBreakout, captureShadowBreakouts, trackShadowTrades, shadowSummary, mapBinanceKlines, tradeFromSignal, updateTradeFromCandles, resultSummary };
