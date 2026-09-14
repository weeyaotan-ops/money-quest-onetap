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
    this.maxFrozen=opts.maxFrozen??this.maxElite;
    this.archive=new Map();
    this.frozen=new Map();
    this.graduated=new Map();
    this.failed=new Map();
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

    if(this.frozen.has(id))return this.frozen.get(id);
    if(this.graduated.has(id))return this.graduated.get(id);
    if(this.failed.has(id))return this.failed.get(id);

    // Frozen exams are fixed slots. Once admitted, a DNA owns its slot until
    // it reaches the proof sample size and receives a PASS/FAIL decision.
    // This prevents rapid evolution from continually replacing candidates
    // before they can ever reach N >= minClosed.
    if(this.frozen.size>=this.maxFrozen)return null;

    const item={
      id,brainId:brain.id,parent:brain.parent||null,role,version,dna:clone(dna),
      frozenAt:Date.now(),status:'FROZEN_EXAM',proofTargetN:this.gates.minClosed
    };
    this.frozen.set(id,item);
    this.record('FREEZE',{id,brainId:brain.id,role,version,targetN:this.gates.minClosed});
    return item;
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
    this.record('ELITE_REFRESH',{elite:[...next.keys()],frozen:this.frozen.size});
    return [...next.values()];
  }

  evaluateFrozenAgainstBrains(brains){
    const byId=new Map(brains.map(b=>[b.id,b]));
    const results=[];

    for(const frozen of [...this.frozen.values()]){
      const brain=byId.get(frozen.brainId);
      if(!brain){
        results.push({
          id:frozen.id,brainId:frozen.brainId,role:frozen.role,version:frozen.version,
          stats:null,proof:null,status:'FROZEN_EXAM',reason:'BRAIN_MISSING'
        });
        continue;
      }

      const stats=this.forwardEvidence(brain);
      const proof=evaluateChampion(stats,this.gates);
      const targetReached=stats.n>=this.gates.minClosed;
      const rec={id:frozen.id,brainId:frozen.brainId,role:frozen.role,version:frozen.version,stats,proof,status:'FROZEN_EXAM'};

      // Before N reaches the proof target, NEVER replace, mutate, fail or
      // graduate this candidate. It remains frozen and keeps accumulating.
      if(!targetReached){
        results.push(rec);
        continue;
      }

      if(proof.eligible){
        const champion={
          ...frozen,status:'CHAMPION',stats,proof,
          graduatedAt:Date.now(),lastVerifiedAt:Date.now()
        };
        this.graduated.set(frozen.id,champion);
        this.frozen.delete(frozen.id);
        rec.status='CHAMPION';
        this.record('GRADUATE',{id:frozen.id,brainId:frozen.brainId,role:frozen.role,score:proof.score,n:stats.n});
      }else{
        const failed={...frozen,status:'FAILED_EXAM',stats,proof,failedAt:Date.now()};
        this.failed.set(frozen.id,failed);
        this.frozen.delete(frozen.id);
        rec.status='FAILED_EXAM';
        this.record('FAIL_EXAM',{id:frozen.id,brainId:frozen.brainId,role:frozen.role,n:stats.n,reasons:proof.reasons});
      }
      results.push(rec);
    }

    // Re-verify existing champions against their still-protected brain history.
    // A champion may be dethroned if later evidence breaks a proof gate.
    for(const champ of [...this.graduated.values()]){
      const brain=byId.get(champ.brainId);
      if(!brain)continue;
      const stats=this.forwardEvidence(brain);
      const proof=evaluateChampion(stats,this.gates);
      if(proof.eligible){
        this.graduated.set(champ.id,{...champ,stats,proof,lastVerifiedAt:Date.now()});
      }else{
        this.graduated.delete(champ.id);
        this.failed.set(champ.id,{...champ,status:'FAILED_EXAM',stats,proof,failedAt:Date.now()});
        this.record('DETHRONE',{id:champ.id,brainId:champ.brainId,reasons:proof.reasons});
      }
    }

    return results.sort((a,b)=>Number(b.proof?.eligible)-Number(a.proof?.eligible)||(b.proof?.score||0)-(a.proof?.score||0));
  }

  portfolio(){
    return selectPortfolio([...this.graduated.values()].map(x=>({id:x.id,role:x.role,stats:x.stats,proof:x.proof,brainId:x.brainId,version:x.version})));
  }

  route(market){
    return routeDecision({market,portfolio:this.portfolio()});
  }

  protectedBrainIds(){
    // CRITICAL: every DNA in a frozen exam is protected from evolution/pruning
    // until its exam ends. This is what allows N to climb monotonically to 100+
    // instead of being reset when a new generation is bred.
    return new Set([
      ...this.archive.keys(),
      ...[...this.frozen.values()].map(x=>x.brainId),
      ...[...this.graduated.values()].map(x=>x.brainId)
    ]);
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
      architecture:'MASTER_BRAIN_CHAMPION_FACTORY_V2_FROZEN_EXAM_LOCK',
      realMoney:false,
      gates:this.gates,
      elite:[...this.archive.values()],
      frozen:[...this.frozen.values()],
      champions:[...this.graduated.values()],
      failed:[...this.failed.values()],
      portfolio:this.portfolio(),
      audit:this.audit.slice(0,100)
    };
  }
}

module.exports={ChampionFactoryManager,tradeStats};
