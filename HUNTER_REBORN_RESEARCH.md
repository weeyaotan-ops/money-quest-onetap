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
