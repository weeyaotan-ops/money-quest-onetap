'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const PORT=Number(process.env.HUNTER_ADAPTER_PORT||18094);
const SOURCE=process.env.HUNTER_TICKETS_URL||'https://xauusd-live-app-production.up.railway.app/hunter/tickets';
const {signalTime,isFresh}=require('./opportunity_hunter_quality_v1');
const MAX_AGE=Math.max(30000,Number(process.env.BINANCE_MAX_SIGNAL_AGE_MS||120000));
function idFor(t){return 'hunter_'+crypto.createHash('sha256').update([t.symbol,t.side,t.edge,t.timeframe||'',t.signalAt||t.openedAt||'',Number(t.entry).toPrecision(12),Number(t.sl).toPrecision(12),Number(t.tp).toPrecision(12)].join('|')).digest('hex').slice(0,24)}
function normalizeTickets(j,now=Date.now()){
  return (Array.isArray(j.tickets)?j.tickets:[]).flatMap(t=>{
    const at=signalTime(t,j.lastScan);
    if(!Number.isFinite(at))return[];
    const timed={...t,signalAt:new Date(at).toISOString(),openedAt:new Date(at).toISOString()};
    if(!isFresh(timed,MAX_AGE,now))return[];
    return[{...timed,id:idFor(timed),setup:t.edge||t.setup||''}];
  });
}
async function tickets(){const r=await fetch(SOURCE+'?t='+Date.now(),{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HUNTER_'+r.status);return normalizeTickets(await r.json())}

const server=http.createServer(async(req,res)=>{try{
  if(req.url.startsWith('/health')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,source:SOURCE}))}
  if(req.method==='POST'&&req.url==='/ingest'){for await(const _ of req){}res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,ack:true}))}
  if(req.url.startsWith('/tickets')||req.url==='/'){const x=await tickets();res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({tickets:x}))}
  res.writeHead(404);res.end()
}catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({tickets:[],error:String(e.message||e)}))}});
if(require.main===module)server.listen(PORT,()=>console.log('HUNTER_ONETAP_ADAPTER_READY',JSON.stringify({port:PORT,source:SOURCE,ingestAck:true,signalClock:'SOURCE_EVENT_TIME',maxSignalAgeMs:MAX_AGE})));
module.exports={idFor,normalizeTickets};
