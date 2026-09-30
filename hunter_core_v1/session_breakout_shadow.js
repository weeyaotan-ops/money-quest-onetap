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


function rankGroupStats(summaryObject, minCompleted = 12) {
  const rows = [];
  for (const [key, s] of Object.entries(summaryObject || {})) {
    if (!s || Number(s.completed || 0) < minCompleted || !Number.isFinite(Number(s.avgR))) continue;
    rows.push({
      key,
      n: Number(s.n || 0),
      completed: Number(s.completed || 0),
      avgR: Number(s.avgR),
      winRate: Number.isFinite(Number(s.winRate)) ? Number(s.winRate) : null
    });
  }
  return rows.sort((a,b) => b.avgR - a.avgR);
}

function learningReport(state, opts = {}) {
  const s = summary(state, { firstOnly: true });
  const minFilter = Math.max(10, Number(opts.minFilterResolved || 30));
  const minGroup = Math.max(5, Number(opts.minGroupResolved || 12));

  let filterStatus = 'INSUFFICIENT';
  let filterDeltaR = null;
  if (s.fullPass.completed >= minFilter && s.filteredOut.completed >= minFilter) {
    filterDeltaR = Number(s.fullPass.avgR) - Number(s.filteredOut.avgR);
    if (filterDeltaR >= 0.15) filterStatus = 'FILTERS_SUPPORTED';
    else if (filterDeltaR <= -0.15) filterStatus = 'FILTERS_QUESTIONED';
    else filterStatus = 'NO_CLEAR_DIFFERENCE';
  }

  const groups = [
    ...rankGroupStats(s.bySymbol, minGroup).map(x => ({ ...x, dimension: 'SYMBOL' })),
    ...rankGroupStats(s.bySession, minGroup).map(x => ({ ...x, dimension: 'SESSION' })),
    ...rankGroupStats(s.bySide, minGroup).map(x => ({ ...x, dimension: 'SIDE' }))
  ].sort((a,b) => b.avgR - a.avgR);

  const strongest = groups.filter(x => x.avgR > 0).slice(0, 3);
  const weakest = [...groups].sort((a,b) => a.avgR - b.avgR).filter(x => x.avgR < 0).slice(0, 3);

  let suggestedTest = {
    type: 'COLLECT_MORE',
    label: '继续收集样本',
    reason: '目前没有足够证据支持改 Live。'
  };

  if (filterStatus === 'FILTERS_QUESTIONED') {
    suggestedTest = {
      type: 'TEST_FILTERS',
      label: '影子测试更宽松的过滤',
      reason: '在当前观察样本中，被过滤掉的突破表现不差于全部条件通过的突破。'
    };
  } else if (weakest[0] && weakest[0].completed >= minGroup && weakest[0].avgR <= -0.15) {
    suggestedTest = {
      type: 'TEST_EXCLUSION',
      label: `影子测试排除 ${weakest[0].key}`,
      reason: `${weakest[0].dimension} ${weakest[0].key} 当前完成样本 ${weakest[0].completed}，平均 ${weakest[0].avgR.toFixed(2)}R。`,
      candidate: weakest[0]
    };
  } else if (filterStatus === 'FILTERS_SUPPORTED') {
    suggestedTest = {
      type: 'KEEP_FILTERS',
      label: '暂时保留现有过滤',
      reason: '当前观察样本中，全部条件通过的组表现更好；暂时没有理由动 Live。'
    };
  }

  const rawDone = Number(s.raw.completed || 0);
  const status = rawDone < minFilter
    ? 'COLLECTING'
    : ['TEST_FILTERS','TEST_EXCLUSION'].includes(suggestedTest.type)
      ? 'READY_FOR_SHADOW_TEST'
      : 'NO_CHANGE_NEEDED';

  return {
    status,
    firstOnly: true,
    raw: s.raw,
    fullPass: s.fullPass,
    filteredOut: s.filteredOut,
    filterStatus,
    filterDeltaR,
    strongest,
    weakest,
    suggestedTest,
    minFilterResolved: minFilter,
    minGroupResolved: minGroup,
    note: 'Observational only. No live rule changes are made automatically.'
  };
}

function maxDrawdownR(values) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of values || []) {
    equity += Number(r) || 0;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function maxLossStreak(values) {
  let streak = 0;
  let max = 0;
  for (const r of values || []) {
    if (Number(r) < 0) {
      streak += 1;
      max = Math.max(max, streak);
    } else {
      streak = 0;
    }
  }
  return max;
}

function liveHealth(trades, opts = {}) {
  const recentN = Math.max(5, Number(opts.recentN || 20));
  const ordered = [...(trades || [])]
    .sort((a,b) => Number(a.signalAtMs || 0) - Number(b.signalAtMs || 0))
    .map(t => ({ trade: t, r: finalR(t) }))
    .filter(x => Number.isFinite(x.r));

  const rs = ordered.map(x => x.r);
  const recent = rs.slice(-recentN);
  const avg = xs => xs.length ? xs.reduce((a,b) => a + b, 0) / xs.length : null;
  const wr = xs => xs.length ? xs.filter(x => x > 0).length / xs.length : null;

  const allAvgR = avg(rs);
  const recentAvgR = avg(recent);
  const resolved = rs.length;
  let status = 'COLLECTING';
  if (resolved >= 20) {
    if (Number(recentAvgR) >= 0.15) status = 'HEALTHY_SAMPLE';
    else if (Number(recentAvgR) > 0) status = 'WATCH';
    else if (Number(allAvgR) > 0) status = 'WEAKENING_SAMPLE';
    else status = 'WEAK_SAMPLE';
  }

  return {
    status,
    resolved,
    recentN: Math.min(recentN, recent.length),
    allAvgR,
    allWinRate: wr(rs),
    recentAvgR,
    recentWinRate: wr(recent),
    totalR: rs.reduce((a,b) => a + b, 0),
    maxDrawdownR: maxDrawdownR(rs),
    maxLossStreak: maxLossStreak(rs),
    note: 'This is a sample-health view, not a guarantee of future performance.'
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
  learningReport,
  liveHealth,
  rankGroupStats,
  maxDrawdownR,
  maxLossStreak,
  prune
};
