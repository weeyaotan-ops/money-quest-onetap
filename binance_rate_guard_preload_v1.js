'use strict';

// Read-only Binance REST guard. This never edits, signs, submits, cancels, or retries orders.
// It only reduces repeated GET traffic for metadata/fee endpoints.
const originalFetch=global.fetch.bind(global);
const REST=(process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com').replace(/\/$/,'');
let restHost='fapi.binance.com';try{restHost=new URL(REST).host}catch{}
const FALLBACK_TAKER=Math.max(0,Number(process.env.EST_FEE_BPS_PER_SIDE||5))/10000;
const BRACKET_FALLBACK=Math.max(1,Math.min(Number(process.env.BINANCE_MAX_LEVERAGE||20),Number(process.env.BINANCE_BRACKET_FALLBACK_LEVERAGE||5)));
const META_TTL=Math.max(300000,Number(process.env.BINANCE_META_CACHE_MS||3600000));
const BRACKET_TTL=Math.max(300000,Number(process.env.BINANCE_BRACKET_CACHE_MS||21600000));
const cache=new Map(),inflight=new Map();
const stats={network:0,cacheHits:0,syntheticCommission:0,bracketFallbacks:0,rateLimited:0,lastRateLimit:null};
let cooldownUntil=0;
function cloneResponse(body,status=200,headers={'content-type':'application/json'}){return new Response(body,{status,headers})}
function getCached(k){const x=cache.get(k);return x&&Date.now()<x.expires?x:null}
function putCached(k,body,status,headers,ttl){cache.set(k,{body,status,headers,expires:Date.now()+ttl})}
function banUntil(text){const m=String(text||'').match(/banned until\s+(\d{10,})/i);return m?Number(m[1]):Date.now()+60000}
async function fetchAndCache(url,init,key,ttl,fallback){
  const c=getCached(key);if(c){stats.cacheHits++;return cloneResponse(c.body,c.status,c.headers)}
  if(inflight.has(key)){stats.cacheHits++;const x=await inflight.get(key);return cloneResponse(x.body,x.status,x.headers)}
  if(Date.now()<cooldownUntil&&fallback)return fallback('COOLDOWN');
  const p=(async()=>{
    const r=await originalFetch(url,init);stats.network++;
    const body=await r.text(),headers={'content-type':r.headers.get('content-type')||'application/json'};
    if(r.status===418||body.includes('"code":-1003')||body.includes('"code": -1003')){
      stats.rateLimited++;stats.lastRateLimit=new Date().toISOString();cooldownUntil=Math.max(cooldownUntil,banUntil(body));
      if(fallback)return {fallback:await fallback(body)};
    }
    if(r.ok){putCached(key,body,r.status,headers,ttl);return{body,status:r.status,headers}}
    return{body,status:r.status,headers};
  })().finally(()=>inflight.delete(key));
  inflight.set(key,p);
  const x=await p;if(x.fallback)return x.fallback;return cloneResponse(x.body,x.status,x.headers)
}
global.fetch=async function rateGuardFetch(input,init={}){
  let u;try{u=new URL(typeof input==='string'?input:input.url)}catch{return originalFetch(input,init)}
  const method=String(init?.method||(typeof input!=='string'&&input?.method)||'GET').toUpperCase();
  if(method!=='GET'||u.host!==restHost)return originalFetch(input,init);
  const path=u.pathname,symbol=String(u.searchParams.get('symbol')||'').toUpperCase();
  if(path==='/fapi/v1/commissionRate'){
    stats.syntheticCommission++;
    return cloneResponse(JSON.stringify({symbol,makerCommissionRate:String(FALLBACK_TAKER),takerCommissionRate:String(FALLBACK_TAKER),source:'RATE_GUARD_FALLBACK'}));
  }
  if(path==='/fapi/v1/exchangeInfo'){
    return fetchAndCache(input,init,'exchangeInfo',META_TTL,null);
  }
  if(path==='/fapi/v1/leverageBracket'&&symbol){
    const fallback=()=>{stats.bracketFallbacks++;return cloneResponse(JSON.stringify([{symbol,brackets:[{bracket:1,initialLeverage:BRACKET_FALLBACK,notionalCap:'0',notionalFloor:'0',maintMarginRatio:'0',cum:'0'}],source:'RATE_GUARD_FALLBACK'}]))};
    return fetchAndCache(input,init,'bracket:'+symbol,BRACKET_TTL,fallback);
  }
  return originalFetch(input,init);
};
setInterval(()=>console.log('BINANCE_RATE_GUARD_STATS',JSON.stringify({...stats,cache:cache.size,cooldownRemainingMs:Math.max(0,cooldownUntil-Date.now())})),60000).unref();
console.log('BINANCE_RATE_GUARD_READY',JSON.stringify({host:restHost,commissionMode:'CONSERVATIVE_FALLBACK',fallbackTakerBps:FALLBACK_TAKER*10000,metaCacheMs:META_TTL,bracketCacheMs:BRACKET_TTL,bracketFallbackLeverage:BRACKET_FALLBACK,orderRequestsUntouched:true}));
