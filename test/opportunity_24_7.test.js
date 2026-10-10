'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tapTestDir=fs.mkdtempSync(path.join(os.tmpdir(),'htr-tap-test-'));
process.env.HTR_PULSE_TICKET_STORE=path.join(tapTestDir,'tickets.json');
const oneTap=require('../hunter_core_v1/pulse_one_tap');
const {signal,explainSignal,recordDiagnostic,diagnosis,rows,message,commandAnswer,rrAtLevel,formatReachedR,selectAltcoins,earlyPool,analyzeEarlyBars,selectEarlyMovers}=require('../hunter_core_v1/opportunity_24_7');
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


// Dual radar: Early Movers require mild 24h change PLUS fresh H1 volume near a
// 12-hour breakout. Hot Movers already filter high-velocity price changes.
const earlySymbols=['TIAUSDT','QUIETUSDT','LATEUSDT','NEWALTUSDT','WIDEALTUSDT'];
const eNow=Date.parse('2026-10-09T12:00:00Z');
const earlyExchange={symbols:earlySymbols.map(symbol=>({
 symbol,quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',
 onboardDate:symbol==='NEWALTUSDT'?eNow-3600000:eNow-100*86400000
}))};
const earlyTicker=earlySymbols.map(symbol=>({symbol,
 quoteVolume:'64000000',priceChangePercent:'4.2',count:400000}));
const earlyBooks=earlySymbols.map(symbol=>({symbol,bidPrice:'1',
 askPrice:symbol==='WIDEALTUSDT'?'1.01':'1.001'}));
const barsGood=Array.from({length:34},(_,i)=>[
 eNow-(35-i)*3600000,100,101,99,100,100
]);
// Last COMPLETED H1 candle surged in volume close to resistance.
barsGood[barsGood.length-1]=[eNow-2*3600000,100,101.3,99.8,101,280];
const barsQuiet=barsGood.map((x,i)=>i===barsGood.length-1?[...x.slice(0,5),80]:x);
const bySymbol={TIAUSDT:barsGood,QUIETUSDT:barsQuiet,LATEUSDT:barsGood,
 NEWALTUSDT:barsGood,WIDEALTUSDT:barsGood};
assert.equal(analyzeEarlyBars(barsGood,eNow).side,'WATCH LONG');
assert.equal(analyzeEarlyBars(barsQuiet,eNow),null);
assert.equal(earlyPool(earlyTicker,earlyExchange,earlyBooks,['BTCUSDT'],eNow)
 .some(x=>x.symbol==='NEWALTUSDT'),false);
assert.equal(earlyPool(earlyTicker,earlyExchange,earlyBooks,['BTCUSDT'],eNow)
 .some(x=>x.symbol==='WIDEALTUSDT'),false);
const early=selectEarlyMovers(earlyTicker,earlyExchange,earlyBooks,bySymbol,
 ['BTCUSDT'],eNow,8);
assert.deepEqual(early.map(x=>x.symbol),['LATEUSDT','TIAUSDT']);
assert(early.every(x=>x.volumeRatio>=1.2&&x.side==='WATCH LONG'));
assert.deepEqual(selectEarlyMovers(earlyTicker,earlyExchange,earlyBooks,bySymbol,
 ['TIAUSDT','LATEUSDT'],eNow,8),[]);
assert.deepEqual(selectEarlyMovers(
 [{symbol:'TIAUSDT',quoteVolume:'64000000',priceChangePercent:'34',count:400000}],
 earlyExchange,earlyBooks,bySymbol,[],eNow,8),[]);
const earlyShort=barsGood.map(x=>[...x]);
earlyShort[earlyShort.length-1]=[eNow-2*3600000,100,100.3,98.7,99,270];
assert.equal(analyzeEarlyBars(earlyShort,eNow).side,'WATCH SHORT');
const dualState={...scoreState,universe:{
 symbols:['BTCUSDT','OGNUSDT','TIAUSDT'],
 hot:['OGNUSDT'],early:['TIAUSDT'],altcoins:['OGNUSDT','TIAUSDT'],
 hotDetails:[{symbol:'OGNUSDT',changePct:35}],
 earlyDetails:[{symbol:'TIAUSDT',changePct:4.2,side:'WATCH LONG',volumeRatio:2.8}]
}};
assert.match(commandAnswer('/scan',dualState),/Early Movers · WATCH ONLY \(1\)/);
assert.match(commandAnswer('/scan',dualState),/TIAUSDT WATCH LONG.*H1 volume ×2.8/);
assert.match(commandAnswer('/scan',dualState),/Hot Movers · WATCH ONLY \(1\): OGNUSDT/);
assert.match(commandAnswer('/status',dualState),/Early watch: 1 \| Hot watch: 1/);
assert.match(commandAnswer('/signals',dualState),/No active confirmed signals/);


// Regression: a liquid Early pre-screen passes its market eligibility even if
// the extra hourly watch badge does not. It should still be scanned for M15.
assert(earlyPool(earlyTicker,earlyExchange,earlyBooks,[],eNow)
 .some(x=>x.symbol==='QUIETUSDT'));
assert.equal(selectEarlyMovers(earlyTicker,earlyExchange,earlyBooks,
 {QUIETUSDT:barsQuiet},['TIAUSDT','LATEUSDT'],eNow).length,0);

// The formal signal remains byte-for-byte identical in logic: diagnostics must
// agree with it on qualified bars and never send stale alerts.
const dNow=Date.parse('2026-10-09T12:15:00Z');
const m15Good=Array.from({length:100},(_,i)=>({
 t:dNow-(100-i)*900000,o:100,h:101,l:99,c:100,v:100
}));
m15Good[m15Good.length-1]={t:dNow-900000,o:100,h:102,l:99.8,c:101.8,v:260};
const h1Good=Array.from({length:100},(_,i)=>({
 t:dNow-(100-i)*3600000,o:90+i*0.2,h:91+i*0.2,
 l:89+i*0.2,c:90+i*0.2,v:100
}));
const confirmed=signal('TESTUSDT',m15Good,h1Good,dNow+1000);
assert(confirmed&&confirmed.side==='LONG');
assert.equal(explainSignal('TESTUSDT',m15Good,h1Good,dNow+1000).reason,'QUALIFIED');
assert.equal(signal('TESTUSDT',m15Good,h1Good,dNow+5*60000),null);
const diagState={};
recordDiagnostic(diagState,'TESTUSDT',m15Good,h1Good,dNow+5*60000);
recordDiagnostic(diagState,'TESTUSDT',m15Good,h1Good,dNow+6*60000);
assert.equal(diagState.diagnostics.samples.length,1);
assert.equal(diagState.diagnostics.samples[0].reason,'MISSED_AGE');
assert.equal(diagnosis(diagState,dNow+6*60000).missed,1);
assert.match(commandAnswer('/scan',{...scoreState,diagnostics:diagState.diagnostics},dNow+6*60000),/Missed alert window: 1/);
const noBreakout=m15Good.map(x=>({...x}));
noBreakout[noBreakout.length-1]={...noBreakout.at(-1),c:100};
assert.equal(explainSignal('TESTUSDT',noBreakout,h1Good,dNow+1000).reason,'NO_M15_BREAKOUT');
const noVol=m15Good.map(x=>({...x}));
noVol[noVol.length-1]={...noVol.at(-1),v:10};
assert.equal(explainSignal('TESTUSDT',noVol,h1Good,dNow+1000).reason,'LOW_VOLUME');


// One-Tap approval: 5 USDT max initial margin / 40x, preserving the signal.
// This test never issues external requests or a live order.
const tapSym={filters:[
 {filterType:'MARKET_LOT_SIZE',minQty:'1',stepSize:'1',maxQty:'4000000'},
 {filterType:'LOT_SIZE',minQty:'1',stepSize:'1',maxQty:'40000000'},
 {filterType:'MIN_NOTIONAL',notional:'5'},
 {filterType:'PRICE_FILTER',tickSize:'0.000001'}]};
// HYPE post-entry regression: Binance position selection must check side and
// not claim an exit succeeded from an ACK without a position re-query.
assert.equal(oneTap.locatePosition([
 {symbol:'HYPEUSDT',positionSide:'BOTH',positionAmt:'-1.8',marginType:'isolated',leverage:'31'}
], 'HYPEUSDT','BOTH','SHORT').leverage,'31');
assert.equal(oneTap.locatePosition([
 {symbol:'HYPEUSDT',positionSide:'BOTH',positionAmt:'-1.8'}
], 'HYPEUSDT','BOTH','LONG'),undefined);
assert.equal(oneTap.locatePosition([
 {symbol:'HYPEUSDT',positionSide:'SHORT',positionAmt:'-1.8'}
], 'HYPEUSDT','SHORT','SHORT').positionAmt,'-1.8');
const executorText=fs.readFileSync(path.join(__dirname,'../hunter_core_v1/pulse_one_tap.js'),'utf8');
const stopStatement=executorText.indexOf("sl=await request('POST','/fapi/v1/algoOrder'");
const verifyStatement=executorText.indexOf("const verified=await verifyLiqAfterFill(");
assert(stopStatement>0&&verifyStatement>stopStatement,'SL must be placed before post-fill liquidation lookup');
assert.match(executorText,/newOrderRespType:'RESULT',newClientOrderId:'HTRF'/);
assert.match(executorText,/flattened=await verifyFlat/);
assert.equal(oneTap.MARGIN,5);
assert.equal(oneTap.LEVERAGE,40);
assert.equal(oneTap.LIQ_BUFFER_RATE,0.005);
const brackets=oneTap.checkedBrackets([{symbol:'OGNUSDT',brackets:[
 {notionalFloor:0,notionalCap:100000,maintMarginRatio:'0.005',initialLeverage:40}
]}],'OGNUSDT');
assert.throws(()=>oneTap.checkedBrackets([], 'OGNUSDT'),/brackets unavailable/);
const testInfo={...tapSym,filters:[
 {filterType:'MARKET_LOT_SIZE',minQty:'1',stepSize:'1',maxQty:'4000000'},
 {filterType:'LOT_SIZE',minQty:'1',stepSize:'1',maxQty:'40000000'},
 {filterType:'MIN_NOTIONAL',notional:'5'},
 {filterType:'PRICE_FILTER',tickSize:'0.000001'}
]};
const tightLong={symbol:'OGNUSDT',side:'LONG',entry:1,stop:.992,tp1:1.008,tp2:1.016};
const wideLong={...tightLong,stop:.97};
const shortWide={...tightLong,side:'SHORT',stop:1.03,tp1:.97,tp2:.94};
const high=oneTap.chooseSafeLeverage(tightLong,1,testInfo,brackets);
assert.equal(high.leverage,40,'tight stop can still use 40x');
assert(high.notional<=200&&high.headroom>0);
const lower=oneTap.chooseSafeLeverage(wideLong,1,testInfo,brackets);
assert(lower.leverage<40&&lower.leverage>1,'wide stop must reduce leverage');
assert(Number(lower.quantity)*1/lower.leverage<=5);
assert(oneTap.stopMarginCheck(wideLong,1.004,Number(lower.quantity),
 lower.leverage,brackets).safe);
assert(!oneTap.stopMarginCheck(wideLong,1.004,199,40,brackets).safe);
const lowerShort=oneTap.chooseSafeLeverage(shortWide,1,testInfo,brackets);
assert(lowerShort.leverage<40,'SHORT wide stop also reduces leverage');
assert(oneTap.stopMarginCheck(shortWide,.996,Number(lowerShort.quantity),
 lowerShort.leverage,brackets).safe);
assert.throws(()=>oneTap.chooseSafeLeverage({...tightLong,stop:.1},1,
 testInfo,brackets),/No leverage 1-40x/,'reject when no leverage is safe');
assert.throws(()=>oneTap.chooseSafeLeverage(wideLong,1,testInfo,[]),
 /No leverage 1-40x/,'fail closed if maintenance brackets missing');

assert.equal(oneTap.clampQty(0.05,tapSym).quantity,'4000');
assert.equal(oneTap.clampQty(0.05,tapSym).notional,200);
assert.equal(oneTap.roundTrigger(0.0500003,tapSym),'0.05');
assert.throws(()=>oneTap.clampQty(250,tapSym),/quantity\/notional rules/);
const tapNow=Date.now();
const sampleTicket=oneTap.newTicket({
 symbol:'OGNUSDT',side:'LONG',entry:0.05,stop:0.049,
 tp1:0.051,tp2:0.052,at:tapNow,key:'OGNUSDT|LONG|'+tapNow},tapNow);
oneTap.validTicket(sampleTicket,tapNow+1000);
assert.equal(oneTap.TTL_MS,180000);
assert.equal(oneTap.MAX_CANDLE_AGE_MS,300000);
oneTap.validTicket(sampleTicket,tapNow+62000);
assert.throws(()=>oneTap.validTicket(sampleTicket,tapNow+181000),/expired/);
oneTap.storeTicket(sampleTicket);
assert.throws(()=>oneTap.storeTicket(oneTap.newTicket({
 symbol:'OGNUSDT',side:'LONG',entry:0.05,stop:0.049,
 tp1:0.051,tp2:0.052,at:tapNow,key:sampleTicket.key},tapNow)),/already exists/);
const claimed=oneTap.claimTicket(sampleTicket.id);
assert.equal(claimed.status,'PROCESSING');
assert.throws(()=>oneTap.claimTicket(sampleTicket.id),/already used/);
oneTap.finishTicket(sampleTicket.id,'FAILED_NO_RETRY','dry-run test');
assert.throws(()=>oneTap.claimTicket(sampleTicket.id),/already used/);
assert.throws(()=>oneTap.validTicket({...sampleTicket,expiresAt:tapNow-1},tapNow),/expired/);
assert.throws(()=>oneTap.validTicket({...sampleTicket,stop:0.06},tapNow),/invalid/);
fs.rmSync(tapTestDir,{recursive:true,force:true});

// Guard against accidental use of legacy conditional order endpoints or a
// missing ambiguous-acknowledgement reconciliation code path.
const liveSource=fs.readFileSync(path.join(__dirname,'../hunter_core_v1/pulse_one_tap.js'),'utf8');
assert.match(liveSource,/\/fapi\/v1\/algoOrder/);
assert.match(liveSource,/ENTRY ACK UNCERTAIN/);
assert.match(liveSource,/\/fapi\/v1\/openOrders/);


// Pure-signal risk advisor: margin follows setup quality and loss follows SL.
// There is intentionally NO arbitrary 2 USDT stop-loss cap.
const advisor=require('../hunter_core_v1/pulse_risk_advisor');
assert.equal(advisor.marginForScore(22),3);
assert.equal(advisor.marginForScore(56),5);
assert.equal(advisor.marginForScore(70),7);
assert.equal(advisor.marginForScore(90),10);
assert(advisor.scoreSetup({volumeRatio:2.5,bodyRatio:.83,netR:1.82,extensionAtr:.05,trendSpread:.02})>
 advisor.scoreSetup({volumeRatio:1.25,bodyRatio:.52,netR:1.52,extensionAtr:.6,trendSpread:.001}));
const advisorySignal={symbol:'TESTUSDT',side:'LONG',entry:100,stop:99,
 tp1:101,tp2:102,at:Date.now(),setupScore:92};
const advisoryMarket={markPrice:100,markTime:Date.now(),exchange:{symbols:[{
 symbol:'TESTUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',filters:[
 {filterType:'MARKET_LOT_SIZE',minQty:'.001',stepSize:'.001',maxQty:'1000000'},
 {filterType:'LOT_SIZE',minQty:'.001',stepSize:'.001',maxQty:'1000000'},
 {filterType:'MIN_NOTIONAL',notional:'5'}
 ]}]},brackets:[{symbol:'TESTUSDT',brackets:[
 {notionalFloor:'0',notionalCap:'50000',maintMarginRatio:'.005',initialLeverage:40}
 ]}]};
const highRisk=advisor.calculate(advisorySignal,advisoryMarket,advisorySignal.at+1000);
assert.equal(highRisk.status,'CHECK BINANCE');
assert.equal(highRisk.margin,10);
assert(highRisk.leverage<=40&&highRisk.leverage>=1);
assert(highRisk.estimatedLoss>2,'Risk follows actual stop distance, not a forced 2U ceiling');
assert(highRisk.quantity>0&&highRisk.notional>0&&highRisk.modelBuffer>0);
assert(highRisk.liqCheckThreshold<advisorySignal.stop);
const smallerRisk=advisor.calculate({...advisorySignal,setupScore:33},advisoryMarket,advisorySignal.at+1000);
assert.equal(smallerRisk.status,'CHECK BINANCE');
assert.equal(smallerRisk.margin,3);
const shortSig={...advisorySignal,side:'SHORT',stop:101,tp1:99,tp2:98};
const shortRisk=advisor.calculate(shortSig,advisoryMarket,shortSig.at+1000);
assert.equal(shortRisk.status,'CHECK BINANCE');
assert(shortRisk.liqCheckThreshold>shortSig.stop);
assert.equal(advisor.calculate(advisorySignal,{...advisoryMarket,brackets:[]},advisorySignal.at+1000).status,'NO TRADE');
assert.equal(advisor.calculate(advisorySignal,{...advisoryMarket,markPrice:101},advisorySignal.at+1000).status,'NO TRADE');
assert.equal(advisor.calculate(advisorySignal,advisoryMarket,advisorySignal.at+4*60000).status,'NO TRADE');
assert.equal(advisor.calculate({...advisorySignal,stop:80},advisoryMarket,advisorySignal.at+1000).status,'NO TRADE');
// Production scanner must not import legacy one-tap execution or submit an order.
const advisoryScannerSource=fs.readFileSync(path.join(__dirname,'../hunter_core_v1/opportunity_24_7.js'),'utf8');
assert.doesNotMatch(advisoryScannerSource,/require\(['"]\.\/pulse_one_tap['"]\)/);
assert.doesNotMatch(advisoryScannerSource,/\/fapi\/v1\/order|\/fapi\/v1\/algoOrder|execute\(ticket\)/);
assert.match(advisoryScannerSource,/riskAdvisor\.advise\(s\)/);
assert.match(advisoryScannerSource,/NO TRADE/);

console.log('OPPORTUNITY_SCANNER_TEST_PASS');
