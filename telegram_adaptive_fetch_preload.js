'use strict';
// Process-wide Telegram Bot API governor. Loaded only into the one-tap gateway.
// Rate-limits outbound traffic, honors retry_after, retries transient network/5xx
// failures, and keeps callback acknowledgements out of the ordinary message queue.
const originalFetch=globalThis.fetch;
if(typeof originalFetch!=='function')throw new Error('GLOBAL_FETCH_REQUIRED');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let chain=Promise.resolve(),cooldownUntil=0,lastCallAt=0;
const MIN_GAP=Math.max(1000,Number(process.env.TELEGRAM_MIN_GAP_MS||1800));
const MAX_429_RETRIES=Math.max(1,Number(process.env.TELEGRAM_429_MAX_RETRIES||3));
const MAX_TRANSIENT_RETRIES=Math.max(1,Number(process.env.TELEGRAM_TRANSIENT_MAX_RETRIES||4));
function urlOf(input){return typeof input==='string'?input:String(input?.url||'')}
function isTelegram(input){return urlOf(input).startsWith('https://api.telegram.org/bot')}
function methodOf(input){const u=urlOf(input);const m=u.match(/\/bot[^/]+\/([^?]+)/);return m?m[1]:''}
function backoff(attempt){return Math.min(8000,500*Math.pow(2,attempt)) + Math.floor(Math.random()*250)}
async function governed(input,init,{paced=true}={}){
  let transient=0,rateRetries=0;
  while(true){
    const wait=Math.max(0,cooldownUntil-Date.now(),paced?lastCallAt+MIN_GAP-Date.now():0);
    if(wait>0)await sleep(wait);
    if(paced)lastCallAt=Date.now();
    let r;
    try{r=await originalFetch(input,init)}catch(e){
      if(transient>=MAX_TRANSIENT_RETRIES)throw e;
      const delay=backoff(transient++);
      console.warn('TELEGRAM_TRANSIENT_RETRY',JSON.stringify({method:methodOf(input),kind:'FETCH',attempt:transient,delayMs:delay,error:String(e?.message||e)}));
      await sleep(delay);continue;
    }
    if(r.status===429){
      let retrySec=1;
      try{const j=await r.clone().json();retrySec=Math.max(1,Number(j?.parameters?.retry_after)||Number(String(j?.description||'').match(/retry after (\d+)/i)?.[1])||1)}catch{}
      cooldownUntil=Math.max(cooldownUntil,Date.now()+retrySec*1000+500);
      rateRetries++;
      console.warn('TELEGRAM_ADAPTIVE_COOLDOWN',JSON.stringify({method:methodOf(input),retryAfterSec:retrySec,attempt:rateRetries,cooldownUntil}));
      if(rateRetries>MAX_429_RETRIES)return r;
      continue;
    }
    if((r.status>=500||r.status===408)&&transient<MAX_TRANSIENT_RETRIES){
      const delay=backoff(transient++);
      console.warn('TELEGRAM_TRANSIENT_RETRY',JSON.stringify({method:methodOf(input),kind:'HTTP_'+r.status,attempt:transient,delayMs:delay}));
      await sleep(delay);continue;
    }
    return r;
  }
}
globalThis.fetch=function(input,init){
  if(!isTelegram(input))return originalFetch(input,init);
  const method=methodOf(input);
  // Callback queries have a short validity window: do not queue them behind sends.
  if(method==='answerCallbackQuery')return governed(input,init,{paced:false});
  const task=chain.then(()=>governed(input,init,{paced:true}));
  chain=task.catch(()=>{});
  return task
};
console.log('TELEGRAM_ADAPTIVE_GOVERNOR_READY',JSON.stringify({minGapMs:MIN_GAP,max429Retries:MAX_429_RETRIES,maxTransientRetries:MAX_TRANSIENT_RETRIES,callbackPriority:true,transientRecovery:true}));