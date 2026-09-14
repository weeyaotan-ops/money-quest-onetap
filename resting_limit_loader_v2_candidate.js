(async()=>{
  const http=require('node:http');
  const NOOP_PORT=18103;
  if(!global.__EXACT_MIRROR_NOOP_UPSTREAM__){
    const server=http.createServer(async(req,res)=>{
      if(req.method==='POST'&&req.url==='/ingest'){
        for await (const _ of req) {}
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:true,mode:'EXACT_MIRROR_V2_RESTING_ONLY',legacySuppressed:true}));
      }
      res.writeHead(404,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'not_found'}));
    });
    server.listen(NOOP_PORT,'127.0.0.1',()=>console.log('EXACT_MIRROR_V2_RESTING_LEGACY_SUPPRESSED',NOOP_PORT));
    global.__EXACT_MIRROR_NOOP_UPSTREAM__=server;
  }
  process.env.BINANCE_ONETAP_UPSTREAM=`http://127.0.0.1:${NOOP_PORT}`;

  const SRC='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/main/exact_mirror_gateway_v2.js';
  const r=await fetch(SRC,{cache:'no-store'});
  if(!r.ok) throw new Error('EXACT_MIRROR_V2_FETCH_'+r.status);
  let src=await r.text();

  function mustReplace(from,to,label){
    if(!src.includes(from)) throw new Error('RESTING_V2_PATCH_MISS_'+label);
    src=src.replace(from,to);
  }

  if(!src.includes("version: 'EXACT_MIRROR_V2'")||
     !src.includes("sizingPolicy: 'LIVE_EQUITY_AT_SIGNAL_LOCK_ONCE'")||
     !src.includes("confirmPolicy: 'REVALIDATE_ONLY_NO_RESIZE'")) {
    throw new Error('EXACT_MIRROR_V2_SOURCE_INVALID');
  }

  mustReplace(
    "const equity = Number(acc.totalWalletBalance || 0);",
    "const equity = Number(acc.totalMarginBalance || acc.totalWalletBalance || 0);",
    'LIVE_FUTURES_EQUITY'
  );

  mustReplace(
    "const MAX_SIGNAL_AGE = Math.max(TTL, Number(process.env.BINANCE_MAX_SIGNAL_AGE_MS || 120000));",
    "const MAX_SIGNAL_AGE = Math.max(TTL, Number(process.env.BINANCE_MAX_SIGNAL_AGE_MS || 120000));\nconst ENTRY_POLL_MS = Math.max(250, Number(process.env.BINANCE_RESTING_POLL_MS || 500));",
    'POLL_CONST'
  );

  const oldEntry=`async function entryOrder(p, hedge) {\n  const params = {\n    symbol: p.symbol,\n    side: p.side,\n    type: 'LIMIT',\n    timeInForce: 'IOC',\n    quantity: p.qtyStr,\n    price: p.priceStr,\n    newClientOrderId: safeId('mhm2_', p.id),\n    newOrderRespType: 'RESULT',\n    positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH'\n  };\n  return signed('POST', '/fapi/v1/order', params);\n}`;

  const newEntry=`async function entryOrder(p, hedge) {\n  const params = {\n    symbol: p.symbol,\n    side: p.side,\n    type: 'LIMIT',\n    timeInForce: 'GTC',\n    quantity: p.qtyStr,\n    price: p.priceStr,\n    newClientOrderId: safeId('mhm2_', p.id),\n    newOrderRespType: 'ACK',\n    positionSide: hedge ? (p.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH'\n  };\n  return signed('POST', '/fapi/v1/order', params);\n}\n\nasync function queryEntryOrder(p) {\n  return signed('GET', '/fapi/v1/order', { symbol: p.symbol, origClientOrderId: safeId('mhm2_', p.id) });\n}\n\nasync function cancelEntryOrder(p) {\n  try {\n    return await signed('DELETE', '/fapi/v1/order', { symbol: p.symbol, origClientOrderId: safeId('mhm2_', p.id) });\n  } catch (e) {\n    console.warn('EXACT_MIRROR_V2_ENTRY_CANCEL_FALLBACK', p.id, String(e.message || e));\n    return null;\n  }\n}\n\nasync function waitForRestingEntry(p, deadline) {\n  let last = await queryEntryOrder(p);\n  while (true) {\n    const executedQty = Number(last?.executedQty || 0);\n    const status = String(last?.status || '');\n    if (executedQty > 0) {\n      if (status !== 'FILLED') await cancelEntryOrder(p);\n      const finalOrder = await queryEntryOrder(p).catch(() => last);\n      const finalQty = Number(finalOrder?.executedQty || executedQty);\n      console.log('EXACT_MIRROR_V2_RESTING_FILL', JSON.stringify({ id: p.id, symbol: p.symbol, status: String(finalOrder?.status || status), executedQty: finalQty, fillRatio: p.qty > 0 ? finalQty / p.qty : 0 }));\n      return finalOrder;\n    }\n    if (['CANCELED','REJECTED','EXPIRED'].includes(status)) return last;\n    const remaining = Number(deadline || 0) - Date.now();\n    if (!(remaining > 0)) {\n      await cancelEntryOrder(p);\n      const finalOrder = await queryEntryOrder(p).catch(() => last);\n      console.log('EXACT_MIRROR_V2_RESTING_EXPIRED', JSON.stringify({ id: p.id, symbol: p.symbol, status: String(finalOrder?.status || status), executedQty: Number(finalOrder?.executedQty || 0) }));\n      return finalOrder;\n    }\n    await sleep(Math.min(ENTRY_POLL_MS, remaining));\n    last = await queryEntryOrder(p);\n  }\n}`;
  mustReplace(oldEntry,newEntry,'ENTRY_ORDER');

  const oldExec=`  const order = await entryOrder(p, hedge);\n  const executedQty = Number(order.executedQty || 0);\n  const status = String(order.status || '');\n  if (!(executedQty > 0)) return { ok: false, reason: \`NOT_FILLED_\${status || 'IOC'}\`, p, order };`;
  const newExec=`  const orderAck = await entryOrder(p, hedge);\n  console.log('EXACT_MIRROR_V2_RESTING_PLACED', JSON.stringify({ id: p.id, symbol: p.symbol, side: p.side, price: p.entry, qty: p.qtyStr, deadline: item.expiresAt, orderId: orderAck?.orderId }));\n  const order = await waitForRestingEntry(p, item.expiresAt);\n  const executedQty = Number(order.executedQty || 0);\n  const status = String(order.status || '');\n  if (!(executedQty > 0)) return { ok: false, reason: \`NOT_FILLED_\${status || 'GTC_TIMEOUT'}\`, p, order };`;
  mustReplace(oldExec,newExec,'EXECUTE_LOCKED');

  mustReplace(
    "if (u.callback_query) await handleCallback(u.callback_query);",
    "if (u.callback_query) { try { await handleCallback(u.callback_query); } catch (cbErr) { console.warn('EXACT_MIRROR_V2_CALLBACK_DRAIN_ERR', String(cbErr.message || cbErr)); } }",
    'CALLBACK_ISOLATION'
  );

  mustReplace(
    "Exact Combined entry was not filled. No chase. No position opened.",
    "Exact Combined entry was not filled before expiry. Resting order cancelled. No chase. No position opened.",
    'NOT_FILLED_TEXT'
  );

  mustReplace(
    "'Rechecking tradability and available margin only. No resize.'",
    "'Rechecking tradability and available margin only. No resize. Exact Entry will rest until ticket expiry; no chase.'",
    'SUBMIT_TEXT'
  );

  mustReplace(
    "entryPolicy: 'EXACT_LIMIT_IOC_NO_CHASE'",
    "entryPolicy: 'EXACT_LIMIT_GTC_BOUNDED_NO_CHASE'",
    'HEALTH_POLICY'
  );

  mustReplace(
    "'V2 lock: direction + Entry + SL + TP + qty + leverage are frozen at signal arrival. Confirm does not resize.'",
    "'V2 lock: direction + Entry + SL + TP + qty + leverage are frozen at signal arrival. Confirm does not resize. Exact Entry rests until expiry; no chase.'",
    'TICKET_TEXT'
  );

  src=src.replace(/EXACT_MIRROR_V2/g,'EXACT_MIRROR_V2_RESTING');
  console.log('EXACT_MIRROR_V2_RESTING_LOADER',src.length);
  eval(src);
})().catch(e=>{console.error('EXACT_MIRROR_V2_RESTING_BOOT_ERR',e&&e.stack||e);process.exit(1)});
