'use strict';

const M15_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureShadow(state) {
  if (!state.shadow || typeof state.shadow !== 'object') state.shadow = {};
  if (!state.shadow.trades || typeof state.shadow.trades !== 'object') state.shadow.trades = {};
  state.shadow.version = 1;
  return state.shadow;
}

function tradeFromCandidate(c) {
  const risk = Math.abs(Number(c.entry) - Number(c.stop));
  const tp1 = c.side === 'LONG' ? Number(c.entry) + risk : Number(c.entry) - risk;
  const tp2 = c.side === 'LONG' ? Number(c.entry) + 2 * risk : Number(c.entry) - 2 * risk;
  return {
    key: c.key,
    symbol: c.symbol,
    provider: c.provider,
    session: c.session,
    sessionLabel: c.sessionLabel,
    side: c.side,
    candleOpenTime: Number(c.candleOpenTime),
    signalAtMs: Number(c.candleCloseTime),
    signalAt: new Date(Number(c.candleCloseTime)).toISOString(),
    entry: Number(c.entry),
    stop: Number(c.stop),
    tp1,
    tp2,
    riskDistance: risk,
    vwapPass: !!c.vwapPass,
    h4Pass: !!c.h4Pass,
    fullPass: !!c.fullPass,
    firstBreakout: !!c.firstBreakout,
    status: 'OPEN',
    terminal: false,
    lastTrackedOpenTime: Number(c.candleOpenTime),
    milestones: {
      tp1: { hit: false, at: null, candleOpenTime: null, sameBar: false },
      tp2: { hit: false, at: null, candleOpenTime: null, sameBar: false },
      sl: { hit: false, at: null, candleOpenTime: null, sameBar: false }
    }
  };
}

function registerCandidate(state, candidate) {
  const shadow = ensureShadow(state);
  if (!candidate || shadow.trades[candidate.key]) return false;
  shadow.trades[candidate.key] = tradeFromCandidate(candidate);
  return true;
}

function hit(trade, candle, kind) {
  const high = Number(candle.high), low = Number(candle.low);
  if (kind === 'sl') return trade.side === 'LONG' ? low <= trade.stop : high >= trade.stop;
  if (kind === 'tp1') return trade.side === 'LONG' ? high >= trade.tp1 : low <= trade.tp1;
  if (kind === 'tp2') return trade.side === 'LONG' ? high >= trade.tp2 : low <= trade.tp2;
  return false;
}

function updateTrade(trade, candles) {
  if (!trade || trade.terminal) return false;
  let changed = false;
  const start = Number(trade.candleOpenTime) + M15_MS;
  const sorted = [...(candles || [])].sort((a,b) => Number(a.openTime) - Number(b.openTime));

  for (const candle of sorted) {
    if (trade.terminal) break;
    const ot = Number(candle.openTime);
    if (ot < start || ot <= Number(trade.lastTrackedOpenTime || 0)) continue;

    const hits = {
      tp1: !trade.milestones.tp1.hit && hit(trade, candle, 'tp1'),
      tp2: !trade.milestones.tp2.hit && hit(trade, candle, 'tp2'),
      sl: !trade.milestones.sl.hit && hit(trade, candle, 'sl')
    };
    if (hits.tp2 && !trade.milestones.tp1.hit) hits.tp1 = true;

    const kinds = Object.entries(hits).filter(([,v]) => v).map(([k]) => k);
    const sameBar = kinds.length > 1;
    const at = new Date(ot + M15_MS).toISOString();

    for (const kind of kinds) {
      trade.milestones[kind] = { hit: true, at, candleOpenTime: ot, sameBar };
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

    trade.lastTrackedOpenTime = ot;
  }
  return changed;
}

function trackAll(state, snapshots) {
  const shadow = ensureShadow(state);
  const bySymbol = Object.fromEntries((snapshots || []).map(s => [s.symbol, s]));
  let changed = false;
  for (const trade of Object.values(shadow.trades)) {
    const snap = bySymbol[trade.symbol];
    if (!snap) continue;
    if (updateTrade(trade, snap.candles15m || [])) changed = true;
  }
  return changed;
}

function finalR(t) {
  if (!t || !t.terminal || String(t.status).includes('SAME_M15')) return null;
  if (t.status === 'TP2') return 2;
  if (t.status === 'SL' || t.status === 'TP1_THEN_SL') return -1;
  return null;
}

function stats(trades) {
  const xs = trades || [];
  const completed = xs.map(t => ({t, r: finalR(t)})).filter(x => Number.isFinite(x.r));
  const wins = completed.filter(x => x.r > 0).length;
  const losses = completed.filter(x => x.r < 0).length;
  const totalR = completed.reduce((a,x) => a + x.r, 0);
  return {
    n: xs.length,
    completed: completed.length,
    wins,
    losses,
    winRate: completed.length ? wins / completed.length : null,
    avgR: completed.length ? totalR / completed.length : null,
    totalR,
    tp1: xs.filter(t => t.milestones?.tp1?.hit).length,
    tp2: xs.filter(t => t.milestones?.tp2?.hit).length,
    sl: xs.filter(t => t.milestones?.sl?.hit).length,
    open: xs.filter(t => !t.terminal).length,
    ambiguous: xs.filter(t => String(t.status || '').includes('SAME_M15')).length
  };
}

function groupStats(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return Object.fromEntries([...map.entries()].map(([k,v]) => [k, stats(v)]));
}

function summary(state, opts = {}) {
  const shadow = ensureShadow(state);
  const firstOnly = opts.firstOnly !== false;
  const all = Object.values(shadow.trades);
  const xs = firstOnly ? all.filter(t => t.firstBreakout) : all;
  const fullPass = xs.filter(t => t.fullPass);
  const filteredOut = xs.filter(t => !t.fullPass);
  return {
    firstOnly,
    raw: stats(xs),
    vwapPass: stats(xs.filter(t => t.vwapPass)),
    h4Pass: stats(xs.filter(t => t.h4Pass)),
    fullPass: stats(fullPass),
    filteredOut: stats(filteredOut),
    bySymbol: groupStats(xs, t => t.symbol),
    bySession: groupStats(xs, t => t.sessionLabel || t.session),
    bySide: groupStats(xs, t => t.side)
  };
}

function prune(state, now = Date.now()) {
  const shadow = ensureShadow(state);
  const cutoff = now - 180 * DAY_MS;
  const entries = Object.entries(shadow.trades)
    .sort((a,b) => Number(b[1]?.signalAtMs || 0) - Number(a[1]?.signalAtMs || 0));
  const keep = new Set(entries
    .filter(([,t], idx) => idx < 5000 && Number(t?.signalAtMs || 0) >= cutoff)
    .map(([k]) => k));
  for (const key of Object.keys(shadow.trades)) if (!keep.has(key)) delete shadow.trades[key];
}

module.exports = {
  ensureShadow,
  registerCandidate,
  updateTrade,
  trackAll,
  finalR,
  stats,
  summary,
  prune
};
