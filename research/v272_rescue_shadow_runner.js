'use strict';

// RESEARCH ONLY. This runner never imports or calls Binance order/execution code.
// Usage:
//   node research/v272_rescue_shadow_runner.js candidates.json [output.jsonl]
//
// candidates.json may be an array or { candidates: [...] }.
// Each candidate should contain at least:
// side, entry, sl, tp, spreadBps, quoteAgeMs, timeframe, score,
// shadowStructureRegime, volatilityBand.

const fs = require('node:fs');
const path = require('node:path');
const brain = require('./v272_rescue_brain_v1');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ANCHOR = path.join(ROOT, 'research_snapshots', 'hunter_forward_n250_2026-09-16T071850Z.json');
const DEFAULT_LATEST = path.join(ROOT, 'research_snapshots', 'hunter_forward_n504_n500_crossing_2026-09-16T100650Z.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function candidatesOf(x) {
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.candidates)) return x.candidates;
  if (Array.isArray(x?.tickets)) return x.tickets;
  return [];
}

function normalizeCandidate(c = {}) {
  return {
    ...c,
    side: String(c.side || c.direction || '').toUpperCase(),
    timeframe: String(c.timeframe || 'UNKNOWN'),
    score: Number(c.score ?? c.edgeScore ?? c.confidence),
    spreadBps: Number(c.spreadBps),
    quoteAgeMs: Number(c.quoteAgeMs ?? 0),
    shadowStructureRegime: String(c.shadowStructureRegime || c.shadowStructure || c.regime || 'UNKNOWN').toUpperCase(),
    volatilityBand: String(c.volatilityBand || c.volatility || 'UNKNOWN').toUpperCase(),
    entry: Number(c.entry),
    sl: Number(c.sl ?? c.stop),
    tp: Number(c.tp ?? c.takeProfit),
  };
}

function run(candidates, anchor, latest) {
  const rows = candidates.map((raw, index) => {
    const candidate = normalizeCandidate(raw);
    const assessment = brain.assess(candidate, anchor, latest);
    return {
      index,
      id: raw.id ?? raw.candidateId ?? null,
      symbol: raw.symbol ?? raw.binanceSymbol ?? raw.instId ?? null,
      side: candidate.side,
      timeframe: candidate.timeframe,
      score: candidate.score,
      spreadBps: candidate.spreadBps,
      structure: candidate.shadowStructureRegime,
      action: assessment.action,
      netTruthScoreR: assessment.netTruthScoreR,
      reasons: assessment.abstainReasons,
      geometry: assessment.execution?.geometry || null,
      support: assessment.truth?.support ?? null,
      expectedR: assessment.truth?.expectedR ?? null,
      truthScoreR: assessment.truth?.truthScoreR ?? null,
    };
  });

  const eligible = rows.filter(x => x.action === 'ELIGIBLE');
  return {
    kind: 'V272_RESCUE_BRAIN_V1_SHADOW_REPORT',
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    total: rows.length,
    eligible: eligible.length,
    abstained: rows.length - eligible.length,
    coverage: rows.length ? eligible.length / rows.length : 0,
    selections: rows,
  };
}

if (require.main === module) {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3] || null;
  if (!inputFile) {
    console.error('Usage: node research/v272_rescue_shadow_runner.js candidates.json [output.json]');
    process.exit(2);
  }
  const payload = readJson(path.resolve(inputFile));
  const anchor = readJson(process.env.V272_RESCUE_ANCHOR || DEFAULT_ANCHOR);
  const latest = readJson(process.env.V272_RESCUE_LATEST || DEFAULT_LATEST);
  const report = run(candidatesOf(payload), anchor, latest);
  const text = JSON.stringify(report, null, 2);
  if (outputFile) fs.writeFileSync(path.resolve(outputFile), text + '\n');
  else process.stdout.write(text + '\n');
}

module.exports = { normalizeCandidate, run };
