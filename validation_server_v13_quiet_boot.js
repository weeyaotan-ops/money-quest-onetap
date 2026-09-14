'use strict';
// Stable V13 bootstrap: preserve full in-memory feed/journal while sampling noisy console events.
const originalLog=console.log.bind(console);
console.log=(...args)=>{
  try{
    const s=args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');
    if(s.startsWith('FOREVER_EVOLUTION ')){
      const noisy=s.includes('"type":"DNA_ORDER"')||s.includes('"type":"DNA_FILL"')||s.includes('"type":"TRAIL_MOVE"')||s.includes('"type":"BREAKEVEN"');
      if(noisy&&Math.random()>0.01)return;
    }
  }catch{}
  originalLog(...args);
};
global.require=require;
require('./validation_server_v13_forever_evolution.js');
