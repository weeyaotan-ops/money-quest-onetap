'use strict';
const assert=require('node:assert/strict');
const {closedMetrics,isFresh,intervalMs,selectFreshCandidates}=require('../opportunity_hunter_quality_v1');
const {normalizeTickets,idFor}=require('../hunter_onetap_adapter');
const now=Date.UTC(2026,8,18,12,0,0),minute=60000;
function candles(){return Array.from({length:61},(_,i)=>{
  const openTime=now-(60-i)*minute,price=100+i*.1;
  return[openTime,String(price),String(price+.3),String(price-.2),String(price+.1),'10',openTime+minute-1];
})}
const bars=candles(),before=closedMetrics(bars,'1m',now);
assert.equal(before.closedBars,60);
assert.equal(before.closedAt,now-1);
assert.equal(before.close,106);
// The active candle can spike or reverse without changing the accepted signal.
bars[60][2]='999999';bars[60][4]='999998';
assert.deepEqual(closedMetrics(bars,'1m',now),before);
assert.equal(closedMetrics(bars,'1m',now+3*minute),null);
assert.equal(closedMetrics(bars.slice(0,15),'1m',now),null);
assert.equal(closedMetrics([...bars.slice(0,25),...bars.slice(26)],'1m',now),null);
const bad=candles();bad[20][3]='500';assert.equal(closedMetrics(bad,'1m',now),null);
assert.equal(intervalMs('15m'),900000);
// ATR includes the previous close for ALL fourteen true ranges, including gaps.
const gap=candles();gap[45][4]='105';gap[45][2]='105.2';
const expected=gap.slice(46,60).reduce((s,b,j)=>s+Math.max(+b[2]-+b[3],Math.abs(+b[2]-+gap[45+j][4]),Math.abs(+b[3]-+gap[45+j][4])),0)/14;
assert.ok(Math.abs(closedMetrics(gap,'1m',now).atr-expected)<1e-12);
const ticket={symbol:'BTCUSDT',side:'BUY',edge:'BREAKOUT_RETEST',timeframe:'5m',entry:100,sl:99,tp:102,signalAt:new Date(now-60000).toISOString()};
const feed={lastScan:now,tickets:[ticket]};
const first=normalizeTickets(feed,now)[0],afterRestart=normalizeTickets(feed,now+1000)[0];
assert.equal(first.id,afterRestart.id);
assert.equal(first.openedAt,ticket.signalAt);
assert.equal(normalizeTickets(feed,now+121000).length,0);
assert.equal(normalizeTickets({tickets:[{...ticket,signalAt:undefined}]},now).length,0);
assert.equal(normalizeTickets({lastScan:now-180000,tickets:[{...ticket,signalAt:undefined}]},now).length,0);
assert.equal(normalizeTickets({lastScan:now,tickets:[{...ticket,signalAt:'bad'}]},now).length,0);
assert.equal(normalizeTickets({tickets:[{...ticket,signalAt:new Date(now+1).toISOString()}]},now).length,0);
assert.notEqual(idFor(ticket),idFor({...ticket,timeframe:'15m'}));
assert.notEqual(idFor(ticket),idFor({...ticket,signalAt:new Date(now).toISOString()}));
assert.equal(isFresh({openedAt:new Date(now-120000).toISOString()},120000,now),true);
assert.equal(isFresh({openedAt:new Date(now-120001).toISOString()},120000,now),false);
assert.equal(isFresh({},120000,now),false);
// A stale high-scoring timeframe must not suppress a fresh alternative for the symbol.
const selection=selectFreshCandidates([
  {...ticket,timeframe:'15m',score:1,signalAt:new Date(now-600000).toISOString()},
  {...ticket,timeframe:'1m',score:.8},
  {...ticket,symbol:'ETHUSDT',score:.9},
  {...ticket,symbol:'ETHUSDT',score:.7}
],120000,now);
assert.equal(selection.stale,1);assert.equal(selection.deduped,2);
assert.deepEqual(selection.candidates.map(x=>[x.symbol,x.timeframe]),[['ETHUSDT','5m'],['BTCUSDT','1m']]);
console.log('HUNTER_SIGNAL_QUALITY_V1_PASS');
