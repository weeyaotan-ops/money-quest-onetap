'use strict';

const crypto=require('node:crypto');
const {
  DEFAULT_GATES,
  enrichStats,
  evaluateChampion,
  selectPortfolio,
  classifyRegime,
  routeDecision
}=require('./champion_factory_core');

const clone=x=>JSON.parse(JSON.stringify(x));
const stable=x=>JSON.stringify(x,Object.keys(x||{}).sort());
const hash=x=>crypto.createHash('sha256').update(stable(x)).digest('hex').slice(0,16);

function tradeStats(trades=[], dd=0, balance=null){
  const rs=trades.map(t=>+t.netR).filter(Number.isFinite);
  const n=rs.length;
  const netR=rs.reduce((a,b)=>a+b,0);
  const expectancy=n?netR/n:null;
  const pos=rs.filter(x=>x>0).reduce((a,b)=>a+b,0);
  const neg=Math.abs(rs.filter(x=>x<0).reduce((a,b)=>a+b,0));
  const pf=neg?pos/neg:(pos?99:null);
  let lcb90=null;
  if(n>1){
    const sd=Math.sqrt(rs.reduce((s,x)=>s+(x-expectancy)**2,0)/(n-1));
    lcb90=expectancy-1.282*sd/Math.sqrt(n);
  }
  return enrichStats({n,netR,expectancy,pf,dd,balance,lcb90},trades);
}

class ChampionFactoryManager{
  constructor(opts={}){
    this.gates={...DEFAULT_GATES,...(opts.gates||{})};
    this.minDiscoveryClosed=opts.minDiscoveryClosed??20;
    this.maxElite=opts.maxElite??12;
    this.maxPerRole=opts.maxPerRole??3;
    this.archive=new Map();
    this.frozen=new Map();
    this.graduated=new Map();
    this.audit=[];
  }

  record(type,data={}){
    this.audit.unshift({ts:Date.now(),type,...data});
    if(this.audit.length>1000)this.audit.length=1000;
  }

  freezeGenome(brain, role='BALANCED'){
    const dna={
      wTake:[...(brain.wTake||[])],wDir:[...(brain.wDir||[])],threshold:brain.threshold,
      stopBase:brain.stopBase,stopMom:brain.stopMom,stopVol:brain.stopVol,stopSpread:brain.stopSpread,
      rrBase:brain.rrBase,rrMom:brain.rrMom,rrTrend:brain.rrTrend,rrVol:brain.rrVol,
      passiveBps:brain.passiveBps,entryTtlSec:brain.entryTtlSec,holdSec:brain.holdSec
    };
    const version=hash(dna);
    const id=`${brain.id}@${version}`;
    const item={id,brainId:brain.id,parent:brain.parent||null,role,version,dna:clone(dna),frozenAt:Date.now(),status:'FROZEN_EXAM'};
    if(!this.frozen.has(id)){
      this.frozen.set(id,item);
      this.record('FREEZE',{id,brainId:brain.id,role,version});
    }
    return this.frozen.get(id);
  }

  discoveryEvidence(brain){
    return tradeStats(brain.closedDiscovery||[],brain.discoveryDD||0,brain.discoveryBalance??null);
  }

  forwardEvidence(brain){
    return tradeStats(brain.closedHoldout||[],brain.holdoutDD||0,brain.holdoutBalance??null);
  }

  roleOf(brain){
    const t=brain.closedDiscovery||[];
    const counts={TREND:0,RANGE:0,BREAKOUT:0,HIGH_VOL:0,MIXED:0};
    for(const x of t){
      const r=x.regime||classifyRegime(x.market||{});
      counts[r]=(counts[r]||0)+1;
    }
    const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    if(!sorted[0]||!sorted[0][1])return 'BALANCED';
    const total=t.length||1;
    return sorted[0][1]/total>=0.55?sorted[0][0]:'BALANCED';
  }

  refreshElite(brains){
    const candidates=[];
    for(const brain of brains){
      const stats=this.discoveryEvidence(brain);
      if(stats.n<this.minDiscoveryClosed)continue;
      const discoveryScore=evaluateChampion({...stats,n:Math.max(stats.n,this.gates.minClosed)},this.gates).score;
      candidates.push({brain,stats,role:this.roleOf(brain),discoveryScore});
    }
    candidates.sort((a,b)=>b.discoveryScore-a.discoveryScore||b.stats.n-a.stats.n);

    const roleCount={};
    const next=new Map();
    for(const c of candidates){
      roleCount[c.role]=roleCount[c.role]||0;
      if(roleCount[c.role]>=this.maxPerRole)continue;
      if(next.size>=this.maxElite)break;
      roleCount[c.role]++;
      next.set(c.brain.id,{brainId:c.brain.id,role:c.role,score:c.discoveryScore,stats:c.stats,updatedAt:Date.now()});
      this.freezeGenome(c.brain,c.role);
    }
    this.archive=next;
    this.record('ELITE_REFRESH',{elite:[...next.keys()]});
    return [...next.values()];
  }

  evaluateFrozenAgainstBrains(brains){
    const byId=new Map(brains.map(b=>[b.id,b]));
    const results=[];
    for(const frozen of this.frozen.values()){
      const brain=byId.get(frozen.brainId);
      if(!brain)continue;
      const stats=this.forwardEvidence(brain);
      const proof=evaluateChampion(stats,this.gates);
      const rec={id:frozen.id,brainId:frozen.brainId,role:frozen.role,version:frozen.version,stats,proof};
      results.push(rec);
      if(proof.eligible){
        const prev=this.graduated.get(frozen.id);
        this.graduated.set(frozen.id,{...frozen,status:'CHAMPION',stats,proof,graduatedAt:prev?.graduatedAt||Date.now(),lastVerifiedAt:Date.now()});
        if(!prev)this.record('GRADUATE',{id:frozen.id,brainId:frozen.brainId,role:frozen.role,score:proof.score});
      }else if(this.graduated.has(frozen.id)){
        this.graduated.delete(frozen.id);
        this.record('DETHRONE',{id:frozen.id,brainId:frozen.brainId,reasons:proof.reasons});
      }
    }
    return results.sort((a,b)=>Number(b.proof.eligible)-Number(a.proof.eligible)||b.proof.score-a.proof.score);
  }

  portfolio(){
    return selectPortfolio([...this.graduated.values()].map(x=>({id:x.id,role:x.role,stats:x.stats,proof:x.proof,brainId:x.brainId,version:x.version})));
  }

  route(market){
    return routeDecision({market,portfolio:this.portfolio()});
  }

  protectedBrainIds(){
    return new Set([...this.archive.keys(),...[...this.graduated.values()].map(x=>x.brainId)]);
  }

  pruneOrder(brains, discoveryRank=[]){
    const protectedIds=this.protectedBrainIds();
    const rankPos=new Map(discoveryRank.map((x,i)=>[x.id,i]));
    return [...brains]
      .filter(b=>!protectedIds.has(b.id) && !(b.open?.size))
      .sort((a,b)=>(rankPos.get(b.id)??1e9)-(rankPos.get(a.id)??1e9));
  }

  snapshot(){
    return {
      architecture:'MASTER_BRAIN_CHAMPION_FACTORY_V1',
      realMoney:false,
      gates:this.gates,
      elite:[...this.archive.values()],
      frozen:[...this.frozen.values()],
      champions:[...this.graduated.values()],
      portfolio:this.portfolio(),
      audit:this.audit.slice(0,100)
    };
  }
}

module.exports={ChampionFactoryManager,tradeStats};
