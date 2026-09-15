'use strict';
// Forward-only shadow ledger for Opportunity Hunter candidates.
class HunterLedger{
 constructor(opts={}){this.max=Number(opts.max||2000);this.ttl=Number(opts.ttlMs||6*60*60*1000);this.open=new Map();this.closed=[];}
 key(t){return [t.symbol,t.side,t.edge,Number(t.entry).toPrecision(10)].join('|')}
 admit(t,ts=Date.now()){const k=this.key(t);if(this.open.has(k))return false;this.open.set(k,{...t,id:k,openedAt:ts,status:'OPEN'});return true}
 mark(symbol,price,ts=Date.now()){price=Number(price);if(!(price>0))return[];const done=[];for(const [k,t] of this.open){if(t.symbol!==symbol)continue;let outcome=null;if(t.side==='BUY'){if(price<=t.sl)outcome='SL';else if(price>=t.tp)outcome='TP'}else{if(price>=t.sl)outcome='SL';else if(price<=t.tp)outcome='TP'}if(!outcome&&ts-t.openedAt>=this.ttl)outcome='TIME';if(!outcome)continue;const risk=Math.abs(t.entry-t.sl)||1;let r=t.side==='BUY'?(price-t.entry)/risk:(t.entry-price)/risk;if(outcome==='TP')r=Number(t.rr)||r;if(outcome==='SL')r=-1;const x={...t,status:'CLOSED',closedAt:ts,exit:price,outcome,r};this.closed.push(x);this.open.delete(k);done.push(x)}if(this.closed.length>this.max)this.closed.splice(0,this.closed.length-this.max);return done}
 summary(){const groups={};for(const t of this.closed){const k=t.edge||'UNKNOWN',g=groups[k]||(groups[k]={edge:k,n:0,wins:0,losses:0,sumR:0});g.n++;g.sumR+=Number(t.r)||0;if(t.r>0)g.wins++;else if(t.r<0)g.losses++}const leaderboard=Object.values(groups).map(g=>({...g,winRate:g.n?g.wins/g.n:0,expectancyR:g.n?g.sumR/g.n:0})).sort((a,b)=>b.expectancyR-a.expectancyR);const total=this.closed.reduce((s,x)=>s+(Number(x.r)||0),0);return{open:this.open.size,closed:this.closed.length,totalR:total,leaderboard,recent:this.closed.slice(-30).reverse()}}
}
module.exports={HunterLedger};
