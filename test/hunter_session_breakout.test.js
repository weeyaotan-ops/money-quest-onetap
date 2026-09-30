'use strict';

const assert = require('assert');
const { evaluateSession, evaluateShadowCandidate, localParts } = require('../hunter_core_v1/session_breakout_monitor');
const shadow = require('../hunter_core_v1/session_breakout_shadow');
const { inspectSession, correlationWarnings, sessionClocks, structureAssessment } = require('../hunter_core_v1/session_breakout_check');

function m15(openTime, o, h, l, c, volume = 100) {
  return { openTime, open: o, high: h, low: l, close: c, volume };
}

function trend4h({ bearish = false, endTime }) {
  const out = [];
  let px = bearish ? 200 : 100;
  const step = bearish ? -0.5 : 0.5;
  for (let i = 0; i < 60; i += 1) {
    px += step;
    out.push({ openTime: endTime - (60 - i) * 4 * 3600_000, open: px - step, high: px + 1, low: px - 1, close: px, volume: 1000 });
  }
  return out;
}

(function testTimezoneMapping() {
  const london = localParts(Date.parse('2026-09-30T07:00:00Z'), 'Europe/London');
  assert.strictEqual(london.hour, 8);
  const ny = localParts(Date.parse('2026-09-30T13:30:00Z'), 'America/New_York');
  assert.strictEqual(ny.hour, 9);
  assert.strictEqual(ny.minute, 30);
})();

(function testLondonLong() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  c.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  c.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));
  const snap = { symbol: 'ETHUSDT', candles15m: c, candles4h: trend4h({ endTime: Date.parse('2026-09-30T07:30:00Z') }) };
  const s = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'), { tpR: 2, equity: 1000, riskPct: 0.005 });
  assert.ok(s, 'expected London long signal');
  assert.strictEqual(s.side, 'LONG');
  assert.strictEqual(s.boxHigh, 105);
  assert.strictEqual(s.stop, 99);
  assert.strictEqual(s.target, 120);
})();

(function testWickOnlyDoesNotTrigger() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  c.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  c.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 104, 150));
  const snap = { symbol: 'ETHUSDT', candles15m: c, candles4h: trend4h({ endTime: Date.parse('2026-09-30T07:30:00Z') }) };
  const s = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.strictEqual(s, null);
})();

(function testNewYorkShort() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T13:30:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T13:30:00Z'), 100, 102, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T13:45:00Z'), 100, 101, 98, 99, 100));
  c.push(m15(Date.parse('2026-09-30T14:00:00Z'), 99, 100, 96, 97, 150));
  const snap = { symbol: 'BTCUSDT', candles15m: c, candles4h: trend4h({ bearish: true, endTime: Date.parse('2026-09-30T14:00:00Z') }) };
  const s = evaluateSession(snap, 'NEW_YORK', Date.parse('2026-09-30T14:16:00Z'), { tpR: 2 });
  assert.ok(s, 'expected New York short signal');
  assert.strictEqual(s.side, 'SHORT');
  assert.strictEqual(s.boxLow, 98);
  assert.strictEqual(s.stop, 102);
  assert.strictEqual(s.target, 87);
})();


(function testShadowCapturesFilteredOutBreakout() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const c = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) c.push(m15(t, 100, 101, 99, 100, 100));
  c.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  c.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  c.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));

  const snap = {
    symbol: 'ETHUSDT',
    provider: 'TEST',
    candles15m: c,
    candles4h: trend4h({ bearish: true, endTime: Date.parse('2026-09-30T07:30:00Z') })
  };

  const live = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.strictEqual(live, null, 'live signal should be blocked by H4');

  const raw = evaluateShadowCandidate(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(raw, 'shadow must still record raw breakout');
  assert.strictEqual(raw.side, 'LONG');
  assert.strictEqual(raw.vwapPass, true);
  assert.strictEqual(raw.h4Pass, false);
  assert.strictEqual(raw.fullPass, false);
  assert.strictEqual(raw.firstBreakout, true);
})();

(function testShadowTracksCounterfactualOutcome() {
  const state = {};
  const candidate = {
    key: 'SHADOW|BTCUSDT|LONDON|2026-09-30|LONG|1',
    symbol: 'BTCUSDT',
    provider: 'TEST',
    session: 'LONDON',
    sessionLabel: 'London',
    side: 'LONG',
    candleOpenTime: 1_000_000,
    candleCloseTime: 1_900_000,
    entry: 100,
    stop: 95,
    vwapPass: false,
    h4Pass: true,
    fullPass: false,
    firstBreakout: true
  };
  assert.strictEqual(shadow.registerCandidate(state, candidate), true);
  assert.strictEqual(shadow.registerCandidate(state, candidate), false, 'duplicate must not be added');

  const t = state.shadow.trades[candidate.key];
  const next = [{ openTime: candidate.candleOpenTime + 15 * 60_000, high: 111, low: 99, close: 110 }];
  assert.strictEqual(shadow.updateTrade(t, next), true);
  assert.strictEqual(t.status, 'TP2');
  assert.strictEqual(t.terminal, true);

  const s = shadow.summary(state);
  assert.strictEqual(s.raw.n, 1);
  assert.strictEqual(s.raw.completed, 1);
  assert.strictEqual(s.raw.avgR, 2);
  assert.strictEqual(s.fullPass.n, 0);
  assert.strictEqual(s.filteredOut.n, 1);
  assert.strictEqual(s.filteredOut.avgR, 2);
})();



(function testOldBreakoutIsNotNewSignal() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) bars.push(m15(t, 100, 101, 99, 100, 100));
  bars.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  bars.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  bars.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));
  bars.push(m15(Date.parse('2026-09-30T07:45:00Z'), 106, 110, 105.5, 108, 150));

  const snap = { symbol: 'ETHUSDT', provider: 'OKX', candles15m: bars, candles4h: trend4h({ endTime: Date.parse('2026-09-30T07:45:00Z') }) };
  const live = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T08:01:00Z'));
  assert.strictEqual(live, null, 'old breakout must not become a new signal');

  const status = inspectSession(snap, 'LONDON', Date.parse('2026-09-30T08:01:00Z'));
  assert.ok(['ACTIVE','EXTENDED'].includes(status.status), 'old breakout should be marked active/extended');
  assert.strictEqual(status.fresh, false);
})();

(function testFreshRebreakAfterReentry() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) bars.push(m15(t, 100, 101, 99, 100, 100));
  bars.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  bars.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  bars.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));
  bars.push(m15(Date.parse('2026-09-30T07:45:00Z'), 106, 106.5, 103, 104, 150));
  bars.push(m15(Date.parse('2026-09-30T08:00:00Z'), 104, 109, 103.5, 107, 150));

  const snap = { symbol: 'ETHUSDT', provider: 'OKX', candles15m: bars, candles4h: trend4h({ endTime: Date.parse('2026-09-30T08:00:00Z') }) };
  const live = evaluateSession(snap, 'LONDON', Date.parse('2026-09-30T08:16:00Z'));
  assert.ok(live, 'fresh rebreak after re-entry should signal');
  assert.strictEqual(live.freshBreakout, true);

  const status = inspectSession(snap, 'LONDON', Date.parse('2026-09-30T08:16:00Z'));
  assert.strictEqual(status.status, 'SIGNAL');
  assert.strictEqual(status.fresh, true);
})();



(function testSignalExpiresAfterOneM15() {
  const d0 = Date.parse('2026-09-30T00:00:00Z');
  const bars = [];
  for (let t = d0; t < Date.parse('2026-09-30T07:00:00Z'); t += 15 * 60_000) bars.push(m15(t, 100, 101, 99, 100, 100));
  bars.push(m15(Date.parse('2026-09-30T07:00:00Z'), 100, 105, 99, 103, 100));
  bars.push(m15(Date.parse('2026-09-30T07:15:00Z'), 103, 104, 100, 102, 100));
  bars.push(m15(Date.parse('2026-09-30T07:30:00Z'), 102, 108, 101, 106, 150));

  const snap = { symbol: 'ETHUSDT', provider: 'OKX', candles15m: bars, candles4h: trend4h({ endTime: Date.parse('2026-09-30T07:30:00Z') }) };
  const fresh = inspectSession(snap, 'LONDON', Date.parse('2026-09-30T07:46:00Z'));
  assert.strictEqual(fresh.status, 'SIGNAL');
  assert.strictEqual(fresh.validUntil, Date.parse('2026-09-30T08:00:00Z'));

  const expired = inspectSession(snap, 'LONDON', Date.parse('2026-09-30T08:01:00Z'));
  assert.strictEqual(expired.status, 'EXPIRED');
})();

(function testUsdCorrelationWarning() {
  const warnings = correlationWarnings([
    { symbol: 'EURUSD', side: 'SHORT' },
    { symbol: 'GBPUSD', side: 'SHORT' },
    { symbol: 'USDCHF', side: 'LONG' }
  ]);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].type, 'USD_STRONG');
  assert.strictEqual(warnings[0].symbols.length, 3);
})();

(function testSessionCountdown() {
  const now = Date.parse('2026-09-30T06:55:00Z'); // 07:55 London (BST)
  const clocks = sessionClocks(now);
  const london = clocks.find(x => x.name === 'London');
  assert.ok(london);
  assert.strictEqual(london.phase, 'NEXT');
  assert.ok(london.remainingMs >= 4 * 60_000 && london.remainingMs <= 6 * 60_000);
})();



(function testLearningReportFindsWeakGroupWithoutChangingLive() {
  const state = {};
  shadow.ensureShadow(state);
  for (let i = 0; i < 12; i += 1) {
    state.shadow.trades['sol'+i] = {
      key:'sol'+i, symbol:'SOLUSDT', sessionLabel:'London', side:'SHORT',
      firstBreakout:true, fullPass:true, vwapPass:true, h4Pass:true,
      terminal:true, status:'SL', signalAtMs:1000+i,
      milestones:{ tp1:{hit:false}, tp2:{hit:false}, sl:{hit:true} }
    };
  }
  for (let i = 0; i < 12; i += 1) {
    state.shadow.trades['eth'+i] = {
      key:'eth'+i, symbol:'ETHUSDT', sessionLabel:'New York', side:'LONG',
      firstBreakout:true, fullPass:true, vwapPass:true, h4Pass:true,
      terminal:true, status:'TP2', signalAtMs:2000+i,
      milestones:{ tp1:{hit:true}, tp2:{hit:true}, sl:{hit:false} }
    };
  }
  const r = shadow.learningReport(state, { minFilterResolved: 30, minGroupResolved: 12 });
  assert.strictEqual(r.status, 'COLLECTING');
  assert.ok(r.strongest.some(x => x.key === 'ETHUSDT'));
  assert.ok(r.weakest.some(x => x.key === 'SOLUSDT'));
  assert.strictEqual(r.suggestedTest.type, 'TEST_EXCLUSION');
})();

(function testLiveHealthDetectsRecentWeakeningSample() {
  const trades = [];
  let t = 1;
  for (let i = 0; i < 20; i += 1) {
    trades.push({ signalAtMs:t++, terminal:true, status:'TP2' });
  }
  for (let i = 0; i < 20; i += 1) {
    trades.push({ signalAtMs:t++, terminal:true, status:i < 12 ? 'SL' : 'TP2' });
  }
  const h = shadow.liveHealth(trades, { recentN:20 });
  assert.strictEqual(h.resolved, 40);
  assert.ok(h.allAvgR > 0);
  assert.ok(h.recentAvgR <= 0.2);
  assert.ok(['WATCH','WEAKENING_SAMPLE','HEALTHY_SAMPLE'].includes(h.status));
  assert.ok(h.maxDrawdownR >= 1);
})();

(function testDrawdownAndLossStreakHelpers() {
  assert.strictEqual(shadow.maxLossStreak([2,-1,-1,-1,2,-1]), 3);
  assert.strictEqual(shadow.maxDrawdownR([2,-1,-1,2]), 2);
})();



(function testStructureWarningInCommandCenter() {
  const bars = [];
  const t0 = Date.parse('2026-09-30T00:00:00Z');
  for (let i=0;i<20;i+=1) bars.push(m15(t0+i*15*60_000,100,101,99,100,100));
  const latest = m15(t0+20*15*60_000,100,111,100,110,100);
  const s = structureAssessment(bars, latest, {high:105,low:95}, 'LONG', 110, 95);
  assert.ok(s.warnings.includes('SL 距离很大'));
  assert.ok(s.warnings.includes('2R 目标很远'));
})();

(function testProductionShadowCompatibilityAndTpSlArena() {
  const direct = {};
  for (let i=0;i<30;i+=1) {
    direct['SHADOW|'+i] = {
      key:'SHADOW|'+i,
      symbol:'ETHUSDT',
      sessionLabel:'New York',
      side:'LONG',
      signalAtMs:1000+i,
      filters:{ liveQualified:true, vwapPass:true, h4Pass:true },
      terminal:true,
      status:'TP2',
      milestones:{ tp1:{hit:true}, tp2:{hit:true}, sl:{hit:false} },
      challengers:{
        TP1:{status:'WIN',outcomeR:1},
        TP1_5:{status:'WIN',outcomeR:1.5},
        LIVE_2R:{status:'WIN',outcomeR:2},
        TIGHT75_2R:{status:'LOSS',outcomeR:-1},
        TIGHT50_2R:{status:'LOSS',outcomeR:-1}
      }
    };
  }
  const state={shadow:direct};
  const map=shadow.shadowTradeMap(state);
  assert.strictEqual(Object.keys(map).length,30);
  const s=shadow.summary(state);
  assert.strictEqual(s.raw.n,30);
  assert.strictEqual(s.fullPass.n,30);
  assert.strictEqual(s.vwapPass.n,30);
  assert.strictEqual(s.h4Pass.n,30);
  const learn=shadow.learningReport(state,{minFilterResolved:10,minGroupResolved:5});
  assert.strictEqual(learn.raw.n,30);
  const a=shadow.tpSlArenaSummary(state,30);
  assert.strictEqual(a.variants.find(x=>x.id==='LIVE_2R').resolved,30);
  assert.strictEqual(a.best.id,'LIVE_2R');
})();


console.log('hunter_session_breakout tests: PASS');
