#!/usr/bin/env python3
from __future__ import annotations
import argparse,bisect,json,math,statistics
from collections import defaultdict
from datetime import date,datetime,timedelta,timezone
from pathlib import Path
import backtest_hunter_v1 as v1

UTC=timezone.utc
SYMBOLS=v1.SYMBOLS
START=date(2022,1,1); DEV_START=date(2023,1,1); DEV_END=date(2024,12,31)
VAL_START=date(2025,1,1); VAL_END=date(2025,12,31)
TEST_START=date(2026,1,1); TEST_END=date(2026,8,31)
FEE_BPS=5.0;SLIP_BPS=2.0;RISK_PCT=.005
FEATURES=["m4","m1","m15","rs","flow","deriv","oi","funding","basis","er","volz","volratio","trend_flow","trend_rs","er_trend"]

def ms(d):return int(datetime(d.year,d.month,d.day,tzinfo=UTC).timestamp()*1000)
def end_ms(d):return ms(d+timedelta(days=1))-1

def month_start_ms(t):
    d=datetime.fromtimestamp(t/1000,UTC)
    return int(datetime(d.year,d.month,1,tzinfo=UTC).timestamp()*1000)

def months_between(start_t,end_t):
    d=datetime.fromtimestamp(start_t/1000,UTC);d=date(d.year,d.month,1)
    e=datetime.fromtimestamp(end_t/1000,UTC);e=date(e.year,e.month,1)
    out=[]
    while d<=e:
        out.append(ms(d))
        d=date(d.year+1,1,1) if d.month==12 else date(d.year,d.month+1,1)
    return out

def zlatest(vals):
    return v1.z_score_latest(vals) if len(vals)>=3 else 0

def safe_tanh(x):return math.tanh(max(-5,min(5,x)))

def sample_features(s,rs):
    c4,c1,c15=s["candles4h"],s["candles1h"],s["candles15m"]
    if len(c4)<40 or len(c1)<60 or len(c15)<80:return None
    price=c15[-1]["close"];a=v1.atr(c15,14)
    if not a:return None
    m4=v1.normalized_momentum(c4,12);m1=v1.normalized_momentum(c1,24);m15=v1.normalized_momentum(c15,16)
    trend=v1.clamp(.5*m4+.3*m1+.2*m15)
    flow=v1.flow_score(s);deriv=v1.derivatives_score(s,trend)
    oi=s["openInterestHistory"];oic=0
    if len(oi)>=5 and oi[-5]["value"]>0 and oi[-1]["value"]>0:oic=math.log(oi[-1]["value"]/oi[-5]["value"])
    fz=zlatest([x["rate"] for x in s["funding"][-30:]])
    basis=s["basis"][-1]["rate"] if s["basis"] else 0
    er=v1.efficiency_ratio(c1,20);vz=v1.volume_z(c15,30)
    vr=v1.recent_volatility(c15,8)/(v1.recent_volatility(c15,40) or 1e-12)
    x=[m4,m1,m15,rs,flow,deriv,safe_tanh(oic/.02),safe_tanh(fz/2),safe_tanh(basis/.002),
       er,safe_tanh(vz/2),max(0,min(3,vr))/3,trend*flow,trend*rs,er*trend]
    return x,price,a

def build_samples(data,start_t,end_t):
    master=data["BTCUSDT"]["candles1h"];timeline=[t for t in master.times if start_t<=t<=end_t];samples=[]
    for idx,t in enumerate(timeline):
        snaps=[]
        for sym in SYMBOLS:
            s=v1.snapshot_at(data[sym],t)
            if s is None:snaps=[];break
            snaps.append(s)
        if not snaps:continue
        rs=v1.relative_strength_scores(snaps)
        for s in snaps:
            q=sample_features(s,rs.get(s["symbol"],0))
            if not q:continue
            x,price,a=q
            fut=data[s["symbol"]]["candles15m"].latest(t+4*60*60*1000)
            if not fut or fut["availableTime"]<t+3*60*60*1000:continue
            y=max(-4,min(4,(fut["close"]-price)/a))
            samples.append(dict(symbol=s["symbol"],time=t,x=x,y=y,price=price,atr=a))
        if idx and idx%10000==0:print(f"samples {idx:,}/{len(timeline):,} -> {len(samples):,}",flush=True)
    print("sample count",len(samples),flush=True);return samples

def solve(A,b):
    n=len(b);M=[A[i][:]+[b[i]] for i in range(n)]
    for col in range(n):
        pivot=max(range(col,n),key=lambda r:abs(M[r][col]))
        if abs(M[pivot][col])<1e-10:return [0.0]*n
        M[col],M[pivot]=M[pivot],M[col]
        div=M[col][col];M[col]=[x/div for x in M[col]]
        for r in range(n):
            if r==col:continue
            f=M[r][col]
            if f:M[r]=[M[r][j]-f*M[col][j] for j in range(n+1)]
    return [M[i][-1] for i in range(n)]

def train_model(rows,lamb):
    p=len(FEATURES);means=[0]*p;stds=[1]*p
    if len(rows)<500:return None
    for j in range(p):
        vals=[r["x"][j] for r in rows];means[j]=sum(vals)/len(vals);sd=statistics.pstdev(vals);stds[j]=sd if sd>1e-8 else 1
    n=p+1;A=[[0.0]*n for _ in range(n)];b=[0.0]*n
    for r in rows:
        z=[1.0]+[(r["x"][j]-means[j])/stds[j] for j in range(p)];y=r["y"]
        for i in range(n):
            b[i]+=z[i]*y
            for j in range(i,n):A[i][j]+=z[i]*z[j]
    for i in range(n):
        for j in range(i):A[i][j]=A[j][i]
    for i in range(1,n):A[i][i]+=lamb
    w=solve(A,b)
    return dict(w=w,means=means,stds=stds)

def predict(model,x):
    z=[1.0]+[(x[j]-model["means"][j])/model["stds"][j] for j in range(len(FEATURES))]
    return sum(a*b for a,b in zip(model["w"],z))

def add_predictions(samples,train_months,lamb,eval_start,eval_end):
    by_month=defaultdict(list)
    for r in samples:by_month[month_start_ms(r["time"])].append(r)
    months=months_between(eval_start,eval_end);pred=[]
    for m in months:
        md=datetime.fromtimestamp(m/1000,UTC);start_date=date(md.year,md.month,1)
        td=start_date
        for _ in range(train_months):
            td=date(td.year-1,12,1) if td.month==1 else date(td.year,td.month-1,1)
        train_start=ms(td)
        sample_times=[r["time"] for r in samples]
        i0=bisect.bisect_left(sample_times,train_start)
        i1=bisect.bisect_left(sample_times,m-4*60*60*1000)
        train=samples[i0:i1]
        model=train_model(train,lamb)
        if not model:continue
        for r in by_month.get(m,[]):
            if eval_start<=r["time"]<=eval_end:
                rr=dict(r);rr["pred"]=predict(model,r["x"]);pred.append(rr)
        print(f"model {md.year}-{md.month:02d} train={len(train):,} eval={len(by_month.get(m,[])):,}",flush=True)
    return pred

def next15(series,t):
    i=bisect.bisect_right(series.times,t)
    return series.rows[i] if i<len(series.rows) else None

def simulate_signal(r,data,stop_atr=1.25,hold_bars=16):
    b=next15(data["candles15m"],r["time"])
    if not b:return None
    d=1 if r["pred"]>0 else -1;entry=b["open"];risk=stop_atr*r["atr"];stop=entry-d*risk
    bars=[];i=bisect.bisect_right(data["candles15m"].times,r["time"]);bars=data["candles15m"].rows[i:i+hold_bars]
    if not bars:return None
    exitp=bars[-1]["close"];exitt=bars[-1]["availableTime"];reason="4H_EXIT";mfe=0;mae=0
    for x in bars:
        fav=(x["high"]-entry)/risk if d>0 else (entry-x["low"])/risk
        adv=(x["low"]-entry)/risk if d>0 else (entry-x["high"])/risk
        mfe=max(mfe,fav);mae=min(mae,adv)
        hit=x["low"]<=stop if d>0 else x["high"]>=stop
        if hit:exitp=stop;exitt=x["availableTime"];reason="STOP";break
    gross=d*(exitp-entry)/risk
    cost=(2*(FEE_BPS+SLIP_BPS)/10000)*entry/risk
    funding=-d*v1.funding_sum(data["funding"],b["availableTime"],exitt)*entry/risk
    return dict(symbol=r["symbol"],signalTime=r["time"],entryTime=b["availableTime"],exitTime=exitt,
                year=datetime.fromtimestamp(r["time"]/1000,UTC).year,side="LONG" if d>0 else "SHORT",
                pred=r["pred"],grossR=gross,costR=cost,fundingR=funding,netR=gross-cost+funding,mfeR=mfe,maeR=mae,reason=reason)

def trades_for(preds,data,threshold):
    rows=sorted([r for r in preds if abs(r["pred"])>=threshold],key=lambda r:r["time"]);busy=defaultdict(int);out=[]
    for r in rows:
        if r["time"]<=busy[r["symbol"]]:continue
        tr=simulate_signal(r,data[r["symbol"]])
        if tr:out.append(tr);busy[r["symbol"]]=tr["exitTime"]
    return out

def summary(t):return v1.summarize(t,RISK_PCT)
def objective(t):
    s=summary(t)
    if s["trades"]<150:return -999
    by=defaultdict(list)
    for x in t:by[x["year"]].append(x["netR"])
    av=[sum(v)/len(v) for v in by.values()];worst=min(av) if av else -9;pos=sum(x>0 for x in av)/max(1,len(av))
    pf=min(s["profitFactor"] or 0,3)
    return s["avgR"]*math.sqrt(s["trades"])+.5*worst+.3*pos+.15*(pf-1)-.008*(s["maxDrawdownPct"] or 0)

def valid(t):
    s=summary(t)
    return s["trades"]>=50 and s["avgR"] is not None and s["avgR"]>.015 and s["profitFactor"] is not None and s["profitFactor"]>1.05 and (s["maxDrawdownPct"] or 99)<15

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--workers",type=int,default=28);ap.add_argument("--out",default="v4_output");args=ap.parse_args()
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True);warm=START-timedelta(days=60)
    data={};quality={}
    for sym in SYMBOLS:data[sym]=v1.load_symbol(sym,warm,TEST_END,args.workers);quality[sym]=data[sym]["quality"]
    samples=build_samples(data,ms(START),end_ms(TEST_END))
    dev_start,dev_end=ms(DEV_START),end_ms(DEV_END);val_start,val_end=ms(VAL_START),end_ms(VAL_END);test_start,test_end=ms(TEST_START),end_ms(TEST_END)
    # Build each walk-forward prediction stream once, then reuse it for threshold search,
    # validation and the final holdout. This changes runtime only, not the research protocol.
    pred_cache={}
    for tm in (6,18):
        for lam in (1.0,20.0):
            pred_cache[(tm,lam)]=add_predictions(samples,tm,lam,dev_start,test_end)

    candidates=[]
    for (tm,lam),preds in pred_cache.items():
        devpred=[r for r in preds if dev_start<=r["time"]<=dev_end]
        for th in (.20,.35,.50,.65,.80):
            tr=trades_for(devpred,data,th);score=objective(tr)
            if score>-900:candidates.append(dict(trainMonths=tm,lambda_=lam,threshold=th,dev=summary(tr),devScore=score))
    candidates.sort(key=lambda x:x["devScore"],reverse=True);top=candidates[:15]
    for c in top:
        vp=[r for r in pred_cache[(c["trainMonths"],c["lambda_"])] if val_start<=r["time"]<=val_end]
        vt=trades_for(vp,data,c["threshold"]);c["val"]=summary(vt);c["pass"]=valid(vt)
        ar=c["val"]["avgR"] if c["val"]["avgR"] is not None else -9;pf=c["val"]["profitFactor"] or 0
        c["valScore"]=ar*math.sqrt(max(1,c["val"]["trades"]))+.15*(min(pf,3)-1)
    passing=[c for c in top if c["pass"]];selected=max(passing,key=lambda x:(x["valScore"],x["devScore"])) if passing else None
    print("TOP",json.dumps(top),flush=True)
    if not selected:
        serial={"selected":None,"top":top};(out/"hunter_v4_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8");print("REJECTED V4");return
    allpred=pred_cache[(selected["trainMonths"],selected["lambda_"])]
    tp=[r for r in allpred if test_start<=r["time"]<=test_end];tt=trades_for(tp,data,selected["threshold"])
    fp=[r for r in allpred if dev_start<=r["time"]<=test_end];ft=trades_for(fp,data,selected["threshold"])
    serial={"selected":selected,"holdout":summary(tt),"fullAdaptive":summary(ft),"holdoutTrades":tt,"fullTradeCount":len(ft),"quality":quality}
    (out/"hunter_v4_results.json").write_text(json.dumps(serial,indent=2),encoding="utf-8")
    print("\n=== HUNTER V4 COMPLETE ===");print(json.dumps(serial,indent=2))

if __name__=="__main__":main()
