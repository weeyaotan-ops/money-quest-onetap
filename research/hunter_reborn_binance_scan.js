'use strict';

const fs = require('node:fs');
const { discover } = require('./hunter_reborn_event_lab');

const FUTURES_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function parseTime(v, fallback) {
  if (!v) return fallback;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`INVALID_TIME_${v}`);
  return t;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchBatch({ symbol, interval, startTime, endTime }) {
  const u = new URL(FUTURES_KLINES);
  u.searchParams.set('symbol', symbol);
  u.searchParams.set('interval', interval);
  u.searchParams.set('limit', '1500');
  u.searchParams.set('startTime', String(startTime));
  u.searchParams.set('endTime', String(endTime));
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`BINANCE_HTTP_${r.status}_${await r.text()}`);
  return r.json();
}

async function loadCandles({ symbol, interval, startTime, endTime }) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`UNSUPPORTED_INTERVAL_${interval}`);
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const batch = await fetchBatch({ symbol, interval, startTime: cursor, endTime });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch.filter(x => Number(x[0]) >= startTime && Number(x[0]) <= endTime));
    const last = Number(batch[batch.length - 1][0]);
    if (!Number.isFinite(last) || last < cursor) break;
    cursor = last + step;
    if (batch.length < 1500) break;
    await sleep(250);
  }
  return [...new Map(rows.map(x => [Number(x[0]), x])).values()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

async function main() {
  const symbol = String(arg('symbol', 'BTCUSDT')).toUpperCase();
  const interval = arg('interval', '1h');
  const endTime = parseTime(arg('end'), Date.now());
  const defaultStart = endTime - 365 * 86_400_000;
  const startTime = parseTime(arg('start'), defaultStart);
  const costBps = Number(arg('cost-bps', '12'));
  const splitRatio = Number(arg('split', '0.70'));
  const out = arg('out');

  const rows = await loadCandles({ symbol, interval, startTime, endTime });
  const report = discover(rows, { costBps, splitRatio, horizons: [1, 2, 4, 16] });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'BINANCE_USDM_PUBLIC_KLINES',
    symbol,
    interval,
    requestedRange: { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString() },
    ...report
  };
  const json = JSON.stringify(payload, null, 2);
  if (out) fs.writeFileSync(out, json + '\n');
  process.stdout.write(json + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('HUNTER_REBORN_SCAN_FAILED', String(e && (e.stack || e.message) || e));
    process.exitCode = 1;
  });
}

module.exports = { loadCandles, parseTime };
