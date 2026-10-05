'use strict';

const assert = require('assert');
const {
  emaSeries, atr, regime, freshBreakout, qualityGate, retestSignal, rangeSignal, updateTrade, drawdownStats, entryZone, barrierRoomAt, chaseGuard, signalMessage,
  ensureTradeLifecycle, lifecycleSnapshot, lifecycleEvents, lifecycleMessage, armedMessage, armEndMessage, ENTRY_VALID_MS, updateTradePrice, entryDecision, snowballRisk, executionPlan,
  vwapGate, chooseFreshestSnapshot, snapshotFreshness, xauMarketClosed, qtyStep, universeQualityOk, setupWatch
} = require('../adaptive_hunter_monitor');

const M15=15*60*1000;
const H4=4*60*60*1000;
function c(t,o,h,l,cl,v=100){return {openTime:t,open:o,high:h,low:l,close:cl,volume:v,closeTime:t+M15-1};}
function h4Trend(long=true){
  const out=[]; let p=long?100:200;
  for(let i=0;i<80;i+=1){
    const step=long?1:-1; const o=p; p+=step;
    out.push({openTime:i*H4,open:o,high:Math.max(o,p)+0.5,low:Math.min(o,p)-0.5,close:p,volume:1000});
  }
  return out;
}
function flatH4(){
  const out=[];
  for(let i=0;i<80;i+=1){
    const p=100+(i%4===0?0.4:i%4===2?-0.4:0);
    out.push({openTime:i*H4,open:100,high:101,low:99,close:p,volume:1000});
  }
  return out;
}
function m15Base(count=80,start=0){
  const out=[];
  for(let i=0;i<count;i+=1){
    const p=100+0.05*i;
    out.push(c(start+i*M15,p,p+0.5,p-0.5,p+0.1,100));
  }
  return out;
}


(function vwapMustBeReal(){
  assert.strictEqual(vwapGate('LONG',101,null),false);
  assert.strictEqual(vwapGate('SHORT',99,null),false);
  assert.strictEqual(vwapGate('LONG',101,100),true);
  assert.strictEqual(vwapGate('SHORT',99,100),true);
})();

(function freshestFeedWins(){
  const now=Date.parse('2026-10-02T00:31:00Z');
  const oldSnap={provider:'BINANCE',m15:[c(Date.parse('2026-10-02T00:00:00Z'),1,1,1,1)]};
  const freshSnap={provider:'OKX',m15:[c(Date.parse('2026-10-02T00:15:00Z'),1,1,1,1)]};
  assert.ok(snapshotFreshness(oldSnap,now)>snapshotFreshness(freshSnap,now));
  assert.strictEqual(chooseFreshestSnapshot([oldSnap,freshSnap],now).provider,'OKX');
})();

(function xauWeekendMarketHours(){
  assert.strictEqual(xauMarketClosed(Date.parse('2026-10-03T06:00:00Z')),true); // Saturday
  assert.strictEqual(xauMarketClosed(Date.parse('2026-10-02T20:00:00Z')),false); // Friday 16:00 New York
  assert.strictEqual(xauMarketClosed(Date.parse('2026-10-02T22:00:00Z')),true);  // Friday 18:00 New York
  assert.strictEqual(xauMarketClosed(Date.parse('2026-10-04T20:00:00Z')),true);  // Sunday 16:00 New York
  assert.strictEqual(xauMarketClosed(Date.parse('2026-10-04T23:00:00Z')),false); // Sunday 19:00 New York
})();

(function indicatorsWork(){
  const e=emaSeries([1,2,3,4,5,6,7,8,9,10],3);
  assert.ok(e&&e.length===10);
  const a=atr(m15Base(30),14);
  assert.ok(a>0);
})();

(function trendRegime(){
  const snap={symbol:'BTCUSDT',h4:h4Trend(true),m15:m15Base(100)};
  const r=regime(snap);
  assert.strictEqual(r.type,'TREND');
  assert.strictEqual(r.side,'LONG');
})();

(function rangeRegime(){
  const snap={symbol:'XAUUSD',h4:flatH4(),m15:m15Base(100)};
  const r=regime(snap);
  assert.ok(['RANGE','NEUTRAL'].includes(r.type));
})();

(function setupWatchExplainsNextStep(){
  const session={id:'LONDON',label:'London'};
  const box={high:105,low:95,activeFrom:2*M15,activeUntil:20*M15};
  const latest=c(5*M15,100,101,99,100);

  const long=setupWatch('BTCUSDT',{type:'TREND',side:'LONG',a15:2},box,session,latest);
  assert.strictEqual(long.status,'WAIT_BREAKOUT');
  assert.strictEqual(long.trigger,105);
  assert.ok(long.instruction.includes('M15'));

  const short=setupWatch('XAUUSD',{type:'TREND',side:'SHORT',a15:2},box,session,latest);
  assert.strictEqual(short.status,'WAIT_BREAKOUT');
  assert.strictEqual(short.trigger,95);

  const range=setupWatch('ETHUSDT',{type:'RANGE',a15:2},box,session,latest);
  assert.strictEqual(range.status,'WAIT_SWEEP_RECLAIM');
  assert.strictEqual(range.boxLow,95);
  assert.strictEqual(range.boxHigh,105);

  const noBox=setupWatch('SOLUSDT',{type:'TREND',side:'LONG'},null,session,latest);
  assert.strictEqual(noBox.status,'WAIT_BOX');
})();

(function freshBreakoutOnly(){
  const box={high:105,low:95,activeFrom:0,activeUntil:999999999};
  const xs=[c(0,100,104,99,104),c(M15,104,108,103,106)];
  assert.ok(freshBreakout(xs,box,'LONG'));
  xs.push(c(2*M15,106,109,105.5,108));
  assert.strictEqual(freshBreakout(xs,box,'LONG'),null);
})();

(function riskGate(){
  assert.strictEqual(qualityGate(100,99.8,1).ok,false);
  assert.strictEqual(qualityGate(100,99,1).ok,true);
  assert.strictEqual(qualityGate(100,97,1).ok,false);
})();

(function retestLong(){
  const start=Date.parse('2026-09-30T00:00:00Z');
  const base=[];
  for(let i=0;i<40;i+=1) base.push(c(start+i*M15,100,101,99,100,100));
  const boTime=start+40*M15;
  base.push(c(boTime,104,108,103,106,150));
  base.push(c(boTime+M15,105.2,106.5,104.7,105.8,150));
  const snap={symbol:'BTCUSDT',m15:base,h4:h4Trend(true)};
  const armed={side:'LONG',breakoutOpenTime:boTime};
  const box={high:105,low:99};
  const reg={a15:2};
  const s=retestSignal(snap,armed,box,reg);
  assert.ok(s);
  assert.strictEqual(s.mode,'TREND_RETEST');
  assert.strictEqual(s.side,'LONG');
  assert.ok(s.stop<s.entry);
  assert.ok(s.tp2>s.tp1);
})();

(function rangeSweepLong(){
  const start=Date.parse('2026-09-30T00:00:00Z');
  const xs=[];
  for(let i=0;i<40;i+=1) xs.push(c(start+i*M15,100,101,99,100,100));
  xs.push(c(start+40*M15,100,100.2,98.2,99.4,150));
  const box={high:102,low:99,mid:100.5,activeFrom:0,activeUntil:Date.parse('2030-01-01T00:00:00Z')};
  const snap={symbol:'XAUUSD',m15:xs};
  const s=rangeSignal(snap,box,{a15:1});
  assert.ok(s===null || s.mode==='RANGE_SWEEP');
})();

(function tradeTracking(){
  const t={symbol:'BTCUSDT',mode:'TREND_RETEST',side:'LONG',entry:100,stop:95,tp1:105,tp2:110,riskDistance:5,signalAtMs:1,status:'OPEN',terminal:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,lastOpenTime:0,realizedR:null};
  const bars=[c(M15,100,106,99,105),c(2*M15,105,111,104,110)];
  updateTrade(t,bars);
  assert.strictEqual(t.tp1Hit,true);
  assert.strictEqual(t.tp2Hit,true);
  assert.strictEqual(t.runnerActive,true);
})();

(function stats(){
  const trades=[
    {terminal:true,realizedR:2,signalAtMs:1},
    {terminal:true,realizedR:-1,signalAtMs:2},
    {terminal:true,realizedR:-1,signalAtMs:3},
    {terminal:true,realizedR:1,signalAtMs:4}
  ];
  const s=drawdownStats(trades);
  assert.strictEqual(s.resolved,4);
  assert.strictEqual(s.totalR,1);
  assert.ok(s.maxDrawdownR>=2);
  assert.strictEqual(s.maxLossStreak,2);
})();

(function chaseGuardFormatting(){
  const long=chaseGuard({side:'LONG',entry:10000,stop:9900});
  assert.strictEqual(long.limitEntry,10000);
  assert.strictEqual(long.chasePrice,10005);
  assert.strictEqual(long.boundaryLabel,'追价上限');
  const short=chaseGuard({side:'SHORT',entry:10000,stop:10100});
  assert.strictEqual(short.chasePrice,9995);
  assert.strictEqual(short.boundaryLabel,'追价下限');

  const msg=signalMessage({
    symbol:'BTCUSDT',side:'LONG',mode:'TREND_RETEST',sessionLabel:'London',
    entry:10000,stop:9900,tp1:10100,tp2:10200,plan:'30%@1R · 30%@2R · 40% Runner',
    riskAtr:1.15,signalAtMs:Date.parse('2026-10-02T08:15:00Z')
  });
  assert.ok(msg.includes('✅ 可以进 · BTCUSDT'));
  assert.ok(msg.includes('方向：做多 LONG'));
  assert.ok(msg.includes('杠杆：'));
  assert.ok(msg.includes('数量：'));
  assert.ok(msg.includes('参考入场：10000.0'));
  assert.ok(msg.includes('可进区间：'));
  assert.ok(msg.includes('有效到：'));
})();

(function atrEntryZoneAndBarrierGuard(){
  const s={symbol:'LTCUSDT',side:'LONG',entry:70.39,stop:70.19,atr15:0.30,intelligence:{a15:0.30,entryRoom:{barrier:70.43}}};
  const z=entryZone(s);
  assert.ok(z.valid);
  assert.ok(z.low<70.39);
  assert.ok(z.high>70.39);
  assert.ok(z.high<=70.40);
  const room=barrierRoomAt(s,70.39);
  assert.strictEqual(room.state,'BLOCK');
  assert.strictEqual(entryDecision({...s,entryExpiresAtMs:10*M15,terminal:false,entryConfirmed:false},70.39,M15).state,'BLOCKED_BARRIER');

  const clear={...s,intelligence:{a15:0.30,entryRoom:{barrier:70.90}}};
  const d1=entryDecision({...clear,entryExpiresAtMs:10*M15,terminal:false,entryConfirmed:false},70.39,M15);
  assert.strictEqual(d1.state,'ENTER');
  assert.ok(['GOOD','NORMAL'].includes(d1.priceGrade));
  const d2=entryDecision({...clear,entryExpiresAtMs:10*M15,terminal:false,entryConfirmed:false},70.41,M15);
  assert.strictEqual(d2.state,'DO_NOT_CHASE');
})();

(function lifecycleExpiry(){
  const t={key:'x',symbol:'BTCUSDT',mode:'TREND_RETEST',side:'LONG',entry:100,stop:95,tp1:105,tp2:110,riskDistance:5,signalAtMs:0,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:ENTRY_VALID_MS,terminal:false,entryConfirmed:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,lastOpenTime:0,realizedR:null};
  assert.strictEqual(entryDecision(t,100,ENTRY_VALID_MS+1).state,'EXPIRED');
  assert.ok(lifecycleMessage(t,'EXPIRED').includes('不要追'));
})();

(function lifecycleTp1(){
  const t={key:'y',symbol:'BTCUSDT',mode:'TREND_RETEST',side:'LONG',entry:100,stop:95,tp1:105,tp2:110,riskDistance:5,signalAtMs:M15,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:10*M15,terminal:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,lastOpenTime:0,realizedR:null};
  ensureTradeLifecycle(t);
  const before=lifecycleSnapshot(t);
  updateTrade(t,[c(M15,100,106,99,105)],2*M15);
  const ev=lifecycleEvents(before,t);
  assert.ok(ev.includes('TP1'));
  assert.strictEqual(t.actionState,'MANAGING');
  assert.strictEqual(t.stop,t.entry);
  assert.ok(lifecycleMessage(t,'TP1').includes('止损拉到入场价'));
})();

(function livePriceLifecycle(){
  const t={key:'live',symbol:'ETHUSDT',mode:'TREND_RETEST',side:'LONG',entry:100,stop:99,tp1:101,tp2:102,riskDistance:1,signalAtMs:0,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:10*M15,terminal:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,lastOpenTime:0,realizedR:null};
  let before=lifecycleSnapshot(t);
  updateTradePrice(t,101.01,M15);
  let ev=lifecycleEvents(before,t);
  assert.ok(ev.includes('TP1'));
  assert.strictEqual(t.stop,t.entry);
  assert.strictEqual(t.actionState,'MANAGING');

  before=lifecycleSnapshot(t);
  updateTradePrice(t,102.01,M15+2000);
  ev=lifecycleEvents(before,t);
  assert.ok(ev.includes('TP2'));
  assert.strictEqual(t.actionState,'RUNNER');
})();

(function pendingEntryDecision(){
  const t={key:'pending',symbol:'ETHUSDT',mode:'TREND_RETEST',side:'LONG',entry:100,stop:99,tp1:101,tp2:102,riskDistance:1,signalAtMs:0,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:10*M15,terminal:false,entryConfirmed:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,lastOpenTime:0,realizedR:null};
  assert.strictEqual(entryDecision(t,100.06,M15).state,'DO_NOT_CHASE');
  assert.strictEqual(entryDecision(t,100.03,M15).state,'ENTER');
  assert.strictEqual(entryDecision(t,98.9,M15).state,'INVALID');
  assert.strictEqual(entryDecision(t,100.00,10*M15+1).state,'EXPIRED');
})();

(function unconfirmedTradeDoesNotManageTp(){
  const t={key:'pending2',symbol:'ETHUSDT',mode:'TREND_RETEST',side:'LONG',entry:100,stop:99,tp1:101,tp2:102,riskDistance:1,signalAtMs:0,status:'ACTIONABLE',actionState:'ACTIONABLE',entryExpiresAtMs:10*M15,terminal:false,entryConfirmed:false,tp1Hit:false,tp2Hit:false,runnerActive:false,runnerTrail:null,lastOpenTime:0,realizedR:null};
  updateTradePrice(t,102.5,M15);
  assert.strictEqual(t.tp1Hit,false);
  assert.strictEqual(t.tp2Hit,false);
})();

(function feeAwareExecutionFilter(){
  const tooTight=executionPlan({symbol:'ETHUSDT',side:'LONG',entry:2702.07,stop:2700.17,tp1:2703.97,tp2:2705.87},250);
  assert.strictEqual(tooTight.costOk,false);
  assert.ok(tooTight.costReason!=='OK');
  const workable=executionPlan({symbol:'ETHUSDT',side:'LONG',entry:2700,stop:2680,tp1:2720,tp2:2740},250);
  assert.strictEqual(workable.costOk,true);
  assert.strictEqual(workable.costReason,'OK');
})();

(function retestLifecycleMessages(){
  const a={symbol:'BTCUSDT',side:'LONG',sessionLabel:'London',expiresOpenTime:4*M15};
  assert.ok(armedMessage(a).includes('WAITING RETEST'));
  assert.ok(armEndMessage(a,'EXPIRED').includes('SETUP EXPIRED'));
})();


(function snowballRiskSizing(){
  assert.strictEqual(snowballRisk({intelligence:{score:80}},250,250).riskPct,0.0075);
  assert.strictEqual(snowballRisk({intelligence:{score:92}},250,250).riskPct,0.01);
  assert.strictEqual(snowballRisk({intelligence:{score:95}},235,250).riskPct,0.005);
})();

(function expandedUniverseSizing(){
  assert.strictEqual(qtyStep('DOGEUSDT'),1);
  assert.strictEqual(qtyStep('XRPUSDT'),0.1);
  assert.strictEqual(qtyStep('LINKUSDT'),0.01);
  assert.strictEqual(qtyStep('ZECUSDT'),0.001);
  assert.strictEqual(universeQualityOk({symbol:'ZECUSDT',intelligence:{score:81}}),false);
  assert.strictEqual(universeQualityOk({symbol:'ZECUSDT',intelligence:{score:82}}),true);
  assert.strictEqual(universeQualityOk({symbol:'DOGEUSDT',intelligence:{score:65}}),true);
  const tight=executionPlan({symbol:'ETHUSDT',side:'LONG',entry:100,stop:99.99,tp1:100.5,tp2:101},250);
  assert.ok(tight.leverage>=6&&tight.leverage<=10);
  assert.strictEqual(tight.maxLeverage,10);
})();

console.log('adaptive_hunter_monitor tests: PASS');
