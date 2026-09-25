# Hunter Reborn — Research V0

This branch starts a clean research lineage. It intentionally does **not** inherit the old Hunter setup selector, score thresholds, cohort allowlist, timeframe allowlist, or live-entry logic.

## Objective

Discover market states whose **future return distribution** remains favorable after a configurable trading-cost assumption and survives a chronological holdout.

The research loop is:

```
closed candles
→ causal event labels using past/current data only
→ forward-return labels
→ discovery-period screening
→ untouched chronological holdout
→ evidence report
```

There is no order placement, no Telegram ticket emission, and no promotion into the existing Exact Mirror / Confirm Live gateway.

## V0 event families

These are research probes, not approved trading setups:

- `COMPRESSION_RELEASE`
- `DISPLACEMENT`
- `VOLUME_SHOCK`
- `SWEEP_RECLAIM`

Each family is evaluated across a small explicit parameter grid. Parameter selection happens only on the discovery segment. Holdout results are attached **after** selection and are not used to rank discovery candidates.

## Leakage controls

- percentile/range features use history strictly before the event candle;
- sweep levels use prior candles only;
- future candles are used only to label subsequent returns;
- discovery and holdout are chronological, not randomized;
- all reported returns deduct `costBps` before statistics are calculated.

## Current first probe

On 25 Sep 2026, an external research run on Binance USD-M `BTCUSDT` 1h candles used:

- 8,774 candles from 25 Sep 2025 to 25 Sep 2026;
- 20 fresh event parameter combinations;
- 70% discovery / 30% holdout;
- 12 bps round-trip cost stress assumption.

Only one family/configuration selected in discovery and remained positive in the holdout:

- `COMPRESSION_RELEASE`, config `CR_q0.9_c0.8`, 2h horizon;
- discovery: n=43, mean +7.11 bps net, PF 1.199, 3/4 positive folds;
- holdout: n=21, mean +13.27 bps net, median +3.53 bps, 52.4% positive, PF 1.760.

This is **not sufficient evidence for live trading**. The holdout sample is small. The purpose of V0 is to reproduce and extend the test across longer history, 15m/5m data, multiple market regimes, and later BTC/ETH/SOL without contaminating the live executor.

## Run

```bash
node test/hunter_reborn_event_lab.test.js
node research/hunter_reborn_binance_scan.js \
  --symbol BTCUSDT \
  --interval 1h \
  --start 2025-09-25 \
  --end 2026-09-25 \
  --cost-bps 12 \
  --out hunter-reborn-btc-1h.json
```

For 15m research, change `--interval 15m`. The downloader paginates public Binance klines in 1,500-candle batches with a short delay between batches.

## Promotion rule

Nothing in this branch is live-eligible. A separate future promotion step must be explicit and evidence-based. It must not reuse or spoof the existing `combinedSelected`, old setup version, or Exact Mirror lineage flags.

## Negative validation update — 25 Sep 2026

The first one-year BTCUSDT 1h probe produced a tentative compression-release candidate. That candidate was **not promoted**.

Follow-up validation deliberately tried to falsify it:

- **BTCUSDT 15m**, 29 Mar 2026 to 25 Sep 2026, 17,281 candles, 20 fresh configs, 12 bps round-trip cost assumption, 70/30 chronological split: **zero configurations qualified from discovery**.
- **BTCUSDT 1h**, 25 Sep 2024 to 25 Sep 2026, 17,535 candles, 20 fresh configs, 12 bps round-trip cost assumption, 70/30 chronological split with six discovery folds: **zero configurations qualified**.
- The earlier `CR_q0.9_c0.8` / 2h candidate therefore **failed longer-history validation and is rejected**.

This is the intended research behavior: a setup is removed when broader data fails to support it. No live promotion is authorized.

## Strongest surviving edge family so far — daily long/cash regime filter

After rejecting the earlier intraday price-only and derivatives candidates, the research moved to five years of daily data.

The current strongest **research candidate** is not a high-frequency entry pattern. It is a long-only regime filter:

```
prior daily close > long SMA
→ hold long from next daily open
otherwise
→ cash
```

Key safeguards:

- causal timing: yesterday's close decides today's open position;
- no short leg;
- no same-bar return leakage;
- spot cross-check to avoid perpetual funding contamination;
- trading costs charged on every weight change;
- no live execution path.

A broad SMA parameter band around 150–250 days remained viable across BTCUSDT, ETHUSDT and SOLUSDT spot from 25 Sep 2021 to 25 Sep 2026. The 200-day version is retained as the neutral research anchor rather than because it maximized any one backtest.

At a conservative 30 bps charged on each sleeve weight change, the three-sleeve portfolio (BTC / ETH / SOL, fixed 1/3 each when active, otherwise cash) produced in this historical sample:

- total return: +244.3%
- CAGR: 32.0%
- max drawdown: -35.7%
- Sharpe: 0.93
- turnover: 33.0 sleeve-weight units

Equal-weight buy-and-hold over the same sample produced:

- total return: +58.0%
- CAGR: 10.8%
- max drawdown: -74.5%
- Sharpe: 0.48

Yearly filtered portfolio returns were approximately:

- 2022: 0.0%
- 2023: +116.0%
- 2024: +42.3%
- 2025: -11.4%
- 2026 YTD through 25 Sep: +25.7%

This remains **research evidence, not proof of a persistent future edge**. It has a materially losing year (2025), and max drawdown remains large. No live promotion is authorized.


## Warm-up correction — supersedes earlier long-horizon figures

A research bias was found after the first daily-regime runs: the evaluation data originally started on the same date as the indicator history. That meant SMA200 had no pre-evaluation warm-up and artificially left part of early 2022 uninvested.

This has been corrected. The data loader now supplies at least one year of history before the evaluation start, while performance still begins on **25 Sep 2021**. The research module also now accepts a separate evaluation window so warm-up history cannot be confused with performance history.

Corrected Binance Spot evaluation, BTCUSDT / ETHUSDT / SOLUSDT, 25 Sep 2021 to 25 Sep 2026:

### Core: three fixed 1/3 sleeves, own prior close > own SMA200, otherwise cash

At **50 bps per sleeve weight change**:

- total return: **+216.5%**
- CAGR: **25.9%**
- max drawdown: **-40.7%**
- Sharpe: **0.79**
- turnover: **37.0 sleeve-weight units**

Cost stress:

- 30 bps: CAGR 27.8%, max DD -40.2%, Sharpe 0.82
- 50 bps: CAGR 25.9%, max DD -40.7%, Sharpe 0.79
- 100 bps: CAGR 21.4%, max DD -42.4%, Sharpe 0.69

Corrected yearly portfolio returns at 50 bps were approximately:

- 2021 partial: +12.5%
- 2022: **-12.7%**
- 2023: +112.4%
- 2024: +39.5%
- 2025: **-13.3%**
- 2026 through 25 Sep: +25.4%

Equal-weight buy-and-hold over the same evaluation window returned about +50.5%, CAGR 8.5%, max DD -85.5%, Sharpe 0.45.

The earlier +244.3% / 32.0% CAGR / -35.7% drawdown figures are therefore **superseded** and must not be cited as the current result.

### Parameter robustness

With the corrected warm-up and 50 bps costs, long/cash filters from roughly 150 to 250 days remained positive over the full evaluation, but results varied materially. SMA200 remains the neutral anchor because it is not an isolated profitable point and gave one of the stronger risk-adjusted outcomes in this band.

### Rejected overlays

- 4h momentum entry overlay: survived some cross-asset checks but weakened materially in later BTC history; not promoted.
- weekly 120-day relative-strength rotation: attractive full-sample results but failed rebalance-phase robustness and suffered large 2022 losses once warm-up was corrected; not promoted.
- dual-momentum requirement (SMA200 + positive 120-day return): did not improve recent-window robustness; rejected.
- SMA ensemble weighting: reduced concentration around one threshold but did not improve the recent evaluation window; not promoted.

### Secondary candidate: BTC market gate

A simple hierarchy was also tested: BTC keeps its own SMA filter; ETH and SOL may be long only when **both** their own prior close and BTC prior close are above the same long SMA.

At SMA200 and 50 bps, this historical sample improved the core result to roughly:

- total return: +247.0%
- CAGR: 28.3%
- max drawdown: -34.7%
- Sharpe: 0.84

However, the improvement was not consistent across all nearby long-SMA periods: it helped around 150–200 days but was weaker around 220–250 days. Therefore it remains a **secondary research candidate**, not a promoted core rule.

No result in this document authorizes live execution.


## Current strongest research candidate — hierarchical BTC market gate

After correcting warm-up bias and rejecting the intraday, rotation, dual-momentum, ensemble and Donchian variants that did not survive stricter checks, the strongest current **BTC/ETH/SOL-specific** candidate is:

```
BTC sleeve:
  long 1/3 only if prior BTC daily close > BTC SMA200

ETH sleeve:
  long 1/3 only if prior ETH daily close > ETH SMA200
  AND prior BTC daily close > BTC SMA200

SOL sleeve:
  long 1/3 only if prior SOL daily close > SOL SMA200
  AND prior BTC daily close > BTC SMA200

otherwise:
  unused sleeve stays in cash
```

Execution remains causal: prior completed daily close decides the next daily open position.

Corrected Binance Spot evaluation, with one full year of pre-evaluation warm-up and 50 bps charged on every sleeve weight change, 25 Sep 2021 to 25 Sep 2026:

- total return: **+247.0%**
- CAGR: **28.3%**
- max drawdown: **-34.7%**
- Sharpe: **0.84**

For comparison, the corrected own-SMA200-only three-sleeve core produced:

- total return: +216.5%
- CAGR: 25.9%
- max drawdown: -40.7%
- Sharpe: 0.79

The gate improved the two non-BTC sleeves individually at SMA200:

- ETH: CAGR 19.4% -> 21.8%; max DD -40.0% -> -35.0%
- SOL: CAGR 24.3% -> 30.1%; max DD -68.1% -> -58.3%

Robustness checks:

- keeping the BTC gate at SMA200 while varying ETH/SOL own trend periods showed improvement for SOL across 150/180/200/220/250 days, and for ETH across 180/200/220/250 days (150d was weaker);
- varying the BTC gate itself showed the strongest plateau around roughly 150–200 days, with deterioration above ~220 days;
- therefore SMA200 is retained as the neutral anchor rather than selecting the highest-return gate period.

This edge **did not generalize cleanly to a broad altcoin universe**. BNB, XRP, ADA and DOGE did not show the same robust long/cash behavior. Treat the hierarchy as specific to the BTC/ETH/SOL research universe, not as a universal crypto rule.

Still research-only. No live promotion, leverage, or execution integration is authorized.


## Rolling-window falsification — core vs BTC gate

The BTC market gate was subjected to a longer rolling-window test using BTC/ETH history from 25 Sep 2018 to 25 Sep 2026. Each rolling window was 365 days, advanced every 30 days. This test was run after one full year of indicator warm-up.

At 50 bps transaction-cost stress:

### Own-SMA200 core
- positive rolling 12m windows: **65.1%**
- median rolling CAGR: **29.1%**
- worst rolling CAGR: **-50.0%**
- median rolling max DD: **-30.8%**
- worst rolling max DD: **-63.8%**

### Hard BTC gate
- positive rolling 12m windows: **68.6%**
- median rolling CAGR: **28.2%**
- worst rolling CAGR: **-62.2%**
- median rolling max DD: **-30.8%**
- worst rolling max DD: **-62.1%**

### Soft BTC gate sensitivity
When ETH exposure during BTC-bear regime was scaled instead of forced fully to zero:

- 25% residual ETH exposure: 69.8% positive windows, median CAGR 28.4%, worst CAGR -59.1%
- 50% residual ETH exposure: 68.6% positive windows, median CAGR 27.3%, worst CAGR -56.0%
- 75% residual ETH exposure: 67.4% positive windows, median CAGR 27.9%, worst CAGR -53.0%

The gate does not dominate the own-SMA200 core across rolling windows. It improves some regimes and worsens others, especially around parts of 2021.

**Current interpretation:**
- `own close > own SMA200 -> long; otherwise cash` remains the most defensible core edge family for this research universe.
- BTC market gating is downgraded to an optional risk overlay, not the core rule.
- No hard or soft gate setting is promoted based on the current evidence.

Research-only; no live execution authorization.


## Drawdown-reduction research — volatility throttle

The core directional rule remains unchanged:

```
own prior daily close > own SMA200
→ long the asset sleeve
otherwise
→ cash
```

A separate **Conservative Risk Mode** was tested that only scales an already-active sleeve downward:

```
realizedVol = annualized standard deviation of the prior 60 daily log returns
throttle = min(1, 0.40 / realizedVol)
active sleeve weight = (1/3) * throttle
```

The overlay never increases a sleeve above its original 1/3 maximum and never creates a new long signal.

### Corrected BTC / ETH / SOL sample

Binance Spot, one-year pre-evaluation warm-up, evaluation 25 Sep 2021 to 25 Sep 2026, 50 bps per weight change:

**Core SMA200**
- total return: +216.5%
- CAGR: 25.9%
- max drawdown: -40.7%
- Sharpe: 0.79
- Calmar: 0.64
- average gross exposure: 47.9%

**SMA200 + 60d realized-vol throttle, 40% annualized target**
- total return: +146.8%
- CAGR: 19.8%
- max drawdown: **-23.6%**
- Sharpe: **0.86**
- Calmar: **0.84**
- average gross exposure: 32.9%

The reduction in drawdown is not free: return and average market exposure both fall. This is therefore a risk mode, not a replacement signal.

### Parameter neighborhood

Using the same 60-day realized-volatility estimate:

- 40% target: CAGR 19.8%, max DD -23.6%, Sharpe 0.86, Calmar 0.84
- 45% target: CAGR 21.5%, max DD -26.1%, Sharpe 0.85, Calmar 0.82
- 50% target: CAGR 22.9%, max DD -27.8%, Sharpe 0.85, Calmar 0.82
- 55% target: CAGR 24.0%, max DD -29.6%, Sharpe 0.84, Calmar 0.81
- 60% target: CAGR 24.6%, max DD -32.0%, Sharpe 0.83, Calmar 0.77

This forms a smooth risk/return trade-off rather than a single isolated parameter optimum.

### Longer-history rolling check

For BTC/ETH from 25 Sep 2018 to 25 Sep 2026, using 86 rolling 365-day windows advanced every 30 days and 50 bps costs:

**Own-SMA200 core**
- positive windows: 65.1%
- median rolling CAGR: 29.1%
- worst rolling CAGR: -50.0%
- median rolling max DD: -30.8%
- worst rolling max DD: -63.8%

**60d / 40% volatility throttle**
- positive windows: 69.8%
- median rolling CAGR: 23.1%
- worst rolling CAGR: -28.8%
- median rolling max DD: -22.8%
- worst rolling max DD: **-36.9%**
- rolling drawdown was shallower than the core in **100% of the 86 windows**

This is the strongest drawdown-reduction overlay found so far.

### Current hierarchy

1. **Core edge:** own daily close > own SMA200 -> long; otherwise cash.
2. **Conservative Risk Mode:** optional 60d realized-volatility throttle with a 40% annualized target.
3. **BTC market gate:** remains research-only and downgraded; rolling-window tests did not show dominance over the core.

Nothing here authorizes live execution, leverage, or deployment.


## Portfolio-level volatility targeting — current strongest risk overlay

A stronger risk overlay was found by scaling the **whole active SMA200 portfolio** rather than throttling each asset independently.

Causal rule:

```
base weights:
  each asset = 1/3 only when own prior close > own SMA200
  otherwise 0

basePortfolioVol:
  annualized standard deviation of prior 60 daily returns
  of the unthrottled base portfolio

scale = min(1, targetPortfolioVol / basePortfolioVol)

final weights = base weights * scale
```

Important constraints:

- the overlay cannot turn an OFF signal ON;
- it cannot increase any weight above the original SMA200 core;
- `scale <= 1` always;
- volatility uses only prior base-portfolio returns;
- pre-evaluation history is used for both SMA and portfolio-volatility warm-up;
- execution remains prior-close decision -> next-open return;
- no leverage is introduced.

### BTC / ETH / SOL, 25 Sep 2021 to 25 Sep 2026

Binance Spot, full warm-up, 50 bps charged per weight change:

**Core SMA200**
- CAGR: 25.9%
- max DD: -40.7%
- Sharpe: 0.79

**60d / 20% portfolio-vol target**
- CAGR: **22.6%**
- max DD: **-17.5%**
- Sharpe: **1.19**
- Calmar: **1.29**

**60d / 25% portfolio-vol target**
- CAGR: **24.6%**
- max DD: **-20.6%**
- Sharpe: **1.11**
- Calmar: **1.20**

At 100 bps transaction-cost stress:

- 20% target: CAGR 19.3%, max DD -20.0%, Sharpe 1.05
- 25% target: CAGR 20.9%, max DD -23.4%, Sharpe 0.98

The target therefore behaves like a transparent risk dial rather than an entry filter.

### Lookback robustness

BTC / ETH / SOL, 50 bps:

- 45d / 20%: CAGR 20.7%, max DD -17.1%, Sharpe 1.14
- 60d / 20%: CAGR 22.6%, max DD -17.5%, Sharpe 1.19
- 90d / 20%: CAGR 24.4%, max DD -15.4%, Sharpe 1.23
- 45d / 25%: CAGR 22.8%, max DD -20.1%, Sharpe 1.07
- 60d / 25%: CAGR 24.6%, max DD -20.6%, Sharpe 1.11
- 90d / 25%: CAGR 27.2%, max DD -18.8%, Sharpe 1.16

The effect is not isolated to one lookback. 60 days remains the neutral anchor because it also behaved strongly in the longer BTC/ETH sample.

### Longer BTC / ETH check, 25 Sep 2018 to 25 Sep 2026

With 50 bps costs and complete warm-up:

**60d / 20% target**
- CAGR: 25.5%
- max DD: -22.2%
- Sharpe: 1.26
- Calmar: 1.15
- positive rolling 12m windows: 81.4%
- worst rolling 12m CAGR: -13.1%
- worst rolling 12m DD: -22.2%

**60d / 25% target**
- CAGR: 28.8%
- max DD: -27.1%
- Sharpe: 1.20
- Calmar: 1.06
- positive rolling 12m windows: 80.2%
- worst rolling 12m CAGR: -16.1%
- worst rolling 12m DD: -27.1%

For comparison, the unthrottled BTC/ETH own-SMA200 core over the longer sample had:

- CAGR: 41.1%
- max DD: -63.8%
- Sharpe: 0.97
- positive rolling 12m windows: 65.1%
- worst rolling 12m CAGR: about -50%

### Current risk hierarchy

- **Core signal:** own prior close > own SMA200 -> active sleeve; otherwise cash.
- **Defensive research mode:** 60d portfolio-vol target at 20%.
- **Moderate research mode:** 60d portfolio-vol target at 25%.
- **Per-asset volatility throttle:** still valid as a secondary overlay, but portfolio-level targeting produced better historical risk-adjusted behavior.
- **BTC market gate:** remains downgraded and research-only.

These are backtest findings, not proof of future returns. No live deployment or leverage is authorized.


## Operational shadow state

A read-only daily state generator has been added:

```bash
npm run research:reborn-shadow
```

It fetches Binance Spot public daily klines and outputs:

- prior completed daily candle used for the signal;
- SMA200 regime state for BTC / ETH / SOL;
- unthrottled base weights;
- prior 60-day realized volatility of the unthrottled core portfolio;
- Defensive 20% portfolio-vol scale and final weights;
- Moderate 25% portfolio-vol scale and final weights.

It does **not** submit orders, emit Confirm Live tickets, or connect to an exchange execution path.

### First recorded shadow snapshot — 25 Sep 2026

Using the completed 24 Sep 2026 UTC daily candle for the 25 Sep 2026 UTC open:

- BTCUSDT: regime ON; close 84,410.24; SMA200 ~70,887.02
- ETHUSDT: regime ON; close 2,688.05; SMA200 ~2,091.88
- SOLUSDT: regime ON; close 117.04; SMA200 ~84.46
- all three base sleeves therefore ON at 1/3 each
- trailing 60-day annualized base-portfolio volatility: ~42.55%

Research weights at that open:

- Defensive 20% target: scale ~0.470; each active sleeve ~15.67%; gross ~47.0%
- Moderate 25% target: scale ~0.588; each active sleeve ~19.58%; gross ~58.7%

The snapshot is stored at:

`research/snapshots/hunter_reborn_shadow_2026-09-25.json`

This is a reproducibility artifact only, not a trade instruction.


## Portfolio-vol robustness: refresh cadence and block bootstrap

### Scale refresh cadence

The SMA200 core still updates daily. Only the portfolio-volatility scalar refresh frequency was varied.

BTC / ETH / SOL, 60-day estimator, 50 bps costs:

**20% target**
- daily refresh: CAGR 22.6%, max DD -17.5%, Sharpe 1.19
- every 3 days: CAGR 22.7%, max DD -17.9%, Sharpe 1.19
- every 7 days: CAGR 23.1%, max DD -17.7%, Sharpe 1.20
- every 14 days: CAGR 24.1%, max DD -17.6%, Sharpe 1.21

**25% target**
- daily refresh: CAGR 24.6%, max DD -20.6%, Sharpe 1.11
- every 7 days: CAGR 25.3%, max DD -20.9%, Sharpe 1.12
- every 14 days: CAGR 25.6%, max DD -20.9%, Sharpe 1.12

Longer BTC / ETH history (25 Sep 2018 to 25 Sep 2026) showed the same pattern: weekly and biweekly refresh remained viable, while daily refresh produced slightly shallower drawdown. The risk-first research default therefore remains **daily scale refresh**; slower refresh is an operational simplification option, not a separate edge.

### Paired block-bootstrap stress test

To reduce dependence on one historical ordering, the net daily return streams of the unthrottled core and 20% portfolio-vol mode were resampled in paired blocks. The same sampled blocks were applied to both strategies so the comparison remained path-matched. Two block sizes were used to preserve short- and medium-range dependence.

#### BTC / ETH / SOL, 25 Sep 2021 to 25 Sep 2026
2,000 deterministic resamples per block size:

**7-day blocks**
- risk mode had shallower max DD in **100.0%** of resamples
- higher Sharpe in **98.8%**
- higher Calmar in **97.3%**
- higher CAGR in only **40.1%**

**30-day blocks**
- shallower max DD in **100.0%**
- higher Sharpe in **99.0%**
- higher Calmar in **98.2%**
- higher CAGR in **50.2%**

The bootstrap median max DD moved from roughly -47% to -21% with 7-day blocks, and from roughly -51% to -23% with 30-day blocks.

#### BTC / ETH, 25 Sep 2018 to 25 Sep 2026
2,000 deterministic resamples per block size:

**7-day blocks**
- shallower max DD in **100.0%**
- higher Sharpe in **97.8%**
- higher Calmar in **89.7%**
- higher CAGR in **14.1%**

**30-day blocks**
- shallower max DD in **100.0%**
- higher Sharpe in **97.8%**
- higher Calmar in **89.7%**
- higher CAGR in **16.4%**

This reinforces the intended interpretation: the 20% portfolio-volatility target is a **risk-path improvement**, not a return-maximization rule. It often sacrifices upside in exchange for materially shallower drawdown and better risk-adjusted behavior.

### Locked research hierarchy after this pass

1. **Directional core:** own prior daily close > own SMA200 -> active sleeve; otherwise cash.
2. **Primary risk overlay:** 60-day base-portfolio realized-volatility target.
   - Defensive research mode: 20% annualized target.
   - Moderate research mode: 25% annualized target.
3. **Refresh default:** daily, with weekly refresh shown to be viable if operational simplicity is preferred.
4. Per-asset volatility throttle remains secondary.
5. BTC hard/soft gate remains downgraded.
6. No intraday entry layer is currently promoted.

No merge, deployment, leverage, or live execution is authorized by these findings.


## Funding-adjusted USD-M cross-check

A futures-specific cross-check was run using Binance USD-M perpetual daily klines for price/SMA/portfolio-volatility and Binance historical funding-rate records for carry cost.

Focused evaluation window:

- warm-up starts 20 Aug 2022
- performance evaluation: 10 Mar 2023 to 24 Sep 2026
- BTCUSDT / ETHUSDT / SOLUSDT
- daily signal timing remains prior close -> next daily open
- positive funding is deducted from long exposure; negative funding is credited
- all funding events in the UTC day are summed
- the 00:00 funding event is included conservatively
- transaction-cost stress remains charged on weight changes

At 50 bps transaction-cost stress:

**Price-only core**
- CAGR: 39.5%
- max DD: -37.1%
- Sharpe: 1.01

**Funding-adjusted core**
- CAGR: 31.7%
- max DD: -39.1%
- Sharpe: 0.87
- simple summed funding charge over the test path: ~20.39% of notional-weighted capital

**Funding-adjusted Defensive 20% portfolio-vol mode**
- CAGR: **31.8%**
- max DD: **-19.2%**
- Sharpe: **1.40**
- Calmar: **1.66**
- simple summed funding charge: ~9.38%

**Funding-adjusted Moderate 25% mode**
- CAGR: 34.1%
- max DD: -22.0%
- Sharpe: 1.30
- Calmar: 1.55
- simple summed funding charge: ~11.29%

At **100 bps transaction-cost stress**, funding-adjusted Defensive 20% still produced:

- CAGR: 27.3%
- max DD: -21.1%
- Sharpe: 1.23
- Calmar: 1.29

Interpretation: funding is a material drag and cannot be ignored, but it did not invalidate the current long/cash trend + portfolio-vol risk framework in this focused futures sample. The risk overlay also reduces funding drag by lowering average long exposure.

This is still a historical research result, not authorization to trade futures live or use leverage.
