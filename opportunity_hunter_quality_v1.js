'use strict';

// Pure input validation. No network, order placement, or portfolio changes.
function timestamp(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function intervalMs(tf) {
  const m = /^(\d+)(m|h|d)$/.exec(String(tf));
  return m ? Number(m[1]) * {m:60000,h:3600000,d:86400000}[m[2]] : NaN;
}

function closedMetrics(klines, tf, now = Date.now()) {
  const interval = intervalMs(tf);
  if (!Array.isArray(klines) || !Number.isFinite(interval)) return null;
  const bars = klines.filter(x => Array.isArray(x) && Number(x[6]) < now).slice(-60);
  if (bars.length < 22) return null;
  for (let i = 0; i < bars.length; i++) {
    const [openTime, open, high, low, close, , closeTime] = bars[i].map(Number);
    if (![openTime, open, high, low, close, closeTime].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, low, close) ||
        low > Math.min(open, close) || closeTime - openTime !== interval - 1 ||
        (i > 0 && openTime !== Number(bars[i-1][0]) + interval)) return null;
  }
  const closedAt = Number(bars.at(-1)[6]);
  if (now - closedAt > interval + 5000) return null;
  const c = bars.map(x => Number(x[4]));
  let path = 0;
  const returns = [];
  for (let i = 1; i < c.length; i++) {
    path += Math.abs(c[i] - c[i-1]);
    returns.push(Math.log(c[i] / c[i-1]) * 1e4);
  }
  const average = returns.reduce((a,b) => a+b, 0) / returns.length;
  let tr = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const high = Number(bars[i][2]), low = Number(bars[i][3]), prev = c[i-1];
    tr += Math.max(high-low, Math.abs(high-prev), Math.abs(low-prev));
  }
  const trueRange=i=>Math.max(Number(bars[i][2])-Number(bars[i][3]),Math.abs(Number(bars[i][2])-c[i-1]),Math.abs(Number(bars[i][3])-c[i-1]));
  const ema=(xs,period)=>xs.slice(1).reduce((v,x)=>v+(x-v)*2/(period+1),xs[0]);
  const candle=b=>({open:Number(b[1]),high:Number(b[2]),low:Number(b[3]),close:Number(b[4])});
  const priorAtr14=Array.from({length:14},(_,i)=>trueRange(bars.length-15+i)).reduce((a,b)=>a+b,0)/14;
  return {
    mom:Math.log(c.at(-1)/c[0])*1e4,
    er:path ? Math.abs(c.at(-1)-c[0])/path : 0,
    vol:Math.sqrt(returns.reduce((s,x) => s+(x-average)**2, 0)/(returns.length-1)),
    close:c.at(-1), atr:tr/14,
    high20:Math.max(...bars.slice(-21,-1).map(x => Number(x[2]))),
    low20:Math.min(...bars.slice(-21,-1).map(x => Number(x[3]))),
    closedAt, closedBars:bars.length,
    pattern:{last:candle(bars.at(-1)),previous:candle(bars.at(-2)),
      priorHigh20:Math.max(...bars.slice(-22,-2).map(x=>Number(x[2]))),
      priorLow20:Math.min(...bars.slice(-22,-2).map(x=>Number(x[3]))),
      ema8:ema(c,8),ema20:ema(c,20),previousEma20:ema(c.slice(0,-1),20),
      priorAtr14,lastTR:trueRange(bars.length-1)}
  };
}

function signalTime(ticket, lastScan) {
  // Once the producer supplies an event time, never replace it with receipt time.
  const sources = [ticket.signalAt, ticket.openedAt, lastScan].filter(x => x !== undefined && x !== null && x !== '');
  return sources.length ? timestamp(sources[0]) : NaN;
}

function isFresh(ticket, maxAge, now = Date.now()) {
  const at = signalTime(ticket);
  return Number.isFinite(at) && at <= now && now - at <= maxAge;
}

function selectFreshCandidates(tickets,maxAge,now=Date.now()) {
  const best=new Map();let stale=0;
  for(const t of tickets){
    if(!isFresh(t,maxAge,now)){stale++;continue}
    const old=best.get(t.symbol);
    if(!old||t.score>old.score)best.set(t.symbol,t);
  }
  return{candidates:[...best.values()].sort((a,b)=>b.score-a.score).slice(0,30),deduped:best.size,stale};
}

module.exports = {timestamp, intervalMs, closedMetrics, signalTime, isFresh, selectFreshCandidates};
