'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');

(async()=>{
  process.env.BINANCE_EGRESS_RELAY_URL='http://relay.internal:19400/relay';
  process.env.BINANCE_PRIVATE_RELAY_TOKEN='test-token';
  process.env.BINANCE_EGRESS_RELAY_WRITES='1';
  process.env.BINANCE_FUTURES_REST_BASE='https://fapi.binance.com';

  const relayCalls=[],directCalls=[];
  global.fetch=async(input,init={})=>{
    const url=typeof input==='string'?input:input.url;
    if(url===process.env.BINANCE_EGRESS_RELAY_URL){
      relayCalls.push({url,init});
      return new Response(JSON.stringify({
        ok:true,status:200,body:JSON.stringify({ok:true}),
        headers:{'content-type':'application/json','x-mbx-used-weight-1m':'42'}
      }),{status:200,headers:{'content-type':'application/json'}});
    }
    directCalls.push({url,init});
    return new Response(JSON.stringify({direct:true}),{status:200,headers:{'content-type':'application/json'}});
  };

  require('../binance_private_egress_preload.js');

  const signed='https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&side=BUY&timestamp=123&signature=a%2Bb%2Fc%3D';
  const wr=await fetch(signed,{method:'POST',headers:{'X-MBX-APIKEY':'k'}});
  assert.equal(wr.status,200);
  assert.equal(relayCalls.length,1);
  const forwarded=JSON.parse(relayCalls[0].init.body);
  assert.equal(forwarded.method,'POST');
  assert.equal(forwarded.url,signed,'signed URL must be forwarded byte-for-byte');
  assert.equal(forwarded.apiKey,'k');
  assert.equal(directCalls.length,0,'allowlisted Binance write must not use old direct egress');

  const cancel='https://fapi.binance.com/fapi/v1/algoOrder?symbol=BTCUSDT&timestamp=124&signature=xyz';
  await fetch(cancel,{method:'DELETE',headers:{'X-MBX-APIKEY':'k'}});
  assert.equal(JSON.parse(relayCalls[1].init.body).method,'DELETE');
  assert.equal(JSON.parse(relayCalls[1].init.body).url,cancel);

  const blocked=await fetch('https://fapi.binance.com/fapi/v1/positionSide/dual?timestamp=125&signature=z',{method:'POST',headers:{'X-MBX-APIKEY':'k'}});
  assert.equal(blocked.status,503);
  assert.equal(relayCalls.length,2);
  assert.equal(directCalls.length,0,'non-allowlisted Binance write must fail closed');

  await fetch('https://api.telegram.org/test',{method:'POST'});
  assert.equal(directCalls.length,1,'non-Binance traffic must stay direct');

  const account='https://fapi.binance.com/fapi/v3/account?timestamp=126&signature=q';
  await fetch(account,{method:'GET',headers:{'X-MBX-APIKEY':'k'}});
  assert.equal(JSON.parse(relayCalls[2].init.body).method,'GET');
  assert.equal(JSON.parse(relayCalls[2].init.body).url,account);

  const host=fs.readFileSync(require.resolve('../binance_private_egress_relay.js'),'utf8');
  assert.match(host,/signed_write_required/);
  assert.match(host,/POST \/fapi\/v1\/order/);
  assert.match(host,/POST \/fapi\/v1\/algoOrder/);
  assert.match(host,/DELETE \/fapi\/v1\/algoOrder/);
  assert.match(host,/fetch\(target,/,'relay must forward original signed URL string');
  console.log('BINANCE_PRIVATE_EGRESS_WRITE_V1_TEST_OK');
})().catch(e=>{console.error(e);process.exit(1)});
