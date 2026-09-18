'use strict';
const http=require('node:http');
const crypto=require('node:crypto');

const PORT=Math.max(1024,Number(process.env.BINANCE_PRIVATE_RELAY_PORT||19400));
const TOKEN=String(process.env.BINANCE_PRIVATE_RELAY_TOKEN||'');
const HOST='fapi.binance.com';
const ALLOWED=new Set([
  '/fapi/v3/account',
  '/fapi/v1/positionSide/dual',
  '/fapi/v1/leverageBracket',
  '/fapi/v1/commissionRate',
  '/fapi/v1/exchangeInfo',
  '/fapi/v1/userTrades',
  '/fapi/v1/allOrders'
]);
const safeEqual=(a,b)=>{
  const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));
  return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);
};
function send(res,code,x){res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(x))}
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health')return send(res,200,{ok:true,mode:'GET_ONLY',host:HOST});
  if(req.method!=='POST'||req.url!=='/relay')return send(res,404,{ok:false,error:'not_found'});
  if(!safeEqual(req.headers['x-relay-token'],TOKEN))return send(res,401,{ok:false,error:'unauthorized'});
  try{
    let raw='';for await(const ch of req){raw+=ch;if(raw.length>65536){res.destroy();return}}
    const j=JSON.parse(raw||'{}'),method=String(j.method||'GET').toUpperCase();
    if(method!=='GET')return send(res,405,{ok:false,error:'get_only'});
    const u=new URL(String(j.url||''));
    if(u.protocol!=='https:'||u.host!==HOST||!ALLOWED.has(u.pathname))return send(res,400,{ok:false,error:'target_not_allowed'});
    const headers={};
    if(j.apiKey)headers['X-MBX-APIKEY']=String(j.apiKey);
    const r=await fetch(u.toString(),{method:'GET',headers,signal:AbortSignal.timeout(10000)});
    const body=await r.text();
    const outHeaders={
      'content-type':r.headers.get('content-type')||'application/json',
      'x-mbx-used-weight-1m':r.headers.get('x-mbx-used-weight-1m')||'',
      'retry-after':r.headers.get('retry-after')||''
    };
    console.log('BINANCE_PRIVATE_RELAY',JSON.stringify({path:u.pathname,status:r.status,usedWeight1m:outHeaders['x-mbx-used-weight-1m']||null}));
    return send(res,200,{ok:true,status:r.status,body,headers:outHeaders});
  }catch(e){
    console.error('BINANCE_PRIVATE_RELAY_ERR',String(e?.message||e));
    return send(res,502,{ok:false,error:'relay_failed'});
  }
});
if(!TOKEN){console.error('BINANCE_PRIVATE_RELAY_DISABLED missing token');process.exit(1)}
server.listen(PORT,'::',()=>console.log('BINANCE_PRIVATE_RELAY_READY',JSON.stringify({port:PORT,mode:'GET_ONLY',host:HOST,allowed:[...ALLOWED]})));
