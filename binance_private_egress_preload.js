'use strict';
const originalFetch=global.fetch.bind(global);
const RELAY_URL=String(process.env.BINANCE_EGRESS_RELAY_URL||'');
const TOKEN=String(process.env.BINANCE_PRIVATE_RELAY_TOKEN||'');
const REST=(process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com').replace(/\/$/,'');
const WRITES=process.env.BINANCE_EGRESS_RELAY_WRITES==='1';
const WRITE_ALLOW=new Set(['POST /fapi/v1/leverage','POST /fapi/v1/order','POST /fapi/v1/algoOrder','DELETE /fapi/v1/algoOrder']);
let HOST='fapi.binance.com';try{HOST=new URL(REST).host}catch{}

function headerValue(headers,name){
  if(!headers)return'';
  if(typeof headers.get==='function')return String(headers.get(name)||headers.get(name.toLowerCase())||'');
  for(const[k,v]of Object.entries(headers))if(String(k).toLowerCase()===name.toLowerCase())return Array.isArray(v)?String(v[0]||''):String(v||'');
  return'';
}
global.fetch=async function binanceRelayFetch(input,init={}){
  if(!RELAY_URL||!TOKEN)return originalFetch(input,init);
  let u;try{u=new URL(typeof input==='string'?input:input.url)}catch{return originalFetch(input,init)}
  const method=String(init?.method||(typeof input!=='string'&&input?.method)||'GET').toUpperCase();
  if(u.host!==HOST)return originalFetch(input,init);
  const isGet=method==='GET',writeKey=method+' '+u.pathname;
  if(!isGet&&(!WRITES||!WRITE_ALLOW.has(writeKey)))return originalFetch(input,init);
  const sourceHeaders=init?.headers||(typeof input!=='string'?input.headers:null);
  const apiKey=headerValue(sourceHeaders,'X-MBX-APIKEY');
  try{
    const rr=await originalFetch(RELAY_URL,{
      method:'POST',
      headers:{'content-type':'application/json','x-relay-token':TOKEN},
      body:JSON.stringify({method,url:u.toString(),apiKey}),
      signal:AbortSignal.timeout(12000)
    });
    const j=await rr.json();
    if(!rr.ok||!j?.ok)throw Error('RELAY_HTTP_'+rr.status+'_'+String(j?.error||'unknown'));
    console.log('BINANCE_PRIVATE_EGRESS',JSON.stringify({method,path:u.pathname,status:Number(j.status||0),usedWeight1m:j?.headers?.['x-mbx-used-weight-1m']||null}));
    return new Response(String(j.body??''),{status:Number(j.status||502),headers:j.headers||{'content-type':'application/json'}});
  }catch(e){
    console.error('BINANCE_PRIVATE_EGRESS_ERR',u.pathname,String(e?.message||e));
    return new Response(JSON.stringify({code:-1003,msg:'Private Binance egress relay unavailable'}),{status:503,headers:{'content-type':'application/json','x-private-relay':'error'}});
  }
};
console.log('BINANCE_PRIVATE_EGRESS_READY',JSON.stringify({enabled:Boolean(RELAY_URL&&TOKEN),mode:WRITES?'SIGNED_READ_WRITE':'GET_ONLY',writes:WRITES,host:HOST}));
