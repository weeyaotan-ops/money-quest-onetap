# Solana Meme Shadow V1

Research-only scanner for forward-testing early Solana meme-token selection.

This branch does **not** contain wallet keys, transaction signing, swap execution, leverage, or live-order code.

## What V1 measures

- Pair age
- Liquidity and liquidity/market-cap ratio
- 5m and 1h volume
- 5m buyer/seller pressure
- Volume acceleration
- Short-horizon price extension
- Social presence
- SPL mint/freeze authority
- Top-holder concentration when public RPC permits it

Discovery uses DEX Screener public endpoints. DEX Screener documents token profiles, boosts, pair lookup, transaction counts, volume, price changes, liquidity, market cap and pair creation timestamps in its API. Jupiter Tokens V2 can later add holder count, audit fields and organic score if an API key is connected.

## Forward test

Every candidate is recorded before its outcome. Primary result is 6h net return after a frozen 3% round-trip friction assumption. Secondary horizons are 1h and 24h.

No thresholds may be retuned until 100 resolved eligible candidates exist.
