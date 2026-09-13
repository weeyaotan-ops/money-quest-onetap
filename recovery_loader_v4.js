(async()=>{
  const V3='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/main/recovery_loader_v3.js';
  let v3=await (await fetch(V3)).text();
  if(!v3.includes('ONETAP_RECOVERY_V3_PATCHED_SOURCE')) throw new Error('V4_V3_SOURCE_NOT_FOUND');

  const inject=String.raw`
  // V4: preserve authoritative Combined lineage and maximize live capture.
  s=s.replace("async function sendPending(ticket){\\n  const id=String(ticket.id||'');", "async function sendPending(ticket){\\n  if(ticket?.combinedSelected!==true){console.log('ONETAP_LINEAGE_BLOCK',JSON.stringify({id:String(ticket?.id||''),symbol:String(ticket?.symbol||ticket?.instId||''),reason:'NOT_AUTHORITATIVE_COMBINED'}));return}\\n  const id=String(ticket.id||'');");

  s=s.replace(
    "else if(modes.makerEntry.netReward>0&&modes.makerEntry.netRR>=MIN_NET_RR_FLOOR&&modes.makerEntry.netEVR>=MIN_NET_EV_R){executionMode='makerEntry';econ=modes.makerEntry}\\n  else{",
    "else if(modes.makerEntry.netReward>0&&modes.makerEntry.netRR>=MIN_NET_RR_FLOOR&&modes.makerEntry.netEVR>=MIN_NET_EV_R){executionMode='makerEntry';econ=modes.makerEntry}\\n  else if(modes.makerEntryMakerTP.netReward>0&&modes.makerEntryMakerTP.netRR>=MIN_NET_RR_FLOOR&&modes.makerEntryMakerTP.netEVR>=MIN_NET_EV_R){executionMode='makerEntryMakerTP';econ=modes.makerEntryMakerTP}\\n  else{"
  );

  s=s.replace("p.executionMode==='makerEntry'?'MAKER ENTRY (post-only)':'TAKER/IOC'", "p.executionMode==='makerEntryMakerTP'?'MAKER ENTRY + MAKER TP':(p.executionMode==='makerEntry'?'MAKER ENTRY (post-only)':'TAKER/IOC')");
  s=s.replace("params.timeInForce=p.executionMode==='makerEntry'?'GTX':'IOC';", "params.timeInForce=p.executionMode.startsWith('makerEntry')?'GTX':'IOC';");
  s=s.replace("if(p.executionMode==='makerEntry')order=await waitMakerEntry(p,order);", "if(p.executionMode.startsWith('makerEntry'))order=await waitMakerEntry(p,order);");
  s=s.replace("if(!(executedQty>0)){if(p.executionMode==='makerEntry')await cancelEntry(p);", "if(!(executedQty>0)){if(p.executionMode.startsWith('makerEntry'))await cancelEntry(p);");
  s=s.replace("if(p.executionMode==='makerEntry'&&status!=='FILLED')await cancelEntry(p);", "if(p.executionMode.startsWith('makerEntry')&&status!=='FILLED')await cancelEntry(p);");

  s=s.replace("async function algoOrder(p,kind,hedge){", String.raw\`async function makerTpOrder(p,hedge,qtyStr){
  const params={symbol:p.symbol,side:p.side==='BUY'?'SELL':'BUY',type:'LIMIT',timeInForce:'GTX',quantity:qtyStr,price:p.tpStr,newClientOrderId:safeId('mhtpl_',p.id),newOrderRespType:'RESULT',positionSide:hedge?(p.side==='BUY'?'LONG':'SHORT'):'BOTH'};
  if(!hedge)params.reduceOnly='true';
  return signed('POST','/fapi/v1/order',params)
}
async function cancelMakerTp(p){try{return await signed('DELETE','/fapi/v1/order',{symbol:p.symbol,origClientOrderId:safeId('mhtpl_',p.id)})}catch{return null}}
async function algoOrder(p,kind,hedge){\`);

  s=s.replace(
    "const fills=await fillStats(p,order);let slAlgo=null,tpAlgo=null;\\n  try{slAlgo=await algoOrder(p,'SL',hedge);tpAlgo=await algoOrder(p,'TP',hedge)}catch(e){",
    "const fills=await fillStats(p,order);let slAlgo=null,tpAlgo=null,tpOrder=null;\\n  try{slAlgo=await algoOrder(p,'SL',hedge);if(p.executionMode==='makerEntryMakerTP')tpOrder=await makerTpOrder(p,hedge,qtyStr);else tpAlgo=await algoOrder(p,'TP',hedge)}catch(e){"
  );
  s=s.replace("if(tpAlgo)await cancelAlgo(p.symbol,safeId('mhtp_',p.id));", "if(tpAlgo)await cancelAlgo(p.symbol,safeId('mhtp_',p.id));if(tpOrder)await cancelMakerTp(p);");
  s=s.replace("hedge,slAlgo,tpAlgo};", "hedge,slAlgo,tpAlgo,tpOrder};");
  s=s.replace("await cancelAlgo(t.p.symbol,safeId('mhtp_',id));", "await cancelAlgo(t.p.symbol,safeId('mhtp_',id));\\n      await cancelMakerTp(t.p);");
  s=s.replace("'SL/TP protection submitted.'", "r.p.executionMode==='makerEntryMakerTP'?'SL protected + maker TP resting.':'SL/TP protection submitted.'");

  s=s.replace("version:'EV_V3_RECOVERY_ROUTER'", "version:'EV_V4_CAPTURE_ROUTER'");
  s=s.replace("makerWaitMs:MAKER_WAIT_MS}", "makerWaitMs:MAKER_WAIT_MS,makerTpLive:true,lineageLock:'combinedSelected=true'}");

  if(!s.includes("EV_V4_CAPTURE_ROUTER")||!s.includes("makerTpOrder")||!s.includes("ONETAP_LINEAGE_BLOCK")||!s.includes("makerEntryMakerTP';econ")) throw new Error('V4_PATCH_INCOMPLETE');
  console.log('ONETAP_CAPTURE_V4_PATCHED_SOURCE',s.length);
`;

  const needle='  eval(s);\n})().catch';
  if(!v3.includes(needle)) throw new Error('V4_INJECT_POINT_NOT_FOUND');
  v3=v3.replace(needle,inject+'\n  eval(s);\n})().catch');
  console.log('ONETAP_CAPTURE_V4_LOADER',v3.length);
  eval(v3);
})().catch(e=>{console.error('ONETAP_CAPTURE_V4_BOOT_ERR',e&&e.stack||e);process.exit(1)});
