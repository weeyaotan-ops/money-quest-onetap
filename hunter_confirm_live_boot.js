'use strict';
const {spawn}=require('node:child_process');
const PUBLIC_PORT=String(process.env.PORT||8000);
const ADAPTER_PORT=String(process.env.HUNTER_ADAPTER_PORT||18094);
const ADAPTER_URL=`http://127.0.0.1:${ADAPTER_PORT}/tickets`;
const INGEST_URL=`http://127.0.0.1:${PUBLIC_PORT}/ingest`;
const POLL_MS=Math.max(3000,Number(process.env.HUNTER_CONFIRM_POLL_MS||5000));
const SEND_MS=Math.max(1200,Number(process.env.HUNTER_CONFIRM_SEND_MS||1800));
const MAX_AGE=Math.max(30000,Number(process.env.BINANCE_MAX_SIGNAL_AGE_MS||120000));
const TOP_PER_WINDOW=Math.max(1,Number(process.env.HUNTER_TELEGRAM_TOP_PER_WINDOW||3));
const WINDOW_MS=Math.max(15000,Number(process.env.HUNTER_TELEGRAM_WINDOW_MS||60000));
function run(script,extra={},label=script){const p=spawn(process.execPath,[script],{env:{...process.env,...extra},stdio:['ignore','inherit','inherit']});p.on('exit',(c,s)=>{console.error(label+'_EXIT',c,s);if(label==='HUNTER_CONFIRM_LIVE')process.exit(c||1)});return p}
const adapter=run('hunter_onetap_adapter.js',{HUNTER_ADAPTER_PORT:ADAPTER_PORT},'HUNTER_ADAPTER');
const preload=require.resolve('./telegram_adaptive_fetch_preload.js');
const gateway=run('binance_onetap_gateway.js',{PORT:PUBLIC_PORT,BINANCE_ONETAP_PORT:PUBLIC_PORT,BINANCE_ONETAP_UPSTREAM:`http://127.0.0.1:${ADAPTER_PORT}`,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --require=${preload}`.trim()},'HUNTER_CONFIRM_LIVE');
const sent=new Set();let current=[],polling=false,sending=false,windowStart=Date.now(),windowSent=0;
function score(t){
  const hunter=Number(t.score||t.edgeScore||t.confidence||0);
  const rr=Number(t.netRR||t.rr||t.riskReward||0);
  const regime=String(t.regime||'').toUpperCase();
  const edge=String(t.edge||t.setup||'').toUpperCase();
  const regimeFit=regime&&regime!=='MIXED'?0.03:0;
  const edgeBonus=(edge.includes('SWEEP')||edge.includes('RETEST')||edge.includes('RECLAIM'))?0.02:0;
  return hunter*100+Math.min(Math.max(rr,0),3)*5+regimeFit+edgeBonus
}
function fresh(t){const x=Date.parse(t.openedAt||0);return !(Number.isFinite(x)&&x>0&&Date.now()-x>MAX_AGE)}
function family(t){return [String(t.side||''),String(t.edge||t.setup||''),String(t.regime||'')].join('|')}
function rankCurrent(tickets){
  const candidates=tickets.filter(t=>{const id=String(t.id||'');return id&&!sent.has(id)&&fresh(t)}).sort((a,b)=>score(b)-score(a));
  const families=new Set(),next=[];
  for(const t of candidates){const f=family(t);if(families.has(f))continue;families.add(f);next.push(t)}
  current=next;
}
function refreshWindow(){if(Date.now()-windowStart>=WINDOW_MS){windowStart=Date.now();windowSent=0}}
async function poll(){if(polling)return;polling=true;try{const r=await fetch(ADAPTER_URL,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(`ADAPTER_${r.status}`);const j=await r.json(),tickets=Array.isArray(j.tickets)?j.tickets:[];rankCurrent(tickets);console.log('HUNTER_OPPORTUNITY_COMPETITION',JSON.stringify({seen:tickets.length,currentEligible:current.length,topPerWindow:TOP_PER_WINDOW,windowMs:WINDOW_MS,mode:'CURRENT_SNAPSHOT_RERANK'}))}catch(e){console.error('HUNTER_CONFIRM_POLL_ERR',String(e.message||e))}finally{polling=false}}
async function sendOne(){if(sending)return;refreshWindow();if(windowSent>=TOP_PER_WINDOW)return;sending=true;try{while(current.length&&(!fresh(current[0])||sent.has(String(current[0].id||''))))current.shift();const t=current.shift();if(!t)return;const id=String(t.id||'');const u=await fetch(INGEST_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tickets:[t]}),signal:AbortSignal.timeout(15000)});if(!u.ok)throw Error(`INGEST_${u.status}`);sent.add(id);windowSent++;console.log('HUNTER_TOP_PICK_SEND',JSON.stringify({id,symbol:t.symbol,rankScore:score(t),windowSent,topPerWindow:TOP_PER_WINDOW,currentRemaining:current.length}))}catch(e){console.error('HUNTER_CONFIRM_SEND_ERR',String(e.message||e))}finally{sending=false}}
setTimeout(()=>{poll();setInterval(poll,POLL_MS).unref();setInterval(sendOne,SEND_MS).unref()},2500).unref();
setInterval(()=>{if(sent.size>5000)sent.clear()},3600000).unref();
function stop(){for(const p of[adapter,gateway])try{p.kill('SIGTERM')}catch{}setTimeout(()=>process.exit(0),500).unref()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log('HUNTER_CONFIRM_LIVE_BOOT',JSON.stringify({live:process.env.BINANCE_ONETAP_LIVE==='1',confirmationRequired:true,source:'Money Hunter',publicPort:PUBLIC_PORT,legacyPublisher:false,opportunityCompetition:true,competitionMode:'CURRENT_SNAPSHOT_RERANK',topPerWindow:TOP_PER_WINDOW,windowMs:WINDOW_MS,adaptiveTelegramCooldown:true,pollMs:POLL_MS,sendMs:SEND_MS,maxAgeMs:MAX_AGE,upstream:`adapter:${ADAPTER_PORT}`}));
