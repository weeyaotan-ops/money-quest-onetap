'use strict';

const symbol = 'GRVTUSDT';
const side = 'SELL';
const entry = 0.1703;
const startTime = 1789343493890; // ticket sent
const endTime = 1789343575056;   // ticket expiry
const REST = 'https://fapi.binance.com';

async function fetchAllAggTrades() {
  let out = [];
  let cursorStart = startTime;
  let lastId = null;
  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams({ symbol, startTime: String(cursorStart), endTime: String(endTime), limit: '1000' });
    if (lastId !== null) {
      params.delete('startTime');
      params.delete('endTime');
      params.set('fromId', String(lastId + 1));
    }
    const r = await fetch(`${REST}/fapi/v1/aggTrades?${params}`);
    if (!r.ok) throw new Error(`BINANCE_${r.status}_${await r.text()}`);
    const a = await r.json();
    if (!Array.isArray(a) || !a.length) break;
    for (const x of a) {
      const t = Number(x.T);
      if (t >= startTime && t <= endTime) out.push(x);
    }
    const last = a[a.length - 1];
    lastId = Number(last.a);
    if (Number(last.T) >= endTime || a.length < 1000) break;
  }
  return out;
}

(async()=>{
  const trades = await fetchAllAggTrades();
  const prices = trades.map(x=>Number(x.p)).filter(Number.isFinite);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const touch = trades.find(x => side === 'SELL' ? Number(x.p) >= entry : Number(x.p) <= entry) || null;
  console.log('GRVT_WINDOW_CHECK', JSON.stringify({
    symbol, side, entry, startTime, endTime, seconds:(endTime-startTime)/1000,
    trades: trades.length, min, max,
    restingWouldTouch: !!touch,
    firstTouchTime: touch ? Number(touch.T) : null,
    firstTouchPrice: touch ? Number(touch.p) : null,
    msAfterSend: touch ? Number(touch.T)-startTime : null
  }));
})().catch(e=>{console.error('GRVT_WINDOW_CHECK_ERR', String(e&&e.stack||e)); process.exit(1);});
