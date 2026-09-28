#!/usr/bin/env python3
from __future__ import annotations
import argparse,bisect,itertools,json,math,statistics
from collections import defaultdict
from datetime import date,datetime,timedelta,timezone
from pathlib import Path
import backtest_hunter_v1 as v1

UTC=timezone.utc
SYMBOLS=v1.SYMBOLS
DEV_START,DEV_END=date(2022,1,1),date(2024,12,31)
VAL_START,VAL_END=date(2025,1,1),date(2025,12,31)
TEST_START,TEST_END=date(2026,1,1),date(2026,8,31)
FEE_BPS=5.;SLIP_BPS=2.;RISK_PCT=.005

def ms(d):return int(datetime(d.year,d.month,d.day,tzinfo=UTC).timestamp()*1000)
def end_ms(d):return ms(d+timedelta(days=1))-1
def ema(xs,p):
    if not xs:return 0
    a=2/(p+1);y=xs[0]
    for x in xs[1:]:y=a*x+(1-a)*y
    return y

def zscore(vals):
    if len(vals)<5:return 0
    m=sum(vals)/len(vals);sd=statistics.pstdev(vals)
    return (vals[-1]-m)/sd if sd>1e-12 else 0

def funding_z(rows):
    vals=[x["rate"] for x in rows[-30:]]
    return v1.z_score_latest(vals) if len(vals)>=3 else 0

def features(s,rs):
    c1,c4=s["candles1h"],s["candles4h"]
    if len(c1)<80 or len(c4)<80:return None
    closes1=[x["close"] for x in c1];closes4=[x["close"] for x in c4]
    last=c1[-1];a1=v1.atr(c1,14);a4=v1.atr(c4,14)
    if not a1 or not a4:return None
    mean20=ema(closes1[-60:],20)
    z=zscore(closes1[-20:])
    er4=v1.efficiency_ratio(c4,20)
    fast4=ema(closes4[-80:],20);slow4=ema(closes4[-120:],50)
    gap=abs(fast4-slow4)/a4
    trend=v1.clamp(.6*v1.normalized_momentum(c4,12)+.4*v1.normalized_momentum(c1,24))
    flow=v1.flow_score(s);deriv=v1.derivatives_score(s,trend);fz=funding_z(s["funding"])
    return dict(close=last["close"],open=last["open"],high=last["high"],low=last["low"],atr1=a1,
                mean20=mean20,z=z,er4=er4,gap4=gap,trend=trend,flow=flow,deriv=deriv,fundingZ=fz,rs=rs)

def build_events(data,start_t,end_t):
    timeline=[t for t in data["BTCUSDT"]["candles1h"].times if start_t<=t<=end_t];events=[]
    for idx,t in enumerate(timeline):
        snaps=[]
        for sym in SYMBOLS:
            s=v1.snapshot_at(data[sym],t)
            if s is None:snaps=[];break
            snaps.append(s)
        if not snaps:continue
        rs=v1.relative_strength_scores(snaps)
        for s in snaps:
            f=features(s,rs.get(s["symbol"],0))
            if not f:continue
            if f["z"]<=-1.0:
                events.append(dict(symbol=s["symbol"],time=t,dir=1,**f))
            elif f["z"]>=1.0:
                events.append(dict(symbol=s["symbol"],time=t,dir=-1,**f))
        if idx and idx%10000==0:print(f"event scan {idx:,}/{len(timeline):,} events={len(events):,}",flush=True)
    print("base events",len(events),flush=True);return events

def accept(e,c):
    d=e["dir"]
    return (abs(e["z"])>=c["zmin"] and e["er4"]<=c["ermax"] and e["gap4"]<=c["gapmax"]
            and d*e["trend"]<=c["trend_against_max"]
            and (not c["flow_contra"] or d*e["flow"]<=0)
            and d*e["fundingZ"]<=c["funding_contra_max"])

def next_rows(series,t,n):
    i=bisect.bisect_right(series.times,t);return series.rows[i:i+n]

def simulate(e,data,c):
    bars=next_rows(data["candles15m"],e["time"],4)
    if not bars:return None
    d=e["dir"];trigger=None;prev=data["candles15m"].latest(e["time"])
    for b in bars:
        if prev:
            if d>0 and b["close"]>prev["high"] and b["close"]>b["open"]:trigger=b
            if d<0 and b["close"]<prev["low"] and b["close"]<b["open"]:trigger=b
        if trigger:break
        prev=b
    if not trigger:return None
    entry=trigger["close"];stop=entry-d*c["stop_atr"]*e["atr1"];risk=abs(entry-stop)
    target=e["mean20"]
    target_r=d*(target-entry)/risk
    if target_r<c["min_target_r"] or target_r>4:return None
    hold=96
    path=next_rows(data["candles15m"],trigger["availableTime"],hold)
    if not path:return None
    exitp=path[-1]["close"];exitt=path[-1]["availableTime"];reason="TIME";mfe=0.;mae=0.
    for b in path:
        fav=(b["high"]-entry)/risk if d>0 else (entry-b["low"])/risk
        adv=(b["low"]-entry)/risk if d>0 else (entry-b["high"])/risk
        mfe=max(mfe,fav);mae=min(mae,adv)
        stophit=b["low"]<=stop if d>0 else b["high"]>=stop
        targethit=b["high"]>=target if d>0 else b["low"]<=target
        if stophit:
            exitp=stop;exitt=b["availableTime"];reason="STOP";break
        if targethit:
            exitp=target;exitt=b["availableTime"];reason="MEAN_TARGET";break
    gross=d*(exitp-entry)/risk
    cost=(2*(FEE_BPS+SLIP_BPS)/10000)*entry/risk
    funding=-d*v1.funding_sum(data["funding"],trigger["availableTime"],exitt)*entry/risk
    return dict(symbol=e["symbol"],signalTime=e["time"],entryTime=trigger["availableTime"],exitTime=exitt,
                year=datetime.fromtimestamp(e["time"]/1000,UTC).year,side="LONG" if d>0 else "SHORT",
                grossR=gross,costR=cost,fundingR=funding,netR=gross-cost+funding,mfeR=mfe,maeR=mae,reason=reason)

def evaluate(events,data,c,start_t,end_t):
    ev=[e for e in events if start_t<=e["time"]<=end_t and accept(e,c)]
    ev.sort(key=lambda x:x["time"]);busy=defaultdict(int);out=[]
    for e in ev:
        if e["time"]<=busy[e["symbol"]]:continue
        tr=simulate(e,data[e["symbol"]],c)
        if tr:out.append(tr);busy[e["symbol"]]=tr["exitTime"]
    return out

def summary(t):return v1.summarize(t,RISK_PCT)
def objective(t):
    s=summary(t)
    if s["trades"]<60:return -999
    by=defaultdict(list)
    for x in t:by[x["year"]].append(x["netR"])
    av=[sum(v)/len(v) for v in by.values()];worst=min(av) if av else -9;cons=sum(x>0 for x in av)/max(1,len(av));pf=min(s["profitFactor"] or 0,3)
    return s["avgR"]*math.sqrt(s["trades"])+.5*worst+.3*cons+.15*(pf-1)-.01*(s["maxDrawdownPct"] or 0)

def valid(t):
    s=summary(t)
    return s["trades"]>=15 and s["avgR"] is not None and s["avgR"]>.03 and s["profitFactor"] is not None and s["profitFactor"]>1.08 and (s["maxDrawdownPct"] or 99)<12

def grid():
    for zmin,ermax,gapmax,trendmax,flowc,fcap,stop,mintr in itertools.product(
        [1.25,1.5,1.75,2.0],[.18,.28,.38],[.6,1.0,1.5],[.10,.25],[False,True],[-.25,.25],[1.5,2.0],[.5,.8]):
        yield dict(zmin=zmin,ermax=ermax,gapmax=gapmax,trend_against_max=trendmax,flow_contra=flowc,
                   funding_contra_max=fcap,stop_atr=stop,min_target_r=mintr)

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--workers",type=int,default=28);ap.add_argument("--out",default="v5_output");args=ap.parse_args()
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True);warm=DEV_START-timedelta(days=80)
    data={};quality={}
    for sym in SYMBOLS:data[sym]=v1.load_symbol(sym,warm,TEST_END,args.workers);quality[sym]=data[sym]["quality"]
    events=build_events(data,ms(DEV_START),end_ms(TEST_END))
    cand=[]
    for c in grid():
        dev=evaluate(events,data,c,ms(DEV_START),end_ms(DEV_END));score=objective(dev)
        if score>-900:cand.append(dict(cfg=c,dev=summary(dev),devScore=score))
    cand.sort(key=lambda x:x["devScore"],reverse=True);top=cand[:20]
    for x in top:
        val=evaluate(events,data,x["cfg"],ms(VAL_START),end_ms(VAL_END));x["val"]=summary(val);x["pass"]=valid(val)
        ar=x["val"]["avgR"] if x["val"]["avgR"] is not None else -9;pf=x["val"]["profitFactor"] or 0
        x["valScore"]=ar*math.sqrt(max(1,x["val"]["trades"]))+.15*(min(pf,3)-1)
    passing=[x for x in top if x["pass"]];sel=max(passing,key=lambda x:(x["valScore"],x["devScore"])) if passing else None
    print("TOP",json.dumps(top),flush=True)
    if not sel:
        serial={"selected":None,"top":top};(out/"hunter_v5_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8");print("REJECTED V5");return
    test=evaluate(events,data,sel["cfg"],ms(TEST_START),end_ms(TEST_END));full=evaluate(events,data,sel["cfg"],ms(DEV_START),end_ms(TEST_END))
    serial={"selected":sel,"holdout":summary(test),"full":summary(full),"holdoutTrades":test,"quality":quality}
    (out/"hunter_v5_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8")
    print("\n=== HUNTER V5 COMPLETE ===");print(json.dumps(serial,indent=2))

if __name__=="__main__":main()
