'use strict';

const http = require('node:http');

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = process.env.V2_UPSTREAM || 'https://crypto-signal-publisher-production.up.railway.app/ingest';
const BINANCE = (process.env.BINANCE_PUBLIC_REST || 'https://fapi.binance.com').replace(/\/$/, '');
const MAX_OPEN = Math.max(1, Number(process.env.SHADOW_MAX_OPEN || 8));
const TTL_MS = Math.max(30000, Number(process.env.SHADOW_ENTRY_TTL_MS || 90000));
const RISK_PCT = Number(process.env.SHADOW_RISK_PCT || 1);
const ENTRY_FEE_BPS = Number(process.env.SHADOW_ENTRY_FEE_BPS || 2);
const EXIT_FEE_BPS = Number(process.env.SHADOW_EXIT_FEE_BPS || 5);
const SLIPPAGE_BPS = Number(process.env.SHADOW_EXIT_SLIPPAGE_BPS || 1);
const START_BALANCE = Number(process.env.SHADOW_START_BALANCE || 1000);

const state = {
  startedAt: new Date().toISOString(),
  seen: new Set(),
  accepted: 0,
  blockedSymbol: 0,
  blockedCapacity: 0,
  pending: new Map(),
  open: new Map(),
  closed: [],
  recent: [],
  sourceOpen: new Set(),
  prevSourceOpen: new Set(),
  sourceBalance: null,
  prevSourceBalance: null,
  sourceRById: new Map(),
  errors: [],
  balance: START_BALANCE,
  peak: START_BALANCE,
  maxDD: 0,
  meta: new Map(),
  metaAt: 0,
};

const j = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pushRecent = (event, data = {}) => {
  state.recent.unshift({ ts: new Date().toISOString(), event, ...data });
  if (state.recent.length > 80) state.recent.length = 80;
  console.log('MIRROR_VALIDATION', JSON.stringify(state.recent[0]));
};
const pushError = (where, e) => {
  const row = { ts: Date.now(), where, error: String(e?.message || e) };
  state.errors.push(row);
  state.errors = state.errors.filter(x => Date.now() - x.ts < 86400000);
  console.error('MIRROR_VALIDATION_ERR', JSON.stringify(row));
};

function findTickets(x) {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== 'object') return [];
  for (const k of ['tickets', 'signals', 'data', 'items', 'open']) {
    if (Array.isArray(x[k])) return x[k];
    if (x[k] && typeof x[k] === 'object') {
      const a = findTickets(x[k]);
      if (a.length) return a;
    }
  }
  if (x.id && x.side && (x.symbol || x.instId)) return [x];
  return [];
}

function findCombinedBalance(x, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 5) return null;
  if (Number.isFinite(Number(x.combinedBalance))) return Number(x.combinedBalance);
  for (const v of Object.values(x)) {
    if (v && typeof v === 'object') {
      const b = findCombinedBalance(v, depth + 1);
      if (Number.isFinite(b)) return b;
    }
  }
  return null;
}

function normalizeSymbol(t) {
  const raw = String(t.binanceSymbol || t.instId || t.symbol || t.asset || '')
    .toUpperCase().replace(/[-_/]/g, '');
  const base = raw.replace(/USDTSWAP$/, '').replace(/USDTPERP$/, '').replace(/USDT$/, '');
  return base ? `${base}USDT` : '';
}

function dec(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return Math.max(0, (s.split('.')[1] || '').replace(/0+$/, '').length);
}
function roundStep(v, step) {
  const n = Number(v), s = Number(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
  return Number((Math.round(n / s) * s).toFixed(dec(step)));
}

async function refreshMeta(force = false) {
  if (!force && state.meta.size && Date.now() - state.metaAt < 300000) return;
  const r = await fetch(`${BINANCE}/fapi/v1/exchangeInfo`);
  if (!r.ok) throw new Error(`exchangeInfo ${r.status}`);
  const data = await r.json();
  const m = new Map();
  for (const x of data.symbols || []) {
    if (x.status !== 'TRADING' || x.contractType !== 'PERPETUAL' || x.quoteAsset !== 'USDT') continue;
    const pf = (x.filters || []).find(f => f.filterType === 'PRICE_FILTER') || {};
    if (pf.tickSize) m.set(x.symbol, { tickSize: Number(pf.tickSize) });
  }
  state.meta = m;
  state.metaAt = Date.now();
}

async function book(symbol) {
  const r = await fetch(`${BINANCE}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);
  if (!r.ok) throw new Error(`book ${symbol} ${r.status}`);
  const x = await r.json();
  return { bid: Number(x.bidPrice), ask: Number(x.askPrice) };
}

async function lastPrice(symbol) {
  const r = await fetch(`${BINANCE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!r.ok) throw new Error(`ticker ${symbol} ${r.status}`);
  const x = await r.json();
  return Number(x.price);
}

function hasSymbol(symbol) {
  for (const x of state.pending.values()) if (x.symbol === symbol) return true;
  for (const x of state.open.values()) if (x.symbol === symbol) return true;
  return false;
}

async function trackTicket(t) {
  if (t?.combinedSelected !== true) return;
  const id = String(t.id || '');
  if (!id || state.seen.has(id)) return;
  state.seen.add(id);

  const opened = Date.parse(t.openedAt || 0);
  if (opened > 0 && Date.now() - opened > 120000) {
    pushRecent('STALE_IGNORED', { id });
    return;
  }

  const symbol = normalizeSymbol(t);
  if (!symbol) return;
  if (hasSymbol(symbol)) {
    state.blockedSymbol++;
    pushRecent('BLOCK_SYMBOL', { id, symbol });
    return;
  }
  if (state.pending.size + state.open.size >= MAX_OPEN) {
    state.blockedCapacity++;
    pushRecent('BLOCK_CAPACITY', { id, symbol, maxOpen: MAX_OPEN });
    return;
  }

  await refreshMeta();
  const meta = state.meta.get(symbol);
  if (!meta) {
    pushRecent('BLOCK_UNSUPPORTED', { id, symbol });
    return;
  }

  const side = String(t.side || '').toUpperCase();
  const entry = roundStep(Number(t.entry), meta.tickSize);
  const sl = roundStep(Number(t.sl), meta.tickSize);
  const tp = roundStep(Number(t.tp), meta.tickSize);
  if (![entry, sl, tp].every(Number.isFinite)) return;
  if (side === 'BUY' && !(sl < entry && tp > entry)) return;
  if (side === 'SELL' && !(sl > entry && tp < entry)) return;

  state.pending.set(id, {
    id, symbol, side, setup: String(t.setup || ''), entry, sl, tp,
    receivedAt: Date.now(), expiresAt: Date.now() + TTL_MS,
    sourceOpenedAt: t.openedAt || null,
  });
  state.accepted++;
  pushRecent('SHADOW_PENDING', { id, symbol, side, entry, sl, tp });
}

function inferSourceClosures(newIds, newBalance) {
  const dropped = [...state.prevSourceOpen].filter(id => !newIds.has(id));
  if (dropped.length === 1 && Number.isFinite(state.prevSourceBalance) && Number.isFinite(newBalance) && state.prevSourceBalance > 0) {
    const rawR = ((newBalance / state.prevSourceBalance) - 1) / (RISK_PCT / 100);
    const candidates = [-1, 2, 2.1, 2.2];
    let best = candidates[0];
    for (const c of candidates) if (Math.abs(rawR - c) < Math.abs(rawR - best)) best = c;
    if (Math.abs(rawR - best) <= 0.35) {
      state.sourceRById.set(dropped[0], best);
      pushRecent('SOURCE_CLOSED_INFERRED', { id: dropped[0], sourceR: best, rawR: Number(rawR.toFixed(3)) });
    }
  }
}

async function onIngest(payload, tickets) {
  const selected = tickets.filter(t => t?.combinedSelected === true && t?.id);
  const ids = new Set(selected.map(t => String(t.id)));
  const bal = findCombinedBalance(payload);
  inferSourceClosures(ids, bal);
  state.prevSourceOpen = state.sourceOpen;
  state.sourceOpen = ids;
  state.prevSourceBalance = state.sourceBalance;
  if (Number.isFinite(bal)) state.sourceBalance = bal;
  for (const t of selected) await trackTicket(t);
}

function closeShadow(x, reason) {
  const dist = Math.abs(x.entry - x.sl);
  if (!(dist > 0)) return;
  const slip = SLIPPAGE_BPS / 10000;
  let exit;
  if (reason === 'TP') {
    exit = x.side === 'BUY' ? x.tp * (1 - slip) : x.tp * (1 + slip);
  } else {
    exit = x.side === 'BUY' ? x.sl * (1 - slip) : x.sl * (1 + slip);
  }
  const grossR = x.side === 'BUY' ? (exit - x.entry) / dist : (x.entry - exit) / dist;
  const feeR = ((x.entry * ENTRY_FEE_BPS / 10000) + (Math.abs(exit) * EXIT_FEE_BPS / 10000)) / dist;
  const netR = grossR - feeR;
  const sourceR = state.sourceRById.get(x.id);
  const row = {
    ...x,
    closedAt: Date.now(), reason,
    grossR, feeR, netR,
    sourceR: Number.isFinite(sourceR) ? sourceR : null,
    sourceOutcomeMatch: Number.isFinite(sourceR) ? Math.sign(sourceR) === Math.sign(netR) : null,
  };
  state.closed.push(row);
  state.open.delete(x.id);
  state.balance *= (1 + (RISK_PCT / 100) * netR);
  state.peak = Math.max(state.peak, state.balance);
  const dd = state.peak > 0 ? (state.peak - state.balance) / state.peak * 100 : 0;
  state.maxDD = Math.max(state.maxDD, dd);
  pushRecent('SHADOW_CLOSED', { id: x.id, symbol: x.symbol, reason, netR: Number(netR.toFixed(3)), sourceR: row.sourceR });
}

async function pollShadow() {
  while (true) {
    try {
      const now = Date.now();
      for (const [id, x] of [...state.pending]) {
        if (now > x.expiresAt) {
          state.pending.delete(id);
          pushRecent('SHADOW_NO_FILL', { id, symbol: x.symbol });
          continue;
        }
        try {
          const b = await book(x.symbol);
          const fill = x.side === 'BUY' ? b.ask <= x.entry : b.bid >= x.entry;
          if (fill) {
            state.pending.delete(id);
            state.open.set(id, { ...x, filledAt: Date.now(), fillPrice: x.entry });
            pushRecent('SHADOW_FILLED', { id, symbol: x.symbol, entry: x.entry });
          }
        } catch (e) { pushError('pending:' + x.symbol, e); }
      }

      for (const [id, x] of [...state.open]) {
        try {
          const p = await lastPrice(x.symbol);
          if (!Number.isFinite(p)) continue;
          if (x.side === 'BUY') {
            if (p <= x.sl) closeShadow(x, 'SL');
            else if (p >= x.tp) closeShadow(x, 'TP');
          } else {
            if (p >= x.sl) closeShadow(x, 'SL');
            else if (p <= x.tp) closeShadow(x, 'TP');
          }
        } catch (e) { pushError('open:' + x.symbol, e); }
      }
    } catch (e) { pushError('poll', e); }
    await sleep(1000);
  }
}

function metrics() {
  const c = state.closed;
  const wins = c.filter(x => x.netR > 0).length;
  const losses = c.filter(x => x.netR < 0).length;
  const netR = c.reduce((a, x) => a + x.netR, 0);
  const pos = c.filter(x => x.netR > 0).reduce((a, x) => a + x.netR, 0);
  const neg = Math.abs(c.filter(x => x.netR < 0).reduce((a, x) => a + x.netR, 0));
  const expectancy = c.length ? netR / c.length : null;
  const pf = neg > 0 ? pos / neg : (pos > 0 ? 99 : null);
  const range = c.filter(x => x.setup === 'RANGE_MEAN_REVERSION');
  const rangeExp = range.length ? range.reduce((a, x) => a + x.netR, 0) / range.length : null;
  const comparable = c.filter(x => Number.isFinite(x.sourceR));
  const matchedOutcome = comparable.filter(x => x.sourceOutcomeMatch === true).length;
  const outcomeMatchPct = comparable.length ? matchedOutcome / comparable.length * 100 : null;
  const syncPct = state.seen.size ? state.accepted / state.seen.size * 100 : null;
  const errors24h = state.errors.filter(x => Date.now() - x.ts < 86400000).length;

  const gates = {
    matchedTrades: c.length >= 50,
    sync95: syncPct !== null && syncPct >= 95,
    netExpectancy: expectancy !== null && expectancy > 0.10,
    profitFactor: pf !== null && pf > 1.15,
    maxDD: state.maxDD < 10,
    errors24h: errors24h === 0,
    rangePositive: rangeExp !== null && rangeExp > 0,
  };
  const ready = Object.values(gates).every(Boolean);
  return {
    status: ready ? 'READY' : 'WATCH',
    liveTrading: false,
    startedAt: state.startedAt,
    matchedTrades: c.length,
    wins, losses,
    winRate: c.length ? wins / c.length * 100 : null,
    netR,
    expectancy,
    profitFactor: pf,
    maxDDPct: state.maxDD,
    shadowBalance: state.balance,
    sourceBalance: state.sourceBalance,
    sourceOpen: state.sourceOpen.size,
    shadowPending: state.pending.size,
    shadowOpen: state.open.size,
    maxOpen: MAX_OPEN,
    seenTickets: state.seen.size,
    acceptedTickets: state.accepted,
    ticketSyncPct: syncPct,
    comparableOutcomes: comparable.length,
    outcomeMatchPct,
    rangeClosed: range.length,
    rangeExpectancy: rangeExp,
    errors24h,
    blockedSymbol: state.blockedSymbol,
    blockedCapacity: state.blockedCapacity,
    gates,
    recent: state.recent.slice(0, 30),
    recentClosed: c.slice(-30).reverse().map(x => ({
      id: x.id, symbol: x.symbol, side: x.side, setup: x.setup, reason: x.reason,
      netR: x.netR, sourceR: x.sourceR, match: x.sourceOutcomeMatch,
    })),
    assumptions: {
      riskPct: RISK_PCT,
      entryFeeBps: ENTRY_FEE_BPS,
      exitFeeBps: EXIT_FEE_BPS,
      exitSlippageBps: SLIPPAGE_BPS,
      entryPolicy: 'RESTING EXACT LIMIT UNTIL TTL',
      portfolioPolicy: `MAX_${MAX_OPEN}_ONE_POSITION_PER_SYMBOL`,
    }
  };
}

function dashboardHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Mirror Validation</title><style>
  :root{color-scheme:dark}body{margin:0;background:#0b0d12;color:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}.wrap{max-width:1100px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.badge{padding:8px 12px;border-radius:999px;background:#242a36;font-weight:700}.ready{background:#173a29}.watch{background:#4a3514}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:14px}.card{background:#141821;border:1px solid #252b37;border-radius:14px;padding:14px}.v{font-size:24px;font-weight:800;margin-top:5px}.muted{color:#8f9bad;font-size:12px}.gates{margin-top:14px}.gate{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #232936}.ok{color:#61d095}.no{color:#ffb657}.table{margin-top:14px;overflow:auto}.row{display:grid;grid-template-columns:160px 90px 90px 1fr 80px 80px;gap:8px;padding:8px 0;border-bottom:1px solid #232936;font-size:13px;min-width:650px}h2{font-size:16px;margin-top:20px}a{color:#9ecbff}</style></head><body><div class="wrap"><div class="top"><div><div class="muted">MONEY HUNTER</div><h1 style="margin:3px 0 0;font-size:23px">LIVE MIRROR VALIDATION</h1></div><div id="status" class="badge watch">WATCH</div></div><div class="grid" id="cards"></div><div class="card gates"><b>GO / NO-GO Gates</b><div id="gates"></div></div><h2>Recent matched closes</h2><div class="card table"><div class="row muted"><b>ID</b><b>Symbol</b><b>Result</b><b>Setup</b><b>Net R</b><b>Source R</b></div><div id="rows"></div></div><h2>Notes</h2><div class="card muted">Real-money execution remains OFF. This page validates a synchronized shadow portfolio: max ${MAX_OPEN} open positions, one position per symbol, exact resting entry until expiry, with estimated fees and exit slippage included.</div></div><script>
const f=(x,d=2)=>x==null?'—':Number(x).toFixed(d);async function tick(){try{const r=await fetch('/validation.json',{cache:'no-store'});const x=await r.json();const s=document.getElementById('status');s.textContent=x.status;s.className='badge '+(x.status==='READY'?'ready':'watch');const cards=[['Matched trades',x.matchedTrades],['Ticket sync',x.ticketSyncPct==null?'—':f(x.ticketSyncPct,1)+'%'],['Net expectancy',x.expectancy==null?'—':f(x.expectancy,3)+'R'],['Profit factor',f(x.profitFactor,2)],['Max DD',f(x.maxDDPct,2)+'%'],['Range expectancy',x.rangeExpectancy==null?'—':f(x.rangeExpectancy,3)+'R'],['Outcome match',x.outcomeMatchPct==null?'—':f(x.outcomeMatchPct,1)+'%'],['Shadow balance',f(x.shadowBalance,2)]];document.getElementById('cards').innerHTML=cards.map(([a,b])=>'<div class="card"><div class="muted">'+a+'</div><div class="v">'+b+'</div></div>').join('');document.getElementById('gates').innerHTML=Object.entries(x.gates).map(([k,v])=>'<div class="gate"><span>'+k+'</span><b class="'+(v?'ok':'no')+'">'+(v?'PASS':'WAIT')+'</b></div>').join('');document.getElementById('rows').innerHTML=x.recentClosed.map(z=>'<div class="row"><span>'+z.id.slice(0,22)+'</span><b>'+z.symbol+'</b><span>'+z.reason+'</span><span>'+z.setup+'</span><span>'+f(z.netR,2)+'</span><span>'+(z.sourceR==null?'—':f(z.sourceR,1))+'</span></div>').join('');}catch(e){console.error(e)}}tick();setInterval(tick,2000);
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/validation')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(dashboardHtml());
    }
    if (req.method === 'GET' && req.url === '/validation.json') return j(res, 200, metrics());
    if (req.method === 'GET' && req.url === '/health') return j(res, 200, { ok: true, service: 'synchronized-shadow-validator', status: metrics().status });
    if (req.method === 'POST' && req.url === '/ingest') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload = null;
      try { payload = JSON.parse(raw); } catch {}
      if (payload) {
        const tickets = findTickets(payload);
        await onIngest(payload, tickets);
      }
      let upstreamStatus = null;
      try {
        const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
        upstreamStatus = r.status;
      } catch (e) { pushError('forward', e); }
      return j(res, 200, { ok: true, validator: true, upstreamStatus });
    }
    return j(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    pushError('server', e);
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

pollShadow().catch(e => pushError('pollFatal', e));
server.listen(PORT, '0.0.0.0', () => console.log('SYNCHRONIZED_SHADOW_VALIDATOR_READY', JSON.stringify({ port: PORT, upstream: UPSTREAM, maxOpen: MAX_OPEN, live: false })));
