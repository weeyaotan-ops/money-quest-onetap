'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.BINANCE_ONETAP_PORT || 18093);
const REST = (process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com').replace(/\/$/, '');
const API_KEY = process.env.BINANCE_API_KEY || '';
const PRIV = process.env.BINANCE_ED25519_PRIVATE_KEY_PEM || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const AUTH_USER = String(process.env.TELEGRAM_AUTH_USER_ID || '');

const LIVE = process.env.BINANCE_ONETAP_LIVE === '1';
const RISK_PCT = Number(process.env.BINANCE_RISK_PCT || 1);
const MAX_LEV = Number(process.env.BINANCE_MAX_LEVERAGE || 20);
const MARGIN_UTIL = Math.min(0.8, Math.max(0.05, Number(process.env.BINANCE_MAX_MARGIN_UTILIZATION || 0.45)));
const TTL = Math.max(30000, Number(process.env.BINANCE_ONETAP_TTL_MS || 90000));
const MAX_SIGNAL_AGE = Math.max(TTL, Number(process.env.BINANCE_MAX_SIGNAL_AGE_MS || 120000));

const pending = new Map();
const notified = new Set();
const completed = new Set();
const liveTrades = new Map();
let exchangeMeta = new Map();
let metaAt = 0;
let accountCache = null;
let accountAt = 0;
let dualCache = null;
let dualAt = 0;
let updateOffset = 0;
let tgPollOk = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function sign(payload) {
  const key = crypto.createPrivateKey(PRIV);
  return crypto.sign(null, Buffer.from(payload), key).toString('base64');
}

async function signed(method, path, params = {}) {
  const p = { ...params, recvWindow: 5000, timestamp: Date.now() };
  const base = qs(p);
  const sig = sign(base);
  const url = `${REST}${path}?${base}&signature=${encodeURIComponent(sig)}`;
  const r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`BINANCE_${r.status}_${data?.code ?? ''}_${data?.msg ?? text}`);
  return data;
}

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`TG_${method}_${j.error_code}_${j.description}`);
  return j.result;
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
function floorStep(v, step) {
  const n = Number(v), s = Number(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
  return Number((Math.floor((n + 1e-12) / s) * s).toFixed(dec(step)));
}
function fmt(v, step) { return Number(v).toFixed(dec(step)); }
function safeId(prefix, id) {
  return (prefix + crypto.createHash('sha256').update(String(id)).digest('hex')).slice(0, 36);
}
function normalizeSymbol(t) {
  const raw = String(t.binanceSymbol || t.instId || t.symbol || t.asset || '')
    .toUpperCase().replace(/[-_/]/g, '');
  const base = raw.replace(/USDTSWAP$/, '').replace(/USDTPERP$/, '').replace(/USDT$/, '');
  return base ? `${base}USDT` : '';
}
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

function computeLockedSizing({ equity, avail, entry, sl, meta, maxLev, riskPct = RISK_PCT, marginUtil = MARGIN_UTIL }) {
  const dist = Math.abs(entry - sl);
  if (!(equity > 0) || !(avail > 0) || !(dist > 0)) return { blocked: 'BAD_RISK' };
  const riskUsd = equity * (riskPct / 100);
  const rawQty = riskUsd / dist;
  const maxNotional = avail * marginUtil * maxLev;
  const capQty = Math.min(maxNotional / entry, meta.maxQty);
  const capacityLimited = capQty + 1e-12 < rawQty;
  const qty = floorStep(Math.min(rawQty, capQty), meta.stepSize);
  const notional = qty * entry;
  if (!(qty >= meta.minQty) || notional < meta.minNotional) {
    return { blocked: 'BELOW_MIN_ORDER', riskUsd, rawQty, capQty, qty, notional, capacityLimited };
  }
  const leverage = Math.max(1, Math.min(maxLev, Math.ceil(notional / (avail * marginUtil))));
  const margin = notional / leverage;
  const actualRisk = qty * dist;
  return {
    blocked: null,
    riskUsd,
    rawQty,
    capQty,
    qty,
    notional,
    leverage,
    margin,
    actualRisk,
    fullyMirrorable: !capacityLimited,
    riskPctActual: equity > 0 ? (actualRisk / equity) * 100 : 0
  };
}

async function refreshMeta(force = false) {
  if (!force && exchangeMeta.size && Date.now() - metaAt < 300000) return;
  const r = await fetch(`${REST}/fapi/v1/exchangeInfo`);
  if (!r.ok) throw new Error(`EXCHANGEINFO_${r.status}`);
  const j = await r.json();
  const next = new Map();
  for (const x of j.symbols || []) {
    if (x.status !== 'TRADING' || x.contractType !== 'PERPETUAL' || x.quoteAsset !== 'USDT') continue;
    const pf = (x.filters || []).find(f => f.filterType === 'PRICE_FILTER') || {};
    const lf = (x.filters || []).find(f => f.filterType === 'LOT_SIZE') || {};
    const nf = (x.filters || []).find(f => f.filterType === 'MIN_NOTIONAL') || {};
    if (!pf.tickSize || !lf.stepSize) continue;
    next.set(x.symbol, {
      tickSize: pf.tickSize,
      stepSize: lf.stepSize,
      minQty: Number(lf.minQty || 0),
      maxQty: Number(lf.maxQty || Infinity),
      minNotional: Number(nf.notional || 5)
    });
  }
  exchangeMeta = next;
  metaAt = Date.now();
  console.log('EXACT_MIRROR_V2_META_READY', JSON.stringify({ symbols: next.size }));
}

async function account(force = false) {
  if (!force && accountCache && Date.now() - accountAt < 1000) return accountCache;
  accountCache = await signed('GET', '/fapi/v3/account');
  accountAt = Date.now();
  return accountCache;
}

async function dualMode(force = false) {
  if (!force && dualCache !== null && Date.now() - dualAt < 60000) return dualCache;
  const j = await signed('GET', '/fapi/v1/positionSide/dual');
  dualCache = !!j.dualSidePosition;
  dualAt = Date.now();
  return dualCache;
}

async function maxLeverage(symbol) {
  try {
    const j = await signed('GET', '/fapi/v1/leverageBracket', { symbol });
    const b = Array.isArray(j) ? j[0] : j;
    const first = b?.brackets?.[0]?.initialLeverage;
    return Math.max(1, Math.min(MAX_LEV, Number(first || MAX_LEV)));
  } catch (e) {
    console.warn('EXACT_MIRROR_V2_BRACKET_FALLBACK', symbol, String(e.message || e));
    return MAX_LEV;
  }
}

function nonzeroPositions(acc) {
  return (acc.positions || []).filter(p => Math.abs(Number(p.positionAmt || 0)) > 0);
}

async function buildLockedPreview(ticket) {
  if (ticket?.combinedSelected !== true) return { blocked: 'NOT_AUTHORITATIVE_COMBINED' };
  await refreshMeta();
  const symbol = normalizeSymbol(ticket);
  const meta = exchangeMeta.get(symbol);
  if (!meta) return { blocked: 'SYMBOL_NOT_BINANCE_USDM_PERP', symbol };
  const side = String(ticket.side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) return { blocked: 'BAD_SIDE', symbol };

  const sourceEntry = Number(ticket.entry);
  const sourceSl = Number(ticket.sl);
  const sourceTp = Number(ticket.tp);
  if (![sourceEntry, sourceSl, sourceTp].every(Number.isFinite) || !(sourceEntry > 0)) return { blocked: 'BAD_PRICES', symbol };

  const entry = roundStep(sourceEntry, meta.tickSize);
  const sl = roundStep(sourceSl, meta.tickSize);
  const tp = roundStep(sourceTp, meta.tickSize);
  if (side === 'BUY' && !(sl < entry && tp > entry)) return { blocked: 'INVALID_BUY_LEVELS', symbol };
  if (side === 'SELL' && !(sl > entry && tp < entry)) return { blocked: 'INVALID_SELL_LEVELS', symbol };

  const reward = Math.abs(tp - entry);
  const dist = Math.abs(entry - sl);
  if (!(reward > 0 && dist > 0)) return { blocked: 'BAD_RISK', symbol };

  const acc = await account(true);
  const equity = Number(acc.totalWalletBalance || 0);
  const avail = Number(acc.availableBalance || 0);
  if (!(equity > 0 && avail > 0)) return { blocked: 'NO_FUTURES_USDT', symbol, equity, avail };
  if (nonzeroPositions(acc).some(p => p.symbol === symbol)) return { blocked: 'EXISTING_SYMBOL_POSITION', symbol, equity, avail };

  const maxLev = await maxLeverage(symbol);
  const s = computeLockedSizing({ equity, avail, entry, sl, meta, maxLev });
  if (s.blocked) return { ...s, symbol, equity, avail };

  return {
    blocked: null,
    version: 'EXACT_MIRROR_V2',
    id: String(ticket.id),
    symbol,
    side,
    setup: ticket.setup || '',
    combinedSelected: true,
    sourceEntry,
    sourceSl,
    sourceTp,
    entry,
    sl,
    tp,
    tickAdjusted: entry !== sourceEntry || sl !== sourceSl || tp !== sourceTp,
    qty: s.qty,
    qtyStr: fmt(s.qty, meta.stepSize),
    priceStr: fmt(entry, meta.tickSize),
    slStr: fmt(sl, meta.tickSize),
    tpStr: fmt(tp, meta.tickSize),
    equityAtSignal: equity,
    availableAtSignal: avail,
    riskUsdTarget: s.riskUsd,
    actualRiskLocked: s.actualRisk,
    riskPctActual: s.riskPctActual,
    fullyMirrorable: s.fullyMirrorable,
    notional: s.notional,
    leverage: s.leverage,
    margin: s.margin,
    maxLev,
    meta,
    grossRR: reward / dist,
    lockedAt: Date.now()
  };
}

function ticketText(p, expiresSec) {
  const lines = [
    '🚀 COMBINED EDGE — EXACT MIRROR V2',
    `${p.symbol} ${p.side}${p.setup ? ' | ' + p.setup : ''}`,
    `Entry: ${p.entry}`,
    `SL: ${p.sl}`,
    `TP: ${p.tp}`,
    `Qty: ${p.qtyStr}`,
    `Leverage: ${p.leverage}x`,
    `Signal equity: ${p.equityAtSignal.toFixed(2)} USDT`,
    `Target risk: ${p.riskUsdTarget.toFixed(2)} USDT (${RISK_PCT.toFixed(2)}%)`,
    `Locked max loss: ~${p.actualRiskLocked.toFixed(2)} USDT (${p.riskPctActual.toFixed(2)}%)`,
    `Gross RR: ${p.grossRR.toFixed(2)}`,
    `Margin: ~${p.margin.toFixed(2)} USDT`,
    p.fullyMirrorable ? 'Mirrorability: FULL' : 'Mirrorability: NOT FULLY MIRRORABLE — Binance margin/leverage cap limits size',
    `Expires: ${expiresSec}s`,
    '',
    'V2 lock: direction + Entry + SL + TP + qty + leverage are frozen at signal arrival. Confirm does not resize.'
  ];
  if (p.tickAdjusted) lines.push('Only mandatory Binance tick-size rounding was applied.');
  return lines.join('\n');
}

async function sendPending(ticket) {
  if (ticket?.combinedSelected !== true) return;
  const id = String(ticket.id || '');
  if (!id || notified.has(id) || completed.has(id)) return;
  const opened = Date.parse(ticket.openedAt || 0);
  if (Number.isFinite(opened) && opened > 0 && Date.now() - opened > MAX_SIGNAL_AGE) {
    notified.add(id);
    console.log('EXACT_MIRROR_V2_TECH_BLOCK', JSON.stringify({ id, reason: 'STALE_TICKET' }));
    return;
  }

  notified.add(id);
  try {
    const p = await buildLockedPreview(ticket);
    if (p.blocked) {
      console.log('EXACT_MIRROR_V2_TECH_BLOCK', JSON.stringify({ id, symbol: p.symbol, reason: p.blocked }));
      return;
    }
    const token = crypto.randomBytes(10).toString('hex');
    const expiresAt = Date.now() + TTL;
    const msg = await tg('sendMessage', {
      chat_id: TG_CHAT,
      text: ticketText(p, Math.round(TTL / 1000)),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '✅ CONFIRM LIVE', callback_data: `mh2:${token}` },
        { text: '❌ SKIP', callback_data: `ms2:${token}` }
      ]] }
    });
    pending.set(token, { id, ticket, preview: p, expiresAt, messageId: msg.message_id, locked: false });
    console.log('EXACT_MIRROR_V2_PENDING_SENT', JSON.stringify({
      id, symbol: p.symbol, side: p.side, entry: p.entry, sl: p.sl, tp: p.tp,
      qty: p.qtyStr, leverage: p.leverage, signalEquity: p.equityAtSignal,
      targetRisk: p.riskUsdTarget, actualRisk: p.actualRiskLocked, fullyMirrorable: p.fullyMirrorable
    }));
  } catch (e) {
    notified.delete(id);
    console.error('EXACT_MIRROR_V2_PENDING_ERR', id, String(e.message || e));
  }
}

async function revalidateLocked(p) {
  await refreshMeta(true);
  const liveMeta = exchangeMeta.get(p.symbol);
  if (!liveMeta) throw new Error('SYMBOL_NOT_BINANCE_USDM_PERP');
  const acc = await account(true);
  const availNow = Number(acc.availableBalance || 0);
  if (!(availNow > 0)) throw new Error('NO_FUTURES_USDT');
  if (nonzeroPositions(acc).some(x => x.symbol === p.symbol)) throw new Error('EXISTING_SYMBOL_POSITION');
  const maxLevNow = await maxLeverage(p.symbol);
  if (p.leverage > maxLevNow) throw new Error('LOCKED_LEVERAGE_NO_LONGER_ALLOWED');
  if (availNow + 1e-9 < p.margin) throw new Error(`INSUFFICIENT_MARGIN_NOW_${availNow.toFixed(4)}_NEED_${p.margin.toFixed(4)}`);
  return { availNow, maxLevNow };
}

async function changeLeverage(p) {
  return signed('POST', '/fapi/v1/leverage', { symbol: p.symbol, leverage: p.leverage });
}

async function entryOrder(p, hedge) {
  const params = {
    symbol: p.symbol,
    side: p.side,
    type: 'LIMIT',
    timeInForce: 'IOC',
    quantity: p.qtyStr,
    price: p.priceStr,
    newClientOrderId: safeId('mhm2_', p.id),
    newOrderRespType: 'RESULT',
    positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH'
  };
  return signed('POST', '/fapi/v1/order', params);
}

async function algoOrder(p, kind, hedge) {
  const closeSide = p.side === 'BUY' ? 'SELL' : 'BUY';
  return signed('POST', '/fapi/v1/algoOrder', {
    algoType: 'CONDITIONAL',
    symbol: p.symbol,
    side: closeSide,
    positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH',
    type: kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
    triggerPrice: kind === 'SL' ? p.slStr : p.tpStr,
    closePosition: 'true',
    workingType: 'CONTRACT_PRICE',
    priceProtect: 'false',
    clientAlgoId: safeId(kind === 'SL' ? 'mhm2sl_' : 'mhm2tp_', p.id)
  });
}

async function cancelAlgo(p, kind) {
  try {
    return await signed('DELETE', '/fapi/v1/algoOrder', {
      symbol: p.symbol,
      clientAlgoId: safeId(kind === 'SL' ? 'mhm2sl_' : 'mhm2tp_', p.id)
    });
  } catch { return null; }
}

async function emergencyClose(p, hedge, qtyStr) {
  const params = {
    symbol: p.symbol,
    side: p.side === 'BUY' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: qtyStr,
    newClientOrderId: safeId('mhm2e_', p.id),
    newOrderRespType: 'RESULT',
    positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH'
  };
  if (!hedge) params.reduceOnly = 'true';
  return signed('POST', '/fapi/v1/order', params);
}

async function editMessage(messageId, text) {
  try {
    return await tg('editMessageText', { chat_id: TG_CHAT, message_id: messageId, text, disable_web_page_preview: true });
  } catch (e) {
    console.warn('EXACT_MIRROR_V2_EDIT_ERR', String(e.message || e));
  }
}

async function fillStats(p, order) {
  let avg = Number(order?.avgPrice || 0), commission = 0, commissionAsset = 'USDT';
  try {
    const trades = await signed('GET', '/fapi/v1/userTrades', { symbol: p.symbol, orderId: order.orderId, limit: 100 });
    let q = 0, n = 0;
    for (const x of Array.isArray(trades) ? trades : []) {
      const qty = Number(x.qty || 0), price = Number(x.price || 0), c = Math.abs(Number(x.commission || 0));
      if (qty > 0 && price > 0) { q += qty; n += qty * price; }
      if (Number.isFinite(c)) commission += c;
      if (x.commissionAsset) commissionAsset = String(x.commissionAsset);
    }
    if (q > 0) avg = n / q;
  } catch (e) {
    console.warn('EXACT_MIRROR_V2_FILL_STATS_FALLBACK', p.id, String(e.message || e));
  }
  if (!(avg > 0)) avg = p.entry;
  return { avgPrice: avg, entryCommission: commission, commissionAsset };
}

async function executeLocked(item) {
  if (!LIVE) throw new Error('LIVE_GATE_DISABLED');
  const p = item.preview;
  await revalidateLocked(p);
  const hedge = await dualMode(true);
  await changeLeverage(p);
  const order = await entryOrder(p, hedge);
  const executedQty = Number(order.executedQty || 0);
  const status = String(order.status || '');
  if (!(executedQty > 0)) return { ok: false, reason: `NOT_FILLED_${status || 'IOC'}`, p, order };

  const qtyStr = fmt(executedQty, p.meta.stepSize);
  const fillRatio = p.qty > 0 ? executedQty / p.qty : 0;
  const fills = await fillStats(p, order);
  const executedRisk = executedQty * Math.abs(p.entry - p.sl);
  let slAlgo = null, tpAlgo = null;
  try {
    slAlgo = await algoOrder(p, 'SL', hedge);
    tpAlgo = await algoOrder(p, 'TP', hedge);
  } catch (e) {
    console.error('EXACT_MIRROR_V2_PROTECTION_FAIL', p.id, String(e.message || e));
    if (slAlgo) await cancelAlgo(p, 'SL');
    if (tpAlgo) await cancelAlgo(p, 'TP');
    try { await emergencyClose(p, hedge, qtyStr); } catch (closeErr) {
      console.error('EXACT_MIRROR_V2_EMERGENCY_CLOSE_FAIL', p.id, String(closeErr.message || closeErr));
    }
    throw new Error(`PROTECTION_FAIL_POSITION_CLOSED_ATTEMPTED_${String(e.message || e)}`);
  }

  const result = {
    ok: true, p, order, executedQty, fillRatio, executedRisk,
    avgPrice: fills.avgPrice, entryCommission: fills.entryCommission,
    commissionAsset: fills.commissionAsset, hedge, slAlgo, tpAlgo
  };
  liveTrades.set(p.id, { ...result, startedAt: Date.now() });
  monitorTrade(p.id).catch(e => console.error('EXACT_MIRROR_V2_MONITOR_ERR', p.id, String(e.message || e)));
  return result;
}

async function settledStats(t) {
  try {
    const start = Math.max(0, Number(t.startedAt || Date.now()) - 10000);
    const trades = await signed('GET', '/fapi/v1/userTrades', { symbol: t.p.symbol, startTime: start, endTime: Date.now(), limit: 1000 });
    let realized = 0, commission = 0, commissionAsset = 'USDT';
    for (const x of Array.isArray(trades) ? trades : []) {
      const rp = Number(x.realizedPnl || 0), c = Math.abs(Number(x.commission || 0));
      if (Number.isFinite(rp)) realized += rp;
      if (Number.isFinite(c)) commission += c;
      if (x.commissionAsset) commissionAsset = String(x.commissionAsset);
    }
    const net = commissionAsset === 'USDT' ? realized - commission : realized;
    const actualR = t.executedRisk > 0 ? net / t.executedRisk : null;
    return { realized, commission, commissionAsset, net, actualR };
  } catch (e) {
    console.warn('EXACT_MIRROR_V2_SETTLED_STATS_ERR', t.p.id, String(e.message || e));
    return null;
  }
}

async function monitorTrade(id) {
  const t = liveTrades.get(id);
  if (!t) return;
  for (let i = 0; i < 720; i++) {
    await sleep(2000);
    try {
      const acc = await account(true);
      const open = (acc.positions || [])
        .filter(x => x.symbol === t.p.symbol)
        .some(x => Math.abs(Number(x.positionAmt || 0)) > 0);
      if (open) continue;
      await cancelAlgo(t.p, 'SL');
      await cancelAlgo(t.p, 'TP');
      const stats = await settledStats(t);
      liveTrades.delete(id);
      const lines = ['✅ EXACT MIRROR V2 POSITION CLOSED', `${t.p.symbol} ${t.p.side}`];
      if (stats) {
        lines.push(`Realized PnL: ${stats.realized.toFixed(4)} USDT`);
        lines.push(`Commission: ${stats.commission.toFixed(4)} ${stats.commissionAsset}`);
        if (stats.commissionAsset === 'USDT') lines.push(`Net PnL: ${stats.net.toFixed(4)} USDT`);
        if (Number.isFinite(stats.actualR)) lines.push(`Actual R: ${stats.actualR >= 0 ? '+' : ''}${stats.actualR.toFixed(2)}R`);
      }
      try { await tg('sendMessage', { chat_id: TG_CHAT, text: lines.join('\n') }); } catch {}
      return;
    } catch (e) {
      console.warn('EXACT_MIRROR_V2_MONITOR_TICK_ERR', id, String(e.message || e));
    }
  }
}

async function handleCallback(q) {
  const data = String(q.data || '');
  const chat = String(q.message?.chat?.id || '');
  const user = String(q.from?.id || '');
  if (chat !== TG_CHAT) return;
  if (AUTH_USER && user !== AUTH_USER) {
    try { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Not authorized for LIVE execution.', show_alert: true }); } catch {}
    return;
  }

  const [kind, token] = data.split(':');
  if (!['mh2', 'ms2'].includes(kind) || !token) return;
  const item = pending.get(token);
  if (!item) {
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'This V2 ticket expired or was already handled.', show_alert: true });
    return;
  }
  if (item.locked) {
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Already processing.', show_alert: false });
    return;
  }
  if (Date.now() > item.expiresAt) {
    pending.delete(token);
    completed.add(item.id);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ticket expired.', show_alert: true });
    await editMessage(item.messageId, `⌛ EXACT MIRROR V2 TICKET EXPIRED\n${item.id}`);
    return;
  }
  if (kind === 'ms2') {
    item.locked = true;
    pending.delete(token);
    completed.add(item.id);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Skipped.' });
    await editMessage(item.messageId, `❌ SKIPPED\n${item.preview.symbol} ${item.preview.side}\nNo order was submitted.`);
    return;
  }

  item.locked = true;
  completed.add(item.id);
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Submitting the locked Exact Mirror V2 ticket…' });
  await editMessage(item.messageId, [
    '⏳ EXACT MIRROR V2 SUBMITTING',
    `${item.preview.symbol} ${item.preview.side}`,
    `Locked qty: ${item.preview.qtyStr} @ ${item.preview.leverage}x`,
    'Rechecking tradability and available margin only. No resize.'
  ].join('\n'));

  try {
    const r = await executeLocked(item);
    pending.delete(token);
    if (!r.ok) {
      await editMessage(item.messageId, `⚠️ EXACT MIRROR V2 NOT FILLED\n${r.p.symbol} ${r.p.side}\nExact Combined entry was not filled. No chase. No position opened.`);
      return;
    }
    await editMessage(item.messageId, [
      '✅ BINANCE FUTURES — EXACT MIRROR V2',
      `${r.p.symbol} ${r.p.side}`,
      `Filled qty: ${r.executedQty} (${(r.fillRatio * 100).toFixed(1)}%)`,
      `Avg fill: ${r.avgPrice}`,
      `Leverage: ${r.p.leverage}x`,
      `Entry target: ${r.p.entry}`,
      `SL: ${r.p.sl}`,
      `TP: ${r.p.tp}`,
      `Signal equity: ${r.p.equityAtSignal.toFixed(2)} USDT`,
      `Locked risk: ~${r.p.actualRiskLocked.toFixed(2)} USDT`,
      `Executed risk: ~${r.executedRisk.toFixed(2)} USDT`,
      `Mirrorability: ${r.p.fullyMirrorable ? 'FULL' : 'NOT FULLY MIRRORABLE'}`,
      'V2 did not recalculate size at confirmation.'
    ].join('\n'));
    console.log('EXACT_MIRROR_V2_LIVE_EXECUTED', JSON.stringify({
      id: item.id, symbol: r.p.symbol, side: r.p.side, qty: r.executedQty,
      fillRatio: r.fillRatio, avgPrice: r.avgPrice, leverage: r.p.leverage,
      signalEquity: r.p.equityAtSignal, targetRisk: r.p.riskUsdTarget,
      lockedRisk: r.p.actualRiskLocked, executedRisk: r.executedRisk,
      fullyMirrorable: r.p.fullyMirrorable, entry: r.p.entry, sl: r.p.sl, tp: r.p.tp
    }));
  } catch (e) {
    pending.delete(token);
    await editMessage(item.messageId, `❌ EXACT MIRROR V2 EXECUTION FAILED\n${item.preview.symbol} ${item.preview.side}\n${String(e.message || e).slice(0, 300)}\nNo automatic retry/chase was sent.`);
    console.error('EXACT_MIRROR_V2_EXEC_ERROR', item.id, String(e.message || e));
  }
}

async function pollTelegram() {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error('EXACT_MIRROR_V2_TG_MISSING');
    return;
  }
  while (true) {
    try {
      const updates = await tg('getUpdates', { offset: updateOffset, timeout: 20, allowed_updates: ['callback_query'] });
      tgPollOk = true;
      for (const u of updates || []) {
        updateOffset = Math.max(updateOffset, Number(u.update_id || 0) + 1);
        if (u.callback_query) await handleCallback(u.callback_query);
      }
    } catch (e) {
      tgPollOk = false;
      console.error('EXACT_MIRROR_V2_TG_POLL_ERR', String(e.message || e));
      await sleep(3000);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, x] of pending) if (now > x.expiresAt + 60000) pending.delete(token);
}, 30000).unref();

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
        const body = {
          ok: true,
          service: 'BINANCE_COMBINED_EDGE_EXACT_MIRROR',
          version: 'EXACT_MIRROR_V2',
          live: LIVE,
          tgPollOk,
          pending: pending.size,
          completed: completed.size,
          liveTrades: liveTrades.size,
          riskPct: RISK_PCT,
          maxLeverage: MAX_LEV,
          maxMarginUtilization: MARGIN_UTIL,
          ttlMs: TTL,
          strategyGate: 'NONE',
          lineageLock: 'combinedSelected=true',
          sizingPolicy: 'LIVE_EQUITY_AT_SIGNAL_LOCK_ONCE',
          confirmPolicy: 'REVALIDATE_ONLY_NO_RESIZE',
          entryPolicy: 'EXACT_LIMIT_IOC_NO_CHASE'
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(body));
      }

      if (req.method === 'POST' && req.url === '/ingest') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        let payload = null;
        try { payload = JSON.parse(raw.toString('utf8')); } catch {}
        if (payload) for (const t of findTickets(payload)) void sendPending(t);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, mode: 'EXACT_MIRROR_V2_ONLY' }));
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });
}

async function start() {
  if (!API_KEY || !PRIV) console.warn('EXACT_MIRROR_V2_BINANCE_CREDS_MISSING');
  if (!TG_TOKEN || !TG_CHAT) console.warn('EXACT_MIRROR_V2_TELEGRAM_CREDS_MISSING');
  refreshMeta().catch(e => console.error('EXACT_MIRROR_V2_META_BOOT_ERR', String(e.message || e)));
  pollTelegram().catch(e => console.error('EXACT_MIRROR_V2_TG_BOOT_ERR', String(e.message || e)));
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log('EXACT_MIRROR_V2_READY', JSON.stringify({ port: PORT, live: LIVE, riskPct: RISK_PCT, maxLeverage: MAX_LEV }));
  });
}

if (require.main === module) start();

module.exports = {
  computeLockedSizing,
  normalizeSymbol,
  roundStep,
  floorStep,
  fmt,
  createServer,
  buildLockedPreview
};
