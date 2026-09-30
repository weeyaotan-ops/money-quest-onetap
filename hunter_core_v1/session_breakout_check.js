'use strict';

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OKX_BASE = process.env.OKX_REST_BASE || process.env.OKX_API_BASE || 'https://www.okx.com';
const { getHistoricalRates } = require('dukascopy-node');

const CRYPTO = (process.env.BREAKOUT_CRYPTO_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,SUIUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const FX = (process.env.FX_SYMBOLS || 'XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCHF,USDCAD,NZDUSD')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const SESSION_DEFS = {
  LONDON: { id: 'LONDON', label: 'London', tz: 'Europe/London', hour: 8, minute: 0 },
  NEW_YORK: { id: 'NEW_YORK', label: 'New York', tz: 'America/New_York', hour: 9, minute: 30 }
};

function localParts(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
}

function sgt(ts) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ts));
}

function utcDate(ts) { return new Date(Number(ts)).toISOString().slice(0, 10); }

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'session-breakout-check/1.0', ...headers }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

function okxInstId(symbol) { return `${symbol.replace(/USDT$/i, '')}-USDT-SWAP`; }

async function okxCandles(symbol, bar, limit) {
  const qs = new URLSearchParams({ instId: okxInstId(symbol), bar, limit: String(Math.min(limit, 300)) });
  const body = await getJson(`${OKX_BASE}/api/v5/market/candles?${qs}`);
  if (body.code !== '0') throw new Error(`OKX_${body.code}`);
  const interval = bar === '4H' ? 4 * HOUR_MS : M15_MS;
  return (body.data || []).filter(r => String(r[8] ?? '1') === '1').map(r => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[0]) + interval - 1
  })).sort((a,b) => a.openTime - b.openTime);
}

async function cryptoSnapshot(symbol) {
  const [candles15m, candles4h] = await Promise.all([okxCandles(symbol, '15m', 300), okxCandles(symbol, '4H', 100)]);
  return { symbol, provider: 'OKX', candles15m, candles4h };
}

async function dukascopyCandles(symbol, timeframe, lookbackDays, now = Date.now()) {
  const interval = timeframe === 'h4' ? 4 * HOUR_MS : M15_MS;
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
    closeTime: Number(x.timestamp) + interval - 1
  })).filter(x =>
    Number.isFinite(x.openTime) &&
    [x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite) &&
    x.openTime + interval <= now
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

async function fxSnapshot(symbol, now = Date.now()) {
  const [candles15m, candles1h] = await Promise.all([
    dukascopyCandles(symbol, 'm15', 5, now),
    dukascopyCandles(symbol, 'h1', 14, now)
  ]);
  const candles4h = aggregateH4FromH1(candles1h);
  if (candles15m.length < 20 || candles4h.length < 51) throw new Error('DUKASCOPY_INSUFFICIENT_DATA');
  return { symbol, provider: 'DUKASCOPY', candles15m, candles4h };
}

function ema50Bias(candles4h) {
  const xs = [...candles4h].sort((a,b) => a.openTime - b.openTime);
  if (xs.length < 51) return 'FLAT';
  const alpha = 2 / 51;
  let ema = xs[0].close, prev = ema;
  for (let i = 1; i < xs.length; i++) { prev = ema; ema = alpha * xs[i].close + (1 - alpha) * ema; }
  const close = xs.at(-1).close, slope = ema - prev;
  if (close > ema && slope > 0) return 'BULLISH';
  if (close < ema && slope < 0) return 'BEARISH';
  return 'FLAT';
}

function dailyVwap(candles15m, targetOpenTime) {
  const day = utcDate(targetOpenTime);
  let pv = 0, v = 0;
  for (const c of candles15m) {
    if (c.openTime > targetOpenTime || utcDate(c.openTime) !== day || !(c.volume > 0)) continue;
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    v += c.volume;
  }
  return v > 0 ? pv / v : null;
}

function resolveSession(snap, id) {
  const base = SESSION_DEFS[id];
  if (!base) return null;
  if (id !== 'NEW_YORK') return base;
  if (snap.provider === 'DUKASCOPY') {
    if (snap.symbol === 'XAUUSD') return { ...base, id: 'NEW_YORK_GOLD', label: 'NY Gold', hour: 8, minute: 30 };
    return { ...base, id: 'NEW_YORK_FX', label: 'NY FX', hour: 8, minute: 0 };
  }
  return { ...base, id: 'NEW_YORK_CRYPTO', label: 'NY Crypto', hour: 9, minute: 30 };
}

function boxFor(candles, latestOpen, session) {
  const ld = localParts(latestOpen, session.tz);
  let h2 = session.hour, m2 = session.minute + 15;
  if (m2 >= 60) { m2 -= 60; h2++; }
  let a = null, b = null;
  for (const c of candles) {
    const p = localParts(c.openTime, session.tz);
    if (p.date !== ld.date) continue;
    if (p.hour === session.hour && p.minute === session.minute) a = c;
    if (p.hour === h2 && p.minute === m2) b = c;
  }
  if (!a || !b) return null;
  return {
    date: ld.date,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    activeFrom: b.openTime + M15_MS,
    activeUntil: b.openTime + 6 * HOUR_MS
  };
}

function latestSignal(snap, id, now = Date.now()) {
  const session = resolveSession(snap, id);
  const c15 = [...snap.candles15m].sort((a,b) => a.openTime - b.openTime);
  const latest = c15.at(-1);
  if (!session || !latest) return null;
  const age = now - (latest.openTime + M15_MS);
  if (age < -60000 || age > 20 * 60 * 1000) return null;
  const box = boxFor(c15, latest.openTime, session);
  if (!box || latest.openTime < box.activeFrom || latest.openTime >= box.activeUntil) return null;
  const vwap = dailyVwap(c15, latest.openTime);
  const trend = ema50Bias(snap.candles4h);
  if (!Number.isFinite(vwap)) return null;
  let side = null;
  if (latest.close > box.high && latest.close > vwap && trend === 'BULLISH') side = 'LONG';
  if (latest.close < box.low && latest.close < vwap && trend === 'BEARISH') side = 'SHORT';
  if (!side) return null;
  return { symbol: snap.symbol, session: session.label, side, close: latest.close, boxHigh: box.high, boxLow: box.low, vwap, trend };
}

function watchLevel(snap, id, now = Date.now()) {
  const session = resolveSession(snap, id);
  const c15 = [...snap.candles15m].sort((a,b) => a.openTime - b.openTime);
  const latest = c15.at(-1);
  if (!session || !latest) return null;

  const age = now - (latest.openTime + M15_MS);
  if (age < -60000 || age > 20 * 60 * 1000) return null;

  const box = boxFor(c15, latest.openTime, session);
  if (!box || latest.openTime < box.activeFrom || latest.openTime >= box.activeUntil) return null;

  const vwap = dailyVwap(c15, latest.openTime);
  const trend = ema50Bias(snap.candles4h);
  const close = Number(latest.close);
  const width = Number(box.high) - Number(box.low);
  if (!Number.isFinite(vwap) || !(width > 0)) return null;

  let side = null, trigger = null, invalidation = null, distance = null;

  if (trend === 'BULLISH' && close > vwap && close <= box.high) {
    side = 'LONG';
    trigger = box.high;
    invalidation = box.low;
    distance = box.high - close;
  } else if (trend === 'BEARISH' && close < vwap && close >= box.low) {
    side = 'SHORT';
    trigger = box.low;
    invalidation = box.high;
    distance = close - box.low;
  } else {
    return null;
  }

  const boxFraction = Math.max(0, distance / width);
  const distancePct = Math.max(0, distance / close * 100);

  return {
    symbol: snap.symbol,
    provider: snap.provider,
    session: session.label,
    side,
    current: close,
    trigger,
    invalidation,
    distance,
    distancePct,
    boxFraction,
    trend,
    vwap,
    date: box.date
  };
}

function nextScanAt(now = Date.now()) {
  const q = (Math.floor(now / M15_MS) + 1) * M15_MS + 2 * 60 * 1000;
  return q;
}

async function checkAll() {
  const now = Date.now();
  const cryptoSettled = await Promise.allSettled(CRYPTO.map(cryptoSnapshot));
  const cryptoSnaps = cryptoSettled.filter(x => x.status === 'fulfilled').map(x => x.value);

  let fxSnaps = [];
  const fxConfigured = true;
  let fxErrors = 0;
  const fxSettled = await Promise.allSettled(FX.map(s => fxSnapshot(s, now)));
  fxSnaps = fxSettled.filter(x => x.status === 'fulfilled').map(x => x.value);
  fxErrors = fxSettled.length - fxSnaps.length;

  const all = [...cryptoSnaps, ...fxSnaps];
  const signals = [];
  const watches = [];
  for (const snap of all) {
    for (const id of ['LONDON','NEW_YORK']) {
      const s = latestSignal(snap, id, now);
      if (s) signals.push(s);
      else {
        const w = watchLevel(snap, id, now);
        if (w) watches.push(w);
      }
    }
  }
  watches.sort((a,b) => a.boxFraction - b.boxFraction);

  const latestTimes = all.map(s => s.candles15m.at(-1)?.openTime + M15_MS).filter(Number.isFinite);
  return {
    now,
    cryptoOk: cryptoSnaps.length,
    cryptoTotal: CRYPTO.length,
    fxConfigured,
    fxOk: fxSnaps.length,
    fxTotal: FX.length,
    fxErrors,
    signals,
    watches,
    latestClose: latestTimes.length ? Math.max(...latestTimes) : null,
    nextScan: nextScanAt(now)
  };
}

function p(x, symbol = '') {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  const s = String(symbol).toUpperCase();
  if (s === 'XAUUSD') return n.toFixed(2);
  if (s.includes('JPY')) return n.toFixed(3);
  if (s.endsWith('USD') && !s.endsWith('USDT')) return n.toFixed(5);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function formatNow(r) {
  const lines = ['🚨 NOW', ''];

  if (r.signals.length) {
    lines.push('✅ CONFIRMED SIGNALS');
    for (const s of r.signals.slice(0, 8)) {
      lines.push(
        `${s.side === 'LONG' ? '🟢' : '🔴'} ${s.symbol} — ${s.side}`,
        `Entry ~ ${p(s.close, s.symbol)}`,
        `Session: ${s.session}`,
        ''
      );
    }
  } else {
    lines.push('⚪ No confirmed entry right now.');
  }

  const near = (r.watches || []).filter(w => w.boxFraction <= 0.35).slice(0, 3);
  if (near.length) {
    lines.push('👀 CLOSEST TO TRIGGER');
    for (const w of near) {
      const arrow = w.side === 'LONG' ? '↑' : '↓';
      lines.push(`${w.symbol} ${arrow} ${p(w.trigger, w.symbol)}  | now ${p(w.current, w.symbol)}`);
    }
  }

  lines.push('', `Next check ~ ${sgt(r.nextScan)} SGT`);
  return lines.join('\n');
}

function formatLevels(r) {
  const watches = (r.watches || []).slice(0, 8);
  const lines = ['👀 KEY LEVELS', ''];

  if (!watches.length) {
    lines.push('Nothing important is close enough right now.', '', 'Wait for the next M15 close.');
    return lines.join('\n');
  }

  for (const w of watches) {
    const arrow = w.side === 'LONG' ? '↑' : '↓';
    const verb = w.side === 'LONG' ? 'ABOVE' : 'BELOW';
    const hot = w.boxFraction <= 0.20 ? '🔥' : w.boxFraction <= 0.35 ? '🟠' : '⚪';
    lines.push(
      `${hot} ${w.symbol} — ${w.side}`,
      `WATCH ${arrow} ${p(w.trigger, w.symbol)}`,
      `Now: ${p(w.current, w.symbol)} · ${w.distancePct.toFixed(2)}% away`,
      `Only act after M15 CLOSE ${verb} ${p(w.trigger, w.symbol)}`,
      ''
    );
  }

  lines.push('🔥 = very close · still NOT an entry until M15 closes through the level.');
  return lines.join('\n');
}

function formatSystem(r) {
  return [
    '📡 SYSTEM',
    '',
    `${r.cryptoOk === r.cryptoTotal ? '🟢' : '🟠'} Crypto: ${r.cryptoOk}/${r.cryptoTotal}`,
    `${r.fxOk === r.fxTotal ? '🟢' : '🟠'} Gold/Forex: ${r.fxOk}/${r.fxTotal}`,
    r.latestClose ? `Latest M15: ${sgt(r.latestClose)} SGT` : null,
    `Next scan: ~${sgt(r.nextScan)} SGT`,
    '',
    'Mode: SIGNAL ONLY'
  ].filter(Boolean).join('\n');
}

function formatCheck(r) {
  return formatNow(r);
}

module.exports = { checkAll, formatCheck, formatNow, formatLevels, formatSystem, latestSignal, watchLevel, resolveSession };
