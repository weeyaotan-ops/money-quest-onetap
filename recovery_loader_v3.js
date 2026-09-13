(async()=>{
  const SRC='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/c5b70fbec00e4288835e25905ba455d6e610b52b/binance_onetap_gateway.js';
  let s=await (await fetch(SRC)).text();
  if(!s.includes("async function preview(ticket,force=false)")) throw new Error('V3_BASE_PREVIEW_NOT_FOUND');

  s=s.replace(
`const FALLBACK_TAKER_FEE=Math.max(0,Number(process.env.EST_FEE_BPS_PER_SIDE||5))/10000;
const SLIP_SIDE=Math.max(0,Number(process.env.EST_SLIPPAGE_BPS_PER_SIDE||1))/10000;
const MIN_NET_RR=Math.max(0,Number(process.env.MIN_NET_RR||1.5));
const MIN_NET_PROFIT=Math.max(0,Number(process.env.MIN_NET_PROFIT_USDT||0));
const MIN_FILL_RATIO=Math.min(1,Math.max(0.1,Number(process.env.BINANCE_MIN_FILL_RATIO||0.80)));`,
`const FALLBACK_TAKER_FEE=Math.max(0,Number(process.env.EST_FEE_BPS_PER_SIDE||5))/10000;
const FALLBACK_MAKER_FEE=Math.max(0,Number(process.env.EST_MAKER_FEE_BPS_PER_SIDE||2))/10000;
const SLIP_SIDE=Math.max(0,Number(process.env.EST_SLIPPAGE_BPS_PER_SIDE||1))/10000;
const MIN_NET_EV_R=Number(process.env.MIN_NET_EV_R||0.05);
const MIN_NET_RR_FLOOR=Math.max(0,Number(process.env.MIN_NET_RR_FLOOR||0.50));
const PRIOR_WIN_RATE=Math.min(0.95,Math.max(0.05,Number(process.env.COMBINED_OOS_WIN_RATE||0.453)));
const MIN_NET_PROFIT=Math.max(0,Number(process.env.MIN_NET_PROFIT_USDT||0));
const MIN_FILL_RATIO=Math.min(1,Math.max(0.1,Number(process.env.BINANCE_MIN_FILL_RATIO||0.80)));
const MAKER_WAIT_MS=Math.max(3000,Math.min(60000,Number(process.env.BINANCE_MAKER_WAIT_MS||25000)));
const MAKER_POLL_MS=Math.max(200,Math.min(2000,Number(process.env.BINANCE_MAKER_POLL_MS||500)));`);

  s=s.replace(
`async function takerFee(symbol,force=false){
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
}`,
`async function feeRates(symbol,force=false){
  const c=commissionCache.get(symbol);
  if(!force&&c&&Date.now()-c.at<300000)return c;
  try{
    const j=await signed('GET','/fapi/v1/commissionRate',{symbol});
    const taker=Number(j?.takerCommissionRate),maker=Number(j?.makerCommissionRate);
    const out={taker:Number.isFinite(taker)&&taker>=0?taker:FALLBACK_TAKER_FEE,maker:Number.isFinite(maker)&&maker>=0?maker:FALLBACK_MAKER_FEE,at:Date.now()};
    commissionCache.set(symbol,out);return out
  }catch(e){
    console.warn('ONETAP_COMMISSION_FALLBACK',symbol,String(e.message||e));
    const out={taker:FALLBACK_TAKER_FEE,maker:FALLBACK_MAKER_FEE,at:Date.now()};commissionCache.set(symbol,out);return out
  }
}
function ticketWinProb(ticket){
  for(const k of ['winProb','winProbability','pWin','combinedWinProb','edgeProbability','probability']){
    const v=Number(ticket?.[k]);if(Number.isFinite(v)){const p=v>1&&v<=100?v/100:v;if(p>0&&p<1)return p}
  }
  return PRIOR_WIN_RATE
}
function economics(entry,sl,tp,pWin,entryFee,tpFee,slFee,entrySlip,tpSlip,slSlip){
  const dist=Math.abs(entry-sl),reward=Math.abs(tp-entry);
  const lossCost=dist+entry*(entryFee+entrySlip)+sl*(slFee+slSlip);
  const netReward=reward-entry*(entryFee+entrySlip)-tp*(tpFee+tpSlip);
  const netRR=netReward>0&&lossCost>0?netReward/lossCost:-Infinity;
  const netEVR=Number.isFinite(netRR)?pWin*netRR-(1-pWin):-Infinity;
  return{lossCost,netReward,netRR,netEVR}
}`);

  const previewV3=`async function preview(ticket,force=false){
  await refreshMeta();
  const symbol=normalizeSymbol(ticket),meta=exchangeMeta.get(symbol);
  if(!meta)return{blocked:'SYMBOL_NOT_USDM_PERP',symbol};
  const side=String(ticket.side||'').toUpperCase();
  if(!['BUY','SELL'].includes(side))return{blocked:'BAD_SIDE',symbol};
  const entry=roundStep(Number(ticket.entry),meta.tickSize),sl=roundStep(Number(ticket.sl),meta.tickSize),tp=roundStep(Number(ticket.tp),meta.tickSize);
  if(![entry,sl,tp].every(Number.isFinite)||entry<=0)return{blocked:'BAD_PRICES',symbol};
  if(side==='BUY'&&!(sl<entry&&tp>entry))return{blocked:'INVALID_BUY_LEVELS',symbol};
  if(side==='SELL'&&!(sl>entry&&tp<entry))return{blocked:'INVALID_SELL_LEVELS',symbol};
  const dist=Math.abs(entry-sl),reward=Math.abs(tp-entry),grossRR=reward/dist,stopBps=dist/entry*10000;
  if(!(dist>0&&reward>0))return{blocked:'BAD_RISK',symbol};
  const fees=await feeRates(symbol,force),pWin=ticketWinProb(ticket);
  const modes={
    takerTaker:economics(entry,sl,tp,pWin,fees.taker,fees.taker,fees.taker,SLIP_SIDE,SLIP_SIDE,SLIP_SIDE),
    makerEntry:economics(entry,sl,tp,pWin,fees.maker,fees.taker,fees.taker,0,SLIP_SIDE,SLIP_SIDE),
    makerEntryMakerTP:economics(entry,sl,tp,pWin,fees.maker,fees.maker,fees.taker,0,0,SLIP_SIDE)
  };
  let executionMode=null,econ=null;
  if(modes.takerTaker.netReward>0&&modes.takerTaker.netRR>=MIN_NET_RR_FLOOR&&modes.takerTaker.netEVR>=MIN_NET_EV_R){executionMode='takerTaker';econ=modes.takerTaker}
  else if(modes.makerEntry.netReward>0&&modes.makerEntry.netRR>=MIN_NET_RR_FLOOR&&modes.makerEntry.netEVR>=MIN_NET_EV_R){executionMode='makerEntry';econ=modes.makerEntry}
  else{
    const best=[['takerTaker',modes.takerTaker],['makerEntry',modes.makerEntry],['makerEntryMakerTP',modes.makerEntryMakerTP]].sort((a,b)=>(b[1].netEVR||-999)-(a[1].netEVR||-999))[0];
    return{blocked:'NO_EXECUTION_ROUTE_PRESERVES_EDGE',symbol,entry,sl,tp,grossRR,stopBps,pWin,modes,bestMode:best[0],bestNetRR:Number.isFinite(best[1].netRR)?best[1].netRR:null,bestNetEVR:Number.isFinite(best[1].netEVR)?best[1].netEVR:null,estimatedRoundTripBps:2*(fees.taker+SLIP_SIDE)*10000}
  }
  const acc=await account(force),equity=Number(acc.totalWalletBalance||0),avail=Number(acc.availableBalance||0);
  if(!(equity>0&&avail>0))return{blocked:'NO_FUTURES_USDT',symbol,equity,avail};
  const nz=nonzeroPositions(acc);
  if(nz.some(p=>p.symbol===symbol))return{blocked:'EXISTING_SYMBOL_POSITION',symbol,equity,avail};
  if(nz.length>=MAX_OPEN)return{blocked:'MAX_OPEN_POSITIONS',symbol,equity,avail,open:nz.length};
  const riskUsd=equity*(RISK_PCT/100);if(!(riskUsd>0))return{blocked:'BAD_RISK',symbol,equity,avail};
  const maxLev=await maxLeverage(symbol),rawQty=riskUsd/econ.lossCost,maxNotional=avail*MARGIN_UTIL*maxLev;
  const qty=floorStep(Math.min(rawQty,maxNotional/entry,meta.maxQty),meta.stepSize),notional=qty*entry;
  if(!(qty>=meta.minQty)||notional<meta.minNotional)return{blocked:'BELOW_MIN_ORDER',symbol,equity,avail,qty,notional};
  const leverage=Math.max(1,Math.min(maxLev,Math.ceil(notional/(avail*MARGIN_UTIL)))),margin=notional/leverage;
  const actualRisk=qty*econ.lossCost,netProfit=qty*econ.netReward;
  if(netProfit<MIN_NET_PROFIT)return{blocked:'NET_PROFIT_TOO_LOW',symbol,equity,avail,netProfit,minNetProfit:MIN_NET_PROFIT};
  return{blocked:null,id:String(ticket.id),symbol,side,setup:ticket.setup||'',entry,sl,tp,qty,qtyStr:fmt(qty,meta.stepSize),priceStr:fmt(entry,meta.tickSize),slStr:fmt(sl,meta.tickSize),tpStr:fmt(tp,meta.tickSize),equity,avail,riskUsd,actualRisk,netProfit,notional,leverage,margin,maxLev,meta,feeRate:fees.taker,makerFeeRate:fees.maker,slipRate:SLIP_SIDE,grossRR,netRR:econ.netRR,netEVR:econ.netEVR,pWin,stopBps,estimatedRoundTripBps:2*(fees.taker+SLIP_SIDE)*10000,lossCostPerUnit:econ.lossCost,netRewardPerUnit:econ.netReward,executionMode,modes}
}`;
  s=s.replace(/async function preview\(ticket,force=false\)\{[\s\S]*?\n\}\n\nfunction ticketText/,previewV3+'\n\nfunction ticketText');

  s=s.replace("    `Gross RR: ${p.grossRR.toFixed(2)} | Est. net RR: ${p.netRR.toFixed(2)}`,", "    `Execution: ${p.executionMode==='makerEntry'?'MAKER ENTRY (post-only)':'TAKER/IOC'}`,\n    `Gross RR: ${p.grossRR.toFixed(2)} | Est. net RR: ${p.netRR.toFixed(2)} | Net EV: ${p.netEVR>=0?'+':''}${p.netEVR.toFixed(3)}R`,");

  s=s.replace(/async function sendPending\(ticket\)\{[\s\S]*?\n\}\n\nasync function changeLeverage/,`async function sendPending(ticket){
  const id=String(ticket.id||'');if(!id||notified.has(id)||completed.has(id))return;
  const opened=Date.parse(ticket.openedAt||0);if(Number.isFinite(opened)&&opened>0&&Date.now()-opened>MAX_SIGNAL_AGE){notified.add(id);return}
  notified.add(id);
  try{
    const p=await preview(ticket,false);
    if(p.blocked){console.log('ONETAP_RECOVERY_BLOCK',JSON.stringify({id,symbol:p.symbol,reason:p.blocked,bestMode:p.bestMode,bestNetRR:p.bestNetRR,bestNetEVR:p.bestNetEVR,grossRR:p.grossRR,stopBps:p.stopBps}));return}
    console.log('ONETAP_RECOVERY_ROUTE',JSON.stringify({id,symbol:p.symbol,mode:p.executionMode,netRR:p.netRR,netEVR:p.netEVR,pWin:p.pWin,takerEV:p.modes.takerTaker.netEVR,makerEV:p.modes.makerEntry.netEVR,shadowMakerTpEV:p.modes.makerEntryMakerTP.netEVR}));
    const token=crypto.randomBytes(10).toString('hex'),expiresAt=Date.now()+TTL;
    const msg=await tg('sendMessage',{chat_id:TG_CHAT,text:ticketText(p,Math.round(TTL/1000)),disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'✅ CONFIRM LIVE',callback_data:`mh:${token}`},{text:'❌ SKIP',callback_data:`ms:${token}`}]]}});
    pending.set(token,{ticket,id,preview:p,expiresAt,messageId:msg.message_id,locked:false});
    console.log('ONETAP_PENDING_SENT',JSON.stringify({id,symbol:p.symbol,mode:p.executionMode,qty:p.qtyStr,lev:p.leverage,netRR:p.netRR,netEVR:p.netEVR,actualRisk:p.actualRisk,expiresAt}))
  }catch(e){notified.delete(id);console.error('ONETAP_PENDING_ERR',id,String(e.message||e))}
}

async function changeLeverage`);

  s=s.replace(/async function entryOrder\(p,hedge\)\{[\s\S]*?\n\}\nasync function algoOrder/,`async function entryOrder(p,hedge){
  const params={symbol:p.symbol,side:p.side,type:'LIMIT',quantity:p.qtyStr,price:p.priceStr,newClientOrderId:safeId('mh_',p.id),newOrderRespType:'RESULT',positionSide:hedge?(p.side==='BUY'?'LONG':'SHORT'):'BOTH'};
  params.timeInForce=p.executionMode==='makerEntry'?'GTX':'IOC';
  return signed('POST','/fapi/v1/order',params)
}
async function cancelEntry(p){try{return await signed('DELETE','/fapi/v1/order',{symbol:p.symbol,origClientOrderId:safeId('mh_',p.id)})}catch{return null}}
async function queryEntry(p){return signed('GET','/fapi/v1/order',{symbol:p.symbol,origClientOrderId:safeId('mh_',p.id)})}
async function waitMakerEntry(p,first){
  let order=first;
  const until=Date.now()+MAKER_WAIT_MS;
  while(Date.now()<until){
    const q=Number(order?.executedQty||0),st=String(order?.status||'');
    if(st==='FILLED'||q>=p.qty*MIN_FILL_RATIO)return order;
    if(['CANCELED','EXPIRED','REJECTED'].includes(st))return order;
    await sleep(MAKER_POLL_MS);
    try{order=await queryEntry(p)}catch(e){console.warn('ONETAP_MAKER_QUERY_ERR',p.id,String(e.message||e))}
  }
  await cancelEntry(p);await sleep(200);
  try{order=await queryEntry(p)}catch{}
  return order
}
async function algoOrder`);

  s=s.replace(/async function executePending\(item\)\{[\s\S]*?\n\}\n\nasync function settledStats/,`async function executePending(item){
  if(!LIVE)throw new Error('LIVE_GATE_DISABLED');
  const p=await preview(item.ticket,true);if(p.blocked)throw new Error('BLOCKED_'+p.blocked);
  const hedge=await dualMode(true);await changeLeverage(p);
  let order=await entryOrder(p,hedge);
  if(p.executionMode==='makerEntry')order=await waitMakerEntry(p,order);
  const executedQty=Number(order.executedQty||0),status=String(order.status||'');
  if(!(executedQty>0)){if(p.executionMode==='makerEntry')await cancelEntry(p);return{ok:false,reason:`NOT_FILLED_${status||p.executionMode}`,p,order}}
  if(p.executionMode==='makerEntry'&&status!=='FILLED')await cancelEntry(p);
  const fillRatio=p.qty>0?executedQty/p.qty:0,qtyStr=fmt(executedQty,p.meta.stepSize);
  if(fillRatio<MIN_FILL_RATIO){
    console.warn('ONETAP_PARTIAL_FILL_REJECT',JSON.stringify({id:p.id,symbol:p.symbol,mode:p.executionMode,requested:p.qty,filled:executedQty,fillRatio,minFillRatio:MIN_FILL_RATIO}));
    let closeOrder;try{closeOrder=await emergencyClose(p,hedge,qtyStr)}catch(e){throw new Error('PARTIAL_FILL_REJECT_CLOSE_FAILED_POSITION_MAY_BE_OPEN_'+String(e.message||e))}
    await sleep(250);if(!(await verifyNoSymbolPosition(p.symbol)))throw new Error('PARTIAL_FILL_REJECT_POSITION_STILL_OPEN_CHECK_BINANCE');
    return{ok:false,reason:'PARTIAL_FILL_REJECTED_AND_CLOSED',p,order,executedQty,fillRatio,partialClosed:true,closeOrder}
  }
  const fills=await fillStats(p,order);let slAlgo=null,tpAlgo=null;
  try{slAlgo=await algoOrder(p,'SL',hedge);tpAlgo=await algoOrder(p,'TP',hedge)}catch(e){
    console.error('ONETAP_PROTECTION_FAIL',p.id,String(e.message||e));if(slAlgo)await cancelAlgo(p.symbol,safeId('mhsl_',p.id));if(tpAlgo)await cancelAlgo(p.symbol,safeId('mhtp_',p.id));
    try{await emergencyClose(p,hedge,qtyStr)}catch(closeErr){console.error('ONETAP_EMERGENCY_CLOSE_FAIL',p.id,String(closeErr.message||closeErr))}
    throw new Error('PROTECTION_FAIL_POSITION_CLOSED_ATTEMPTED_'+String(e.message||e))
  }
  const result={ok:true,p,order,executedQty,fillRatio,avgPrice:fills.avgPrice,entryCommission:fills.entryCommission,commissionAsset:fills.commissionAsset,hedge,slAlgo,tpAlgo};
  liveTrades.set(p.id,{...result,startedAt:Date.now()});monitorTrade(p.id).catch(e=>console.error('ONETAP_MONITOR_ERR',p.id,String(e.message||e)));return result
}

async function settledStats`);

  s=s.replace("const actualR=t.p.riskUsd>0?net/t.p.riskUsd:null;","const actualR=t.p.actualRisk>0?net/t.p.actualRisk:null;");
  s=s.replace("IOC entry was not filled. No position opened.","${r.p.executionMode==='makerEntry'?'Post-only maker entry did not fill in time.':'IOC entry was not filled.'} No position opened.");
  s=s.replace("      `Est. net RR: ${r.p.netRR.toFixed(2)}`,","      `Execution: ${r.p.executionMode}`,\n      `Est. net RR: ${r.p.netRR.toFixed(2)} | Net EV: ${r.p.netEVR>=0?'+':''}${r.p.netEVR.toFixed(3)}R`,");
  s=s.replace("actualRisk:r.p.actualRisk,netRR:r.p.netRR,feeRate:r.p.feeRate","actualRisk:r.p.actualRisk,netRR:r.p.netRR,netEVR:r.p.netEVR,executionMode:r.p.executionMode,feeRate:r.p.feeRate,makerFeeRate:r.p.makerFeeRate");

  s=s.replace(/executionGate:\{minNetRR:MIN_NET_RR,fallbackTakerFeeBps:FALLBACK_TAKER_FEE\*10000,slippageBpsPerSide:SLIP_SIDE\*10000,minFillRatio:MIN_FILL_RATIO\}/g,
    "executionRouter:{minNetEVR:MIN_NET_EV_R,minNetRRFloor:MIN_NET_RR_FLOOR,priorWinRate:PRIOR_WIN_RATE,fallbackTakerFeeBps:FALLBACK_TAKER_FEE*10000,fallbackMakerFeeBps:FALLBACK_MAKER_FEE*10000,slippageBpsPerSide:SLIP_SIDE*10000,minFillRatio:MIN_FILL_RATIO,makerWaitMs:MAKER_WAIT_MS}");
  s=s.replace("port:PORT,live:LIVE,ttlMs:TTL,riskPct:RISK_PCT,maxLeverage:MAX_LEV,maxMarginUtilization:MARGIN_UTIL,maxOpenPositions:MAX_OPEN,","port:PORT,version:'EV_V3_RECOVERY_ROUTER',live:LIVE,ttlMs:TTL,riskPct:RISK_PCT,maxLeverage:MAX_LEV,maxMarginUtilization:MARGIN_UTIL,maxOpenPositions:MAX_OPEN,");

  if(!s.includes("EV_V3_RECOVERY_ROUTER")||!s.includes("ONETAP_RECOVERY_ROUTE")||!s.includes("waitMakerEntry")) throw new Error('V3_PATCH_INCOMPLETE');
  console.log('ONETAP_RECOVERY_V3_PATCHED_SOURCE',s.length);
  eval(s);
})().catch(e=>{console.error('ONETAP_RECOVERY_V3_BOOT_ERR',e&&e.stack||e);process.exit(1)});
