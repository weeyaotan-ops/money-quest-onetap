# Dynamic Expected-R V2 — preregistration

Status: **SHADOW / RESEARCH ONLY**

Frozen design evidence: N250 → first N500 watershed crossing (N504).

New untouched evaluation holdout: **first emitted checkpoint/candidates at closed >= N550 through closed >= N800**. N505–N549 is a burn-in gap and is not part of the scored holdout. Once the holdout begins, the rules below are frozen until the N800 review.

## Why V2 exists

N250→N504 showed large phase changes. Static score/spread/side/timeframe relationships changed sign and magnitude. V2 therefore estimates both long-term and recent Expected-R and explicitly detects regime drift rather than assuming one permanent rule.

## Information allowed

At a candidate timestamp, V2 may use only outcomes already closed before that timestamp. No future bars, future outcomes, post-hoc relabeling, or holdout retuning.

Candidate context allowed:
- shadowStructure: RANGE / MIXED / BREAKOUT / TREND
- side
- timeframe
- spread bucket
- score bucket
- volatility band

Live Hunter entry, SL, TP, risk, leverage, max-open, and execution logic remain unchanged.

## Estimator

Two windows:
- recent window: last 75 closed observational lifecycles
- long window: last 250 closed observational lifecycles

For each dimension bucket, estimate mean realized R and shrink it toward that window's global mean:

`shrunkMean = (n * bucketMean + 30 * globalMean) / (n + 30)`

Base dimension weights:
- structure 0.35
- spread 0.20
- side 0.15
- timeframe 0.15
- score 0.10
- volatility 0.05

Support reliability for each dimension:

`reliability = baseWeight * min(1, bucketN / 60)`

Window state estimate:

`stateExpectedR = weightedAverage(shrunkMean_j, reliability_j)`

If fewer than 3 dimensions have bucketN >= 15, fall back to that window's global shrunk mean and mark low support.

## Change detector

When recentN >= 40 and longN >= 100:

`drift = abs(recentGlobalMean - longGlobalMean)`

Estimate the standard error of the difference from the realized-R samples in the two windows.

Set `changeDetected = true` only when:

`drift > max(0.10R, 1.5 * SE_difference)`

Blend recent and long estimates:
- if changeDetected: 70% recent / 30% long
- otherwise: 35% recent / 65% long

Final shadow score:

`dynamicExpectedR = wRecent * recentStateExpectedR + wLong * longStateExpectedR`

## Abstention label

This is shadow-only and does not block live candidates.

Mark a candidate `SHADOW_ABSTAIN` when any is true:
- dynamicExpectedR <= +0.03R
- fewer than 3 dimensions have bucketN >= 15 in both usable windows
- candidate data is stale/incomplete

Otherwise mark `SHADOW_ELIGIBLE`.

## Evaluation at N800

Primary measurements on the untouched N550→N800 holdout:
1. realized expectancy of SHADOW_ELIGIBLE candidates
2. realized expectancy by predicted Expected-R calibration bin
3. calibration error: predicted mean R vs realized mean R
4. top-ranked shadow candidate expectancy versus existing heuristic rank order, using the same observable candidate set
5. maximum R drawdown of the shadow-selected sequence
6. concentration by side/timeframe/structure
7. performance during changeDetected vs stable states

## Promotion gate

No live promotion unless the untouched holdout simultaneously has:
- >= 100 eligible resolved samples
- realized expectancy > +0.10R/trade
- profit factor > 1.20
- 90% lower confidence bound of expectancy > 0
- max drawdown < 10R at 1R unit risk accounting
- no single side/timeframe/structure bucket contributes > 60% of resolved eligible samples
- no evidence that results depend on one short phase only

Failing any gate means **do not promote**; analyze and form a new preregistered hypothesis for a later untouched holdout.

## Explicit non-rules from N250→N504

Do not hard-code SELL-only, 1–2bps-only, 0.90–0.95-only, 1m-only, or RANGE-only as live filters. Their observed effects are treated as context inputs, not permanent truths.

`STRUCTURE_EDGE_CONSISTENT` in its current shadow definition is not a promotion candidate because its frozen holdout performance was strongly negative.

## Principle

The purpose is not to make the historical curve look better. The purpose is to make a falsifiable prediction about future ranking quality and allow the N550→N800 data to disprove it.
