'use strict';

// Observational-only live selection gate for Money Hunter.
// It NEVER changes order placement. It only records a counterfactual PASS/WATCH/REJECT
// decision, then joins that decision to the realized live Actual-R after the trade closes.

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
    this.negativeExpectancyR=Number(opts.negativeExpectancyR??-0.15);
    this.positiveExpectancyR=Number(opts.positiveExpectancyR??0.15);
    this.policyVersion=String(opts.policyVersion||'V1_1_NEUTRAL_BAND');
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
      gatePolicyVersion:d?.policyVersion||'V1_LEGACY',
      forwardMatched:Boolean(d)
    });
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

    let score=0.5,negativeSignals=0,positiveSignals=0;
    const reasons=[];
    const add=(delta,reason,kind=null)=>{
      score+=delta;reasons.push(reason);
      if(kind==='NEG')negativeSignals++;
      if(kind==='POS')positiveSignals++;
    };
    const expectancy=(s,negDelta,posDelta,prefix)=>{
      if(s.expectancyR<=this.negativeExpectancyR)add(negDelta,prefix+'_NEGATIVE_EXPECTANCY','NEG');
      else if(s.expectancyR>=this.positiveExpectancyR)add(posDelta,prefix+'_POSITIVE_EXPECTANCY','POS');
      else reasons.push(prefix+'_EXPECTANCY_NEUTRAL');
    };

    if(scopes.recent.n>=this.minSamples){
      expectancy(scopes.recent,-0.18,+0.10,'RECENT');
      if(scopes.recent.profitFactor<this.minProfitFactor)add(-0.10,'RECENT_LOW_PF','NEG');
      if(scopes.recent.maxDrawdownR>this.maxRecentDrawdownR)add(-0.12,'RECENT_HIGH_DRAWDOWN','NEG');
    }else reasons.push('RECENT_SAMPLE_SMALL');

    if(scopes.symbol.n>=this.minSamples)expectancy(scopes.symbol,-0.15,+0.08,'SYMBOL');
    else reasons.push('SYMBOL_SAMPLE_SMALL');

    if(scopes.symbolSide.n>=Math.max(6,Math.floor(this.minSamples/2)))expectancy(scopes.symbolSide,-0.18,+0.10,'SYMBOL_SIDE');

    if(scopes.side.n>=this.minSamples)expectancy(scopes.side,-0.08,+0.04,'SIDE');

    if(scopes.regime.n>=this.minSamples)expectancy(scopes.regime,-0.12,+0.06,'REGIME');

    score=clamp(score,0,1);
    let verdict='WATCH';
    if(score>=0.62&&positiveSignals>=2)verdict='PASS';
    else if(score<=0.38&&negativeSignals>=2)verdict='REJECT';

    const decision={
      id,at:new Date().toISOString(),symbol,side,regime,timeframe,edge,
      score,verdict,reasons,scopes,negativeSignals,positiveSignals,policyVersion:this.policyVersion,
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
    const baseline=this.stats(matched),keptStats=this.stats(kept),rejectedStats=this.stats(rejected);
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
      policyVersion:this.policyVersion,
      thresholds:{minSamples:this.minSamples,recentWindow:this.recentWindow,symbolWindow:this.symbolWindow,sideWindow:this.sideWindow,minExpectancyR:this.minExpectancyR,negativeExpectancyR:this.negativeExpectancyR,positiveExpectancyR:this.positiveExpectancyR,minProfitFactor:this.minProfitFactor,maxRecentDrawdownR:this.maxRecentDrawdownR},
      historicalBackfill:all,
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
        byPolicyVersion:this.breakdown(matched,x=>x.gatePolicyVersion||'V1_LEGACY')
      },
      latest:this.decisions.slice(-50).reverse(),
      liveExecutionChanged:false
    };
  }
}

module.exports={HunterLiveGateV1,finiteNumber};
