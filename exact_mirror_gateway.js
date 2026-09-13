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
const UPSTREAM = process.env.BINANCE_ONETAP_UPSTREAM || 'http://127.0.0.1:18092';

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

function sign(s) {
  const key = crypto.createPrivateKey(PRIV);
  return crypto.sign(null, Buffer.from(s), key).toString('base64');
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
function normalizeSymbol(t) {
  const raw = String(t.binanceSymbol || t.instId || t.symbol || t.asset || '')
    .toUpperCase().replace(/[-_/]/g, '');
  const base = raw.replace(/USDTSWAP$/, '').replace(/USDTPERP$/, '').replace(/USDT$/, '');
  return base ? base + 'USDT' : '';
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
function safeId(prefix, id) {
  return (prefix + crypto.createHash('sha256').update(String(id)).digest('hex')).slice(0, 36);
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
  console.log('EXACT_MIRROR_META_READY', JSON.stringify({ symbols: next.size }));
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
    console.warn('EXACT_MIRROR_BRACKET_FALLBACK', symbol, String(e.message || e));
    return MAX_LEV;
  }
}

function nonzeroPositions(acc) {
  return (acc.positions || []).filter(p => Math.abs(Number(p.positionAmt || 0)) > 0);
}

async function preview(ticket, force = false) {
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
  const dist = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!(dist > 0 && reward > 0)) return { blocked: 'BAD_RISK', symbol };
  const acc = await account(force);
  const equity = Number(acc.totalWalletBalance || 0);
  const avail = Number(acc.availableBalance || 0);
  if (!(equity > 0 && avail > 0)) return { blocked: 'NO_FUTURES_USDT', symbol, equity, avail };
  const nz = nonzeroPositions(acc);
  if (nz.some(p => p.symbol === symbol)) return { blocked: 'EXISTING_SYMBOL_POSITION', symbol, equity, avail };
  const riskUsd = equity * (RISK_PCT / 100);
  if (!(riskUsd > 0)) return { blocked: 'BAD_RISK', symbol, equity, avail };
  const maxLev = await maxLeverage(symbol);
  const rawQty = riskUsd / dist;
  const maxNotional = avail * MARGIN_UTIL * maxLev;
  const qty = floorStep(Math.min(rawQty, maxNotional / entry, meta.maxQty), meta.stepSize);
  const notional = qty * entry;
  if (!(qty >= meta.minQty) || notional < meta.minNotional) return { blocked: 'BELOW_MIN_ORDER', symbol, equity, avail, qty, notional };
  const leverage = Math.max(1, Math.min(maxLev, Math.ceil(notional / (avail * MARGIN_UTIL))));
  const margin = notional / leverage;
  const actualRisk = qty * dist;
  const grossRR = reward / dist;
  return {
    blocked: null, version: 'EXACT_MIRROR_V1', id: String(ticket.id), symbol, side, setup: ticket.setup || '', combinedSelected: true,
    sourceEntry, sourceSl, sourceTp, entry, sl, tp,
    tickAdjusted: entry !== sourceEntry || sl !== sourceSl || tp !== sourceTp,
    qty, qtyStr: fmt(qty, meta.stepSize), priceStr: fmt(entry, meta.tickSize), slStr: fmt(sl, meta.tickSize), tpStr: fmt(tp, meta.tickSize),
    equity, avail, riskUsd, actualRisk, notional, leverage, margin, maxLev, meta, grossRR
  };
}

function ticketText(p, expiresSec) {
  const lines = [
    '🚀 COMBINED EDGE — EXACT MIRROR',
    `${p.symbol} ${p.side}${p.setup ? ' | ' + p.setup : ''}`,
    `Entry: ${p.entry}`,
    `SL: ${p.sl}`,
    `TP: ${p.tp}`,
    `Qty: ${p.qtyStr}`,
    `Leverage: ${p.leverage}x`,
    `Target risk: ~${p.actualRisk.toFixed(2)} USDT (${(p.actualRisk / p.equity * 100).toFixed(2)}%)`,
    `Gross RR: ${p.grossRR.toFixed(2)}`,
    `Margin: ~${p.margin.toFixed(2)} USDT`,
    `Expires: ${expiresSec}s`,
    '',
    'Exact Mirror: no extra EV/RR/setup gate. Combined Edge owns direction + Entry + SL + TP.'
  ];
  if (p.tickAdjusted) lines.push('Only mandatory Binance tick-size rounding applied.');
  return lines.join('\n');
}

async function sendPending(ticket) {
  if (ticket?.combinedSelected !== true) {
    console.log('EXACT_MIRROR_LINEAGE_BLOCK', JSON.stringify({ id: String(ticket?.id || ''), reason: 'NOT_AUTHORITATIVE_COMBINED' }));
    return;
  }
  const id = String(ticket.id || '');
  if (!id || notified.has(id) || completed.has(id)) return;
  const opened = Date.parse(ticket.openedAt || 0);
  if (Number.isFinite(opened) && opened > 0 && Date.now() - opened > MAX_SIGNAL_AGE) {
    notified.add(id);
    console.log('EXACT_MIRROR_TECH_BLOCK', JSON.stringify({ id, reason: 'STALE_TICKET' }));
    return;
  }
  notified.add(id);
  try {
    const p = await preview(ticket, false);
    if (p.blocked) {
      console.log('EXACT_MIRROR_TECH_BLOCK', JSON.stringify({ id, symbol: p.symbol, reason: p.blocked }));
      return;
    }
    const token = crypto.randomBytes(10).toString('hex');
    const expiresAt = Date.now() + TTL;
    const msg = await tg('sendMessage', {
      chat_id: TG_CHAT,
      text: ticketText(p, Math.round(TTL / 1000)),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '✅ CONFIRM LIVE', callback_data: `mh:${token}` }, { text: '❌ SKIP', callback_data: `ms:${token}` }]] }
    });
    pending.set(token, { ticket, id, preview: p, expiresAt, messageId: msg.message_id, locked: false });
    console.log('EXACT_MIRROR_PENDING_SENT', JSON.stringify({ id, symbol: p.symbol, side: p.side, entry: p.entry, sl: p.sl, tp: p.tp, qty: p.qtyStr, lev: p.leverage, expiresAt }));
  } catch (e) {
    notified.delete(id);
    console.error('EXACT_MIRROR_PENDING_ERR', id, String(e.message || e));
  }
}

async function changeLeverage(p) { return signed('POST', '/fapi/v1/leverage', { symbol: p.symbol, leverage: p.leverage }); }

async function entryOrder(p, hedge) {
  const params = {
    symbol: p.symbol, side: p.side, type: 'LIMIT', timeInForce: 'IOC', quantity: p.qtyStr, price: p.priceStr,
    newClientOrderId: safeId('mhm_', p.id), newOrderRespType: 'RESULT', positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH'
  };
  return signed('POST', '/fapi/v1/order', params);
}

async function algoOrder(p, kind, hedge) {
  const side = p.side === 'BUY' ? 'SELL' : 'BUY';
  const params = {
    algoType: 'CONDITIONAL', symbol: p.symbol, side,
    positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH',
    type: kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
    triggerPrice: kind === 'SL' ? p.slStr : p.tpStr,
    closePosition: 'true', workingType: 'CONTRACT_PRICE', priceProtect: 'false',
    clientAlgoId: safeId(kind === 'SL' ? 'mhmsl_' : 'mhmtp_', p.id)
  };
  return signed('POST', '/fapi/v1/algoOrder', params);
}

async function emergencyClose(p, hedge, qtyStr) {
  const params = {
    symbol: p.symbol, side: p.side === 'BUY' ? 'SELL' : 'BUY', type: 'MARKET', quantity: qtyStr,
    newClientOrderId: safeId('mhme_', p.id), newOrderRespType: 'RESULT', positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH'
  };
  if (!hedge) params.reduceOnly = 'true';
  return signed('POST', '/fapi/v1/order', params);
}

async function cancelAlgo(symbol, clientAlgoId) {
  try { return await signed('DELETE', '/fapi/v1/algoOrder', { symbol, clientAlgoId }); } catch { return null; }
}
async function editMessage(messageId, text) {
  try { return await tg('editMessageText', { chat_id: TG_CHAT, message_id: messageId, text, disable_web_page_preview: true }); }
  catch (e) { console.warn('EXACT_MIRROR_EDIT_ERR', String(e.message || e)); }
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
  } catch (e) { console.warn('EXACT_MIRROR_FILL_STATS_FALLBACK', p.id, String(e.message || e)); }
  if (!(avg > 0)) avg = p.entry;
  return { avgPrice: avg, entryCommission: commission, commissionAsset };
}

async function executePending(item) {
  if (!LIVE) throw new Error('LIVE_GATE_DISABLED');
  const p = await preview(item.ticket, true);
  if (p.blocked) throw new Error('BLOCKED_' + p.blocked);
  const hedge = await dualMode(true);
  await changeLeverage(p);
  const order = await entryOrder(p, hedge);
  const executedQty = Number(order.executedQty || 0);
  const status = String(order.status || '');
  if (!(executedQty > 0)) return { ok: false, reason: `NOT_FILLED_${status || 'IOC'}`, p, order };
  const qtyStr = fmt(executedQty, p.meta.stepSize);
  const fillRatio = p.qty > 0 ? executedQty / p.qty : 0;
  const fills = await fillStats(p, order);
  let slAlgo = null, tpAlgo = null;
  try {
    slAlgo = await algoOrder(p, 'SL', hedge);
    tpAlgo = await algoOrder(p, 'TP', hedge);
  } catch (e) {
    console.error('EXACT_MIRROR_PROTECTION_FAIL', p.id, String(e.message || e));
    if (slAlgo) await cancelAlgo(p.symbol, safeId('mhmsl_', p.id));
    if (tpAlgo) await cancelAlgo(p.symbol, safeId('mhmtp_', p.id));
    try { await emergencyClose(p, hedge, qtyStr); } catch (closeErr) { console.error('EXACT_MIRROR_EMERGENCY_CLOSE_FAIL', p.id, String(closeErr.message || closeErr)); }
    throw new Error('PROTECTION_FAIL_POSITION_CLOSED_ATTEMPTED_' + String(e.message || e));
  }
  const result = { ok: true, p, order, executedQty, fillRatio, avgPrice: fills.avgPrice, entryCommission: fills.entryCommission, commissionAsset: fills.commissionAsset, hedge, slAlgo, tpAlgo };
  liveTrades.set(p.id, { ...result, startedAt: Date.now() });
  monitorTrade(p.id).catch(e => console.error('EXACT_MIRROR_MONITOR_ERR', p.id, String(e.message || e)));
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
    const actualR = t.p.actualRisk > 0 ? net / t.p.actualRisk : null;
    return { realized, commission, commissionAsset, net, actualR };
  } catch (e) {
    console.warn('EXACT_MIRROR_SETTLED_STATS_ERR', t.p.id, String(e.message || e));
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
      const pos = (acc.positions || []).filter(x => x.symbol === t.p.symbol);
      const open = pos.some(x => Math.abs(Number(x.positionAmt || 0)) > 0);
      if (open) continue;
      await cancelAlgo(t.p.symbol, safeId('mhmsl_', id));
      await cancelAlgo(t.p.symbol, safeId('mhmtp_', id));
      const stats = await settledStats(t);
      liveTrades.delete(id);
      console.log('EXACT_MIRROR_POSITION_CLOSED', JSON.stringify({ id, symbol: t.p.symbol, stats }));
      try {
        const lines = ['✅ EXACT MIRROR POSITION CLOSED', `${t.p.symbol} ${t.p.side}`];
        if (stats) {
          lines.push(`Realized PnL: ${stats.realized.toFixed(4)} USDT`);
          lines.push(`Commission: ${stats.commission.toFixed(4)} ${stats.commissionAsset}`);
          if (stats.commissionAsset === 'USDT') lines.push(`Net PnL: ${stats.net.toFixed(4)} USDT`);
          if (Number.isFinite(stats.actualR)) lines.push(`Actual R: ${stats.actualR >= 0 ? '+' : ''}${stats.actualR.toFixed(2)}R`);
        }
        await tg('sendMessage', { chat_id: TG_CHAT, text: lines.join('\n') });
      } catch {}
      return;
    } catch (e) { console.warn('EXACT_MIRROR_MONITOR_TICK_ERR', id, String(e.message || e)); }
  }
}

async function handleCallback(q) {
  const data = String(q.data || ''), chat = String(q.message?.chat?.id || ''), user = String(q.from?.id || '');
  if (chat !== TG_CHAT) return;
  if (AUTH_USER && user !== AUTH_USER) {
    try { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Not authorized for LIVE execution.', show_alert: true }); } catch {}
    return;
  }
  const [kind, token] = data.split(':');
  if (!['mh', 'ms'].includes(kind) || !token) return;
  const item = pending.get(token);
  if (!item) { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'This ticket expired or was already handled.', show_alert: true }); return; }
  if (item.locked) { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Already processing.', show_alert: false }); return; }
  if (Date.now() > item.expiresAt) {
    pending.delete(token); completed.add(item.id);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ticket expired.', show_alert: true });
    await editMessage(item.messageId, '⌛ EXACT MIRROR TICKET EXPIRED\n' + item.id);
    return;
  }
  if (kind === 'ms') {
    item.locked = true; pending.delete(token); completed.add(item.id);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Skipped.' });
    await editMessage(item.messageId, `❌ SKIPPED\n${item.preview.symbol} ${item.preview.side}\nNo order was submitted.`);
    return;
  }
  item.locked = true; completed.add(item.id);
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Submitting exact Combined ticket to Binance Futures…' });
  await editMessage(item.messageId, `⏳ EXACT MIRROR SUBMITTING\n${item.preview.symbol} ${item.preview.side}\nRechecking Binance tradability, balance and exact Combined levels…`);
  try {
    const r = await executePending(item);
    pending.delete(token);
    if (!r.ok) {
      await editMessage(item.messageId, `⚠️ EXACT MIRROR NOT FILLED\n${r.p.symbol} ${r.p.side}\nExact Combined entry was not filled. No chase. No position opened.`);
      console.log('EXACT_MIRROR_NOT_FILLED', JSON.stringify({ id: item.id, symbol: r.p.symbol, reason: r.reason }));
      return;
    }
    await editMessage(item.messageId, [
      '✅ BINANCE FUTURES — EXACT MIRROR', `${r.p.symbol} ${r.p.side}`,
      `Filled qty: ${r.executedQty} (${(r.fillRatio * 100).toFixed(1)}%)`, `Avg fill: ${r.avgPrice}`, `Leverage: ${r.p.leverage}x`,
      `Entry target: ${r.p.entry}`, `SL: ${r.p.sl}`, `TP: ${r.p.tp}`, `Target risk: ~${r.p.actualRisk.toFixed(2)} USDT`,
      `Gross RR: ${r.p.grossRR.toFixed(2)}`, 'No extra strategy gate was applied.'
    ].join('\n'));
    console.log('EXACT_MIRROR_LIVE_EXECUTED', JSON.stringify({ id: item.id, symbol: r.p.symbol, side: r.p.side, qty: r.executedQty, fillRatio: r.fillRatio, avgPrice: r.avgPrice, lev: r.p.leverage, actualRisk: r.p.actualRisk, entry: r.p.entry, sl: r.p.sl, tp: r.p.tp }));
  } catch (e) {
    pending.delete(token);
    await editMessage(item.messageId, `❌ EXACT MIRROR EXECUTION FAILED\n${item.preview.symbol} ${item.preview.side}\n${String(e.message || e).slice(0, 300)}\nNo automatic retry/chase was sent.`);
    console.error('EXACT_MIRROR_EXEC_ERROR', item.id, String(e.message || e));
  }
}

async function pollTelegram() {
  if (!TG_TOKEN || !TG_CHAT) { console.error('EXACT_MIRROR_TG_MISSING'); return; }
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
      console.error('EXACT_MIRROR_TG_POLL_ERR', String(e.message || e));
      await sleep(3000);
    }
  }
}

async function forward(req, raw) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'connection'].includes(k.toLowerCase()) || v == null) continue;
    headers[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return fetch(UPSTREAM + '/ingest', { method: 'POST', headers, body: raw });
}

setInterval(() => {
  const now = Date.now();
  for (const [token, x] of pending) if (now > x.expiresAt + 60000) pending.delete(token);
}, 30000).unref();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
      const body = {
        ok: true, service: 'BINANCE_COMBINED_EDGE_EXACT_MIRROR', version: 'EXACT_MIRROR_V1', live: LIVE,
        tgPollOk, pending: pending.size, completed: completed.size, liveTrades: liveTrades.size,
        riskPct: RISK_PCT, maxLeverage: MAX_LEV, maxMarginUtilization: MARGIN_UTIL, ttlMs: TTL,
        strategyGate: 'NONE', lineageLock: 'combinedSelected=true', entryPolicy: 'EXACT_LIMIT_IOC_NO_CHASE'
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    if (req.method === 'POST' && req.url === '/ingest') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      let payload = null; try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      if (payload) for (const t of findTickets(payload)) void sendPending(t);
      try {
        const u = await forward(req, raw), b = Buffer.from(await u.arrayBuffer());
        res.writeHead(u.status, { 'content-type': u.headers.get('content-type') || 'application/json' });
        return res.end(b);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'upstream_unreachable', detail: String(e.message || e) }));
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('EXACT_MIRROR_READY', JSON.stringify({
    port: PORT, version: 'EXACT_MIRROR_V1', live: LIVE, ttlMs: TTL, riskPct: RISK_PCT, maxLeverage: MAX_LEV,
    maxMarginUtilization: MARGIN_UTIL, strategyGate: 'NONE', lineageLock: 'combinedSelected=true', entryPolicy: 'EXACT_LIMIT_IOC_NO_CHASE'
  }));
  refreshMeta().catch(e => console.error('EXACT_MIRROR_META_BOOT_ERR', String(e.message || e)));
  pollTelegram();
});
