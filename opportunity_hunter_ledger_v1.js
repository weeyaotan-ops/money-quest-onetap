'use strict';
// Forward-only shadow ledger for Opportunity Hunter candidates.
// Exit-policy experiments are observational only: they NEVER change live Entry/SL/TP.
class HunterLedger{
 constructor(opts={}){this.max=Number(opts.max||2000);this.ttl=Number(opts.ttlMs||6*60*60*1000);this.open=new Map();this.closed=[];}
 key(t){return [t.symbol,t.side,t.edge,Number(t.entry).toPrecision(10)].join('|')}
 admit(t,ts=Date.now()){const k=this.key(t);if(this.open.has(k))return false;this.open.set(k,{...t,id:k,openedAt:ts,status:'OPEN',mfeR:0,maeR:0,shadow:{be05:null,be1:null,trail15:null},shadowState:{be05Armed:false,be1Armed:false,trailArmed:false,peakR:0}});return true}
 rAt(t,price){const risk=Math.abs(Number(t.entry)-Number(t.sl))||1;return t.side==='BUY'?(Number(price)-Number(t.entry))/risk:(Number(t.entry)-Number(price))/risk}
 mark(symbol,price,ts=Date.now()){price=Number(price);if(!(price>0))return[];const done=[];for(const [k,t] of this.open){if(t.symbol!==symbol)continue;const curR=this.rAt(t,price);t.mfeR=Math.max(Number(t.mfeR)||0,curR);t.maeR=Math.min(Number(t.maeR)||0,curR);const st=t.shadowState||(t.shadowState={});const sh=t.shadow||(t.shadow={});
 // Counterfactual policies, evaluated only from forward price samples.
 if(sh.be05==null){if(st.be05Armed&&curR<=0)sh.be05=0;if(curR>=0.5)st.be05Armed=true}
 if(sh.be1==null){if(st.be1Armed&&curR<=0)sh.be1=0;if(curR>=1)st.be1Armed=true}
 if(sh.trail15==null){st.peakR=Math.max(Number(st.peakR)||0,curR);if(curR>=1.5)st.trailArmed=true;if(st.trailArmed&&curR<=Math.max(0,st.peakR-1))sh.trail15=Math.max(0,st.peakR-1)}
 let outcome=null;if(t.side==='BUY'){if(price<=t.sl)outcome='SL';else if(price>=t.tp)outcome='TP'}else{if(price>=t.sl)outcome='SL';else if(price<=t.tp)outcome='TP'}if(!outcome&&ts-t.openedAt>=this.ttl)outcome='TIME';if(!outcome)continue;let r=curR;if(outcome==='TP')r=Number(t.rr)||r;if(outcome==='SL')r=-1;
 // If a shadow policy did not exit earlier, it inherits the original outcome.
 if(sh.be05==null)sh.be05=r;if(sh.be1==null)sh.be1=r;if(sh.trail15==null)sh.trail15=r;
 const x={...t,status:'CLOSED',closedAt:ts,exit:price,outcome,r,shadow:{...sh}};delete x.shadowState;this.closed.push(x);this.open.delete(k);done.push(x)}if(this.closed.length>this.max)this.closed.splice(0,this.closed.length-this.max);return done}
 policyStats(name,getR){const xs=this.closed.map(getR).filter(Number.isFinite);const sum=xs.reduce((a,b)=>a+b,0);const wins=xs.filter(x=>x>0).length,losses=xs.filter(x=>x<0).length;return{name,n:xs.length,wins,losses,breakeven:xs.length-wins-losses,totalR:sum,winRate:xs.length?wins/xs.length:0,expectancyR:xs.length?sum/xs.length:0}}
 summary(){const groups={};for(const t of this.closed){const k=t.edge||'UNKNOWN',g=groups[k]||(groups[k]={edge:k,n:0,wins:0,losses:0,sumR:0});g.n++;g.sumR+=Number(t.r)||0;if(t.r>0)g.wins++;else if(t.r<0)g.losses++}const leaderboard=Object.values(groups).map(g=>({...g,winRate:g.n?g.wins/g.n:0,expectancyR:g.n?g.sumR/g.n:0})).sort((a,b)=>b.expectancyR-a.expectancyR);const total=this.closed.reduce((s,x)=>s+(Number(x.r)||0),0);const exitPolicyShadow=[this.policyStats('ORIGINAL_TP_SL',x=>Number(x.r)),this.policyStats('BE_AFTER_0.5R',x=>Number(x.shadow&&x.shadow.be05)),this.policyStats('BE_AFTER_1R',x=>Number(x.shadow&&x.shadow.be1)),this.policyStats('TRAIL_1R_AFTER_1.5R',x=>Number(x.shadow&&x.shadow.trail15))];return{open:this.open.size,closed:this.closed.length,totalR:total,leaderboard,exitPolicyShadow,recent:this.closed.slice(-30).reverse()}}
}
module.exports={HunterLedger};
