#!/usr/bin/env python3
from __future__ import annotations

import argparse, bisect, itertools, json, math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import backtest_hunter_v1 as v1

UTC = timezone.utc
SYMBOLS = v1.SYMBOLS
DEV_START, DEV_END = date(2022,1,1), date(2024,12,31)
VAL_START, VAL_END = date(2025,1,1), date(2025,12,31)
TEST_START, TEST_END = date(2026,1,1), date(2026,8,31)
FEE_BPS, SLIPPAGE_BPS, RISK_PCT = 5.0, 2.0, 0.005

def ms(d): return int(datetime(d.year,d.month,d.day,tzinfo=UTC).timestamp()*1000)
def end_ms(d): return ms(d+timedelta(days=1))-1
def sign(x): return 1 if x>0 else -1 if x<0 else 0

def ema(values, period):
    if not values: return 0.0
    a=2/(period+1); out=values[0]
    for x in values[1:]: out=a*x+(1-a)*out
    return out

def load_symbol_v2(symbol,start_d,end_d,workers):
    d=v1.load_symbol(symbol,start_d,end_d,workers)
    rows,q=v1.download_many(v1.build_urls(symbol,start_d,end_d,"klines","5m"),v1.parse_kline_rows,workers)
    d["candles5m"]=v1.Series.from_rows(rows,"availableTime")
    d["quality"]["klines_5m"]=q
    print(f"{symbol} 5m: {len(rows):,} rows",flush=True)
    return d

def snapshot_at_v2(data,t):
    s=v1.snapshot_at(data,t)
    if s is None: return None
    c5=data["candles5m"].upto(t,300)
    if len(c5)<80: return None
    s["candles5m"]=c5
    return s

def vol_ratio(c15):
    return v1.recent_volatility(c15,8)/(v1.recent_volatility(c15,40) or 1e-12)

def features(snap,rs):
    c15,c1,c4=snap["candles15m"],snap["candles1h"],snap["candles4h"]
    last=c15[-1]; a=v1.atr(c15,14)
    if not a: return None
    m4=v1.normalized_momentum(c4,12); m1=v1.normalized_momentum(c1,24); m15=v1.normalized_momentum(c15,6)
    trend=v1.clamp(.55*m4+.45*m1)
    er1=v1.efficiency_ratio(c1,20)
    flow=v1.flow_score(snap); deriv=v1.derivatives_score(snap,trend)
    vz=v1.volume_z(c15,30); vr=vol_ratio(c15)
    e20=ema([x["close"] for x in c15[-40:]],20)
    prior=c15[-21:-1]; hi=max(x["high"] for x in prior); lo=min(x["low"] for x in prior)
    return dict(price=last["close"],open=last["open"],high=last["high"],low=last["low"],atr15=a,
                m4=m4,m1=m1,m15=m15,trend=trend,er1=er1,rs=rs,flow=flow,deriv=deriv,
                volumeZ=vz,volRatio=vr,ema20=e20,hi20=hi,lo20=lo,
                closeToEmaAtr=(last["close"]-e20)/a)

def build_events(all_data,start_t,end_t):
    master=all_data["BTCUSDT"]["candles15m"]
    timeline=[t for t in master.times if start_t<=t<=end_t]
    events=[]
    for idx,t in enumerate(timeline):
        snaps=[]
        for sym in SYMBOLS:
            s=snapshot_at_v2(all_data[sym],t)
            if s is None: snaps=[]; break
            snaps.append(s)
        if not snaps: continue
        rs=v1.relative_strength_scores(snaps)
        for snap in snaps:
            f=features(snap,rs.get(snap["symbol"],0.0))
            if not f: continue
            d=sign(f["trend"])
            if d and abs(f["trend"])>=.12 and f["er1"]>=.12:
                pull=d*f["m15"]; ed=d*f["closeToEmaAtr"]
                if -.55<=pull<=.25 and -.60<=ed<=.90:
                    events.append(dict(setup="TREND_PULLBACK",symbol=snap["symbol"],time=t,dir=d,**f))
            up=f["price"]>f["hi20"]; dn=f["price"]<f["lo20"]
            if (up or dn) and f["volRatio"]<=1.60 and f["volumeZ"]>=-.50:
                d=1 if up else -1
                events.append(dict(setup="BREAKOUT_EXPANSION",symbol=snap["symbol"],time=t,dir=d,
                                   level=f["hi20"] if up else f["lo20"],**f))
            swept_low=f["low"]<f["lo20"] and f["price"]>f["lo20"]
            swept_high=f["high"]>f["hi20"] and f["price"]<f["hi20"]
            if f["er1"]<=.50 and (swept_low or swept_high):
                d=1 if swept_low else -1
                extreme=f["low"] if swept_low else f["high"]
                boundary=f["lo20"] if swept_low else f["hi20"]
                events.append(dict(setup="RANGE_SWEEP",symbol=snap["symbol"],time=t,dir=d,
                                   sweepDepth=abs(extreme-boundary)/f["atr15"],**f))
        if idx and idx%20000==0:
            print(f"event scan {idx:,}/{len(timeline):,} events={len(events):,}",flush=True)
    print(f"base events: {len(events):,}",flush=True)
    return events

def next_bars(series,t,n):
    i=bisect.bisect_right(series.times,t); return series.rows[i:i+n]

def trigger_trade(e,data,cfg):
    bars=next_bars(data["candles5m"],e["time"],cfg.get("trigger_bars",3))
    if not bars: return None
    d=e["dir"]; trigger=None; prev=data["candles5m"].latest(e["time"])
    for bar in bars:
        if e["setup"]=="TREND_PULLBACK":
            if prev:
                if d>0 and bar["close"]>prev["high"] and bar["close"]>bar["open"]: trigger=bar
                if d<0 and bar["close"]<prev["low"] and bar["close"]<bar["open"]: trigger=bar
        elif e["setup"]=="BREAKOUT_EXPANSION":
            level=e["level"]; tol=cfg["retest_atr"]*e["atr15"]
            if d>0 and ((bar["low"]<=level+tol and bar["close"]>level) or bar["close"]>e["high"]): trigger=bar
            if d<0 and ((bar["high"]>=level-tol and bar["close"]<level) or bar["close"]<e["low"]): trigger=bar
        else:
            mid=(e["high"]+e["low"])/2
            if d>0 and bar["close"]>mid and bar["close"]>bar["open"]: trigger=bar
            if d<0 and bar["close"]<mid and bar["close"]<bar["open"]: trigger=bar
        if trigger: break
        prev=bar
    if not trigger: return None
    entry=trigger["close"]; a=e["atr15"]
    if e["setup"]=="TREND_PULLBACK":
        stop=min(e["low"],entry-cfg["stop_atr"]*a) if d>0 else max(e["high"],entry+cfg["stop_atr"]*a)
    elif e["setup"]=="BREAKOUT_EXPANSION":
        level=e["level"]
        stop=min(trigger["low"],level-cfg["stop_atr"]*a) if d>0 else max(trigger["high"],level+cfg["stop_atr"]*a)
    else:
        stop=e["low"]-cfg["stop_atr"]*a if d>0 else e["high"]+cfg["stop_atr"]*a
    risk=abs(entry-stop)
    if risk<=0 or risk/entry<.001 or risk/entry>.06: return None
    target=entry+d*cfg["target_r"]*risk
    return dict(entryTime=trigger["availableTime"],entry=entry,stop=stop,target=target,risk=risk,dir=d)

def simulate_trade(e,data,cfg):
    t=trigger_trade(e,data,cfg)
    if not t: return None
    bars=next_bars(data["candles5m"],t["entryTime"],cfg.get("max_hold_bars",144))
    if not bars: return None
    d=t["dir"]; mfe=0.; mae=0.; exit_price=bars[-1]["close"]; exit_time=bars[-1]["availableTime"]
    gross=d*(exit_price-t["entry"])/t["risk"]; reason="TIME_EXIT"
    for bar in bars:
        fav=(bar["high"]-t["entry"])/t["risk"] if d>0 else (t["entry"]-bar["low"])/t["risk"]
        adv=(bar["low"]-t["entry"])/t["risk"] if d>0 else (t["entry"]-bar["high"])/t["risk"]
        mfe=max(mfe,fav); mae=min(mae,adv)
        stop_hit=bar["low"]<=t["stop"] if d>0 else bar["high"]>=t["stop"]
        target_hit=bar["high"]>=t["target"] if d>0 else bar["low"]<=t["target"]
        if stop_hit:
            exit_price=t["stop"]; exit_time=bar["availableTime"]; gross=-1.; reason="STOP"; break
        if target_hit:
            exit_price=t["target"]; exit_time=bar["availableTime"]; gross=cfg["target_r"]; reason="TARGET"; break
    cost=(2*(FEE_BPS+SLIPPAGE_BPS)/10000)*t["entry"]/t["risk"]
    funding=-d*v1.funding_sum(data["funding"],t["entryTime"],exit_time)*t["entry"]/t["risk"]
    quality=.35*abs(e["trend"])+.20*d*e["rs"]+.20*d*e["flow"]+.15*d*e["deriv"]+.10*max(0,e["volumeZ"]/3)
    return dict(setup=e["setup"],symbol=e["symbol"],signalTime=e["time"],entryTime=t["entryTime"],exitTime=exit_time,
                year=datetime.fromtimestamp(e["time"]/1000,UTC).year,side="LONG" if d>0 else "SHORT",
                entry=t["entry"],stop=t["stop"],target=t["target"],grossR=gross,costR=cost,fundingR=funding,
                netR=gross-cost+funding,mfeR=mfe,maeR=mae,reason=reason,quality=quality)

def accepts(e,c):
    d=e["dir"]
    if e["setup"]=="TREND_PULLBACK":
        return abs(e["trend"])>=c["trend_min"] and e["er1"]>=c["er_min"] and d*e["rs"]>=c["rs_min"] and d*e["flow"]>=c["flow_min"] and d*e["deriv"]>=c["deriv_min"] and c["pull_min"]<=d*e["m15"]<=c["pull_max"]
    if e["setup"]=="BREAKOUT_EXPANSION":
        return d*e["trend"]>=c["trend_min"] and e["volumeZ"]>=c["volume_z_min"] and e["volRatio"]<=c["vol_ratio_max"] and d*e["flow"]>=c["flow_min"] and d*e["deriv"]>=c["deriv_min"]
    return e["er1"]<=c["er_max"] and abs(e["trend"])<=c["trend_max"] and e["sweepDepth"]>=c["sweep_min"] and d*e["rs"]>=c["rs_min"] and d*e["flow"]>=c["flow_min"]

def evaluate(events,all_data,cfg,start_t,end_t):
    chosen=[e for e in events if e["setup"]==cfg["setup"] and start_t<=e["time"]<=end_t and accepts(e,cfg)]
    chosen.sort(key=lambda e:e["time"]); trades=[]; busy=defaultdict(int)
    for e in chosen:
        if e["time"]<=busy[e["symbol"]]: continue
        tr=simulate_trade(e,all_data[e["symbol"]],cfg)
        if tr:
            trades.append(tr); busy[e["symbol"]]=tr["exitTime"]
    return trades

def summarize(trades): return v1.summarize(trades,RISK_PCT)

def yearly_consistency(trades):
    by=defaultdict(list)
    for t in trades: by[t["year"]].append(t["netR"])
    if not by: return dict(positiveYears=0,years=0,worstYearAvgR=None)
    av=[sum(v)/len(v) for v in by.values()]
    return dict(positiveYears=sum(x>0 for x in av),years=len(av),worstYearAvgR=min(av))

def objective(trades):
    s=summarize(trades)
    if s["trades"]<30: return -999
    c=yearly_consistency(trades); consistency=c["positiveYears"]/max(1,c["years"]); worst=c["worstYearAvgR"]
    pf=min(s["profitFactor"] or 0,3)
    return s["avgR"]*math.sqrt(s["trades"])+.40*worst+.25*consistency+.10*(pf-1)-.01*(s["maxDrawdownPct"] or 0)

def val_pass(trades):
    s=summarize(trades)
    return s["trades"]>=8 and s["avgR"] is not None and s["avgR"]>.05 and s["profitFactor"] is not None and s["profitFactor"]>1.10 and (s["maxDrawdownPct"] or 999)<12

def grid(setup):
    if setup=="TREND_PULLBACK":
        for a in itertools.product([.18,.24,.30],[.18,.26],[-.10,.10],[-.10,.05],[-.15,0],[1.8,2.4]):
            yield dict(setup=setup,trend_min=a[0],er_min=a[1],rs_min=a[2],flow_min=a[3],deriv_min=a[4],pull_min=-.50,pull_max=.15,stop_atr=.90,target_r=a[5],trigger_bars=3,max_hold_bars=144)
    elif setup=="BREAKOUT_EXPANSION":
        for a in itertools.product([.08,.16,.24],[.20,.70],[.80,1.10],[-.10,.05],[-.15,0],[1.8,2.4]):
            yield dict(setup=setup,trend_min=a[0],volume_z_min=a[1],vol_ratio_max=a[2],flow_min=a[3],deriv_min=a[4],retest_atr=.15,stop_atr=.45,target_r=a[5],trigger_bars=3,max_hold_bars=144)
    else:
        for a in itertools.product([.22,.32,.42],[.18,.28],[.05,.15],[-.20,0],[-.20,0],[1.4,1.8]):
            yield dict(setup=setup,er_max=a[0],trend_max=a[1],sweep_min=a[2],rs_min=a[3],flow_min=a[4],stop_atr=.15,target_r=a[5],trigger_bars=3,max_hold_bars=96)

def research_setup(setup,events,all_data):
    candidates=[]
    for cfg in grid(setup):
        dev=evaluate(events,all_data,cfg,ms(DEV_START),end_ms(DEV_END)); score=objective(dev)
        if score<=-900: continue
        candidates.append(dict(cfg=cfg,devTrades=dev,dev=summarize(dev),devScore=score,consistency=yearly_consistency(dev)))
    candidates.sort(key=lambda x:x["devScore"],reverse=True); top=candidates[:12]
    for c in top:
        val=evaluate(events,all_data,c["cfg"],ms(VAL_START),end_ms(VAL_END))
        c["valTrades"]=val; c["val"]=summarize(val); c["valPass"]=val_pass(val)
        ar=c["val"]["avgR"] if c["val"]["avgR"] is not None else -9; pf=c["val"]["profitFactor"] or 0
        c["validationScore"]=ar*math.sqrt(max(1,c["val"]["trades"]))+.15*(min(pf,3)-1)
    passing=[c for c in top if c["valPass"]]
    selected=max(passing,key=lambda x:(x["validationScore"],x["devScore"])) if passing else None
    return dict(setup=setup,searched=len(candidates),top=top,selected=selected)

def combine(trade_lists,max_concurrent=2):
    cand=sorted([t for xs in trade_lists for t in xs],key=lambda x:(x["entryTime"],-x["quality"]))
    accepted=[]; active=[]
    for tr in cand:
        active=[x for x in active if x["exitTime"]>tr["entryTime"]]
        if any(x["symbol"]==tr["symbol"] for x in active) or len(active)>=max_concurrent: continue
        accepted.append(tr); active.append(tr)
    return accepted

def compact(cfg): return {k:v for k,v in cfg.items() if k not in ("max_hold_bars","trigger_bars")}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--workers",type=int,default=28); ap.add_argument("--out",default="v2_output"); args=ap.parse_args()
    out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    warm=DEV_START-timedelta(days=40); all_data={}; quality={}
    for sym in SYMBOLS:
        all_data[sym]=load_symbol_v2(sym,warm,TEST_END,args.workers); quality[sym]=all_data[sym]["quality"]
    events=build_events(all_data,ms(DEV_START),end_ms(TEST_END))

    results={}; selected={}
    for setup in ("TREND_PULLBACK","BREAKOUT_EXPANSION","RANGE_SWEEP"):
        print(f"\n=== research {setup} ===",flush=True)
        r=research_setup(setup,events,all_data); results[setup]=r; selected[setup]=r["selected"]
        if r["selected"]:
            s=r["selected"]; print("SELECTED",setup,json.dumps(compact(s["cfg"]),sort_keys=True),flush=True); print("DEV",json.dumps(s["dev"]),flush=True); print("VAL",json.dumps(s["val"]),flush=True)
        else: print("REJECTED",setup,flush=True)

    test_by={}; full_by={}
    for setup,sel in selected.items():
        if not sel: continue
        test_by[setup]=evaluate(events,all_data,sel["cfg"],ms(TEST_START),end_ms(TEST_END))
        full_by[setup]=evaluate(events,all_data,sel["cfg"],ms(DEV_START),end_ms(TEST_END))
    combined_test=combine(list(test_by.values()),2); combined_full=combine(list(full_by.values()),2)

    serial={
        "protocol":{"development":"2022-2024","validation":"2025","holdout":"2026-01-01..2026-08-31","feeBpsPerSide":FEE_BPS,"slippageBpsPerSide":SLIPPAGE_BPS,"riskPct":RISK_PCT},
        "selected":{k:None if v is None else {"cfg":compact(v["cfg"]),"dev":v["dev"],"validation":v["val"]} for k,v in selected.items()},
        "holdout":{k:summarize(v) for k,v in test_by.items()},
        "combinedHoldout":summarize(combined_test),
        "combinedFull":summarize(combined_full),
        "holdoutTrades":combined_test,
        "fullTradeCount":len(combined_full),
        "quality":quality
    }
    (out/"hunter_v2_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8")

    lines=["# Hunter V2 Research","","Development: 2022-2024","Validation: 2025","Untouched holdout: 2026-01-01..2026-08-31",""]
    for setup in ("TREND_PULLBACK","BREAKOUT_EXPANSION","RANGE_SWEEP"):
        sel=selected[setup]; lines.append("## "+setup)
        if not sel: lines += ["REJECTED: no candidate passed 2025 validation.",""]
        else:
            lines += [f"Config: {json.dumps(compact(sel['cfg']),sort_keys=True)}",
                      f"DEV: {json.dumps(sel['dev'])}",f"VAL: {json.dumps(sel['val'])}",
                      f"2026: {json.dumps(summarize(test_by[setup]))}",""]
    lines += ["## COMBINED 2026",json.dumps(serial["combinedHoldout"],indent=2),"",
              "## COMBINED FULL PERIOD",json.dumps(serial["combinedFull"],indent=2),""]
    (out/"hunter_v2_report.md").write_text("\n".join(lines),encoding="utf-8")

    print("\n=== HUNTER V2 COMPLETE ===")
    print(json.dumps({"selected":serial["selected"],"holdout":serial["holdout"],"combinedHoldout":serial["combinedHoldout"],"combinedFull":serial["combinedFull"]},indent=2))

if __name__=="__main__": main()
