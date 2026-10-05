'use strict';
const assert=require('assert');
const I=require('../hunter_core_v1/intelligence');
const M15=15*60*1000,H4=4*60*60*1000;
function c(t,o,h,l,cl,v=100){return {openTime:t,open:o,high:h,low:l,close:cl,volume:v};}

(function swingsAreConfirmed(){
  const xs=[c(0,10,11,9,10),c(M15,10,12,9.5,11),c(2*M15,11,15,10,14),c(3*M15,14,13,10.5,12),c(4*M15,12,12.5,10,11)];
  const s=I.confirmedSwings(xs,1,1);
  assert.ok(s.highs.some(x=>x.price===15));
})();

(function liquidityLevels(){
  const xs=[]; for(let i=0;i<60;i++){const p=100+Math.sin(i/3)*2;xs.push(c(i*M15,p,p+1,p-1,p+0.2));}
  const l=I.nearestLiquidity(xs,100);
  assert.ok(l.bsl===null||l.bsl>100);
  assert.ok(l.ssl===null||l.ssl<100);
})();

(function overlappingZonesAreInvalid(){
  const demand={kind:'DEMAND',low:1332.34,high:1335.87};
  const supply={kind:'SUPPLY',low:1330.59,high:1333.70};
  const z=I.validateZones(demand,supply);
  assert.strictEqual(z.invalid,true);
  assert.strictEqual(z.invalidReason,'OVERLAP');
  assert.strictEqual(z.demand,null);
  assert.strictEqual(z.supply,null);
  assert.ok(z.overlapRatio>=0.40);

  const clean=I.validateZones({low:100,high:101},{low:102,high:103});
  assert.strictEqual(clean.invalid,false);
  assert.ok(clean.demand&&clean.supply);
})();

(function orderBlockAndScore(){
  const m15=[];
  for(let i=0;i<40;i++){const p=100+i*0.03;m15.push(c(i*M15,p,p+0.5,p-0.5,p+0.05));}
  m15.push(c(40*M15,101.2,101.5,100.6,100.8));
  m15.push(c(41*M15,100.8,103.0,100.7,102.8));
  m15.push(c(42*M15,102.8,103.4,102.3,103.1));
  const h4=[]; for(let i=0;i<80;i++){const p=80+i;h4.push(c(i*H4,p,p+2,p-1,p+1));}
  const snap={m15,h4}; const reg={type:'TREND',side:'LONG',a15:1};
  const ctx=I.marketContext(snap,reg);
  assert.ok(ctx.zones.demand);
  const sig={side:'LONG',mode:'TREND_RETEST',entry:103.1,stop:102.1,riskAtr:1};
  const intel=I.scoreSignal({snap,reg,sig,vwap:102,context:ctx});
  assert.ok(intel.score>=0&&intel.score<=100);
  assert.strictEqual(I.decisionLabel(sig,intel,false),'BUY');
  assert.strictEqual(I.decisionLabel(sig,intel,true),'RE-BUY');
  assert.strictEqual(I.compactIntelligence(intel).score,intel.score);
})();


(function nearbyBarrierCapsScore(){
  const m15=[];
  for(let i=0;i<60;i++){const p=100+i*0.02;m15.push(c(i*M15,p,p+0.20,p-0.20,p+0.05));}
  // Create a confirmed swing high just above the intended long entry.
  m15.push(c(60*M15,101.20,101.60,101.00,101.30));
  m15.push(c(61*M15,101.30,101.40,101.05,101.10));
  m15.push(c(62*M15,101.10,101.25,100.95,101.00));
  const h4=[]; for(let i=0;i<80;i++){const p=80+i;h4.push(c(i*H4,p,p+2,p-1,p+1));}
  const snap={m15,h4};
  const reg={type:'TREND',side:'LONG',a15:1};
  const sig={side:'LONG',mode:'TREND_RETEST',entry:101.45,stop:100.45,riskAtr:1};
  const ctx=I.marketContext(snap,reg);
  ctx.liquidity.bsl=101.60;
  const intel=I.scoreSignal({snap,reg,sig,vwap:100,context:ctx});
  assert.strictEqual(intel.entryRoom.state,'BLOCK');
  assert.ok(intel.score<=69);
  assert.strictEqual(I.compactIntelligence(intel).entryRoom.state,'BLOCK');
})();

console.log('intelligence v2 tests: PASS');
