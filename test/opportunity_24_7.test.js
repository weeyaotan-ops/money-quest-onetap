'use strict';
const assert=require('node:assert/strict');
const {signal,message,rows,commandAnswer,rrAtLevel,formatReachedR,selectAltcoins}=require('../hunter_core_v1/opportunity_24_7');
const now=Date.now();
assert.deepEqual(rows([['0','1','2','0.5','1.5','100']])[0],{t:0,o:1,h:2,l:0.5,c:1.5,v:100});
assert.equal(signal('BTCUSDT',[],[],now),null);
const h1=Array.from({length:110},(_,i)=>({t:now-(111-i)*3600000,o:70+i*0.3,h:71+i*0.3,l:69+i*0.3,c:70+i*0.3,v:100}));
const m15=Array.from({length:110},(_,i)=>({t:now-(110-i)*900000-1000,o:90+i*0.1,h:90.3+i*0.1,l:89.8+i*0.1,c:90+i*0.1,v:100}));
const output=signal('BTCUSDT',m15,h1,now);
assert(output===null||['LONG','SHORT'].includes(output.side));
assert.match(message({symbol:'BTCUSDT',side:'LONG',entry:83000,stop:82500,tp1:83500,tp2:84000,netR:1.8}),/83000/);
// RR reporting must be gross reward/risk and must never claim executed PnL.
const levels={entry:114.51,stop:115.2185,tp1:113.8015,tp2:113.093,side:'SHORT',symbol:'SOLUSDT',notifiedAt:1};
assert.equal(rrAtLevel(levels,levels.tp1).toFixed(2),'1.00');
assert.equal(rrAtLevel(levels,levels.tp2).toFixed(2),'2.00');
assert.equal(rrAtLevel({...levels,side:'LONG',entry:100,stop:98},104),2);
assert.equal(rrAtLevel({...levels,stop:levels.entry},levels.tp2),null);
assert.equal(formatReachedR({...levels,tp1Hit:true,tp2Hit:false,slHit:false}),'+1.00R');
assert.equal(formatReachedR({...levels,tp1Hit:true,tp2Hit:true,slHit:false}),'+2.00R');
assert.equal(formatReachedR({...levels,tp1Hit:false,tp2Hit:false,slHit:true}),'SL reached (−1.00R)');
assert.equal(formatReachedR({...levels,tp1Hit:false,tp2Hit:false,slHit:false}),'—');
const scoreState={
 lastScan:Date.now(),errors:0,
 scorecard:{trades:[
  {...levels,key:'a',status:'TP2',tp1Hit:true,tp2Hit:true,slHit:false},
  {...levels,key:'b',side:'SHORT',symbol:'LINKUSDT',status:'OPEN',
   tp1Hit:false,tp2Hit:false,slHit:false,notifiedAt:2}
 ]}
};
const out=commandAnswer('/status',scoreState);
assert.match(out,/TP1 hit: 1 \(1R target\)/);
assert.match(out,/TP2 hit: 1 \(2R target\)/);
assert.match(out,/SOLUSDT SHORT.*RR \+2\.00R/);
assert.match(out,/LINKUSDT SHORT.*RR —.*Tracking/);
assert.match(out,/no simulated exits or PnL/);
assert.match(commandAnswer('/scan',scoreState),/26 coins/);
assert.match(commandAnswer('/signals',scoreState),/No active confirmed signals/);


// Alt radar must accept a liquid OGNUSDT mover, not every high percentage gainer.
const at=Date.parse('2026-10-09T09:00:00Z');
const candidates=['OGNUSDT','THINUSDT','WIDEUSDT','NEWUSDT','STOPPEDUSDT'];
const exchange={symbols:candidates.map(symbol=>({symbol,quoteAsset:'USDT',
  contractType:'PERPETUAL',status:symbol==='STOPPEDUSDT'?'BREAK':'TRADING',
  onboardDate:symbol==='NEWUSDT'?at-3600000:at-100*86400000}))};
const tickers=candidates.map(symbol=>({symbol,
  quoteVolume:symbol==='THINUSDT'?'800000':'75000000',
  priceChangePercent:'45',count:75000}));
const books=candidates.map(symbol=>({symbol,bidPrice:'1.000',askPrice:symbol==='WIDEUSDT'?'1.02':'1.001'}));
const dynamic=selectAltcoins(tickers,exchange,books,['BTCUSDT'],at,10);
assert.deepEqual(dynamic.map(x=>x.symbol),['OGNUSDT']);
assert.deepEqual(selectAltcoins(tickers,exchange,books,['BTCUSDT','OGNUSDT'],at,10),[]);
const dynamicState={...scoreState,universe:{symbols:['BTCUSDT','OGNUSDT'],altcoins:['OGNUSDT']}};
assert.match(commandAnswer('/status',dynamicState),/Altcoin radar: 1 active movers/);
assert.match(commandAnswer('/scan',dynamicState),/Watchlist \(not entry signals\): OGNUSDT/);

console.log('OPPORTUNITY_SCANNER_TEST_PASS');
