'use strict';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function serialDispatch(){
  const seen=[];
  async function handle(id,ms){ seen.push('start:'+id); await sleep(ms); seen.push('end:'+id); }
  const t=Date.now();
  for(const x of [['A',120],['B',1],['C',1]]) await handle(x[0],x[1]);
  return {elapsed:Date.now()-t,seen};
}

async function asyncDispatch(){
  const seen=[];
  async function handle(id,ms){ seen.push('start:'+id); await sleep(ms); seen.push('end:'+id); }
  const t=Date.now();
  for(const x of [['A',120],['B',1],['C',1]]) void handle(x[0],x[1]);
  await sleep(15);
  return {elapsed:Date.now()-t,seen};
}

(async()=>{
  const serial=await serialDispatch();
  const concurrent=await asyncDispatch();
  if(serial.elapsed < 100) throw new Error('serial baseline invalid');
  if(!concurrent.seen.includes('start:B') || !concurrent.seen.includes('start:C')) throw new Error('async callbacks blocked');
  if(concurrent.elapsed > 80) throw new Error('async dispatcher still blocking');
  console.log('CALLBACK_ASYNC_DISPATCH_TEST_PASS',JSON.stringify({serialMs:serial.elapsed,asyncWindowMs:concurrent.elapsed,seen:concurrent.seen}));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
