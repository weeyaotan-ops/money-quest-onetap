import { VersionedTransaction } from '@solana/web3.js';
import { C, USDC_MINT } from './config.js';
import { signer } from './solana.js';

const BASE = 'https://api.jup.ag/swap/v2';

function headers(json = false) {
  if (!C.JUPITER_API_KEY) throw new Error('MISSING_JUPITER_API_KEY');
  return {
    'x-api-key': C.JUPITER_API_KEY,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

export async function order({ inputMint, outputMint, amount, taker = '' }) {
  const p = new URLSearchParams({ inputMint, outputMint, amount: String(amount) });
  if (taker) p.set('taker', taker);
  const r = await fetch(`${BASE}/order?${p}`, { headers: headers(false) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`JUP_ORDER_BAD_JSON_${r.status}_${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`JUP_ORDER_HTTP_${r.status}_${j?.error || j?.errorMessage || text.slice(0, 120)}`);
  if (!j.outAmount || BigInt(j.outAmount) <= 0n) throw new Error(`JUP_ORDER_NO_OUTPUT_${j.errorCode || ''}_${j.errorMessage || ''}`);
  return j;
}

export async function execute(orderResponse) {
  if (!orderResponse?.transaction || !orderResponse?.requestId) throw new Error('JUP_ORDER_NOT_EXECUTABLE');
  const tx = VersionedTransaction.deserialize(Buffer.from(orderResponse.transaction, 'base64'));
  tx.sign([signer()]);
  const signedTransaction = Buffer.from(tx.serialize()).toString('base64');
  const r = await fetch(`${BASE}/execute`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ signedTransaction, requestId: orderResponse.requestId }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`JUP_EXEC_BAD_JSON_${r.status}_${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`JUP_EXEC_HTTP_${r.status}_${j?.error || text.slice(0, 120)}`);
  if (j.status !== 'Success' || Number(j.code) !== 0) throw new Error(`JUP_EXEC_FAILED_${j.code}_${j.error || j.status || 'unknown'}`);
  return j;
}

export async function roundTripPreview(mint, usdcRaw) {
  const buy = await order({ inputMint: USDC_MINT, outputMint: mint, amount: usdcRaw });
  const sell = await order({ inputMint: mint, outputMint: USDC_MINT, amount: buy.outAmount });
  const input = Number(usdcRaw);
  const back = Number(sell.outAmount);
  const roundtripLossPct = input > 0 ? ((input - back) / input) * 100 : 100;
  return { buy, sell, roundtripLossPct };
}

export async function buildLiveBuyOrder(mint, usdcRaw) {
  const s = signer();
  const o = await order({ inputMint: USDC_MINT, outputMint: mint, amount: usdcRaw, taker: s.publicKey.toBase58() });
  if (!o.transaction) throw new Error(`JUP_BUY_NOT_EXECUTABLE_${o.errorCode || ''}_${o.errorMessage || ''}`);
  return o;
}

export async function liveSell(mint, tokenRaw) {
  const s = signer();
  const o = await order({ inputMint: mint, outputMint: USDC_MINT, amount: tokenRaw, taker: s.publicKey.toBase58() });
  if (!o.transaction) throw new Error(`JUP_SELL_NOT_EXECUTABLE_${o.errorCode || ''}_${o.errorMessage || ''}`);
  return { order: o, result: await execute(o) };
}

export async function sellPreview(mint, tokenRaw) {
  return order({ inputMint: mint, outputMint: USDC_MINT, amount: tokenRaw });
}
