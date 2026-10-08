'use strict';
// 24/7 major-crypto signal-only scanner. NO account access or order execution.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const API=process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com';
const TOKEN=process.env.TELEGRAM_BOT_TOKEN,CHAT=process.env.TELEGRAM_CHAT_ID;
const STORE=process.env.OPPORTUNITY_STATE_PATH||'/data/opportunity_signals.json';
const POLL=Math.max(60000,Number(process.env.OPPORTUNITY_POLL_MS)||60000);
const COINS=(process.env.OPPORTUNITY_SYMBOLS||'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,SUIUSDT,NEARUSDT,ZECUSDT,APTUSDT,ATOMUSDT,BCHUSDT,TRXUSDT,ETCUSDT,UNIUSDT,FILUSDT,ICPUSDT,HBARUSDT,OPUSDT,ARBUSDT,INJUSDT').split(',').map(x=>x.trim()).filter(Boolean);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function ema(a,n){if(a.length<n)return null;let v=a.slice(0,n).reduce((s,x)=>s+x,0)/n;const k=2/(n+1);for(let i=n;i<a.length;i++)v=a[i]*k+v*(1-k);return v;}
function atr(c,n=14){if(c.length<n+1)return null;return c.slice(-n).reduce((s,x,i)=>{const prev=c[c.length-n-1+i];return s+Math.max(x.h-x.l,Math.abs(x.h-prev.c),Math.abs(x.l-prev.c))},0)/n;}
function signal(symbol,m15,h1,now=Date.now()){
 if(m15.length<80||h1.length<80)return null;
 const a=m15.filter(x=>x.t+900000<=now),b=h1.filter(x=>x.t+3600000<=now);
 if(a.length<70||b.length<70)return null;
 const c=a.at(-1),prev=a.at(-2);if(now-(c.t+900000)>180000)return null;
 const h=b.map(x=>x.c),h20=ema(h,20),h50=ema(h,50),vol=atr(a);
 if(!(vol>0)||!(h20>0)||!(h50>0))return null;
 const long=h.at(-1)>h20&&h20>h50,short=h.at(-1)<h20&&h20<h50;
 const history=a.slice(-21,-1),hi=Math.max(...history.map(x=>x.h)),lo=Math.min(...history.map(x=>x.l));
 const avgVol=history.reduce((s,x)=>s+x.v,0)/history.length;
 const buy=long&&prev.c<=hi&&c.c>hi&&c.c-c.o>0.35*vol;
 const sell=short&&prev.c>=lo&&c.c<lo&&c.o-c.c>0.35*vol;
 if(!buy&&!sell)return null;
 if(c.v<avgVol*1.20)return null;
 const side=buy?'LONG':'SHORT',dir=buy?1:-1;
 const extension=buy?c.c-hi:lo-c.c;
 if(extension>0.7*vol)return null;
 const stop=buy?Math.min(lo+0.45*(hi-lo),c.c-1.2*vol):Math.max(hi-0.45*(hi-lo),c.c+1.2*vol);
 const risk=dir*(c.c-stop);
 if(risk<0.7*vol||risk>2.2*vol)return null;
 const tp1=c.c+dir*risk,tp2=c.c+dir*2*risk;
 // Conservative round-trip taker fee + slippage, in R.
 const fee=0.0012*c.c,netR=(2*risk-fee)/(risk+fee);
 if(netR<1.5)return null;
 const body=Math.abs(c.c-c.o),range=c.h-c.l;
 if(!(range>0)||body/range<0.50)return null;
 return {symbol,side,entry:c.c,stop,tp1,tp2,netR,at:c.t+900000,key:symbol+'|'+side+'|'+(c.t+900000)};
}
function rows(x){return x.map(y=>({t:Number(y[0]),o:+y[1],h:+y[2],l:+y[3],c:+y[4],v:+y[5]}));}
async function request(url){const r=await fetch(url,{signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error('API '+r.status);return r.json();}
async function candles(symbol,tf){return rows(await request(API+'/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+'&interval='+tf+'&limit=140'));}
async function telegram(msg){if(!TOKEN||!CHAT)throw Error('Telegram credentials missing');const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text:msg,disable_web_page_preview:true}),signal:AbortSignal.timeout(10000)});const j=await r.json();if(!r.ok||!j.ok)throw Error('Telegram rejected message');}
function fmt(v){return Number(v).toLocaleString('en-US',{useGrouping:false,maximumSignificantDigits:8});}
function message(s){return ['🚨 '+s.symbol+' · '+s.side,'','Entry: '+fmt(s.entry),'SL: '+fmt(s.stop),'TP1 (1R): '+fmt(s.tp1),'TP2 (2R): '+fmt(s.tp2),'Expected net R at TP2: '+s.netR.toFixed(2),'','15m candle confirmed · H1 trend aligned','Manual trade only · signal may be invalid if price moves'].join('\n');}
function load(){try{return JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{return {sent:{}}}}
function save(s){fs.mkdirSync(path.dirname(STORE),{recursive:true});const tmp=STORE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,STORE);}
let lastScan=0,lastErrors=0,lastMatches=0,inProgress=false;
let latestCandidates=[];
async function scan(){if(inProgress)return;inProgress=true;try{
 const state=load();state.sent||={};let errors=0,matches=0;const current=[];
 for(let i=0;i<COINS.length;i+=5){
   await Promise.all(COINS.slice(i,i+5).map(async symbol=>{
     try{const [a,b]=await Promise.all([candles(symbol,'15m'),candles(symbol,'1h')]);const s=signal(symbol,a,b);if(!s)return;
       matches++;current.push(s);if(state.sent[s.key])return;
       // An old signal is never emitted on startup; send only recently closed bars.
       await telegram(message(s));state.sent[s.key]=Date.now();
     }catch(e){errors++;console.error('scan',symbol,String(e.message||e));}
   }));
 }
 const cutoff=Date.now()-8*86400000;for(const [k,t] of Object.entries(state.sent))if(t<cutoff)delete state.sent[k];
 latestCandidates=current.sort((a,b)=>b.netR-a.netR);state.latestCandidates=latestCandidates;state.lastScan=Date.now();state.errors=errors;state.matches=matches;
 save(state);lastScan=state.lastScan;lastErrors=errors;lastMatches=matches;
 console.log(JSON.stringify({scanner:'OPPORTUNITY_24_7',symbols:COINS.length,at:new Date(lastScan).toISOString(),matches,errors}));
 }finally{inProgress=false;}}
// Only three public commands. Telegram's old message keyboards cannot be deleted retroactively.
async function botApi(method,body){
 const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(!r.ok||!j.ok)throw Error('Telegram '+method+' failed: '+r.status);return j.result;
}
async function respond(chat,text){
 return botApi('sendMessage',{chat_id:chat,text,reply_markup:{remove_keyboard:true}});
}
function commandAnswer(command,state,now=Date.now()){
 const candidates=(state.latestCandidates||[]).filter(x=>now-Number(x.at)<30*60000).sort((a,b)=>b.netR-a.netR);
 if(command==='/scan')return ['📡 26 major coins · latest confirmed scan',
   'Last scan: '+(state.lastScan?new Date(state.lastScan).toISOString():'not yet'),
   ...(candidates.length?candidates.slice(0,3).map((x,i)=>(i+1)+'. '+x.symbol+' '+x.side+' · '+x.netR.toFixed(2)+' net R'):['No qualified setups now.']),
   'Only closed M15 candles qualify.'].join('\n');
 if(command==='/signals')return candidates.length?
   candidates.slice(0,3).map(message).join('\n\n────────\n\n'):
   'No active confirmed signals. Bot will automatically alert when a setup qualifies.';
 if(command==='/status')return ['📊 Scanner status',
  'Mode: 24/7 signals only','Symbols: '+COINS.length,
  'Last scan: '+(state.lastScan?new Date(state.lastScan).toISOString():'pending'),
  'Last scan errors: '+(state.errors??'unknown'),
  'Signals found: '+(state.matches??0),'Manual trade only'].join('\n');
 return 'HTR Signal Bot\n/scan — scan results\n/signals — confirmed entries\n/status — scanner health';
}
// Use Telegram webhook instead of competing getUpdates polling clients.
// Telegram routes command updates to this HTTPS endpoint even if an older bot
// instance is still attempting getUpdates (old poller will receive 409).
const crypto=require('node:crypto');
const HOOK_DOMAIN=process.env.OPPORTUNITY_WEBHOOK_DOMAIN||'crypto-signal-publisher-production.up.railway.app';
const HOOK_SECRET=TOKEN?crypto.createHash('sha256').update(TOKEN+'|HTR-V3-WEBHOOK').digest('hex'):'';
const HOOK_PATH='/telegram/'+HOOK_SECRET;
let commandQueue=Promise.resolve();
function handleWebhook(req,res){
 if(req.method!=='POST'||req.url!==HOOK_PATH){return false;}
 if(req.headers['content-type']?.split(';')[0]!=='application/json'){
  res.writeHead(415);res.end();return true;
 }
 let body='',large=false;
 req.on('data',chunk=>{body+=chunk;if(body.length>65536){large=true;req.destroy();}});
 req.on('end',()=>{
  if(large){res.writeHead(413);res.end();return;}
  let u;try{u=JSON.parse(body)}catch{res.writeHead(400);res.end();return;}
  res.writeHead(200);res.end('OK');
  const chat=String(u.message?.chat?.id||'');
  if(chat!==String(CHAT))return;
  const cmd=String(u.message?.text||'').trim().split(/\\s+/)[0].split('@')[0].toLowerCase();
  if(!['/scan','/signals','/status','/start'].includes(cmd))return;
  commandQueue=commandQueue.catch(()=>{}).then(()=>respond(chat,commandAnswer(cmd,load())))
    .catch(e=>console.error('command response',e.message));
 });
 return true;
}
async function setupWebhook(){
 if(!TOKEN||!CHAT){console.error('Telegram command registration disabled: missing credentials');return;}
 await botApi('setMyCommands',{commands:[
  {command:'scan',description:'Scan 26 major coins'},
  {command:'signals',description:'Confirmed LONG / SHORT signals'},
  {command:'status',description:'Scanner status'}]});
 await botApi('setWebhook',{url:'https://'+HOOK_DOMAIN+HOOK_PATH,
   allowed_updates:['message'],drop_pending_updates:false,max_connections:5});
 const info=await botApi('getWebhookInfo',{});
 console.log(JSON.stringify({telegramWebhook:info.url?'SET':'NOT_SET',
   pending:info.pending_update_count,lastError:info.last_error_message||null}));
}

if(require.main===module){
 http.createServer((req,res)=>{if(handleWebhook(req,res))return;const ok=lastScan&&Date.now()-lastScan<3600000;res.writeHead(ok?200:503,{'content-type':'application/json'});res.end(JSON.stringify({ok:!!ok,scanner:'OPPORTUNITY_24_7',lastScan,errors:lastErrors,matches:lastMatches}));}).listen(Number(process.env.PORT||3000),'0.0.0.0');
 const loop=async()=>{for(;;){try{await scan()}catch(e){console.error('scan fatal',e)}await wait(POLL)}};
 loop();
 setupWebhook().catch(e=>console.error('webhook setup',e.message));
}
module.exports={signal,rows,message,commandAnswer};
