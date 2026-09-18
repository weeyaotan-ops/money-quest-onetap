# Hunter signal quality and win-rate evaluation

This change repairs the existing Hunter input path; it does not replace the engine.

## Live changes

- Use only fully closed candles with valid OHLC, consecutive timestamps, and a recent final close. Request 61 rows to retain up to 60 closed bars.
- Include the prior close in all 14 ATR true ranges and compare the final close against the preceding 20 bars.
- Freeze signal age at candle close. The configured signal-age limit still applies; a slow scan, adapter restart, or repeated poll cannot renew a signal.
- Preserve event time through the adapter, include timeframe/event time in ticket identity, reject invalid/future/missing times, and recheck freshness after asynchronous delivery checks.
- Neutralize the existing evidence adjustment if its report stops refreshing for three refresh intervals (at least 180 seconds).
- Sort closed-trade history chronologically before recent-window calculations, including after state restoration.

The Binance order handler, confirmation/skip UI, position sizing, risk settings, exchange routing, SL/TP placement and exit policies are unchanged. Existing live ranking remains; the new model below is not allowed to affect it.

## Frozen prospective model: WIN_QUALITY_V1

The objective is a better probability of a net winning trade while preserving positive net expectancy. No achieved improvement is claimed by this patch.

- Use at most 100 real closed trades whose close precedes prediction time. Never use simulated gross-R outcomes as real execution labels.
- Pick one sufficiently populated cohort in a fixed hierarchy: edge/timeframe, edge, timeframe, side, global. Minimum subgroup size is 12; no parameter search or outcome-driven cohort switching.
- Estimate win probability with a 20-observation prior toward the Laplace-smoothed global win rate. Shrink net actual-R expectancy toward the global mean using the same prior.
- Record a descriptive 95% Wilson interval. It assumes independent Bernoulli observations and does not establish statistical significance for dependent or selected trading outcomes.
- Mark support only with at least 30 cohort observations, positive shrunk actual-R expectancy, and a lower interval bound above the two-outcome break-even proxy implied by the ticket's estimated net RR. Actual fills, variable losses and dependence can invalidate that proxy.
- Freeze and persist the estimate in the candidate decision before execution; join it to realized actual-R after closure. Legacy trades without a frozen prediction are excluded from prospective evaluation.
- Report Brier score, calibration bins, baseline/supported/unproven win rates and actual-R returns. The probability is explicitly uncalibrated until forward validation.
- At 100 matched forward outcomes and at least 30 supported outcomes, mark the report ready for review. This is a review threshold, not proof or automatic promotion. Require a later independent window, net-return and drawdown checks, and concentration review before any live selector change.

The report is `/hunter-live-gate/report` under `winQuality`. Runtime snapshots include the same aggregate field. Candidate-level predictions live in the existing persistent gate decisions. No future monitoring task or automatic trading-policy change is created.

## Verification and rollback

The offline tests inject unfinished-candle spikes, stale/corrupt bars, timestamp resets, expiry during delivery, future outcome leakage, sparse cohorts, and high-win-rate/negative-expectancy sequences. Gateway tests mock all exchange I/O and verify CONFIRM LIVE, SKIP, authorization and duplicate callbacks.

Rollback: revert this change's commit and redeploy both the publisher and the Hunter host. No environment settings or persisted-state schema migration is required; existing gate state can be read by either revision.
