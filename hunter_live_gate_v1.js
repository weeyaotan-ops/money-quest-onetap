'use strict';

// Observational-only live selection gate for Money Hunter.
// It NEVER changes order placement. It only records a counterfactual PASS/WATCH/REJECT
// decision, then joins that decision to the realized live Actual-R after the trade closes.

const winQuality=require('./hunter_win_quality_v1');
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const finiteNumber=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;

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
    this.seenClosed=new Set();
    this.decisions=[];
    this.decisionById=new Map();
    this.ignoredMissingActualR=0;
  }

  ingestClosedTrade(t){
    const id=String(t?.id||'');
    const r=finiteNumber(t?.actualR);
    if(!id||r===null||this.seenClosed.has(id)) {
      if(id&&r===null&&!this.seenClosed.has(id)) this.ignoredMissingActualR++;
      return false;
    }
    const d=this.decisionById.get(id)||null;
    this.seenClosed.add(id);
    this.history.push({
      id,
      symbol:String(t.symbol||d?.symbol||'UNKNOWN'),
      side:String(t.side||d?.side||'UNKNOWN'),
      regime:String(t.regime||t.shadowStructureRegime||d?.regime||'UNKNOWN'),
      timeframe:String(t.timeframe||d?.timeframe||'UNKNOWN'),
      edge:String(t.edge||d?.edge||'UNKNOWN'),
      actualR:r,
      netPnl:finiteNumber(t.netPnl),
      closedAt:t.closedAt||new Date().toISOString(),
      gateVerdict:d?.verdict||null,
      gateScore:Number.isFinite(Number(d?.score))?Number(d.score):null,
      gateReasons:Array.isArray(d?.reasons)?d.reasons:[],
      challengerVerdict:d?.challenger?.verdict||null,
      challengerScore:Number.isFinite(Number(d?.challenger?.score))?Number(d.challenger.score):null,
      challengerReasons:Array.isArray(d?.challenger?.reasons)?d.challenger.reasons:[],
      forwardMatched:Boolean(d)&&Date.parse(d.at)<=Date.parse(t.closedAt||new Date().toISOString()),
      winQuality:d?.winQuality||null
    });
    this.history.sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt));
    if(this.history.length>5000){
      const removed=this.history.splice(0,this.history.length-5000);
      for(const x of removed)this.seenClosed.delete(x.id);
    }
    return true;
  }

  stats(xs){
    const rs=xs.map(x=>finiteNumber(x.actualR)).filter(x=>x!==null);
    const wins=rs.filter(x=>x>0),losses=rs.filter(x=>x<0);
    const grossWin=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
    let eq=0,peak=0,maxDD=0;
    for(const r of rs){eq+=r;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq)}
    return {
      n:rs.length,
      wins:wins.length,
      losses:losses.length,
      winRate:rs.length?wins.length/rs.length:0,
      expectancyR:mean(rs),
      profitFactor:grossLoss?grossWin/grossLoss:(grossWin>0?Infinity:0),
      maxDrawdownR:maxDD,
      totalR:rs.reduce((a,b)=>a+b,0)
    };
  }

  breakdown(xs,keyFn){
    const groups=new Map();
    for(const x of xs){
      const key=String(keyFn(x)||'UNKNOWN');
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(x);
    }
    return [...groups.entries()]
      .map(([key,rows])=>({key,...this.stats(rows)}))
      .sort((a,b)=>b.n-a.n||Math.abs(b.totalR)-Math.abs(a.totalR)||a.key.localeCompare(b.key));
  }


  scoreCandidate(c){
    const id=String(c?.id||'');
    if(id&&this.decisionById.has(id))return this.decisionById.get(id);
    const symbol=String(c?.symbol||'UNKNOWN');
    const side=String(c?.side||'UNKNOWN');
    const regime=String(c?.regime||c?.shadowStructureRegime||'UNKNOWN');
    const timeframe=String(c?.timeframe||'UNKNOWN');
    const edge=String(c?.edge||c?.setup||'UNKNOWN');
    const recent=this.history.slice(-this.recentWindow);
    const sym=this.history.filter(x=>x.symbol===symbol).slice(-this.symbolWindow);
    const sd=this.history.filter(x=>x.side===side).slice(-this.sideWindow);
    const rg=this.history.filter(x=>x.regime===regime&&regime!=='UNKNOWN').slice(-this.sideWindow);
    const sr=this.history.filter(x=>x.symbol===symbol&&x.side===side).slice(-this.symbolWindow);
    const tf=this.history.filter(x=>x.timeframe===timeframe&&timeframe!=='UNKNOWN').slice(-this.sideWindow);
    const ed=this.history.filter(x=>x.edge===edge&&edge!=='UNKNOWN').slice(-this.sideWindow);
    const srg=this.history.filter(x=>x.side===side&&x.regime===regime&&regime!=='UNKNOWN').slice(-this.sideWindow);
    const etf=this.history.filter(x=>x.edge===edge&&x.timeframe===timeframe&&edge!=='UNKNOWN'&&timeframe!=='UNKNOWN').slice(-this.sideWindow);
    const scopes={recent:this.stats(recent),symbol:this.stats(sym),side:this.stats(sd),regime:this.stats(rg),symbolSide:this.stats(sr),timeframe:this.stats(tf),edge:this.stats(ed),sideRegime:this.stats(srg),edgeTimeframe:this.stats(etf)};

    let score=0.5;
    const reasons=[];
    const add=(delta,reason)=>{score+=delta;reasons.push(reason)};

    if(scopes.recent.n>=this.minSamples){
      if(scopes.recent.expectancyR<this.minExpectancyR)add(-0.18,'RECENT_NEGATIVE_EXPECTANCY');
      else add(+0.10,'RECENT_POSITIVE_EXPECTANCY');
      if(scopes.recent.profitFactor<this.minProfitFactor)add(-0.10,'RECENT_LOW_PF');
      if(scopes.recent.maxDrawdownR>this.maxRecentDrawdownR)add(-0.12,'RECENT_HIGH_DRAWDOWN');
    }else reasons.push('RECENT_SAMPLE_SMALL');

    if(scopes.symbol.n>=this.minSamples){
      if(scopes.symbol.expectancyR<this.minExpectancyR)add(-0.15,'SYMBOL_NEGATIVE_EXPECTANCY');
      else add(+0.08,'SYMBOL_POSITIVE_EXPECTANCY');
    }else reasons.push('SYMBOL_SAMPLE_SMALL');

    if(scopes.symbolSide.n>=Math.max(6,Math.floor(this.minSamples/2))){
      if(scopes.symbolSide.expectancyR<this.minExpectancyR)add(-0.18,'SYMBOL_SIDE_NEGATIVE_EXPECTANCY');
      else add(+0.10,'SYMBOL_SIDE_POSITIVE_EXPECTANCY');
    }

    if(scopes.side.n>=this.minSamples){
      if(scopes.side.expectancyR<this.minExpectancyR)add(-0.08,'SIDE_NEGATIVE_EXPECTANCY');
      else add(+0.04,'SIDE_POSITIVE_EXPECTANCY');
    }

    if(scopes.regime.n>=this.minSamples){
      if(scopes.regime.expectancyR<this.minExpectancyR)add(-0.12,'REGIME_NEGATIVE_EXPECTANCY');
      else add(+0.06,'REGIME_POSITIVE_EXPECTANCY');
    }

    score=clamp(score,0,1);
    let verdict='WATCH';
    if(score>=0.62)verdict='PASS';
    else if(score<=0.38)verdict='REJECT';

    // V2 challenger is observational-only. It starts from the proven V1 score and
    // uses additional cohort evidence only after each cohort has enough samples.
    let challengerScore=score;
    const challengerReasons=[];
    const tune=(delta,reason)=>{challengerScore+=delta;challengerReasons.push(reason)};
    const halfMin=Math.max(6,Math.floor(this.minSamples/2));
    if(scopes.timeframe.n>=this.minSamples){
      if(scopes.timeframe.expectancyR<this.minExpectancyR)tune(-0.08,'V2_TIMEFRAME_NEGATIVE_EXPECTANCY');
      else tune(+0.04,'V2_TIMEFRAME_POSITIVE_EXPECTANCY');
    }
    if(scopes.edge.n>=this.minSamples){
      if(scopes.edge.expectancyR<this.minExpectancyR)tune(-0.08,'V2_EDGE_NEGATIVE_EXPECTANCY');
      else tune(+0.04,'V2_EDGE_POSITIVE_EXPECTANCY');
    }
    if(scopes.sideRegime.n>=halfMin){
      if(scopes.sideRegime.expectancyR<this.minExpectancyR)tune(-0.12,'V2_SIDE_REGIME_NEGATIVE_EXPECTANCY');
      else tune(+0.06,'V2_SIDE_REGIME_POSITIVE_EXPECTANCY');
    }
    if(scopes.edgeTimeframe.n>=halfMin){
      if(scopes.edgeTimeframe.expectancyR<this.minExpectancyR)tune(-0.10,'V2_EDGE_TIMEFRAME_NEGATIVE_EXPECTANCY');
      else tune(+0.05,'V2_EDGE_TIMEFRAME_POSITIVE_EXPECTANCY');
    }
    challengerScore=clamp(challengerScore,0,1);
    let challengerVerdict='WATCH';
    if(challengerScore>=0.62)challengerVerdict='PASS';
    else if(challengerScore<=0.38)challengerVerdict='REJECT';
    const challenger={score:challengerScore,verdict:challengerVerdict,reasons:challengerReasons,observationalOnly:true,liveExecutionChanged:false};

    const prediction=winQuality.estimate(c,this.history);
    const decision={
      id,at:new Date().toISOString(),symbol,side,regime,timeframe,edge,
      score,verdict,reasons,scopes,challenger,winQuality:prediction,
      observationalOnly:true,liveExecutionChanged:false
    };
    this.decisions.push(decision);
    if(id)this.decisionById.set(id,decision);
    if(this.decisions.length>5000){
      const removed=this.decisions.splice(0,this.decisions.length-5000);
      for(const x of removed)if(x.id&&this.decisionById.get(x.id)===x)this.decisionById.delete(x.id);
    }
    return decision;
  }

  report(){
    const all=this.stats(this.history);
    const recent=this.stats(this.history.slice(-this.recentWindow));
    const matched=this.history.filter(x=>x.forwardMatched);
    const rejected=matched.filter(x=>x.gateVerdict==='REJECT');
    const kept=matched.filter(x=>x.gateVerdict!=='REJECT');
    const passed=matched.filter(x=>x.gateVerdict==='PASS');
    const watched=matched.filter(x=>x.gateVerdict==='WATCH');
    const challengerRejected=matched.filter(x=>x.challengerVerdict==='REJECT');
    const challengerKept=matched.filter(x=>x.challengerVerdict!=='REJECT');
    const challengerPassed=matched.filter(x=>x.challengerVerdict==='PASS');
    const challengerWatched=matched.filter(x=>x.challengerVerdict==='WATCH');
    const baseline=this.stats(matched),keptStats=this.stats(kept),rejectedStats=this.stats(rejected),
      challengerKeptStats=this.stats(challengerKept),challengerRejectedStats=this.stats(challengerRejected);
    const evidenceWindow=this.history.slice(-Math.max(100,this.recentWindow));
    const evidence={
      window:evidenceWindow.length,
      side:this.breakdown(evidenceWindow,x=>x.side),
      regime:this.breakdown(evidenceWindow,x=>x.regime),
      timeframe:this.breakdown(evidenceWindow,x=>x.timeframe),
      edge:this.breakdown(evidenceWindow,x=>x.edge),
      sideRegime:this.breakdown(evidenceWindow,x=>`${x.side}|${x.regime}`),
      edgeTimeframe:this.breakdown(evidenceWindow,x=>`${x.edge}|${x.timeframe}`)
    };
    return {
      name:'HUNTER_LIVE_GATE_V1',mode:'OBSERVATIONAL_ONLY',
      dataQuality:{ignoredMissingActualR:this.ignoredMissingActualR,validClosedTrades:this.history.length},
      thresholds:{minSamples:this.minSamples,recentWindow:this.recentWindow,symbolWindow:this.symbolWindow,sideWindow:this.sideWindow,minExpectancyR:this.minExpectancyR,minProfitFactor:this.minProfitFactor,maxRecentDrawdownR:this.maxRecentDrawdownR},
      historicalBackfill:all,
      winQuality:winQuality.evaluate(this.history),
      recent,
      evidence,
      forward:{
        decisions:this.decisions.length,
        matched:matched.length,
        baseline,
        kept:keptStats,
        rejected:rejectedStats,
        pass:this.stats(passed),
        watch:this.stats(watched),
        expectancyUpliftR:baseline.n&&keptStats.n?keptStats.expectancyR-baseline.expectancyR:null,
        rejectedTotalR:rejectedStats.totalR,
        proofProgress:{minimum:100,target:150,current:matched.length},
        challengerV2:{
          mode:'OBSERVATIONAL_ONLY',
          kept:challengerKeptStats,
          rejected:challengerRejectedStats,
          pass:this.stats(challengerPassed),
          watch:this.stats(challengerWatched),
          expectancyUpliftR:baseline.n&&challengerKeptStats.n?challengerKeptStats.expectancyR-baseline.expectancyR:null,
          rejectedTotalR:challengerRejectedStats.totalR,
          proofProgress:{minimum:100,target:150,current:matched.filter(x=>x.challengerVerdict).length},
          liveExecutionChanged:false
        }
      },
      latest:this.decisions.slice(-50).reverse(),
      liveExecutionChanged:false
    };
  }
}

module.exports={HunterLiveGateV1,finiteNumber};
