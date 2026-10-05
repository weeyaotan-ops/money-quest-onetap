# Accounting recovery before exit optimization

Status: offline candidate only. No live imports, orders, strategy changes or deployment.

Code inspection found two concrete inconsistencies:

1. `binance_onetap_gateway.js` settledStats aggregates every same-symbol fill from startedAt minus 10 seconds through now, without identifying the entry order or the position cycle. This can include previous or subsequent trades. `real_money_ledger_preload.js` similarly starts five seconds before an entry. A timestamp margin is not ownership evidence.
2. Gateway closure logs divide net P&L by riskUsd (target equity risk), whereas reconciliation and excursion sampling use actualRisk (sized estimated risk). These denominators can differ. Consequently, reported R and comparisons against excursion R can disagree even for identical P&L.

These findings do not establish that any particular reported loss was erroneous. Previously reported live statistics remain provisional until reconciled. Historical closed records are not automatically repaired by this offline candidate.

`settlement_attribution_v1.js` matches entry order fills and follows their position side through a quantity-balanced closure. It excludes neighboring cycles, deduplicates fill IDs, uses the frozen actualRisk denominator and refuses uncertain histories, overlapping entries, reversals or commission currencies requiring conversion. The caller must supply genuine evidence of a flat position before entry and complete paginated fill history; flags must never be assumed from an array length. Trade-level P&L excludes funding and other account adjustments, which require a separate reconciliation.

Required next steps:

- Obtain read-only complete exchange fills, matching entry order IDs and a verified pre-entry flat position for the anomalous trades. Preserve original records and produce an auditable corrected view separately.
- Compare entry/exit quantities, stop trigger, fill price and fees to determine whether losses above 2R are genuine execution losses or attribution errors.
- Persist executed-order metadata and one explicit frozen risk basis before integrating any accounting repair. Existing actualRisk is based on preview sizing; accepted partial fills require an explicit, consistent risk convention too.
- Only after accounting verification, preregister one offline exit challenger: move the simulated stop to estimated cost-adjusted break-even after +1R. Compare with unchanged exits using chronological quote paths and conservative spread/slippage/latency assumptions. This candidate is a hypothesis, not a recommendation or live rule.
- Existing MFE/MAE extrema are insufficient to backtest break-even: they omit the order of price movements and executable prices. Do not relabel every loss that once reached +1R as a saved trade.
- Freeze the challenger, evaluate on a fresh chronological holdout and report net expectancy, drawdown, profit factor and dependence on symbols/regimes. No automatic promotion, and no profitability claim from unit tests.

Offline verification: `node test/settlement_attribution_v1.test.js`.
