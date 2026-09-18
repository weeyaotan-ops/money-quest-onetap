'use strict';

const fs=require('node:fs');
const pathMod=require('node:path');

// Read-only Binance REST guard.
// It never edits, signs, submits, cancels, or retries an order.
// It reduces repeated GET traffic, persists safe metadata caches/cooldown state,
// and fails closed after Binance 418/429/-1003 responses.
const originalFetch=global.fetch.bind(global);
const REST=(process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com').replace(/\/$/,'');
let restHost='fapi.binance.com';try{restHost=new URL(REST).host}catch{}
const FALLBACK_TAKER=Math.max(0,Number(process.env.EST_FEE_BPS_PER_SIDE||5))/10000;
const BRACKET_FALLBACK=Math.max(1,Math.min(Number(process.env.BINANCE_MAX_LEVERAGE||20),Number(process.env.BINANCE_BRACKET_FALLBACK_LEVERAGE||5)));
const META_TTL=Math.max(300000,Number(process.env.BINANCE_META_CACHE_MS||3600000));
const BRACKET_TTL=Math.max(300000,Number(process.env.BINANCE_BRACKET_CACHE_MS||21600000));
const BASE_BACKOFF_MS=Math.max(30000,Number(process.env.BINANCE_RATE_LIMIT_BASE_BACKOFF_MS||60000));
const MAX_BACKOFF_MS=Math.max(BASE_BACKOFF_MS,Number(process.env.BINANCE_RATE_LIMIT_MAX_BACKOFF_MS||15*60*1000));
const STATE_FILE=String(process.env.BINANCE_RATE_GUARD_STATE_FILE||'/data/binance-rate-guard-v1.json');
const STARTUP_GRACE_MS=Math.max(0,Number(process.env.BINANCE_RATE_GUARD_STARTUP_GRACE_MS||0));
const cache=new Map(),inflight=new Map();
const stats={network:0,cacheHits:0,staleCacheHits:0,syntheticCommission:0,bracketFallbacks:0,rateLimited:0,localCooldownBlocks:0,lastRateLimit:null,persistRestores:0};
let cooldownUntil=0,rateLimitStreak=0,lastLimitAt=0;

function cloneResponse(body,status=200,headers={'content-type':'application/json'}){return new Response(body,{status,headers})}
function cooldownResponse(){
  stats.localCooldownBlocks++;
  return cloneResponse(JSON.stringify({code:-1003,msg:`Local Binance GET cooldown active until ${cooldownUntil}`}),418,{'content-type':'application/json','x-rate-guard':'cooldown'});
}
function cacheHeaders(r){return {'content-type':r.headers.get('content-type')||'application/json'}}
function getCached(k,allowStale=false){
  const x=cache.get(k);
  if(!x)return null;
  if(Date.now()<Number(x.expires||0))return x;
  return allowStale?x:null;
}
function safeCacheRows(){
  return [...cache.entries()]
    .filter(([k])=>k==='exchangeInfo'||k.startsWith('bracket:'))
    .map(([k,v])=>[k,v])
    .slice(-1000);
}
function saveState(){
  try{
    fs.mkdirSync(pathMod.dirname(STATE_FILE),{recursive:true});
    const tmp=STATE_FILE+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({version:2,savedAt:new Date().toISOString(),cooldownUntil,rateLimitStreak,lastLimitAt,lastRateLimit:stats.lastRateLimit,cache:safeCacheRows()}));
    fs.renameSync(tmp,STATE_FILE);
    return true;
  }catch{return false}
}
function loadState(){
  try{
    if(!fs.existsSync(STATE_FILE))return false;
    const j=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    const now=Date.now();
    cooldownUntil=Math.max(0,Number(j?.cooldownUntil||0));
    rateLimitStreak=Math.max(0,Number(j?.rateLimitStreak||0));
    lastLimitAt=Math.max(0,Number(j?.lastLimitAt||0));
    stats.lastRateLimit=j?.lastRateLimit||null;
    for(const row of Array.isArray(j?.cache)?j.cache:[]){
      if(!Array.isArray(row)||row.length!==2)continue;
      const [k,v]=row;
      // Keep expired metadata for at most 24h so it can be used only as a stale
      // fallback during a Binance cooldown.
      if(v&&Number(v.expires||0)+24*3600000>now)cache.set(String(k),v);
    }
    if(cooldownUntil>now||cache.size){stats.persistRestores++;return true}
  }catch{}
  return false;
}
function putCached(k,body,status,headers,ttl){
  cache.set(k,{body,status,headers,expires:Date.now()+ttl});
  saveState();
}
function parseBodyBanUntil(text){
  const m=String(text||'').match(/banned until\s+(\d{10,13})/i);
  if(!m)return 0;
  const n=Number(m[1]);
  return n>0?(n<1e12?n*1000:n):0;
}
function parseRetryAfter(r){
  const raw=String(r?.headers?.get?.('retry-after')||'').trim();
  if(!raw)return 0;
  const seconds=Number(raw);
  if(Number.isFinite(seconds)&&seconds>=0)return Date.now()+seconds*1000;
  const d=Date.parse(raw);
  return Number.isFinite(d)?d:0;
}
function limited(status,body){
  return status===418||status===429||/"code"\s*:\s*-1003/.test(String(body||''));
}
function noteLimit(body,r){
  const now=Date.now();
  rateLimitStreak=(lastLimitAt&&now-lastLimitAt<30*60*1000)?Math.min(8,rateLimitStreak+1):1;
  lastLimitAt=now;
  const backoff=Math.min(MAX_BACKOFF_MS,BASE_BACKOFF_MS*Math.pow(2,Math.max(0,rateLimitStreak-1)));
  cooldownUntil=Math.max(cooldownUntil,parseBodyBanUntil(body),parseRetryAfter(r),now+backoff);
  stats.rateLimited++;
  stats.lastRateLimit=new Date(now).toISOString();
  saveState();
}
async function fetchAndCache(url,init,key,ttl,fallback){
  const c=getCached(key,false);
  if(c){stats.cacheHits++;return cloneResponse(c.body,c.status,c.headers)}
  if(inflight.has(key)){
    stats.cacheHits++;
    const x=await inflight.get(key);
    if(x.fallback)return x.fallback;
    return cloneResponse(x.body,x.status,x.headers);
  }
  if(Date.now()<cooldownUntil){
    const stale=getCached(key,true);
    if(stale){stats.staleCacheHits++;return cloneResponse(stale.body,stale.status,{...stale.headers,'x-rate-guard':'stale'})}
    return fallback?fallback('COOLDOWN'):cooldownResponse();
  }
  const p=(async()=>{
    const r=await originalFetch(url,init);stats.network++;
    const body=await r.text(),headers=cacheHeaders(r);
    if(limited(r.status,body)){
      noteLimit(body,r);
      const stale=getCached(key,true);
      if(stale){stats.staleCacheHits++;return{body:stale.body,status:stale.status,headers:{...stale.headers,'x-rate-guard':'stale'}}}
      if(fallback)return{fallback:await fallback(body)};
    }
    if(r.ok){putCached(key,body,r.status,headers,ttl);return{body,status:r.status,headers}}
    return{body,status:r.status,headers};
  })().finally(()=>inflight.delete(key));
  inflight.set(key,p);
  const x=await p;
  if(x.fallback)return x;
  return cloneResponse(x.body,x.status,x.headers);
}
loadState();
if(STARTUP_GRACE_MS>0&&cooldownUntil<=Date.now()){
  cooldownUntil=Date.now()+STARTUP_GRACE_MS;
  saveState();
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
  if(path==='/fapi/v1/exchangeInfo')return fetchAndCache(input,init,'exchangeInfo',META_TTL,null);
  if(path==='/fapi/v1/leverageBracket'&&symbol){
    const fallback=()=>{stats.bracketFallbacks++;return cloneResponse(JSON.stringify([{symbol,brackets:[{bracket:1,initialLeverage:BRACKET_FALLBACK,notionalCap:'0',notionalFloor:'0',maintMarginRatio:'0',cum:'0'}],source:'RATE_GUARD_FALLBACK'}]))};
    const x=await fetchAndCache(input,init,'bracket:'+symbol,BRACKET_TTL,fallback);
    return x?.fallback||x;
  }
  if(Date.now()<cooldownUntil)return cooldownResponse();
  const r=await originalFetch(input,init);stats.network++;
  if(r.status===418||r.status===429){
    const body=await r.text();
    noteLimit(body,r);
    return cloneResponse(body,r.status,cacheHeaders(r));
  }
  return r;
};
setInterval(()=>console.log('BINANCE_RATE_GUARD_STATS',JSON.stringify({...stats,cache:cache.size,cooldownRemainingMs:Math.max(0,cooldownUntil-Date.now()),rateLimitStreak,persistent:true,stateFile:STATE_FILE})),60000).unref();
console.log('BINANCE_RATE_GUARD_READY',JSON.stringify({host:restHost,commissionMode:'CONSERVATIVE_FALLBACK',fallbackTakerBps:FALLBACK_TAKER*10000,metaCacheMs:META_TTL,bracketCacheMs:BRACKET_TTL,bracketFallbackLeverage:BRACKET_FALLBACK,writeRequestsUntouched:true,getCooldown:true,handles429:true,persistentCooldown:true,stateFile:STATE_FILE,cooldownRemainingMs:Math.max(0,cooldownUntil-Date.now()),startupGraceMs:STARTUP_GRACE_MS}));
