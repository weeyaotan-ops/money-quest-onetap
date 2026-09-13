'use strict';

// V4 Combined Edge capture router (SIGNAL / SHADOW ONLY).
// It never submits, cancels, or modifies exchange orders.
// Combined Edge remains authoritative for direction, Entry, SL and TP.

function finite(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function authoritativeCombined(ticket) {
  return !!ticket && ticket.combinedSelected === true && typeof ticket.id === 'string' && ticket.id.length > 0;
}

function ticketWinProb(ticket, fallback = 0.453) {
  for (const k of ['winProb', 'winProbability', 'pWin', 'combinedWinProb', 'edgeProbability', 'probability']) {
    let v = Number(ticket?.[k]);
    if (!Number.isFinite(v)) continue;
    if (v > 1 && v <= 100) v /= 100;
    if (v > 0 && v < 1) return v;
  }
  return fallback;
}

function economics({ entry, sl, tp, pWin, entryFee, tpFee, slFee, entrySlip = 0, tpSlip = 0, slSlip = 0 }) {
  entry = Number(entry); sl = Number(sl); tp = Number(tp); pWin = Number(pWin);
  if (![entry, sl, tp, pWin].every(Number.isFinite) || !(entry > 0) || !(pWin > 0 && pWin < 1)) {
    return { valid: false, netRR: -Infinity, netEVR: -Infinity };
  }
  const dist = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!(dist > 0 && reward > 0)) return { valid: false, netRR: -Infinity, netEVR: -Infinity };

  const lossCost = dist + entry * (entryFee + entrySlip) + sl * (slFee + slSlip);
  const netReward = reward - entry * (entryFee + entrySlip) - tp * (tpFee + tpSlip);
  const netRR = netReward > 0 && lossCost > 0 ? netReward / lossCost : -Infinity;
  const netEVR = Number.isFinite(netRR) ? pWin * netRR - (1 - pWin) : -Infinity;
  return { valid: true, lossCost, netReward, netRR, netEVR, grossRR: reward / dist };
}

function executionWindow(ticket, cfg = {}, now = Date.now()) {
  const opened = Date.parse(ticket?.openedAt || '');
  const ttlMs = Math.max(1, finite(cfg.ttlMs, 90000));
  const makerWaitMs = Math.max(0, finite(cfg.makerWaitMs, 8000));
  const ageMs = Number.isFinite(opened) ? Math.max(0, now - opened) : 0;
  const remainingMs = Math.max(0, ttlMs - ageMs);
  return {
    ageMs,
    remainingMs,
    makerWindowMs: Math.min(makerWaitMs, remainingMs),
    expired: remainingMs <= 0
  };
}

function venueModes(ticket, venue, cfg = {}) {
  const pWin = ticketWinProb(ticket, finite(cfg.priorWinRate, 0.453));
  const slip = finite(venue.slippageBpsPerSide, finite(cfg.slippageBpsPerSide, 1)) / 10000;
  const taker = finite(venue.takerFee, 0.0005);
  const maker = finite(venue.makerFee, 0.0002);
  const base = { entry: ticket.entry, sl: ticket.sl, tp: ticket.tp, pWin };

  return {
    takerTaker: economics({ ...base, entryFee: taker, tpFee: taker, slFee: taker, entrySlip: slip, tpSlip: slip, slSlip: slip }),
    makerEntry: economics({ ...base, entryFee: maker, tpFee: taker, slFee: taker, entrySlip: 0, tpSlip: slip, slSlip: slip }),
    makerEntryMakerTP: economics({ ...base, entryFee: maker, tpFee: maker, slFee: taker, entrySlip: 0, tpSlip: 0, slSlip: slip })
  };
}

function adjustedRouteEV(econ, route, cfg = {}) {
  const fillProbability = clamp(finite(route.fillProbability, 1), 0, 1);
  const opportunityCostR = Math.max(0, finite(route.opportunityCostR, finite(cfg.opportunityCostR, 0.03)));
  const latencyPenaltyR = Math.max(0, finite(route.latencyPenaltyR, 0));
  const rejectionPenaltyR = Math.max(0, finite(route.rejectionPenaltyR, 0));
  if (!econ?.valid || !Number.isFinite(econ.netEVR)) return -Infinity;
  return fillProbability * econ.netEVR - (1 - fillProbability) * opportunityCostR - latencyPenaltyR - rejectionPenaltyR;
}

function buildRoutes(ticket, venues, cfg = {}) {
  const out = [];
  for (const venue of Array.isArray(venues) ? venues : []) {
    if (!venue?.tradable) continue;
    const modes = venueModes(ticket, venue, cfg);
    const modeDefs = [
      ['TAKER_IOC', modes.takerTaker, finite(venue.takerFillProbability, 0.995)],
      ['MAKER_ENTRY', modes.makerEntry, finite(venue.makerEntryFillProbability, finite(venue.fillProbability, 0.8))],
      ['MAKER_ENTRY_MAKER_TP', modes.makerEntryMakerTP, finite(venue.makerRoundTripFillProbability, finite(venue.fillProbability, 0.72))]
    ];

    for (const [mode, econ, fillProbability] of modeDefs) {
      const route = {
        venue: String(venue.name || venue.venue || 'UNKNOWN'),
        mode,
        fillProbability,
        opportunityCostR: finite(venue.opportunityCostR, cfg.opportunityCostR ?? 0.03),
        latencyPenaltyR: finite(venue.latencyPenaltyR, 0),
        rejectionPenaltyR: finite(venue.rejectionPenaltyR, 0),
        economics: econ
      };
      route.adjustedEVR = adjustedRouteEV(econ, route, cfg);
      out.push(route);
    }
  }
  return out;
}

function selectCaptureRoute(ticket, venues, cfg = {}, now = Date.now()) {
  if (!authoritativeCombined(ticket)) {
    return { action: 'BLOCK', reason: 'NOT_AUTHORITATIVE_COMBINED', route: null, routes: [] };
  }

  const side = String(ticket.side || '').toUpperCase();
  const entry = Number(ticket.entry), sl = Number(ticket.sl), tp = Number(ticket.tp);
  if (!['BUY', 'SELL'].includes(side) || ![entry, sl, tp].every(Number.isFinite)) {
    return { action: 'BLOCK', reason: 'INVALID_COMBINED_GEOMETRY', route: null, routes: [] };
  }
  if ((side === 'BUY' && !(sl < entry && tp > entry)) || (side === 'SELL' && !(sl > entry && tp < entry))) {
    return { action: 'BLOCK', reason: 'INVALID_COMBINED_GEOMETRY', route: null, routes: [] };
  }

  const window = executionWindow(ticket, cfg, now);
  if (window.expired) return { action: 'BLOCK', reason: 'TICKET_EXPIRED', route: null, routes: [], window };

  const minNetRR = finite(cfg.minNetRRFloor, 0.5);
  const minAdjustedEVR = finite(cfg.minAdjustedEVR, 0);
  const minFillProbability = clamp(finite(cfg.minFillProbability, 0.65), 0, 1);

  const routes = buildRoutes(ticket, venues, cfg)
    .filter(r => r.economics.valid)
    .sort((a, b) => b.adjustedEVR - a.adjustedEVR);

  const route = routes.find(r =>
    r.fillProbability >= minFillProbability &&
    r.economics.netReward > 0 &&
    r.economics.netRR >= minNetRR &&
    r.adjustedEVR >= minAdjustedEVR
  );

  if (!route) {
    return { action: 'BLOCK_AFTER_RECOVERY_FAILS', reason: 'NO_ROUTE_PRESERVES_EDGE', route: null, routes, window };
  }

  return {
    action: 'SEND_ONETAP_SIGNAL',
    reason: 'BEST_EDGE_PRESERVING_ROUTE',
    route,
    routes,
    window,
    combined: { id: ticket.id, side, entry, sl, tp, setup: ticket.setup || '' }
  };
}

function captureRatio(actualR, theoreticalCombinedR) {
  const a = Number(actualR), t = Number(theoreticalCombinedR);
  if (!Number.isFinite(a) || !Number.isFinite(t) || t === 0) return null;
  return a / t;
}

module.exports = {
  authoritativeCombined,
  ticketWinProb,
  economics,
  executionWindow,
  venueModes,
  adjustedRouteEV,
  buildRoutes,
  selectCaptureRoute,
  captureRatio
};
