'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 8000);
const INNER = Number(process.env.ARENA_INNER_PORT || 8001);
const BINANCE = (process.env.BINANCE_PUBLIC_REST || 'https://fapi.binance.com').replace(/\/$/, '');
const FEE = Number(process.env.SHADOW_ENTRY_FEE_BPS || 2);
const EXIT_FEE = Number(process.env.SHADOW_EXIT_FEE_BPS || 5);
const SLIP = Number(process.env.SHADOW_EXIT_SLIPPAGE_BPS || 1);
const FRICTION = FEE + EXIT_FEE + SLIP;
const TTL = Math.max(30000, Number(process.env.SHADOW_ENTRY_TTL_MS || 90000));
const RISK = Number(process.env.SHADOW_RISK_PCT || 1);
const MAX_OPEN = Math.max(1, Number(process.env.SHADOW_MAX_OPEN || 8));
const START = Number(process.env.SHADOW_START_BALANCE || 1000);
const START_MS = Date.now();
const GRAND_PRIZE = Math.max(100000, Number(process.env.ARENA_GRAND_PRIZE_CREDITS || 1000000));

const child = spawn(process.execPath, ['validation_server_v5_adaptive_lab.js'], {
  env: { ...process.env, PORT: String(INNER) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (c, s) => console.error('INNER_V5_EXIT', c, s));

const P = [
  { id: 'TREND_PURE', name: 'Trend Pure', kind: 'pure', allow: ['TREND'], mf: .18, rr: 1.35, min: 25, sr: .10 },
  { id: 'BREAKOUT_PURE', name: 'Breakout Pure', kind: 'pure', allow: ['BREAKOUT'], mf: .15, rr: 1.50, min: 30, sr: .08 },
  { id: 'RANGE_PURE', name: 'Range Pure', kind: 'pure', allow: ['RANGE'], mf: .10, rr: 1.80, min: 60, sr: .06 },
  { id: 'TREND_BREAKOUT_FUSION', name: 'Trend × Breakout Fusion', kind: 'fusion', allow: ['TREND', 'BREAKOUT'], mf: .16, rr: 1.45, min: 25, sr: .08 },
  { id: 'RANGE_TREND_FUSION', name: 'Range × Trend Fusion', kind: 'fusion', allow: ['RANGE', 'TREND'], mf: .13, rr: 1.55, min: 35, sr: .07 },
  { id: 'ALL_STYLE_FUSION', name: 'All-Style Fusion', kind: 'fusion', mf: .14, rr: 1.55, min: 30, sr: .08 },
  { id: 'SPEED_FUSION', name: 'Speed Fusion', kind: 'fusion', mf: .20, rr: 1.25, min: 20, sr: .12 },
  { id: 'DEFENSIVE_FUSION', name: 'Defensive Fusion', kind: 'fusion', mf: .09, rr: 1.90, min: 60, sr: .05 },
  { id: 'REGIME_SWITCHER', name: 'Regime Switcher', kind: 'regime', mf: .15, rr: 1.45, min: 25, sr: .09, regime: true },
  { id: 'REGIME_FUSION', name: 'Adaptive Regime Fusion', kind: 'regime', mf: .16, rr: 1.40, min: 20, sr: .10, regime: true, adaptive: true },
  { id: 'CONSENSUS_3', name: '3-Brain Consensus', kind: 'ensemble', synth: 'CONS', votes: 3 },
  { id: 'CONSENSUS_5', name: '5-Brain Consensus', kind: 'ensemble', synth: 'CONS', votes: 5 },
  { id: 'ELITE_FUSION', name: 'Elite Fusion', kind: 'ensemble', synth: 'ELITE' },
  { id: 'META_FUSION', name: 'Meta Fusion', kind: 'meta', synth: 'META' },
];
const BASE = P.filter(x => !x.synth);
const VOTERS = BASE.map(x => x.id);
const ELITE = ['DEFENSIVE_FUSION', 'REGIME_SWITCHER', 'REGIME_FUSION', 'TREND_BREAKOUT_FUSION', 'RANGE_PURE'];

const S = {
  brains: new Map(), meta: new Map(), metaAt: 0, reg: new Map(), errors: [], seen: new Set(), fresh: new Set(),
  feed: [], lastLeader: null, statusCache: new Map(), marks: new Map(),
};
const mk = p => ({ ...p, seen: new Set(), pending: new Map(), open: new Map(), closed: [], passed: 0, rejected: 0, balance: START, peak: START, dd: 0, reasons: {}, born: Date.now() });
for (const p of P) S.brains.set(p.id, mk(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
function out(res, c, x) { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(x)); }
function pushFeed(type, data = {}, heat = 4) {
  S.feed.unshift({ ts: Date.now(), type, heat, ...data });
  if (S.feed.length > 120) S.feed.length = 120;
  console.log('ARENA_LIVE', JSON.stringify({ type, ...data }));
}
function fail(w, e) { S.errors.push({ t: Date.now(), w, e: String(e?.message || e) }); S.errors = S.errors.filter(x => Date.now() - x.t < 86400000); console.error('OPEN_ARENA_ERR', w, e?.message || e); }
function tickets(x) { if (Array.isArray(x)) return x; if (!x || typeof x !== 'object') return []; for (const k of ['tickets', 'signals', 'data', 'items', 'open']) { if (Array.isArray(x[k])) return x[k]; if (x[k] && typeof x[k] === 'object') { const a = tickets(x[k]); if (a.length) return a; } } if (x.id && x.side && (x.symbol || x.instId)) return [x]; return []; }
function sym(t) { const r = String(t.binanceSymbol || t.instId || t.symbol || t.asset || '').toUpperCase().replace(/[-_/]/g, ''), b = r.replace(/USDTSWAP$/, '').replace(/USDTPERP$/, '').replace(/USDT$/, ''); return b ? b + 'USDT' : ''; }
function fam(x) { x = String(x || '').toUpperCase(); if (x.includes('RANGE') || x.includes('MEAN_REVERSION') || x.includes('SWEEP')) return 'RANGE'; if (x.includes('BREAKOUT') || x.includes('RETEST')) return 'BREAKOUT'; if (x.includes('TREND') || x.includes('PULLBACK') || x.includes('RECLAIM')) return 'TREND'; return 'OTHER'; }
function geom(t) { const e = +t.entry, s = +t.sl, p = +t.tp, d = String(t.side || '').toUpperCase(); if (![e, s, p].every(Number.isFinite) || e <= 0) return null; if (d === 'BUY' && !(s < e && p > e) || d === 'SELL' && !(s > e && p < e) || !['BUY', 'SELL'].includes(d)) return null; const rb = Math.abs(e - s) / e * 1e4, wb = Math.abs(p - e) / e * 1e4; if (!(rb > 0 && wb > 0)) return null; return { e, s, p, d, rb, wb, fr: FRICTION / rb, nrr: (wb - FRICTION) / (rb + FRICTION) }; }
async function meta() { if (S.meta.size && Date.now() - S.metaAt < 3e5) return; const r = await fetch(BINANCE + '/fapi/v1/exchangeInfo'), j = await r.json(), m = new Map(); for (const x of j.symbols || []) { if (x.status !== 'TRADING' || x.contractType !== 'PERPETUAL' || x.quoteAsset !== 'USDT') continue; const f = (x.filters || []).find(q => q.filterType === 'PRICE_FILTER'); if (f) m.set(x.symbol, +f.tickSize); } S.meta = m; S.metaAt = Date.now(); }
async function book(s) { const r = await fetch(BINANCE + '/fapi/v1/ticker/bookTicker?symbol=' + encodeURIComponent(s)); if (!r.ok) throw new Error('book_' + s + '_' + r.status); const x = await r.json(); return { b: +x.bidPrice, a: +x.askPrice }; }
async function price(s) { const r = await fetch(BINANCE + '/fapi/v1/ticker/price?symbol=' + encodeURIComponent(s)); if (!r.ok) throw new Error('price_' + s + '_' + r.status); const x = await r.json(); return +x.price; }
async function regime(s) { const c = S.reg.get(s); if (c && Date.now() - c.t < 18e4) return c; try { const r = await fetch(BINANCE + '/fapi/v1/klines?symbol=' + encodeURIComponent(s) + '&interval=5m&limit=48'), k = await r.json(), cs = k.map(x => +x[4]); let path = 0; for (let i = 1; i < cs.length; i++) path += Math.abs(cs[i] - cs[i - 1]); const er = path ? Math.abs(cs.at(-1) - cs[0]) / path : 0, rs = []; for (let i = 1; i < cs.length; i++) rs.push(Math.log(cs[i] / cs[i - 1]) * 1e4); const av = rs.reduce((a, b) => a + b, 0) / (rs.length || 1), vol = Math.sqrt(rs.reduce((a, x) => a + (x - av) ** 2, 0) / Math.max(1, rs.length - 1)); let l = 'MIXED'; if (er >= .35) l = 'TREND'; else if (er <= .18) l = 'RANGE'; else if (vol >= 35) l = 'VOLATILE'; const z = { t: Date.now(), l, er, vol }; S.reg.set(s, z); return z; } catch (e) { fail('regime', e); return { t: Date.now(), l: 'UNKNOWN' }; } }
function regOK(f, r) { if (!r || ['UNKNOWN', 'MIXED'].includes(r.l)) return true; if (r.l === 'TREND') return ['TREND', 'BREAKOUT', 'OTHER'].includes(f); if (r.l === 'RANGE') return ['RANGE', 'OTHER'].includes(f); if (r.l === 'VOLATILE') return ['BREAKOUT', 'TREND', 'OTHER'].includes(f); return true; }
function gate(p, t, sp, r) { const f = fam(t.setup); if (p.allow && !p.allow.includes(f)) return { pass: false, why: 'FAMILY' }; const g = geom(t); if (!g) return { pass: false, why: 'GEOMETRY' }; if (p.regime && !regOK(f, r)) return { pass: false, why: 'REGIME' }; let mf = p.mf, rr = p.rr, mn = p.min, sr = p.sr; if (p.adaptive) { if (r?.l === 'TREND') { mf += .02; rr -= .1; } else if (r?.l === 'RANGE') { mf -= .02; rr += .15; mn = Math.max(mn, 50); } else if (r?.l === 'VOLATILE') { mn = Math.max(mn, 50); sr = Math.min(sr, .07); } } const spr = Number.isFinite(sp) ? sp / g.rb : null; if (g.rb < mn) return { pass: false, why: 'NARROW' }; if (g.fr > mf) return { pass: false, why: 'COST' }; if (g.nrr < rr) return { pass: false, why: 'RR' }; if (!Number.isFinite(spr) || spr > sr) return { pass: false, why: 'SPREAD' }; return { pass: true, why: 'PASS', f, ...g, spr }; }
function has(b, s) { for (const x of b.pending.values()) if (x.s === s) return true; for (const x of b.open.values()) if (x.s === s) return true; return false; }
function round(v, step) { return Math.round(v / step) * step; }
async function track(b, t, g) {
  const id = String(t.id || ''); if (!id || b.seen.has(id)) return; b.seen.add(id);
  if (!g.pass) { b.rejected++; b.reasons[g.why] = (b.reasons[g.why] || 0) + 1; return; }
  b.passed++;
  const s = sym(t); if (!s || has(b, s) || b.pending.size + b.open.size >= MAX_OPEN) return;
  await meta(); const stp = S.meta.get(s); if (!stp) return;
  const d = String(t.side).toUpperCase(), e = round(+t.entry, stp), sl = round(+t.sl, stp), tp = round(+t.tp, stp);
  if (d === 'BUY' && !(sl < e && tp > e) || d === 'SELL' && !(sl > e && tp < e)) return;
  b.pending.set(id, { id, s, d, e, sl, tp, setup: String(t.setup || ''), until: Date.now() + TTL, placedAt: Date.now() });
  pushFeed('ORDER_PLACED', { brain: b.name, brainId: b.id, symbol: s, side: d, entry: e, sl, tp }, 3);
}
function streak(b, positive) { let n = 0; for (let i = b.closed.length - 1; i >= 0; i--) { if ((b.closed[i].nr > 0) === positive) n++; else break; } return n; }
function close(b, x, why) {
  const dist = Math.abs(x.e - x.sl), q = SLIP / 1e4;
  const ex = why === 'TP' ? (x.d === 'BUY' ? x.tp * (1 - q) : x.tp * (1 + q)) : (x.d === 'BUY' ? x.sl * (1 - q) : x.sl * (1 + q));
  const gross = x.d === 'BUY' ? (ex - x.e) / dist : (x.e - ex) / dist;
  const fee = (x.e * FEE / 1e4 + Math.abs(ex) * EXIT_FEE / 1e4) / dist;
  const nr = gross - fee;
  b.closed.push({ ...x, why, nr, closedAt: Date.now() }); b.open.delete(x.id);
  b.balance *= 1 + RISK / 100 * nr; b.peak = Math.max(b.peak, b.balance); b.dd = Math.max(b.dd, (b.peak - b.balance) / b.peak * 100);
  const ws = streak(b, true), ls = streak(b, false);
  pushFeed(why === 'TP' ? 'TAKE_PROFIT' : 'STOP_LOSS', { brain: b.name, brainId: b.id, symbol: x.s, side: x.d, netR: Number(nr.toFixed(3)), winStreak: ws, lossStreak: ls }, why === 'TP' ? 12 : 8);
  if (ws >= 3) pushFeed('HOT_STREAK', { brain: b.name, brainId: b.id, streak: ws }, 10);
  if (ls >= 3) pushFeed('DANGER_STREAK', { brain: b.name, brainId: b.id, streak: ls }, 7);
}
function st(b) {
  const c = b.closed, n = c.length, w = c.filter(x => x.nr > 0).length, losses = c.filter(x => x.nr < 0).length;
  const net = c.reduce((a, x) => a + x.nr, 0), pos = c.filter(x => x.nr > 0).reduce((a, x) => a + x.nr, 0), neg = Math.abs(c.filter(x => x.nr < 0).reduce((a, x) => a + x.nr, 0));
  const ex = n ? net / n : null, pf = neg ? pos / neg : (pos ? 99 : null); let lcb = null;
  if (n > 1) { const sd = Math.sqrt(c.reduce((a, x) => a + (x.nr - ex) ** 2, 0) / (n - 1)); lcb = ex - 1.282 * sd / Math.sqrt(n); }
  const proven = n >= 50 && ex > .1 && pf > 1.15 && b.dd < 10 && lcb > 0;
  const prom = n >= 20 && ex > .1 && pf > 1.15 && b.dd < 10;
  const failing = n >= 20 && (ex <= 0 || pf < .9 || b.dd >= 15);
  const status = proven ? 'PROVEN' : failing ? 'FAILING' : prom ? 'PROMISING' : 'LEARNING';
  const proof = 100 * (.4 * clamp(n / 50) + .22 * (ex == null ? 0 : clamp((ex + .1) / .25)) + .14 * (pf == null ? 0 : clamp((pf - .8) / .5)) + .1 * clamp((15 - b.dd) / 10) + .14 * (lcb == null ? 0 : clamp((lcb + .05) / .15)));
  const score = n < 5 ? -999 : (lcb ?? ex ?? -9) * Math.min(1, n / 30) + .025 * Math.log1p(n) - Math.max(0, b.dd - 10) * .02;
  return { id: b.id, name: b.name, kind: b.kind, trades: n, wins: w, losses, netR: net, expectancy: ex, profitFactor: pf, maxDDPct: b.dd, lcb90: lcb, status, proofProgress: proof, evidenceScore: score, balance: b.balance, pending: b.pending.size, open: b.open.size, passed: b.passed, rejected: b.rejected };
}
function economy(x) {
  const n = Number(x.trades || 0), net = Number(x.netR || 0), dd = Number(x.maxDDPct || 0), proof = Number(x.proofProgress || 0), pf = Number(x.profitFactor || 0), exp = Number(x.expectancy || 0);
  const reward = Math.max(0, net) * 9000 + Number(x.wins || 0) * 700 + proof * 450 + (x.status === 'PROMISING' ? 50000 : 0) + (x.status === 'PROVEN' ? 300000 : 0);
  const penalty = Math.max(0, -net) * 11000 + dd * 2200 + (n >= 20 && exp <= 0 ? 30000 : 0) + (x.status === 'FAILING' ? 65000 : 0) + (n >= 20 && pf > 0 && pf < .9 ? 25000 : 0);
  const credits = Math.max(0, 100000 + reward - penalty);
  let arenaState = 'WAITING';
  if (x.status === 'PROVEN') arenaState = 'CROWN CONTENDER';
  else if (n >= 50 && (exp <= 0 || (pf > 0 && pf < .9) || dd >= 20)) arenaState = 'ELIMINATED';
  else if (x.status === 'FAILING' || dd >= 12) arenaState = 'DANGER ZONE';
  else if (x.status === 'PROMISING') arenaState = 'HOT';
  else if (Number(x.open || 0) > 0) arenaState = 'FIGHTING';
  else if (Number(x.pending || 0) > 0) arenaState = 'STALKING';
  const evidence = Number.isFinite(x.evidenceScore) ? x.evidenceScore : -999;
  const battleScore = evidence * 120 + proof * .65 + Math.log10(credits + 10) * 8 + Math.min(25, n) * .25 - dd * .8;
  const selectionPower = arenaState === 'ELIMINATED' ? -9999 : battleScore;
  return { rewardCredits: Math.round(reward), penaltyCredits: Math.round(penalty), credits: Math.round(credits), arenaState, battleScore, selectionPower };
}
function extraRank() { return [...S.brains.values()].map(st).map(x => ({ ...x, ...economy(x) })).sort((a, b) => b.selectionPower - a.selectionPower || b.proofProgress - a.proofProgress); }
function metaPick() { return extraRank().filter(x => !['CONSENSUS_3', 'CONSENSUS_5', 'ELITE_FUSION', 'META_FUSION'].includes(x.id) && x.trades >= 10 && x.arenaState !== 'ELIMINATED' && x.status !== 'FAILING')[0]?.id || 'ALL_STYLE_FUSION'; }
async function ingestLocal(payload) {
  const a = tickets(payload).filter(x => x?.combinedSelected === true && x?.id); if (!a.length) return; await meta();
  for (const t of a) {
    const id = String(t.id), op = Date.parse(t.openedAt || 0), fresh = !(op > 0 && op < START_MS); S.seen.add(id); if (fresh) S.fresh.add(id);
    const s = sym(t); let bk = null, r = null; try { bk = await book(s); r = await regime(s); } catch (e) { fail('market', e); }
    const sp = bk && bk.a > 0 && bk.b > 0 ? (bk.a - bk.b) / ((bk.a + bk.b) / 2) * 1e4 : null, base = new Map();
    for (const p of BASE) { const b = S.brains.get(p.id); if (b.seen.has(id)) continue; const g = fresh ? gate(p, t, sp, r) : { pass: false, why: 'PRE' }; base.set(p.id, g); await track(b, t, g); }
    for (const p of P.filter(x => x.synth)) {
      const b = S.brains.get(p.id); if (b.seen.has(id)) continue; let g;
      if (!fresh) g = { pass: false, why: 'PRE' };
      else if (p.synth === 'CONS') { const v = VOTERS.filter(k => base.get(k)?.pass).length; g = { pass: v >= p.votes, why: 'VOTES', v }; }
      else if (p.synth === 'ELITE') { const v = ELITE.filter(k => base.get(k)?.pass).length; g = { pass: v >= 3, why: 'ELITE', v }; }
      else { const k = metaPick(); g = base.get(k) || { pass: false, why: 'META_EMPTY' }; }
      await track(b, t, g);
    }
  }
}
async function poll() {
  while (true) {
    try {
      const ps = new Set(), os = new Set(); for (const b of S.brains.values()) { for (const x of b.pending.values()) ps.add(x.s); for (const x of b.open.values()) os.add(x.s); }
      const bs = new Map(), px = new Map();
      await Promise.all([...ps].map(async s => { try { bs.set(s, await book(s)); } catch {} }));
      await Promise.all([...os].map(async s => { try { const p = await price(s); px.set(s, p); S.marks.set(s, p); } catch {} }));
      for (const b of S.brains.values()) {
        for (const [id, x] of [...b.pending]) {
          if (Date.now() > x.until) { b.pending.delete(id); pushFeed('NO_FILL', { brain: b.name, brainId: b.id, symbol: x.s }, 1); continue; }
          const q = bs.get(x.s); if (q && (x.d === 'BUY' ? q.a <= x.e : q.b >= x.e)) { b.pending.delete(id); b.open.set(id, { ...x, filledAt: Date.now(), mark: x.e }); pushFeed('TRADE_OPEN', { brain: b.name, brainId: b.id, symbol: x.s, side: x.d, entry: x.e }, 7); }
        }
        for (const [id, x] of [...b.open]) {
          const p = px.get(x.s); if (!Number.isFinite(p)) continue; x.mark = p;
          if (x.d === 'BUY') { if (p <= x.sl) close(b, x, 'SL'); else if (p >= x.tp) close(b, x, 'TP'); }
          else { if (p >= x.sl) close(b, x, 'SL'); else if (p <= x.tp) close(b, x, 'TP'); }
        }
      }
    } catch (e) { fail('poll', e); }
    await sleep(1000);
  }
}
async function inner(path, init) { const r = await fetch('http://127.0.0.1:' + INNER + path, init); return { status: r.status, text: await r.text() }; }
function livePositions() {
  const rows = [];
  for (const b of S.brains.values()) {
    for (const x of b.open.values()) {
      const mark = Number(x.mark ?? S.marks.get(x.s)); const dist = Math.abs(x.e - x.sl); const uR = Number.isFinite(mark) && dist > 0 ? (x.d === 'BUY' ? (mark - x.e) / dist : (x.e - mark) / dist) : null;
      rows.push({ brainId: b.id, brain: b.name, symbol: x.s, side: x.d, entry: x.e, sl: x.sl, tp: x.tp, mark, unrealizedR: uR, ageSec: Math.floor((Date.now() - (x.filledAt || x.placedAt || Date.now())) / 1000) });
    }
  }
  return rows.sort((a, b) => Math.abs(b.unrealizedR || 0) - Math.abs(a.unrealizedR || 0));
}
function pendingOrders() {
  const rows = [];
  for (const b of S.brains.values()) for (const x of b.pending.values()) rows.push({ brainId: b.id, brain: b.name, symbol: x.s, side: x.d, entry: x.e, sl: x.sl, tp: x.tp, ttlSec: Math.max(0, Math.ceil((x.until - Date.now()) / 1000)) });
  return rows.sort((a, b) => a.ttlSec - b.ttlSec);
}
function applyTransitions(all) {
  for (const x of all) {
    const prev = S.statusCache.get(x.id); const now = x.arenaState + '|' + x.status;
    if (prev && prev !== now) {
      if (x.status === 'PROVEN') pushFeed('BRAIN_PROVEN', { brain: x.name, brainId: x.id, expectancy: x.expectancy, pf: x.profitFactor }, 18);
      else if (x.arenaState === 'ELIMINATED') pushFeed('ELIMINATED', { brain: x.name, brainId: x.id }, 12);
      else if (x.status === 'PROMISING') pushFeed('PROMISING', { brain: x.name, brainId: x.id }, 10);
      else if (x.arenaState === 'DANGER ZONE') pushFeed('DANGER_ZONE', { brain: x.name, brainId: x.id }, 6);
    }
    S.statusCache.set(x.id, now);
  }
}
async function combined() {
  let core = { brains: [], brainCount: 0, generation: 0, sourceFresh: 0 };
  try { core = JSON.parse((await inner('/lab.json')).text); } catch {}
  const coreDecorated = (core.brains || []).map(x => ({ ...x, ...economy(x) }));
  const extras = extraRank();
  const all = [...coreDecorated, ...extras].filter((x, i, a) => a.findIndex(y => y.id === x.id) === i).sort((a, b) => b.selectionPower - a.selectionPower || b.proofProgress - a.proofProgress);
  all.forEach((x, i) => x.rank = i + 1);
  applyTransitions(all);
  const leader = all.find(x => x.id !== 'RAW_CONTROL' && x.trades >= 5) || all.find(x => x.id !== 'RAW_CONTROL') || null;
  if (leader?.id && S.lastLeader && S.lastLeader !== leader.id) pushFeed('LEADER_CHANGE', { brain: leader.name, brainId: leader.id, oldBrainId: S.lastLeader }, 14);
  if (leader?.id) S.lastLeader = leader.id;
  const open = livePositions(), pending = pendingOrders();
  const coreOpen = (core.brains || []).reduce((a, x) => a + Number(x.open || 0), 0), corePending = (core.brains || []).reduce((a, x) => a + Number(x.pending || 0), 0);
  const recentHeat = S.feed.filter(x => Date.now() - x.ts < 180000).reduce((a, x) => a + Number(x.heat || 0), 0);
  const crowdHeat = Math.round(clamp((open.length + coreOpen) * 9 + (pending.length + corePending) * 3 + recentHeat / 3, 0, 100));
  const top3 = all.filter(x => x.id !== 'RAW_CONTROL').slice(0, 3);
  const prizeProjection = top3.map((x, i) => ({ rank: i + 1, brain: x.name, credits: Math.round(GRAND_PRIZE * [0.60, 0.25, 0.15][i]) }));
  return {
    status: all.some(x => x.status === 'PROVEN') ? 'EDGE_PROVEN' : 'BATTLE_LIVE', version: 'OPEN_EDGE_ARENA_V3_BATTLE_ROYALE', liveTrading: false,
    startedAt: new Date(START_MS).toISOString(), leader, brains: all, brainCount: all.length, coreBrains: core.brainCount || 0, fusionBrains: S.brains.size,
    generation: core.generation || 0, sourceFresh: Math.max(core.sourceFresh || 0, S.fresh.size), metaLeader: metaPick(), errors24h: S.errors.length,
    livePositions: open, pendingOrders: pending, coreBusy: (core.brains || []).filter(x => Number(x.open || 0) > 0 || Number(x.pending || 0) > 0).map(x => ({ id: x.id, name: x.name, open: Number(x.open || 0), pending: Number(x.pending || 0) })),
    totalOpen: open.length + coreOpen, totalPending: pending.length + corePending, crowdHeat, grandPrizeCredits: GRAND_PRIZE, prizeProjection,
    rewardRule: 'Selection power rises with net R, proof progress, PF and low drawdown. Failing brains lose credits and promotion power; eliminated brains cannot lead Meta Fusion. Risk rules never loosen for points.',
    feed: S.feed.slice(0, 60),
  };
}
function page() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Money Hunter Battle Royale</title><style>
  :root{color-scheme:dark;--bg:#050912;--card:#0d1624;--line:#22334b;--muted:#8fa3bd;--good:#58ef9a;--bad:#ff7070;--gold:#ffd86b;--cyan:#61dfff;--violet:#a992ff}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#101b31 0,#050912 48%);color:#eef5ff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}.w{max-width:1280px;margin:auto;padding:14px}.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.live{font-weight:900;color:#ff6666;letter-spacing:.08em}.dot{display:inline-block;width:9px;height:9px;background:#ff4e4e;border-radius:50%;margin-right:6px;box-shadow:0 0 18px #ff4e4e;animation:p 1.2s infinite}@keyframes p{50%{opacity:.35}}h1{margin:4px 0 2px;font-size:28px}.m{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:12px}.c{background:linear-gradient(180deg,#101b2b,#0b1421);border:1px solid var(--line);border-radius:16px;padding:13px;box-shadow:0 8px 30px #0004}.v{font-size:21px;font-weight:900;margin-top:4px}.gold{color:var(--gold)}.good{color:var(--good)}.bad{color:var(--bad)}.cyan{color:var(--cyan)}.pod{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.pod .c{text-align:center}.rank{font-size:30px;font-weight:1000}.table{overflow:auto}.r{display:grid;grid-template-columns:1.75fr .55fr .55fr .65fr .65fr .72fr .82fr;gap:7px;padding:10px 0;border-bottom:1px solid var(--line);font-size:12px;align-items:center;min-width:790px}.tag{display:inline-block;font-size:10px;padding:3px 6px;border-radius:999px;background:#1b2b42;margin-top:3px}.fight{color:#6de5ff}.danger{color:#ff9a72}.elim{color:#ff5c7d}.hot{color:#ffe17a}.pos{display:grid;grid-template-columns:1.35fr .8fr .55fr .75fr .75fr .7fr;gap:7px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px;min-width:690px}.feed{max-height:390px;overflow:auto}.ev{padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}.ticker{margin-top:10px;border:1px solid #3a2f15;background:#151108;border-radius:12px;padding:10px;color:#ffe4a1;white-space:nowrap;overflow:hidden}.ticker span{display:inline-block;animation:scroll 22s linear infinite}@keyframes scroll{from{transform:translateX(100%)}to{transform:translateX(-100%)}}.bar{height:7px;background:#18263a;border-radius:9px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:linear-gradient(90deg,#4dd6ff,#ff5d9e);transition:.4s}.cols{display:grid;grid-template-columns:1fr;gap:10px}.empty{padding:18px;text-align:center;color:var(--muted)}h2{font-size:16px;margin:17px 0 8px}@media(min-width:760px){.grid{grid-template-columns:repeat(4,1fr)}.cols{grid-template-columns:1.25fr .75fr}}@media(max-width:650px){h1{font-size:23px}.pod{grid-template-columns:1fr}.hideM{display:none}}
  </style></head><body><div class="w"><div class="top"><div><div class="m">MONEY HUNTER · BINANCE-REALISTIC SHADOW</div><h1>🏟️ BRAIN BATTLE ROYALE</h1><div class="m">24+ brains · specialists · fusion · regime · consensus · meta · mutants</div></div><div><div class="live"><span class="dot"></span>LIVE</div><div class="m">REAL MONEY OFF</div></div></div><div class="ticker"><span id="ticker">Waiting for the next fight…</span></div><div class="grid" id="cards"></div><h2>🏆 Podium & Grand Prize</h2><div class="pod" id="pod"></div><div class="cols"><div><h2>⚔️ Live Fight Board — who is actually trading</h2><div class="c table"><div class="pos m"><b>Brain</b><b>Symbol</b><b>Side</b><b>Entry</b><b>Mark</b><b>Live R</b></div><div id="livepos"></div><div id="corebusy"></div></div><h2>🥊 Full Leaderboard</h2><div class="c table"><div class="r m"><b>Brain</b><b>Open</b><b>Trades</b><b>Exp</b><b>PF</b><b>Credits</b><b>State</b></div><div id="brains"></div></div></div><div><h2>📣 Arena Broadcast</h2><div class="c feed" id="feed"></div><h2>💰 Reward / Punishment</h2><div class="c m"><b class="gold">Grand Prize: 1,000,000 Arena Credits</b><br><br>Rewards: net R, proof progress, wins, strong PF, low drawdown and PROVEN status.<br><br>Penalties: negative net R, drawdown, weak PF and FAILING status. ELIMINATED brains lose promotion power and cannot lead Meta Fusion.<br><br><b>Important:</b> these are simulated competition credits. Pressure changes selection priority — never leverage, position size, SL or TP.</div></div></div></div><script>
  const f=(x,d=2)=>x==null||!Number.isFinite(Number(x))?'—':Number(x).toFixed(d), money=x=>Number(x||0).toLocaleString();
  const stateClass=s=>s==='CROWN CONTENDER'||s==='HOT'?'hot':s==='DANGER ZONE'?'danger':s==='ELIMINATED'?'elim':s==='FIGHTING'?'fight':'';
  function eventText(e){const t=new Date(e.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});if(e.type==='TRADE_OPEN')return t+' ⚔️ '+e.brain+' OPEN '+e.side+' '+e.symbol+' @ '+e.entry;if(e.type==='TAKE_PROFIT')return t+' 🟢 '+e.brain+' TP '+e.symbol+' '+f(e.netR,2)+'R';if(e.type==='STOP_LOSS')return t+' 🔴 '+e.brain+' SL '+e.symbol+' '+f(e.netR,2)+'R';if(e.type==='ORDER_PLACED')return t+' 🎯 '+e.brain+' hunting '+e.symbol;if(e.type==='NO_FILL')return t+' ⌛ '+e.brain+' no-fill '+e.symbol;if(e.type==='HOT_STREAK')return t+' 🔥 '+e.brain+' '+e.streak+'-win streak';if(e.type==='DANGER_STREAK')return t+' ⚠️ '+e.brain+' '+e.streak+' losses in a row';if(e.type==='LEADER_CHANGE')return t+' 👑 NEW #1 '+e.brain;if(e.type==='BRAIN_PROVEN')return t+' 🏆 '+e.brain+' is PROVEN';if(e.type==='PROMISING')return t+' 🚀 '+e.brain+' became PROMISING';if(e.type==='ELIMINATED')return t+' ☠️ '+e.brain+' ELIMINATED';if(e.type==='DANGER_ZONE')return t+' 🚨 '+e.brain+' entered DANGER ZONE';return t+' '+e.type+' '+(e.brain||'');}
  async function go(){try{const x=await fetch('/arena.json?'+Date.now(),{cache:'no-store'}).then(r=>r.json()),L=x.leader||{};document.getElementById('cards').innerHTML=[['👑 #1',L.name||'Learning'],['⚔️ Open now',x.totalOpen],['🎯 Pending',x.totalPending],['🔥 Crowd heat',x.crowdHeat+'/100'],['🧠 Brains',x.brainCount],['📊 Fresh tickets',x.sourceFresh],['🧬 Generation',x.generation],['🎛️ Meta follows',x.metaLeader]].map(z=>'<div class="c"><div class="m">'+z[0]+'</div><div class="v">'+z[1]+'</div></div>').join('');
  const prize=[.60,.25,.15];const top=x.brains.filter(q=>q.id!=='RAW_CONTROL').slice(0,3);document.getElementById('pod').innerHTML=top.map((q,i)=>'<div class="c"><div class="rank">'+['🥇','🥈','🥉'][i]+'</div><b>'+q.name+'</b><div class="m">'+q.arenaState+' · '+q.trades+' trades</div><div class="v gold">'+money(x.grandPrizeCredits*prize[i])+'</div><div class="m">projected prize credits</div></div>').join('');
  const pos=x.livePositions||[];document.getElementById('livepos').innerHTML=pos.length?pos.map(p=>'<div class="pos"><div><b>'+p.brain+'</b></div><div>'+p.symbol+'</div><div class="'+(p.side==='BUY'?'good':'bad')+'">'+p.side+'</div><div>'+f(p.entry,6)+'</div><div>'+f(p.mark,6)+'</div><div class="'+(p.unrealizedR>0?'good':p.unrealizedR<0?'bad':'')+'">'+f(p.unrealizedR,2)+'R</div></div>').join(''):'<div class="empty">No extra-arena positions open right now.</div>';
  const cb=x.coreBusy||[];document.getElementById('corebusy').innerHTML=cb.length?'<div class="m" style="padding-top:10px"><b>Core brains active:</b> '+cb.map(q=>q.name+' ('+q.open+' open / '+q.pending+' pending)').join(' · ')+'</div>':'';
  document.getElementById('brains').innerHTML=x.brains.filter(q=>q.id!=='RAW_CONTROL').map((q,i)=>'<div class="r"><div><b>#'+(i+1)+' '+q.name+'</b><div class="m">'+(q.kind||'core')+' · '+q.status+'</div></div><div class="cyan">'+(q.open||0)+'</div><div>'+q.trades+'</div><div class="'+(q.expectancy>0?'good':q.expectancy<0?'bad':'')+'">'+f(q.expectancy,2)+'R</div><div>'+f(q.profitFactor,2)+'</div><div class="gold">'+money(q.credits)+'</div><div class="'+stateClass(q.arenaState)+'"><b>'+q.arenaState+'</b><div class="bar"><i style="width:'+Math.min(100,q.proofProgress||0)+'%"></i></div></div></div>').join('');
  const ev=x.feed||[];document.getElementById('feed').innerHTML=ev.length?ev.slice(0,35).map(e=>'<div class="ev">'+eventText(e)+'</div>').join(''):'<div class="empty">Broadcast waiting for action…</div>';document.getElementById('ticker').textContent=ev.length?ev.slice(0,5).map(eventText).join('   •   '):'Waiting for the next fight…';}catch(e){document.getElementById('ticker').textContent='Arena reconnecting…'}}go();setInterval(go,1800);
  </script></body></html>`;
}

poll();
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/health') return out(res, 200, { ok: true, version: 'OPEN_EDGE_ARENA_V3_BATTLE_ROYALE', live: false, child: child.pid });
    if (req.method === 'GET' && (u.pathname === '/arena.json' || u.pathname === '/validation.json')) return out(res, 200, await combined());
    if (req.method === 'POST' && u.pathname === '/ingest') {
      let s = ''; for await (const c of req) s += c; let p; try { p = JSON.parse(s); } catch { return out(res, 400, { ok: false }); }
      await ingestLocal(p); const q = await inner('/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: s });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, inner: q.status }));
    }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page()); }
    return out(res, 404, { ok: false });
  } catch (e) { fail('server', e); return out(res, 500, { ok: false, error: String(e?.message || e) }); }
}).listen(PORT, '0.0.0.0', () => console.log('OPEN_EDGE_ARENA_V3_BATTLE_ROYALE_READY', JSON.stringify({ port: PORT, inner: INNER, live: false, fusionBrains: S.brains.size, grandPrizeCredits: GRAND_PRIZE })));
