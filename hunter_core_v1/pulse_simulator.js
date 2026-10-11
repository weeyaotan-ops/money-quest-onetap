'use strict';
// Paper-only TP1 50% / runner 50% to 2R; after TP1 move remaining stop to entry.
// Uses ordered CLOSED one-minute bars. An intrabar conflict is UNKNOWN, never guessed.
// Existing historical hit counts are NOT converted into fictitious paper profits.
const FEE_SIDE=0.0006,SLIPPAGE_SIDE=0.0002;
function fresh(){return {version:1,status:'WAIT_TP1',tp1At:null,closedAt:null,grossR:null,estimatedCostR:null,estimatedNetR:null,reason:null};}
function baseline(trade){
 if(trade.simulation&&trade.simulation.version===1)return trade.simulation;
 trade.simulation={version:1,status:'HISTORICAL_UNVERIFIED',tp1At:null,closedAt:null,
  grossR:null,estimatedCostR:null,estimatedNetR:null,reason:'Existing hit history cannot prove intrabar order or paper fill'};
 return trade.simulation;
}
function estimateCostR(trade){
 const risk=Math.abs(Number(trade.entry)-Number(trade.stop));
 if(!(risk>0))return null;
 const fee=Number(process.env.PULSE_SIM_FEE_PER_SIDE);
 const slip=Number(process.env.PULSE_SIM_SLIPPAGE_PER_SIDE);
 const feeRate=Number.isFinite(fee)&&fee>=0?fee:FEE_SIDE;
 const slipRate=Number.isFinite(slip)&&slip>=0?slip:SLIPPAGE_SIDE;
 // Approximation: one weighted entry + exit for total initial size.
 return 2*(feeRate+slipRate)*Number(trade.entry)/risk;
}
function settle(trade,status,grossR,at,reason=null){
 const s=trade.simulation;s.status=status;s.closedAt=at;s.reason=reason;
 if(grossR===null)return;
 s.grossR=grossR;s.estimatedCostR=estimateCostR(trade);
 s.estimatedNetR=Number.isFinite(s.estimatedCostR)?grossR-s.estimatedCostR:null;
}
function touched(t,bar,level,target){
 return t.side==='LONG'?(target?Number(bar.h)>=level:Number(bar.l)<=level):
  (target?Number(bar.l)<=level:Number(bar.h)>=level);
}
function advance(t,bar){
 const s=t.simulation;
 if(!s||!['WAIT_TP1','RUNNER'].includes(s.status))return;
 const at=Number(bar.t)+60000;
 const sl=touched(t,bar,t.stop,false);
 const tp1=touched(t,bar,t.tp1,true);
 const tp2=touched(t,bar,t.tp2,true);
 const be=touched(t,bar,t.entry,false);
 if(s.status==='WAIT_TP1'){
  if(sl&&tp1){settle(t,'AMBIGUOUS',null,at,'SL and TP1 in same 1m bar');return;}
  if(sl){settle(t,'SL',-1,at);return;}
  if(!tp1)return;
  s.tp1At=at;
  // Did entry/B.E. get touched after TP1? OHLC cannot prove order.
  if(be){settle(t,'AMBIGUOUS',null,at,'TP1 and entry in same 1m bar');return;}
  if(tp2){settle(t,'TP2',1.5,at);return;}
  s.status='RUNNER';return;
 }
 if(be&&tp2){settle(t,'AMBIGUOUS',null,at,'Breakeven and TP2 in same 1m bar');return;}
 if(be){settle(t,'BE_EXIT',0.5,at);return;}
 if(tp2)settle(t,'TP2',1.5,at);
}
function summarize(trades){
 const modes={};
 let historical=0,uncertain=0,active=0,closed=0,netTotal=0,grossTotal=0;
 const exitCounts={SL:0,BE_EXIT:0,TP2:0};
 for(const t of trades||[]){
  const mode=t.mode||'LEGACY';
  const m=modes[mode]||={eligible:0,resolved:0,uncertain:0,netR:0,tp2:0,be:0,sl:0};
  const s=t.simulation;
  if(!s||s.status==='HISTORICAL_UNVERIFIED'){historical++;continue;}
  m.eligible++;
  if(s.status==='AMBIGUOUS'){uncertain++;m.uncertain++;continue;}
  if(['WAIT_TP1','RUNNER'].includes(s.status)){active++;continue;}
  if(!Object.hasOwn(exitCounts,s.status))continue;
  closed++;m.resolved++;exitCounts[s.status]++;
  if(s.status==='SL')m.sl++;if(s.status==='TP2')m.tp2++;if(s.status==='BE_EXIT')m.be++;
  grossTotal+=s.grossR;
  if(Number.isFinite(s.estimatedNetR)){netTotal+=s.estimatedNetR;m.netR+=s.estimatedNetR;}
 }
 return {closed,active,uncertain,historical,exitCounts,netTotal,grossTotal,modes,validationMinimum:100};
}
function paperLabel(t){
 const s=t.simulation;
 if(!s||s.status==='HISTORICAL_UNVERIFIED')return 'old / not verified';
 if(s.status==='AMBIGUOUS')return 'unknown order';
 if(s.status==='WAIT_TP1'||s.status==='RUNNER')return 'tracking';
 if(!Number.isFinite(s.estimatedNetR))return 'cost unavailable';
 return (s.estimatedNetR>=0?'+':'')+s.estimatedNetR.toFixed(2)+'R est. net';
}
module.exports={fresh,baseline,advance,estimateCostR,summarize,paperLabel};