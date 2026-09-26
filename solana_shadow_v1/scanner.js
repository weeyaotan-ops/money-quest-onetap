'use strict';

/*
  SOLANA MEME SHADOW V1
  Research-only candidate scanner. It does not create, sign or submit transactions.
  Market discovery/enrichment: public DEX Screener endpoints.
  On-chain safety: public Solana JSON-RPC.
*/

const CONFIG = Object.freeze({
  minAgeMin: 10,
  maxAgeMin: 72 * 60,
  minLiquidityUsd: 50000,
  minMcapUsd: 100000,
  maxMcapUsd: 20000000,
  minLiqMcap: 0.03,
  minVol5m: 15000,
  minVol1h: 50000,
  minBuys5m: 30,
  minBuySellRatio5m: 1.25,
  minVolAccel: 1.5,
  minPc5m: -15,
  maxPc5m: 60,
  minPc1h: -30,
  maxPc1h: 150,
  maxTopHolderPct: 30,
  minScore: 0.72,
});

const DEX = 'https://api.dexscreener.com';
const SOL_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const clamp = (x, lo=0, hi=1) => Math.max(lo, Math.min(hi, x));
const num = (x, d=0) => Number.isFinite(Number(x)) ? Number(x) : d;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'solana-shadow-v1' } });
  if (!r.ok) throw new Error('HTTP_'+r.status+' '+url);
  return r.json();
}

async function rpc(method, params) {
  const r = await fetch(SOL_RPC, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  });
  if (!r.ok) throw new Error('RPC_HTTP_'+r.status);
  const j = await r.json();
  if (j.error) throw new Error('RPC_'+j.error.code+'_'+j.error.message);
  return j.result;
}

function u32le(buf, off){ return buf.readUInt32LE(off); }

async function mintAudit(mint) {
  try {
    const info = await rpc('getAccountInfo', [mint, {encoding:'base64'}]);
    const b64 = info?.value?.data?.[0];
    if (!b64) return {status:'UNKNOWN', reason:'NO_MINT_ACCOUNT'};
    const b = Buffer.from(b64, 'base64');
    if (b.length < 82) return {status:'UNKNOWN', reason:'BAD_MINT_LAYOUT'};
    const mintAuthOpt = u32le(b, 0);
    const supply = Number(b.readBigUInt64LE(36));
    const decimals = b[44];
    const freezeAuthOpt = u32le(b, 46);
    let topHolderPct = null;
    try {
      const largest = await rpc('getTokenLargestAccounts', [mint]);
      const totalUi = supply / Math.pow(10, decimals);
      if (totalUi > 0 && Array.isArray(largest?.value)) {
        const topUi = largest.value.slice(0, 10).reduce((s,x)=>s+num(x.uiAmount),0);
        topHolderPct = topUi / totalUi * 100;
      }
    } catch {}
    return {
      status:'OK',
      mintAuthorityDisabled: mintAuthOpt === 0,
      freezeAuthorityDisabled: freezeAuthOpt === 0,
      topHolderPct
    };
  } catch (e) {
    return {status:'UNKNOWN', reason:String(e.message||e)};
  }
}

async function discoverMints() {
  const endpoints = [
    '/token-profiles/latest/v1',
    '/token-boosts/latest/v1',
    '/token-boosts/top/v1',
    '/community-takeovers/latest/v1'
  ];
  const all = [];
  for (const ep of endpoints) {
    try {
      const x = await getJson(DEX+ep);
      const rows = Array.isArray(x) ? x : (x ? [x] : []);
      for (const r of rows) if (r?.chainId === 'solana' && r?.tokenAddress) {
        all.push({mint:r.tokenAddress, source:ep, profile:r});
      }
    } catch (e) {
      all.push({error:String(e.message||e), source:ep});
    }
  }
  const by = new Map();
  for (const x of all) {
    if (!x.mint) continue;
    const old = by.get(x.mint) || {mint:x.mint, sources:[], profiles:[]};
    old.sources.push(x.source); old.profiles.push(x.profile); by.set(x.mint, old);
  }
  return [...by.values()];
}

function pickPair(pairs, mint) {
  const sol = (pairs||[]).filter(p => p?.chainId === 'solana' && p?.baseToken?.address === mint);
  sol.sort((a,b)=>num(b?.liquidity?.usd)-num(a?.liquidity?.usd));
  return sol[0] || null;
}

function rawFeatures(pair, discovery, now=Date.now()) {
  const liq = num(pair?.liquidity?.usd);
  const mcap = num(pair?.marketCap || pair?.fdv);
  const ageMin = pair?.pairCreatedAt ? (now - num(pair.pairCreatedAt))/60000 : Infinity;
  const tx5 = pair?.txns?.m5 || {};
  const v5 = num(pair?.volume?.m5);
  const v1h = num(pair?.volume?.h1);
  const buys5 = num(tx5.buys);
  const sells5 = num(tx5.sells);
  const buySell = buys5 / Math.max(1, sells5);
  const accel = v5 / Math.max(1, v1h / 12);
  const pc5 = num(pair?.priceChange?.m5);
  const pc1 = num(pair?.priceChange?.h1);
  const socials = (pair?.info?.socials||[]).length + (pair?.info?.websites||[]).length;
  return {
    mint: discovery.mint,
    symbol: pair?.baseToken?.symbol || '',
    name: pair?.baseToken?.name || '',
    pairAddress: pair?.pairAddress || '',
    dexId: pair?.dexId || '',
    priceUsd: num(pair?.priceUsd, NaN),
    liquidityUsd: liq,
    marketCapUsd: mcap,
    ageMin,
    liquidityToMcap: mcap>0 ? liq/mcap : 0,
    volume5mUsd: v5,
    volume1hUsd: v1h,
    buys5m: buys5,
    sells5m: sells5,
    buySellRatio5m: buySell,
    volumeAcceleration: accel,
    priceChange5mPct: pc5,
    priceChange1hPct: pc1,
    socials,
    sources: discovery.sources,
    boostsActive: num(pair?.boosts?.active),
    url: pair?.url || ''
  };
}

function hardReasons(f, audit) {
  const r=[];
  if (!(f.ageMin>=CONFIG.minAgeMin && f.ageMin<=CONFIG.maxAgeMin)) r.push('PAIR_AGE');
  if (f.liquidityUsd<CONFIG.minLiquidityUsd) r.push('LOW_LIQUIDITY');
  if (!(f.marketCapUsd>=CONFIG.minMcapUsd && f.marketCapUsd<=CONFIG.maxMcapUsd)) r.push('MCAP_RANGE');
  if (f.liquidityToMcap<CONFIG.minLiqMcap) r.push('LOW_LIQUIDITY_TO_MCAP');
  if (f.volume5mUsd<CONFIG.minVol5m) r.push('LOW_5M_VOLUME');
  if (f.volume1hUsd<CONFIG.minVol1h) r.push('LOW_1H_VOLUME');
  if (f.buys5m<CONFIG.minBuys5m) r.push('LOW_BUY_COUNT');
  if (f.buySellRatio5m<CONFIG.minBuySellRatio5m) r.push('WEAK_BUY_PRESSURE');
  if (f.volumeAcceleration<CONFIG.minVolAccel) r.push('NO_VOLUME_ACCELERATION');
  if (!(f.priceChange5mPct>=CONFIG.minPc5m && f.priceChange5mPct<=CONFIG.maxPc5m)) r.push('5M_OVEREXTENDED_OR_DUMPING');
  if (!(f.priceChange1hPct>=CONFIG.minPc1h && f.priceChange1hPct<=CONFIG.maxPc1h)) r.push('1H_OVEREXTENDED_OR_DUMPING');
  if (audit?.status==='OK') {
    if (!audit.mintAuthorityDisabled) r.push('MINT_AUTHORITY_ACTIVE');
    if (!audit.freezeAuthorityDisabled) r.push('FREEZE_AUTHORITY_ACTIVE');
    if (Number.isFinite(audit.topHolderPct) && audit.topHolderPct>CONFIG.maxTopHolderPct) r.push('TOP_HOLDERS_CONCENTRATED');
  } else r.push('ONCHAIN_AUDIT_UNKNOWN');
  return r;
}

function score(f) {
  const liquidity = clamp((Math.log10(Math.max(f.liquidityUsd,1))-4.7)/1.2);
  const liqMcap = clamp((f.liquidityToMcap-.03)/.17);
  const accel = clamp((f.volumeAcceleration-1.5)/4);
  const buy = clamp((f.buySellRatio5m-1.25)/1.75);
  const activity = clamp((f.buys5m-30)/170);
  const age = f.ageMin<60 ? clamp((f.ageMin-10)/50) : clamp(1-(f.ageMin-60)/(72*60-60),0,1);
  const social = clamp(f.socials/3);
  const notExtended = 1-clamp(Math.max(0,f.priceChange5mPct-20)/40);
  return 0.15*liquidity + 0.15*liqMcap + 0.20*accel + 0.20*buy +
    0.10*activity + 0.10*age + 0.05*social + 0.05*notExtended;
}

async function scan() {
  const startedAt = new Date().toISOString();
  const discoveries = await discoverMints();
  const out=[];
  for (let i=0;i<discoveries.length;i+=30) {
    const chunk=discoveries.slice(i,i+30);
    const mints=chunk.map(x=>x.mint);
    let pairs=[];
    try { pairs = await getJson(DEX+'/tokens/v1/solana/'+mints.join(',')); }
    catch (e) { for (const d of chunk) out.push({mint:d.mint, action:'ABSTAIN', reasons:['PAIR_LOOKUP_FAILED'], error:String(e.message||e)}); continue; }
    for (const d of chunk) {
      const pair=pickPair(pairs,d.mint);
      if (!pair) { out.push({mint:d.mint, action:'ABSTAIN', reasons:['NO_SOLANA_PAIR']}); continue; }
      const f=rawFeatures(pair,d);
      const audit=await mintAudit(d.mint);
      const s=score(f);
      const reasons=hardReasons(f,audit);
      if (s<CONFIG.minScore) reasons.push('SCORE_BELOW_THRESHOLD');
      out.push({
        observedAt:new Date().toISOString(),
        ...f,
        audit,
        score:Number(s.toFixed(4)),
        action:reasons.length?'ABSTAIN':'ELIGIBLE',
        reasons:[...new Set(reasons)]
      });
      await sleep(60);
    }
  }
  return {
    kind:'SOLANA_MEME_SHADOW_V1_SCAN',
    startedAt,
    finishedAt:new Date().toISOString(),
    researchOnly:true,
    discovered:discoveries.length,
    eligible:out.filter(x=>x.action==='ELIGIBLE').length,
    rows:out
  };
}

if (require.main===module) {
  scan().then(x=>process.stdout.write(JSON.stringify(x,null,2)+'\n')).catch(e=>{
    console.error(e); process.exit(1);
  });
}

module.exports={CONFIG,discoverMints,mintAudit,rawFeatures,hardReasons,score,scan};
