'use strict';

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OKX_BASE = process.env.OKX_REST_BASE || process.env.OKX_API_BASE || 'https://www.okx.com';
const OANDA_API_BASE = process.env.OANDA_API_BASE || 'https://api-fxpractice.oanda.com';
const OANDA_TOKEN = process.env.OANDA_TOKEN || '';

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

function oandaInstrument(symbol) {
  if (symbol === 'XAUUSD') return 'XAU_USD';
  return symbol.replace(/^([A-Z]{3})([A-Z]{3})$/, '$1_$2');
}

async function oandaCandles(symbol, granularity, count) {
  if (!OANDA_TOKEN) throw new Error('OANDA_TOKEN_MISSING');
  const qs = new URLSearchParams({ price: 'M', granularity, count: String(count), smooth: 'false' });
  const body = await getJson(
    `${OANDA_API_BASE}/v3/instruments/${encodeURIComponent(oandaInstrument(symbol))}/candles?${qs}`,
    { authorization: `Bearer ${OANDA_TOKEN}` }
  );
  const interval = granularity === 'H4' ? 4 * HOUR_MS : M15_MS;
  return (body.candles || []).filter(x => x.complete === true && x.mid).map(x => {
    const openTime = Date.parse(x.time);
    return {
      openTime, open: Number(x.mid.o), high: Number(x.mid.h), low: Number(x.mid.l),
      close: Number(x.mid.c), volume: Number(x.volume || 0), closeTime: openTime + interval - 1
    };
  }).sort((a,b) => a.openTime - b.openTime);
}

async function fxSnapshot(symbol) {
  const [candles15m, candles4h] = await Promise.all([oandaCandles(symbol, 'M15', 300), oandaCandles(symbol, 'H4', 100)]);
  return { symbol, provider: 'OANDA', candles15m, candles4h };
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
  if (snap.provider === 'OANDA') {
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

function nextScanAt(now = Date.now()) {
  const q = (Math.floor(now / M15_MS) + 1) * M15_MS + 2 * 60 * 1000;
  return q;
}

async function checkAll() {
  const now = Date.now();
  const cryptoSettled = await Promise.allSettled(CRYPTO.map(cryptoSnapshot));
  const cryptoSnaps = cryptoSettled.filter(x => x.status === 'fulfilled').map(x => x.value);

  let fxSnaps = [];
  let fxConfigured = Boolean(OANDA_TOKEN);
  let fxErrors = 0;
  if (fxConfigured) {
    const fxSettled = await Promise.allSettled(FX.map(fxSnapshot));
    fxSnaps = fxSettled.filter(x => x.status === 'fulfilled').map(x => x.value);
    fxErrors = fxSettled.length - fxSnaps.length;
  }

  const all = [...cryptoSnaps, ...fxSnaps];
  const signals = [];
  for (const snap of all) {
    for (const id of ['LONDON','NEW_YORK']) {
      const s = latestSignal(snap, id, now);
      if (s) signals.push(s);
    }
  }

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
    latestClose: latestTimes.length ? Math.max(...latestTimes) : null,
    nextScan: nextScanAt(now)
  };
}

function p(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function formatCheck(r) {
  const lines = [
    '📡 BREAKOUT CHECK',
    '',
    `${r.cryptoOk === r.cryptoTotal ? '🟢' : '🟠'} Crypto feed: ${r.cryptoOk}/${r.cryptoTotal} OK`,
    r.fxConfigured
      ? `${r.fxOk === r.fxTotal ? '🟢' : '🟠'} Gold/Forex feed: ${r.fxOk}/${r.fxTotal} OANDA`
      : '🔴 Gold/Forex feed: NOT CONNECTED',
    r.fxConfigured ? null : '   OANDA token is still missing.',
    '',
    'Rule: 2×M15 box + CLOSE breakout + VWAP + H4 EMA50',
    'Sessions: London + New York',
    r.latestClose ? `Latest closed M15: ${sgt(r.latestClose)} SGT` : null,
    `Next auto scan: ~${sgt(r.nextScan)} SGT`,
    '',
    r.signals.length ? '🚨 VALID RIGHT NOW' : '⚪ No new valid breakout on the latest M15 close.'
  ].filter(Boolean);

  for (const s of r.signals.slice(0, 12)) {
    lines.push(`${s.side === 'LONG' ? '🟢' : '🔴'} ${s.symbol} ${s.session} ${s.side} @ ${p(s.close)}`);
  }

  lines.push('', 'BTC/ETH/SOL: 2Y-tested version.', 'Other symbols: monitoring, not yet 2Y validated.');
  return lines.join('\n');
}

module.exports = { checkAll, formatCheck, latestSignal, resolveSession };
