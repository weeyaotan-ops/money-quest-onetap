import { C } from './config.js';

const DS = 'https://api.dexscreener.com';
const asArray = x => Array.isArray(x) ? x : (x ? [x] : []);

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`DEX_${r.status}_${url}`);
  return r.json();
}

export async function discover() {
  const [profilesRaw, boostsRaw] = await Promise.all([
    getJson(`${DS}/token-profiles/latest/v1`),
    getJson(`${DS}/token-boosts/latest/v1`),
  ]);
  const addresses = [...new Set([
    ...asArray(profilesRaw), ...asArray(boostsRaw),
  ].filter(x => x?.chainId === 'solana' && x?.tokenAddress).map(x => x.tokenAddress))].slice(0, 60);

  const allPairs = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    if (!batch.length) continue;
    const pairs = await getJson(`${DS}/tokens/v1/solana/${batch.join(',')}`);
    allPairs.push(...asArray(pairs));
  }

  const best = new Map();
  for (const p of allPairs) {
    const mint = p?.baseToken?.address;
    if (!mint || !addresses.includes(mint)) continue;
    const liq = Number(p?.liquidity?.usd || 0);
    const prev = best.get(mint);
    if (!prev || liq > Number(prev?.liquidity?.usd || 0)) best.set(mint, p);
  }

  const out = [];
  for (const [mint, p] of best) {
    const ageMin = p.pairCreatedAt ? (Date.now() - Number(p.pairCreatedAt)) / 60_000 : Infinity;
    const liq = Number(p?.liquidity?.usd || 0);
    const fdv = Number(p?.fdv || p?.marketCap || 0);
    const m5vol = Number(p?.volume?.m5 || 0);
    const buys = Number(p?.txns?.m5?.buys || 0);
    const sells = Number(p?.txns?.m5?.sells || 0);
    const ratio = buys / Math.max(1, sells);
    const pc = Number(p?.priceChange?.m5 || 0);
    const liqFdv = fdv > 0 ? liq / fdv : 0;

    if (!(ageMin >= C.MIN_PAIR_AGE_MIN && ageMin <= C.MAX_PAIR_AGE_MIN)) continue;
    if (liq < C.MIN_LIQUIDITY_USD) continue;
    if (m5vol < C.MIN_M5_VOLUME_USD) continue;
    if (buys < C.MIN_M5_BUYS) continue;
    if (ratio < C.MIN_BUY_SELL_RATIO) continue;
    if (pc < C.MIN_M5_PRICE_CHANGE_PCT || pc > C.MAX_M5_PRICE_CHANGE_PCT) continue;
    if (fdv < C.MIN_FDV_USD || fdv > C.MAX_FDV_USD) continue;
    if (liqFdv < C.MIN_LIQUIDITY_FDV_RATIO) continue;

    const score =
      Math.min(30, Math.log10(Math.max(1, liq / C.MIN_LIQUIDITY_USD)) * 20 + 10) +
      Math.min(25, Math.log10(Math.max(1, m5vol / C.MIN_M5_VOLUME_USD)) * 15 + 10) +
      Math.min(20, ratio * 7) +
      Math.min(15, Math.max(0, pc) / 4) +
      Math.min(10, liqFdv * 100);

    out.push({
      mint,
      symbol: p?.baseToken?.symbol || mint.slice(0, 6),
      name: p?.baseToken?.name || '',
      pairAddress: p?.pairAddress || '',
      dexId: p?.dexId || '',
      url: p?.url || '',
      ageMin,
      liquidityUsd: liq,
      fdvUsd: fdv,
      m5VolumeUsd: m5vol,
      buys,
      sells,
      buySellRatio: ratio,
      m5PriceChangePct: pc,
      liqFdv,
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, C.MAX_CANDIDATES_PER_SCAN);
}
