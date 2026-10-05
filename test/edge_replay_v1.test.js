'use strict';
const assert=require('node:assert/strict');
const {evaluate,replay,stats}=require('../research/edge_replay_v1');
const protocol={frozenAt:-100,holdoutStart:0,holdoutEnd:10000,maxQuoteGapMs:1000,stopAmendLatencyMs:50};
const quote=(at,bid,ask,mark=(bid+ask)/2)=>({at,bid,ask,mark});
const base={id:'a',symbol:'TESTUSDT',side:'BUY',decisionAt:0,entryAt:0,entryPrice:100,qty:1,riskAmount:2,
 entryCommission:.02,exitFeeRate:.0002,exitSlippageBps:1,sl:98,tp:104,fundingCost:0,
 noFundingEventDuringPath:true,flatBeforeEntry:true,completeQuoteHistory:true,
 quotes:[quote(0,99.99,100.01),quote(100,102.5,102.6),quote(200,99.9,100),quote(300,97,97.1)]};
const test=(name,f)=>{f();console.log('PASS',name)};
test('Gap through stop realizes worse than -1R',()=>assert.ok(replay(base,'ORIGINAL',protocol).netR < -1.5));
test('Break-even can realize a loss after costs and a gap',()=>{const r=replay(base,'NET_BE_AFTER_1R',protocol);assert.equal(r.reason,'BREAK_EVEN_STOP');assert.ok(r.netR<0);assert.equal(r.exitAt,200);});
test('Paired cost stress uses the same cohort',()=>{const r=evaluate({protocol,trades:[base]});assert.equal(r.pairs.length,1);assert.equal(r.comparison.ORIGINAL_COST_1X.n,r.comparison.NET_BE_AFTER_1R_COST_2X.n);assert.ok(r.comparison.ORIGINAL_COST_2X.expectancyR<r.comparison.ORIGINAL_COST_1X.expectancyR);});
test('Profit protection can cut a later winner',()=>{const t={...base,quotes:[...base.quotes.slice(0,3),quote(300,104.1,104.2)]};assert.ok(replay(t,'ORIGINAL',protocol).netR>1.9);assert.ok(replay(t,'NET_BE_AFTER_1R',protocol).netR<0);});
test('Stop amendment latency prevents impossible earlier activation',()=>{const t={...base,quotes:[base.quotes[0],quote(100,102.5,102.6),quote(120,99.9,100),quote(130,104.1,104.2)]};assert.equal(replay(t,'NET_BE_AFTER_1R',protocol).reason,'TP');});
test('Mark price triggers and executable bid determine different things',()=>{const t={...base,quotes:[quote(0,99,99.1,100),quote(100,97.5,97.6,98.5),quote(200,97,97.1,97.9)]};assert.equal(replay(t,'ORIGINAL',protocol).exitAt,200);});
test('A short closes at ask with adverse slippage',()=>{const t={...base,side:'SELL',sl:102,tp:96,quotes:[quote(0,99.9,100.1),quote(100,102.1,102.2)]};assert.ok(replay(t,'ORIGINAL',protocol).exitPrice>102.2);});
test('Reject extrema-only records rather than fabricate a path',()=>{const r=evaluate({protocol,trades:[{...base,quotes:undefined,mfeR:2,maeR:-1}]});assert.equal(r.status,'INSUFFICIENT_DATA');assert.equal(r.excluded[0].reason,'QUOTE_PATH_REQUIRED');});
test('Reject sparse paths',()=>{const r=evaluate({protocol,trades:[{...base,quotes:[base.quotes[0],quote(2000,97,97.1)]}]});assert.equal(r.excluded[0].reason,'QUOTE_GAP');});
test('Reject reversed timestamps',()=>{const r=evaluate({protocol,trades:[{...base,quotes:base.quotes.slice().reverse()}]});assert.equal(r.excluded[0].reason,'NON_CHRONOLOGICAL_QUOTES');});
test('Exclude decisions predating the untouched holdout',()=>assert.equal(evaluate({protocol,trades:[{...base,decisionAt:-1}]}).excluded[0].reason,'OUTSIDE_FROZEN_HOLDOUT'));
test('Reject a protocol frozen after testing started',()=>assert.throws(()=>evaluate({protocol:{...protocol,frozenAt:1},trades:[base]}),/INVALID_FROZEN_PROTOCOL/));
test('Report unresolved comparisons instead of dropping them silently',()=>{const r=evaluate({protocol,trades:[{...base,quotes:base.quotes.slice(0,2)}]});assert.equal(r.pairs.length,0);assert.equal(r.excluded[0].reason,'INCOMPLETE_PAIRED_OUTCOMES');assert.equal(r.exclusionRate,1);});
test('Funding requires time-resolved accounting',()=>assert.equal(evaluate({protocol,trades:[{...base,fundingCost:1}]}).excluded[0].reason,'FUNDING_PATH_REQUIRED'));
test('High win rate can still mean negative expectancy',()=>{const r=stats([.1,.1,.1,-1].map((netR,i)=>({netR,entryAt:i,exitAt:i})));assert.equal(r.winRate,.75);assert.ok(r.expectancyR<0);});
test('Duplicate trade IDs fail',()=>assert.throws(()=>evaluate({protocol,trades:[base,base]}),/DUPLICATE_TRADE_ID/));
console.log('16 offline replay checks passed. Synthetic fixtures are not strategy-performance evidence.');
