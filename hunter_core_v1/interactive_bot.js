'use strict';

const { snapshot } = require('./market_data');
const { rankSnapshots, normalizedMomentum } = require('./core');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const EQUITY = Number(process.env.HUNTER_EQUITY_USDT || 1000);
const RISK_PCT = Number(process.env.HUNTER_RISK_PCT || 0.005);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

let cache = null;
let cacheAt = 0;
const CACHE_MS = 12000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (x, d = 3) => Number.isFinite(Number(x)) ? Number(x).toFixed(d) : 'n/a';

function priceFmt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  return n.toFixed(4);
}

function arrow(v) {
  if (v > 0.12) return '↑ Bullish';
  if (v < -0.12) return '↓ Bearish';
  return '→ Neutral';
}

function keyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'BTC', callback_data: 'asset:BTCUSDT' },
        { text: 'ETH', callback_data: 'asset:ETHUSDT' },
        { text: 'SOL', callback_data: 'asset:SOLUSDT' }
      ],
      [
        { text: 'Market Overview', callback_data: 'overview' },
        { text: 'Best Setup', callback_data: 'best' }
      ],
      [
        { text: 'Hunter Status', callback_data: 'status' }
      ]
    ]
  };
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

async function send(text, withMenu = true) {
  return tg('sendMessage', {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true,
    ...(withMenu ? { reply_markup: keyboard() } : {})
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
    'HUNTER CORE V1',
    '',
    'Mode: SIGNAL ONLY',
    'Auto scan: every 15 min',
    'Markets: BTC / ETH / SOL',
    'Signal threshold: Edge >= +0.65 LONG',
    'Signal threshold: Edge <= -0.65 SHORT',
    '',
    'Interactive bot: ONLINE while this worker is running',
    'Buttons only show market data and Hunter judgement.',
    'No automatic order execution.'
  ].join('\n');
}

function assetText(symbol, data) {
  const x = data.bySymbol[symbol];
  const s = data.snapBySymbol[symbol];
  if (!x || !s) return `${symbol}: data unavailable`;

  const price = Number(s.candles15m[s.candles15m.length - 1]?.close);
  const m4h = normalizedMomentum(s.candles4h, 12);
  const m1h = normalizedMomentum(s.candles1h, 24);
  const m15 = normalizedMomentum(s.candles15m, 16);
  const oiPct = x.derivativesDiagnostics.oiChange * 100;
  const plan = x.plan;

  const lines = [
    `${symbol.replace('USDT', '/USDT')}`,
    '',
    `Price: $${priceFmt(price)}`,
    `4H: ${arrow(m4h)}`,
    `1H: ${arrow(m1h)}`,
    `15M: ${arrow(m15)}`,
    '',
    `Regime: ${x.regime.name}`,
    `Edge: ${fmt(x.edge, 3)}`,
    `Trend: ${fmt(x.components.trend, 3)}`,
    `Relative Strength: ${fmt(x.components.relativeStrength, 3)}`,
    `Derivatives: ${fmt(x.components.derivatives, 3)}`,
    `Flow: ${fmt(x.components.flow, 3)}`,
    `OI change: ${fmt(oiPct, 2)}%`,
    '',
    `Hunter: ${x.decision}`
  ];

  if (plan) {
    lines.push(
      '',
      `Entry: ${priceFmt(plan.entryZone[0])} - ${priceFmt(plan.entryZone[1])}`,
      `Stop: ${priceFmt(plan.stop)}`,
      `Risk: ${(RISK_PCT * 100).toFixed(2)}%`,
      `Position: ${fmt(plan.notional, 2)} USDT`
    );
  } else {
    lines.push('', 'No actionable signal now.');
  }

  lines.push('', `Updated: ${data.at.toISOString()}`);
  return lines.join('\n');
}

function overviewText(data) {
  const lines = ['MARKET OVERVIEW', ''];
  for (const x of data.ranked) {
    lines.push(
      `${x.symbol.replace('USDT', '')}: ${x.decision} | Edge ${fmt(x.edge, 3)} | ${x.regime.name}`
    );
  }
  lines.push('', 'Only |Edge| >= 0.65 becomes an actionable signal.');
  return lines.join('\n');
}

function bestText(data) {
  const x = data.ranked[0];
  if (!x) return 'No market data available.';
  if (x.decision === 'NO_TRADE') {
    return [
      'BEST SETUP',
      '',
      'No actionable trade right now.',
      `Strongest watch: ${x.symbol}`,
      `Edge: ${fmt(x.edge, 3)}`,
      `Regime: ${x.regime.name}`,
      '',
      'Hunter is waiting rather than forcing a trade.'
    ].join('\n');
  }
  return [
    'BEST SETUP',
    '',
    `${x.symbol} — ${x.decision}`,
    `Edge: ${fmt(x.edge, 3)}`,
    `Regime: ${x.regime.name}`,
    '',
    x.plan ? `Entry: ${priceFmt(x.plan.entryZone[0])} - ${priceFmt(x.plan.entryZone[1])}` : '',
    x.plan ? `Stop: ${priceFmt(x.plan.stop)}` : '',
    '',
    'This is the strongest actionable market among BTC / ETH / SOL.'
  ].filter(Boolean).join('\n');
}

async function showMenu() {
  await send([
    'HUNTER CORE V1',
    '',
    'Tap a button for live market analysis.',
    'BTC / ETH / SOL = individual market',
    'Market Overview = compare all 3',
    'Best Setup = strongest current setup',
    'Hunter Status = system status'
  ].join('\n'));
}

async function handleAction(action, callbackId) {
  await answerCallback(callbackId);

  if (action === 'status') {
    await send(statusText());
    return;
  }
  if (action === 'menu' || action === 'start') {
    await showMenu();
    return;
  }

  await send('Refreshing live market data...', false);

  try {
    const data = await analyze(true);
    if (action.startsWith('asset:')) {
      await send(assetText(action.slice(6), data));
    } else if (action === 'overview') {
      await send(overviewText(data));
    } else if (action === 'best') {
      await send(bestText(data));
    } else {
      await showMenu();
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action, error: err.message }));
    await send('Market refresh failed. Please try again in a moment.');
  }
}

function normalizeMessage(text) {
  const t = String(text || '').trim().toLowerCase().replace(/@\w+$/, '');
  if (t === '/start' || t === 'start' || t === '/menu' || t === 'menu') return 'start';
  if (t === '/btc' || t === 'btc') return 'asset:BTCUSDT';
  if (t === '/eth' || t === 'eth') return 'asset:ETHUSDT';
  if (t === '/sol' || t === 'sol') return 'asset:SOLUSDT';
  if (t === '/overview' || t === 'overview') return 'overview';
  if (t === '/best' || t === 'best') return 'best';
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
      { command: 'start', description: 'Open Hunter menu' },
      { command: 'btc', description: 'BTC live analysis' },
      { command: 'eth', description: 'ETH live analysis' },
      { command: 'sol', description: 'SOL live analysis' },
      { command: 'overview', description: 'Compare BTC ETH SOL' },
      { command: 'best', description: 'Best current setup' },
      { command: 'status', description: 'Hunter system status' }
    ]
  });
}

async function run() {
  console.log(JSON.stringify({ bot: 'Hunter Interactive V1', status: 'STARTING' }));
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
      console.error(JSON.stringify({ bot: 'Hunter Interactive V1', error: err.message }));
      await sleep(2500);
    }
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ bot: 'Hunter Interactive V1', fatal: err.message }));
  process.exit(1);
});
