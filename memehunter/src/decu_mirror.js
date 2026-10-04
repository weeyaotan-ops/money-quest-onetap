import http from 'node:http';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { C, USDC_MINT } from './config.js';
import { connection, signer, walletAddress, solBalance, usdcBalance, tokenBalanceRaw } from './solana.js';
import { notify } from './telegram.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TARGET = process.env.MIRROR_TARGET_WALLET || '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const LIVE = C.LIVE_TRADING;
const SCALE = positiveNum('MIRROR_COPY_SCALE', 1);
const MAX_WALLET_PCT = clamp(positiveNum('MIRROR_MAX_WALLET_PCT', 0.05), 0.001, 1);
const GAS_RESERVE_SOL = positiveNum('MIRROR_GAS_RESERVE_SOL', 0.03);
const MIN_BUY_SOL = positiveNum('MIRROR_MIN_BUY_SOL', 0.001);
const MAX_BUY_SOL = positiveNum('MIRROR_MAX_BUY_SOL', 0.05);
const MIN_BUY_USDC = positiveNum('MIRROR_MIN_BUY_USDC', 1);
const MAX_BUY_USDC = positiveNum('MIRROR_MAX_BUY_USDC', 10);
const MIN_TARGET_SOL = positiveNum('MIRROR_MIN_TARGET_SOL_SPEND', 0.0005);
const MIN_TARGET_USDC = positiveNum('MIRROR_MIN_TARGET_USDC_SPEND', 0.25);
const MAX_BUY_AGE_MS = Math.max(1000, positiveNum('MIRROR_MAX_BUY_AGE_MS', 8000));
const ADMIN_TOKEN = C.ADMIN_TOKEN || '';

let ready = false;
let paused = false;
let pauseReason = '';
let subscriptionId = null;
let queue = Promise.resolve();
const seen = new Map();
const stats = {
  detected: 0,
  buys: 0,
  sells: 0,
  mirrored: 0,
  skipped: 0,
  failed: 0,
  lastSignature: null,
  lastAction: null,
  lastAt: null,
};

function positiveNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function keyString(k) {
  if (!k) return '';
  if (typeof k === 'string') return k;
  if (k.pubkey?.toBase58) return k.pubkey.toBase58();
  if (k.pubkey) return String(k.pubkey);
  if (k.toBase58) return k.toBase58();
  return String(k);
}

function rawTokenMap(items, owner) {
  const out = new Map();
  for (const b of items || []) {
    if (b?.owner !== owner || !b?.mint) continue;
    const raw = b.uiTokenAmount?.amount;
    if (raw == null) continue;
    out.set(b.mint, {
      raw: BigInt(raw),
      decimals: Number(b.uiTokenAmount?.decimals || 0),
    });
  }
  return out;
}

function uiAmount(raw, decimals) {
  return Number(raw) / (10 ** decimals);
}

function parseAction(tx) {
  const meta = tx?.meta;
  const msg = tx?.transaction?.message;
  if (!meta || !msg) return null;

  const keys = msg.accountKeys || [];
  const targetIndex = keys.findIndex(k => keyString(k) === TARGET);
  if (targetIndex < 0) return null;

  const targetSigner = !!keys[targetIndex]?.signer;
  const preLamports = Number(meta.preBalances?.[targetIndex] || 0);
  const postLamports = Number(meta.postBalances?.[targetIndex] || 0);
  const fee = targetSigner ? Number(meta.fee || 0) : 0;

  const solSpent = Math.max(0, preLamports - postLamports - fee) / 1e9;
  const solReceived = Math.max(0, postLamports - preLamports + fee) / 1e9;
  const pre = rawTokenMap(meta.preTokenBalances, TARGET);
  const post = rawTokenMap(meta.postTokenBalances, TARGET);

  const usdcPre = pre.get(USDC_MINT)?.raw || 0n;
  const usdcPost = post.get(USDC_MINT)?.raw || 0n;
  const usdcDelta = usdcPost - usdcPre;
  const usdcSpent = usdcDelta < 0n ? Number(-usdcDelta) / 1e6 : 0;
  const usdcReceived = usdcDelta > 0n ? Number(usdcDelta) / 1e6 : 0;

  const mints = new Set([...pre.keys(), ...post.keys()]);
  mints.delete(USDC_MINT);
  mints.delete(SOL_MINT);

  const changes = [];
  for (const mint of mints) {
    const a = pre.get(mint) || { raw: 0n, decimals: post.get(mint)?.decimals || 0 };
    const b = post.get(mint) || { raw: 0n, decimals: a.decimals || 0 };
    const delta = b.raw - a.raw;
    if (delta === 0n) continue;
    changes.push({
      mint,
      preRaw: a.raw,
      postRaw: b.raw,
      deltaRaw: delta,
      decimals: b.decimals ?? a.decimals,
    });
  }

  const positive = changes.filter(x => x.deltaRaw > 0n);
  const negative = changes.filter(x => x.deltaRaw < 0n);

  const buyBase = usdcSpent >= MIN_TARGET_USDC
    ? { kind: 'USDC', spent: usdcSpent, pre: Number(usdcPre) / 1e6, mint: USDC_MINT }
    : solSpent >= MIN_TARGET_SOL
      ? { kind: 'SOL', spent: solSpent, pre: preLamports / 1e9, mint: SOL_MINT }
      : null;

  if (buyBase && positive.length === 1) {
    const t = positive[0];
    const targetRatio = buyBase.pre > 0 ? clamp(buyBase.spent / buyBase.pre, 0, 1) : 0;
    return {
      type: 'BUY',
      mint: t.mint,
      tokenDeltaRaw: t.deltaRaw,
      tokenDecimals: t.decimals,
      baseKind: buyBase.kind,
      baseMint: buyBase.mint,
      targetBaseSpent: buyBase.spent,
      targetBasePre: buyBase.pre,
      targetRatio,
    };
  }

  const sellBase = usdcReceived >= MIN_TARGET_USDC
    ? { kind: 'USDC', received: usdcReceived, mint: USDC_MINT }
    : solReceived >= MIN_TARGET_SOL
      ? { kind: 'SOL', received: solReceived, mint: SOL_MINT }
      : null;

  if (sellBase && negative.length === 1) {
    const t = negative[0];
    const sold = -t.deltaRaw;
    const sellPct = t.preRaw > 0n
      ? clamp(Number((sold * 1_000_000n) / t.preRaw) / 1_000_000, 0, 1)
      : 1;
    return {
      type: 'SELL',
      mint: t.mint,
      tokenDeltaRaw: t.deltaRaw,
      tokenDecimals: t.decimals,
      baseKind: sellBase.kind,
      baseMint: sellBase.mint,
      targetBaseReceived: sellBase.received,
      sellPct,
    };
  }

  return null;
}

function remember(signature) {
  seen.set(signature, Date.now());
  if (seen.size > 3000) {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [sig, ts] of seen) {
      if (ts < cutoff || seen.size > 2500) seen.delete(sig);
      if (seen.size <= 2500 && ts >= cutoff) break;
    }
  }
}

async function getTx(signature) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx) return tx;
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 150 + i * 100));
  }
  if (lastErr) throw lastErr;
  return null;
}

function jupHeaders(json = false) {
  if (!C.JUPITER_API_KEY) throw new Error('MISSING_JUPITER_API_KEY');
  return {
    'x-api-key': C.JUPITER_API_KEY,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function liveSwap(inputMint, outputMint, amountRaw) {
  const s = signer();
  const p = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    taker: s.publicKey.toBase58(),
  });
  const or = await fetch('https://api.jup.ag/swap/v2/order?' + p.toString(), {
    headers: jupHeaders(false),
  });
  const ot = await or.text();
  let order;
  try { order = JSON.parse(ot); } catch { throw new Error('JUP_ORDER_BAD_JSON_' + or.status); }
  if (!or.ok || !order?.transaction || !order?.requestId) {
    throw new Error('JUP_ORDER_FAILED_' + or.status + '_' + (order?.errorMessage || order?.error || 'unknown'));
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([s]);
  const signedTransaction = Buffer.from(tx.serialize()).toString('base64');
  const er = await fetch('https://api.jup.ag/swap/v2/execute', {
    method: 'POST',
    headers: jupHeaders(true),
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
  });
  const et = await er.text();
  let result;
  try { result = JSON.parse(et); } catch { throw new Error('JUP_EXEC_BAD_JSON_' + er.status); }
  if (!er.ok || result?.status !== 'Success' || Number(result?.code) !== 0) {
    throw new Error('JUP_EXEC_FAILED_' + er.status + '_' + (result?.error || result?.status || 'unknown'));
  }
  return { order, result };
}

async function planBuy(action) {
  const ratio = Math.min(MAX_WALLET_PCT, Math.max(0, action.targetRatio * SCALE));
  if (action.baseKind === 'SOL') {
    const bal = await solBalance();
    const available = Math.max(0, bal - GAS_RESERVE_SOL);
    const amount = Math.min(MAX_BUY_SOL, available * ratio);
    if (amount < MIN_BUY_SOL) {
      return { ok: false, reason: 'BUY_TOO_SMALL_OR_LOW_SOL', ratio, balance: bal, amount };
    }
    return { ok: true, ratio, amount, raw: Math.floor(amount * 1e9), baseMint: SOL_MINT };
  }

  const bal = await usdcBalance();
  const amount = Math.min(MAX_BUY_USDC, bal * ratio);
  if (amount < MIN_BUY_USDC) {
    return { ok: false, reason: 'BUY_TOO_SMALL_OR_LOW_USDC', ratio, balance: bal, amount };
  }
  return { ok: true, ratio, amount, raw: Math.floor(amount * 1e6), baseMint: USDC_MINT };
}

async function mirrorBuy(action, signature, ageMs) {
  stats.buys++;

  if (ageMs > MAX_BUY_AGE_MS) {
    stats.skipped++;
    await notify(
      '⏭️ DECU BUY SKIPPED — TOO LATE\n' +
      action.mint + '\n' +
      'Delay: ' + (ageMs / 1000).toFixed(1) + 's\n' +
      'Target TX: https://solscan.io/tx/' + signature
    );
    return;
  }

  if (paused) {
    stats.skipped++;
    return;
  }

  const plan = await planBuy(action);
  if (!plan.ok) {
    stats.skipped++;
    await notify(
      '⏭️ DECU BUY DETECTED — NOT COPIED\n' +
      action.mint + '\n' +
      'Reason: ' + plan.reason + '\n' +
      'Decu used: ' + action.targetBaseSpent.toFixed(4) + ' ' + action.baseKind + '\n' +
      'Decu wallet ratio: ' + (action.targetRatio * 100).toFixed(2) + '%'
    );
    return;
  }

  if (!LIVE) {
    await notify(
      '🟡 DECU BUY — SHADOW\n' +
      action.mint + '\n' +
      'Decu: ' + action.targetBaseSpent.toFixed(4) + ' ' + action.baseKind +
      ' (' + (action.targetRatio * 100).toFixed(2) + '% wallet)\n' +
      'We would buy: ' + plan.amount.toFixed(4) + ' ' + action.baseKind + '\n' +
      'Delay: ' + (ageMs / 1000).toFixed(2) + 's'
    );
    return;
  }

  try {
    const { result } = await liveSwap(plan.baseMint, action.mint, plan.raw);
    stats.mirrored++;
    await notify(
      '🟢 DECU MIRROR BUY\n' +
      action.mint + '\n' +
      'Bought: ' + plan.amount.toFixed(4) + ' ' + action.baseKind + '\n' +
      'Copied ratio: ' + (plan.ratio * 100).toFixed(2) + '%\n' +
      'Delay: ' + (ageMs / 1000).toFixed(2) + 's\n' +
      'Our TX: https://solscan.io/tx/' + result.signature
    );
  } catch (e) {
    stats.failed++;
    await notify('⚠️ DECU MIRROR BUY FAILED\n' + action.mint + '\n' + String(e.message).slice(0, 300));
  }
}

async function mirrorSell(action, signature, ageMs) {
  stats.sells++;
  const ownRaw = await tokenBalanceRaw(action.mint);
  if (ownRaw <= 0n) {
    stats.skipped++;
    return;
  }

  const pct = clamp(action.sellPct, 0, 1);
  let sellRaw = pct >= 0.999999
    ? ownRaw
    : (ownRaw * BigInt(Math.max(1, Math.floor(pct * 1_000_000)))) / 1_000_000n;
  if (sellRaw <= 0n) sellRaw = ownRaw;

  if (!LIVE) {
    await notify(
      '🟠 DECU SELL — SHADOW\n' +
      action.mint + '\n' +
      'Decu sold: ' + (pct * 100).toFixed(1) + '%\n' +
      'We would sell: ' + (pct * 100).toFixed(1) + '%\n' +
      'Delay: ' + (ageMs / 1000).toFixed(2) + 's'
    );
    return;
  }

  try {
    const { result } = await liveSwap(action.mint, action.baseMint, sellRaw.toString());
    stats.mirrored++;
    await notify(
      '✅ DECU MIRROR SELL\n' +
      action.mint + '\n' +
      'Sold: ' + (pct * 100).toFixed(1) + '%\n' +
      'To: ' + action.baseKind + '\n' +
      'Delay: ' + (ageMs / 1000).toFixed(2) + 's\n' +
      'Our TX: https://solscan.io/tx/' + result.signature
    );
  } catch (e) {
    stats.failed++;
    paused = true;
    pauseReason = 'SELL_FAILED:' + action.mint;
    await notify(
      '🛑 DECU MIRROR SELL FAILED — BUYS PAUSED\n' +
      action.mint + '\n' +
      String(e.message).slice(0, 300)
    );
  }
}

async function processSignature(signature) {
  if (!signature || seen.has(signature)) return;
  remember(signature);

  const tx = await getTx(signature);
  if (!tx || tx.meta?.err) return;

  const action = parseAction(tx);
  if (!action) return;

  stats.detected++;
  stats.lastSignature = signature;
  stats.lastAction = action.type + ':' + action.mint;
  stats.lastAt = new Date().toISOString();

  const ageMs = tx.blockTime ? Math.max(0, Date.now() - tx.blockTime * 1000) : 0;
  if (action.type === 'BUY') await mirrorBuy(action, signature, ageMs);
  if (action.type === 'SELL') await mirrorSell(action, signature, ageMs);
}

function enqueue(signature) {
  queue = queue
    .then(() => processSignature(signature))
    .catch(async e => {
      stats.failed++;
      console.error('MIRROR_PROCESS_ERROR', e.stack || e.message);
      await notify('⚠️ DECU MIRROR ERROR\n' + String(e.message).slice(0, 300));
    });
}

async function subscribe() {
  const target = new PublicKey(TARGET);
  subscriptionId = connection.onLogs(
    target,
    log => {
      if (!log?.err && log.signature) enqueue(log.signature);
    },
    'confirmed'
  );
  await subscriptionId;
}

async function status() {
  let wallet = { address: walletAddress() || null, sol: null, usdc: null };
  if (C.BS58_PRIVATE_KEY) {
    try {
      [wallet.sol, wallet.usdc] = await Promise.all([solBalance(), usdcBalance()]);
    } catch {}
  }
  return {
    ok: true,
    mode: LIVE ? 'DECU_MIRROR_AUTO_LIVE' : 'DECU_MIRROR_SHADOW',
    target: TARGET,
    paused,
    pauseReason,
    wallet,
    sizing: {
      copyScale: SCALE,
      maxWalletPct: MAX_WALLET_PCT,
      maxBuySol: MAX_BUY_SOL,
      maxBuyUsdc: MAX_BUY_USDC,
      gasReserveSol: GAS_RESERVE_SOL,
    },
    buyMaxAgeMs: MAX_BUY_AGE_MS,
    stats,
  };
}

function authorized(req) {
  return !!ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN;
}

function sendJson(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, ready ? 200 : 503, { ok: ready });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      if (!authorized(req)) return sendJson(res, 403, { ok: false });
      return sendJson(res, ready ? 200 : 503, await status());
    }
    if (req.method === 'POST' && url.pathname === '/pause') {
      if (!authorized(req)) return sendJson(res, 403, { ok: false });
      paused = true;
      pauseReason = 'ADMIN';
      await notify('⏸️ DECU MIRROR PAUSED');
      return sendJson(res, 200, { ok: true, paused });
    }
    if (req.method === 'POST' && url.pathname === '/resume') {
      if (!authorized(req)) return sendJson(res, 403, { ok: false });
      paused = false;
      pauseReason = '';
      await notify('▶️ DECU MIRROR RESUMED');
      return sendJson(res, 200, { ok: true, paused });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
});

async function boot() {
  if (LIVE && !C.JUPITER_API_KEY) throw new Error('MISSING_JUPITER_API_KEY');
  if (LIVE && !C.BS58_PRIVATE_KEY) throw new Error('MISSING_BS58_PRIVATE_KEY');
  new PublicKey(TARGET);

  await subscribe();
  ready = true;

  await notify(
    '🪞 DECU MIRROR STARTED\n' +
    'Mode: ' + (LIVE ? 'AUTO LIVE' : 'SHADOW / NO MONEY') + '\n' +
    'Target: ' + TARGET + '\n' +
    'Rule: Decu BUY = copy BUY | Decu SELL = same % SELL\n' +
    'Sizing: same wallet % × ' + SCALE.toFixed(2) + '\n' +
    'Hard cap: ' + (MAX_WALLET_PCT * 100).toFixed(1) + '% of wallet per buy\n' +
    'No independent TP/SL — exit follows Decu.'
  );
  console.log('DECU_MIRROR_READY', JSON.stringify({ live: LIVE, target: TARGET, subscriptionId }));
}

server.listen(C.PORT, '0.0.0.0', () => {
  console.log('HTTP_LISTEN', C.PORT);
  boot().catch(async e => {
    ready = false;
    console.error('DECU_MIRROR_FATAL', e.stack || e.message);
    await notify('🛑 DECU MIRROR FATAL\n' + String(e.message).slice(0, 300));
  });
});

async function shutdown(signal) {
  console.log('SHUTDOWN', signal);
  if (subscriptionId != null) {
    try { await connection.removeOnLogsListener(subscriptionId); } catch {}
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
