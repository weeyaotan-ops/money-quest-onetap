'use strict';
const assert=require('node:assert');
const {ChampionFactoryManager}=require('../champion_factory_manager');

function trades(n,{r=0.25,symbols=['BTCUSDT','ETHUSDT','SOLUSDT'],regimes=['TREND','RANGE','BREAKOUT','HIGH_VOL']}={}){
  return Array.from({length:n},(_,i)=>({netR:i%5===0?-0.2:r,symbol:symbols[i%symbols.length],regime:regimes[i%regimes.length]}));
}

const brain={
  id:'G9-999',parent:'G8-777',wTake:[1],wDir:[1],threshold:0.2,
  stopBase:60,stopMom:0,stopVol:0,stopSpread:1,rrBase:2,rrMom:0,rrTrend:0,rrVol:0,
  passiveBps:2,entryTtlSec:60,holdSec:300,open:new Map(),
  closedDiscovery:trades(40),closedHoldout:trades(120),
  discoveryDD:2,holdoutDD:3,discoveryBalance:1040,holdoutBalance:1080
};

const m=new ChampionFactoryManager({minDiscoveryClosed:20});
const elite=m.refreshElite([brain]);
assert.equal(elite.length,1);
assert.equal(m.frozen.size,1);

const evals=m.evaluateFrozenAgainstBrains([brain]);
assert.equal(evals.length,1);
assert.equal(evals[0].proof.eligible,true);
assert.equal(m.graduated.size,1);

const p=m.portfolio();
assert.ok(p.BALANCED||p.TREND||p.RANGE||p.BREAKOUT||p.HIGH_VOL);
const protectedIds=m.protectedBrainIds();
assert.ok(protectedIds.has('G9-999'));

brain.closedHoldout=trades(120,{r:-0.4});
brain.holdoutDD=12;
m.evaluateFrozenAgainstBrains([brain]);
assert.equal(m.graduated.size,0);

console.log('champion_factory_manager tests passed');
