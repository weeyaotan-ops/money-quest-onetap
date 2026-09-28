'use strict';

const path = require('path');
const { snapshot } = require('./market_data');
const { rankSnapshots } = require('./core');
const { loadState, performance, performanceBreakdown } = require('./journal');
const {
  shortSymbol,
  stageVisual,
  regimeVisual,
  watchPlan,
  marketSynthesis
} = require('./advisor');

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
let previousData = null;
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

function localTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function currentPrice(snapshot) {
  return Number(snapshot?.lastPrice || snapshot?.candles15m?.[snapshot.candles15m.length - 1]?.close);
}

function directionText(x) {
  const t = Number(x.components?.trend || 0);
  if (t > 0.12) return '↗ UP';
  if (t < -0.12) return '↘ DOWN';
  return '→ MIXED';
}

function componentVisual(v, positive, negative) {
  const n = Number(v || 0);
  if (n > 0.15) return `🟢 ${positive}`;
  if (n < -0.15) return `🔴 ${negative}`;
  return '⚪ Neutral';
}

function providerText(data) {
  const values = [...new Set(Object.values(data?.snapBySymbol || {}).map((s) => s.provider).filter(Boolean))];
  return values.length ? values.join(' / ') : 'n/a';
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🧠 Analyst', callback_data: 'analyst' },
        { text: '🎯 Best Now', callback_data: 'best' }
      ],
      [
        { text: '🌍 Market', callback_data: 'overview' }
      ],
      [
        { text: 'BTC', callback_data: 'asset:BTCUSDT' },
        { text: 'ETH', callback_data: 'asset:ETHUSDT' },
        { text: 'SOL', callback_data: 'asset:SOLUSDT' }
      ],
      [
        { text: '📌 Active', callback_data: 'active' },
        { text: '📊 Performance', callback_data: 'performance' }
      ],
      [
        { text: '⚙️ Status', callback_data: 'status' }
      ]
    ]
  };
}

function assetKeyboard(symbol) {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: `refresh:${symbol}` },
        { text: '🧠 Why?', callback_data: `why:${symbol}` }
      ],
      [
        { text: '🏠 Home', callback_data: 'start' }
      ]
    ]
  };
}

function analystKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: 'analyst' },
        { text: '⚡ Changes', callback_data: 'changes' }
      ],
      [
        { text: '🎯 Best Now', callback_data: 'best' },
        { text: '🏠 Home', callback_data: 'start' }
      ]
    ]
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'start' }]] };
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

  if (cache) previousData = cache;
  cache = { ranked, bySymbol, snapBySymbol, at: new Date() };
  cacheAt = Date.now();
  return cache;
}

function actionLine(x) {
  const v = stageVisual(x);
  if (v.stage === 'ACTIONABLE') return 'DO NOW: Follow the signal plan.';
  if (v.stage === 'ARMED') return 'DO NOW: Prepare. Wait for confirmation.';
  if (v.stage === 'WATCH') return 'DO NOW: Watch the zone. Do not enter yet.';
  return 'DO NOW: Wait. No trade.';
}

function statusText(data) {
  return [
    '⚙️ HUNTER STATUS',
    '',
    '🟢 System: ONLINE',
    '🔔 Auto scan: every 15 min',
    '🧠 Analyst: ON',
    '🎯 Watch zones: ON',
    '🟠 Early heads-up: ON',
    '📒 Forward tracking: ON',
    '🔁 Duplicate protection: ON',
    '',
    `Data: ${providerText(data)}`,
    'Scoring: closed 15m / 1h / 4h candles',
    'Display price: live ticker',
    `Updated: ${localTime(data.at)} SGT/MYT`,
    '',
    'Signal threshold: |Edge| ≥ 0.65',
    'Mode: SIGNAL ONLY'
  ].join('\n');
}

function assetText(symbol, data) {
  const x = data.bySymbol[symbol];
  const s = data.snapBySymbol[symbol];
  if (!x || !s) return `${shortSymbol(symbol)}: data unavailable`;

  const price = currentPrice(s);
  const visual = stageVisual(x);
  const regime = regimeVisual(x.regime.name);
  const watch = watchPlan(x, s);

  const lines = [
    `${shortSymbol(symbol)} / USDT`,
    '',
    `💵 $${priceFmt(price)}`,
    `${visual.icon} ${visual.label}`,
    `Direction: ${directionText(x)}`,
    `${regime.icon} Market: ${regime.label}`,
    `Edge: ${fmt(x.edge, 2)} / 0.65`,
    '',
    actionLine(x)
  ];

  if (x.decision !== 'NO_TRADE' && x.plan) {
    lines.push(
      '',
      `🎯 ENTRY: ${priceFmt(x.plan.entryZone[0])} - ${priceFmt(x.plan.entryZone[1])}`,
      `🛑 STOP: ${priceFmt(x.plan.stop)}`,
      `Risk: ${(RISK_PCT * 100).toFixed(1)}%`
    );
  } else if (watch && visual.stage !== 'NO_TRADE') {
    lines.push(
      '',
      `👀 Watch: ${priceFmt(watch.zone[0])} - ${priceFmt(watch.zone[1])}`,
      `🧭 Bias: ${watch.side}`,
      `❌ Weakens beyond: ${priceFmt(watch.invalid)}`
    );
  }

  lines.push('', `Updated: ${localTime(data.at)}`);
  return lines.join('\n');
}

function whyText(symbol, data) {
  const x = data.bySymbol[symbol];
  const s = data.snapBySymbol[symbol];
  if (!x || !s) return 'Data unavailable.';

  const visual = stageVisual(x);
  const regime = regimeVisual(x.regime.name);
  const watch = watchPlan(x, s);

  const regimeReason = {
    TREND: 'Price is moving cleanly enough to follow.',
    BREAKOUT: 'Price is expanding with momentum.',
    RANGE: 'Sideways market. Hunter cuts confidence.',
    CHAOS: 'Too unstable. Hunter blocks trades.'
  }[x.regime.name] || x.regime.name;

  const lines = [
    `🧠 WHY ${shortSymbol(symbol)}?`,
    '',
    `Trend: ${componentVisual(x.components.trend, 'Supports LONG', 'Supports SHORT')}`,
    `Relative: ${componentVisual(x.components.relativeStrength, 'Strong vs others', 'Weak vs others')}`,
    `Futures: ${componentVisual(x.components.derivatives, 'Supportive', 'Against move')}`,
    `Buy/Sell flow: ${componentVisual(x.components.flow, 'Buyers stronger', 'Sellers stronger')}`,
    `${regime.icon} Regime: ${regime.label}`,
    '',
    regimeReason,
    '',
    `${visual.icon} Final: ${visual.label} | Edge ${fmt(x.edge, 2)}`,
    actionLine(x)
  ];

  if (watch && x.decision === 'NO_TRADE' && visual.stage !== 'NO_TRADE') {
    lines.push(`👀 Main price area: ${priceFmt(watch.zone[0])} - ${priceFmt(watch.zone[1])}`);
  }

  lines.push('', `Source: ${s.provider}`, 'Signal math uses CLOSED candles; live price is display only.');
  return lines.join('\n');
}

function overviewText(data) {
  const lines = ['🌍 MARKET', ''];
  for (const x of data.ranked) {
    const v = stageVisual(x);
    const r = regimeVisual(x.regime.name);
    lines.push(`${v.icon} ${shortSymbol(x.symbol)}  ${v.label} | ${directionText(x)} | ${r.icon} ${r.label} | ${fmt(x.edge, 2)}`);
  }
  lines.push('', '🟢/🔴 action | 🟠 prepare | 🟡 watch | ⚪ wait');
  lines.push(`Updated: ${localTime(data.at)}`);
  return lines.join('\n');
}

function bestText(data) {
  const x = data.ranked[0];
  const s = x ? data.snapBySymbol[x.symbol] : null;
  if (!x || !s) return 'No market data available.';

  const v = stageVisual(x);
  const watch = watchPlan(x, s);
  const lines = [
    '🎯 BEST NOW',
    '',
    `${v.icon} ${shortSymbol(x.symbol)} — ${v.label}`,
    `Direction: ${directionText(x)}`,
    `Market: ${regimeVisual(x.regime.name).icon} ${x.regime.name}`,
    `Edge: ${fmt(x.edge, 2)} / 0.65`,
    '',
    actionLine(x)
  ];

  if (x.decision !== 'NO_TRADE' && x.plan) {
    lines.push(
      '',
      `ENTRY: ${priceFmt(x.plan.entryZone[0])} - ${priceFmt(x.plan.entryZone[1])}`,
      `STOP: ${priceFmt(x.plan.stop)}`
    );
  } else if (watch && v.stage !== 'NO_TRADE') {
    lines.push('', `👀 Watch: ${priceFmt(watch.zone[0])} - ${priceFmt(watch.zone[1])}`);
  }

  return lines.join('\n');
}

function analystText(data) {
  const a = marketSynthesis(data);
  if (!a) return 'No market data available.';

  const bestSnap = data.snapBySymbol[a.best.symbol];
  const watch = watchPlan(a.best, bestSnap);
  const regime = regimeVisual(a.best.regime.name);

  const lines = [
    '🧠 HUNTER ANALYST',
    '',
    `${a.biasIcon} Bias: ${a.bias}`,
    `${a.riskIcon} Risk: ${a.risk}`,
    `${regime.icon} Regime: ${a.best.regime.name}`,
    '',
    `🎯 Focus: ${shortSymbol(a.best.symbol)}`,
    `${a.bestVisual.icon} ${a.bestVisual.label}`,
    `Edge: ${fmt(a.best.edge, 2)} / 0.65`
  ];

  if (watch && a.best.decision === 'NO_TRADE' && a.bestVisual.stage !== 'NO_TRADE') {
    lines.push(`👀 Watch: ${priceFmt(watch.zone[0])} - ${priceFmt(watch.zone[1])}`);
  }

  lines.push(
    '',
    `BOTTOM LINE: ${a.oneLiner}`,
    actionLine(a.best),
    '',
    `Breadth: ${a.bulls} bullish / ${a.bears} bearish / ${a.ranges} range`,
    `Updated: ${localTime(data.at)}`
  );

  return lines.join('\n');
}

function changesText(data) {
  if (!previousData) {
    return ['⚡ CHANGES', '', 'No comparison yet.', 'Refresh Analyst once, then check Changes again.'].join('\n');
  }

  const rows = [];
  let material = 0;
  for (const symbol of SYMBOLS) {
    const now = data.bySymbol[symbol];
    const prev = previousData.bySymbol[symbol];
    if (!now || !prev) continue;
    const d = Number(now.edge) - Number(prev.edge);
    const stageChanged = stageVisual(now).stage !== stageVisual(prev).stage;
    const regimeChanged = now.regime.name !== prev.regime.name;
    if (Math.abs(d) >= 0.05 || stageChanged || regimeChanged) material += 1;

    rows.push({
      symbol,
      d,
      stageChanged,
      regimeChanged,
      text: `${shortSymbol(symbol)}: Edge ${d >= 0 ? '+' : ''}${fmt(d, 2)}${stageChanged ? ` | ${stageVisual(prev).label} → ${stageVisual(now).label}` : ''}${regimeChanged ? ` | ${prev.regime.name} → ${now.regime.name}` : ''}`
    });
  }

  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  if (!material) {
    return ['⚡ CHANGES', '', 'No meaningful change since the previous refresh.', '', 'Market structure is broadly the same.'].join('\n');
  }

  return [
    '⚡ CHANGES',
    '',
    ...rows.filter((r) => Math.abs(r.d) >= 0.05 || r.stageChanged || r.regimeChanged).map((r) => r.text),
    '',
    'Largest movement is shown first.'
  ].join('\n');
}

function activeText(data) {
  const state = loadState(STATE_PATH);
  const journalActive = (state.signals || []).filter((s) => ['PENDING_ENTRY', 'TRIGGERED'].includes(s.status));
  const liveActionable = data.ranked.filter((x) => x.decision !== 'NO_TRADE');

  if (!journalActive.length && !liveActionable.length) {
    return ['📌 ACTIVE', '', '⚪ No active setup now.', '', 'Hunter will alert you automatically.'].join('\n');
  }

  const lines = ['📌 ACTIVE', ''];
  for (const s of journalActive.slice(-5)) {
    const icon = s.side === 'LONG' ? '🟢' : '🔴';
    const status = s.status === 'TRIGGERED' ? 'ENTRY TRIGGERED' : 'WAITING ENTRY';
    lines.push(`${icon} ${shortSymbol(s.symbol)} — ${s.side} — ${status}`);
    lines.push(`Entry ${priceFmt(s.entryZone[0])}-${priceFmt(s.entryZone[1])} | Stop ${priceFmt(s.stop)}`);
  }

  if (!journalActive.length && liveActionable.length) {
    for (const x of liveActionable) {
      const v = stageVisual(x);
      lines.push(`${v.icon} ${shortSymbol(x.symbol)} — ${x.decision} — Edge ${fmt(x.edge, 2)}`);
    }
  }
  return lines.join('\n');
}

function performanceText() {
  const state = loadState(STATE_PATH);
  const p = performance(state);
  const bySymbol = performanceBreakdown(state, 'symbol');
  const byRegime = performanceBreakdown(state, 'regime');

  if (!p.actionable) {
    return ['📊 PERFORMANCE', '', 'No forward-test signal yet.', '', 'Hunter is collecting data first.'].join('\n');
  }

  const lines = [
    '📊 PERFORMANCE',
    '',
    `Signals: ${p.actionable}`,
    `Triggered: ${p.triggered}`,
    `Completed: ${p.completed}`,
    `Cancelled/expired: ${p.expired}`
  ];

  if (p.completed >= 10) {
    lines.push(
      `Win rate: ${p.winRateFinal == null ? 'n/a' : fmt(p.winRateFinal * 100, 1) + '%'}`,
      `Average: ${p.avgFinalR == null ? 'n/a' : fmt(p.avgFinalR, 2) + 'R'}`
    );
  } else {
    lines.push('', 'Too early for a reliable verdict.');
  }

  const symbolRows = Object.entries(bySymbol).filter(([, g]) => g.completed >= 3);
  if (symbolRows.length) {
    lines.push('', 'BY COIN');
    for (const [key, g] of symbolRows) lines.push(`${shortSymbol(key)}: n=${g.completed} | avg ${fmt(g.avgR, 2)}R`);
  }

  const regimeRows = Object.entries(byRegime).filter(([, g]) => g.completed >= 3);
  if (regimeRows.length) {
    lines.push('', 'BY REGIME');
    for (const [key, g] of regimeRows) lines.push(`${key}: n=${g.completed} | avg ${fmt(g.avgR, 2)}R`);
  }

  return lines.join('\n');
}

async function showMenu() {
  await send([
    'HUNTER',
    '',
    '🧠 Analyst = whole-market answer',
    '🎯 Best Now = strongest setup',
    '🌍 Market = all 3 at a glance',
    '📌 Active = open setup tracking',
    '📊 Performance = real forward results'
  ].join('\n'), mainKeyboard());
}

async function handleAction(action, callbackId) {
  await answerCallback(callbackId);

  if (action === 'performance') {
    await send(performanceText(), backKeyboard());
    return;
  }
  if (action === 'menu' || action === 'start') {
    await showMenu();
    return;
  }

  try {
    const force = action.startsWith('refresh:') || ['analyst', 'changes', 'overview', 'best', 'active', 'status'].includes(action);
    const data = await analyze(force);

    if (action === 'status') {
      await send(statusText(data), backKeyboard());
    } else if (action.startsWith('asset:')) {
      const symbol = action.slice(6);
      await send(assetText(symbol, data), assetKeyboard(symbol));
    } else if (action.startsWith('refresh:')) {
      const symbol = action.slice(8);
      await send(assetText(symbol, data), assetKeyboard(symbol));
    } else if (action.startsWith('why:')) {
      const symbol = action.slice(4);
      await send(whyText(symbol, data), assetKeyboard(symbol));
    } else if (action === 'analyst') {
      await send(analystText(data), analystKeyboard());
    } else if (action === 'changes') {
      await send(changesText(data), analystKeyboard());
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
    await send('⚠️ Market refresh failed. Try again in a moment.', backKeyboard());
  }
}

function normalizeMessage(text) {
  const t = String(text || '').trim().toLowerCase().replace(/@\w+$/, '');
  if (t === '/start' || t === 'start' || t === '/menu' || t === 'menu') return 'start';
  if (t === '/analyst' || t === 'analyst') return 'analyst';
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
      { command: 'start', description: 'Open Hunter' },
      { command: 'analyst', description: 'Whole-market analyst' },
      { command: 'best', description: 'Best setup now' },
      { command: 'market', description: 'Quick market view' },
      { command: 'btc', description: 'BTC' },
      { command: 'eth', description: 'ETH' },
      { command: 'sol', description: 'SOL' },
      { command: 'active', description: 'Open setup tracking' },
      { command: 'performance', description: 'Forward-test results' },
      { command: 'status', description: 'System status' }
    ]
  });
}

async function run() {
  console.log(JSON.stringify({ bot: 'Hunter Interactive V4 Analyst', status: 'STARTING' }));
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
      console.error(JSON.stringify({ bot: 'Hunter Interactive V4 Analyst', error: err.message }));
      await sleep(2500);
    }
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ bot: 'Hunter Interactive V4 Analyst', fatal: err.message }));
  process.exit(1);
});
