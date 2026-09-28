'use strict';

const fs = require('fs');
const path = require('path');
const { snapshot } = require('./market_data');
const { rankSnapshots, normalizedMomentum } = require('./core');
const { loadState, performance, stageFromEdge } = require('./journal');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || 1000);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || 0.005);
const STATE_PATH = process.env.HUNTER_STATE_PATH || path.join('.hunter_state', 'state.json');

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

let cache = null;
let cacheAt = 0;
const CACHE_MS = 12000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (x, d = 2) => Number.isFinite(Number(x)) ? Number(x).toFixed(d) : 'n/a';

function priceFmt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function shortSymbol(symbol) {
  return String(symbol).replace('USDT', '');
}

function stageLabel(edge) {
  const s = stageFromEdge(edge);
  if (s === 'ACTIONABLE') return 'ACTIONABLE';
  if (s === 'ARMED') return 'ALMOST READY';
  if (s === 'WATCH') return 'WATCH';
  return 'WAIT';
}

function directionLabel(x) {
  if (x.components.trend > 0.12) return 'UP';
  if (x.components.trend < -0.12) return 'DOWN';
  return 'MIXED';
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Best Now', callback_data: 'best' },
        { text: 'Market', callback_data: 'overview' }
      ],
      [
        { text: 'BTC', callback_data: 'asset:BTCUSDT' },
        { text: 'ETH', callback_data: 'asset:ETHUSDT' },
        { text: 'SOL', callback_data: 'asset:SOLUSDT' }
      ],
      [
        { text: 'Active', callback_data: 'active' },
        { text: 'Performance', callback_data: 'performance' }
      ],
      [
        { text: 'Status', callback_data: 'status' }
      ]
    ]
  };
}

function assetKeyboard(symbol) {
  return {
    inline_keyboard: [
      [
        { text: 'Refresh', callback_data: `refresh:${symbol}` },
        { text: 'Why?', callback_data: `why:${symbol}` }
      ],
      [
        { text: 'Home', callback_data: 'start' }
      ]
    ]
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: 'Home', callback_data: 'start' }]] };
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
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

async function analyze(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const snaps = await Promise.all(SYMBOLS.map(snapshot));
  const ranked = rankSnapshots(snaps, EQUITY, RISK_PCT);
  const bySymbol = Object.fromEntries(ranked.map((x) => [x.symbol, x]));
  const snapBySymbol = Object.fromEntries(snaps.map((x) => [x.symbol, x]));
  cache = { ranked, bySymbol, snapBySymbol, at: new Date() };
  cacheAt = Date.now();
  return cache;
}

function statusText() {
  return [
    'HUNTER STATUS',
    '',
    'System: ONLINE',
    'Mode: SIGNAL ONLY',
    'Scan: every 15 minutes',
    'Coins: BTC / ETH / SOL',
    'Signal: |Edge| >= 0.65',
    'Risk model: 0.5% equity',
    '',
    'No automatic order execution.'
  ].join('\n');
}

function assetText(symbol, data) {
  const x = data.bySymbol[symbol];
  const s = data.snapBySymbol[symbol];
  if (!x || !s) return `${shortSymbol(symbol)}: data unavailable`;

  const price = Number(s.candles15m[s.candles15m.length - 1]?.close);
  const status = stageLabel(x.edge);

  const lines = [
    `${shortSymbol(symbol)} / USDT`,
    '',
    `Price: $${priceFmt(price)}`,
    `Status: ${status}`,
    `Direction: ${directionLabel(x)}`,
    `Market: ${x.regime.name}`,
    `Edge: ${fmt(x.edge, 2)} / 0.65`
  ];

  if (x.decision !== 'NO_TRADE' && x.plan) {
    lines.push(
      '',
      `Signal: ${x.decision}`,
      `Entry: ${priceFmt(x.plan.entryZone[0])} - ${priceFmt(x.plan.entryZone[1])}`,
      `Stop: ${priceFmt(x.plan.stop)}`,
      `Risk: ${(RISK_PCT * 100).toFixed(1)}%`
    );
  } else if (status === 'ALMOST READY') {
    lines.push('', 'Close, but not confirmed yet.');
  } else if (status === 'WATCH') {
    lines.push('', 'Worth watching. No trade yet.');
  } else {
    lines.push('', 'Nothing to do now.');
  }

  return lines.join('\n');
}

function reasonWord(v, positive, negative) {
  if (v > 0.15) return positive;
  if (v < -0.15) return negative;
  return 'Neutral';
}

function whyText(symbol, data) {
  const x = data.bySymbol[symbol];
  if (!x) return 'Data unavailable.';

  const regimeReason = {
    TREND: 'Market is moving cleanly.',
    BREAKOUT: 'Price is breaking out with activity.',
    RANGE: 'Market is sideways, so Hunter reduces confidence.',
    CHAOS: 'Market is too unstable, so Hunter blocks trades.'
  }[x.regime.name] || x.regime.name;

  return [
    `WHY ${shortSymbol(symbol)}?`,
    '',
    `Trend: ${reasonWord(x.components.trend, 'Supports LONG', 'Supports SHORT')}`,
    `Relative strength: ${reasonWord(x.components.relativeStrength, 'Strong vs others', 'Weak vs others')}`,
    `Futures positioning: ${reasonWord(x.components.derivatives, 'Supportive', 'Against move')}`,
    `Buy/Sell flow: ${reasonWord(x.components.flow, 'Buyers stronger', 'Sellers stronger')}`,
    `Market: ${x.regime.name}`,
    '',
    regimeReason,
    '',
    `Final Edge: ${fmt(x.edge, 2)}`,
    'Needs 0.65 for a real signal.'
  ].join('\n');
}

function overviewText(data) {
  const lines = ['MARKET', ''];
  for (const x of data.ranked) {
    lines.push(
      `${shortSymbol(x.symbol)}  ${stageLabel(x.edge)}  |  ${directionLabel(x)}  |  Edge ${fmt(x.edge, 2)}`
    );
  }
  lines.push('', 'Only ACTIONABLE becomes a Telegram signal.');
  return lines.join('\n');
}

function bestText(data) {
  const x = data.ranked[0];
  if (!x) return 'No market data available.';

  const lines = [
    'BEST NOW',
    '',
    `${shortSymbol(x.symbol)}`,
    `Status: ${stageLabel(x.edge)}`,
    `Direction: ${directionLabel(x)}`,
    `Market: ${x.regime.name}`,
    `Edge: ${fmt(x.edge, 2)} / 0.65`
  ];

  if (x.decision !== 'NO_TRADE' && x.plan) {
    lines.push(
      '',
      `Signal: ${x.decision}`,
      `Entry: ${priceFmt(x.plan.entryZone[0])} - ${priceFmt(x.plan.entryZone[1])}`,
      `Stop: ${priceFmt(x.plan.stop)}`
    );
  } else {
    lines.push('', 'No trade yet.');
  }

  return lines.join('\n');
}

function activeText(data) {
  const active = data.ranked.filter((x) => x.decision !== 'NO_TRADE');
  if (!active.length) {
    return [
      'ACTIVE SIGNALS',
      '',
      'None right now.',
      '',
      'Hunter will message you automatically when one reaches the threshold.'
    ].join('\n');
  }

  const lines = ['ACTIVE SIGNALS', ''];
  for (const x of active) {
    lines.push(`${shortSymbol(x.symbol)} — ${x.decision} — Edge ${fmt(x.edge, 2)}`);
  }
  return lines.join('\n');
}

function performanceText() {
  const state = loadState(STATE_PATH);
  const p = performance(state);

  if (!p.actionable) {
    return [
      'PERFORMANCE',
      '',
      'No completed forward-test data yet.',
      '',
      'Hunter is collecting real signals first.'
    ].join('\n');
  }

  const lines = [
    'PERFORMANCE',
    '',
    `Signals tracked: ${p.actionable}`,
    `Entry triggered: ${p.triggered}`,
    `Completed: ${p.completed}`
  ];

  if (p.completed >= 10) {
    lines.push(
      `Win rate: ${p.winRateFinal == null ? 'n/a' : fmt(p.winRateFinal * 100, 1) + '%'}`,
      `Average result: ${p.avgFinalR == null ? 'n/a' : fmt(p.avgFinalR, 2) + 'R'}`
    );
  } else {
    lines.push('', 'Too early to judge the strategy.');
    lines.push('Need more completed signals first.');
  }

  if (state.updatedAt) lines.push('', `Data synced: ${state.updatedAt}`);
  return lines.join('\n');
}

async function showMenu() {
  await send([
    'HUNTER',
    '',
    'Best Now = strongest setup',
    'Market = quick view of all 3',
    'BTC / ETH / SOL = details',
    'Active = current real signals',
    'Performance = forward-test results'
  ].join('\n'), mainKeyboard());
}

async function handleAction(action, callbackId) {
  await answerCallback(callbackId);

  if (action === 'status') {
    await send(statusText(), backKeyboard());
    return;
  }
  if (action === 'performance') {
    await send(performanceText(), backKeyboard());
    return;
  }
  if (action === 'menu' || action === 'start') {
    await showMenu();
    return;
  }

  try {
    const force = action.startsWith('refresh:') || ['overview', 'best', 'active'].includes(action);
    const data = await analyze(force);

    if (action.startsWith('asset:')) {
      const symbol = action.slice(6);
      await send(assetText(symbol, data), assetKeyboard(symbol));
    } else if (action.startsWith('refresh:')) {
      const symbol = action.slice(8);
      await send(assetText(symbol, data), assetKeyboard(symbol));
    } else if (action.startsWith('why:')) {
      const symbol = action.slice(4);
      await send(whyText(symbol, data), assetKeyboard(symbol));
    } else if (action === 'overview') {
      await send(overviewText(data), backKeyboard());
    } else if (action === 'best') {
      await send(bestText(data), backKeyboard());
    } else if (action === 'active') {
      await send(activeText(data), backKeyboard());
    } else {
      await showMenu();
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action, error: err.message }));
    await send('Market refresh failed. Try again in a moment.', backKeyboard());
  }
}

function normalizeMessage(text) {
  const t = String(text || '').trim().toLowerCase().replace(/@\w+$/, '');
  if (t === '/start' || t === 'start' || t === '/menu' || t === 'menu') return 'start';
  if (t === '/btc' || t === 'btc') return 'asset:BTCUSDT';
  if (t === '/eth' || t === 'eth') return 'asset:ETHUSDT';
  if (t === '/sol' || t === 'sol') return 'asset:SOLUSDT';
  if (t === '/market' || t === 'market' || t === '/overview' || t === 'overview') return 'overview';
  if (t === '/best' || t === 'best') return 'best';
  if (t === '/active' || t === 'active') return 'active';
  if (t === '/performance' || t === 'performance') return 'performance';
  if (t === '/status' || t === 'status') return 'status';
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
  url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']));
  if (offset) url.searchParams.set('offset', String(offset));

  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`getUpdates failed: ${res.status}`);
  return data.result || [];
}

async function setCommands() {
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open simple Hunter menu' },
      { command: 'best', description: 'Best setup now' },
      { command: 'market', description: 'Quick market view' },
      { command: 'btc', description: 'BTC' },
      { command: 'eth', description: 'ETH' },
      { command: 'sol', description: 'SOL' },
      { command: 'active', description: 'Current signals' },
      { command: 'performance', description: 'Forward-test results' },
      { command: 'status', description: 'System status' }
    ]
  });
}

async function run() {
  console.log(JSON.stringify({ bot: 'Hunter Interactive V2 Simple', status: 'STARTING' }));
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
      console.error(JSON.stringify({ bot: 'Hunter Interactive V2 Simple', error: err.message }));
      await sleep(2500);
    }
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ bot: 'Hunter Interactive V2 Simple', fatal: err.message }));
  process.exit(1);
});
