# Hunter edge recovery

Status: isolated review branch; not deployed. No demonstrated profitable replacement strategy.

## Verified code defects and prepared fixes

- Protection recovery previously cancelled accepted protective orders before trying an emergency close. It now retains them until a fresh account read verifies no symbol position remains. A failed or inconclusive read reports closure as unverified. This does not repair an existing live position or prove that old failures caused particular losses.
- Closure R now uses the same frozen preview actualRisk denominator as excursion sampling and ledger reconciliation. Target riskUsd is not interchangeable with sized actualRisk. Historical records are not rewritten, and accepted partial fills still require a separately defined filled-risk convention.
- Unknown or mixed commission currencies now produce unknown net P&L and R instead of an invented net result. Funding remains excluded. Fill ownership is still explicitly UNVERIFIED_TIME_WINDOW pending complete order/fill reconciliation; the previous offline attribution candidate is not yet wired into live settlement.

## Exit comparison implemented

`edge_replay_v1.js` compares ORIGINAL exits with a single preregistered NET_BE_AFTER_1R hypothesis. It uses chronological bid/ask and mark-price samples, explicit entry commissions, exit fee rates, adverse slippage, stop-amendment latency and gap fills. It also evaluates doubled fee/slippage assumptions. A break-even trigger may realize a loss, and cutting a reversal may also cut a later winning trade.

Both policies and both cost scenarios use the same fully resolved cohort; exclusions and their fraction are reported. Reject missing costs, incomplete paths, duplicate trade IDs, nonchronological quotes, excessive quote gaps, funding crossings without a funding path, decisions outside the frozen holdout and paths crossing its end. Unresolved cases remain visible. The output is descriptive and never promotes a strategy automatically. Quote sampling still misses intragap events and depth. Results are conditional on baseline entries and cannot establish the return of a full alternative portfolio.

Input: a private JSON object with `protocol` (numeric millisecond timestamps frozenAt, holdoutStart, holdoutEnd, plus maxQuoteGapMs and stopAmendLatencyMs) and `trades`.

Each trade requires id, symbol, side, decisionAt, entryAt, entryPrice, qty, riskAmount, entryCommission, exitFeeRate (fraction), exitSlippageBps, sl, tp, fundingCost, noFundingEventDuringPath, flatBeforeEntry, completeQuoteHistory and a strictly chronological quotes array containing at/bid/ask/mark. Provenance flags require evidence; they must not be filled with true merely to make the validator pass. Historical extrema cannot be converted to quote paths. Keep private inputs out of the public repository.

Command: `node research/edge_replay_v1.js <private-dataset.json>`.

## Remaining work by layer

| Layer | Finding | Evidence needed before a performance claim |
|---|---|---|
| Signal selection | Volatility can dominate the score for both directions; numerical score is not a calibrated win probability. | Frozen pre-entry features and matched, verified net outcomes for all compared candidates. Test existing structural challenger without assuming superiority. |
| Learning | The current scanner learns from sampled gross shadow outcomes. | Separate verified net and simulated labels; simulate entry fill feasibility and realistic costs before using shadow evidence. |
| Execution | Conditional-order errors and recovery uncertainty exist. | Exact order/trigger/fill timestamps, prices and fees; verify recovery fixes in controlled integration before deployment. |
| Exits | Existing shadow BE assumes zero-R fills and baseline SL assumes exactly -1R. | New chronological bid/ask/mark data with conservative latency/slippage assumptions. |
| Portfolio risk | Individual signal results do not measure correlated simultaneous exposure. | Time-aligned positions and account equity, with portfolio drawdown and concentration analysis. Closed-trade R drawdown is not account drawdown. |

## Decision standard

Optimize net expectancy subject to drawdown and execution reliability; do not optimize win rate alone. Freeze one challenger before collecting its holdout, include every attempted comparison in the research record, inspect concentration and cost sensitivity, and require fresh independent forward evidence. Unit tests establish code behavior only. None of these changes establish guaranteed profit, the best possible edge, or safety of unattended trading.
