#!/usr/bin/env python3
from __future__ import annotations
import argparse, bisect, itertools, json, math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import backtest_hunter_v1 as v1

UTC=timezone.utc
SYMBOLS=v1.SYMBOLS
DEV_START,DEV_END=date(2022,1,1),date(2024,12,31)
VAL_START,VAL_END=date(2025,1,1),date(2025,12,31)
TEST_START,TEST_END=date(2026,1,1),date(2026,8,31)
FEE_BPS=5.0; SLIP_BPS=2.0; RISK_PCT=.005

def ms(d): return int(datetime(d.year,d.month,d.day,tzinfo=UTC).timestamp()*1000)
def end_ms(d): return ms(d+timedelta(days=1))-1
def sign(x): return 1 if x>0 else -1 if x<0 else 0

def ema(xs,p):
    if not xs:return 0
    a=2/(p+1); y=xs[0]
    for x in xs[1:]: y=a*x+(1-a)*y
    return y

def ema_slope(xs,p,back=3):
    if len(xs)<p+back+5:return 0
    now=ema(xs[-(p*3):],p); prev=ema(xs[-(p*3+back):-back],p)
    return (now-prev)/prev if prev else 0

def funding_z(rows):
    vals=[x["rate"] for x in rows[-30:]]
    return v1.z_score_latest(vals) if len(vals)>=3 else 0

def oi_change(rows,bars=5):
    if len(rows)<bars:return 0
    a=rows[-bars]["value"]; b=rows[-1]["value"]
    return math.log(b/a) if a>0 and b>0 else 0

def load_symbol(symbol,start_d,end_d,workers):
    d=v1.load_symbol(symbol,start_d,end_d,workers)
    return d

def snap(data,t):
    s=v1.snapshot_at(data,t)
    if s is None:return None
    return s

def features(s,rs):
    c4=s["candles4h"]; c1=s["candles1h"]
    x4=[x["close"] for x in c4]; x1=[x["close"] for x in c1]
    if len(x4)<100 or len(x1)<100:return None
    close=x1[-1]
    atr1=v1.atr(c1,14)
    if not atr1:return None
    fast4=ema(x4[-100:],20); slow4=ema(x4[-160:],50)
    slope4=ema_slope(x4,20,3)
    ema1=ema(x1[-80:],20)
    er=v1.efficiency_ratio(c1,20)
    vz=v1.volume_z(c1,30)
    trendmom=v1.clamp(.6*v1.normalized_momentum(c4,12)+.4*v1.normalized_momentum(c1,24))
    flow=v1.flow_score(s); deriv=v1.derivatives_score(s,trendmom)
    fz=funding_z(s["funding"]); oic=oi_change(s["openInterestHistory"],5)
    prior={}
    for n in (12,24,48):
        hist=c1[-(n+1):-1]
        prior[n]=(max(x["high"] for x in hist),min(x["low"] for x in hist))
    last=c1[-1]
    return dict(close=close,open=last["open"],high=last["high"],low=last["low"],atr1=atr1,
                fast4=fast4,slow4=slow4,slope4=slope4,ema1=ema1,er=er,volumeZ=vz,
                trend=trendmom,rs=rs,flow=flow,deriv=deriv,fundingZ=fz,oiChange=oic,prior=prior)

def build_events(all_data,start_t,end_t):
    master=all_data["BTCUSDT"]["candles1h"]
    timeline=[t for t in master.times if start_t<=t<=end_t]; events=[]
    for idx,t in enumerate(timeline):
        snaps=[]
        for sym in SYMBOLS:
            s=snap(all_data[sym],t)
            if s is None: snaps=[]; break
            snaps.append(s)
        if not snaps:continue
        rs=v1.relative_strength_scores(snaps)
        for s in snaps:
            f=features(s,rs.get(s["symbol"],0))
            if not f:continue
            trend_dir=1 if f["close"]>f["fast4"]>f["slow4"] and f["slope4"]>0 else -1 if f["close"]<f["fast4"]<f["slow4"] and f["slope4"]<0 else 0
            if trend_dir:
                # Channel breakout events for all candidate channel lengths.
                for n,(hi,lo) in f["prior"].items():
                    if trend_dir>0 and f["close"]>hi:
                        events.append(dict(setup="CHANNEL_BREAKOUT",symbol=s["symbol"],time=t,dir=1,channel=n,level=hi,**f))
                    elif trend_dir<0 and f["close"]<lo:
                        events.append(dict(setup="CHANNEL_BREAKOUT",symbol=s["symbol"],time=t,dir=-1,channel=n,level=lo,**f))
                # EMA pullback/reclaim in higher-TF trend.
                if trend_dir>0 and f["low"]<=f["ema1"] and f["close"]>f["ema1"] and f["close"]>f["open"]:
                    events.append(dict(setup="EMA_PULLBACK",symbol=s["symbol"],time=t,dir=1,**f))
                elif trend_dir<0 and f["high"]>=f["ema1"] and f["close"]<f["ema1"] and f["close"]<f["open"]:
                    events.append(dict(setup="EMA_PULLBACK",symbol=s["symbol"],time=t,dir=-1,**f))
        if idx and idx%10000==0:print(f"event scan {idx:,}/{len(timeline):,} events={len(events):,}",flush=True)
    print("base events",len(events),flush=True);return events

def next_rows(series,t,n):
    i=bisect.bisect_right(series.times,t);return series.rows[i:i+n]

def accept(e,c):
    d=e["dir"]
    common=(e["er"]>=c["er_min"] and d*e["rs"]>=c["rs_min"] and d*e["flow"]>=c["flow_min"] and d*e["deriv"]>=c["deriv_min"] and d*e["fundingZ"]<=c["funding_cap"])
    if not common:return False
    if e["setup"]=="CHANNEL_BREAKOUT":
        return e["channel"]==c["channel"] and e["volumeZ"]>=c["volume_min"] and d*e["trend"]>=c["trend_min"]
    return abs((e["close"]-e["ema1"])/e["atr1"])<=c["reclaim_atr"] and d*e["trend"]>=c["trend_min"]

def make_entry(e,data,c):
    bars=next_rows(data["candles15m"],e["time"],4)
    if not bars:return None
    d=e["dir"]
    if e["setup"]=="CHANNEL_BREAKOUT":
        # Enter first 15m bar that still holds the broken level; avoids assuming fill at the hourly close.
        for b in bars:
            if d>0 and b["close"]>e["level"]: entrybar=b;break
            if d<0 and b["close"]<e["level"]: entrybar=b;break
        else:return None
    else:
        # Pullback confirmation: break the signal-hour high/low.
        for b in bars:
            if d>0 and b["high"]>e["high"] and b["close"]>b["open"]: entrybar=b;break
            if d<0 and b["low"]<e["low"] and b["close"]<b["open"]: entrybar=b;break
        else:return None
    entry=entrybar["close"]; risk_dist=c["stop_atr"]*e["atr1"]
    stop=entry-d*risk_dist
    return dict(entryTime=entrybar["availableTime"],entry=entry,stop=stop,risk=risk_dist,dir=d)

def simulate(e,data,c):
    x=make_entry(e,data,c)
    if not x:return None
    bars=next_rows(data["candles15m"],x["entryTime"],c["max_hold_bars"])
    if not bars:return None
    d=x["dir"]; peak=x["entry"]; trough=x["entry"]; active_stop=x["stop"]; mfe=0.;mae=0.
    exit_price=bars[-1]["close"];exit_time=bars[-1]["availableTime"];reason="TIME_EXIT"
    for b in bars:
        peak=max(peak,b["high"]);trough=min(trough,b["low"])
        fav=(b["high"]-x["entry"])/x["risk"] if d>0 else (x["entry"]-b["low"])/x["risk"]
        adv=(b["low"]-x["entry"])/x["risk"] if d>0 else (x["entry"]-b["high"])/x["risk"]
        mfe=max(mfe,fav);mae=min(mae,adv)
        # Trail activates only after 1R excursion, so winners can breathe.
        if mfe>=1:
            if d>0: active_stop=max(active_stop,peak-c["trail_atr"]*e["atr1"])
            else: active_stop=min(active_stop,trough+c["trail_atr"]*e["atr1"])
        stop_hit=b["low"]<=active_stop if d>0 else b["high"]>=active_stop
        if stop_hit:
            exit_price=active_stop;exit_time=b["availableTime"];reason="TRAIL_STOP";break
        # Optional trend failure exit on 1H-equivalent time boundaries via entry EMA reference.
        if c["ema_exit"] and ((d>0 and b["close"]<e["ema1"]-.5*e["atr1"]) or (d<0 and b["close"]>e["ema1"]+.5*e["atr1"])):
            exit_price=b["close"];exit_time=b["availableTime"];reason="TREND_FAIL";break
    gross=d*(exit_price-x["entry"])/x["risk"]
    cost=(2*(FEE_BPS+SLIP_BPS)/10000)*x["entry"]/x["risk"]
    funding=-d*v1.funding_sum(data["funding"],x["entryTime"],exit_time)*x["entry"]/x["risk"]
    quality=.35*abs(e["trend"])+.2*d*e["rs"]+.15*d*e["flow"]+.1*d*e["deriv"]+.1*max(0,e["volumeZ"]/3)+.1*max(0,e["er"])
    return dict(setup=e["setup"],symbol=e["symbol"],signalTime=e["time"],entryTime=x["entryTime"],exitTime=exit_time,
                year=datetime.fromtimestamp(e["time"]/1000,UTC).year,side="LONG" if d>0 else "SHORT",
                grossR=gross,costR=cost,fundingR=funding,netR=gross-cost+funding,mfeR=mfe,maeR=mae,reason=reason,quality=quality)

def evaluate(events,all_data,c,start_t,end_t):
    ev=[e for e in events if e["setup"]==c["setup"] and start_t<=e["time"]<=end_t and accept(e,c)]
    ev.sort(key=lambda x:x["time"]);busy=defaultdict(int);out=[]
    for e in ev:
        if e["time"]<=busy[e["symbol"]]:continue
        tr=simulate(e,all_data[e["symbol"]],c)
        if tr:out.append(tr);busy[e["symbol"]]=tr["exitTime"]
    return out

def summary(t):return v1.summarize(t,RISK_PCT)

def yearly(t):
    by=defaultdict(list)
    for x in t:by[x["year"]].append(x["netR"])
    av=[sum(v)/len(v) for v in by.values()]
    return (sum(x>0 for x in av),len(av),min(av) if av else -9)

def objective(t):
    s=summary(t)
    if s["trades"]<40:return -999
    pos,n,worst=yearly(t);cons=pos/max(1,n);pf=min(s["profitFactor"] or 0,3)
    return s["avgR"]*math.sqrt(s["trades"])+.5*worst+.35*cons+.15*(pf-1)-.01*(s["maxDrawdownPct"] or 0)

def valid(t):
    s=summary(t)
    return s["trades"]>=10 and s["avgR"] is not None and s["avgR"]>.05 and s["profitFactor"] is not None and s["profitFactor"]>1.10 and (s["maxDrawdownPct"] or 99)<12

def grids(setup):
    # Keep the search coarse on purpose. We are looking for a broad plateau, not a perfect fit.
    common=list(itertools.product([.12,.22],[-.10,.10],[-.10,0]))
    if setup=="CHANNEL_BREAKOUT":
        for channel in [12,24,48]:
            for trend_min,rs_min,flow_min in common:
                for er_min,volmin in itertools.product([.12,.22],[-.5,.2]):
                    yield dict(setup=setup,channel=channel,trend_min=trend_min,rs_min=rs_min,flow_min=flow_min,deriv_min=-.15,funding_cap=1.5,er_min=er_min,volume_min=volmin,stop_atr=1.75,trail_atr=2.5,ema_exit=False,max_hold_bars=672)
    else:
        for trend_min,rs_min,flow_min in common:
            for er_min,reclaim,stop in itertools.product([.10,.20],[.8,1.2],[1.4,1.8]):
                yield dict(setup=setup,trend_min=trend_min,rs_min=rs_min,flow_min=flow_min,deriv_min=-.15,funding_cap=1.5,er_min=er_min,reclaim_atr=reclaim,stop_atr=stop,trail_atr=2.5,ema_exit=False,max_hold_bars=672)

def research(setup,events,all_data):
    cand=[]
    for i,c in enumerate(grids(setup),1):
        dev=evaluate(events,all_data,c,ms(DEV_START),end_ms(DEV_END));score=objective(dev)
        if score>-900:cand.append(dict(cfg=c,dev=summary(dev),devScore=score))
    cand.sort(key=lambda x:x["devScore"],reverse=True);top=cand[:20]
    for x in top:
        val=evaluate(events,all_data,x["cfg"],ms(VAL_START),end_ms(VAL_END));x["val"]=summary(val);x["pass"]=valid(val)
        ar=x["val"]["avgR"] if x["val"]["avgR"] is not None else -9;pf=x["val"]["profitFactor"] or 0
        x["valScore"]=ar*math.sqrt(max(1,x["val"]["trades"]))+.2*(min(pf,3)-1)
    passing=[x for x in top if x["pass"]]
    selected=max(passing,key=lambda x:(x["valScore"],x["devScore"])) if passing else None
    print("TOP",setup,json.dumps([{"dev":x["dev"],"val":x["val"],"pass":x["pass"],"cfg":x["cfg"]} for x in top[:5]]),flush=True)
    return selected,top

def combine(lists,max_concurrent=2):
    cand=sorted([x for xs in lists for x in xs],key=lambda x:(x["entryTime"],-x["quality"]));out=[];active=[]
    for tr in cand:
        active=[a for a in active if a["exitTime"]>tr["entryTime"]]
        if any(a["symbol"]==tr["symbol"] for a in active) or len(active)>=max_concurrent:continue
        out.append(tr);active.append(tr)
    return out

def compact(c):return {k:v for k,v in c.items() if k!="max_hold_bars"}

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--workers",type=int,default=28);ap.add_argument("--out",default="v3_output");args=ap.parse_args()
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True);warm=DEV_START-timedelta(days=80)
    data={};quality={}
    for sym in SYMBOLS:data[sym]=load_symbol(sym,warm,TEST_END,args.workers);quality[sym]=data[sym]["quality"]
    events=build_events(data,ms(DEV_START),end_ms(TEST_END))
    selected={};tops={}
    for setup in ("CHANNEL_BREAKOUT","EMA_PULLBACK"):
        print("\nRESEARCH",setup,flush=True);sel,top=research(setup,events,data);selected[setup]=sel;tops[setup]=top
        print("SELECTED" if sel else "REJECTED",setup,json.dumps(None if not sel else {"cfg":compact(sel["cfg"]),"dev":sel["dev"],"val":sel["val"]}),flush=True)
    test_by={};full_by={}
    for setup,sel in selected.items():
        if not sel:continue
        test_by[setup]=evaluate(events,data,sel["cfg"],ms(TEST_START),end_ms(TEST_END))
        full_by[setup]=evaluate(events,data,sel["cfg"],ms(DEV_START),end_ms(TEST_END))
    ct=combine(list(test_by.values()));cf=combine(list(full_by.values()))
    serial={"protocol":{"development":"2022-2024","validation":"2025","holdout":"2026-01-01..2026-08-31"},
            "selected":{k:None if not v else {"cfg":compact(v["cfg"]),"dev":v["dev"],"validation":v["val"]} for k,v in selected.items()},
            "holdout":{k:summary(v) for k,v in test_by.items()},"combinedHoldout":summary(ct),"combinedFull":summary(cf),
            "holdoutTrades":ct,"fullTradeCount":len(cf),"quality":quality}
    (out/"hunter_v3_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8")
    print("\n=== HUNTER V3 COMPLETE ===");print(json.dumps(serial,indent=2))

if __name__=="__main__":main()
