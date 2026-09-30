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
const COMMAND_CENTER_ENABLED = !['0','false','no'].includes(String(process.env.TELEGRAM_COMMAND_CENTER_ENABLED || 'true').toLowerCase());
const FETCH_TIMEOUT_MS = Number(process.env.HUNTER_FETCH_TIMEOUT_MS || 12000);
const FETCH_RETRIES = Math.max(0, Math.min(3, Number(process.env.HUNTER_FETCH_RETRIES || 2)));
const SHADOW_MIN_RESOLVED = Math.max(10, Number(process.env.SHADOW_MIN_RESOLVED || 30));
const SHADOW_COST_R = Math.max(0, Number(process.env.SHADOW_COST_R || 0));
const CORE_SYMBOLS = new Set(['BTCUSDT','ETHUSDT','SOLUSDT']);
const STRATEGY_VERSION = 'SESSION_BREAKOUT_V1_LOCKED_2026-09-30';
const SIGNAL_VALID_MS = Number(process.env.BREAKOUT_SIGNAL_VALID_MS || 15 * 60 * 1000);
const DAILY_SUMMARY_ENABLED = !['0','false','no'].includes(String(process.env.DAILY_SUMMARY_ENABLED || 'true').toLowerCase());
const DAILY_SUMMARY_HOUR_SGT = Math.max(0, Math.min(23, Number(process.env.DAILY_SUMMARY_HOUR_SGT || 7)));
const TP_SL_VARIANTS = [
  { id: 'TP1', label: '原SL + 1R', stopFactor: 1, targetRR: 1 },
  { id: 'TP1_5', label: '原SL + 1.5R', stopFactor: 1, targetRR: 1.5 },
  { id: 'LIVE_2R', label: '原SL + 2R（Live）', stopFactor: 1, targetRR: 2 },
  { id: 'TIGHT75_2R', label: 'SL收紧25% + 2R', stopFactor: 0.75, targetRR: 2 },
  { id: 'TIGHT50_2R', label: 'SL收紧50% + 2R', stopFactor: 0.5, targetRR: 2 }
];

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

function sgtParts(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    hour: Number(o.hour),
    minute: Number(o.minute)
  };
}

function sgtDate(ts = Date.now()) {
  return sgtParts(ts).date;
}

function utcDate(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(url, extraHeaders = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'money-quest-session-breakout/1.0', ...extraHeaders },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!retryable) throw new Error(`HTTP ${res.status} ${url}`);
        throw new Error(`RETRYABLE_HTTP_${res.status} ${url}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt >= FETCH_RETRIES) break;
      await sleep(250 * (2 ** attempt));
    }
  }
  throw lastError || new Error(`FETCH_FAILED ${url}`);
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

function snapshotHealth(snapshotData, now = Date.now()) {
  const c15 = [...(snapshotData?.candles15m || [])].sort((a,b) => Number(a.openTime) - Number(b.openTime));
  const c4h = [...(snapshotData?.candles4h || [])].sort((a,b) => Number(a.openTime) - Number(b.openTime));
  const latest = c15.at(-1);
  const issues = [];
  if (!latest) issues.push('NO_M15');
  if (c4h.length < 51) issues.push('H4_HISTORY_SHORT');

  let lagMs = null;
  if (latest) {
    lagMs = now - (Number(latest.openTime) + M15_MS);
    if (lagMs > MAX_SIGNAL_AGE_MS) issues.push('M15_STALE');
    if (lagMs < -60_000) issues.push('M15_FUTURE');
    const o=Number(latest.open), h=Number(latest.high), l=Number(latest.low), cl=Number(latest.close);
    if (![o,h,l,cl].every(Number.isFinite)) issues.push('M15_INVALID_OHLC');
    if (Number.isFinite(h) && Number.isFinite(l) && h < l) issues.push('M15_HIGH_LT_LOW');
    if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(o) && (o > h || o < l)) issues.push('M15_OPEN_OUTSIDE');
    if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(cl) && (cl > h || cl < l)) issues.push('M15_CLOSE_OUTSIDE');
  }

  let gapCount = 0;
  const recent = c15.slice(-24);
  for (let i=1;i<recent.length;i+=1) {
    const gap = Number(recent[i].openTime) - Number(recent[i-1].openTime);
    if (gap > M15_MS * 2.1) gapCount += 1;
  }
  if (gapCount > 0 && snapshotData?.provider !== 'DUKASCOPY') issues.push('M15_GAPS');

  const fatal = issues.some(x => ['NO_M15','H4_HISTORY_SHORT','M15_STALE','M15_FUTURE','M15_INVALID_OHLC','M15_HIGH_LT_LOW','M15_OPEN_OUTSIDE','M15_CLOSE_OUTSIDE'].includes(x));
  return {
    symbol: snapshotData?.symbol || 'UNKNOWN',
    provider: snapshotData?.provider || 'UNKNOWN',
    ok: !fatal,
    status: fatal ? 'ERROR' : issues.length ? 'WARN' : 'HEALTHY',
    lagMs,
    lagMinutes: Number.isFinite(lagMs) ? lagMs / 60000 : null,
    m15Bars: c15.length,
    h4Bars: c4h.length,
    gapCount,
    issues
  };
}

function atr14(candles15m, beforeOpenTime) {
  const xs = [...(candles15m || [])]
    .filter(x => Number(x.openTime) < Number(beforeOpenTime))
    .sort((a,b) => Number(a.openTime) - Number(b.openTime))
    .slice(-15);
  if (xs.length < 15) return null;
  const trs = [];
  for (let i = 1; i < xs.length; i += 1) {
    const cur = xs[i];
    const prev = xs[i-1];
    const h = Number(cur.high), l = Number(cur.low), pc = Number(prev.close);
    if (![h,l,pc].every(Number.isFinite)) continue;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  if (!trs.length) return null;
  return trs.reduce((a,b)=>a+b,0) / trs.length;
}

function structureAssessment(candles15m, latest, box, side, entry, stop) {
  const atr = atr14(candles15m, latest.openTime);
  const risk = Math.abs(Number(entry) - Number(stop));
  const boxWidth = Number(box.high) - Number(box.low);
  const trigger = side === 'LONG' ? Number(box.high) : Number(box.low);
  const extension = Math.abs(Number(entry) - trigger);
  if (!(atr > 0) || !(risk > 0) || !(boxWidth > 0)) {
    return { atr:null, riskAtr:null, boxAtr:null, extensionAtr:null, tp2Atr:null, warnings:[] };
  }
  const riskAtr = risk / atr;
  const boxAtr = boxWidth / atr;
  const extensionAtr = extension / atr;
  const tp2Atr = (2 * risk) / atr;
  const warnings = [];
  if (boxAtr >= 2.5) warnings.push('Box 很宽');
  if (boxAtr <= 0.30) warnings.push('Box 很窄');
  if (riskAtr >= 3.0) warnings.push('SL 距离很大');
  if (extensionAtr >= 1.0) warnings.push('突破后已经冲远');
  if (tp2Atr >= 5.0) warnings.push('2R 目标很远');
  return { atr, riskAtr, boxAtr, extensionAtr, tp2Atr, warnings };
}

function evaluate(snapshotData, sessionId, now = Date.now()) {
  const integrity = snapshotHealth(snapshotData, now);
  if (!integrity.ok) return null;
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

  const vwap = dailyVwap(c15, latest.openTime);
  const trend = ema50Bias(snapshotData.candles4h);
  if (!Number.isFinite(vwap)) return null;

  const close = Number(latest.close);
  const prevClose = Number(previous.close);
  let side = null;

  // Fresh signal only:
  // LONG = previous close was not already above Box High, current close breaks above.
  // SHORT = previous close was not already below Box Low, current close breaks below.
  if (prevClose <= box.high && close > box.high && close > vwap && trend.bias === 'BULLISH') side = 'LONG';
  if (prevClose >= box.low && close < box.low && close < vwap && trend.bias === 'BEARISH') side = 'SHORT';
  if (!side) return null;

  const entry = close;
  const stop = side === 'LONG' ? box.low : box.high;
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;
  const target = side === 'LONG' ? entry + TP_R * riskDistance : entry - TP_R * riskDistance;
  const riskUsd = EQUITY > 0 && RISK_PCT > 0 ? EQUITY * RISK_PCT : null;
  const quantity = Number.isFinite(riskUsd) ? riskUsd / riskDistance : null;
  const structure = structureAssessment(c15, latest, box, side, entry, stop);

  return {
    strategyVersion: STRATEGY_VERSION,
    key: `${snapshotData.symbol}|${session.id}|${box.date}`,
    symbol: snapshotData.symbol,
    provider: snapshotData.provider,
    session: session.id,
    sessionLabel: session.label,
    side,
    freshBreakout: true,
    previousClose: prevClose,
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
    quantity,
    structure
  };
}

function evaluateWatch(snapshotData, sessionId, now = Date.now()) {
  const integrity = snapshotHealth(snapshotData, now);
  if (!integrity.ok) return null;
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
  const structure = structureAssessment(c15, latest, box, side, entry, stop);

  return {
    strategyVersion: STRATEGY_VERSION,
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
    ],
    structure
  };
}

function shadowTradeFromBreakout(event) {
  const t = tradeFromSignal(event);
  t.shadow = true;
  t.strategyVersion = event.strategyVersion || STRATEGY_VERSION;
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
    emaSlope: Number(event.emaSlope),
    structure: event.structure || null
  };
  ensureTpSlVariants(t);
  return t;
}

function ensureTpSlVariants(trade) {
  if (!trade || !(Number(trade.riskDistance) > 0)) return {};
  if (!trade.challengers || typeof trade.challengers !== 'object') trade.challengers = {};
  for (const cfg of TP_SL_VARIANTS) {
    if (trade.challengers[cfg.id]) continue;
    const stopDistance = Number(trade.riskDistance) * cfg.stopFactor;
    const targetDistance = stopDistance * cfg.targetRR;
    const stop = trade.side === 'LONG' ? Number(trade.entry) - stopDistance : Number(trade.entry) + stopDistance;
    const target = trade.side === 'LONG' ? Number(trade.entry) + targetDistance : Number(trade.entry) - targetDistance;
    trade.challengers[cfg.id] = {
      id: cfg.id,
      label: cfg.label,
      stopFactor: cfg.stopFactor,
      targetRR: cfg.targetRR,
      stop,
      target,
      status: 'OPEN',
      terminal: false,
      outcomeR: null,
      lastTrackedOpenTime: Number(trade.candleOpenTime),
      resolvedAt: null,
      sameBar: false
    };
  }
  return trade.challengers;
}

function updateTpSlVariants(trade, candles) {
  if (!trade) return false;
  const variants = ensureTpSlVariants(trade);
  let changed = false;
  const start = Number(trade.candleOpenTime) + M15_MS;
  const sorted = [...(candles || [])].sort((a,b) => Number(a.openTime) - Number(b.openTime));

  for (const v of Object.values(variants)) {
    if (v.terminal) continue;
    for (const candle of sorted) {
      const ot = Number(candle.openTime);
      if (ot < start || ot <= Number(v.lastTrackedOpenTime || 0)) continue;
      const high = Number(candle.high), low = Number(candle.low);
      const stopHit = trade.side === 'LONG' ? low <= Number(v.stop) : high >= Number(v.stop);
      const targetHit = trade.side === 'LONG' ? high >= Number(v.target) : low <= Number(v.target);
      v.lastTrackedOpenTime = ot;

      if (stopHit && targetHit) {
        v.status = 'AMBIGUOUS';
        v.terminal = true;
        v.sameBar = true;
        v.outcomeR = null;
        v.resolvedAt = new Date(ot + M15_MS).toISOString();
        changed = true;
        break;
      }
      if (targetHit) {
        v.status = 'WIN';
        v.terminal = true;
        v.outcomeR = Number(v.targetRR);
        v.resolvedAt = new Date(ot + M15_MS).toISOString();
        changed = true;
        break;
      }
      if (stopHit) {
        v.status = 'LOSS';
        v.terminal = true;
        v.outcomeR = -1;
        v.resolvedAt = new Date(ot + M15_MS).toISOString();
        changed = true;
        break;
      }
    }
  }
  return changed;
}

function tpSlVariantStats(trades, variantId) {
  const rows = [];
  let ambiguous = 0;
  for (const t of trades || []) {
    const v = t?.challengers?.[variantId];
    if (!v) continue;
    if (v.status === 'AMBIGUOUS') ambiguous += 1;
    if (Number.isFinite(Number(v.outcomeR))) rows.push({ at:Number(t.signalAtMs||0), r:Number(v.outcomeR), v });
  }
  rows.sort((a,b)=>a.at-b.at);
  const wins = rows.filter(x=>x.r>0).length;
  const losses = rows.filter(x=>x.r<0).length;
  const totalR = rows.reduce((a,x)=>a+x.r,0);
  let equity=0, peak=0, maxDrawdownR=0;
  for (const x of rows) {
    equity += x.r;
    peak = Math.max(peak,equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak-equity);
  }
  return {
    resolved: rows.length,
    wins,
    losses,
    ambiguous,
    winRate: rows.length ? wins/rows.length : null,
    avgR: rows.length ? totalR/rows.length : null,
    totalR,
    maxDrawdownR
  };
}

function tpSlArenaSummary(state) {
  state = normalizeState(state);
  const all = Object.values(state.shadow || {}).filter(t => t?.filters?.liveQualified);
  const variants = TP_SL_VARIANTS.map(cfg => {
    const stats = tpSlVariantStats(all, cfg.id);
    return { ...cfg, ...stats };
  });
  const live = variants.find(x=>x.id==='LIVE_2R') || null;
  const eligible = variants
    .filter(x => x.resolved >= SHADOW_MIN_RESOLVED && Number.isFinite(x.avgR))
    .sort((a,b)=>b.avgR-a.avgR);
  const best = eligible[0] || null;
  let status = 'INSUFFICIENT';
  let deltaVsLive = null;
  if (live && best && live.resolved >= SHADOW_MIN_RESOLVED && Number.isFinite(live.avgR)) {
    deltaVsLive = Number(best.avgR) - Number(live.avgR);
    status = best.id === 'LIVE_2R' || deltaVsLive < 0.10 ? 'LIVE_STILL_BEST_OR_CLOSE' : 'CHALLENGER_AHEAD_SAMPLE';
  }
  return {
    mode:'SHADOW_ONLY',
    minResolved:SHADOW_MIN_RESOLVED,
    liveVariant:'LIVE_2R',
    variants,
    best: best ? { id:best.id, label:best.label, resolved:best.resolved, avgR:best.avgR, winRate:best.winRate, maxDrawdownR:best.maxDrawdownR } : null,
    status,
    deltaVsLive,
    note:'No live TP/SL change is made automatically.'
  };
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
    if (updateTpSlVariants(trade, snap.candles15m || [])) changed = true;
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

function shadowFinalR(trade) {
  if (!trade?.terminal || String(trade.status || '').includes('SAME_M15')) return null;
  if (trade.status === 'TP2') return 2;
  if (trade.status === 'SL' || trade.status === 'TP1_THEN_SL') return -1;
  return null;
}

function wilsonInterval(wins, n, z = 1.96) {
  if (!(n > 0)) return { low: null, high: null };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2*n)) / denom;
  const margin = z * Math.sqrt((p * (1-p) / n) + z2 / (4*n*n)) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function evidenceStatus(resolved, wins, interval, breakEvenWinRate) {
  if (resolved < SHADOW_MIN_RESOLVED) return 'INSUFFICIENT';
  if (Number.isFinite(interval.low) && interval.low > breakEvenWinRate) return 'SUPPORTED_SAMPLE';
  if (Number.isFinite(interval.high) && interval.high < breakEvenWinRate) return 'WEAK_SAMPLE';
  return 'INCONCLUSIVE';
}

function summarizeShadowTrades(trades) {
  const xs = trades || [];
  const resolvedRows = xs.map(t => ({ trade: t, r: shadowFinalR(t) })).filter(x => Number.isFinite(x.r));
  const wins = resolvedRows.filter(x => x.r > 0).length;
  const losses = resolvedRows.filter(x => x.r < 0).length;
  const resolved = resolvedRows.length;
  const totalRBeforeCosts = resolvedRows.reduce((sum,x) => sum + x.r, 0);
  const totalRAfterCosts = totalRBeforeCosts - resolved * SHADOW_COST_R;
  const avgRBeforeCosts = resolved ? totalRBeforeCosts / resolved : null;
  const avgRAfterCosts = resolved ? totalRAfterCosts / resolved : null;
  const winRate = resolved ? wins / resolved : null;
  const breakEvenWinRate = (1 + SHADOW_COST_R) / 3;
  const ci95 = wilsonInterval(wins, resolved);
  return {
    n: xs.length,
    resolved,
    wins,
    losses,
    winRate,
    winRateCi95: ci95,
    breakEvenWinRate,
    avgRBeforeCosts,
    avgRAfterCosts,
    totalRBeforeCosts,
    totalRAfterCosts,
    evidenceStatus: evidenceStatus(resolved, wins, ci95, breakEvenWinRate),
    tp1: xs.filter(t => t.milestones?.tp1?.hit).length,
    tp2: xs.filter(t => t.milestones?.tp2?.hit).length,
    sl: xs.filter(t => t.milestones?.sl?.hit).length,
    open: xs.filter(t => !t.terminal).length,
    ambiguous: xs.filter(t => String(t.status || '').includes('SAME_M15')).length
  };
}

function compareFilterEvidence(passStats, blockedStats) {
  if ((passStats?.resolved || 0) < SHADOW_MIN_RESOLVED || (blockedStats?.resolved || 0) < SHADOW_MIN_RESOLVED) {
    return { status: 'INSUFFICIENT', deltaAvgR: null };
  }
  const deltaAvgR = Number(passStats.avgRAfterCosts) - Number(blockedStats.avgRAfterCosts);
  const passLow = passStats.winRateCi95?.low;
  const passHigh = passStats.winRateCi95?.high;
  const blockLow = blockedStats.winRateCi95?.low;
  const blockHigh = blockedStats.winRateCi95?.high;
  let status = 'INCONCLUSIVE';
  if (Number.isFinite(passLow) && Number.isFinite(blockHigh) && passLow > blockHigh) status = 'FILTERS_HELPING_SAMPLE';
  if (Number.isFinite(passHigh) && Number.isFinite(blockLow) && passHigh < blockLow) status = 'FILTERS_HURTING_SAMPLE';
  return { status, deltaAvgR };
}

function shadowSummary(state) {
  state = normalizeState(state);
  const all = Object.values(state.shadow || {});

  function cohort(xs) {
    const raw = summarizeShadowTrades(xs);
    const both = summarizeShadowTrades(xs.filter(t => t.filters?.liveQualified));
    const blocked = summarizeShadowTrades(xs.filter(t => !t.filters?.liveQualified));
    return {
      raw,
      both,
      blocked,
      filterAssessment: compareFilterEvidence(both, blocked)
    };
  }

  function grouped(keyFn) {
    const groups = {};
    for (const trade of all) {
      const key = String(keyFn(trade) || 'UNKNOWN');
      if (!groups[key]) groups[key] = [];
      groups[key].push(trade);
    }
    return Object.fromEntries(
      Object.entries(groups)
        .sort((a,b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([key, xs]) => [key, cohort(xs)])
    );
  }

  const raw = summarizeShadowTrades(all);
  const vwapOnly = summarizeShadowTrades(all.filter(t => t.filters?.vwapPass));
  const h4Only = summarizeShadowTrades(all.filter(t => t.filters?.h4Pass));
  const both = summarizeShadowTrades(all.filter(t => t.filters?.liveQualified));
  const blocked = summarizeShadowTrades(all.filter(t => !t.filters?.liveQualified));

  return {
    strategyVersion: STRATEGY_VERSION,
    mode: 'OBSERVATIONAL_ONLY',
    outcomeModel: 'HOLD_TO_2R_OR_SL',
    costRPerTrade: SHADOW_COST_R,
    minResolvedForEvidence: SHADOW_MIN_RESOLVED,
    raw,
    vwapOnly,
    h4Only,
    both,
    blocked,
    filterAssessment: compareFilterEvidence(both, blocked),
    bySymbol: grouped(t => t.symbol),
    bySession: grouped(t => t.sessionLabel || t.session),
    bySide: grouped(t => t.side),
    bySymbolSession: grouped(t => `${t.symbol}|${t.sessionLabel || t.session}`),
    tpSlArena: tpSlArenaSummary(state)
  };
}

function buildWatchMessage(w) {
  const direction = w.side === 'LONG' ? '做多' : '做空';
  const condition = w.side === 'LONG' ? '收在上方' : '收在下方';
  return [
    '👀 接近触发',
    '',
    `${w.symbol} — ${direction}`,
    `时段：${w.sessionLabel}`,
    '',
    `关键价：${fmtPrice(w.trigger)}`,
    `现在：${fmtPrice(w.current)}`,
    Number.isFinite(w.distancePct) ? `距离：${w.distancePct.toFixed(2)}%` : null,
    '',
    `等 M15 ${condition} ${fmtPrice(w.trigger)} 才算确认`,
    `另一边 Box：${fmtPrice(w.invalidation)}`,
    '',
    '⚠️ 还没确认，不进场'
  ].filter(Boolean).join('\n');
}

function buildMessage(s) {
  const icon = s.side === 'LONG' ? '🟢' : '🔴';
  const direction = s.side === 'LONG' ? '做多' : '做空';
  const tp1 = s.side === 'LONG'
    ? s.entry + Math.abs(s.entry - s.stop)
    : s.entry - Math.abs(s.entry - s.stop);
  const tp2 = s.side === 'LONG'
    ? s.entry + 2 * Math.abs(s.entry - s.stop)
    : s.entry - 2 * Math.abs(s.entry - s.stop);

  return [
    `${icon} 刚确认信号`,
    '',
    `${s.symbol} — ${direction}`,
    `时段：${s.sessionLabel}`,
    `突破收盘：${fmtPrice(s.close)}`,
    '',
    '条件：突破 ✅  VWAP ✅  H4 ✅',
    '',
    `进场：约 ${fmtPrice(s.entry)}`,
    `止损：${fmtPrice(s.stop)}`,
    `目标1：${fmtPrice(tp1)}（1R）`,
    `目标2：${fmtPrice(tp2)}（2R）`,
    Number.isFinite(s.riskUsd) ? `风险：${(RISK_PCT * 100).toFixed(1)}%（约 ${s.riskUsd.toFixed(2)}）` : null,
    s.structure?.warnings?.length ? `⚠️ 结构提醒：${s.structure.warnings.join(' / ')}` : '结构检查：没有极端异常',
    Number.isFinite(s.structure?.riskAtr) ? `SL距离约 ${s.structure.riskAtr.toFixed(2)}× M15 ATR · 2R约 ${s.structure.tp2Atr.toFixed(2)}× ATR` : null,
    '',
    `确认时间：${sgtTime(s.candleCloseTime)} SGT`,
    `有效至：${sgtTime(Number(s.candleCloseTime) + SIGNAL_VALID_MS)} SGT`,
    '超过有效时间就不追。'
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
  if (!state.ops || typeof state.ops !== 'object') state.ops = {};
  return state;
}

function tradeFromSignal(s) {
  const riskDistance = Math.abs(Number(s.entry) - Number(s.stop));
  const tp1 = s.side === 'LONG' ? Number(s.entry) + riskDistance : Number(s.entry) - riskDistance;
  const tp2 = s.side === 'LONG' ? Number(s.entry) + 2 * riskDistance : Number(s.entry) - 2 * riskDistance;
  return {
    key: s.key,
    strategyVersion: s.strategyVersion || STRATEGY_VERSION,
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

function tradeFinalR(trade) {
  const status = String(trade?.status || '');
  if (status.includes('SAME_M15')) return null;
  if (status === 'TP2') return 2;
  if (status === 'SL' || status === 'TP1_THEN_SL') return -1;
  return null;
}

function buildDailySummary(state, targetDate) {
  state = normalizeState(state);
  const trades = Object.values(state.trades || {})
    .filter(t => Number.isFinite(Number(t.signalAtMs)) && sgtDate(Number(t.signalAtMs)) === targetDate);

  const resolved = trades.map(tradeFinalR).filter(Number.isFinite);
  const totalR = resolved.reduce((a,b) => a + b, 0);
  const tp1 = trades.filter(t => t.milestones?.tp1?.hit).length;
  const tp2 = trades.filter(t => t.milestones?.tp2?.hit).length;
  const sl = trades.filter(t => t.milestones?.sl?.hit).length;
  const open = trades.filter(t => !t.terminal).length;
  const ambiguous = trades.filter(t => String(t.status || '').includes('SAME_M15')).length;

  const shadowDay = Object.values(state.shadow || {})
    .filter(t => Number.isFinite(Number(t.signalAtMs)) && sgtDate(Number(t.signalAtMs)) === targetDate);
  const fullPass = shadowDay.filter(t => t.filters?.liveQualified).length;
  const blocked = shadowDay.filter(t => !t.filters?.liveQualified).length;

  return [
    '📅 每日总结',
    targetDate,
    '',
    `正式信号：${trades.length}`,
    `到1R：${tp1} · 到2R：${tp2} · 碰止损：${sl} · 还在跑：${open}`,
    resolved.length ? `已完成净结果：${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R（${resolved.length}单）` : '已完成净结果：还没有',
    ambiguous ? `⚠️ 同根M15无法判断先后：${ambiguous}` : null,
    '',
    `Shadow：全部条件通过 ${fullPass} · 被条件挡掉 ${blocked}`,
    '研究数据只做比较，不会自动改策略。'
  ].filter(Boolean).join('\n');
}

async function maybeSendDailySummary(state, now = Date.now()) {
  if (!DAILY_SUMMARY_ENABLED) return false;
  state = normalizeState(state);
  const p = sgtParts(now);
  if (p.hour !== DAILY_SUMMARY_HOUR_SGT || p.minute >= 45) return false;

  const targetDate = sgtDate(now - 24 * HOUR_MS);
  if (state.ops.lastDailySummaryDate === targetDate) return false;

  await telegram(buildDailySummary(state, targetDate));
  state.ops.lastDailySummaryDate = targetDate;
  state.ops.lastDailySummaryAt = new Date(now).toISOString();
  return true;
}

function actionableHealthStatus(coreMissing, dataErrors, feedHealth) {
  const cryptoErrors = (dataErrors || []).filter(x => x.provider === 'CRYPTO');
  const coreBad = (feedHealth || []).filter(x => CORE_SYMBOLS.has(x.symbol) && x.status !== 'HEALTHY');
  if ((coreMissing || []).length === CORE_SYMBOLS.size) return 'FAILED';
  if ((coreMissing || []).length || cryptoErrors.length || coreBad.length) return 'DEGRADED';
  return 'HEALTHY';
}

async function maybeSendHealthAlert(state, status, details = {}, now = Date.now()) {
  state = normalizeState(state);
  const prev = state.ops.lastActionHealthStatus || null;
  state.ops.lastActionHealthStatus = status;
  state.ops.lastHealthCheckedAt = new Date(now).toISOString();

  if (!prev && status === 'HEALTHY') return false;
  if (prev === status) return false;

  if (status === 'HEALTHY') {
    await telegram(['✅ 系统恢复正常', '', '核心数据源已经恢复，扫描继续。'].join('\n'));
  } else {
    const core = (details.coreMissing || []).join(', ');
    const errors = (details.cryptoErrors || []).map(x => x.symbol).join(', ');
    await telegram([
      status === 'FAILED' ? '🚨 系统异常' : '⚠️ 系统需要注意',
      '',
      core ? `核心数据异常：${core}` : null,
      errors ? `Crypto feed 错误：${errors}` : null,
      '为安全起见，有问题的数据不会发信号。'
    ].filter(Boolean).join('\n'));
  }

  state.ops.lastHealthAlertAt = new Date(now).toISOString();
  return true;
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

let health = {
  ok: true,
  status: 'STARTING',
  lastCycleAt: null,
  lastError: null,
  lastCandidates: 0,
  lastWatches: 0,
  dataErrors: [],
  feeds: []
};

async function cycle() {
  const now = Date.now();
  const state = loadState();
  const cryptoResults = await Promise.allSettled(SYMBOLS.map(s => snapshot(s, now)));
  const snaps = [];
  const dataErrors = [];
  for (let i = 0; i < cryptoResults.length; i += 1) {
    const r = cryptoResults[i];
    if (r.status === 'fulfilled') snaps.push(r.value);
    else {
      const error = String(r.reason?.message || r.reason);
      dataErrors.push({ symbol: SYMBOLS[i], provider: 'CRYPTO', error });
      console.error(JSON.stringify({ symbol: SYMBOLS[i], marketData: 'ERROR', error }));
    }
  }
  const fxResults = await Promise.allSettled(FX_SYMBOLS.map(s => publicFxSnapshot(s, now)));
  for (let i = 0; i < fxResults.length; i += 1) {
    const r = fxResults[i];
    if (r.status === 'fulfilled') snaps.push(r.value);
    else {
      const error = String(r.reason?.message || r.reason);
      dataErrors.push({ symbol: FX_SYMBOLS[i], provider: 'DUKASCOPY', error });
      console.error(JSON.stringify({ symbol: FX_SYMBOLS[i], provider: 'DUKASCOPY', marketData: 'ERROR', error }));
    }
  }

  const feedHealth = snaps.map(s => snapshotHealth(s, now));
  const healthySymbols = new Set(feedHealth.filter(x => x.ok).map(x => x.symbol));
  const coreMissing = [...CORE_SYMBOLS].filter(s => !healthySymbols.has(s));

  const outcomeChanged = trackTrades(state, snaps);
  const shadowAdded = captureShadowBreakouts(state, snaps, now);
  const shadowChanged = trackShadowTrades(state, snaps);
  if (outcomeChanged || shadowAdded || shadowChanged) saveState(state);

  const signals = [];
  const watches = [];

  for (const snap of snaps) {
    const integrity = snapshotHealth(snap, now);
    if (!integrity.ok) {
      console.warn(JSON.stringify({ symbol: snap.symbol, provider: snap.provider, signalIntegrity: 'BLOCKED', issues: integrity.issues }));
      continue;
    }
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

  const healthStatus = snaps.length === 0 || coreMissing.length === CORE_SYMBOLS.size
    ? 'FAILED'
    : (dataErrors.length || coreMissing.length || feedHealth.some(x => x.status !== 'HEALTHY') ? 'DEGRADED' : 'HEALTHY');
  health = {
    ok: healthStatus !== 'FAILED',
    status: healthStatus,
    lastCycleAt: new Date(now).toISOString(),
    lastError: null,
    lastCandidates: signals.length,
    lastWatches: watches.length,
    dataErrors,
    coreMissing,
    feeds: feedHealth
  };

  const actionStatus = actionableHealthStatus(coreMissing, dataErrors, feedHealth);
  const cryptoErrors = dataErrors.filter(x => x.provider === 'CRYPTO');
  try {
    const healthAlerted = await maybeSendHealthAlert(state, actionStatus, { coreMissing, cryptoErrors }, now);
    const dailySent = await maybeSendDailySummary(state, now);
    if (healthAlerted || dailySent) saveState(state);
  } catch (error) {
    console.error(JSON.stringify({ opsTelegram: 'ERROR', error: error.message }));
  }
  console.log(JSON.stringify({
    engine: 'Session Breakout Monitor V1',
    strategyVersion: STRATEGY_VERSION,
    mode: 'SIGNAL_ONLY',
    at: health.lastCycleAt,
    symbols: SYMBOLS,
    fxSymbols: FX_SYMBOLS,
    publicFxFeed: 'DUKASCOPY',
    health: { status: health.status, coreMissing: health.coreMissing, dataErrors: dataErrors.length },
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
      const code = health.status === 'FAILED' ? 503 : 200;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ...health,
        engine: 'Session Breakout Monitor V1',
        strategyVersion: STRATEGY_VERSION,
        mode: 'SIGNAL_ONLY',
        autoTrading: false,
        shadowLab: 'OBSERVATIONAL_ONLY'
      }, null, 2));
      return;
    }
    if (req.url === '/shadow' || req.url === '/evidence') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(shadowSummary(loadState()), null, 2));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Session Breakout Monitor V1\n');
  }).listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ http: 'LISTENING', port: PORT }));
  });
}

async function main() {
  if (!RUN_ONCE) {
    startHealthServer();
    if (COMMAND_CENTER_ENABLED) {
      try {
        const commandBot = require('./session_breakout_bot');
        commandBot.run().catch(error => {
          console.error(JSON.stringify({ commandCenter: 'ERROR', error: error.message }));
        });
      } catch (error) {
        console.error(JSON.stringify({ commandCenter: 'START_ERROR', error: error.message }));
      }
    }
  }
  console.log(JSON.stringify({ engine: 'Session Breakout Monitor V1', status: 'STARTING', runOnce: RUN_ONCE, commandCenter: COMMAND_CENTER_ENABLED, symbols: SYMBOLS, fxSymbols: FX_SYMBOLS, publicFxFeed: 'DUKASCOPY', sessions: SESSION_IDS, tpR: TP_R }));

  if (STARTUP_NOTICE) {
    try {
      await telegram([
        '✅ Breakout 系统已上线',
        '',
        '规则：前30分钟 Box → 刚收破 → VWAP 同向 → H4 EMA50 同向',
        `目标：${TP_R.toFixed(1)}R`,
        '模式：只发信号，不自动下单'
      ].join('\n'));
    } catch (error) {
      console.error(JSON.stringify({ startupTelegram: 'ERROR', error: error.message }));
    }
  }

  try { await cycle(); }
  catch (error) {
    health.ok = false;
    health.status = 'FAILED';
    health.lastError = error.message;
    console.error(JSON.stringify({ cycle: 'ERROR', error: error.message }));
    try {
      const state = loadState();
      const prev = state.ops?.lastFatalCycleError || null;
      const sig = String(error.message || error).slice(0, 160);
      if (prev !== sig) {
        await telegram(['🚨 扫描失败', '', sig, '', '这一轮不会发任何信号。'].join('\n'));
        state.ops.lastFatalCycleError = sig;
        state.ops.lastFatalCycleAt = new Date().toISOString();
        saveState(state);
      }
    } catch (notifyError) {
      console.error(JSON.stringify({ fatalTelegram: 'ERROR', error: notifyError.message }));
    }
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

module.exports = {
  STRATEGY_VERSION,
  localParts,
  ema50Bias,
  dailyVwap,
  sessionBox,
  snapshotHealth,
  evaluate,
  evaluateWatch,
  rawBreakoutEvent,
  shadowTradeFromBreakout,
  captureShadowBreakouts,
  trackShadowTrades,
  shadowFinalR,
  wilsonInterval,
  summarizeShadowTrades,
  compareFilterEvidence,
  shadowSummary,
  mapBinanceKlines,
  tradeFromSignal,
  updateTradeFromCandles,
  resultSummary,
  buildDailySummary,
  actionableHealthStatus,
  atr14,
  structureAssessment,
  ensureTpSlVariants,
  updateTpSlVariants,
  tpSlVariantStats,
  tpSlArenaSummary
};
