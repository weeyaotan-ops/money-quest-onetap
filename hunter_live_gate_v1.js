'use strict';

// Observational-only live selection gate for Money Hunter.
// This module MUST NOT change live order placement. It only scores/reports
// whether a live candidate would have been accepted or rejected.

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;

class HunterLiveGateV1 {
  constructor(opts={}) {
    this.minSamples=Number(opts.minSamples||12);
    this.recentWindow=Number(opts.recentWindow||30);
    this.symbolWindow=Number(opts.symbolWindow||20);
    this.sideWindow=Number(opts.sideWindow||40);
    this.minExpectancyR=Number(opts.minExpectancyR??0);
    this.minProfitFactor=Number(opts.minProfitFactor??0.9);
    this.maxRecentDrawdownR=Number(opts.maxRecentDrawdownR??6);
    this.history=[];
    this.decisions=[];
  }

  ingestClosedTrade(t){
    const r=Number(t?.actualR);
    if(!Number.isFinite(r)) return false;
    this.history.push({
      id:String(t.id||''),symbol:String(t.symbol||'UNKNOWN'),side:String(t.side||'UNKNOWN'),
      regime:String(t.regime||t.shadowStructureRegime||'UNKNOWN'),actualR:r,
      netPnl:Number(t.netPnl),closedAt:t.closedAt||new Date().toISOString()
    });
    if(this.history.length>5000)this.history.splice(0,this.history.length-5000);
    return true;
  }

  stats(xs){
    const rs=xs.map(x=>Number(x.actualR)).filter(Number.isFinite);
    const wins=rs.filter(x=>x>0), losses=rs.filter(x=>x<0);
    const grossWin=wins.reduce((a,b)=>a+b,0), grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
    let eq=0,peak=0,maxDD=0;
    for(const r of rs){eq+=r;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq)}
    return {
      n:rs.length,
      winRate:rs.length?wins.length/rs.length:0,
      expectancyR:mean(rs),
      profitFactor:grossLoss?grossWin/grossLoss:(grossWin>0?Infinity:0),
      maxDrawdownR:maxDD,
      totalR:rs.reduce((a,b)=>a+b,0)
    };
  }

  scoreCandidate(c){
    const symbol=String(c?.symbol||'UNKNOWN'), side=String(c?.side||'UNKNOWN'), regime=String(c?.regime||c?.shadowStructureRegime||'UNKNOWN');
    const recent=this.history.slice(-this.recentWindow);
    const sym=this.history.filter(x=>x.symbol===symbol).slice(-this.symbolWindow);
    const sd=this.history.filter(x=>x.side===side).slice(-this.sideWindow);
    const rg=this.history.filter(x=>x.regime===regime).slice(-this.sideWindow);
    const sr=this.history.filter(x=>x.symbol===symbol&&x.side===side).slice(-this.symbolWindow);
    const scopes={recent:this.stats(recent),symbol:this.stats(sym),side:this.stats(sd),regime:this.stats(rg),symbolSide:this.stats(sr)};

    let score=0.5;
    const reasons=[];
    const add=(delta,reason)=>{score+=delta;reasons.push(reason)};

    if(scopes.recent.n>=this.minSamples){
      if(scopes.recent.expectancyR<0)add(-0.18,'RECENT_NEGATIVE_EXPECTANCY');
      else add(+0.10,'RECENT_POSITIVE_EXPECTANCY');
      if(scopes.recent.profitFactor<this.minProfitFactor)add(-0.10,'RECENT_LOW_PF');
      if(scopes.recent.maxDrawdownR>this.maxRecentDrawdownR)add(-0.12,'RECENT_HIGH_DRAWDOWN');
    } else reasons.push('RECENT_SAMPLE_SMALL');

    if(scopes.symbol.n>=this.minSamples){
      if(scopes.symbol.expectancyR<0)add(-0.15,'SYMBOL_NEGATIVE_EXPECTANCY');
      else add(+0.08,'SYMBOL_POSITIVE_EXPECTANCY');
    } else reasons.push('SYMBOL_SAMPLE_SMALL');

    if(scopes.symbolSide.n>=Math.max(6,Math.floor(this.minSamples/2))){
      if(scopes.symbolSide.expectancyR<0)add(-0.18,'SYMBOL_SIDE_NEGATIVE_EXPECTANCY');
      else add(+0.10,'SYMBOL_SIDE_POSITIVE_EXPECTANCY');
    }

    if(scopes.side.n>=this.minSamples){
      if(scopes.side.expectancyR<0)add(-0.08,'SIDE_NEGATIVE_EXPECTANCY');
      else add(+0.04,'SIDE_POSITIVE_EXPECTANCY');
    }

    if(scopes.regime.n>=this.minSamples){
      if(scopes.regime.expectancyR<0)add(-0.12,'REGIME_NEGATIVE_EXPECTANCY');
      else add(+0.06,'REGIME_POSITIVE_EXPECTANCY');
    }

    score=clamp(score,0,1);
    let verdict='WATCH';
    if(score>=0.62)verdict='PASS';
    else if(score<=0.38)verdict='REJECT';

    // Fail-safe: observational only. Never mutate or block candidate execution.
    const decision={
      at:new Date().toISOString(),symbol,side,regime,score,verdict,reasons,scopes,
      observationalOnly:true,liveExecutionChanged:false
    };
    this.decisions.push(decision);
    if(this.decisions.length>2000)this.decisions.splice(0,this.decisions.length-2000);
    return decision;
  }

  report(){
    const all=this.stats(this.history);
    const recent=this.stats(this.history.slice(-this.recentWindow));
    const rejected=this.decisions.filter(x=>x.verdict==='REJECT');
    const passed=this.decisions.filter(x=>x.verdict==='PASS');
    return {
      name:'HUNTER_LIVE_GATE_V1',mode:'OBSERVATIONAL_ONLY',
      thresholds:{minSamples:this.minSamples,recentWindow:this.recentWindow,symbolWindow:this.symbolWindow,sideWindow:this.sideWindow,minExpectancyR:this.minExpectancyR,minProfitFactor:this.minProfitFactor,maxRecentDrawdownR:this.maxRecentDrawdownR},
      all,recent,
      decisions:this.decisions.length,
      pass:passed.length,reject:rejected.length,watch:this.decisions.length-passed.length-rejected.length,
      latest:this.decisions.slice(-50).reverse()
    };
  }
}

module.exports={HunterLiveGateV1};
