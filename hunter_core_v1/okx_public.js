'use strict';

const BASE = process.env.OKX_PUBLIC_BASE || 'https://www.okx.com';

async function getJson(path, params = {}) {
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  const url = `${BASE}${path}${q ? '?' + q : ''}`;
  const res = await fetch(url, { headers: { 'user-agent': 'money-quest-hunter-core-v1/1.0' } });
  if (!res.ok) throw new Error(`OKX HTTP ${res.status} ${url}`);
  const body = await res.json();
  if (body.code !== '0') throw new Error(`OKX code ${body.code}: ${body.msg || 'unknown'}`);
  return body.data || [];
}

function baseFromSymbol(symbol) {
  return String(symbol).replace(/USDT$/i, '').toUpperCase();
}

function instId(symbol) {
  return `${baseFromSymbol(symbol)}-USDT-SWAP`;
}

function spotId(symbol) {
  return `${baseFromSymbol(symbol)}-USDT`;
}

const BAR_MAP = { '4h': '4H', '1h': '1H', '15m': '15m' };

function mapCandles(rows) {
  return rows
    .filter((r) => String(r[8] ?? '1') === '1')
    .map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[0])
    }))
    .reverse();
}

async function candles(symbol, interval, limit = 180) {
  const rows = await getJson('/api/v5/market/candles', {
    instId: instId(symbol),
    bar: BAR_MAP[interval] || interval,
    limit: Math.min(limit, 300)
  });
  return mapCandles(rows);
}

async function lastPrice(symbol) {
  const rows = await getJson('/api/v5/market/ticker', { instId: instId(symbol) });
  const price = Number(rows[0] && rows[0].last);
  if (!(price > 0)) throw new Error(`OKX invalid ticker price for ${symbol}`);
  return price;
}

async function funding(symbol, limit = 30) {
  const rows = await getJson('/api/v5/public/funding-rate-history', {
    instId: instId(symbol),
    limit: Math.min(limit, 100)
  });
  return rows
    .map((r) => ({ time: Number(r.fundingTime), rate: Number(r.fundingRate) }))
    .reverse();
}

async function openInterestHistory(symbol, period = '5m') {
  const rows = await getJson('/api/v5/rubik/stat/contracts/open-interest-volume', {
    ccy: baseFromSymbol(symbol),
    period
  });
  return rows
    .map((r) => ({ time: Number(r[0]), value: Number(r[1]) }))
    .filter((x) => Number.isFinite(x.time) && Number.isFinite(x.value))
    .sort((a, b) => a.time - b.time)
    .slice(-32);
}

async function basis(symbol) {
  const [markRows, spotRows] = await Promise.all([
    getJson('/api/v5/public/mark-price', { instType: 'SWAP', instId: instId(symbol) }),
    getJson('/api/v5/market/ticker', { instId: spotId(symbol) })
  ]);
  const mark = Number(markRows[0] && markRows[0].markPx);
  const spot = Number(spotRows[0] && spotRows[0].last);
  const rate = mark > 0 && spot > 0 ? (mark - spot) / spot : 0;
  return [{ time: Date.now(), rate, basis: mark - spot }];
}

async function taker(symbol, period = '5m') {
  const rows = await getJson('/api/v5/rubik/stat/taker-volume', {
    ccy: baseFromSymbol(symbol),
    instType: 'CONTRACTS',
    period
  });
  return rows
    .map((r) => {
      const sellVol = Number(r[1]);
      const buyVol = Number(r[2]);
      return {
        time: Number(r[0]),
        buySellRatio: sellVol > 0 ? buyVol / sellVol : 1,
        buyVol,
        sellVol
      };
    })
    .filter((x) => Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time)
    .slice(-32);
}

function aggregateOi15m(rows) {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const out = [];
  for (let i = 2; i < sorted.length; i += 3) out.push(sorted[i]);
  return out.slice(-32);
}

function aggregateTaker15m(rows) {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const out = [];
  for (let i = 0; i + 2 < sorted.length; i += 3) {
    const chunk = sorted.slice(i, i + 3);
    const buyVol = chunk.reduce((a, x) => a + Number(x.buyVol || 0), 0);
    const sellVol = chunk.reduce((a, x) => a + Number(x.sellVol || 0), 0);
    out.push({
      time: chunk[chunk.length - 1].time,
      buySellRatio: sellVol > 0 ? buyVol / sellVol : 1,
      buyVol,
      sellVol
    });
  }
  return out.slice(-32);
}

async function snapshot(symbol) {
  const [candles4h, candles1h, candles15m, f, oi, b, t, lp] = await Promise.all([
    candles(symbol, '4h', 160),
    candles(symbol, '1h', 180),
    candles(symbol, '15m', 180),
    funding(symbol, 30),
    openInterestHistory(symbol, '5m'),
    basis(symbol),
    taker(symbol, '5m'),
    lastPrice(symbol)
  ]);

  return {
    provider: 'OKX_FALLBACK',
    symbol,
    lastPrice: lp,
    candles4h,
    candles1h,
    candles15m,
    funding: f,
    openInterestHistory: aggregateOi15m(oi),
    basis: b,
    taker: aggregateTaker15m(t)
  };
}

module.exports = {
  snapshot,
  candles,
  lastPrice,
  funding,
  openInterestHistory,
  basis,
  taker,
  mapCandles,
  aggregateOi15m,
  aggregateTaker15m
};
