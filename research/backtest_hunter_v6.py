#!/usr/bin/env python3
from __future__ import annotations
import argparse,bisect,itertools,json,math,statistics
from datetime import date,datetime,timedelta,timezone
from pathlib import Path
import backtest_hunter_v1 as v1

UTC=timezone.utc
SYMBOLS=v1.SYMBOLS
DEV_START,DEV_END=date(2022,1,1),date(2024,12,31)
VAL_START,VAL_END=date(2025,1,1),date(2025,12,31)
TEST_START,TEST_END=date(2026,1,1),date(2026,8,31)
COST_BPS=7.0

def ms(d):return int(datetime(d.year,d.month,d.day,tzinfo=UTC).timestamp()*1000)
def end_ms(d):return ms(d+timedelta(days=1))-1

def closes_up_to(series,t,n):
    rows=series.upto(t,n)
    return [r["close"] for r in rows]

def rr(xs,lookback):
    if len(xs)<=lookback:return None
    r=math.log(xs[-1]/xs[-1-lookback])
    rets=[math.log(xs[i]/xs[i-1]) for i in range(1,len(xs))]
    sd=statistics.pstdev(rets[-lookback:]) if len(rets)>=lookback else 0
    return r/(sd*math.sqrt(lookback)) if sd>1e-12 else 0

def price_at(series,t):
    r=series.latest(t);return r["close"] if r else None

def funding_sum(series,start,end):
    return v1.funding_sum(series,start,end)

def score_at(data,t,cfg):
    raw={}
    for sym in SYMBOLS:
        xs=closes_up_to(data[sym]["candles1h"],t,max(cfg["lb1"],cfg["lb2"])+2)
        if len(xs)<=max(cfg["lb1"],cfg["lb2"]):return None
        a=rr(xs,cfg["lb1"]);b=rr(xs,cfg["lb2"])
        raw[sym]=cfg["w"]*a+(1-cfg["w"])*b
    vals=list(raw.values());m=sum(vals)/len(vals);sd=statistics.pstdev(vals)
    z={k:(v-m)/sd if sd>1e-12 else 0 for k,v in raw.items()}
    ranked=sorted(z.items(),key=lambda kv:kv[1])
    weak,wz=ranked[0];strong,sz=ranked[-1]
    spread=sz-wz
    return dict(long=strong,short=weak,longScore=sz,shortScore=wz,spread=spread)

def decision_times(data,start_t,end_t,step_h):
    rows=data["BTCUSDT"]["candles1h"].rows
    out=[]
    for r in rows:
        t=r["availableTime"]
        if start_t<=t<=end_t:
            d=datetime.fromtimestamp(t/1000,UTC)
            if d.hour%step_h==0:out.append(t)
    return out

def run(data,cfg,start_t,end_t):
    times=decision_times(data,start_t,end_t,cfg["rebalance_h"])
    equity=1.0;peak=1.0;maxdd=0.;rets=[];switches=0;active=None;last_switch=0
    records=[]
    for i,t in enumerate(times[:-1]):
        nt=times[i+1]
        sc=score_at(data,t,cfg)
        if not sc:continue
        desired=None
        if sc["spread"]>=cfg["spread_min"]:
            desired=(sc["long"],sc["short"])
        if active is not None and desired is not None and active!=desired and t-last_switch<cfg["min_hold_h"]*3600*1000:
            desired=active
        if active is not None and t-last_switch>=cfg["max_hold_h"]*3600*1000:
            active=None
        turnover=0.0
        if desired!=active:
            if active is None and desired is not None:turnover=1.0
            elif active is not None and desired is None:turnover=1.0
            elif active is not None and desired is not None:turnover=2.0 if set(active).isdisjoint(set(desired)) else 1.0
            active=desired;last_switch=t;switches+=1 if desired is not None else 0
        period_ret=0.0
        if active:
            lo,sh=active
            p0l=price_at(data[lo]["candles1h"],t);p1l=price_at(data[lo]["candles1h"],nt)
            p0s=price_at(data[sh]["candles1h"],t);p1s=price_at(data[sh]["candles1h"],nt)
            if p0l and p1l and p0s and p1s:
                longret=p1l/p0l-1
                shortret=-(p1s/p0s-1)
                # Equal-dollar legs, 1.0x gross exposure total.
                period_ret=.5*longret+.5*shortret
                # Perp funding: long pays positive funding; short receives positive funding.
                fl=funding_sum(data[lo]["funding"],t,nt)
                fs=funding_sum(data[sh]["funding"],t,nt)
                period_ret+=.5*(-fl)+.5*(fs)
        period_ret-=turnover*COST_BPS/10000
        equity*=max(.01,1+period_ret);peak=max(peak,equity);maxdd=max(maxdd,(peak-equity)/peak)
        rets.append(period_ret)
        records.append(dict(time=t,equity=equity,periodReturn=period_ret,active=active,spread=sc["spread"]))
    if not rets:return dict(periods=0,switches=0,totalReturn=None,annualized=None,sharpe=None,maxDrawdownPct=None,equity=1)
    years=max((end_t-start_t)/(365.25*24*3600*1000),.1)
    ann=equity**(1/years)-1
    mean=sum(rets)/len(rets);sd=statistics.pstdev(rets)
    periods_per_year=365.25*24/cfg["rebalance_h"]
    sharpe=(mean/sd)*math.sqrt(periods_per_year) if sd>1e-12 else 0
    return dict(periods=len(rets),switches=switches,totalReturn=equity-1,annualized=ann,sharpe=sharpe,maxDrawdownPct=maxdd*100,equity=equity,records=records)

def objective(s):
    if s["switches"]<60:return -999
    return 2*s["annualized"]+.35*s["sharpe"]-.03*s["maxDrawdownPct"]

def valid(s):
    return s["switches"]>=15 and s["totalReturn"]>0 and s["sharpe"]>.35 and s["maxDrawdownPct"]<15

def grid():
    for lb1,lb2,w,spread,reb,minh,maxh in itertools.product(
        [12,24,48],[72,120,168],[.4,.6,.8],[1.0,1.5,2.0],[4,8],[4,8],[24,48]):
        if lb1>=lb2:continue
        yield dict(lb1=lb1,lb2=lb2,w=w,spread_min=spread,rebalance_h=reb,min_hold_h=minh,max_hold_h=maxh)

def clean(s):
    return {k:v for k,v in s.items() if k!="records"}

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--workers",type=int,default=28);ap.add_argument("--out",default="v6_output");args=ap.parse_args()
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True);warm=DEV_START-timedelta(days=30)
    data={};quality={}
    for sym in SYMBOLS:data[sym]=v1.load_symbol(sym,warm,TEST_END,args.workers);quality[sym]=data[sym]["quality"]
    cand=[]
    for c in grid():
        s=run(data,c,ms(DEV_START),end_ms(DEV_END));score=objective(s)
        if score>-900:cand.append(dict(cfg=c,dev=clean(s),devScore=score))
    cand.sort(key=lambda x:x["devScore"],reverse=True);top=cand[:20]
    for x in top:
        v=run(data,x["cfg"],ms(VAL_START),end_ms(VAL_END));x["val"]=clean(v);x["pass"]=valid(v)
        x["valScore"]=2*(v["annualized"] or -9)+.35*(v["sharpe"] or -9)-.03*(v["maxDrawdownPct"] or 99)
    passing=[x for x in top if x["pass"]];sel=max(passing,key=lambda x:(x["valScore"],x["devScore"])) if passing else None
    print("TOP",json.dumps(top),flush=True)
    if not sel:
        serial={"selected":None,"top":top};(out/"hunter_v6_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8");print("REJECTED V6");return
    test=run(data,sel["cfg"],ms(TEST_START),end_ms(TEST_END));full=run(data,sel["cfg"],ms(DEV_START),end_ms(TEST_END))
    serial={"selected":sel,"holdout":clean(test),"full":clean(full),"quality":quality}
    (out/"hunter_v6_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8")
    print("\n=== HUNTER V6 COMPLETE ===");print(json.dumps(serial,indent=2))

if __name__=="__main__":main()
