'use strict';
const assert=require('node:assert');
const {attachMasterBrain}=require('../validation_server_master_brain_v1');

function brain(id,exp=.2,n=30){
  const trades=Array.from({length:n},(_,i)=>({symbol:['BTCUSDT','ETHUSDT','SOLUSDT'][i%3],regime:['TREND','RANGE','BREAKOUT','HIGH_VOL'][i%4],netR:exp+(i%2?.1:-.1)}));
  return {id,parent:null,wTake:[1],wDir:[1],threshold:0,stopBase:50,stopMom:0,stopVol:0,stopSpread:0,rrBase:2,rrMom:0,rrTrend:0,rrVol:0,passiveBps:1,entryTtlSec:60,holdSec:300,open:new Map(),closedDiscovery:trades,closedHoldout:[],discoveryDD:1,holdoutDD:0,discoveryBalance:1010,holdoutBalance:1000};
}
const state={brains:new Map(),generation:3};
for(let i=0;i<20;i++)state.brains.set('B'+i,brain('B'+i,.05+i/100));
const rank=()=>[...state.brains.values()].map(b=>({id:b.id,discovery:{n:b.closedDiscovery.length},fitness:b.closedDiscovery.reduce((s,t)=>s+t.netR,0)})).sort((a,b)=>b.fitness-a.fitness);
const mb=attachMasterBrain({state,brainStats:x=>x,discoveryRank:rank});
const s=mb.refresh();
assert.equal(s.architecture,'MASTER_BRAIN_CHAMPION_FACTORY_V1');
assert(s.elite.length>0);
const parents=mb.breedingParents(6);
assert(parents.length>0);
mb.pruneTo(12);
assert.equal(state.brains.size,12);
for(const id of mb.manager.protectedBrainIds()) assert(state.brains.has(id),'protected elite must survive pruning');
const routed=mb.masterSnapshot({er:.5,mom:20,vol:5}).route;
assert.equal(routed.action,'NO_TRADE','no forward-proven champion must mean no trade');
console.log('master brain integration tests passed');
