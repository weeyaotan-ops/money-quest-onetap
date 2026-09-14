'use strict';
const http=require('node:http');
const {spawn}=require('node:child_process');

const PORT=Number(process.env.PORT||8000);
const EVO_PORT=Number(process.env.SELF_DISCOVERY_EVO_PORT||8200);
const LEGACY_PORT=EVO_PORT+1;
const SCAN_MS=Math.max(5000,Number(process.env.SELF_DISCOVERY_SCAN_MS||15000));
const BATCH=Math.max(1,Math.min(20,Number(process.env.SELF_DISCOVERY_BATCH||4)));
const BASES=[process.env.BINANCE_PUBLIC_REST,'https://fapi1.binance.com','https://fapi2.binance.com','https://fapi3.binance.com','https://fapi4.binance.com','https://fapi.binance.com'].filter(Boolean).map(x=>x.replace(/\/$/,''));
const START=Date.now();
const S={symbols:[],cursor:0,cycles:0,generated:0,lastScanAt:0,lastUniverseAt:0,lastBase:null,lastError:null,lastBatch:[]};

const child=spawn(process.execPath,['validation_server_v11_open_evolution.js'],{
  env:{...process.env,PORT:String(EVO_PORT),EVOLUTION_INNER_PORT:String(LEGACY_PORT),EVOLUTION_INNER_INNER_PORT:String(LEGACY_PORT+1),EVOLUTION_INNER_INNER_INNER_PORT:String(LEGACY_PORT+2)},
  stdio:['ignore','inherit','inherit']
});
child.on('exit',(c,s)=>console.error('SELF_DISCOVERY_CHILD_EXIT',c,s));

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function hash(s){let h=2166136261>>>0;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function out(res,c,x,ct='application/json; charset=utf-8'){res.writeHead(c,{'content-type':ct,'cache-control':'no-store','access-control-allow-origin':'*'});res.end(ct.startsWith('application/json')?JSON.stringify(x):x)}
async function jfetch(path){let last='unavailable';for(const base of BASES){try{const ac=new AbortController(),to=setTimeout(()=>ac.abort(),2500);const r=await fetch(base+path,{signal:ac.signal});clearTimeout(to);const txt=await r.text();if(!r.ok||!txt){last=base+'_'+r.status;continue}const j=JSON.parse(txt);S.lastBase=base;return j}catch(e){last=String(e?.message||e)}}throw new Error('binance_'+last)}
async function refreshUniverse(force=false){if(!force&&Date.now()-S.lastUniverseAt<15*60*1000&&S.symbols.length)return;const x=await jfetch('/fapi/v1/exchangeInfo');if(!x||!Array.isArray(x.symbols))throw new Error('exchangeInfo_invalid');const syms=x.symbols.filter(v=>v&&v.status==='TRADING'&&v.quoteAsset==='USDT'&&v.contractType==='PERPETUAL'&&typeof v.symbol==='string').map(v=>v.symbol);syms.sort();if(!syms.length)throw new Error('no_usdt_perpetuals');S.symbols=syms;S.cursor%=syms.length;S.lastUniverseAt=Date.now();console.log('SELF_DISCOVERY_UNIVERSE',JSON.stringify({symbols:syms.length,base:S.lastBase}))}
async function postJson(port,path,obj){const body=JSON.stringify(obj);return await new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port,path,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve({status:r.statusCode||0,body:d}))});q.setTimeout(5000,()=>q.destroy(new Error('timeout')));q.on('error',reject);q.end(body)})}
async function baseline(){for(let i=0;i<20;i++){try{const r=await postJson(EVO_PORT,'/ingest',{tickets:[]});if(r.status===200)return true}catch{}await sleep(500)}return false}
function makeTrigger(symbol,slot){const side=(hash(symbol+'|'+slot)&1)?'BUY':'SELL';return{id:'SELFSCAN_'+slot+'_'+symbol,symbol,side,setup:'SELF_DISCOVERY',origin:'BINANCE_SELF_SCAN',ts:Date.now()}}
async function scanOnce(){try{await refreshUniverse(false);if(!S.symbols.length)return;const slot=Math.floor(Date.now()/SCAN_MS),batch=[];for(let i=0;i<BATCH;i++){const s=S.symbols[S.cursor++%S.symbols.length];batch.push(makeTrigger(s,slot))}if(S.cursor>=S.symbols.length){S.cursor%=S.symbols.length;S.cycles++}const r=await postJson(EVO_PORT,'/ingest',{tickets:batch,origin:'BINANCE_SELF_SCAN'});if(r.status!==200)throw new Error('evolution_ingest_'+r.status);S.generated+=batch.length;S.lastScanAt=Date.now();S.lastBatch=batch.map(x=>x.symbol);S.lastError=null;console.log('SELF_DISCOVERY_SCAN',JSON.stringify({batch:batch.length,total:S.generated,cycles:S.cycles,symbols:S.lastBatch}))}catch(e){S.lastError=String(e?.message||e);console.error('SELF_DISCOVERY_ERR',S.lastError)}}
async function proxy(req,res,port,pathOverride){const chunks=[];for await(const ch of req){chunks.push(ch);if(chunks.reduce((a,b)=>a+b.length,0)>3e6){res.destroy();return}}const body=Buffer.concat(chunks);const opts={host:'127.0.0.1',port,path:pathOverride||req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1'}};delete opts.headers['content-length'];if(body.length)opts.headers['content-length']=body.length;return await new Promise(resolve=>{const q=http.request(opts,r=>{res.writeHead(r.statusCode||502,r.headers);r.pipe(res);r.on('end',resolve)});q.on('error',e=>{if(!res.headersSent)out(res,502,{ok:false,error:String(e?.message||e)});else res.end();resolve()});if(body.length)q.write(body);q.end()})}
function status(){return{ok:true,version:'SELF_DISCOVERY_V1',live:false,mode:'BINANCE_WIDE_ROUND_ROBIN',opportunityPrefilter:'NONE_BEYOND_TRADABLE_USDT_PERPETUAL',symbols:S.symbols.length,batch:BATCH,scanEveryMs:SCAN_MS,generated:S.generated,cycles:S.cycles,lastScanAt:S.lastScanAt,lastUniverseAt:S.lastUniverseAt,lastBatch:S.lastBatch,lastBase:S.lastBase,lastError:S.lastError,uptimeSec:Math.floor((Date.now()-START)/1000)}}

(async()=>{await baseline();try{await refreshUniverse(true)}catch(e){S.lastError=String(e?.message||e)}await scanOnce();setInterval(scanOnce,SCAN_MS).unref();setInterval(()=>refreshUniverse(true).catch(e=>{S.lastError=String(e?.message||e)}),15*60*1000).unref()})();

const server=http.createServer(async(req,res)=>{try{
  if(req.method==='GET'&&req.url.startsWith('/health'))return out(res,200,status());
  if(req.method==='GET'&&req.url.startsWith('/scanner.json'))return out(res,200,status());
  if(req.method==='GET'&&req.url.startsWith('/arena.json'))return proxy(req,res,EVO_PORT,'/validation.json');
  if(req.method==='POST'&&req.url.startsWith('/ingest'))return proxy(req,res,LEGACY_PORT,'/ingest');
  return proxy(req,res,EVO_PORT);
}catch(e){return out(res,500,{ok:false,error:String(e?.message||e)})}});
server.listen(PORT,()=>console.log('SELF_DISCOVERY_V1_READY',JSON.stringify({port:PORT,evolutionPort:EVO_PORT,legacyPort:LEGACY_PORT,live:false,scanMs:SCAN_MS,batch:BATCH,mode:'BINANCE_WIDE_NO_OPPORTUNITY_PREFILTER'})));
