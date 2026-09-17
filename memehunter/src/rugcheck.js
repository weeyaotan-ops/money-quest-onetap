import { C } from './config.js';

const BASE = 'https://api.rugcheck.xyz/v1';
const badRiskLevels = new Set(['danger', 'critical', 'high']);

export async function rugcheckSafety(mint) {
  if (!C.RUGCHECK_REQUIRED) return { ok: true, skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), C.RUGCHECK_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/tokens/${encodeURIComponent(mint)}/report/summary`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, reason: `RUGCHECK_HTTP_${r.status}` };
    const j = await r.json();
    if (!j || typeof j !== 'object' || String(j.mint || '') !== mint || !Array.isArray(j.risks)) {
      return { ok: false, reason: 'RUGCHECK_SCHEMA_INVALID' };
    }
    if (j.rugged === true) return { ok: false, reason: 'RUGCHECK_RUGGED', report: j };

    const riskLevel = String(j.riskLevel || '').trim().toLowerCase();
    if (!riskLevel) return { ok: false, reason: 'RUGCHECK_NO_RISK_LEVEL', report: j };
    if (!C.RUGCHECK_ALLOWED_LEVELS.includes(riskLevel)) {
      return { ok: false, reason: `RUGCHECK_LEVEL_${riskLevel.toUpperCase()}`, report: j };
    }

    const severe = j.risks.find(x => badRiskLevels.has(String(x?.level || '').trim().toLowerCase()));
    if (severe) {
      return {
        ok: false,
        reason: `RUGCHECK_SEVERE_${String(severe.name || severe.level || 'RISK').replace(/\s+/g, '_').toUpperCase()}`,
        report: j,
      };
    }
    if (j.mintAuthority) return { ok: false, reason: 'RUGCHECK_MINT_AUTHORITY_ACTIVE', report: j };
    if (j.freezeAuthority) return { ok: false, reason: 'RUGCHECK_FREEZE_AUTHORITY_ACTIVE', report: j };

    return {
      ok: true,
      riskLevel: j.riskLevel,
      score: Number.isFinite(Number(j.score)) ? Number(j.score) : null,
      lpLocked: typeof j.lpLocked === 'boolean' ? j.lpLocked : null,
      lpLockedPct: Number.isFinite(Number(j.lpLockedPct)) ? Number(j.lpLockedPct) : null,
      topHoldersPct: Number.isFinite(Number(j.topHoldersPct)) ? Number(j.topHoldersPct) : null,
      risks: j.risks,
    };
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'RUGCHECK_TIMEOUT' : 'RUGCHECK_FETCH_FAILED', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
