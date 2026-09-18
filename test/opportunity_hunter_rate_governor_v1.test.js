'use strict';
const assert=require('node:assert/strict');
const {BinanceIpWeightGovernor}=require('../opportunity_hunter_rate_governor_v1');

const now=Date.UTC(2026,8,18,4,0,30);
const g=new BinanceIpWeightGovernor({softLimit:1500,pauseBufferMs:2500,maxPauseMs:300000});
let r=new Response('{}',{status:200,headers:{'x-mbx-used-weight-1m':'1499'}});
let x=g.observe(r,now);
assert.equal(x.paused,false);
assert.equal(x.usedWeight,1499);

r=new Response('{}',{status:200,headers:{'x-mbx-used-weight-1m':'1500'}});
x=g.observe(r,now);
assert.equal(x.paused,true);
assert.equal(x.usedWeight,1500);
assert.ok(x.pauseRemainingMs>=30000);
assert.equal(x.reserve,900);

const g2=new BinanceIpWeightGovernor({softLimit:1500,pauseBufferMs:2500,maxPauseMs:300000});
r=new Response('{}',{status:429,headers:{'x-mbx-used-weight-1m':'2400','retry-after':'120'}});
x=g2.observe(r,now);
assert.equal(x.paused,true);
assert.ok(x.pauseRemainingMs>=120000);
assert.equal(x.lastStatus,429);

console.log('OPPORTUNITY_HUNTER_RATE_GOVERNOR_V1_TEST_OK');
