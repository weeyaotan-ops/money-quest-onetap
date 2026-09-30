#!/usr/bin/env python3
"""
Hunter Core V1 historical backtest.

Goals:
- Freeze the current V1 rule set (no parameter fitting in this script).
- Use official Binance Vision USD-M public archives.
- Avoid look-ahead: signals are evaluated only after candles are closed.
- Reconstruct derivatives inputs from archived funding + 5m metrics.
- Use premiumIndexKlines close as a historical proxy for live mark-vs-spot basis.
- Model conservative transaction costs and 24h time exit, matching the forward journal horizon.

This is research code, not an order-execution engine.
"""

from __future__ import annotations

import argparse
import bisect
import concurrent.futures as cf
import csv
import io
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://data.binance.vision/data/futures/um"
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
UTC = timezone.utc

TREND_W = (0.50, 0.30, 0.20)
EDGE_W = (0.40, 0.25, 0.20, 0.15)
ACTION_THRESHOLD = 0.65
ARMED_THRESHOLD = 0.50
WATCH_THRESHOLD = 0.35


def clamp(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, x))


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(mean([(x - m) ** 2 for x in xs]))


def log_return(a, b):
    return math.log(b / a) if a > 0 and b > 0 else 0.0


def returns_from_closes(xs):
    return [log_return(xs[i - 1], xs[i]) for i in range(1, len(xs))]


def atr(candles, period=14):
    if len(candles) < 2:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        h = candles[i]["high"]
        l = candles[i]["low"]
        pc = candles[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return mean(trs[-period:])


def normalized_momentum(candles, lookback):
    xs = [c["close"] for c in candles]
    if len(xs) <= lookback:
        return 0.0
    s = xs[-(lookback + 1):]
    r = log_return(s[0], s[-1])
    rs = returns_from_closes(s)
    vol = stdev(rs) * math.sqrt(max(lookback, 1))
    if vol < 1e-12:
        return 0.0
    return clamp((r / vol) / 2.5)


def efficiency_ratio(candles, lookback=20):
    xs = [c["close"] for c in candles]
    if len(xs) <= lookback:
        return 0.0
    s = xs[-(lookback + 1):]
    net = abs(s[-1] - s[0])
    path = sum(abs(s[i] - s[i - 1]) for i in range(1, len(s)))
    return clamp(net / path, 0, 1) if path > 0 else 0.0


def recent_volatility(candles, lookback=20):
    rs = returns_from_closes([c["close"] for c in candles])
    return stdev(rs[-lookback:])


def volume_z(candles, lookback=30):
    vs = [c["volume"] for c in candles]
    if len(vs) < 3:
        return 0.0
    hist = vs[-lookback - 1:-1]
    sd = stdev(hist)
    return (vs[-1] - mean(hist)) / sd if sd > 0 else 0.0


def breakout_direction(candles, lookback=20):
    if len(candles) <= lookback:
        return 0
    prior = candles[-(lookback + 1):-1]
    last = candles[-1]
    max_h = max(c["high"] for c in prior)
    min_l = min(c["low"] for c in prior)
    if last["close"] > max_h:
        return 1
    if last["close"] < min_l:
        return -1
    return 0


def trend_score(snap):
    return clamp(
        TREND_W[0] * normalized_momentum(snap["candles4h"], 12)
        + TREND_W[1] * normalized_momentum(snap["candles1h"], 24)
        + TREND_W[2] * normalized_momentum(snap["candles15m"], 16)
    )


def classify_regime(snap, t_score):
    c15 = snap["candles15m"]
    er = efficiency_ratio(snap["candles1h"], 20)
    v_short = recent_volatility(c15, 8)
    v_long = recent_volatility(c15, 40) or 1e-12
    vol_ratio = v_short / v_long
    a = atr(c15, 14)
    last = c15[-1]
    last_range = last["high"] - last["low"]
    br = breakout_direction(c15, 20)
    vz = volume_z(c15, 30)

    if vol_ratio > 2.25 or (a > 0 and last_range > 3.25 * a):
        return {"name": "CHAOS", "multiplier": 0.0}
    if br != 0 and vz > 0.25 and (1 if (t_score or br) > 0 else -1) == br:
        return {"name": "BREAKOUT", "multiplier": 0.8}
    if er >= 0.34 and abs(t_score) >= 0.28:
        return {"name": "TREND", "multiplier": 1.0}
    return {"name": "RANGE", "multiplier": 0.25}


def risk_adjusted_return(candles, lookback=24):
    xs = [c["close"] for c in candles]
    if len(xs) <= lookback:
        return 0.0
    r = log_return(xs[-1 - lookback], xs[-1])
    rs = returns_from_closes(xs[-(lookback + 1):])
    vol = stdev(rs) * math.sqrt(lookback)
    return r / vol if vol > 1e-12 else 0.0


def relative_strength_scores(snaps):
    raw = [(s["symbol"], risk_adjusted_return(s["candles1h"], 24)) for s in snaps]
    vals = [x[1] for x in raw]
    m = mean(vals)
    sd = stdev(vals)
    out = {}
    for sym, val in raw:
        z = (val - m) / sd if sd > 1e-12 else 0.0
        out[sym] = clamp(math.tanh(z / 1.25))
    return out


def z_score_latest(values):
    if not values or len(values) < 3:
        return 0.0
    hist = values[:-1]
    sd = stdev(hist)
    return (values[-1] - mean(hist)) / sd if sd > 1e-12 else 0.0


def derivatives_score(snap, t_score):
    funding_rates = [x["rate"] for x in snap["funding"] if math.isfinite(x["rate"])]
    funding_z = z_score_latest(funding_rates[-30:])
    funding_component = clamp(-math.tanh(funding_z / 2))

    oi = snap["openInterestHistory"]
    oi_change = 0.0
    if len(oi) >= 2:
        a = oi[-2]["value"]
        b = oi[-1]["value"]
        if a > 0 and b > 0:
            oi_change = math.log(b / a)
    oi_magnitude = clamp(abs(oi_change) / 0.025, 0, 1)
    oi_component = (1 if t_score > 0 else -1 if t_score < 0 else 0) * oi_magnitude if oi_change > 0 else 0.0

    basis_rates = [x["rate"] for x in snap["basis"] if math.isfinite(x["rate"])]
    latest_basis = basis_rates[-1] if basis_rates else 0.0
    basis_component = clamp(-math.tanh(latest_basis / 0.0015))

    score = clamp(0.40 * funding_component + 0.40 * oi_component + 0.20 * basis_component)
    return score


def flow_score(snap):
    rows = snap["taker"]
    if not rows:
        return 0.0
    recent = [x["buySellRatio"] for x in rows[-8:] if math.isfinite(x["buySellRatio"]) and x["buySellRatio"] > 0]
    if not recent:
        return 0.0
    avg_log_ratio = mean([math.log(x) for x in recent])
    return clamp(math.tanh(avg_log_ratio / 0.35))


def build_trade_plan(snap, side):
    price = snap["candles15m"][-1]["close"]
    a = atr(snap["candles15m"], 14)
    if price <= 0 or a <= 0:
        return None
    direction = 1 if side == "LONG" else -1
    near = price - direction * 0.10 * a
    far = price - direction * 0.35 * a
    lo, hi = min(near, far), max(near, far)
    mid = (lo + hi) / 2
    stop = mid - direction * 1.5 * a
    return {
        "entryZone": [lo, hi],
        "entryMid": mid,
        "stop": stop,
        "atr15m": a,
    }


def score_snapshots(snaps):
    rs = relative_strength_scores(snaps)
    out = []
    for snap in snaps:
        trend = trend_score(snap)
        regime = classify_regime(snap, trend)
        deriv = derivatives_score(snap, trend)
        flow = flow_score(snap)
        edge_raw = clamp(
            EDGE_W[0] * trend
            + EDGE_W[1] * rs.get(snap["symbol"], 0.0)
            + EDGE_W[2] * deriv
            + EDGE_W[3] * flow
        )
        edge = clamp(edge_raw * regime["multiplier"])
        decision = "NO_TRADE"
        if edge >= ACTION_THRESHOLD:
            decision = "LONG"
        elif edge <= -ACTION_THRESHOLD:
            decision = "SHORT"
        out.append({
            "symbol": snap["symbol"],
            "decision": decision,
            "edge": edge,
            "edgeRaw": edge_raw,
            "regime": regime,
            "components": {
                "trend": trend,
                "relativeStrength": rs.get(snap["symbol"], 0.0),
                "derivatives": deriv,
                "flow": flow,
            },
            "plan": build_trade_plan(snap, decision) if decision != "NO_TRADE" else None,
        })
    out.sort(key=lambda x: abs(x["edge"]), reverse=True)
    return out


def parse_dt(s):
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def month_iter(start_d, end_d):
    y, m = start_d.year, start_d.month
    while (y, m) <= (end_d.year, end_d.month):
        yield y, m
        if m == 12:
            y += 1
            m = 1
        else:
            m += 1


def day_iter(start_d, end_d):
    d = start_d
    while d <= end_d:
        yield d
        d += timedelta(days=1)


def fetch_zip_csv(url, retries=3, timeout=30):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hunter-core-v1-backtest/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
            with zipfile.ZipFile(io.BytesIO(payload)) as z:
                names = [n for n in z.namelist() if not n.endswith("/")]
                if not names:
                    return []
                with z.open(names[0]) as f:
                    text = io.TextIOWrapper(f, encoding="utf-8-sig", newline="")
                    return list(csv.reader(text))
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return []
            last = e
        except Exception as e:
            last = e
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def is_header(row):
    if not row:
        return False
    try:
        float(row[0])
        return False
    except Exception:
        return True


def parse_kline_rows(rows):
    if rows and is_header(rows[0]):
        rows = rows[1:]
    out = []
    for r in rows:
        if len(r) < 7:
            continue
        try:
            open_t = int(float(r[0]))
            close_t = int(float(r[6]))
            out.append({
                "openTime": open_t,
                "open": float(r[1]),
                "high": float(r[2]),
                "low": float(r[3]),
                "close": float(r[4]),
                "volume": float(r[5]),
                "closeTime": close_t,
                "availableTime": close_t + 1,
            })
        except Exception:
            continue
    return out


def parse_premium_rows(rows):
    # premiumIndexKlines share the standard kline layout; close is a premium-rate proxy.
    return [{"time": x["availableTime"], "rate": x["close"]} for x in parse_kline_rows(rows)]


def parse_funding_rows(rows):
    if not rows:
        return []
    header = [x.strip().lower() for x in rows[0]] if rows and is_header(rows[0]) else None
    data = rows[1:] if header else rows

    time_idx = 0
    rate_idx = None
    if header:
        for i, h in enumerate(header):
            if h in ("calc_time", "funding_time", "fundingtime", "time"):
                time_idx = i
            if h in ("last_funding_rate", "funding_rate", "fundingrate"):
                rate_idx = i
    if rate_idx is None:
        rate_idx = len(data[0]) - 1 if data else 2

    out = []
    for r in data:
        try:
            t = int(float(r[time_idx]))
            rate = float(r[rate_idx])
            if math.isfinite(rate):
                out.append({"time": t, "rate": rate})
        except Exception:
            continue
    return out


def parse_metrics_rows(rows):
    if not rows:
        return []
    header = [x.strip().lower() for x in rows[0]]
    if "create_time" not in header:
        return []

    idx = {h: i for i, h in enumerate(header)}
    out5 = []
    for r in rows[1:]:
        try:
            t = int(parse_dt(r[idx["create_time"]]).timestamp() * 1000)
            oi = float(r[idx["sum_open_interest"]])
            ratio = float(r[idx["sum_taker_long_short_vol_ratio"]])
            if not (math.isfinite(oi) and math.isfinite(ratio)):
                continue
            out5.append((t, oi, ratio))
        except Exception:
            continue

    # Reproduce live OKX fallback normalization: 3 x 5m -> one 15m point.
    out5.sort()
    out = []
    for i in range(0, len(out5) - 2, 3):
        chunk = out5[i:i + 3]
        if len(chunk) != 3:
            continue
        # Skip non-contiguous triplets.
        if chunk[2][0] - chunk[0][0] > 11 * 60 * 1000:
            continue
        t = chunk[-1][0]
        oi = chunk[-1][1]
        # Ratio is not additive. A geometric mean is stable for ratio aggregation.
        logs = [math.log(max(x[2], 1e-12)) for x in chunk]
        ratio = math.exp(mean(logs))
        out.append({
            "time": t,
            "oi": oi,
            "buySellRatio": ratio,
        })
    return out


@dataclass
class Series:
    rows: list
    times: list

    @classmethod
    def from_rows(cls, rows, time_key):
        rows = sorted(rows, key=lambda x: x[time_key])
        # de-duplicate by timestamp, last observation wins
        dedup = {}
        for r in rows:
            dedup[r[time_key]] = r
        rows = [dedup[k] for k in sorted(dedup)]
        return cls(rows, [r[time_key] for r in rows])

    def upto(self, t, n=None):
        i = bisect.bisect_right(self.times, t)
        lo = max(0, i - n) if n else 0
        return self.rows[lo:i]

    def latest(self, t):
        i = bisect.bisect_right(self.times, t)
        return self.rows[i - 1] if i > 0 else None


def download_many(url_jobs, parser, workers=24):
    rows = []
    missing = 0
    failed = 0

    def one(item):
        url, tag = item
        try:
            raw = fetch_zip_csv(url)
            if not raw:
                return tag, [], "missing"
            return tag, parser(raw), None
        except Exception as e:
            return tag, [], str(e)

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(one, item) for item in url_jobs]
        total = len(futures)
        for n, fut in enumerate(cf.as_completed(futures), 1):
            tag, part, err = fut.result()
            if err == "missing":
                missing += 1
            elif err:
                failed += 1
                print(f"WARN {tag}: {err}", file=sys.stderr)
            else:
                rows.extend(part)
            if n % 500 == 0:
                print(f"download progress {n}/{total}", flush=True)
    return rows, {"requested": len(url_jobs), "missing": missing, "failed": failed}


def build_urls(symbol, start_d, end_d, kind, interval=None):
    jobs = []
    if kind == "metrics":
        for d in day_iter(start_d, end_d):
            stamp = d.isoformat()
            url = f"{BASE}/daily/metrics/{symbol}/{symbol}-metrics-{stamp}.zip"
            jobs.append((url, f"{symbol} metrics {stamp}"))
        return jobs

    for y, m in month_iter(start_d, end_d):
        stamp = f"{y:04d}-{m:02d}"
        if kind == "klines":
            url = f"{BASE}/monthly/klines/{symbol}/{interval}/{symbol}-{interval}-{stamp}.zip"
        elif kind == "premium":
            url = f"{BASE}/monthly/premiumIndexKlines/{symbol}/15m/{symbol}-15m-{stamp}.zip"
        elif kind == "funding":
            url = f"{BASE}/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{stamp}.zip"
        else:
            raise ValueError(kind)
        jobs.append((url, f"{symbol} {kind} {stamp}"))
    return jobs


def load_symbol(symbol, start_d, end_d, workers):
    print(f"\n=== downloading {symbol} ===", flush=True)
    result = {"symbol": symbol, "quality": {}}

    for interval in ("15m", "1h", "4h"):
        rows, q = download_many(build_urls(symbol, start_d, end_d, "klines", interval), parse_kline_rows, workers)
        result[f"candles{interval}"] = Series.from_rows(rows, "availableTime")
        result["quality"][f"klines_{interval}"] = q
        print(f"{symbol} {interval}: {len(rows):,} rows", flush=True)

    premium, q = download_many(build_urls(symbol, start_d, end_d, "premium"), parse_premium_rows, workers)
    result["basis"] = Series.from_rows(premium, "time")
    result["quality"]["premium"] = q
    print(f"{symbol} premium: {len(premium):,} rows", flush=True)

    funding, q = download_many(build_urls(symbol, start_d, end_d, "funding"), parse_funding_rows, workers)
    result["funding"] = Series.from_rows(funding, "time")
    result["quality"]["funding"] = q
    print(f"{symbol} funding: {len(funding):,} rows", flush=True)

    metrics, q = download_many(build_urls(symbol, start_d, end_d, "metrics"), parse_metrics_rows, workers)
    result["metrics"] = Series.from_rows(metrics, "time")
    result["quality"]["metrics"] = q
    print(f"{symbol} metrics15m: {len(metrics):,} rows", flush=True)

    return result


def snapshot_at(data, t):
    c4 = data["candles4h"].upto(t, 160)
    c1 = data["candles1h"].upto(t, 180)
    c15 = data["candles15m"].upto(t, 180)
    if len(c4) < 40 or len(c1) < 40 or len(c15) < 60:
        return None

    funding = data["funding"].upto(t, 30)
    metrics = data["metrics"].upto(t, 32)
    basis_latest = data["basis"].latest(t)

    if len(metrics) < 8:
        return None

    return {
        "symbol": data["symbol"],
        "candles4h": c4,
        "candles1h": c1,
        "candles15m": c15,
        "funding": funding,
        "openInterestHistory": [{"time": x["time"], "value": x["oi"]} for x in metrics],
        "basis": [basis_latest] if basis_latest else [],
        "taker": [{"time": x["time"], "buySellRatio": x["buySellRatio"]} for x in metrics],
    }


def funding_sum(series, start_t, end_t):
    i = bisect.bisect_right(series.times, start_t)
    j = bisect.bisect_right(series.times, end_t)
    return sum(x["rate"] for x in series.rows[i:j])


def candle_at_time(series, t):
    i = bisect.bisect_left(series.times, t)
    if i < len(series.times) and series.times[i] == t:
        return series.rows[i]
    return None


def run_backtest(all_data, start_ms, end_ms, fee_bps=5.0, slippage_bps=2.0, risk_pct=0.005):
    # Use BTC 15m closed-candle grid as the master timeline.
    master = all_data["BTCUSDT"]["candles15m"]
    timeline = [t for t in master.times if start_ms <= t <= end_ms]

    active = []
    trades = []
    signals = []
    skipped_missing = 0
    peak_active = 0

    for idx, t in enumerate(timeline):
        snaps = []
        for sym in SYMBOLS:
            s = snapshot_at(all_data[sym], t)
            if s is None:
                snaps = []
                break
            snaps.append(s)
        if not snaps:
            skipped_missing += 1
            continue

        ranked = score_snapshots(snaps)
        result_by_symbol = {x["symbol"]: x for x in ranked}

        # First update existing setups, matching live journal ordering.
        survivors = []
        for sig in active:
            result = result_by_symbol[sig["symbol"]]
            candle = candle_at_time(all_data[sig["symbol"]]["candles15m"], t)
            if candle is None or t <= sig["signalTime"]:
                survivors.append(sig)
                continue

            if sig["status"] == "PENDING_ENTRY":
                age = t - sig["signalTime"]
                current_edge = result["edge"]
                current_side = "LONG" if current_edge >= 0 else "SHORT"
                opposite = current_side != sig["side"] and abs(current_edge) >= WATCH_THRESHOLD
                collapsed = abs(current_edge) < 0.20

                if age >= 24 * 60 * 60 * 1000:
                    sig["status"] = "EXPIRED"
                    sig["closeReason"] = "ENTRY_NOT_TOUCHED_24H"
                    continue
                if opposite or collapsed:
                    sig["status"] = "INVALIDATED"
                    sig["closeReason"] = "EDGE_FLIPPED" if opposite else "EDGE_COLLAPSED"
                    continue

                # Strict fill: midpoint itself must trade, not merely the outer watch zone.
                if candle["low"] <= sig["entryMid"] <= candle["high"]:
                    sig["status"] = "TRIGGERED"
                    sig["triggerTime"] = t
                    sig["entryYear"] = datetime.fromtimestamp(t / 1000, UTC).year
                    sig["mfeR"] = 0.0
                    sig["maeR"] = 0.0

                    # Conservative intrabar ordering: if entry and stop are both in this candle, count stop.
                    stop_hit = candle["low"] <= sig["stop"] if sig["side"] == "LONG" else candle["high"] >= sig["stop"]
                    if stop_hit:
                        gross_r = -1.0
                        risk = abs(sig["entryMid"] - sig["stop"])
                        cost_r = (2 * (fee_bps + slippage_bps) / 10000.0) * sig["entryMid"] / risk
                        fsum = funding_sum(all_data[sig["symbol"]]["funding"], t, t)
                        direction = 1 if sig["side"] == "LONG" else -1
                        funding_r = -direction * fsum * sig["entryMid"] / risk
                        sig["netR"] = gross_r - cost_r + funding_r
                        sig["grossR"] = gross_r
                        sig["fundingR"] = funding_r
                        sig["costR"] = cost_r
                        sig["exitTime"] = t
                        sig["closeReason"] = "SAME_CANDLE_STOP_WORST_CASE"
                        trades.append(sig.copy())
                        continue
                survivors.append(sig)
                continue

            if sig["status"] == "TRIGGERED":
                risk = abs(sig["entryMid"] - sig["stop"])
                direction = 1 if sig["side"] == "LONG" else -1
                favorable = ((candle["high"] - sig["entryMid"]) / risk) if direction == 1 else ((sig["entryMid"] - candle["low"]) / risk)
                adverse = ((candle["low"] - sig["entryMid"]) / risk) if direction == 1 else ((sig["entryMid"] - candle["high"]) / risk)
                sig["mfeR"] = max(sig["mfeR"], favorable)
                sig["maeR"] = min(sig["maeR"], adverse)

                stop_hit = candle["low"] <= sig["stop"] if direction == 1 else candle["high"] >= sig["stop"]
                elapsed = t - sig["triggerTime"]
                gross_r = None
                reason = None

                if stop_hit:
                    gross_r = -1.0
                    reason = "STOP_TOUCHED"
                elif elapsed >= 24 * 60 * 60 * 1000:
                    gross_r = direction * (candle["close"] - sig["entryMid"]) / risk
                    reason = "24H_TIME_EXIT"

                if gross_r is not None:
                    cost_r = (2 * (fee_bps + slippage_bps) / 10000.0) * sig["entryMid"] / risk
                    fsum = funding_sum(all_data[sig["symbol"]]["funding"], sig["triggerTime"], t)
                    funding_r = -direction * fsum * sig["entryMid"] / risk
                    sig["netR"] = gross_r - cost_r + funding_r
                    sig["grossR"] = gross_r
                    sig["fundingR"] = funding_r
                    sig["costR"] = cost_r
                    sig["exitTime"] = t
                    sig["closeReason"] = reason
                    trades.append(sig.copy())
                    continue

                survivors.append(sig)

        active = survivors

        # Create no more than one new signal this cycle, strongest first.
        for result in ranked:
            if result["decision"] not in ("LONG", "SHORT") or not result["plan"]:
                continue
            same_active = any(s["symbol"] == result["symbol"] and s["side"] == result["decision"] for s in active)
            if same_active:
                continue

            # Retire opposite pending setup.
            active = [
                s for s in active
                if not (s["symbol"] == result["symbol"] and s["side"] != result["decision"] and s["status"] == "PENDING_ENTRY")
            ]

            p = result["plan"]
            sig = {
                "id": f'{result["symbol"]}-{result["decision"]}-{t}',
                "symbol": result["symbol"],
                "side": result["decision"],
                "signalTime": t,
                "signalYear": datetime.fromtimestamp(t / 1000, UTC).year,
                "edge": result["edge"],
                "edgeRaw": result["edgeRaw"],
                "regime": result["regime"]["name"],
                "trend": result["components"]["trend"],
                "relativeStrength": result["components"]["relativeStrength"],
                "derivatives": result["components"]["derivatives"],
                "flow": result["components"]["flow"],
                "entryZone": p["entryZone"],
                "entryMid": p["entryMid"],
                "stop": p["stop"],
                "status": "PENDING_ENTRY",
            }
            active.append(sig)
            signals.append(sig.copy())
            break

        peak_active = max(peak_active, len(active))
        if idx and idx % 20000 == 0:
            print(f"backtest progress {idx:,}/{len(timeline):,} | signals {len(signals):,} | trades {len(trades):,}", flush=True)

    return {
        "signals": signals,
        "trades": trades,
        "openAtEnd": active,
        "timelineBars": len(timeline),
        "skippedMissingBars": skipped_missing,
        "maxConcurrentSetups": peak_active,
        "feeBpsPerSide": fee_bps,
        "slippageBpsPerSide": slippage_bps,
        "riskPct": risk_pct,
    }


def max_drawdown_from_r(trades, risk_pct):
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    curve = []
    for tr in sorted(trades, key=lambda x: x["exitTime"]):
        equity *= max(0.01, 1.0 + risk_pct * tr["netR"])
        peak = max(peak, equity)
        dd = (peak - equity) / peak
        max_dd = max(max_dd, dd)
        curve.append((tr["exitTime"], equity))
    return max_dd, equity, curve


def summarize(trades, risk_pct):
    if not trades:
        return {
            "trades": 0,
            "winRate": None,
            "avgR": None,
            "medianR": None,
            "profitFactor": None,
            "maxDrawdownPct": None,
            "endingEquityMultiple": None,
            "avgGrossR": None,
            "avgCostR": None,
            "avgFundingR": None,
        }
    rs = [x["netR"] for x in trades]
    pos = sum(x for x in rs if x > 0)
    neg = -sum(x for x in rs if x < 0)
    dd, ending, _ = max_drawdown_from_r(trades, risk_pct)
    return {
        "trades": len(trades),
        "winRate": sum(1 for x in rs if x > 0) / len(rs),
        "avgR": mean(rs),
        "medianR": statistics.median(rs),
        "profitFactor": pos / neg if neg > 0 else None,
        "maxDrawdownPct": dd * 100,
        "endingEquityMultiple": ending,
        "avgGrossR": mean([x["grossR"] for x in trades]),
        "avgCostR": mean([x["costR"] for x in trades]),
        "avgFundingR": mean([x["fundingR"] for x in trades]),
    }


def grouped_summary(trades, key_fn, risk_pct):
    groups = defaultdict(list)
    for tr in trades:
        groups[str(key_fn(tr))].append(tr)
    return {k: summarize(v, risk_pct) for k, v in sorted(groups.items())}


def fmt_pct(x):
    return "n/a" if x is None else f"{100*x:.1f}%"


def fmt_num(x, d=2):
    return "n/a" if x is None else f"{x:.{d}f}"


def markdown_report(meta, result):
    trades = result["trades"]
    risk_pct = result["riskPct"]
    full = summarize(trades, risk_pct)
    is_trades = [x for x in trades if x["signalTime"] < meta["oosStartMs"]]
    oos_trades = [x for x in trades if x["signalTime"] >= meta["oosStartMs"]]
    is_s = summarize(is_trades, risk_pct)
    oos_s = summarize(oos_trades, risk_pct)

    by_symbol = grouped_summary(trades, lambda x: x["symbol"], risk_pct)
    by_regime = grouped_summary(trades, lambda x: x["regime"], risk_pct)
    by_year = grouped_summary(trades, lambda x: x["signalYear"], risk_pct)

    def row(label, s):
        return (
            f"| {label} | {s['trades']} | {fmt_pct(s['winRate'])} | "
            f"{fmt_num(s['avgR'])} | {fmt_num(s['profitFactor'])} | "
            f"{fmt_num(s['maxDrawdownPct'])}% | {fmt_num(s['endingEquityMultiple'])}x |"
        )

    lines = [
        "# Hunter Core V1 — Historical Backtest",
        "",
        f"Period: **{meta['start']} → {meta['end']} UTC**",
        f"Holdout/OOS start: **{meta['oosStart']} UTC**",
        f"Symbols: **{', '.join(SYMBOLS)}**",
        f"Signal threshold: **|Edge| ≥ {ACTION_THRESHOLD}**",
        "",
        "## Important test assumptions",
        "",
        "- V1 weights and threshold are frozen; this run does not optimize them.",
        "- Signals use only closed 15m/1h/4h candles.",
        "- Historical OI and taker flow use Binance Vision 5m metrics aggregated to 15m.",
        "- Historical basis uses Binance premiumIndexKlines close as a proxy for the live mark-vs-spot basis input.",
        "- Strict fill: the planned entry midpoint must trade after the signal.",
        "- If entry and stop occur in the same 15m candle, the test assumes the stop happened (worst case).",
        "- Exit: stop, otherwise a 24h time exit. This matches the current forward-journal evaluation horizon; it is not yet a dynamic production exit.",
        f"- Costs: **{result['feeBpsPerSide']:.1f} bps fee + {result['slippageBpsPerSide']:.1f} bps slippage per side**, plus archived funding.",
        f"- Risk used for the compounded equity illustration: **{100*risk_pct:.2f}% per triggered trade**.",
        "",
        "## Headline results",
        "",
        "| Sample | Trades | Win rate | Avg R | Profit factor | Max DD | Equity multiple |",
        "|---|---:|---:|---:|---:|---:|---:|",
        row("Full", full),
        row("Pre-holdout", is_s),
        row("Holdout/OOS", oos_s),
        "",
        f"Signals created: **{len(result['signals'])}**",
        f"Completed triggered trades: **{len(trades)}**",
        f"Setups still open at end: **{len(result['openAtEnd'])}**",
        f"Master 15m bars: **{result['timelineBars']:,}**",
        f"Bars skipped for insufficient/missing aligned data: **{result['skippedMissingBars']:,}**",
        f"Max concurrent setups: **{result['maxConcurrentSetups']}**",
        "",
        "## By symbol",
        "",
        "| Symbol | Trades | Win rate | Avg R | PF | Max DD | Equity multiple |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for k, s in by_symbol.items():
        lines.append(row(k, s))

    lines += [
        "",
        "## By market regime",
        "",
        "| Regime | Trades | Win rate | Avg R | PF | Max DD | Equity multiple |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for k, s in by_regime.items():
        lines.append(row(k, s))

    lines += [
        "",
        "## By year",
        "",
        "| Year | Trades | Win rate | Avg R | PF | Max DD | Equity multiple |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for k, s in by_year.items():
        lines.append(row(k, s))

    lines += [
        "",
        "## Cost diagnostics",
        "",
        f"- Average gross result: **{fmt_num(full['avgGrossR'])} R**",
        f"- Average fee+slippage drag: **{fmt_num(full['avgCostR'])} R**",
        f"- Average funding contribution: **{fmt_num(full['avgFundingR'])} R**",
        "",
        "## Interpretation guardrails",
        "",
        "- A positive historical result is evidence, not proof of future profitability.",
        "- If the holdout sample is weak while the earlier sample is strong, treat that as a warning for regime dependence or overfitting.",
        "- Do not tune the threshold against the holdout and then continue calling that same period OOS.",
        "- The next validation after this report is walk-forward analysis plus the live forward journal.",
        "",
        "## Data quality",
        "",
        "Official Binance Vision archives are used. The public metrics archive has documented historical gaps/duplicate timestamps; this backtester de-duplicates timestamps and reports missing files rather than silently fabricating observations.",
        "",
    ]

    return "\n".join(lines)


def self_test():
    c = []
    for i in range(60):
        p = 100 + i * 0.2
        c.append({"open": p, "high": p + 1, "low": p - 1, "close": p + 0.1, "volume": 100 + i})
    assert atr(c, 14) > 0
    assert normalized_momentum(c, 12) > 0
    assert efficiency_ratio(c, 20) > 0
    assert clamp(2) == 1
    assert clamp(-2) == -1

    sample_metrics = [
        ["create_time","symbol","sum_open_interest","sum_open_interest_value","count_toptrader_long_short_ratio","sum_toptrader_long_short_ratio","count_long_short_ratio","sum_taker_long_short_vol_ratio"],
        ["2026-01-01 00:05:00","BTCUSDT","100","0","1","1","1","2"],
        ["2026-01-01 00:10:00","BTCUSDT","101","0","1","1","1","2"],
        ["2026-01-01 00:15:00","BTCUSDT","102","0","1","1","1","2"],
    ]
    m = parse_metrics_rows(sample_metrics)
    assert len(m) == 1 and abs(m[0]["buySellRatio"] - 2) < 1e-9
    print("hunter_backtest self-test: PASS")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2022-01-01")
    ap.add_argument("--end", default="2026-08-31")
    ap.add_argument("--oos-start", default="2025-01-01")
    ap.add_argument("--workers", type=int, default=28)
    ap.add_argument("--fee-bps", type=float, default=5.0)
    ap.add_argument("--slippage-bps", type=float, default=2.0)
    ap.add_argument("--risk-pct", type=float, default=0.005)
    ap.add_argument("--out", default="backtest_output")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return

    start_d = date.fromisoformat(args.start)
    end_d = date.fromisoformat(args.end)
    oos_d = date.fromisoformat(args.oos_start)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Add a warm-up month so long-horizon features are available at the requested start.
    warm_start = start_d - timedelta(days=40)

    all_data = {}
    quality = {}
    for sym in SYMBOLS:
        d = load_symbol(sym, warm_start, end_d, args.workers)
        all_data[sym] = d
        quality[sym] = d["quality"]

    start_ms = int(datetime(start_d.year, start_d.month, start_d.day, tzinfo=UTC).timestamp() * 1000)
    end_ms = int((datetime(end_d.year, end_d.month, end_d.day, tzinfo=UTC) + timedelta(days=1)).timestamp() * 1000) - 1
    oos_ms = int(datetime(oos_d.year, oos_d.month, oos_d.day, tzinfo=UTC).timestamp() * 1000)

    result = run_backtest(
        all_data,
        start_ms,
        end_ms,
        fee_bps=args.fee_bps,
        slippage_bps=args.slippage_bps,
        risk_pct=args.risk_pct,
    )

    meta = {
        "start": args.start,
        "end": args.end,
        "oosStart": args.oos_start,
        "oosStartMs": oos_ms,
        "symbols": list(SYMBOLS),
        "actionThreshold": ACTION_THRESHOLD,
        "basisHistoricalProxy": "premiumIndexKlines close",
        "dataSource": "Binance Vision USD-M public archive",
        "quality": quality,
    }

    report = markdown_report(meta, result)
    (out_dir / "hunter_v1_backtest.md").write_text(report, encoding="utf-8")
    (out_dir / "hunter_v1_trades.json").write_text(json.dumps(result["trades"], indent=2), encoding="utf-8")

    summary = {
        "meta": meta,
        "full": summarize(result["trades"], args.risk_pct),
        "preHoldout": summarize([x for x in result["trades"] if x["signalTime"] < oos_ms], args.risk_pct),
        "holdout": summarize([x for x in result["trades"] if x["signalTime"] >= oos_ms], args.risk_pct),
        "bySymbol": grouped_summary(result["trades"], lambda x: x["symbol"], args.risk_pct),
        "byRegime": grouped_summary(result["trades"], lambda x: x["regime"], args.risk_pct),
        "byYear": grouped_summary(result["trades"], lambda x: x["signalYear"], args.risk_pct),
        "signals": len(result["signals"]),
        "completedTrades": len(result["trades"]),
        "openAtEnd": len(result["openAtEnd"]),
        "timelineBars": result["timelineBars"],
        "skippedMissingBars": result["skippedMissingBars"],
        "maxConcurrentSetups": result["maxConcurrentSetups"],
        "feeBpsPerSide": args.fee_bps,
        "slippageBpsPerSide": args.slippage_bps,
        "riskPct": args.risk_pct,
    }
    (out_dir / "hunter_v1_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("\n=== BACKTEST COMPLETE ===")
    print(json.dumps(summary, indent=2))
    print(f"\nReport: {out_dir / 'hunter_v1_backtest.md'}")


if __name__ == "__main__":
    main()
