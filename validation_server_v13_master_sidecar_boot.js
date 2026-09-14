'use strict';
const http=require('node:http');
const {spawn}=require('node:child_process');

const PUBLIC_PORT=Number(process.env.PORT||8000);
const PROD_PORT=Number(process.env.V13_INNER_PORT||19000);
const SHADOW_PORT=Number(process.env.MASTER_BRAIN_SHADOW_PORT||19100);
const SHADOW_EVO_PORT=Number(process.env.MASTER_BRAIN_EVO_PORT||19200);
const HOST='127.0.0.1';

function launch(script,env,label){
  const p=spawn(process.execPath,[script],{env:{...process.env,...env},stdio:['ignore','inherit','inherit']});
  p.on('exit',(code,signal)=>console.error(label+'_EXIT',code,signal));
  return p;
}

// Existing V13 remains the public source of truth, only moved behind localhost proxy.
const prod=launch('validation_server_v13_quiet_boot.js',{PORT:String(PROD_PORT)},'V13_PROD');

// Independent shadow-only Master Brain. No real-money path and no public execution authority.
const shadow=launch('validation_server_master_brain_self_discovery_v1.js',{
  PORT:String(SHADOW_PORT),
  SELF_DISCOVERY_EVO_PORT:String(SHADOW_EVO_PORT),
  MASTER_BRAIN_SHADOW:'1'
},'MASTER_BRAIN_SHADOW');

function proxy(req,res,targetPort,path,rewriteMasterHtml=false){
  const headers={...req.headers,host:HOST+':'+targetPort};
  const q=http.request({host:HOST,port:targetPort,path,method:req.method,headers},r=>{
    const ct=String(r.headers['content-type']||'');
    if(rewriteMasterHtml&&ct.includes('text/html')){
      const chunks=[];
      r.on('data',c=>chunks.push(c));
      r.on('end',()=>{
        let body=Buffer.concat(chunks).toString('utf8');
        // The Master Brain is mounted under /master-brain/. Keep its dashboard
        // API request inside that mount instead of accidentally hitting V13.
        body=body.replace("fetch('/validation.json?","fetch('validation.json?");
        const h={...r.headers};
        delete h['content-length'];
        h['content-length']=Buffer.byteLength(body);
        res.writeHead(r.statusCode||502,h);
        res.end(body);
      });
      return;
    }
    res.writeHead(r.statusCode||502,r.headers);
    r.pipe(res);
  });
  q.on('error',e=>{
    if(!res.headersSent){
      res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({ok:false,error:'sidecar_proxy_unavailable',detail:String(e?.message||e)}));
    }else res.end();
  });
  req.pipe(q);
}

const server=http.createServer((req,res)=>{
  const u=req.url||'/';
  if(u==='/master-brain'||u.startsWith('/master-brain/')){
    const path=u==='/master-brain'?'/':u.slice('/master-brain'.length)||'/';
    return proxy(req,res,SHADOW_PORT,path,true);
  }
  return proxy(req,res,PROD_PORT,u);
});

function stop(){
  try{prod.kill('SIGTERM')}catch{}
  try{shadow.kill('SIGTERM')}catch{}
  try{server.close(()=>process.exit(0))}catch{process.exit(0)}
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

server.listen(PUBLIC_PORT,()=>console.log('V13_MASTER_SIDECAR_READY',JSON.stringify({
  port:PUBLIC_PORT,
  prodPort:PROD_PORT,
  shadowPort:SHADOW_PORT,
  shadowEvolutionPort:SHADOW_EVO_PORT,
  productionBehavior:'PROXIED_UNCHANGED_V13',
  masterBrain:'SHADOW_ONLY',
  realMoney:false
})));
