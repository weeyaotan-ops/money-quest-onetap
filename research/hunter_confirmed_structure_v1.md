# Confirmed structure selection

Selection identifier: `CONFIRMED_STRUCTURE_V1`.

This revision changes live signal eligibility. It does not establish an achieved
win rate or positive net expectancy. No performance percentage is promised.

## Problems corrected

The previous scorer ranked every edge against the same source direction. A range
reversal could therefore be relabeled as a breakout or volatility expansion,
including a continuation trade against momentum. The source detector also called
a first breakout a retest, a range midpoint a sweep, and any efficient trend a
pullback. Those names were not supported by the candle sequence.

The scanner's learning input used simulated gross returns sampled at scan times.
Those observations omit execution costs and fills and can miss intrabar stops.
They are no longer used to adjust live scores. The simulated ledger remains an
explicitly observational diagnostic.

## Eligibility

Only validated closed bars are used. The existing efficiency thresholds are
retained; EMA 8/20 confirms trend direction and EMA 20 defines the reclaim. These
rules were fixed from the pattern definitions, not tuned to historical returns.

- Range, efficiency at most 0.16: breach one preceding 20-bar boundary, close
  back inside the range, and close in the reclaim direction. Two-sided sweeps
  are ambiguous and rejected. Range setups cannot become continuation setups.
- Breakout retest: the previous close must break the 20-bar range preceding it;
  the latest bar must touch that boundary and close back on the breakout side,
  with body and momentum in that direction.
- Trend pullback reclaim, efficiency at least 0.38: the previous close is on the
  pullback side of its EMA 20; the latest close reclaims EMA 20, with matching
  body, momentum and EMA 8/20 direction.
- Momentum continuation, efficiency at least 0.28: the latest close exceeds the
  preceding candle's high/low, with body, momentum and EMA 8/20 alignment.
- Volatility expansion, volatility at least 18 bps: latest true range exceeds
  the preceding 14-bar ATR and closes beyond the preceding 20-bar high/low, with
  matching body and momentum. High volatility alone cannot qualify.

The scorer can only rank a confirmed pattern and cannot relabel its direction.
The existing stop must be beyond the confirming candle's low for BUY or high for
SELL; otherwise the setup is rejected. Stops are not widened to make it pass.
Existing RR, fee estimates, sizing, leverage, confirmation and order protection
remain in place. Fewer tickets are expected.

## Evaluation and continuity

`selectionVersion` travels through the candidate, decision, execution and real
trade ledger. Old or unknown rules are `LEGACY`; history is retained. The report
includes `selectionVersions` and `evidenceBySelectionVersion`.

Live evidence ranking and observational probability estimates use real net
outcomes from the matching selection version only. Before that version has enough
closed outcomes, the evidence adjustment is neutral. Old mislabeled edge samples
cannot reward or penalize the corrected definitions.

The shadow probability model remains observational. Review net expectancy,
profit factor, drawdown, asset concentration and win-rate calibration on new
closed trades. Unit tests verify signal mechanics, not future profitability.
Do not present old simulated results or legacy live results as performance of
these revised rules.

## Verification and rollback

Tests cover BUY/SELL symmetry, failed retests, absent sweeps, false volatility
signals, direction contradictions, structural stop placement, closed-candle
isolation, disabled simulated learning and separation of selection versions.
Existing freshness, callback, signing and execution-policy tests remain required.

Rollback by reverting this revision and redeploying the scanner and publisher.
No environment changes or destructive state migration are required.
