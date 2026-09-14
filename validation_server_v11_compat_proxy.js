'use strict';
const http=require('node:http');
const {spawn}=require('node:child_process');
const PORT=Number(process.env.PORT||8000);
const INNER=Number(process.env.EVO_PROXY_INNER_PORT||8100);
const child=spawn(process.execPath,['validation_server_v11_open_evolution.js'],{env:{...process.env,PORT:String(INNER),EVOLUTION_INNER_PORT:'8101',EVOLUTION_INNER_INNER_PORT:'8102',EVOLUTION_INNER_INNER_INNER_PORT:'8103'},stdio:['ignore','inherit','inherit']});
child.on('exit',(c,s)=>console.error('EVO_PROXY_CHILD_EXIT',c,s));
const server=http.createServer(async(req,res)=>{try{let path=req.url||'/';if(path.startsWith('/arena.json'))path='/validation.json'+(path.includes('?')?path.slice(path.indexOf('?')):'');let body; if(req.method!=='GET'&&req.method!=='HEAD'){const a=[];for await(const ch of req)a.push(ch);body=Buffer.concat(a)}const r=await fetch('http://127.0.0.1:'+INNER+path,{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json'},body});const buf=Buffer.from(await r.arrayBuffer());res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/octet-stream','cache-control':'no-store','access-control-allow-origin':'*'});res.end(buf)}catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:String(e?.message||e)}))}});
server.listen(PORT,()=>console.log('OPEN_EVOLUTION_PROXY_READY',JSON.stringify({port:PORT,inner:INNER,live:false,arenaAlias:true})));