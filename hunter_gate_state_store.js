'use strict';
const http=require('node:http');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const PORT=Number(process.env.PORT||process.env.HUNTER_GATE_STATE_PORT||9011);
const FILE=process.env.HUNTER_GATE_STATE_FILE||'/data/hunter_live_gate_v1.json';
const TOKEN=String(process.env.HUNTER_GATE_STATE_TOKEN||'');
const MAX_BYTES=Math.max(1024*1024,Number(process.env.HUNTER_GATE_STATE_MAX_BYTES||16*1024*1024));
const empty=()=>({version:1,savedAt:null,history:[],decisions:[],live:[],ignoredMissingActualR:0});
const send=(res,status,obj)=>{const s=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(s),'cache-control':'no-store'});res.end(s)};
const auth=req=>TOKEN&&String(req.headers.authorization||'')===`Bearer ${TOKEN}`;
async function readState(){try{if(!fs.existsSync(FILE))return empty();const x=JSON.parse(await fsp.readFile(FILE,'utf8'));return x&&typeof x==='object'?x:empty()}catch(e){console.error('HUNTER_GATE_STATE_READ_ERR',String(e?.message||e));return empty()}}
async function writeState(x){await fsp.mkdir(require('node:path').dirname(FILE),{recursive:true});const body=JSON.stringify({...x,savedAt:new Date().toISOString()}),tmp=FILE+'.tmp';if(Buffer.byteLength(body)>MAX_BYTES)throw Error('STATE_TOO_LARGE');await fsp.writeFile(tmp,body);await fsp.rename(tmp,FILE)}
function body(req){return new Promise((resolve,reject)=>{let n=0,s='';req.setEncoding('utf8');req.on('data',c=>{n+=Buffer.byteLength(c);if(n>MAX_BYTES){reject(Error('STATE_TOO_LARGE'));req.destroy();return}s+=c});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch(e){reject(Error('BAD_JSON'))}});req.on('error',reject)})}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local');if(u.pathname==='/health')return send(res,200,{ok:true,service:'HUNTER_GATE_STATE_STORE_V1'});if(u.pathname!=='/state')return send(res,404,{ok:false,error:'NOT_FOUND'});if(!auth(req))return send(res,401,{ok:false,error:'UNAUTHORIZED'});if(req.method==='GET')return send(res,200,await readState());if(req.method==='PUT'){const x=await body(req);if(!x||typeof x!=='object'||Number(x.version||0)!==1)return send(res,400,{ok:false,error:'BAD_STATE_VERSION'});await writeState(x);return send(res,200,{ok:true})}return send(res,405,{ok:false,error:'METHOD_NOT_ALLOWED'})}catch(e){const m=String(e?.message||e);return send(res,m==='STATE_TOO_LARGE'?413:400,{ok:false,error:m})}});
server.listen(PORT,'0.0.0.0',()=>console.log('HUNTER_GATE_STATE_STORE_READY',JSON.stringify({port:PORT,file:FILE,maxBytes:MAX_BYTES})));
