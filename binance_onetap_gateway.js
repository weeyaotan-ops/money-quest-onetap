const http=require('node:http');
const crypto=require('node:crypto');

const PORT=Number(process.env.BINANCE_ONETAP_PORT||18093);
const REST=(process.env.BINANCE_FUTURES_REST_BASE||'https://fapi.binance.com').replace(/\/$/,'');
const API_KEY=process.env.BINANCE_API_KEY||'';
const PRIV=process.env.BINANCE_ED25519_PRIVATE_KEY_PEM||'';
const TG_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const TG_CHAT=String(process.env.TELEGRAM_CHAT_ID||'');
const AUTH_USER=String(process.env.TELEGRAM_AUTH_USER_ID||'');
const UPSTREAM=process.env.BINANCE_ONETAP_UPSTREAM||'http://127.0.0.1:18092';

const LIVE=process.env.BINANCE_ONETAP_LIVE==='1';
const RISK_PCT=Number(process.env.BINANCE_RISK_PCT||1);
const MAX_LEV=Number(process.env.BINANCE_MAX_LEVERAGE||20);
const MARGIN_UTIL=Math.min(0.8,Math.max(0.05,Number(process.env.BINANCE_MAX_MARGIN_UTILIZATION||0.45)));
const MAX_OPEN=Math.max(1,Number(process.env.BINANCE_MAX_OPEN_POSITIONS||2));
const TTL=Math.max(30000,Number(process.env.BINANCE_ONETAP_TTL_MS||90000));
const MAX_SIGNAL_AGE=Math.max(TTL,Number(process.env.BINANCE_MAX_SIGNAL_AGE_MS||120000));

/*
 * EXECUTION QUALITY GATE
 * Combined Edge still owns direction / Entry / SL / TP.
 * This layer only rejects tickets whose real Binance execution economics
 * no longer preserve enough net R:R after fees/slippage.
 */
const FALLBACK_TAKER_FEE=Math.max(0,Number(process.env.EST_FEE_BPS_PER_SIDE||5))/10000;
const SLIP_SIDE=Math.max(0,Number(process.env.EST_SLIPPAGE_BPS_PER_SIDE||1))/10000;
const MIN_NET_RR=Math.max(0,Number(process.env.MIN_NET_RR||1.5));
const MIN_NET_PROFIT=Math.max(0,Number(process.env.MIN_NET_PROFIT_USDT||0));
const MIN_FILL_RATIO=Math.min(1,Math.max(0.1,Number(process.env.BINANCE_MIN_FILL_RATIO||0.80)));

const pending=new Map(),notified=new Set(),completed=new Set(),liveTrades=new Map();
let exchangeMeta=new Map(),metaAt=0,accountCache=null,accountAt=0,dualCache=null,dualAt=0,updateOffset=0,tgPollOk=false;
const commissionCache=new Map();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function qs(params){return Object.entries(params).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>`${k}=${encodeURIComponent(String(v))}`).join('&')}
function sign(s){const key=crypto.createPrivateKey(PRIV);return crypto.sign(null,Buffer.from(s),key).toString('base64')}
async function signed(method,path,params={}){
  const p={...params,recvWindow:5000,timestamp:Date.now()},base=qs(p),sig=sign(base),url=`${REST}${path}?${base}&signature=${encodeURIComponent(sig)}`;
  const r=await fetch(url,{method,headers:{'X-MBX-APIKEY':API_KEY}});
  const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
  if(!r.ok)throw new Error(`BINANCE_${r.status}_${data?.code??''}_${data?.msg??text}`);
  return data
}
async function tg(method,payload){
  const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json();
  if(!j.ok)throw new Error(`TG_${method}_${j.error_code}_${j.description}`);
  return j.result
}
function dec(step){const s=String(step);if(s.includes('e-'))return Number(s.split('e-')[1]);return Math.max(0,(s.split('.')[1]||'').replace(/0+$/,'').length)}
function roundStep(v,step){const n=Number(v),s=Number(step);if(!Number.isFinite(n)||!Number.isFinite(s)||s<=0)return n;return Number((Math.round(n/s)*s).toFixed(dec(step)))}
function floorStep(v,step){const n=Number(v),s=Number(step);if(!Number.isFinite(n)||!Number.isFinite(s)||s<=0)return n;return Number((Math.floor((n+1e-12)/s)*s).toFixed(dec(step)))}
function fmt(v,step){return Number(v).toFixed(dec(step))}
function normalizeSymbol(t){const raw=String(t.binanceSymbol||t.instId||t.symbol||t.asset||'').toUpperCase().replace(/[-_/]/g,'');const base=raw.replace(/USDTSWAP$/,'').replace(/USDTPERP$/,'').replace(/USDT$/,'');return base?base+'USDT':''}
function findTickets(x){if(Array.isArray(x))return x;if(!x||typeof x!=='object')return[];for(const k of ['tickets','signals','data','items','open']){if(Array.isArray(x[k]))return x[k];if(x[k]&&typeof x[k]==='object'){const a=findTickets(x[k]);if(a.length)return a}}if(x.id&&x.side&&(x.symbol||x.instId))return[x];return[]}
function safeId(prefix,id){return(prefix+crypto.createHash('sha256').update(String(id)).digest('hex')).slice(0,36)}

async function refreshMeta(force=false){
  if(!force&&exchangeMeta.size&&Date.now()-metaAt<300000)return;
  const r=await fetch(`${REST}/fapi/v1/exchangeInfo`);
  if(!r.ok)throw new Error(`EXCHANGEINFO_${r.status}`);
  const j=await r.json(),next=new Map();
  for(const x of j.symbols||[]){
    if(x.status!=='TRADING'||x.contractType!=='PERPETUAL'||x.quoteAsset!=='USDT')continue;
    const pf=(x.filters||[]).find(f=>f.filterType==='PRICE_FILTER')||{};
    const lf=(x.filters||[]).find(f=>f.filterType==='LOT_SIZE')||{};
    const nf=(x.filters||[]).find(f=>f.filterType==='MIN_NOTIONAL')||{};
    if(!pf.tickSize||!lf.stepSize)continue;
    next.set(x.symbol,{tickSize:pf.tickSize,stepSize:lf.stepSize,minQty:Number(lf.minQty||0),maxQty:Number(lf.maxQty||Infinity),minNotional:Number(nf.notional||5)})
  }
  exchangeMeta=next;metaAt=Date.now();
  console.log('ONETAP_META_READY',JSON.stringify({symbols:next.size}))
}
async function account(force=false){
  if(!force&&accountCache&&Date.now()-accountAt<1000)return accountCache;
  accountCache=await signed('GET','/fapi/v3/account');accountAt=Date.now();return accountCache
}
async function dualMode(force=false){
  if(!force&&dualCache!==null&&Date.now()-dualAt<60000)return dualCache;
  const j=await signed('GET','/fapi/v1/positionSide/dual');dualCache=!!j.dualSidePosition;dualAt=Date.now();return dualCache
}
async function maxLeverage(symbol){
  try{
    const j=await signed('GET','/fapi/v1/leverageBracket',{symbol}),b=Array.isArray(j)?j[0]:j,first=b?.brackets?.[0]?.initialLeverage;
    return Math.max(1,Math.min(MAX_LEV,Number(first||MAX_LEV)))
  }catch(e){
    console.warn('ONETAP_BRACKET_FALLBACK',symbol,String(e.message||e));return MAX_LEV
  }
}
async function takerFee(symbol,force=false){
  const c=commissionCache.get(symbol);
  if(!force&&c&&Date.now()-c.at<300000)return c.rate;
  try{
    const j=await signed('GET','/fapi/v1/commissionRate',{symbol});
    const rate=Number(j?.takerCommissionRate);
    if(Number.isFinite(rate)&&rate>=0){commissionCache.set(symbol,{rate,at:Date.now()});return rate}
  }catch(e){
    console.warn('ONETAP_COMMISSION_FALLBACK',symbol,String(e.message||e))
  }
  commissionCache.set(symbol,{rate:FALLBACK_TAKER_FEE,at:Date.now()});
  return FALLBACK_TAKER_FEE
}
function nonzeroPositions(acc){return(acc.positions||[]).filter(p=>Math.abs(Number(p.positionAmt||0))>0)}

async function preview(ticket,force=false){
  await refreshMeta();
  const symbol=normalizeSymbol(ticket),meta=exchangeMeta.get(symbol);
  if(!meta)return{blocked:'SYMBOL_NOT_USDM_PERP',symbol};
  const side=String(ticket.side||'').toUpperCase();
  if(!['BUY','SELL'].includes(side))return{blocked:'BAD_SIDE',symbol};

  const entry=roundStep(Number(ticket.entry),meta.tickSize),sl=roundStep(Number(ticket.sl),meta.tickSize),tp=roundStep(Number(ticket.tp),meta.tickSize);
  if(![entry,sl,tp].every(Number.isFinite)||entry<=0)return{blocked:'BAD_PRICES',symbol};
  if(side==='BUY'&&!(sl<entry&&tp>entry))return{blocked:'INVALID_BUY_LEVELS',symbol};
  if(side==='SELL'&&!(sl>entry&&tp<entry))return{blocked:'INVALID_SELL_LEVELS',symbol};

  const dist=Math.abs(entry-sl),reward=Math.abs(tp-entry);
  const feeRate=await takerFee(symbol,force);
  const lossCostPerUnit=dist+(entry+sl)*(feeRate+SLIP_SIDE);
  const netRewardPerUnit=reward-(entry+tp)*(feeRate+SLIP_SIDE);
  const grossRR=reward/dist;
  const netRR=netRewardPerUnit>0?netRewardPerUnit/lossCostPerUnit:-Infinity;
  const stopBps=dist/entry*10000;
  const estimatedRoundTripBps=(2*(feeRate+SLIP_SIDE))*10000;

  if(!(dist>0&&reward>0&&lossCostPerUnit>0))return{blocked:'BAD_RISK',symbol};
  if(!(netRewardPerUnit>0))return{blocked:'EXECUTION_COST_EXCEEDS_REWARD',symbol,entry,sl,tp,grossRR,netRR,stopBps,estimatedRoundTripBps};
  if(netRR<MIN_NET_RR)return{blocked:'NET_RR_TOO_LOW',symbol,entry,sl,tp,grossRR,netRR,stopBps,estimatedRoundTripBps,minNetRR:MIN_NET_RR};

  const acc=await account(force),equity=Number(acc.totalWalletBalance||0),avail=Number(acc.availableBalance||0);
  if(!(equity>0&&avail>0))return{blocked:'NO_FUTURES_USDT',symbol,equity,avail};
  const nz=nonzeroPositions(acc);
  if(nz.some(p=>p.symbol===symbol))return{blocked:'EXISTING_SYMBOL_POSITION',symbol,equity,avail};
  if(nz.length>=MAX_OPEN)return{blocked:'MAX_OPEN_POSITIONS',symbol,equity,avail,open:nz.length};

  const riskUsd=equity*(RISK_PCT/100);
  if(!(riskUsd>0))return{blocked:'BAD_RISK',symbol,equity,avail};

  const maxLev=await maxLeverage(symbol);
  const rawQty=riskUsd/lossCostPerUnit;
  const maxNotional=avail*MARGIN_UTIL*maxLev;
  const qty=floorStep(Math.min(rawQty,maxNotional/entry,meta.maxQty),meta.stepSize);
  const notional=qty*entry;
  if(!(qty>=meta.minQty)||notional<meta.minNotional)return{blocked:'BELOW_MIN_ORDER',symbol,equity,avail,qty,notional};

  const leverage=Math.max(1,Math.min(maxLev,Math.ceil(notional/(avail*MARGIN_UTIL))));
  const margin=notional/leverage;
  const actualRisk=qty*lossCostPerUnit;
  const netProfit=qty*netRewardPerUnit;
  if(netProfit<MIN_NET_PROFIT)return{blocked:'NET_PROFIT_TOO_LOW',symbol,equity,avail,netProfit,minNetProfit:MIN_NET_PROFIT};

  return{
    blocked:null,id:String(ticket.id),symbol,side,setup:ticket.setup||'',
    entry,sl,tp,qty,qtyStr:fmt(qty,meta.stepSize),priceStr:fmt(entry,meta.tickSize),slStr:fmt(sl,meta.tickSize),tpStr:fmt(tp,meta.tickSize),
    equity,avail,riskUsd,actualRisk,netProfit,notional,leverage,margin,maxLev,meta,
    feeRate,slipRate:SLIP_SIDE,grossRR,netRR,stopBps,estimatedRoundTripBps,lossCostPerUnit,netRewardPerUnit
  }
}

function ticketText(p,expiresSec){
  return[
    '⚡ COMBINED EDGE → BINANCE LIVE',
    `${p.symbol} ${p.side}${p.setup?' | '+p.setup:''}`,
    `Entry: ${p.entry}`,
    `SL: ${p.sl}`,
    `TP: ${p.tp}`,
    `Qty: ${p.qtyStr}`,
    `Leverage: ${p.leverage}x`,
    `Risk incl. est. costs: ~${p.actualRisk.toFixed(2)} USDT (${(p.actualRisk/p.equity*100).toFixed(2)}%)`,
    `Gross RR: ${p.grossRR.toFixed(2)} | Est. net RR: ${p.netRR.toFixed(2)}`,
    `Est. round-trip cost: ~${p.estimatedRoundTripBps.toFixed(1)} bps`,
    `Margin: ~${p.margin.toFixed(2)} USDT`,
    `Futures equity: ${p.equity.toFixed(2)} USDT`,
    `Expires: ${expiresSec}s`,
    '',
    'Combined Edge levels unchanged. Tap CONFIRM LIVE to execute.'
  ].join('\n')
}

async function sendPending(ticket){
  const id=String(ticket.id||'');
  if(!id||notified.has(id)||completed.has(id))return;
  const opened=Date.parse(ticket.openedAt||0);
  if(Number.isFinite(opened)&&opened>0&&Date.now()-opened>MAX_SIGNAL_AGE){notified.add(id);return}
  notified.add(id);
  try{
    const p=await preview(ticket,false);
    if(p.blocked){
      console.log('ONETAP_EXECUTION_GATE_BLOCK',JSON.stringify({id,symbol:p.symbol,reason:p.blocked,netRR:Number.isFinite(p.netRR)?p.netRR:null,grossRR:p.grossRR,stopBps:p.stopBps,costBps:p.estimatedRoundTripBps}));
      return
    }
    const token=crypto.randomBytes(10).toString('hex'),expiresAt=Date.now()+TTL;
    const msg=await tg('sendMessage',{
      chat_id:TG_CHAT,text:ticketText(p,Math.round(TTL/1000)),disable_web_page_preview:true,
      reply_markup:{inline_keyboard:[[{text:'✅ CONFIRM LIVE',callback_data:`mh:${token}`},{text:'❌ SKIP',callback_data:`ms:${token}`}]]}
    });
    pending.set(token,{ticket,id,preview:p,expiresAt,messageId:msg.message_id,locked:false});
    console.log('ONETAP_PENDING_SENT',JSON.stringify({id,symbol:p.symbol,qty:p.qtyStr,lev:p.leverage,netRR:p.netRR,actualRisk:p.actualRisk,expiresAt}))
  }catch(e){
    notified.delete(id);
    console.error('ONETAP_PENDING_ERR',id,String(e.message||e))
  }
}

async function changeLeverage(p){return signed('POST','/fapi/v1/leverage',{symbol:p.symbol,leverage:p.leverage})}
async function entryOrder(p,hedge){
  const params={symbol:p.symbol,side:p.side,type:'LIMIT',timeInForce:'IOC',quantity:p.qtyStr,price:p.priceStr,newClientOrderId:safeId('mh_',p.id),newOrderRespType:'RESULT',positionSide:hedge?(p.side==='BUY'?'LONG':'SHORT'):'BOTH'};
  return signed('POST','/fapi/v1/order',params)
}
async function algoOrder(p,kind,hedge){
  const side=p.side==='BUY'?'SELL':'BUY';
  const params={algoType:'CONDITIONAL',symbol:p.symbol,side,positionSide:hedge?(p.side==='BUY'?'LONG':'SHORT'):'BOTH',type:kind==='SL'?'STOP_MARKET':'TAKE_PROFIT_MARKET',triggerPrice:kind==='SL'?p.slStr:p.tpStr,closePosition:'true',workingType:'CONTRACT_PRICE',priceProtect:'false',clientAlgoId:safeId(kind==='SL'?'mhsl_':'mhtp_',p.id)};
  return signed('POST','/fapi/v1/algoOrder',params)
}
async function emergencyClose(p,hedge,qtyStr){
  const params={symbol:p.symbol,side:p.side==='BUY'?'SELL':'BUY',type:'MARKET',quantity:qtyStr,newClientOrderId:safeId('mhe_',p.id),newOrderRespType:'RESULT',positionSide:hedge?(p.side==='BUY'?'LONG':'SHORT'):'BOTH'};
  if(!hedge)params.reduceOnly='true';
  return signed('POST','/fapi/v1/order',params)
}
async function cancelAlgo(symbol,clientAlgoId){try{return await signed('DELETE','/fapi/v1/algoOrder',{symbol,clientAlgoId})}catch{return null}}
async function editMessage(messageId,text){try{return await tg('editMessageText',{chat_id:TG_CHAT,message_id:messageId,text,disable_web_page_preview:true})}catch(e){console.warn('ONETAP_EDIT_ERR',String(e.message||e))}}

async function fillStats(p,order){
  let avg=Number(order?.avgPrice||0),commission=0,commissionAsset='USDT';
  try{
    const trades=await signed('GET','/fapi/v1/userTrades',{symbol:p.symbol,orderId:order.orderId,limit:100});
    let q=0,n=0;
    for(const x of Array.isArray(trades)?trades:[]){
      const qty=Number(x.qty||0),price=Number(x.price||0),c=Math.abs(Number(x.commission||0));
      if(qty>0&&price>0){q+=qty;n+=qty*price}
      if(Number.isFinite(c))commission+=c;
      if(x.commissionAsset)commissionAsset=String(x.commissionAsset)
    }
    if(q>0)avg=n/q
  }catch(e){
    console.warn('ONETAP_FILL_STATS_FALLBACK',p.id,String(e.message||e))
  }
  if(!(avg>0))avg=p.entry;
  return{avgPrice:avg,entryCommission:commission,commissionAsset}
}

async function verifyNoSymbolPosition(symbol){
  const acc=await account(true);
  return !(acc.positions||[]).some(x=>x.symbol===symbol&&Math.abs(Number(x.positionAmt||0))>0)
}

async function executePending(item){
  if(!LIVE)throw new Error('LIVE_GATE_DISABLED');
  const p=await preview(item.ticket,true);
  if(p.blocked)throw new Error('BLOCKED_'+p.blocked);

  const hedge=await dualMode(true);
  await changeLeverage(p);
  const order=await entryOrder(p,hedge);
  const executedQty=Number(order.executedQty||0),status=String(order.status||'');
  if(!(executedQty>0))return{ok:false,reason:`NOT_FILLED_${status||'IOC'}`,p,order};

  const fillRatio=p.qty>0?executedQty/p.qty:0;
  const qtyStr=fmt(executedQty,p.meta.stepSize);

  if(fillRatio<MIN_FILL_RATIO){
    console.warn('ONETAP_PARTIAL_FILL_REJECT',JSON.stringify({id:p.id,symbol:p.symbol,requested:p.qty,filled:executedQty,fillRatio,minFillRatio:MIN_FILL_RATIO}));
    let closeOrder;
    try{closeOrder=await emergencyClose(p,hedge,qtyStr)}
    catch(e){throw new Error('PARTIAL_FILL_REJECT_CLOSE_FAILED_POSITION_MAY_BE_OPEN_'+String(e.message||e))}
    await sleep(250);
    if(!(await verifyNoSymbolPosition(p.symbol)))throw new Error('PARTIAL_FILL_REJECT_POSITION_STILL_OPEN_CHECK_BINANCE');
    return{ok:false,reason:'PARTIAL_FILL_REJECTED_AND_CLOSED',p,order,executedQty,fillRatio,partialClosed:true,closeOrder}
  }

  const fills=await fillStats(p,order);
  let slAlgo=null,tpAlgo=null;
  try{
    slAlgo=await algoOrder(p,'SL',hedge);
    tpAlgo=await algoOrder(p,'TP',hedge)
  }catch(e){
    console.error('ONETAP_PROTECTION_FAIL',p.id,String(e.message||e));
    if(slAlgo)await cancelAlgo(p.symbol,safeId('mhsl_',p.id));
    if(tpAlgo)await cancelAlgo(p.symbol,safeId('mhtp_',p.id));
    try{await emergencyClose(p,hedge,qtyStr)}catch(closeErr){console.error('ONETAP_EMERGENCY_CLOSE_FAIL',p.id,String(closeErr.message||closeErr))}
    throw new Error('PROTECTION_FAIL_POSITION_CLOSED_ATTEMPTED_'+String(e.message||e))
  }

  const result={ok:true,p,order,executedQty,fillRatio,avgPrice:fills.avgPrice,entryCommission:fills.entryCommission,commissionAsset:fills.commissionAsset,hedge,slAlgo,tpAlgo};
  liveTrades.set(p.id,{...result,startedAt:Date.now()});
  monitorTrade(p.id).catch(e=>console.error('ONETAP_MONITOR_ERR',p.id,String(e.message||e)));
  return result
}

async function settledStats(t){
  try{
    const start=Math.max(0,Number(t.startedAt||Date.now())-10000);
    const trades=await signed('GET','/fapi/v1/userTrades',{symbol:t.p.symbol,startTime:start,endTime:Date.now(),limit:1000});
    let realized=0,commission=0,commissionAsset='USDT';
    for(const x of Array.isArray(trades)?trades:[]){
      const rp=Number(x.realizedPnl||0),c=Math.abs(Number(x.commission||0));
      if(Number.isFinite(rp))realized+=rp;
      if(Number.isFinite(c))commission+=c;
      if(x.commissionAsset)commissionAsset=String(x.commissionAsset)
    }
    const net=commissionAsset==='USDT'?realized-commission:realized;
    const actualR=t.p.riskUsd>0?net/t.p.riskUsd:null;
    return{realized,commission,commissionAsset,net,actualR}
  }catch(e){
    console.warn('ONETAP_SETTLED_STATS_ERR',t.p.id,String(e.message||e));
    return null
  }
}

async function monitorTrade(id){
  const t=liveTrades.get(id);
  if(!t)return;
  for(let i=0;i<720;i++){
    await sleep(2000);
    try{
      const acc=await account(true);
      const pos=(acc.positions||[]).filter(x=>x.symbol===t.p.symbol);
      const open=pos.some(x=>Math.abs(Number(x.positionAmt||0))>0);
      if(open)continue;

      await cancelAlgo(t.p.symbol,safeId('mhsl_',id));
      await cancelAlgo(t.p.symbol,safeId('mhtp_',id));
      const stats=await settledStats(t);
      liveTrades.delete(id);

      console.log('ONETAP_POSITION_CLOSED',JSON.stringify({id,symbol:t.p.symbol,stats}));
      try{
        const lines=['✅ LIVE POSITION CLOSED',`${t.p.symbol} ${t.p.side}`];
        if(stats){
          lines.push(`Realized PnL: ${stats.realized.toFixed(4)} USDT`);
          lines.push(`Commission: ${stats.commission.toFixed(4)} ${stats.commissionAsset}`);
          if(stats.commissionAsset==='USDT')lines.push(`Net PnL: ${stats.net.toFixed(4)} USDT`);
          if(Number.isFinite(stats.actualR))lines.push(`Actual R: ${stats.actualR>=0?'+':''}${stats.actualR.toFixed(2)}R`)
        }
        lines.push('Protective sibling order cleaned.');
        await tg('sendMessage',{chat_id:TG_CHAT,text:lines.join('\n')})
      }catch{}
      return
    }catch(e){
      console.warn('ONETAP_MONITOR_TICK_ERR',id,String(e.message||e))
    }
  }
}

async function handleCallback(q){
  const data=String(q.data||''),chat=String(q.message?.chat?.id||''),user=String(q.from?.id||'');
  if(chat!==TG_CHAT)return;
  if(AUTH_USER&&user!==AUTH_USER){
    try{await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Not authorized for LIVE execution.',show_alert:true})}catch{}
    console.warn('ONETAP_UNAUTHORIZED_CALLBACK',JSON.stringify({chat,user}));
    return
  }
  const[kind,token]=data.split(':');
  if(!['mh','ms'].includes(kind)||!token)return;

  const item=pending.get(token);
  if(!item){await tg('answerCallbackQuery',{callback_query_id:q.id,text:'This ticket expired or was already handled.',show_alert:true});return}
  if(item.locked){await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Already processing.',show_alert:false});return}
  if(Date.now()>item.expiresAt){
    pending.delete(token);completed.add(item.id);
    await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Ticket expired.',show_alert:true});
    await editMessage(item.messageId,'⌛ LIVE TICKET EXPIRED\n'+item.id);
    return
  }
  if(kind==='ms'){
    item.locked=true;pending.delete(token);completed.add(item.id);
    await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Skipped.'});
    await editMessage(item.messageId,`❌ SKIPPED\n${item.preview.symbol} ${item.preview.side}\nNo order was submitted.`);
    console.log('ONETAP_SKIPPED',item.id);
    return
  }

  item.locked=true;completed.add(item.id);
  await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Submitting to Binance Futures…'});
  await editMessage(item.messageId,`⏳ SUBMITTING LIVE\n${item.preview.symbol} ${item.preview.side}\nRechecking execution cost, balance, sizing and leverage…`);

  try{
    const r=await executePending(item);
    pending.delete(token);

    if(!r.ok){
      if(r.partialClosed){
        await editMessage(item.messageId,`⚠️ PARTIAL FILL REJECTED\n${r.p.symbol} ${r.p.side}\nFilled ${(r.fillRatio*100).toFixed(1)}% only; small partial was immediately closed.\nNo position left open.`);
        console.log('ONETAP_PARTIAL_REJECTED_CLOSED',JSON.stringify({id:item.id,symbol:r.p.symbol,fillRatio:r.fillRatio,filled:r.executedQty}));
        return
      }
      await editMessage(item.messageId,`⚠️ LIVE NOT FILLED\n${r.p.symbol} ${r.p.side}\nIOC entry was not filled. No position opened.`);
      console.log('ONETAP_NOT_FILLED',JSON.stringify({id:item.id,symbol:r.p.symbol,reason:r.reason}));
      return
    }

    await editMessage(item.messageId,[
      '✅ BINANCE FUTURES LIVE',
      `${r.p.symbol} ${r.p.side}`,
      `Filled qty: ${r.executedQty} (${(r.fillRatio*100).toFixed(1)}%)`,
      `Avg fill: ${r.avgPrice}`,
      `Leverage: ${r.p.leverage}x`,
      `SL: ${r.p.sl}`,
      `TP: ${r.p.tp}`,
      `Risk incl. est. costs: ~${r.p.actualRisk.toFixed(2)} USDT`,
      `Est. net RR: ${r.p.netRR.toFixed(2)}`,
      'SL/TP protection submitted.'
    ].join('\n'));

    console.log('ONETAP_LIVE_EXECUTED',JSON.stringify({
      id:item.id,symbol:r.p.symbol,side:r.p.side,qty:r.executedQty,fillRatio:r.fillRatio,avgPrice:r.avgPrice,lev:r.p.leverage,
      actualRisk:r.p.actualRisk,netRR:r.p.netRR,feeRate:r.p.feeRate
    }))
  }catch(e){
    pending.delete(token);
    await editMessage(item.messageId,`❌ LIVE EXECUTION FAILED\n${item.preview.symbol} ${item.preview.side}\n${String(e.message||e).slice(0,300)}\nNo retry was sent automatically.`);
    console.error('ONETAP_EXEC_ERROR',item.id,String(e.message||e))
  }
}

async function pollTelegram(){
  if(!TG_TOKEN||!TG_CHAT){console.error('ONETAP_TG_MISSING');return}
  while(true){
    try{
      const updates=await tg('getUpdates',{offset:updateOffset,timeout:20,allowed_updates:['callback_query']});
      tgPollOk=true;
      for(const u of updates||[]){
        updateOffset=Math.max(updateOffset,Number(u.update_id||0)+1);
        if(u.callback_query)await handleCallback(u.callback_query)
      }
    }catch(e){
      tgPollOk=false;
      console.error('ONETAP_TG_POLL_ERR',String(e.message||e));
      await sleep(3000)
    }
  }
}

async function forward(req,raw){
  const headers={};
  for(const[k,v]of Object.entries(req.headers)){
    if(['host','content-length','connection'].includes(k.toLowerCase())||v==null)continue;
    headers[k]=Array.isArray(v)?v.join(','):String(v)
  }
  return fetch(UPSTREAM+'/ingest',{method:'POST',headers,body:raw})
}

setInterval(()=>{
  const now=Date.now();
  for(const[token,x]of pending)if(now>x.expiresAt+60000)pending.delete(token)
},30000).unref();

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&(req.url==='/health'||req.url==='/status')){
      const body={
        ok:true,service:'BINANCE_COMBINED_EDGE_ONETAP',live:LIVE,tgPollOk,pending:pending.size,completed:completed.size,liveTrades:liveTrades.size,
        riskPct:RISK_PCT,maxLeverage:MAX_LEV,maxMarginUtilization:MARGIN_UTIL,maxOpenPositions:MAX_OPEN,
        executionGate:{minNetRR:MIN_NET_RR,fallbackTakerFeeBps:FALLBACK_TAKER_FEE*10000,slippageBpsPerSide:SLIP_SIDE*10000,minFillRatio:MIN_FILL_RATIO}
      };
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify(body))
    }

    if(req.method==='POST'&&req.url==='/ingest'){
      const chunks=[];for await(const c of req)chunks.push(c);
      const raw=Buffer.concat(chunks);
      let payload=null;try{payload=JSON.parse(raw.toString('utf8'))}catch{}
      if(payload){for(const t of findTickets(payload))void sendPending(t)}
      try{
        const u=await forward(req,raw),b=Buffer.from(await u.arrayBuffer());
        res.writeHead(u.status,{'content-type':u.headers.get('content-type')||'application/json'});
        return res.end(b)
      }catch(e){
        res.writeHead(502,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:false,error:'upstream_unreachable',detail:String(e.message||e)}))
      }
    }

    res.writeHead(404,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:false,error:'not_found'}))
  }catch(e){
    res.writeHead(500,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:false,error:String(e.message||e)}))
  }
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('BINANCE_ONETAP_READY',JSON.stringify({
    port:PORT,live:LIVE,ttlMs:TTL,riskPct:RISK_PCT,maxLeverage:MAX_LEV,maxMarginUtilization:MARGIN_UTIL,maxOpenPositions:MAX_OPEN,
    executionGate:{minNetRR:MIN_NET_RR,fallbackTakerFeeBps:FALLBACK_TAKER_FEE*10000,slippageBpsPerSide:SLIP_SIDE*10000,minFillRatio:MIN_FILL_RATIO}
  }));
  refreshMeta().catch(e=>console.error('ONETAP_META_BOOT_ERR',String(e.message||e)));
  pollTelegram()
});
