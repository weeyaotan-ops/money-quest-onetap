'use strict';
const assert=require('node:assert');
const {ChampionFactoryManager}=require('../champion_factory_manager');

function trades(n,{r=0.25,symbols=['BTCUSDT','ETHUSDT','SOLUSDT'],regimes=['TREND','RANGE','BREAKOUT','HIGH_VOL']}={}){
  return Array.from({length:n},(_,i)=>({netR:i%5===0?-0.2:r,symbol:symbols[i%symbols.length],regime:regimes[i%regimes.length]}));
}

function mkBrain(id='G9-999', holdoutN=120){
  return {
    id,parent:'G8-777',wTake:[1],wDir:[1],threshold:0.2,
    stopBase:60,stopMom:0,stopVol:0,stopSpread:1,rrBase:2,rrMom:0,rrTrend:0,rrVol:0,
    passiveBps:2,entryTtlSec:60,holdSec:300,open:new Map(),
    closedDiscovery:trades(40),closedHoldout:trades(holdoutN),
    discoveryDD:2,holdoutDD:3,discoveryBalance:1040,holdoutBalance:1080
  };
}

// Normal graduation + dethroning.
const brain=mkBrain();
const m=new ChampionFactoryManager({minDiscoveryClosed:20});
const elite=m.refreshElite([brain]);
assert.equal(elite.length,1);
assert.equal(m.frozen.size,1);

const evals=m.evaluateFrozenAgainstBrains([brain]);
assert.equal(evals.length,1);
assert.equal(evals[0].proof.eligible,true);
assert.equal(evals[0].status,'CHAMPION');
assert.equal(m.frozen.size,0);
assert.equal(m.graduated.size,1);

const p=m.portfolio();
assert.ok(p.BALANCED||p.TREND||p.RANGE||p.BREAKOUT||p.HIGH_VOL);
const protectedIds=m.protectedBrainIds();
assert.ok(protectedIds.has('G9-999'));

brain.closedHoldout=trades(120,{r:-0.4});
brain.holdoutDD=12;
m.evaluateFrozenAgainstBrains([brain]);
assert.equal(m.graduated.size,0);
assert.equal(m.failed.size,1);

// Regression: a frozen DNA with tiny N must NOT be replaced/pruned by evolution.
const young=mkBrain('G188-043',2);
const lock=new ChampionFactoryManager({minDiscoveryClosed:20,maxElite:1,maxFrozen:1});
lock.refreshElite([young]);
assert.equal(lock.frozen.size,1);
assert.ok(lock.protectedBrainIds().has('G188-043'));

let e=lock.evaluateFrozenAgainstBrains([young]);
assert.equal(e[0].stats.n,2);
assert.equal(e[0].status,'FROZEN_EXAM');
assert.equal(lock.frozen.size,1);
assert.ok(lock.protectedBrainIds().has('G188-043'));

// A newer elite cannot steal the only exam slot while G188-043 is still proving itself.
const challenger=mkBrain('G189-001',5);
lock.refreshElite([challenger]);
assert.equal(lock.frozen.size,1);
assert.ok([...lock.frozen.values()].some(x=>x.brainId==='G188-043'));
assert.ok(lock.protectedBrainIds().has('G188-043'));

// N accumulates monotonically on the exact same frozen brain until the proof target.
young.closedHoldout=trades(99);
e=lock.evaluateFrozenAgainstBrains([young,challenger]);
assert.equal(e[0].stats.n,99);
assert.equal(e[0].status,'FROZEN_EXAM');
assert.ok(lock.protectedBrainIds().has('G188-043'));

young.closedHoldout=trades(100);
e=lock.evaluateFrozenAgainstBrains([young,challenger]);
assert.equal(e[0].stats.n,100);
assert.equal(e[0].status,'CHAMPION');
assert.equal(lock.frozen.size,0);
assert.equal(lock.graduated.size,1);

console.log('champion_factory_manager tests passed');
