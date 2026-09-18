'use strict';

// Read-only lifecycle guard for Binance live positions.
// It NEVER submits, cancels, or modifies Binance orders.
// Purpose:
// 1) migrate historical seed rows already proven closed by the Gate history;
// 2) keep observing live executions after the gateway's native ~24m monitor ends;
// 3) alert on unusually old positions without auto-closing them.

const fs=require('node:fs');
const path=require('node:path');

if(path.basename(process.argv[1]||'')!=='binance_onetap_gateway.js'){
  module.exports={active:false};
}else{
  const TG_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
  const TG_CHAT=String(process.env.TELEGRAM_CHAT_ID||'');
  const LEDGER_FILE=String(process.env.REAL_MONEY_LEDGER_STATE_FILE||'/data/real-money-ledger-v2.json');
  const GATE_FILE=String(process.env.HUNTER_LIVE_GATE_STATE_FILE||'/data/hunter-live-gate-v1.json');
  const STATE_FILE=String(process.env.POSITION_LIFECYCLE_STATE_FILE||'/data/position-lifecycle-v1.json');
  const LATE_AFTER_MS=Math.max(25*60*1000,Number(process.env.POSITION_LIFECYCLE_LATE_AFTER_MS||25*60*1000));
  const ALERT_AFTER_MS=Math.max(30*60*1000,Number(process.env.POSITION_LIFECYCLE_ALERT_AFTER_MS||30*60*1000));
  const POLL_MS=Math.max(30000,Number(process.env.POSITION_LIFECYCLE_POLL_MS||30000));
  const tracked=new Map();
  let checking=false;
  let emitting=false;
  const baseLog=console.log.bind(console);

  function atomicWrite(file,obj){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(obj));
    fs.renameSync(tmp,file);
  }
  function saveState(){
    try{atomicWrite(STATE_FILE,{version:1,savedAt:new Date().toISOString(),tracked:[...tracked.values()]})}
    catch(e){baseLog('POSITION_LIFECYCLE_PERSIST_ERR',String(e?.message||e))}
  }
  function loadState(){
    try{
      if(!fs.existsSync(STATE_FILE))return;
      const j=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
      for(const t of Array.isArray(j?.tracked)?j.tracked:[])if(t?.id&&t?.symbol)tracked.set(String(t.id),t);
      baseLog('POSITION_LIFECYCLE_RESTORED',JSON.stringify({tracked:tracked.size,file:STATE_FILE}));
    }catch(e){baseLog('POSITION_LIFECYCLE_LOAD_ERR',String(e?.message||e))}
  }
  function migrateClosedSeeds(){
    try{
      if(!fs.existsSync(LEDGER_FILE)||!fs.existsSync(GATE_FILE))return;
      const ledger=JSON.parse(fs.readFileSync(LEDGER_FILE,'utf8'));
      const gate=JSON.parse(fs.readFileSync(GATE_FILE,'utf8'));
      const closed=new Map((gate?.gate?.history||[]).filter(x=>x?.id&&x?.closedAt).map(x=>[String(x.id),x]));
      let changed=0;
      for(const t of Array.isArray(ledger?.trades)?ledger.trades:[]){
        if(t?.source!=='CONFIRMED_EXECUTION_SEED')continue;
        const h=closed.get(String(t.id));if(!h)continue;
        t.status='CLOSED';t.closedAt=h.closedAt;t.netPnl=h.netPnl??t.netPnl??null;t.actualR=h.actualR??t.actualR??null;t.source='MIGRATED_GATE_CONFIRMED_CLOSED';changed++;
      }
      if(changed){ledger.savedAt=new Date().toISOString();atomicWrite(LEDGER_FILE,ledger)}
      baseLog('POSITION_LIFECYCLE_SEED_MIGRATION',JSON.stringify({changed,closedEvidence:closed.size}));
    }catch(e){baseLog('POSITION_LIFECYCLE_SEED_MIGRATION_ERR',String(e?.message||e))}
  }
  function seedFromLedger(){
    try{
      if(!fs.existsSync(LEDGER_FILE))return;
      const j=JSON.parse(fs.readFileSync(LEDGER_FILE,'utf8'));let added=0;
      for(const t of Array.isArray(j?.trades)?j.trades:[]){
        if(t?.status!=='OPEN'||!t?.id||!t?.symbol)continue;
        if(tracked.has(String(t.id)))continue;
        tracked.set(String(t.id),{id:String(t.id),symbol:String(t.symbol),side:String(t.side||''),actualRisk:Number(t.actualRisk)||null,startedAt:Date.parse(t.openedAt||0)||Date.now(),alerted:false,source:'LEDGER_RESTORE'});added++;
      }
      if(added)saveState();
      baseLog('POSITION_LIFECYCLE_LEDGER_SEED',JSON.stringify({added,tracked:tracked.size}));
    }catch(e){baseLog('POSITION_LIFECYCLE_LEDGER_SEED_ERR',String(e?.message||e))}
  }
  function parse(prefix,args){
    try{const s=args.map(String).join(' '),i=s.indexOf(prefix);return i<0?null:JSON.parse(s.slice(i+prefix.length).trim())}catch{return null}
  }
  const previousLog=console.log;
  console.log=(...args)=>{
    if(!emitting){
      try{
        let x=parse('ONETAP_LIVE_EXECUTED',args);
        if(x?.id&&x?.symbol){tracked.set(String(x.id),{id:String(x.id),symbol:String(x.symbol),side:String(x.side||''),actualRisk:Number(x.actualRisk)||null,startedAt:Date.now(),alerted:false,source:'LIVE'});saveState()}
        x=parse('ONETAP_POSITION_CLOSED',args);
        if(x?.id&&tracked.delete(String(x.id)))saveState();
      }catch(e){baseLog('POSITION_LIFECYCLE_LOG_ERR',String(e?.message||e))}
    }
    return previousLog(...args);
  };
  async function tg(text){
    if(!TG_TOKEN||!TG_CHAT)return;
    try{await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,disable_web_page_preview:true})})}catch{}
  }
  async function checkLate(){
    if(checking||!tracked.size)return;
    const now=Date.now(),late=[...tracked.values()].filter(t=>now-Number(t.startedAt||now)>=LATE_AFTER_MS);
    if(!late.length)return;
    checking=true;
    try{
      if(!fs.existsSync(LEDGER_FILE))return;
      const ledger=JSON.parse(fs.readFileSync(LEDGER_FILE,'utf8'));
      const rows=Array.isArray(ledger?.trades)?ledger.trades:[];
      let changed=false;
      for(const t of late){
        const age=now-Number(t.startedAt||now);
        const row=rows.find(x=>String(x.id||'')===String(t.id))
          ||rows.find(x=>x.status==='OPEN'&&String(x.symbol||'')===t.symbol&&String(x.side||'')===String(t.side||''));
        if(row?.status==='OPEN'){
          if(age>=ALERT_AFTER_MS&&!t.alerted){
            t.alerted=true;t.alertedAt=new Date().toISOString();changed=true;
            const mins=Math.round(age/60000);
            baseLog('ONETAP_POSITION_AGE_ALERT',JSON.stringify({id:t.id,symbol:t.symbol,ageMin:mins,autoExit:false,dataSource:'LEDGER'}));
            await tg(`⚠️ LONG-HOLD WATCH\n${t.symbol} ${t.side||''}\nStill open after ~${mins} min.\nNo automatic close was submitted.`);
          }
          continue;
        }
        if(row?.status==='CLOSED'){
          tracked.delete(t.id);changed=true;
          baseLog('ONETAP_LATE_POSITION_NO_LONGER_OPEN',JSON.stringify({id:t.id,symbol:t.symbol,ageMin:Math.round(age/60000),dataSource:'LEDGER'}));
          await tg(`✅ POSITION NO LONGER OPEN\n${t.symbol} ${t.side||''}\nPersistent ledger confirmed the position is closed.\nP&L is recorded in the real-money ledger.`);
        }
      }
      if(changed)saveState();
    }catch(e){
      baseLog('POSITION_LIFECYCLE_CHECK_ERR',String(e?.message||e));
    }finally{
      checking=false;
    }
  }

  migrateClosedSeeds();
  loadState();
  setTimeout(seedFromLedger,4000).unref();
  setInterval(checkLate,POLL_MS).unref();
  baseLog('POSITION_LIFECYCLE_READY',JSON.stringify({binanceRequests:false,dataSource:'PERSISTENT_LEDGER',autoExit:false,lateAfterMs:LATE_AFTER_MS,alertAfterMs:ALERT_AFTER_MS,pollMs:POLL_MS,stateFile:STATE_FILE}));
  module.exports={active:true};
}
