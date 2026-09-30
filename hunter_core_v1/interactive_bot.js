'use strict';

const fs = require('fs');
const path = require('path');
const {
  checkAll,
  formatNow,
  formatWhy,
  formatMarketBoard,
  formatLevels,
  formatSystem
} = require('./session_breakout_check');
const { summary: shadowSummary } = require('./session_breakout_shadow');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const BREAKOUT_STATE_PATH = process.env.BREAKOUT_STATE_PATH || process.env.HUNTER_STATE_PATH || '/data/session_breakout_state.json';
const CHECK_CACHE_MS = Number(process.env.BREAKOUT_CHECK_CACHE_MS || 12000);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

let checkCache = null;
let checkCacheAt = 0;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function priceFmt(x, symbol = '') {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  const s = String(symbol).toUpperCase();
  if (s === 'XAUUSD') return n.toFixed(2);
  if (s.includes('JPY')) return n.toFixed(3);
  if (s.endsWith('USD') && !s.endsWith('USDT')) return n.toFixed(5);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function sgtDate(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

function sgtTime(ts) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ts));
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚨 NOW', callback_data: 'now' }],
      [
        { text: '🌍 MARKET BOARD', callback_data: 'market' },
        { text: '👀 KEY LEVELS', callback_data: 'levels' }
      ],
      [
        { text: '📌 ACTIVE', callback_data: 'active' },
        { text: '📒 SIGNAL RECORDS', callback_data: 'records' }
      ],
      [
        { text: '📊 RESULTS', callback_data: 'results' },
        { text: '📡 SYSTEM', callback_data: 'system' }
      ],
      [{ text: '🧪 SHADOW LAB', callback_data: 'shadow' }]
    ]
  };
}

function homeKeyboard() {
  return { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'start' }]] };
}

function refreshKeyboard(action, extras = []) {
  return {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: action }],
      ...extras,
      [{ text: '🏠 Home', callback_data: 'start' }]
    ]
  };
}

function nowKeyboard() {
  return refreshKeyboard('now', [
    [{ text: '❓ WHY NO SIGNAL', callback_data: 'why' }],
    [{ text: '🌍 MARKET BOARD', callback_data: 'market' }]
  ]);
}

function loadBreakoutState() {
  try {
    const x = JSON.parse(fs.readFileSync(BREAKOUT_STATE_PATH, 'utf8'));
    if (!x || typeof x !== 'object') return { sent: {}, trades: {} };
    if (!x.sent || typeof x.sent !== 'object') x.sent = {};
    if (!x.trades || typeof x.trades !== 'object') x.trades = {};
    return x;
  } catch {
    return { sent: {}, trades: {} };
  }
}

function signalStatusLine(t) {
  const status = String(t.status || 'OPEN');
  if (status === 'TP2') return '🏆 TP2 HIT (+2R milestone)';
  if (status === 'TP1_THEN_SL') return '⚠️ 1R reached → later SL';
  if (status === 'SL') return '❌ SL HIT';
  if (status === 'TP1') return '✅ 1R HIT · still tracking';
  if (status === 'TP1_AND_SL_SAME_M15') return '⚠️ 1R + SL touched in same M15';
  if (status === 'TP2_AND_SL_SAME_M15') return '⚠️ 2R + SL touched in same M15';
  return '⏳ OPEN';
}

function activeText() {
  const state = loadBreakoutState();
  const trades = Object.values(state.trades || {})
    .filter(t => !t.terminal)
    .sort((a,b) => Number(b.signalAtMs || 0) - Number(a.signalAtMs || 0));

  if (!trades.length) return ['📌 ACTIVE', '', '⚪ No open breakout signal.', '', 'New valid signals will appear here automatically.'].join('\n');

  const lines = ['📌 ACTIVE', ''];
  for (const t of trades.slice(0, 10)) {
    lines.push(
      `${t.side === 'LONG' ? '🟢' : '🔴'} ${t.symbol} · ${t.sessionLabel || t.session} · ${t.side}`,
      signalStatusLine(t),
      `Entry ${priceFmt(t.entry, t.symbol)} · SL ${priceFmt(t.stop, t.symbol)} · 1R ${priceFmt(t.tp1, t.symbol)} · 2R ${priceFmt(t.tp2, t.symbol)}`,
      t.signalAtMs ? `Signal ${sgtTime(t.signalAtMs)} SGT` : null,
      ''
    );
  }
  return lines.filter(Boolean).join('\n');
}

function signalRecordsText() {
  const state = loadBreakoutState();
  const trades = Object.values(state.trades || {}).sort((a,b) => Number(b.signalAtMs || 0) - Number(a.signalAtMs || 0));
  if (!trades.length) return ['📒 SIGNAL RECORDS', '', 'No tracked Session Breakout signal yet.'].join('\n');

  const tp1 = trades.filter(t => t.milestones?.tp1?.hit).length;
  const tp2 = trades.filter(t => t.milestones?.tp2?.hit).length;
  const sl = trades.filter(t => t.milestones?.sl?.hit).length;
  const open = trades.filter(t => !t.terminal).length;
  const ambiguous = trades.filter(t => String(t.status || '').includes('SAME_M15')).length;

  const lines = [
    '📒 SIGNAL RECORDS',
    '',
    `Tracked: ${trades.length} · 1R: ${tp1} · 2R: ${tp2} · SL touched: ${sl} · Open: ${open}`,
    ambiguous ? `⚠️ Same-M15 ambiguous: ${ambiguous}` : null,
    '',
    'RECENT'
  ].filter(Boolean);

  for (const t of trades.slice(0, 10)) {
    lines.push(
      '',
      `${t.symbol} · ${t.sessionLabel || t.session} · ${t.side}`,
      signalStatusLine(t),
      `Entry ${priceFmt(t.entry, t.symbol)} · SL ${priceFmt(t.stop, t.symbol)} · 1R ${priceFmt(t.tp1, t.symbol)} · 2R ${priceFmt(t.tp2, t.symbol)}`
    );
  }
  return lines.join('\n');
}

function resultsText() {
  const state = loadBreakoutState();
  const trades = Object.values(state.trades || {});
  const today = sgtDate();
  const todayTrades = trades.filter(t => Number.isFinite(Number(t.signalAtMs)) && sgtDate(Number(t.signalAtMs)) === today);

  const summarize = xs => ({
    total: xs.length,
    tp1: xs.filter(t => t.milestones?.tp1?.hit).length,
    tp2: xs.filter(t => t.milestones?.tp2?.hit).length,
    sl: xs.filter(t => t.milestones?.sl?.hit).length,
    open: xs.filter(t => !t.terminal).length,
    ambiguous: xs.filter(t => String(t.status || '').includes('SAME_M15')).length
  });

  const d = summarize(todayTrades);
  const all = summarize(trades);
  return [
    '📊 SESSION BREAKOUT RESULTS',
    '',
    'TODAY',
    `Signals ${d.total} · 1R ${d.tp1} · 2R ${d.tp2} · SL ${d.sl} · Open ${d.open}`,
    d.ambiguous ? `Ambiguous same-M15: ${d.ambiguous}` : null,
    '',
    'ALL TRACKED',
    `Signals ${all.total} · 1R ${all.tp1} · 2R ${all.tp2} · SL ${all.sl} · Open ${all.open}`,
    all.ambiguous ? `Ambiguous same-M15: ${all.ambiguous}` : null,
    '',
    'This is the new Session Breakout record — old Hunter results are removed.'
  ].filter(Boolean).join('\n');
}

function pct(x) {
  return Number.isFinite(Number(x)) ? (Number(x) * 100).toFixed(1) + '%' : 'n/a';
}

function rfmt(x) {
  return Number.isFinite(Number(x)) ? (Number(x) >= 0 ? '+' : '') + Number(x).toFixed(2) + 'R' : 'n/a';
}

function shadowLine(label, s) {
  return `${label}: n=${s.n} · done=${s.completed} · WR ${pct(s.winRate)} · avg ${rfmt(s.avgR)}`;
}

function shadowLabText() {
  const state = loadBreakoutState();
  const s = shadowSummary(state, { firstOnly: true });
  if (!s.raw.n) {
    return [
      '🧪 SHADOW LAB',
      '',
      'No raw breakout sample yet.',
      'It is running silently and will compare:',
      'RAW vs VWAP vs H4 vs FULL filter.',
      '',
      'Live signal rules are unchanged.'
    ].join('\n');
  }

  const lines = [
    '🧪 SHADOW LAB',
    '',
    'FIRST BREAKOUT ONLY',
    shadowLine('RAW', s.raw),
    shadowLine('VWAP PASS', s.vwapPass),
    shadowLine('H4 PASS', s.h4Pass),
    shadowLine('FULL PASS', s.fullPass),
    shadowLine('FILTERED OUT', s.filteredOut),
    '',
    'BY COIN'
  ];

  for (const [k,v] of Object.entries(s.bySymbol || {})) lines.push(`${k}: n=${v.n} · WR ${pct(v.winRate)} · avg ${rfmt(v.avgR)}`);

  lines.push('', 'BY SESSION');
  for (const [k,v] of Object.entries(s.bySession || {})) lines.push(`${k}: n=${v.n} · WR ${pct(v.winRate)} · avg ${rfmt(v.avgR)}`);

  lines.push(
    '',
    'Interpretation:',
    'FULL PASS better than FILTERED OUT = filters are helping.',
    'FILTERED OUT better = a filter may be blocking useful trades.',
    '',
    'Research only · does not change live signals.'
  );
  return lines.join('\n');
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function send(text, replyMarkup = mainKeyboard()) {
  return tg('sendMessage', {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function answerCallback(id) {
  if (!id) return;
  await tg('answerCallbackQuery', { callback_query_id: id }).catch(() => {});
}

async function getCheck(force = false) {
  if (!force && checkCache && Date.now() - checkCacheAt < CHECK_CACHE_MS) return checkCache;
  checkCache = await checkAll();
  checkCacheAt = Date.now();
  return checkCache;
}

async function showMenu() {
  await send([
    'HUNTER · SESSION BREAKOUT',
    '',
    '🚨 NOW = 现在有没有确认的机会',
    '🌍 MARKET BOARD = 全部市场现在走到哪一步',
    '👀 KEY LEVELS = Box / trigger 价位',
    '📌 ACTIVE = 已触发、仍在追踪的 signals',
    '📒 SIGNAL RECORDS = SL / 1R / 2R 记录',
    '📊 RESULTS = 这套 breakout 的 results',
    '📡 SYSTEM = feed + scanner self-check',
    '🧪 SHADOW LAB = filters 到底有没有帮忙',
    '',
    '没有确认 = 不进。'
  ].join('\n'), mainKeyboard());
}

async function handleAction(action, callbackId) {
  await answerCallback(callbackId);

  try {
    if (action === 'start') return showMenu();
    if (action === 'active') return send(activeText(), refreshKeyboard('active'));
    if (action === 'records') return send(signalRecordsText(), refreshKeyboard('records'));
    if (action === 'results') return send(resultsText(), refreshKeyboard('results'));
    if (action === 'shadow') return send(shadowLabText(), refreshKeyboard('shadow'));

    if (['now','why','market','levels','system'].includes(action)) {
      const r = await getCheck(true);
      if (action === 'now') return send(formatNow(r), nowKeyboard());
      if (action === 'why') return send(formatWhy(r), refreshKeyboard('why', [[{ text: '🚨 NOW', callback_data: 'now' }]]));
      if (action === 'market') return send(formatMarketBoard(r), refreshKeyboard('market', [[{ text: '❓ WHY NO SIGNAL', callback_data: 'why' }]]));
      if (action === 'levels') return send(formatLevels(r), refreshKeyboard('levels', [[{ text: '🚨 NOW', callback_data: 'now' }]]));
      if (action === 'system') return send(formatSystem(r), refreshKeyboard('system'));
    }

    return showMenu();
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action, error: err.message }));
    return send('⚠️ Refresh failed. Try again in a moment.', homeKeyboard());
  }
}

function normalizeMessage(text) {
  const t = String(text || '').trim().toLowerCase().replace(/@\w+$/, '');
  if (['/start','start','/menu','menu'].includes(t)) return 'start';
  if (['/check','check','/now','now','/breakout','breakout'].includes(t)) return 'now';
  if (['/why','why'].includes(t)) return 'why';
  if (['/market','market','/board','board'].includes(t)) return 'market';
  if (['/levels','levels'].includes(t)) return 'levels';
  if (['/active','active'].includes(t)) return 'active';
  if (['/records','records'].includes(t)) return 'records';
  if (['/results','results','/performance','performance'].includes(t)) return 'results';
  if (['/system','system','/status','status'].includes(t)) return 'system';
  if (['/shadow','shadow','/lab','lab'].includes(t)) return 'shadow';
  return null;
}

async function handleUpdate(update) {
  const cq = update.callback_query;
  if (cq) {
    const chatId = String(cq.message?.chat?.id || '');
    if (chatId !== CHAT_ID) {
      await answerCallback(cq.id);
      return;
    }
    await handleAction(String(cq.data || ''), cq.id);
    return;
  }

  const msg = update.message;
  if (!msg || String(msg.chat?.id || '') !== CHAT_ID) return;
  const action = normalizeMessage(msg.text);
  if (action) await handleAction(action);
  else await showMenu();
}

async function getUpdates(offset) {
  const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
  url.searchParams.set('timeout', '50');
  url.searchParams.set('allowed_updates', JSON.stringify(['message','callback_query']));
  if (offset) url.searchParams.set('offset', String(offset));
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`getUpdates failed: ${res.status}`);
  return data.result || [];
}

async function setCommands() {
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open Session Breakout command center' },
      { command: 'now', description: 'Confirmed / near / blocked setups now' },
      { command: 'market', description: 'Market board' },
      { command: 'why', description: 'Why there is no signal' },
      { command: 'levels', description: 'Box and trigger prices' },
      { command: 'active', description: 'Open signal tracking' },
      { command: 'records', description: 'Signal SL / 1R / 2R records' },
      { command: 'results', description: 'Session Breakout results' },
      { command: 'system', description: 'Feed and scanner self-check' },
      { command: 'shadow', description: 'Counterfactual filter lab' }
    ]
  });
}

async function run() {
  console.log(JSON.stringify({ bot: 'Session Breakout Command Center V1', status: 'STARTING', statePath: path.resolve(BREAKOUT_STATE_PATH) }));
  await tg('deleteWebhook', { drop_pending_updates: false });
  await setCommands();
  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        await handleUpdate(update);
      }
    } catch (err) {
      console.error(JSON.stringify({ bot: 'Session Breakout Command Center V1', error: err.message }));
      await sleep(2500);
    }
  }
}

run().catch(err => {
  console.error(JSON.stringify({ bot: 'Session Breakout Command Center V1', fatal: err.message }));
  process.exit(1);
});
