'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../telegram_adaptive_fetch_preload.js'),'utf8');
const url=method=>'https://api.telegram.org/botTEST/'+method;
const ok=()=>({status:200});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function load(originalFetch){
  let now=100000;
  class Clock extends Date {static now(){return now}}
  const ctx=vm.createContext({fetch:originalFetch,Date:Clock,Math,Promise,
    process:{env:{TELEGRAM_MIN_GAP_MS:'1000'}},console:{log(){},warn(){}},
    setTimeout:(fn,ms)=>{now+=ms;queueMicrotask(fn)}});
  vm.runInContext(source,ctx);return ctx.fetch;
}
async function main(){
  const calls=[];let releasePoll,releaseFirstSend;
  const fetch=load(async input=>{
    const method=input.split('/').at(-1);calls.push(method);
    if(method==='getUpdates')return new Promise(r=>{releasePoll=r});
    if(method==='sendMessage'&&calls.filter(x=>x==='sendMessage').length===1)
      return new Promise(r=>{releaseFirstSend=r});
    return ok();
  });
  const poll=fetch(url('getUpdates'));await flush();
  const send=fetch(url('sendMessage'));await flush();
  assert.deepEqual(calls,['getUpdates','sendMessage'],'ticket must start while long poll is still pending');
  const second=fetch(url('editMessageText'));await flush();
  assert.equal(calls.includes('editMessageText'),false,'outbound writes remain serialized');
  await fetch(url('answerCallbackQuery'));
  assert.equal(calls.at(-1),'answerCallbackQuery','callback bypasses both queues');
  const controller=new AbortController();
  const expired=fetch(url('sendPhoto'),{signal:controller.signal});
  const expiredCheck=assert.rejects(expired,/expired/);
  controller.abort(Error('expired'));
  releaseFirstSend(ok());await send;await second;
  await expiredCheck;
  assert.equal(calls.includes('sendPhoto'),false,'expired queued messages never reach the network');
  assert.equal(calls.at(-1),'editMessageText');
  releasePoll(ok());await poll;

  // Long polling still honors Telegram retry_after, despite bypassing the queue.
  let tries=0;
  const retry=load(async()=>++tries===1?{status:429,clone:()=>({json:async()=>({parameters:{retry_after:2}})})}:ok());
  assert.equal((await retry(url('getUpdates'))).status,200);assert.equal(tries,2);
  let directCalls=0;
  const direct=load(async()=>{directCalls++;return ok()});
  await direct('https://example.test/health');assert.equal(directCalls,1);
  // Aborted in-flight requests must not be retried as transient failures.
  const aborted=new AbortController();let abortAttempts=0;
  const abortFetch=load(async()=>{abortAttempts++;aborted.abort(Error('deadline'));throw aborted.signal.reason});
  await assert.rejects(abortFetch(url('sendMessage'),{signal:aborted.signal}),/deadline/);
  assert.equal(abortAttempts,1);
  console.log('TELEGRAM_QUEUE_V1_PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1});
