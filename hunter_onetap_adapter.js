'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const PORT=Number(process.env.HUNTER_ADAPTER_PORT||18094);
const SOURCE=process.env.HUNTER_TICKETS_URL||'https://xauusd-live-app-production.up.railway.app/hunter/tickets';
const born=new Map();
function idFor(t){return 'hunter_'+crypto.createHash('sha256').update([t.symbol,t.side,t.edge,Number(t.entry).toPrecision(12),Number(t.sl).toPrecision(12),Number(t.tp).toPrecision(12)].join('|')).digest('hex').slice(0,24)}
async function tickets(){const r=await fetch(SOURCE+'?t='+Date.now(),{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HUNTER_'+r.status);const j=await r.json();return (j.tickets||[]).map(t=>{const id=idFor(t);if(!born.has(id))born.set(id,new Date().toISOString());return {...t,id,openedAt:born.get(id),setup:t.edge||t.setup||''}})}
const server=http.createServer(async(req,res)=>{try{if(req.url.startsWith('/health')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,source:SOURCE}))}if(req.url.startsWith('/tickets')||req.url==='/'){const x=await tickets();res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({tickets:x}))}res.writeHead(404);res.end()}catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({tickets:[],error:String(e.message||e)}))}});
server.listen(PORT,()=>console.log('HUNTER_ONETAP_ADAPTER_READY',JSON.stringify({port:PORT,source:SOURCE})));
