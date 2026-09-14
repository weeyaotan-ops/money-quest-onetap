'use strict';

// Safe integration layer for the locked Master Brain architecture.
// It deliberately leaves the existing production arena untouched.
const {ChampionFactoryManager}=require('./champion_factory_manager');
const {classifyRegime}=require('./champion_factory_core');

function attachMasterBrain({state, brainStats, discoveryRank, emit=()=>{}}={}){
  if(!state?.brains || typeof brainStats!=='function' || typeof discoveryRank!=='function'){
    throw new Error('MASTER_BRAIN_BAD_ARENA_ADAPTER');
  }
  const manager=new ChampionFactoryManager();

  function tagTradeRegimes(){
    for(const b of state.brains.values()){
      for(const arr of [b.closedDiscovery||[],b.closedHoldout||[]]){
        for(const t of arr){
          if(!t.regime) t.regime=classifyRegime(t.market||{});
        }
      }
    }
  }

  function refresh(){
    tagTradeRegimes();
    const brains=[...state.brains.values()];
    const elite=manager.refreshElite(brains);
    const exams=manager.evaluateFrozenAgainstBrains(brains);
    const snap=manager.snapshot();
    emit('MASTER_BRAIN_REFRESH',{
      elite:elite.length,
      frozen:snap.frozen.length,
      champions:snap.champions.length,
      architecture:snap.architecture
    });
    return {elite,exams,...snap};
  }

  function pruneTo(popMax){
    if(state.brains.size<=popMax)return [];
    refresh();
    const ranked=discoveryRank();
    const order=manager.pruneOrder([...state.brains.values()],ranked);
    const retired=[];
    for(const b of order){
      if(state.brains.size<=popMax)break;
      state.brains.delete(b.id);
      retired.push(b.id);
      emit('MASTER_BRAIN_RETIRE',{brain:b.id,parent:b.parent||null});
    }
    return retired;
  }

  function breedingParents(limit){
    refresh();
    const eliteIds=new Set(manager.protectedBrainIds());
    const ranked=discoveryRank();
    const preferred=ranked.filter(x=>eliteIds.has(x.id));
    const fallback=ranked.filter(x=>!eliteIds.has(x.id) && (x.discovery?.n||0)>=3);
    return [...preferred,...fallback].slice(0,limit);
  }

  function masterSnapshot(market=null){
    const x=refresh();
    return {
      ...x,
      route:market?manager.route(market):null,
      arena:{generation:state.generation,population:state.brains.size}
    };
  }

  return {manager,refresh,pruneTo,breedingParents,masterSnapshot};
}

module.exports={attachMasterBrain};
