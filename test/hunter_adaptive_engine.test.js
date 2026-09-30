'use strict';

const assert = require('assert');
const {
  classifyRegime, sessionBox, trendBreakout, confirmRetest, rangeSweep,
  tradeFromSignal, updateTrendTrade, updateRangeTrade, dailyRealizedR, correlationBlock
} = require('../hunter_adaptive_engine');

const M15=15*60*1000, H4=4*60*60*1000;

function c(t,o,h,l,cl,v=100){return {openTime:t,open:o,high:h,low:l,close:cl,volume:v,closeTime:t+M15-1};}
function h4Trend(end,down=false){
  const out=[];let p=down?200:100;
  for(let i=0;i<70;i+=1){
    const o=p;p+=down?-0.8:0.8;
    out.push({openTime:end-(70-i)*H4,open:o,high:Math.max(o,p)+1,low:Math.min(o,p)-1,close:p,volume:1000});
  }
  return out;
}
function h4Range(end){
  const out=[];
  for(let i=0;i<70;i+=1){
    const p=100+(i%2?0.3:-0.3);
    out.push({openTime:end-(70-i)*H4,open:100,high:101,low:99,close:p,volume:1000});
  }
  return out;
}

(function regimeTrend(){
  const end=Date.parse('2026-09-30T07:30:00Z');
  const m=[];for(let i=0;i<40;i++)m.push(c(end-(40-i)*M15,100,101,99,100));
  const r=classifyRegime(h4Trend(end,false),m);
  assert.strictEqual(r.type,'TREND_UP');
})();

(function regimeRange(){
  const end=Date.parse('2026-09-30T07:30:00Z');
  const m=[];for(let i=0;i<40;i++)m.push(c(end-(40-i)*M15,100,101,99,100));
  const r=classifyRegime(h4Range(end),m);
  assert.ok(['RANGE','CHAOS'].includes(r.type));
})();

(function trendBreakoutThenRetest(){
  const base=Date.parse('2026-09-30T00:00:00Z');
  const bars=[];
  for(let t=base;t<Date.parse('2026-09-30T07:00:00Z');t+=M15)bars.push(c(t,100,101,99,100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'),100,105,99,103));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'),103,104,100,102));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'),104.8,107,104.4,106));
  const snap={symbol:'BTCUSDT',provider:'TEST',candles15m:bars,candles4h:h4Trend(Date.parse('2026-09-30T07:30:00Z'))};
  const regime={...classifyRegime(snap.candles4h,snap.candles15m),atr15:2};
  const session={id:'LONDON',label:'London',tz:'Europe/London',hour:8,minute:0};
  const p=trendBreakout(snap,session,regime,Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(p && !p.blocked);
  bars.push(c(Date.parse('2026-09-30T07:45:00Z'),105.2,106.3,104.7,105.8));
  const out=confirmRetest(snap,p,regime,Date.parse('2026-09-30T08:01:00Z'));
  assert.ok(out && out.key);
  assert.strictEqual(out.kind,'TREND');
  assert.strictEqual(out.side,'LONG');
  assert.ok(out.stop<out.entry);
})();

(function rangeSweepWorks(){
  const base=Date.parse('2026-09-30T00:00:00Z');
  const bars=[];
  for(let t=base;t<Date.parse('2026-09-30T07:00:00Z');t+=M15)bars.push(c(t,100,101,99,100));
  bars.push(c(Date.parse('2026-09-30T07:00:00Z'),100,105,99,102));
  bars.push(c(Date.parse('2026-09-30T07:15:00Z'),102,104,100,101));
  bars.push(c(Date.parse('2026-09-30T07:30:00Z'),101,102,98.5,101.5));
  const snap={symbol:'XAUUSD',provider:'TEST',candles15m:bars,candles4h:h4Range(Date.parse('2026-09-30T07:30:00Z'))};
  const regime={type:'RANGE',label:'区间',atr15:2,adx:15};
  const session={id:'LONDON',label:'London',tz:'Europe/London',hour:8,minute:0};
  const s=rangeSweep(snap,session,regime,Date.parse('2026-09-30T07:46:00Z'));
  assert.ok(s && !s.blocked);
  assert.strictEqual(s.side,'LONG');
  assert.ok(s.finalTarget>s.entry);
})();

(function trendTradePartialsAndRunner(){
  const s={
    key:'t',symbol:'BTCUSDT',side:'LONG',kind:'TREND',signalAtMs:1000,candleOpenTime:0,
    entry:100,stop:95,riskDistance:5,tp1:105,tp2:110
  };
  const t=tradeFromSignal(s);
  const bars=[
    c(M15,100,106,100.5,105),
    c(2*M15,105,111,104,110),
    c(3*M15,110,113,109,112),
    c(4*M15,112,112.5,108,109)
  ];
  updateTrendTrade(t,bars);
  assert.strictEqual(t.tp1Hit,true);
  assert.strictEqual(t.tp2Hit,true);
  assert.ok(['RUNNER','RUNNER_EXIT'].includes(t.status));
})();

(function rangeTradeResolves(){
  const s={
    key:'r',symbol:'XAUUSD',side:'LONG',kind:'RANGE',signalAtMs:1000,candleOpenTime:0,
    entry:100,stop:98,riskDistance:2,tp1:102,finalTarget:104,targetR:2
  };
  const t=tradeFromSignal(s);
  updateRangeTrade(t,[c(M15,100,102.5,99.5,102),c(2*M15,102,104.2,101,104)]);
  assert.strictEqual(t.terminal,true);
  assert.ok(t.finalR>1);
})();

(function killSwitchAndCorrelation(){
  const now=Date.now();
  const state={trades:{
    a:{signalAtMs:now,finalR:-1,terminal:true},
    b:{signalAtMs:now,finalR:-1.2,terminal:true},
    c:{symbol:'BTCUSDT',side:'LONG',terminal:false}
  }};
  assert.ok(dailyRealizedR(state,now)<=-2);
  const reason=correlationBlock(state,{symbol:'ETHUSDT',side:'LONG'});
  assert.ok(reason);
})();

console.log('hunter_adaptive_engine tests: PASS');
