'use strict';
const {spawn}=require('node:child_process');
const PUBLIC_PORT=String(process.env.PORT||8000);
const ADAPTER_PORT=String(process.env.HUNTER_ADAPTER_PORT||18094);
const ADAPTER_URL=`http://127.0.0.1:${ADAPTER_PORT}/tickets`;
const INGEST_URL=`http://127.0.0.1:${PUBLIC_PORT}/ingest`;
const POLL_MS=Math.max(3000,Number(process.env.HUNTER_CONFIRM_POLL_MS||5000));
function run(script,extra={},label=script){const p=spawn(process.execPath,[script],{env:{...process.env,...extra},stdio:['ignore','inherit','inherit']});p.on('exit',(c,s)=>{console.error(label+'_EXIT',c,s);if(label==='HUNTER_CONFIRM_LIVE')process.exit(c||1)});return p}
const adapter=run('hunter_onetap_adapter.js',{HUNTER_ADAPTER_PORT:ADAPTER_PORT},'HUNTER_ADAPTER');
const gateway=run('binance_onetap_gateway.js',{PORT:PUBLIC_PORT,BINANCE_ONETAP_PORT:PUBLIC_PORT,BINANCE_ONETAP_UPSTREAM:`http://127.0.0.1:${ADAPTER_PORT}`},'HUNTER_CONFIRM_LIVE');
let pumping=false,lastIds='';
async function pump(){
  if(pumping)return;pumping=true;
  try{
    const r=await fetch(ADAPTER_URL,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(`ADAPTER_${r.status}`);
    const j=await r.json(),tickets=Array.isArray(j.tickets)?j.tickets:[];
    const sig=tickets.map(x=>x.id).join(',');
    if(tickets.length&&sig!==lastIds){
      const u=await fetch(INGEST_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tickets}),signal:AbortSignal.timeout(15000)});
      if(!u.ok)throw Error(`INGEST_${u.status}`);
      lastIds=sig;
      console.log('HUNTER_CONFIRM_PUMP',JSON.stringify({tickets:tickets.length,status:u.status}));
    }
  }catch(e){console.error('HUNTER_CONFIRM_PUMP_ERR',String(e.message||e))}
  finally{pumping=false}
}
setTimeout(()=>{pump();setInterval(pump,POLL_MS).unref()},2500).unref();
function stop(){for(const p of[adapter,gateway])try{p.kill('SIGTERM')}catch{}setTimeout(()=>process.exit(0),500).unref()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log('HUNTER_CONFIRM_LIVE_BOOT',JSON.stringify({live:process.env.BINANCE_ONETAP_LIVE==='1',confirmationRequired:true,source:'Money Hunter',publicPort:PUBLIC_PORT,legacyPublisher:false,pump:true,pollMs:POLL_MS,upstream:`adapter:${ADAPTER_PORT}`}));
