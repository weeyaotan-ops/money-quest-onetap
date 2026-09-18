'use strict';
const assert=require('node:assert/strict');
const {estimate,evaluate,wilson}=require('../hunter_win_quality_v1');
const {HunterLiveGateV1}=require('../hunter_live_gate_v1');
const now=Date.UTC(2026,8,18,12);
const candidate={edge:'BREAKOUT_RETEST',timeframe:'5m',side:'BUY',_actualNetRR:1.5};
function rows(n,r){return Array.from({length:n},(_,i)=>({id:String(i),closedAt:new Date(now-(n-i)*1000).toISOString(),actualR:typeof r==='function'?r(i):r,edge:'BREAKOUT_RETEST',timeframe:'5m',side:'BUY'}))}
assert.deepEqual(wilson(0,0),{low:0,high:1});
assert.equal(estimate(candidate,[],now).verdict,'UNPROVEN');
assert.equal(estimate(candidate,rows(4,2),now).verdict,'UNPROVEN');
const weak=estimate(candidate,rows(40,i=>i%4===0?1.5:-1),now);
assert.equal(weak.verdict,'UNPROVEN');assert.ok(weak.expectedR<0);
const strong=estimate(candidate,rows(80,i=>i%5===0?-1:1.5),now);
assert.equal(strong.verdict,'SUPPORTED');assert.equal(strong.mode,'SHADOW_ONLY');
assert.equal(strong.liveExecutionChanged,false);assert.equal(strong.calibrated,false);
// A high win rate with rare catastrophic losses must not earn support.
assert.equal(estimate(candidate,rows(80,i=>i%10===0?-20:1),now).verdict,'UNPROVEN');
// Future results and missing labels cannot leak into the estimate.
const h=rows(40,i=>i%3===0?2:-1),original=estimate(candidate,h,now);
assert.deepEqual(estimate(candidate,[...h,...rows(100,20).map(x=>({...x,closedAt:new Date(now+1000).toISOString()})),{actualR:null,closedAt:new Date(now-1).toISOString()}],now),original);
assert.deepEqual(estimate(candidate,h.slice().reverse(),now),original);
const labelled=rows(2, i=>i?1.5:-1).map(t=>({...t,winQuality:{...strong,asOf:new Date(now-10000).toISOString()}}));
const result=evaluate(labelled);
assert.equal(result.baseline.n,2);assert.equal(result.supported.n,2);
assert.equal(result.readyForReview,false);assert.equal(result.automaticPromotion,false);
assert.ok(result.brierScore>0&&result.brierScore<1);
assert.equal(evaluate(labelled.map(t=>({...t,winQuality:{...strong,asOf:new Date(now+1).toISOString()}}))).baseline.n,0);
// Predictions survive the existing decision -> real close -> report lifecycle.
const g=new HunterLiveGateV1();
const d=g.scoreCandidate({id:'forward',...candidate});
assert.equal(d.winQuality.mode,'SHADOW_ONLY');
g.ingestClosedTrade({id:'forward',actualR:-1,closedAt:new Date(Date.parse(d.at)+1000).toISOString()});
assert.equal(g.report().winQuality.baseline.n,1);
const restored=new HunterLiveGateV1();restored.history=JSON.parse(JSON.stringify(g.history));
assert.deepEqual(restored.report().winQuality,g.report().winQuality);
const ordered=new HunterLiveGateV1({recentWindow:2});
ordered.ingestClosedTrade({id:'new',actualR:2,closedAt:new Date(now-1000).toISOString()});
ordered.ingestClosedTrade({id:'old',actualR:-1,closedAt:new Date(now-3000).toISOString()});
ordered.ingestClosedTrade({id:'middle',actualR:1,closedAt:new Date(now-2000).toISOString()});
assert.deepEqual(ordered.history.map(x=>x.id),['old','middle','new']);
assert.equal(ordered.report().recent.totalR,3);
console.log('HUNTER_WIN_QUALITY_V1_PASS');
