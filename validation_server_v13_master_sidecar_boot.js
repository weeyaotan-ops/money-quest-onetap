'use strict';
const http=require('node:http');
const {spawn}=require('node:child_process');

const PUBLIC_PORT=Number(process.env.PORT||8000);
const PROD_PORT=Number(process.env.V13_INNER_PORT||19000);
const SHADOW_PORT=Number(process.env.MASTER_BRAIN_SHADOW_PORT||19100);
const SHADOW_EVO_PORT=Number(process.env.MASTER_BRAIN_EVO_PORT||19200);
const HUNTER_PORT=Number(process.env.OPPORTUNITY_HUNTER_PORT||19300);
const HOST='127.0.0.1';
let stopping=false;
const children=new Set();

function launch(script,env,label,onExit){
  const p=spawn(process.execPath,[script],{env:{...process.env,...env},stdio:['ignore','inherit','inherit']});
  children.add(p);
  p.on('exit',(code,signal)=>{
    children.delete(p);
    console.error(label+'_EXIT',code,signal);
    if(!stopping&&onExit)onExit(code,signal);
  });
  return p;
}

let prod=null;
let prodFailures=0;
let prodStartedAt=0;
let prodRestartTimer=null;
function startProd(){
  if(stopping)return;
  prodStartedAt=Date.now();
  prod=launch('validation_server_v13_quiet_boot.js',{PORT:String(PROD_PORT)},'V13_PROD',()=>{
    const lived=Date.now()-prodStartedAt;
    if(lived>300000)prodFailures=0;
    prodFailures++;
    const delay=Math.min(120000,Math.round(5000*Math.pow(2,Math.min(prodFailures-1,5))));
    console.error('V13_PROD_RESTART_SCHEDULED',JSON.stringify({attempt:prodFailures,delayMs:delay,livedMs:lived}));
    prodRestartTimer=setTimeout(()=>{prodRestartTimer=null;startProd()},delay);
  });
}
startProd();
const shadow=launch('validation_server_master_brain_self_discovery_v1.js',{PORT:String(SHADOW_PORT),SELF_DISCOVERY_EVO_PORT:String(SHADOW_EVO_PORT),MASTER_BRAIN_SHADOW:'1'},'MASTER_BRAIN_SHADOW');
const hunter=launch('opportunity_hunter_server_v1.js',{OPPORTUNITY_HUNTER_PORT:String(HUNTER_PORT)},'OPPORTUNITY_HUNTER');

function proxy(req,res,targetPort,path,rewriteMasterHtml=false){
  const headers={...req.headers,host:HOST+':'+targetPort};
  const q=http.request({host:HOST,port:targetPort,path,method:req.method,headers},r=>{
    const ct=String(r.headers['content-type']||'');
    if(rewriteMasterHtml&&ct.includes('text/html')){
      const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{
        let body=Buffer.concat(chunks).toString('utf8');body=body.replace("fetch('/validation.json?","fetch('validation.json?");
        const h={...r.headers};delete h['content-length'];h['content-length']=Buffer.byteLength(body);res.writeHead(r.statusCode||502,h);res.end(body)
      });return
    }
    res.writeHead(r.statusCode||502,r.headers);r.pipe(res)
  });
  q.on('error',e=>{
    if(!res.headersSent){res.writeHead(503,{'content-type':'application/json','cache-control':'no-store','retry-after':'5'});res.end(JSON.stringify({ok:false,error:'sidecar_temporarily_unavailable',detail:String(e?.message||e)}))}else res.end()
  });
  req.pipe(q)
}
const server=http.createServer((req,res)=>{
  const u=req.url||'/';
  if(u==='/health'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:true,supervisor:true,prodRunning:!!(prod&&!prod.killed&&prod.exitCode===null),hunterRunning:!!(hunter&&!hunter.killed&&hunter.exitCode===null),shadowRunning:!!(shadow&&!shadow.killed&&shadow.exitCode===null),prodRestartPending:!!prodRestartTimer}))
  }
  if(u==='/master-brain'||u.startsWith('/master-brain/')){const path=u==='/master-brain'?'/':u.slice('/master-brain'.length)||'/';return proxy(req,res,SHADOW_PORT,path,true)}
  if(u==='/hunter'||u.startsWith('/hunter/')){const path=u==='/hunter'?'/':u.slice('/hunter'.length)||'/';return proxy(req,res,HUNTER_PORT,path,false)}
  return proxy(req,res,PROD_PORT,u)
});
function stop(){
  stopping=true;
  if(prodRestartTimer)clearTimeout(prodRestartTimer);
  for(const p of children)try{p.kill('SIGTERM')}catch{}
  try{server.close(()=>process.exit(0))}catch{process.exit(0)}
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
server.listen(PUBLIC_PORT,()=>console.log('V13_MASTER_SIDECAR_READY',JSON.stringify({port:PUBLIC_PORT,prodPort:PROD_PORT,shadowPort:SHADOW_PORT,shadowEvolutionPort:SHADOW_EVO_PORT,hunterPort:HUNTER_PORT,productionBehavior:'PROXIED_V13_SELF_HEALING',masterBrain:'SHADOW_ONLY',opportunityHunter:'BINANCE_FUTURES_MULTI_EDGE',realMoney:false,prodRestart:'EXPONENTIAL_BACKOFF'})));
