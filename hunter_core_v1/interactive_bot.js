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
      [{ text: '🚨 现在', callback_data: 'now' }],
      [
        { text: '🌍 市场', callback_data: 'market' },
        { text: '👀 关键价位', callback_data: 'levels' }
      ],
      [
        { text: '📌 进行中', callback_data: 'active' },
        { text: '📒 信号记录', callback_data: 'records' }
      ],
      [
        { text: '📊 成绩', callback_data: 'results' },
        { text: '📡 系统', callback_data: 'system' }
      ],
      [{ text: '🧪 研究室', callback_data: 'shadow' }]
    ]
  };
}

function homeKeyboard() {
  return { inline_keyboard: [[{ text: '🏠 主页', callback_data: 'start' }]] };
}

function refreshKeyboard(action, extras = []) {
  return {
    inline_keyboard: [
      [{ text: '🔄 刷新', callback_data: action }],
      ...extras,
      [{ text: '🏠 主页', callback_data: 'start' }]
    ]
  };
}

function nowKeyboard() {
  return refreshKeyboard('now', [
    [{ text: '❓ 为什么没单', callback_data: 'why' }],
    [{ text: '🌍 市场', callback_data: 'market' }]
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
  if (status === 'TP2') return '🏆 已到 2R';
  if (status === 'TP1_THEN_SL') return '⚠️ 到过 1R，后来止损';
  if (status === 'SL') return '❌ 已止损';
  if (status === 'TP1') return '✅ 已到 1R，继续追踪';
  if (status === 'TP1_AND_SL_SAME_M15') return '⚠️ 同一根 M15 同时碰 1R 和止损';
  if (status === 'TP2_AND_SL_SAME_M15') return '⚠️ 同一根 M15 同时碰 2R 和止损';
  return '⏳ 进行中';
}

function activeText() {
  const state = loadBreakoutState();
  const trades = Object.values(state.trades || {})
    .filter(t => !t.terminal)
    .sort((a,b) => Number(b.signalAtMs || 0) - Number(a.signalAtMs || 0));

  if (!trades.length) return ['📌 进行中', '', '⚪ 现在没有还在跑的信号。'].join('\n');

  const lines = ['📌 进行中', ''];
  for (const t of trades.slice(0, 10)) {
    lines.push(
      `${t.side === 'LONG' ? '🟢' : '🔴'} ${t.symbol} · ${t.side === 'LONG' ? '做多' : '做空'}`,
      signalStatusLine(t),
      `进场 ${priceFmt(t.entry, t.symbol)} · 止损 ${priceFmt(t.stop, t.symbol)} · 1R ${priceFmt(t.tp1, t.symbol)} · 2R ${priceFmt(t.tp2, t.symbol)}`,
      t.signalAtMs ? `信号时间 ${sgtTime(t.signalAtMs)} SGT` : null,
      ''
    );
  }
  return lines.filter(Boolean).join('\n');
}

function signalRecordsText() {
  const state = loadBreakoutState();
  const trades = Object.values(state.trades || {}).sort((a,b) => Number(b.signalAtMs || 0) - Number(a.signalAtMs || 0));
  if (!trades.length) return ['📒 信号记录', '', '还没有记录。'].join('\n');

  const tp1 = trades.filter(t => t.milestones?.tp1?.hit).length;
  const tp2 = trades.filter(t => t.milestones?.tp2?.hit).length;
  const sl = trades.filter(t => t.milestones?.sl?.hit).length;
  const open = trades.filter(t => !t.terminal).length;
  const ambiguous = trades.filter(t => String(t.status || '').includes('SAME_M15')).length;

  const lines = [
    '📒 信号记录',
    '',
    `总数 ${trades.length} · 到1R ${tp1} · 到2R ${tp2} · 碰止损 ${sl} · 进行中 ${open}`,
    ambiguous ? `⚠️ 同一根 M15 无法判断先后：${ambiguous}` : null,
    '',
    '最近'
  ].filter(Boolean);

  for (const t of trades.slice(0, 10)) {
    lines.push(
      '',
      `${t.symbol} · ${t.side === 'LONG' ? '做多' : '做空'}`,
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
    '📊 成绩',
    '',
    '今天',
    `信号 ${d.total} · 到1R ${d.tp1} · 到2R ${d.tp2} · 碰止损 ${d.sl} · 进行中 ${d.open}`,
    d.ambiguous ? `⚠️ 无法判断先后 ${d.ambiguous}` : null,
    '',
    '全部记录',
    `信号 ${all.total} · 到1R ${all.tp1} · 到2R ${all.tp2} · 碰止损 ${all.sl} · 进行中 ${all.open}`,
    all.ambiguous ? `⚠️ 无法判断先后 ${all.ambiguous}` : null,
    '',
    '这里只看现在这套 Session Breakout。'
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
      '🧪 研究室',
      '',
      '还没有足够样本。',
      '系统会在后台比较：',
      '原始突破 / VWAP / H4 / 全部条件',
      '',
      '不会自动改实盘规则。'
    ].join('\n');
  }

  const lines = [
    '🧪 研究室',
    '',
    '只看第一次突破',
    shadowLine('原始突破', s.raw),
    shadowLine('VWAP通过', s.vwapPass),
    shadowLine('H4通过', s.h4Pass),
    shadowLine('全部通过', s.fullPass),
    shadowLine('被挡掉', s.filteredOut),
    '',
    '按币种'
  ];

  for (const [k,v] of Object.entries(s.bySymbol || {})) lines.push(`${k}: n=${v.n} · WR ${pct(v.winRate)} · avg ${rfmt(v.avgR)}`);

  lines.push('', '按时段');
  for (const [k,v] of Object.entries(s.bySession || {})) lines.push(`${k}: n=${v.n} · WR ${pct(v.winRate)} · avg ${rfmt(v.avgR)}`);

  lines.push(
    '',
    '怎么看：',
    '全部通过表现更好 = 过滤条件有帮助。',
    '被挡掉的反而更好 = 过滤条件可能太严格。',
    '',
    '只做研究，不会自动改信号规则。'
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
    '🚨 现在 = 有没有刚确认的信号',
    '🌍 市场 = 全部市场状态',
    '👀 关键价位 = Box 和触发价',
    '📌 进行中 = 已发出、还在跑的信号',
    '📒 信号记录 = 止损 / 1R / 2R',
    '📊 成绩 = 这套策略的记录',
    '📡 系统 = 数据有没有正常',
    '🧪 研究室 = 看过滤条件有没有帮助',
    '',
    '只有刚突破这根 M15 才算新信号。旧突破不追。'
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
      if (action === 'why') return send(formatWhy(r), refreshKeyboard('why', [[{ text: '🚨 现在', callback_data: 'now' }]]));
      if (action === 'market') return send(formatMarketBoard(r), refreshKeyboard('market', [[{ text: '❓ 为什么没单', callback_data: 'why' }]]));
      if (action === 'levels') return send(formatLevels(r), refreshKeyboard('levels', [[{ text: '🚨 现在', callback_data: 'now' }]]));
      if (action === 'system') return send(formatSystem(r), refreshKeyboard('system'));
    }

    return showMenu();
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action, error: err.message }));
    return send('⚠️ 刷新失败，等一下再试。', homeKeyboard());
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
      { command: 'start', description: '打开主页' },
      { command: 'now', description: '现在有没有刚确认信号' },
      { command: 'market', description: '市场状态' },
      { command: 'why', description: '为什么现在没单' },
      { command: 'levels', description: '关键价位' },
      { command: 'active', description: '进行中的信号' },
      { command: 'records', description: '信号记录' },
      { command: 'results', description: '策略成绩' },
      { command: 'system', description: '系统状态' },
      { command: 'shadow', description: '研究室' }
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
