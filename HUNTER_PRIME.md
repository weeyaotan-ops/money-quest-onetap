# Hunter Prime V1 — Shadow Brain

Hunter Prime is the new decision layer for Money Hunter.

## Goal

Replace pattern-first signalling with:

```
market state
→ regime
→ independent edge engines
→ calibrated probability
→ uncertainty/disagreement
→ post-cost EV
→ LONG / SHORT / SKIP
```

## V1 expert families

- Trend
- Volatility
- Mean Reversion
- Order Flow
- Leverage / Funding / Liquidations
- Relative Value / Basis
- Cross Market
- Event

Each expert emits three probabilities:

- `pLong`
- `pShort`
- `pNeutral`

plus:

- `reliability`
- `uncertainty`

The core uses a weighted logarithmic opinion pool. Expert weight is reduced when reliability is weak, uncertainty is high, or the current regime is a poor fit.

## Decision gate

A trade is rejected when any of these fail:

1. post-cost EV floor
2. directional probability floor
3. uncertainty ceiling
4. EV separation versus the opposite direction
5. minimum expert diversity

`SKIP` is a first-class action.

## Safety / integration

V1 is deliberately **shadow-only**.

It does not change `exact_mirror_gateway_v2.js` and does not emit `combinedSelected=true` tickets. Exact Mirror V2 therefore remains untouched.

The next integration step, only after the brain inputs are wired, is:

```
live market data
→ feature builders
→ 8 expert engines
→ hunter_prime_core.evaluateDecision()
→ shadow ledger
```

A later explicit promotion can add a separate Hunter Prime lineage flag to the execution gateway. Do not spoof the existing Combined Edge lineage.

## What V1 proves

V1 does not claim a profitable edge by itself. It establishes the mathematical decision architecture needed to measure whether each edge exists after fees, slippage and uncertainty.
