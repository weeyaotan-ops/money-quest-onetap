import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { C, USDC_MINT } from './config.js';
import { rugcheckSafety } from './rugcheck.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const connection = new Connection(C.SOLANA_RPC_URL, { commitment: 'confirmed' });

let _signer = null;
export function signer() {
  if (_signer) return _signer;
  if (!C.BS58_PRIVATE_KEY) throw new Error('MISSING_BS58_PRIVATE_KEY');
  const bytes = bs58.decode(C.BS58_PRIVATE_KEY.trim());
  _signer = Keypair.fromSecretKey(bytes);
  return _signer;
}

export function walletAddress() {
  try { return signer().publicKey.toBase58(); } catch { return ''; }
}

export async function solBalance() {
  const lamports = await connection.getBalance(signer().publicKey, 'confirmed');
  return lamports / 1e9;
}

export async function tokenBalanceRaw(mint) {
  const r = await connection.getParsedTokenAccountsByOwner(
    signer().publicKey,
    { mint: new PublicKey(mint) },
    'confirmed'
  );
  let total = 0n;
  for (const a of r.value) {
    const raw = a.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (raw != null) total += BigInt(raw);
  }
  return total;
}

export async function usdcBalance() {
  return Number(await tokenBalanceRaw(USDC_MINT)) / 1e6;
}

export async function tokenSafety(mint) {
  const pubkey = new PublicKey(mint);
  const ai = await connection.getParsedAccountInfo(pubkey, 'confirmed');
  if (!ai.value) return { ok: false, reason: 'MINT_ACCOUNT_NOT_FOUND' };
  const ownerProgram = ai.value.owner.toBase58();
  if (!C.ALLOW_TOKEN_2022 && ownerProgram !== TOKEN_PROGRAM) {
    return { ok: false, reason: 'NON_STANDARD_TOKEN_PROGRAM', ownerProgram };
  }
  const parsed = ai.value.data?.parsed;
  if (!parsed || parsed.type !== 'mint') return { ok: false, reason: 'NOT_PARSED_MINT' };
  const info = parsed.info || {};
  if (C.REQUIRE_REVOKED_MINT_AUTHORITY && info.mintAuthority) {
    return { ok: false, reason: 'MINT_AUTHORITY_ACTIVE', mintAuthority: info.mintAuthority };
  }
  if (C.REQUIRE_REVOKED_FREEZE_AUTHORITY && info.freezeAuthority) {
    return { ok: false, reason: 'FREEZE_AUTHORITY_ACTIVE', freezeAuthority: info.freezeAuthority };
  }
  const decimals = Number(info.decimals ?? -1);
  const supplyRaw = BigInt(info.supply || '0');
  if (decimals < 0 || decimals > 12 || supplyRaw <= 0n) {
    return { ok: false, reason: 'BAD_MINT_SUPPLY_OR_DECIMALS' };
  }

  let top1Pct = 0;
  let top5Pct = 0;
  try {
    const largest = await connection.getTokenLargestAccounts(pubkey, 'confirmed');
    const shares = largest.value.slice(0, 5).map(
      x => Number((BigInt(x.amount) * 1_000_000n) / supplyRaw) / 10_000
    );
    top1Pct = shares[0] || 0;
    top5Pct = shares.reduce((a, b) => a + b, 0);
    if (top1Pct > C.MAX_TOP1_HOLDER_PCT) {
      return { ok: false, reason: 'EXTREME_TOP1_CONCENTRATION', top1Pct, top5Pct };
    }
    if (top5Pct > C.MAX_TOP5_HOLDER_PCT) {
      return { ok: false, reason: 'EXTREME_TOP5_CONCENTRATION', top1Pct, top5Pct };
    }
  } catch (e) {
    return { ok: false, reason: 'HOLDER_CHECK_FAILED', error: e.message };
  }

  const rugcheck = await rugcheckSafety(mint);
  if (!rugcheck.ok) {
    return { ok: false, reason: rugcheck.reason || 'RUGCHECK_BLOCK', rugcheck };
  }

  return {
    ok: true,
    decimals,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    top1Pct,
    top5Pct,
    ownerProgram,
    rugcheck,
  };
}
