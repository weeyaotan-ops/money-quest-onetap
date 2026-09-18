'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
  const realFetch=global.fetch;
  const stateFile=path.join('/tmp','binance-rate-guard-'+process.pid+'.json');
  try{fs.unlinkSync(stateFile)}catch{}
  let calls=[];
  global.fetch=async(input,init={})=>{
    const url=typeof input==='string'?input:input.url;calls.push({url,method:String(init.method||'GET').toUpperCase()});
    const u=new URL(url);
    if(u.pathname==='/fapi/v1/leverageBracket')return new Response(JSON.stringify([{symbol:u.searchParams.get('symbol'),brackets:[{initialLeverage:20}]}]),{status:200,headers:{'content-type':'application/json'}});
    if(u.pathname==='/fapi/v3/account')return new Response(JSON.stringify({code:-1003,msg:'Too many requests'}),{status:429,headers:{'content-type':'application/json','retry-after':'120'}});
    return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}});
  };
  process.env.EST_FEE_BPS_PER_SIDE='5';
  process.env.BINANCE_BRACKET_FALLBACK_LEVERAGE='5';
  process.env.BINANCE_RATE_GUARD_STATE_FILE=stateFile;
  require('../binance_rate_guard_preload_v1.js');

  const commission=await fetch('https://fapi.binance.com/fapi/v1/commissionRate?symbol=BTCUSDT');
  assert.equal(commission.status,200);assert.equal(calls.length,0,'commission fallback must not hit Binance');

  await fetch('https://fapi.binance.com/fapi/v1/leverageBracket?symbol=BTCUSDT');
  await fetch('https://fapi.binance.com/fapi/v1/leverageBracket?symbol=BTCUSDT');
  assert.equal(calls.filter(x=>x.url.includes('leverageBracket')).length,1,'bracket must be cached');

  const firstAccount=await fetch('https://fapi.binance.com/fapi/v3/account?timestamp=1');
  assert.equal(firstAccount.status,429);
  assert.ok(fs.existsSync(stateFile),'cooldown state must persist');

  const persisted=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  assert.ok(Number(persisted.cooldownUntil)>Date.now()+100000,'Retry-After must extend cooldown');
  assert.equal(Number(persisted.rateLimitStreak),1);

  const before=calls.length;
  const secondAccount=await fetch('https://fapi.binance.com/fapi/v3/account?timestamp=2');
  assert.equal(secondAccount.status,418);
  assert.equal(calls.length,before,'GET must not hit network during persisted cooldown');

  await fetch('https://fapi.binance.com/fapi/v1/order?timestamp=3',{method:'POST'});
  assert.equal(calls.at(-1).method,'POST','write requests must pass through untouched');

  try{fs.unlinkSync(stateFile)}catch{}
  global.fetch=realFetch;
  console.log('BINANCE_RATE_GUARD_V1_TEST_OK');
})().catch(e=>{console.error(e);process.exit(1)});
