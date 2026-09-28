# Hunter Core V1

Clean signal-only rebuild for BTCUSDT, ETHUSDT and SOLUSDT.

## What it uses

- 4H / 1H / 15M trend and regime
- Cross-sectional relative strength
- Funding crowding
- Open-interest change
- Perpetual basis
- Taker buy/sell flow
- ATR-based entry/stop
- Equity-based risk sizing

## Edge score

```
rawEdge =
  0.40 * trend +
  0.25 * relativeStrength +
  0.20 * derivatives +
  0.15 * flow

finalEdge = rawEdge * regimeMultiplier
```

Regime multipliers:

- TREND = 1.00
- BREAKOUT = 0.80
- RANGE = 0.25
- CHAOS = 0.00

Trade only when `finalEdge >= +0.65` or `<= -0.65`.

## Run

```bash
npm run hunter:scan
```

Optional:

```bash
HUNTER_EQUITY_USDT=500 HUNTER_RISK_PCT=0.005 npm run hunter:scan
```

Default risk is 0.5% of equity per signal.

## Safety

This module is deliberately **SIGNAL_ONLY**. It does not read API keys and cannot submit orders.
