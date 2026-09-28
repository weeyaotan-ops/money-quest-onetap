'use strict';

const FUTURES_BASE = process.env.BINANCE_FUTURES_BASE || 'https://fapi.binance.com';
const FUTURES_DATA_BASE = process.env.BINANCE_FUTURES_DATA_BASE || 'https://fapi.binance.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'money-quest-hunter-core-v1/1.0' } });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status} ${url}`);
  return res.json();
}

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
}

function mapKlines(rows) {
  return rows.map((r) => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6])
  }));
}

async function klines(symbol, interval, limit = 160) {
  const rows = await getJson(`${FUTURES_BASE}/fapi/v1/klines?${qs({ symbol, interval, limit })}`);
  return mapKlines(rows);
}

async function funding(symbol, limit = 30) {
  const rows = await getJson(`${FUTURES_BASE}/fapi/v1/fundingRate?${qs({ symbol, limit })}`);
  return rows.map((r) => ({ time: Number(r.fundingTime), rate: Number(r.fundingRate) }));
}

async function openInterestHistory(symbol, period = '15m', limit = 32) {
  const rows = await getJson(`${FUTURES_DATA_BASE}/futures/data/openInterestHist?${qs({ symbol, period, limit })}`);
  return rows.map((r) => ({ time: Number(r.timestamp), value: Number(r.sumOpenInterest) }));
}

async function basis(pair, period = '15m', limit = 30) {
  const rows = await getJson(`${FUTURES_DATA_BASE}/futures/data/basis?${qs({ pair, contractType: 'PERPETUAL', period, limit })}`);
  return rows.map((r) => ({ time: Number(r.timestamp), rate: Number(r.basisRate), basis: Number(r.basis) }));
}

async function taker(symbol, period = '15m', limit = 32) {
  const rows = await getJson(`${FUTURES_DATA_BASE}/futures/data/takerlongshortRatio?${qs({ symbol, period, limit })}`);
  return rows.map((r) => ({
    time: Number(r.timestamp),
    buySellRatio: Number(r.buySellRatio),
    buyVol: Number(r.buyVol),
    sellVol: Number(r.sellVol)
  }));
}

async function snapshot(symbol) {
  const [candles4h, candles1h, candles15m, f, oi, b, t] = await Promise.all([
    klines(symbol, '4h', 160),
    klines(symbol, '1h', 180),
    klines(symbol, '15m', 180),
    funding(symbol, 30),
    openInterestHistory(symbol, '15m', 32),
    basis(symbol, '15m', 30),
    taker(symbol, '15m', 32)
  ]);
  return { symbol, candles4h, candles1h, candles15m, funding: f, openInterestHistory: oi, basis: b, taker: t };
}

module.exports = { snapshot, klines, funding, openInterestHistory, basis, taker };
