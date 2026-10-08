'use strict';
const assert=require('node:assert/strict');
const {evaluate,detect}=require('../hunter_core_v1/v21_shadow_opportunity');
const base={symbol:'LINKUSDT',side:'LONG',mode:'BREAKOUT_DIRECT',entry:100,stop:99,tp1:101,tp2:102,feeRate:0.0005,slipRate:0.0002};
const good=evaluate(base);
assert.equal(good.status,'SHADOW_CANDIDATE');
assert(good.netR>1.15);
assert.equal(evaluate({...base,tp1:99.5}).reason,'BAD_STRUCTURE');
assert.equal(evaluate({...base,side:'SHORT'}).reason,'BAD_STRUCTURE');
assert.equal(evaluate({...base,feeRate:0.02}).reason,'NET_EDGE_TOO_LOW');
assert.equal(evaluate({...base,timestamp:200,expiresAt:200}).status,'EXPIRED');
const t=1800000, M=900000;
const candles=[
 {openTime:t-4*M,open:99.3,high:99.6,low:99,close:99.4},
 {openTime:t-3*M,open:99.4,high:99.7,low:99.2,close:99.5},
 {openTime:t-2*M,open:99.5,high:99.7,low:99.3,close:99.6},
 {openTime:t-M,open:99.6,high:99.9,low:99.4,close:99.8},
 {openTime:t,open:99.8,high:100.65,low:99.72,close:100.5}
];
const config={symbol:'LINKUSDT',candles,box:{high:100,low:98,activeFrom:t-M,activeUntil:t+4*M},
 regime:{type:'TREND',side:'LONG'},atr15:1,vwap:99.5,now:t+M};
const signals=detect(config);
assert(signals.some(x=>x.mode==='BREAKOUT_DIRECT'));
assert(!detect({...config,now:t+4*M}).length);
assert(!detect({...config,vwap:101}).length);
assert(!detect({...config,regime:{type:'RANGE',side:'LONG'}}).length);
console.log('V2.1 shadow opportunity tests passed');
