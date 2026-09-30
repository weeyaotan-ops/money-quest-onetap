'use strict';

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_SIGNAL_AGE_MS = Number(process.env.HUNTER_MAX_SIGNAL_AGE_MS || 20 * 60 * 1000);
const OKX_BASE = process.env.OKX_REST_BASE || process.env.OKX_API_BASE || 'https://www.okx.com';
const { getHistoricalRates } = require('dukascopy-node');

const CRYPTO = (process.env.BREAKOUT_CRYPTO_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,SUIUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const FX = (process.env.FX_SYMBOLS || 'XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCHF,USDCAD,NZDUSD')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const CORE = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

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
  const res = await fetch(url, {
    headers: { 'user-agent': 'session-breakout-command-center/1.0', ...headers },
    signal: AbortSignal.timeout(12000)
  });
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
  const [candles15m, candles4h] = await Promise.all([
    okxCandles(symbol, '15m', 300),
    okxCandles(symbol, '4H', 100)
  ]);
  return { symbol, provider: 'OKX', candles15m, candles4h };
}

async function dukascopyCandles(symbol, timeframe, lookbackDays, now = Date.now()) {
  const interval = timeframe === 'h4' ? 4 * HOUR_MS : timeframe === 'h1' ? HOUR_MS : M15_MS;
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

function ema50State(candles4h) {
  const xs = [...(candles4h || [])].sort((a,b) => a.openTime - b.openTime);
  if (xs.length < 51) return { bias: 'FLAT', ema50: null, close: xs.at(-1)?.close ?? null };
  const alpha = 2 / 51;
  let ema = Number(xs[0].close);
  for (let i = 1; i < xs.length; i++) ema = alpha * Number(xs[i].close) + (1 - alpha) * ema;
  const close = Number(xs.at(-1).close);
  if (close > ema) return { bias: 'BULLISH', ema50: ema, close };
  if (close < ema) return { bias: 'BEARISH', ema50: ema, close };
  return { bias: 'FLAT', ema50: ema, close };
}

function ema50Bias(candles4h) { return ema50State(candles4h).bias; }

function dailyVwap(candles15m, targetOpenTime) {
  const day = utcDate(targetOpenTime);
  let pv = 0, v = 0;
  for (const c of candles15m || []) {
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
  for (const c of candles || []) {
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

function phaseWithoutBox(latestOpen, session) {
  const p = localParts(latestOpen, session.tz);
  const nowMin = p.hour * 60 + p.minute;
  const startMin = session.hour * 60 + session.minute;
  if (nowMin >= startMin && nowMin < startMin + 30) return 'BUILDING_BOX';
  return 'OFF_SESSION';
}

function inspectSession(snap, id, now = Date.now()) {
  const session = resolveSession(snap, id);
  const c15 = [...(snap.candles15m || [])].sort((a,b) => a.openTime - b.openTime);
  const latest = c15.at(-1);
  if (!session || !latest) return null;

  const closeTime = latest.openTime + M15_MS;
  const age = now - closeTime;
  if (age < -60000 || age > MAX_SIGNAL_AGE_MS) {
    return { symbol: snap.symbol, provider: snap.provider, session: session.label, status: 'STALE', closeTime, ageMs: age };
  }

  const box = boxFor(c15, latest.openTime, session);
  if (!box) {
    return {
      symbol: snap.symbol, provider: snap.provider, session: session.label,
      status: phaseWithoutBox(latest.openTime, session), current: Number(latest.close), closeTime
    };
  }
  if (latest.openTime < box.activeFrom) {
    return { symbol: snap.symbol, provider: snap.provider, session: session.label, status: 'BUILDING_BOX', current: Number(latest.close), boxHigh: box.high, boxLow: box.low, closeTime };
  }
  if (latest.openTime >= box.activeUntil) {
    return { symbol: snap.symbol, provider: snap.provider, session: session.label, status: 'SESSION_DONE', current: Number(latest.close), boxHigh: box.high, boxLow: box.low, closeTime };
  }

  const current = Number(latest.close);
  const vwap = dailyVwap(c15, latest.openTime);
  const h4 = ema50State(snap.candles4h);
  if (!Number.isFinite(vwap)) {
    return { symbol: snap.symbol, provider: snap.provider, session: session.label, status: 'DATA_ERROR', reason: 'VWAP unavailable', current, boxHigh: box.high, boxLow: box.low, closeTime };
  }

  const base = {
    symbol: snap.symbol,
    provider: snap.provider,
    session: session.label,
    current,
    boxHigh: box.high,
    boxLow: box.low,
    vwap,
    h4Bias: h4.bias,
    h4Ema50: h4.ema50,
    h4Close: h4.close,
    closeTime,
    date: box.date
  };

  let breakoutSide = null;
  if (current > box.high) breakoutSide = 'LONG';
  else if (current < box.low) breakoutSide = 'SHORT';

  if (breakoutSide) {
    const vwapPass = breakoutSide === 'LONG' ? current > vwap : current < vwap;
    const h4Pass = breakoutSide === 'LONG' ? h4.bias === 'BULLISH' : h4.bias === 'BEARISH';
    if (vwapPass && h4Pass) {
      return { ...base, status: 'SIGNAL', side: breakoutSide, reason: 'All confirmations passed' };
    }
    const failed = [];
    if (!vwapPass) failed.push('VWAP');
    if (!h4Pass) failed.push('H4 EMA50');
    return { ...base, status: 'BLOCKED', side: breakoutSide, reason: failed.join(' + ') || 'Filter mismatch' };
  }

  let side = null;
  if (h4.bias === 'BULLISH' && current > vwap) side = 'LONG';
  if (h4.bias === 'BEARISH' && current < vwap) side = 'SHORT';
  if (!side) {
    const reason = h4.bias === 'FLAT' ? 'H4 not directional' : 'VWAP and H4 disagree';
    return { ...base, status: 'WAITING', reason };
  }

  const trigger = side === 'LONG' ? box.high : box.low;
  const distance = side === 'LONG' ? Math.max(0, box.high - current) : Math.max(0, current - box.low);
  const width = box.high - box.low;
  const boxFraction = width > 0 ? distance / width : 1;
  const distancePct = current > 0 ? distance / current * 100 : null;
  if (boxFraction <= 0.35) {
    return { ...base, status: 'NEAR', side, trigger, distance, distancePct, boxFraction, reason: 'Waiting M15 close through box' };
  }
  return { ...base, status: 'WAITING', side, trigger, distance, distancePct, boxFraction, reason: 'No breakout yet' };
}

const STATUS_PRIORITY = {
  SIGNAL: 8,
  BLOCKED: 7,
  NEAR: 6,
  BUILDING_BOX: 5,
  WAITING: 4,
  STALE: 3,
  DATA_ERROR: 2,
  SESSION_DONE: 1,
  OFF_SESSION: 0
};

function chooseMarketStatus(rows) {
  const xs = (rows || []).filter(Boolean);
  if (!xs.length) return null;
  return [...xs].sort((a,b) => (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0))[0];
}

function latestSignal(snap, id, now = Date.now()) {
  const x = inspectSession(snap, id, now);
  if (!x || x.status !== 'SIGNAL') return null;
  return {
    symbol: x.symbol, session: x.session, side: x.side, close: x.current,
    boxHigh: x.boxHigh, boxLow: x.boxLow, vwap: x.vwap, trend: x.h4Bias
  };
}

function watchLevel(snap, id, now = Date.now()) {
  const x = inspectSession(snap, id, now);
  if (!x || x.status !== 'NEAR') return null;
  return {
    symbol: x.symbol, provider: x.provider, session: x.session, side: x.side,
    current: x.current, trigger: x.trigger,
    invalidation: x.side === 'LONG' ? x.boxLow : x.boxHigh,
    distance: x.distance, distancePct: x.distancePct, boxFraction: x.boxFraction,
    trend: x.h4Bias, vwap: x.vwap, date: x.date,
    boxHigh: x.boxHigh, boxLow: x.boxLow
  };
}

function nextScanAt(now = Date.now()) {
  return (Math.floor(now / M15_MS) + 1) * M15_MS + 2 * 60 * 1000;
}

async function checkAll() {
  const now = Date.now();
  const cryptoSettled = await Promise.allSettled(CRYPTO.map(cryptoSnapshot));
  const fxSettled = await Promise.allSettled(FX.map(s => fxSnapshot(s, now)));

  const cryptoSnaps = cryptoSettled.filter(x => x.status === 'fulfilled').map(x => x.value);
  const fxSnaps = fxSettled.filter(x => x.status === 'fulfilled').map(x => x.value);
  const errors = [];
  cryptoSettled.forEach((x, i) => { if (x.status === 'rejected') errors.push({ symbol: CRYPTO[i], provider: 'OKX', error: String(x.reason?.message || x.reason) }); });
  fxSettled.forEach((x, i) => { if (x.status === 'rejected') errors.push({ symbol: FX[i], provider: 'DUKASCOPY', error: String(x.reason?.message || x.reason) }); });

  const all = [...cryptoSnaps, ...fxSnaps];
  const sessionRows = [];
  const markets = [];
  for (const snap of all) {
    const rows = ['LONDON','NEW_YORK'].map(id => inspectSession(snap, id, now)).filter(Boolean);
    sessionRows.push(...rows);
    const chosen = chooseMarketStatus(rows.filter(x => !['OFF_SESSION','SESSION_DONE'].includes(x.status))) || chooseMarketStatus(rows);
    if (chosen) markets.push({ ...chosen, core: CORE.has(snap.symbol) });
  }
  for (const e of errors) markets.push({ symbol: e.symbol, provider: e.provider, status: 'DATA_ERROR', reason: e.error, core: CORE.has(e.symbol) });

  const signals = sessionRows.filter(x => x.status === 'SIGNAL');
  const watches = sessionRows.filter(x => x.status === 'NEAR').sort((a,b) => (a.boxFraction ?? 9) - (b.boxFraction ?? 9));
  const blocked = sessionRows.filter(x => x.status === 'BLOCKED');
  const latestTimes = all.map(s => s.candles15m.at(-1)?.openTime + M15_MS).filter(Number.isFinite);

  return {
    now,
    cryptoOk: cryptoSnaps.length,
    cryptoTotal: CRYPTO.length,
    fxOk: fxSnaps.length,
    fxTotal: FX.length,
    errors,
    markets,
    sessionRows,
    signals,
    watches,
    blocked,
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

function shortSymbol(symbol) { return String(symbol).replace(/USDT$/,''); }

function statusIcon(status) {
  return {
    SIGNAL: '🟢', NEAR: '🟡', BLOCKED: '🟠', BUILDING_BOX: '🟣',
    WAITING: '⚪', STALE: '🔴', DATA_ERROR: '🔴', SESSION_DONE: '🌙', OFF_SESSION: '🌙'
  }[status] || '⚪';
}

function statusLabel(x) {
  if (!x) return 'UNKNOWN';
  if (x.status === 'SIGNAL') return `${x.side} SIGNAL`;
  if (x.status === 'NEAR') return `${x.side} NEAR`;
  if (x.status === 'BLOCKED') return `${x.side} BLOCKED`;
  if (x.status === 'BUILDING_BOX') return 'BUILDING BOX';
  if (x.status === 'WAITING') return 'WAITING';
  if (x.status === 'STALE') return 'STALE DATA';
  if (x.status === 'DATA_ERROR') return 'DATA ERROR';
  return 'OFF SESSION';
}

function formatNow(r) {
  const lines = ['🚨 NOW', ''];
  if (r.signals.length) {
    lines.push('✅ VALID');
    for (const s of r.signals.slice(0, 8)) lines.push(`${s.side === 'LONG' ? '🟢' : '🔴'} ${s.symbol} ${s.side} · ${s.session} · close ${p(s.current, s.symbol)}`);
  } else {
    lines.push('⚪ No confirmed entry now.');
  }

  const near = (r.watches || []).slice(0, 4);
  if (near.length) {
    lines.push('', '🟡 NEAR');
    for (const w of near) lines.push(`${w.symbol} ${w.side} · need M15 close ${w.side === 'LONG' ? '>' : '<'} ${p(w.trigger, w.symbol)}`);
  }

  const blocked = (r.blocked || []).slice(0, 4);
  if (blocked.length) {
    lines.push('', '🟠 BLOCKED');
    for (const b of blocked) lines.push(`${b.symbol} ${b.side} · ${b.reason}`);
  }

  lines.push('', `Next M15 check ~ ${sgt(r.nextScan)} SGT`);
  return lines.join('\n');
}

function formatWhy(r) {
  const rows = (r.markets || []).filter(x => !['SIGNAL','OFF_SESSION','SESSION_DONE'].includes(x.status));
  const lines = ['❓ WHY NO SIGNAL', ''];
  if (!rows.length) return lines.concat('Nothing active right now.').join('\n');
  for (const x of rows.slice(0, 12)) {
    if (x.status === 'BLOCKED') lines.push(`🟠 ${x.symbol} ${x.side}: breakout happened, blocked by ${x.reason}.`);
    else if (x.status === 'NEAR') lines.push(`🟡 ${x.symbol} ${x.side}: filters agree, waiting M15 close through ${p(x.trigger, x.symbol)}.`);
    else if (x.status === 'BUILDING_BOX') lines.push(`🟣 ${x.symbol}: building the first 30-min box.`);
    else if (x.status === 'WAITING') lines.push(`⚪ ${x.symbol}: ${x.reason || 'no breakout yet'}.`);
    else if (x.status === 'STALE' || x.status === 'DATA_ERROR') lines.push(`🔴 ${x.symbol}: ${x.status === 'STALE' ? 'feed is stale' : 'feed error'}.`);
  }
  return lines.join('\n');
}

function formatMarketBoard(r) {
  const lines = ['🌍 MARKET BOARD', ''];
  const core = (r.markets || []).filter(x => x.core);
  const test = (r.markets || []).filter(x => !x.core);

  lines.push('CORE');
  for (const x of core) lines.push(`${statusIcon(x.status)} ${shortSymbol(x.symbol)} · ${statusLabel(x)}${x.session && !['OFF_SESSION','SESSION_DONE'].includes(x.status) ? ` · ${x.session}` : ''}`);

  lines.push('', 'TEST / MONITOR');
  for (const x of test) lines.push(`${statusIcon(x.status)} ${shortSymbol(x.symbol)} · ${statusLabel(x)}${x.status === 'BLOCKED' ? ` · ${x.reason}` : ''}`);

  lines.push('', 'CORE = BTC / ETH / SOL validated set. Others are monitoring/test until equally validated.');
  return lines.join('\n');
}

function formatLevels(r) {
  const active = (r.markets || [])
    .filter(x => ['SIGNAL','BLOCKED','NEAR','WAITING'].includes(x.status) && Number.isFinite(x.boxHigh) && Number.isFinite(x.boxLow))
    .sort((a,b) => (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0))
    .slice(0, 8);
  const lines = ['👀 KEY LEVELS', ''];
  if (!active.length) return lines.concat('No active session box right now.', 'Wait for the next session / M15 close.').join('\n');
  for (const x of active) {
    lines.push(`${statusIcon(x.status)} ${x.symbol} · ${x.session}`, `Box H ${p(x.boxHigh, x.symbol)} · L ${p(x.boxLow, x.symbol)} · Now ${p(x.current, x.symbol)}`);
    if (x.status === 'NEAR') lines.push(`Trigger: M15 close ${x.side === 'LONG' ? '>' : '<'} ${p(x.trigger, x.symbol)}`);
    if (x.status === 'BLOCKED') lines.push(`Blocked by: ${x.reason}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function formatSystem(r) {
  const stale = (r.markets || []).filter(x => x.status === 'STALE').length;
  const dataErrors = (r.markets || []).filter(x => x.status === 'DATA_ERROR').length;
  const healthy = r.cryptoOk === r.cryptoTotal && r.fxOk === r.fxTotal && stale === 0 && dataErrors === 0;
  const latestAgeMin = r.latestClose ? Math.max(0, (r.now - r.latestClose) / 60000) : null;
  return [
    '📡 SYSTEM',
    '',
    `${healthy ? '🟢' : '🟠'} Self-check: ${healthy ? 'HEALTHY' : 'ATTENTION'}`,
    `${r.cryptoOk === r.cryptoTotal ? '🟢' : '🟠'} Crypto feed: ${r.cryptoOk}/${r.cryptoTotal}`,
    `${r.fxOk === r.fxTotal ? '🟢' : '🟠'} Gold/Forex feed: ${r.fxOk}/${r.fxTotal}`,
    stale ? `🔴 Stale markets: ${stale}` : '🟢 Stale markets: 0',
    dataErrors ? `🔴 Data errors: ${dataErrors}` : '🟢 Data errors: 0',
    r.latestClose ? `Latest M15 close: ${sgt(r.latestClose)} SGT (${latestAgeMin.toFixed(1)}m ago)` : null,
    `Next scan: ~${sgt(r.nextScan)} SGT`,
    '',
    'Rule: M15 box close breakout + VWAP + H4 price vs EMA50',
    'Mode: SIGNAL ONLY'
  ].filter(Boolean).join('\n');
}

function formatCheck(r) { return formatNow(r); }

module.exports = {
  checkAll,
  formatCheck,
  formatNow,
  formatWhy,
  formatMarketBoard,
  formatLevels,
  formatSystem,
  latestSignal,
  watchLevel,
  inspectSession,
  resolveSession,
  ema50Bias,
  ema50State,
  boxFor
};
