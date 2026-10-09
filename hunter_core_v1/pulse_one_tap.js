'use strict';
// HTR Pulse One-Tap Futures. Only invoked by an authenticated Telegram callback.
// No auto entries; no withdrawal permissions. Live is separately opt-in via env.
const crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const TICKET_STORE=process.env.HTR_PULSE_TICKET_STORE||'/data/htr_live_onetap.json';
function readTickets(){
 if(!fs.existsSync(TICKET_STORE))return {tickets:{}};
 const v=JSON.parse(fs.readFileSync(TICKET_STORE,'utf8'));
 if(!v||typeof v.tickets!=='object'||!v.tickets)ERR('Ticket database invalid');
 return v;
}
function writeTickets(state){
 fs.mkdirSync(path.dirname(TICKET_STORE),{recursive:true});
 const tmp=TICKET_STORE+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});
 fs.renameSync(tmp,TICKET_STORE);
}
function storeTicket(ticket){
 const state=readTickets();
 if(Object.values(state.tickets).some(x=>x.key===ticket.key&&x.status==='PENDING'))ERR('Pending ticket for this signal already exists');
 state.tickets[ticket.id]=ticket;
 const cutoff=Date.now()-8*86400000;
 for(const [id,t] of Object.entries(state.tickets)){
  if(t.createdAt<cutoff&&t.status!=='PROCESSING')delete state.tickets[id];
 }
 writeTickets(state);
}
function claimTicket(id){
 const state=readTickets(),t=state.tickets[id];
 if(!t||t.status!=='PENDING')ERR('This ticket is invalid or already used');
 try{validTicket(t);}catch(e){t.status='EXPIRED';writeTickets(state);throw e;}
 t.status='PROCESSING';t.clickedAt=Date.now();
 writeTickets(state);
 return {...t};
}
function finishTicket(id,status,payload){
 const state=readTickets(),t=state.tickets[id];
 if(!t||t.status!=='PROCESSING')ERR('Ticket completion state mismatch');
 t.status=status;t.doneAt=Date.now();
 if(status==='FILLED_PROTECTED')t.result=payload;
 else t.error=String(payload).slice(0,440);
 writeTickets(state);
}

const API=process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com';
const ENABLED=()=>process.env.HTR_PULSE_ONETAP_LIVE==='1';
// 3 minutes to approve after the Telegram message; never more than 5 minutes after the M15 close.
// Always enforce the 0.4% live price drift and original SL/TP constraints separately.
const MARGIN=5,LEVERAGE=40,TTL_MS=3*60000,MAX_CANDLE_AGE_MS=5*60000,MAX_DRIFT=0.004;
const ERR=s=>{throw Error(s);};
let timeDelta=0;
function key(){
 const p=(process.env.BINANCE_ED25519_PRIVATE_KEY_PEM||'').replace(/\\n/g,'\n');
 if(!process.env.BINANCE_API_KEY||!p)ERR('Binance ED25519 API credentials missing');
 return crypto.createPrivateKey(p);
}
function signature(payload){
 return crypto.sign(null,Buffer.from(payload),key()).toString('base64');
}
function params(obj){return new URLSearchParams(Object.entries(obj).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])).toString();}
async function request(method,urlPath,body={},signed=false,timeout=7000){
 let qs=params(body),headers={};
 if(signed){
  key();headers['X-MBX-APIKEY']=process.env.BINANCE_API_KEY;
  qs=params({...body,recvWindow:5000,timestamp:Date.now()+timeDelta});
  qs+='&signature='+encodeURIComponent(signature(qs));
 }
 const options={method,headers,signal:AbortSignal.timeout(timeout)};
 if(method!=='GET'&&method!=='DELETE'){headers['content-type']='application/x-www-form-urlencoded';options.body=qs;}
 const url=API+urlPath+(method==='GET'||method==='DELETE'?'?'+qs:'');
 const response=await fetch(url,options);
 const raw=await response.text();let result;
 try{result=JSON.parse(raw)}catch{ERR('Binance unavailable (HTTP '+response.status+')');}
 if(!response.ok||typeof result?.code==='number'&&result.code<0){
  ERR('Binance '+String(result.code||response.status)+' '+String(result.msg||'Request failed').slice(0,170));
 }
 return result;
}
async function syncTime(){
 const t=await request('GET','/fapi/v1/time');
 if(!Number.isFinite(t.serverTime))ERR('Invalid Binance server time');
 timeDelta=t.serverTime-Date.now();
 if(Math.abs(timeDelta)>120000)ERR('Server clock mismatch >120s');
}
function clampQty(price,info){
 const rule=info.filters.find(x=>x.filterType==='MARKET_LOT_SIZE')||
 info.filters.find(x=>x.filterType==='LOT_SIZE');
 const min=Math.max(Number(rule?.minQty||0),Number(info.filters.find(x=>x.filterType==='LOT_SIZE')?.minQty||0));
 const step=Number(rule?.stepSize);
 const max=Number(rule?.maxQty||0);
 if(!(step>0&&max>0&&price>0))ERR('Unsupported Binance quantity rules');
 const qty=Math.floor((MARGIN*LEVERAGE/price)/step+1e-9)*step;
 const digits=Math.min(12,(String(step).split('.')[1]||'').length);
 const fixed=Number(qty.toFixed(digits));
 const minimumNotional=Number(info.filters.find(x=>x.filterType==='MIN_NOTIONAL')?.notional||5);
 if(fixed<min||fixed>max||fixed*price<minimumNotional||fixed*price<150)ERR(
  '5 USDT x 40x cannot meet this symbol quantity/notional rules at current price');
 if(fixed*price>200.000001)ERR('Order would use >5 USDT initial margin');
 return {quantity:String(fixed),notional:fixed*price,step};
}
function roundTrigger(price,info){
 const filt=info.filters.find(x=>x.filterType==='PRICE_FILTER');
 const tick=Number(filt?.tickSize||0);
 if(!(price>0&&tick>0))ERR('Unsupported tick size');
 const n=Math.max(0,(String(tick).split('.')[1]||'').length);
 return String(Number((Math.round(price/tick)*tick).toFixed(n)));
}
function validTicket(t,now=Date.now()){
 if(!t||!['LONG','SHORT'].includes(t.side)||!/^[A-Z0-9]{2,24}USDT$/.test(t.symbol))ERR('Invalid signal');
 if(![t.entry,t.stop,t.tp1,t.tp2].every(x=>Number.isFinite(x)&&x>0))ERR('Invalid signal prices');
 const dir=t.side==='LONG'?1:-1;
 if(!(dir*(t.entry-t.stop)>0&&dir*(t.tp1-t.entry)>0&&dir*(t.tp2-t.tp1)>0))ERR('Original SL / TP levels invalid');
 if(!Number.isFinite(t.createdAt)||!Number.isFinite(t.at)||!Number.isFinite(t.expiresAt)||
    t.createdAt<t.at||t.expiresAt>t.createdAt+TTL_MS||t.expiresAt>t.at+MAX_CANDLE_AGE_MS||
    now<t.at||now>t.expiresAt||now-t.at>MAX_CANDLE_AGE_MS)
   ERR('Signal expired. Await a fresh signal.');
}
function newTicket(s,now=Date.now()){
 return {id:crypto.randomBytes(12).toString('hex'),key:s.key,symbol:s.symbol,side:s.side,
 entry:s.entry,stop:s.stop,tp1:s.tp1,tp2:s.tp2,
 at:s.at,expiresAt:Math.min(s.at+MAX_CANDLE_AGE_MS,now+TTL_MS),
 status:'PENDING',createdAt:now};
}
async function accountReady(){
 await syncTime();
 await request('GET','/fapi/v3/balance',{},true);
 return true;
}
async function execute(t){
 if(!ENABLED())ERR('One-Tap live execution disabled');
 validTicket(t);
 await syncTime();
 const [exchange,mark,positions,mode,balance]=await Promise.all([
  request('GET','/fapi/v1/exchangeInfo'),
  request('GET','/fapi/v1/premiumIndex',{symbol:t.symbol}),
  request('GET','/fapi/v3/positionRisk',{symbol:t.symbol},true),
  request('GET','/fapi/v1/positionSide/dual',{},true),
  request('GET','/fapi/v3/balance',{},true)
 ]);
 const info=exchange.symbols.find(x=>x.symbol===t.symbol&&x.status==='TRADING'&&x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT');
 if(!info)ERR('Symbol unavailable as USDT perpetual');
 if(!Array.isArray(positions)||positions.some(x=>Math.abs(Number(x.positionAmt))>0))ERR('This symbol has an existing position; refusing to merge stops');
 if(!Array.isArray(balance)||Number(balance.find(x=>x.asset==='USDT')?.availableBalance)<MARGIN)ERR('Insufficient USDT available margin');
 const isHedge=mode.dualSidePosition===true;
 const side=t.side==='LONG'?'BUY':'SELL',closing=t.side==='LONG'?'SELL':'BUY';
 const positionSide=isHedge?t.side:'BOTH';
 const live=Number(mark.markPrice);
 if(!(live>0)||Math.abs(live/t.entry-1)>MAX_DRIFT)ERR('Price moved more than 0.4% from signal Entry');
 if(t.side==='LONG'&&live<=t.stop||t.side==='SHORT'&&live>=t.stop)ERR('Stop already crossed');
 if(t.side==='LONG'&&live>=t.tp1||t.side==='SHORT'&&live<=t.tp1)ERR('TP1 already crossed; stale setup');
 const {quantity,notional,step}=clampQty(live,info);
 // The 40x request is explicit: NEVER silently fall back to lower leverage.
 try{await request('POST','/fapi/v1/marginType',{symbol:t.symbol,marginType:'ISOLATED'},true);}
 catch(e){if(!String(e.message).includes('-4046'))throw e;}
 const leverage=await request('POST','/fapi/v1/leverage',{symbol:t.symbol,leverage:LEVERAGE},true);
 if(Number(leverage.leverage)!==LEVERAGE)ERR('Exchange did not set 40x; entry cancelled');
 const actualStop=roundTrigger(t.stop,info),actualTp1=roundTrigger(t.tp1,info),actualTp2=roundTrigger(t.tp2,info);
 if(actualStop===actualTp1||actualTp1===actualTp2)ERR('TP/SL levels too close to exchange tick size');
 // Do not create a new position when there are existing conditional orders for that symbol.
 const [pending,plainOrders]=await Promise.all([
  request('GET','/fapi/v1/openAlgoOrders',{symbol:t.symbol},true),
  request('GET','/fapi/v1/openOrders',{symbol:t.symbol},true)
 ]);
 if(!Array.isArray(pending)||pending.length||!Array.isArray(plainOrders)||plainOrders.length)
  ERR('Existing orders on this symbol; refusing to mix positions or stops');
 if(Date.now()>t.expiresAt)ERR('Signal expired during pre-flight');
 const cid='HTRP'+t.id.slice(0,24);
 let entry;try{
  entry=await request('POST','/fapi/v1/order',{symbol:t.symbol,side,positionSide,
   type:'MARKET',quantity,newOrderRespType:'RESULT',newClientOrderId:cid},true,9500);
 }catch(e){
  // On POST timeout, Binance might have accepted the order even though we
  // never received its result. NEVER retry the opening order.
  let uncertain='';
  try{
   const existing=await request('GET','/fapi/v1/order',{
    symbol:t.symbol,origClientOrderId:cid},true);
   if(Number(existing.executedQty)>0){
    try{
     const exit=await request('POST','/fapi/v1/order',{
      symbol:t.symbol,side:closing,positionSide,type:'MARKET',
      quantity:String(existing.executedQty),
      ...(isHedge?{}:{reduceOnly:'true'}),
      newClientOrderId:'HTRU'+t.id.slice(0,24)},true);
     uncertain=Number(exit.executedQty)>0?'Emergency flatten submitted.':'Emergency flatten NOT verified.';
    }catch(closeError){uncertain='EMERGENCY FLATTEN FAILED: '+String(closeError.message);}
   }else{uncertain='Order found but not fully filled; manually inspect Binance.';}
  }catch(queryError){uncertain='Order lookup failed: '+String(queryError.message);}
  ERR('ENTRY ACK UNCERTAIN. '+uncertain+' Check Binance positions/orders NOW. '+String(e.message));
 }
 if(!(Number(entry.executedQty)>0))ERR('Binance entry not filled; no protective orders placed');
 // If the live fill wildly deviates from the confirmed signal, flatten first.
 if(Number(entry.avgPrice)>0&&Math.abs(Number(entry.avgPrice)/t.entry-1)>MAX_DRIFT){
  const qtyClose=String(entry.executedQty);
  try{
   await request('POST','/fapi/v1/order',{symbol:t.symbol,side:closing,positionSide,
    type:'MARKET',quantity:qtyClose,...(isHedge?{}:{reduceOnly:'true'}),
    newClientOrderId:'HTRD'+t.id.slice(0,24)},true);
  }catch(e){
   ERR('Live fill price drifted >0.4%; emergency close unconfirmed. CHECK BINANCE NOW: '+String(e.message));
  }
  ERR('Live fill deviated >0.4%; emergency market close submitted. Check Binance.');
 }
 const filled=Number(entry.executedQty),tp1Qty=Math.floor(filled/(2*step)+1e-9)*step;
 const dp=Math.min(12,(String(step).split('.')[1]||'').length);
 let sl=null,tp1=null,tp2=null;
 const common={algoType:'CONDITIONAL',symbol:t.symbol,side:closing,positionSide,
  workingType:'MARK_PRICE'};
 try{
  sl=await request('POST','/fapi/v1/algoOrder',{...common,type:'STOP_MARKET',
   triggerPrice:actualStop,closePosition:'true',
   clientAlgoId:'HTRS'+t.id.slice(0,24)},true);
  if(!sl.algoId)ERR('Stop order not acknowledged');
  if(!(tp1Qty>0&&tp1Qty<filled))ERR('Filled quantity cannot split TP1/TP2');
  const partial={...common,type:'TAKE_PROFIT_MARKET',
   ...(isHedge?{}:{reduceOnly:'true'})};
  tp1=await request('POST','/fapi/v1/algoOrder',{...partial,
   quantity:String(Number(tp1Qty.toFixed(dp))),triggerPrice:actualTp1,
   clientAlgoId:'HTR1'+t.id.slice(0,24)},true);
  if(!tp1.algoId)ERR('TP1 order not acknowledged');
  tp2=await request('POST','/fapi/v1/algoOrder',{...common,type:'TAKE_PROFIT_MARKET',
   triggerPrice:actualTp2,closePosition:'true',
   clientAlgoId:'HTR2'+t.id.slice(0,24)},true);
  if(!tp2.algoId)ERR('TP2 order not acknowledged');
  const active=await request('GET','/fapi/v1/openAlgoOrders',{symbol:t.symbol},true);
  const ids=new Set(active.map(x=>String(x.algoId)));
  if(![sl,tp1,tp2].every(x=>ids.has(String(x.algoId))))ERR('SL/TP verification incomplete');
 }catch(error){
  // Protection failure: fail closed. Market-flatten the *new* position if possible.
  let flattened=false,closeErr='';
  try{
   const close=await request('POST','/fapi/v1/order',{
    symbol:t.symbol,side:closing,positionSide,type:'MARKET',
    quantity:String(Number(filled.toFixed(dp))),...(isHedge?{}:{reduceOnly:'true'}),
    newClientOrderId:'HTRF'+t.id.slice(0,24)},true);
   flattened=Number(close.executedQty)>0||close.status==='FILLED';
  }catch(e){closeErr=String(e.message);}
  // Cancel only this ticket's created algo orders, NEVER unrelated orders.
  // If flat could not be confirmed, leave SL in place and ask for manual check.
  if(flattened){
   for(const algo of [sl,tp1,tp2]){
    if(!algo?.algoId)continue;
    try{await request('DELETE','/fapi/v1/algoOrder',{
     symbol:t.symbol,algoId:algo.algoId},true);}
    catch(e){console.error('one-tap stale protection cleanup',t.symbol,String(e.message));}
   }
  }
  ERR('PROTECTION FAILED after live entry. Auto-close '+(flattened?'submitted':'NOT CONFIRMED')+
   '. CHECK BINANCE NOW. '+String(error.message)+(closeErr?' Close error '+closeErr:''));
 }
 return {orderId:entry.orderId,symbol:t.symbol,side:t.side,quantity,notional,
  leverage:LEVERAGE,margin:MARGIN,entry:entry.avgPrice||live,stop:actualStop,
  tp1:actualTp1,tp2:actualTp2,slAlgoId:sl.algoId,tp1AlgoId:tp1.algoId,
  tp2AlgoId:tp2.algoId,filled,at:Date.now()};
}
module.exports={newTicket,validTicket,clampQty,roundTrigger,storeTicket,claimTicket,finishTicket,accountReady,execute,ENABLED,TTL_MS,MAX_CANDLE_AGE_MS,MAX_DRIFT,MARGIN,LEVERAGE};
