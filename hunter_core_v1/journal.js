'use strict';

const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    signals: []
  };
}

function loadState(file) {
  try {
    if (!fs.existsSync(file)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.signals)) return emptyState();
    return { ...emptyState(), ...parsed, version: STATE_VERSION };
  } catch {
    return emptyState();
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function stageFromEdge(edge) {
  const a = Math.abs(Number(edge) || 0);
  if (a >= 0.65) return 'ACTIONABLE';
  if (a >= 0.50) return 'ARMED';
  if (a >= 0.35) return 'WATCH';
  return 'NO_TRADE';
}

function directionFromEdge(edge) {
  return Number(edge) >= 0 ? 'LONG' : 'SHORT';
}

function lastCandle(snapshot) {
  return snapshot && snapshot.candles15m && snapshot.candles15m[snapshot.candles15m.length - 1];
}

function candleAfterSignal(signal, candle) {
  const t = Number(candle && candle.openTime);
  return Number.isFinite(t) && t > Number(signal.sourceCandleOpenTime || 0);
}

function zoneTouched(signal, candle) {
  const [lo, hi] = signal.entryZone;
  return Number(candle.high) >= lo && Number(candle.low) <= hi;
}

function stopTouched(signal, candle) {
  return signal.side === 'LONG'
    ? Number(candle.low) <= signal.stop
    : Number(candle.high) >= signal.stop;
}

function rMultiple(signal, price) {
  const risk = Math.abs(signal.entryMid - signal.stop);
  if (!(risk > 0)) return null;
  const dir = signal.side === 'LONG' ? 1 : -1;
  return dir * (Number(price) - signal.entryMid) / risk;
}

function excursionR(signal, candle) {
  const risk = Math.abs(signal.entryMid - signal.stop);
  if (!(risk > 0)) return { favorable: null, adverse: null };
  if (signal.side === 'LONG') {
    return {
      favorable: (Number(candle.high) - signal.entryMid) / risk,
      adverse: (Number(candle.low) - signal.entryMid) / risk
    };
  }
  return {
    favorable: (signal.entryMid - Number(candle.low)) / risk,
    adverse: (signal.entryMid - Number(candle.high)) / risk
  };
}

function makeSignal(result, snapshot, now) {
  const candle = lastCandle(snapshot);
  const p = result.plan;
  return {
    id: `${result.symbol}-${result.decision}-${now}`,
    symbol: result.symbol,
    side: result.decision,
    createdAt: new Date(now).toISOString(),
    sourceCandleOpenTime: Number(candle && candle.openTime) || now,
    edgeAtSignal: result.edge,
    regimeAtSignal: result.regime.name,
    componentsAtSignal: result.components,
    entryZone: p.entryZone,
    entryMid: p.entryMid,
    stop: p.stop,
    riskUsd: p.riskUsd,
    notional: p.notional,
    status: 'PENDING_ENTRY',
    triggeredAt: null,
    completedAt: null,
    closeReason: null,
    mfeR: null,
    maeR: null,
    r1h: null,
    r4h: null,
    r24h: null,
    finalR: null
  };
}

function active(signal) {
  return ['PENDING_ENTRY', 'TRIGGERED'].includes(signal.status);
}

function findActive(state, symbol, side) {
  return state.signals.find((s) => s.symbol === symbol && s.side === side && active(s));
}

function updateExisting(state, ranked, snapshots, now, events = []) {
  const resultMap = Object.fromEntries(ranked.map((x) => [x.symbol, x]));
  const snapMap = Object.fromEntries(snapshots.map((x) => [x.symbol, x]));

  for (const s of state.signals) {
    if (!active(s)) continue;
    const result = resultMap[s.symbol];
    const snap = snapMap[s.symbol];
    const candle = lastCandle(snap);
    if (!result || !candle || !candleAfterSignal(s, candle)) continue;

    if (s.status === 'PENDING_ENTRY') {
      const age = now - Date.parse(s.createdAt);
      const opposite = directionFromEdge(result.edge) !== s.side && Math.abs(result.edge) >= 0.35;
      const collapsed = Math.abs(result.edge) < 0.20;

      if (age >= DAY_MS) {
        s.status = 'EXPIRED';
        s.completedAt = new Date(now).toISOString();
        s.closeReason = 'ENTRY_NOT_TOUCHED_24H';
        events.push({ type: 'EXPIRED', signalId: s.id, symbol: s.symbol, side: s.side });
        continue;
      }
      if (opposite || collapsed) {
        s.status = 'INVALIDATED';
        s.completedAt = new Date(now).toISOString();
        s.closeReason = opposite ? 'EDGE_FLIPPED' : 'EDGE_COLLAPSED';
        events.push({ type: 'INVALIDATED', signalId: s.id, symbol: s.symbol, side: s.side, reason: s.closeReason });
        continue;
      }

      if (zoneTouched(s, candle)) {
        if (stopTouched(s, candle)) {
          s.status = 'AMBIGUOUS';
          s.triggeredAt = new Date(now).toISOString();
          s.completedAt = new Date(now).toISOString();
          s.closeReason = 'ENTRY_AND_STOP_SAME_15M_CANDLE';
          events.push({ type: 'AMBIGUOUS', signalId: s.id, symbol: s.symbol, side: s.side });
          continue;
        }
        s.status = 'TRIGGERED';
        s.triggeredAt = new Date(now).toISOString();
        s.mfeR = 0;
        s.maeR = 0;
        events.push({ type: 'ENTRY_TRIGGERED', signalId: s.id, symbol: s.symbol, side: s.side, entryMid: s.entryMid, stop: s.stop });
      } else {
        continue;
      }
    }

    if (s.status === 'TRIGGERED') {
      const ex = excursionR(s, candle);
      if (Number.isFinite(ex.favorable)) s.mfeR = s.mfeR == null ? ex.favorable : Math.max(s.mfeR, ex.favorable);
      if (Number.isFinite(ex.adverse)) s.maeR = s.maeR == null ? ex.adverse : Math.min(s.maeR, ex.adverse);

      if (stopTouched(s, candle)) {
        s.status = 'COMPLETED';
        s.completedAt = new Date(now).toISOString();
        s.closeReason = 'STOP_TOUCHED';
        s.finalR = -1;
        events.push({ type: 'STOP_TOUCHED', signalId: s.id, symbol: s.symbol, side: s.side, finalR: -1 });
        continue;
      }

      const elapsed = now - Date.parse(s.triggeredAt);
      const currentR = rMultiple(s, candle.close);
      if (elapsed >= 60 * 60 * 1000 && s.r1h == null) s.r1h = currentR;
      if (elapsed >= 4 * 60 * 60 * 1000 && s.r4h == null) s.r4h = currentR;
      if (elapsed >= 24 * 60 * 60 * 1000 && s.r24h == null) {
        s.r24h = currentR;
        s.finalR = currentR;
        s.status = 'COMPLETED';
        s.completedAt = new Date(now).toISOString();
        s.closeReason = '24H_FORWARD_EVAL';
        events.push({ type: 'FORWARD_COMPLETE', signalId: s.id, symbol: s.symbol, side: s.side, finalR: currentR });
      }
    }
  }
}

function processCycle(state, ranked, snapshots, now = Date.now(), options = {}) {
  const events = [];
  updateExisting(state, ranked, snapshots, now, events);

  const maxNew = Number.isFinite(Number(options.maxNew)) ? Math.max(0, Number(options.maxNew)) : Infinity;
  const created = [];
  for (const result of ranked) {
    if (created.length >= maxNew) break;
    if (!['LONG', 'SHORT'].includes(result.decision) || !result.plan) continue;

    // Avoid duplicate signals while the same symbol/direction is still being evaluated.
    if (findActive(state, result.symbol, result.decision)) continue;

    // If a strong opposite signal appears, retire an untriggered opposite setup.
    for (const s of state.signals) {
      if (s.symbol === result.symbol && s.side !== result.decision && s.status === 'PENDING_ENTRY') {
        s.status = 'INVALIDATED';
        s.completedAt = new Date(now).toISOString();
        s.closeReason = 'OPPOSITE_ACTIONABLE_SIGNAL';
        events.push({ type: 'INVALIDATED', signalId: s.id, symbol: s.symbol, side: s.side, reason: s.closeReason });
      }
    }

    const snap = snapshots.find((x) => x.symbol === result.symbol);
    if (!snap) continue;
    const signal = makeSignal(result, snap, now);
    state.signals.push(signal);
    created.push(signal);
  }

  // Bound local state size while preserving completed research history.
  if (state.signals.length > 1000) state.signals = state.signals.slice(-1000);
  state.updatedAt = new Date(now).toISOString();
  return { state, created, events };
}

function performance(state) {
  const all = state.signals || [];
  const actionable = all.length;
  const triggered = all.filter((s) => s.triggeredAt).length;
  const completed = all.filter((s) => s.status === 'COMPLETED' && Number.isFinite(s.finalR));
  const ambiguous = all.filter((s) => s.status === 'AMBIGUOUS').length;
  const expired = all.filter((s) => ['EXPIRED', 'INVALIDATED'].includes(s.status)).length;
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const vals = completed.map((s) => s.finalR);
  const wins = vals.filter((x) => x > 0).length;

  return {
    actionable,
    triggered,
    completed: completed.length,
    ambiguous,
    expired,
    triggerRate: actionable ? triggered / actionable : null,
    winRateFinal: vals.length ? wins / vals.length : null,
    avgFinalR: avg(vals),
    avgR1h: avg(all.map((s) => s.r1h).filter(Number.isFinite)),
    avgR4h: avg(all.map((s) => s.r4h).filter(Number.isFinite)),
    avgR24h: avg(all.map((s) => s.r24h).filter(Number.isFinite))
  };
}

function performanceBreakdown(state, field) {
  const groups = {};
  for (const s of state.signals || []) {
    const key = field === 'regime' ? s.regimeAtSignal : s.symbol;
    if (!key) continue;
    groups[key] = groups[key] || { signals: 0, completed: 0, wins: 0, sumR: 0 };
    groups[key].signals += 1;
    if (s.status === 'COMPLETED' && Number.isFinite(s.finalR)) {
      groups[key].completed += 1;
      groups[key].sumR += s.finalR;
      if (s.finalR > 0) groups[key].wins += 1;
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([key, g]) => [key, {
    signals: g.signals,
    completed: g.completed,
    winRate: g.completed ? g.wins / g.completed : null,
    avgR: g.completed ? g.sumR / g.completed : null
  }]));
}

module.exports = {
  emptyState,
  loadState,
  saveState,
  stageFromEdge,
  directionFromEdge,
  processCycle,
  performance,
  performanceBreakdown,
  rMultiple
};
