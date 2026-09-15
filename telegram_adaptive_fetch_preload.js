'use strict';
// Process-wide Telegram Bot API governor. Loaded only into the one-tap gateway.
// Rate-limits outbound message traffic, honors retry_after, and retries 429s.
// Interactive callback acknowledgements bypass the message queue so CONFIRM/SKIP
// taps are answered immediately instead of expiring behind send/edit backlogs.
const originalFetch=globalThis.fetch;
if(typeof originalFetch!=='function')throw new Error('GLOBAL_FETCH_REQUIRED');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let chain=Promise.resolve(),cooldownUntil=0,lastCallAt=0;
const MIN_GAP=Math.max(1000,Number(process.env.TELEGRAM_MIN_GAP_MS||1800));
const MAX_RETRIES=Math.max(1,Number(process.env.TELEGRAM_429_MAX_RETRIES||3));
function urlOf(input){return typeof input==='string'?input:String(input?.url||'')}
function isTelegram(input){return urlOf(input).startsWith('https://api.telegram.org/bot')}
function methodOf(input){const u=urlOf(input);const m=u.match(/\/bot[^/]+\/([^?]+)/);return m?m[1]:''}
async function governed(input,init,{paced=true}={}){
  for(let attempt=0;attempt<=MAX_RETRIES;attempt++){
    const wait=Math.max(0,cooldownUntil-Date.now(),paced?lastCallAt+MIN_GAP-Date.now():0);
    if(wait>0)await sleep(wait);
    if(paced)lastCallAt=Date.now();
    const r=await originalFetch(input,init);
    if(r.status!==429)return r;
    let retrySec=1;
    try{const j=await r.clone().json();retrySec=Math.max(1,Number(j?.parameters?.retry_after)||Number(String(j?.description||'').match(/retry after (\d+)/i)?.[1])||1)}catch{}
    cooldownUntil=Math.max(cooldownUntil,Date.now()+retrySec*1000+500);
    console.warn('TELEGRAM_ADAPTIVE_COOLDOWN',JSON.stringify({method:methodOf(input),retryAfterSec:retrySec,attempt:attempt+1,cooldownUntil}));
    if(attempt>=MAX_RETRIES)return r;
  }
}
globalThis.fetch=function(input,init){
  if(!isTelegram(input))return originalFetch(input,init);
  const method=methodOf(input);
  // Telegram callback queries have a short validity window. Never make a user tap
  // wait behind the sendMessage/editMessage queue. Shared 429 cooldown is still honored.
  if(method==='answerCallbackQuery')return governed(input,init,{paced:false});
  const task=chain.then(()=>governed(input,init,{paced:true}));
  chain=task.catch(()=>{});
  return task
};
console.log('TELEGRAM_ADAPTIVE_GOVERNOR_READY',JSON.stringify({minGapMs:MIN_GAP,max429Retries:MAX_RETRIES,callbackPriority:true}));
