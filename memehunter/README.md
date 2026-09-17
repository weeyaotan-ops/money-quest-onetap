# Solana MemeHunter v0.1 — Micro Live

Purpose: fail-closed Solana memecoin hunter for a dedicated hot wallet. It discovers early Solana tokens, applies market + on-chain safety gates, verifies a two-way Jupiter route, then (only when `LIVE_TRADING=1`) buys a fixed USDC amount and automatically manages the exit.

## Execution stack
- Discovery: DEX Screener latest token profiles + boosts, then `/tokens/v1/solana/...`
- On-chain safety: Solana RPC (standard SPL Token only by default, revoked mint/freeze authority, extreme concentration gate)
- Execution: Jupiter Swap API v2 `/order` + `/execute`
- Base asset: native Solana USDC (`EPjF...Dt1v`)
- Persistence: PostgreSQL tables prefixed `mh_meme_`
- Alerts: Telegram send-only; Telegram cannot submit trades

## Fail-closed rules
New entries are blocked when any required dependency or rule fails: missing Jupiter key, live wallet key missing, daily loss/trade cap, max open position, insufficient USDC/SOL, unsafe mint, no two-way route, excessive estimated round-trip cost, duplicate/recent trade, or runtime pause.

If a sell route repeatedly fails, or a live exit fails, new entries are paused while the position monitor keeps retrying. Pending entries/exits are reconciled on restart.

## Required secrets
Never commit these. Set them directly in Railway Variables.
- `JUPITER_API_KEY`
- `BS58_PRIVATE_KEY` — dedicated hot-wallet private key; never use your main wallet
- `TELEGRAM_BOT_TOKEN` (optional but recommended)
- `TELEGRAM_CHAT_ID` (optional but recommended)
- `ADMIN_TOKEN` (recommended for /pause and /resume)

## Recommended Micro Live starting variables
```text
LIVE_TRADING=0
TRADE_USDC=5
MAX_OPEN_POSITIONS=1
MAX_TRADES_PER_DAY=6
MAX_DAILY_LOSS_USDC=15
MIN_SOL_GAS=0.02
STOP_LOSS_PCT=8
TAKE_PROFIT_PCT=15
TRAILING_ARM_PCT=10
TRAILING_GIVEBACK_PCT=5
MAX_HOLD_MIN=20
SCAN_MS=15000
POSITION_POLL_MS=5000
MIN_PAIR_AGE_MIN=3
MAX_PAIR_AGE_MIN=180
MIN_LIQUIDITY_USD=25000
MIN_M5_VOLUME_USD=5000
MIN_M5_BUYS=15
MIN_BUY_SELL_RATIO=1.35
MIN_M5_PRICE_CHANGE_PCT=3
MAX_M5_PRICE_CHANGE_PCT=60
MIN_FDV_USD=50000
MAX_FDV_USD=3000000
MIN_LIQUIDITY_FDV_RATIO=0.05
MAX_ROUNDTRIP_LOSS_PCT=5
MAX_ENTRY_QUOTE_DETERIORATION_PCT=3
REQUIRE_REVOKED_MINT_AUTHORITY=1
REQUIRE_REVOKED_FREEZE_AUTHORITY=1
ALLOW_TOKEN_2022=0
```

Keep `LIVE_TRADING=0` until the wallet is funded and `/status` reports healthy. Then change only `LIVE_TRADING=1` to activate Micro Live.

## Hot wallet
Use a separate wallet only for this bot. Start small. A practical micro-live funding level for the default settings is about 30 USDC plus at least 0.02–0.03 SOL for gas. Do not store unrelated assets in this wallet.

Local wallet generator (only run on your own machine):
```bash
npm install
npm run wallet:new
```
Paste the generated private key directly into Railway `BS58_PRIVATE_KEY`. Do not send it through ChatGPT, Telegram, screenshots, or GitHub.

## Health and control
- `GET /health` — deployment health
- `GET /status` — mode, wallet balances, daily stats, open positions, risk limits (no secrets)
- `POST /pause` with header `x-admin-token: <ADMIN_TOKEN>`
- `POST /resume` with the same header

Telegram is notification-only. It has no CONFIRM LIVE button and no execution callback.
