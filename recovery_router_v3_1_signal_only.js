// Combined Edge -> execution recovery router (signal-only)
// This module never submits orders. It only decides which execution route best preserves edge.

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function economics({ entry, sl, tp, pWin, entryFee, tpFee, slFee, entrySlip = 0, tpSlip = 0, slSlip = 0 }) {
  const dist = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!(dist > 0 && reward > 0)) return { valid: false, netRR: -Infinity, netEVR: -Infinity };

  const lossCost = dist + entry * (entryFee + entrySlip) + sl * (slFee + slSlip);
  const netReward = reward - entry * (entryFee + entrySlip) - tp * (tpFee + tpSlip);
  const netRR = netReward > 0 && lossCost > 0 ? netReward / lossCost : -Infinity;
  const netEVR = Number.isFinite(netRR) ? pWin * netRR - (1 - pWin) : -Infinity;
  return { valid: true, lossCost, netReward, netRR, netEVR };
}

function getWinProb(ticket, fallback = 0.453) {
  for (const k of ['winProb', 'winProbability', 'pWin', 'combinedWinProb', 'edgeProbability', 'probability']) {
    let v = Number(ticket?.[k]);
    if (!Number.isFinite(v)) continue;
    if (v > 1 && v <= 100) v /= 100;
    if (v > 0 && v < 1) return v;
  }
  return fallback;
}

function buildModes(ticket, fees, cfg = {}) {
  const pWin = getWinProb(ticket, cfg.priorWinRate ?? 0.453);
  const slip = (cfg.slippageBpsPerSide ?? 1) / 10000;
  const taker = fees.taker;
  const maker = fees.maker;
  const base = { entry: Number(ticket.entry), sl: Number(ticket.sl), tp: Number(ticket.tp), pWin };

  return {
    pWin,
    takerTaker: economics({ ...base, entryFee: taker, tpFee: taker, slFee: taker, entrySlip: slip, tpSlip: slip, slSlip: slip }),
    makerEntry: economics({ ...base, entryFee: maker, tpFee: taker, slFee: taker, entrySlip: 0, tpSlip: slip, slSlip: slip }),
    makerEntryMakerTP: economics({ ...base, entryFee: maker, tpFee: maker, slFee: taker, entrySlip: 0, tpSlip: 0, slSlip: slip })
  };
}

function selectExecutionRoute(ticket, fees, cfg = {}) {
  const modes = buildModes(ticket, fees, cfg);
  const minEV = cfg.minNetEVR ?? 0;
  const minRR = cfg.minNetRRFloor ?? 0.5;

  const ordered = [
    ['TAKER_IOC', modes.takerTaker],
    ['MAKER_ENTRY', modes.makerEntry],
    ['MAKER_ENTRY_MAKER_TP_SHADOW', modes.makerEntryMakerTP]
  ];

  for (const [name, e] of ordered.slice(0, 2)) {
    if (e.valid && e.netReward > 0 && e.netRR >= minRR && e.netEVR >= minEV) {
      return { action: 'SEND_ONETAP', executionMode: name, economics: e, modes, pWin: modes.pWin };
    }
  }

  // maker+maker TP is deliberately signal/shadow only until live lifecycle handling is proven.
  const makerTp = modes.makerEntryMakerTP;
  if (makerTp.valid && makerTp.netReward > 0 && makerTp.netRR >= minRR && makerTp.netEVR >= minEV) {
    return { action: 'SHADOW_RECOVERABLE', executionMode: 'MAKER_ENTRY_MAKER_TP_SHADOW', economics: makerTp, modes, pWin: modes.pWin };
  }

  const best = ordered
    .filter(([, e]) => Number.isFinite(e.netEVR))
    .sort((a, b) => b[1].netEVR - a[1].netEVR)[0];

  return {
    action: 'BLOCK_ONLY_AFTER_RECOVERY_FAILS',
    executionMode: best?.[0] ?? null,
    economics: best?.[1] ?? null,
    modes,
    pWin: modes.pWin
  };
}

function executionWindow({ signalOpenedAt, now = Date.now(), ttlMs = 120000, makerWaitMs = 25000 }) {
  const opened = Number(new Date(signalOpenedAt).getTime());
  const age = Number.isFinite(opened) ? now - opened : 0;
  const remaining = Math.max(0, ttlMs - age);
  return {
    ageMs: age,
    remainingMs: remaining,
    makerWindowMs: Math.min(makerWaitMs, remaining),
    expired: remaining <= 0
  };
}

function rankVenues(venueQuotes, cfg = {}) {
  const minFill = cfg.minFillProbability ?? 0.8;
  return [...venueQuotes]
    .filter(v => v?.tradable && Number(v.fillProbability ?? 1) >= minFill)
    .map(v => ({
      ...v,
      score: Number(v.netEVR ?? -999) - Number(v.latencyPenaltyR ?? 0) - Number(v.rejectionPenaltyR ?? 0)
    }))
    .sort((a, b) => b.score - a.score);
}

module.exports = { economics, getWinProb, buildModes, selectExecutionRoute, executionWindow, rankVenues };
