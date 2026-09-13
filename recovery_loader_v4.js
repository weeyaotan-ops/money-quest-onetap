(async()=>{
  const http=require('node:http');
  const NOOP_PORT=18103;
  if(!global.__EXACT_MIRROR_NOOP_UPSTREAM__){
    const server=http.createServer(async(req,res)=>{
      if(req.method==='POST'&&req.url==='/ingest'){
        for await (const _ of req) {}
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:true,mode:'EXACT_MIRROR_ONLY',legacySuppressed:true}));
      }
      res.writeHead(404,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'not_found'}));
    });
    server.listen(NOOP_PORT,'127.0.0.1',()=>console.log('EXACT_MIRROR_LEGACY_SUPPRESSED',NOOP_PORT));
    global.__EXACT_MIRROR_NOOP_UPSTREAM__=server;
  }
  process.env.BINANCE_ONETAP_UPSTREAM=`http://127.0.0.1:${NOOP_PORT}`;

  const SRC='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/main/exact_mirror_gateway.js';
  const r=await fetch(SRC,{cache:'no-store'});
  if(!r.ok) throw new Error('EXACT_MIRROR_FETCH_'+r.status);
  const src=await r.text();
  if(!src.includes("version: 'EXACT_MIRROR_V1'")||!src.includes("strategyGate: 'NONE'")) throw new Error('EXACT_MIRROR_SOURCE_INVALID');
  console.log('EXACT_MIRROR_LOADER',src.length);
  eval(src);
})().catch(e=>{console.error('EXACT_MIRROR_BOOT_ERR',e&&e.stack||e);process.exit(1)});
