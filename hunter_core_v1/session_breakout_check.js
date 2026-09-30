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

function findLatestFreshBreakout(candles, box, side, latestOpen) {
  const xs = [...(candles || [])].sort((a,b) => a.openTime - b.openTime);
  let found = null;
  for (let i = 1; i < xs.length; i += 1) {
    const cur = xs[i];
    const prev = xs[i - 1];
    if (cur.openTime < box.activeFrom || cur.openTime > latestOpen) continue;
    const cc = Number(cur.close);
    const pc = Number(prev.close);
    const crossed = side === 'LONG'
      ? cc > box.high && pc <= box.high
      : cc < box.low && pc >= box.low;
    if (crossed) {
      found = {
        entry: cc,
        openTime: cur.openTime,
        closeTime: cur.openTime + M15_MS
      };
    }
  }
  return found;
}

function tradeLevels(side, entry, box) {
  const stop = side === 'LONG' ? box.low : box.high;
  const risk = Math.abs(entry - stop);
  return {
    stop,
    risk,
    tp1: side === 'LONG' ? entry + risk : entry - risk,
    tp2: side === 'LONG' ? entry + 2 * risk : entry - 2 * risk
  };
}

function inspectSession(snap, id, now = Date.now()) {
  const session = resolveSession(snap, id);
  const c15 = [...(snap.candles15m || [])].sort((a,b) => a.openTime - b.openTime);
  const latest = c15.at(-1);
  const previous = c15.at(-2);
  if (!session || !latest || !previous) return null;

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
    const prevClose = Number(previous.close);
    const fresh = breakoutSide === 'LONG' ? prevClose <= box.high : prevClose >= box.low;
    const vwapPass = breakoutSide === 'LONG' ? current > vwap : current < vwap;
    const h4Pass = breakoutSide === 'LONG' ? h4.bias === 'BULLISH' : h4.bias === 'BEARISH';
    const failed = [];
    if (!vwapPass) failed.push('VWAP');
    if (!h4Pass) failed.push('H4 EMA50');

    if (fresh) {
      const lv = tradeLevels(breakoutSide, current, box);
      if (vwapPass && h4Pass) {
        return {
          ...base,
          status: 'SIGNAL',
          side: breakoutSide,
          fresh: true,
          entry: current,
          stop: lv.stop,
          tp1: lv.tp1,
          tp2: lv.tp2,
          breakoutTime: closeTime,
          moveR: 0,
          reason: '刚刚第一次收破 Box，条件全部通过'
        };
      }
      return {
        ...base,
        status: 'BLOCKED',
        side: breakoutSide,
        fresh: true,
        entry: current,
        breakoutTime: closeTime,
        reason: failed.join(' + ') || '条件不同向'
      };
    }

    const first = findLatestFreshBreakout(c15, box, breakoutSide, latest.openTime);
    const entry = Number(first?.entry);
    const lv = Number.isFinite(entry) ? tradeLevels(breakoutSide, entry, box) : null;
    const moveR = lv && lv.risk > 0
      ? (breakoutSide === 'LONG' ? current - entry : entry - current) / lv.risk
      : null;
    const status = Number.isFinite(moveR) && moveR >= 0.5 ? 'EXTENDED' : 'ACTIVE';

    return {
      ...base,
      status,
      side: breakoutSide,
      fresh: false,
      entry: Number.isFinite(entry) ? entry : null,
      stop: lv?.stop ?? null,
      tp1: lv?.tp1 ?? null,
      tp2: lv?.tp2 ?? null,
      breakoutTime: first?.closeTime ?? null,
      moveR,
      filtersPass: vwapPass && h4Pass,
      reason: vwapPass && h4Pass
        ? '之前已经突破，不是新的进场'
        : `之前已经突破；现在 ${failed.join(' + ')} 不同向`
    };
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
  SIGNAL: 10,
  BLOCKED: 9,
  EXTENDED: 8,
  ACTIVE: 7,
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
  const active = sessionRows.filter(x => x.status === 'ACTIVE');
  const extended = sessionRows.filter(x => x.status === 'EXTENDED');
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
    active,
    extended,
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
    SIGNAL: '🟢', ACTIVE: '🟡', EXTENDED: '🟠', NEAR: '👀', BLOCKED: '⛔',
    BUILDING_BOX: '🟣', WAITING: '⚪', STALE: '🔴', DATA_ERROR: '🔴',
    SESSION_DONE: '🌙', OFF_SESSION: '🌙'
  }[status] || '⚪';
}

function sideCn(side) { return side === 'LONG' ? '做多' : side === 'SHORT' ? '做空' : ''; }

function statusLabel(x) {
  if (!x) return '未知';
  if (x.status === 'SIGNAL') return `${sideCn(x.side)} · 刚确认`;
  if (x.status === 'ACTIVE') return `${sideCn(x.side)} · 已突破`;
  if (x.status === 'EXTENDED') return `${sideCn(x.side)} · 已走远`;
  if (x.status === 'NEAR') return `${sideCn(x.side)} · 接近触发`;
  if (x.status === 'BLOCKED') return `${sideCn(x.side)} · 被条件挡掉`;
  if (x.status === 'BUILDING_BOX') return '正在形成 Box';
  if (x.status === 'WAITING') return '等待';
  if (x.status === 'STALE') return '数据过旧';
  if (x.status === 'DATA_ERROR') return '数据错误';
  return '时段已结束';
}

function formatNow(r) {
  const lines = ['🚨 现在', ''];

  if (r.signals.length) {
    lines.push('✅ 刚确认，可以看');
    for (const s of r.signals.slice(0, 6)) {
      lines.push(
        `${s.side === 'LONG' ? '🟢' : '🔴'} ${s.symbol} — ${sideCn(s.side)}`,
        `进场约 ${p(s.entry, s.symbol)} · 止损 ${p(s.stop, s.symbol)}`,
        `1R ${p(s.tp1, s.symbol)} · 2R ${p(s.tp2, s.symbol)}`,
        `确认时间 ${sgt(s.breakoutTime)} SGT`,
        ''
      );
    }
  } else {
    lines.push('⚪ 现在没有新的确认信号');
  }

  const old = [...(r.extended || []), ...(r.active || [])].slice(0, 6);
  if (old.length) {
    lines.push('⏳ 已经突破，但不是新进场');
    for (const x of old) {
      const moved = Number.isFinite(x.moveR) ? ` · 已走 ${x.moveR >= 0 ? '+' : ''}${x.moveR.toFixed(2)}R` : '';
      lines.push(`${x.symbol} ${sideCn(x.side)} · 突破 ${x.breakoutTime ? sgt(x.breakoutTime) : '较早'}${moved} · 不追`);
    }
  }

  const near = (r.watches || []).slice(0, 4);
  if (near.length) {
    lines.push('', '👀 接近触发');
    for (const w of near) {
      lines.push(`${w.symbol} ${sideCn(w.side)} · 等 M15 收在 ${w.side === 'LONG' ? '>' : '<'} ${p(w.trigger, w.symbol)}`);
    }
  }

  const blocked = (r.blocked || []).slice(0, 4);
  if (blocked.length) {
    lines.push('', '⛔ 刚突破但条件没过');
    for (const b of blocked) lines.push(`${b.symbol} ${sideCn(b.side)} · ${b.reason}`);
  }

  lines.push('', `下次检查约 ${sgt(r.nextScan)} SGT`);
  return lines.join('\n');
}

function formatWhy(r) {
  const rows = (r.markets || []).filter(x => !['SIGNAL','OFF_SESSION','SESSION_DONE'].includes(x.status));
  const lines = ['❓ 为什么没单', ''];
  if (!rows.length) return lines.concat('现在没有需要特别看的市场。').join('\n');

  for (const x of rows.slice(0, 12)) {
    if (x.status === 'ACTIVE') lines.push(`🟡 ${x.symbol}：已经突破，但不是刚突破；不追。`);
    else if (x.status === 'EXTENDED') lines.push(`🟠 ${x.symbol}：已经走远${Number.isFinite(x.moveR) ? ` ${x.moveR.toFixed(2)}R` : ''}；不追。`);
    else if (x.status === 'BLOCKED') lines.push(`⛔ ${x.symbol}：刚突破，但 ${x.reason}。`);
    else if (x.status === 'NEAR') lines.push(`👀 ${x.symbol}：方向条件对，只差 M15 收破 ${p(x.trigger, x.symbol)}。`);
    else if (x.status === 'BUILDING_BOX') lines.push(`🟣 ${x.symbol}：还在做前30分钟 Box。`);
    else if (x.status === 'WAITING') lines.push(`⚪ ${x.symbol}：还没突破。`);
    else if (x.status === 'STALE' || x.status === 'DATA_ERROR') lines.push(`🔴 ${x.symbol}：数据有问题，系统不会发单。`);
  }
  return lines.join('\n');
}

function formatMarketBoard(r) {
  const lines = ['🌍 市场状态', ''];
  const core = (r.markets || []).filter(x => x.core);
  const test = (r.markets || []).filter(x => !x.core);

  lines.push('重点');
  for (const x of core) lines.push(`${statusIcon(x.status)} ${shortSymbol(x.symbol)} · ${statusLabel(x)}`);

  lines.push('', '观察中');
  for (const x of test) lines.push(`${statusIcon(x.status)} ${shortSymbol(x.symbol)} · ${statusLabel(x)}`);

  lines.push('', '重点 = BTC / ETH / SOL。其他市场先观察和收集成绩。');
  return lines.join('\n');
}

function formatLevels(r) {
  const active = (r.markets || [])
    .filter(x => ['SIGNAL','ACTIVE','EXTENDED','BLOCKED','NEAR','WAITING'].includes(x.status) && Number.isFinite(x.boxHigh) && Number.isFinite(x.boxLow))
    .sort((a,b) => (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0))
    .slice(0, 8);

  const lines = ['👀 关键价位', ''];
  if (!active.length) return lines.concat('现在没有正在进行的 Session Box。').join('\n');

  for (const x of active) {
    lines.push(
      `${statusIcon(x.status)} ${x.symbol} · ${x.session}`,
      `Box 上 ${p(x.boxHigh, x.symbol)} · 下 ${p(x.boxLow, x.symbol)} · 现在 ${p(x.current, x.symbol)}`
    );
    if (x.status === 'NEAR') lines.push(`触发：M15 收在 ${x.side === 'LONG' ? '>' : '<'} ${p(x.trigger, x.symbol)}`);
    if (x.status === 'ACTIVE' || x.status === 'EXTENDED') lines.push('状态：已经突破，不是新进场');
    if (x.status === 'BLOCKED') lines.push(`被挡：${x.reason}`);
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
    '📡 系统',
    '',
    `${healthy ? '🟢' : '🟠'} 状态：${healthy ? '正常' : '需要注意'}`,
    `Crypto 数据：${r.cryptoOk}/${r.cryptoTotal}`,
    `黄金/Forex 数据：${r.fxOk}/${r.fxTotal}`,
    stale ? `🔴 过旧数据：${stale}` : '🟢 过旧数据：0',
    dataErrors ? `🔴 数据错误：${dataErrors}` : '🟢 数据错误：0',
    r.latestClose ? `最新 M15：${sgt(r.latestClose)} SGT（${latestAgeMin.toFixed(1)}分钟前）` : null,
    `下次检查：约 ${sgt(r.nextScan)} SGT`,
    '',
    '规则：前30分钟 Box → 刚收破 → VWAP 同向 → H4 EMA50 同向',
    '旧突破不会再当新进场。',
    '模式：只发信号，不自动下单'
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
