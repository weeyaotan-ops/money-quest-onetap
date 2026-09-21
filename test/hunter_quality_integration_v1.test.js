'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const path=require('node:path'),root=path.resolve(__dirname,'..');
const localRequire=createRequire(path.join(root,'package.json'));
function load(file){
  const req=name=>name==='node:http'?{createServer:()=>({listen(){}})}:name==='node:child_process'?{spawn:()=>({on(){},kill(){}})}:localRequire(name);
  req.resolve=localRequire.resolve;
  const networkCalls=[];
  const context=vm.createContext({networkCalls,require:req,process:{env:{},on(){},execPath:process.execPath},console:{log(){},warn(){},error(){}},setInterval:()=>({unref(){}}),setTimeout:()=>({unref(){}}),AbortController,AbortSignal,URL,Buffer,fetch:(...args)=>{networkCalls.push(args);throw Error('NETWORK_FORBIDDEN')}});
  vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);return context;
}
async function run(){
  const scanner=load('opportunity_hunter_server_v1.js'),now=Math.floor(Date.now()/60000)*60000;
  scanner.bars=Array.from({length:61},(_,i)=>{const at=now-(60-i)*60000,p=100+i*.1;return[at,p,p+2,p-2,p+.1,10,at+59999]});
  scanner.bars[59][2]=108.9;scanner.bars[59][4]=108.4;
  vm.runInContext('jf=async()=>bars;',scanner);
  const a=await vm.runInContext("inspect({symbol:'BTCUSDT',bidPrice:106,askPrice:106.01},'1m',{},emptyFunnel())",scanner);
  assert.equal(a.action,'ONE_TAP_CANDIDATE');assert.equal(a.closedBars,60);
  assert.equal(a.signalAt,new Date(now).toISOString());assert.equal(a.entry,108.4);assert.equal(a.edge,a.sourceSetup);assert.equal(a.selectionVersion,'CONFIRMED_STRUCTURE_V1');
  assert.equal(a.side,'BUY');
  assert.ok(a.sl<a.setupConfirmation.invalidation);
  const wide=vm.runInContext("geometry({close:100,atr:1},{side:'BUY',invalidation:90})",scanner);
  assert.ok(wide.sl<90,'stop must sit beyond confirmed invalidation');
  assert.ok(fs.readFileSync(path.join(root,'opportunity_hunter_server_v1.js'),'utf8').includes('huntConfirmed('));
  vm.runInContext("ledger.closed.push({edge:'VOLATILITY_EXPANSION',r:100,side:'BUY',openedAt:1,closedAt:2})",scanner);
  assert.equal(Object.keys(vm.runInContext('learning()',scanner)).length,0);
  scanner.bars[60][2]=99999;scanner.bars[60][4]=99998;
  const b=await vm.runInContext("inspect({symbol:'BTCUSDT',bidPrice:106,askPrice:106.01},'1m',{},emptyFunnel())",scanner);
  assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
  assert.equal(await vm.runInContext("inspect({symbol:'BTCUSDT',bidPrice:107,askPrice:106},'1m',{},emptyFunnel())",scanner),null);
  const boot=load('hunter_confirm_live_boot.js');
  vm.runInContext("evidence={side:new Map([['BUY',{n:40,expectancyR:1,profitFactor:2}]]),regime:new Map(),timeframe:new Map(),edge:new Map(),sideRegime:new Map(),edgeTimeframe:new Map()};evidenceAt=Date.now();",boot);
  assert.ok(vm.runInContext("evidenceAdjustment({side:'BUY'})",boot)>0);
  assert.equal(vm.runInContext("evidenceAdjustment({side:'BUY',selectionVersion:'CONFIRMED_STRUCTURE_V1'})",boot),0);
  vm.runInContext("versionEvidence.set('CONFIRMED_STRUCTURE_V1',evidence)",boot);
  assert.ok(vm.runInContext("evidenceAdjustment({side:'BUY',selectionVersion:'CONFIRMED_STRUCTURE_V1'})",boot)>0);
  vm.runInContext('evidenceAt=Date.now()-1000000;',boot);
  assert.equal(vm.runInContext("evidenceAdjustment({side:'BUY'})",boot),0);
  assert.equal(vm.runInContext("fresh({openedAt:'invalid'})",boot),false);
  assert.equal(vm.runInContext("liveEligible({selectionVersion:'LEGACY',timeframe:'5m',edge:'TREND_PULLBACK_RECLAIM'})",boot),false);
  assert.equal(vm.runInContext("liveEligible({selectionVersion:'CONFIRMED_STRUCTURE_V1',timeframe:'5m',edge:'TREND_PULLBACK_RECLAIM'})",boot),true);
  assert.equal(vm.runInContext("liveEligible({selectionVersion:'CONFIRMED_STRUCTURE_V1',timeframe:'1m',edge:'BREAKOUT_RETEST'})",boot),false);
  // Expiry during asynchronous recheck must not reach the order gateway.
  vm.runInContext("current=[{id:'stale-during-check',openedAt:new Date().toISOString()}];check=async(t)=>({...t,openedAt:new Date(Date.now()-MAX_AGE-1).toISOString()});",boot);
  await vm.runInContext('sendOne()',boot);
  assert.equal(vm.runInContext('sent.size',boot),0);
  assert.equal(boot.networkCalls.length,0);
  vm.runInContext("current=[{id:'stale-during-observe',openedAt:new Date().toISOString()}];check=async(t)=>t;observeGate=async(t)=>{t.openedAt=new Date(Date.now()-MAX_AGE-1).toISOString()};",boot);
  await vm.runInContext('sendOne()',boot);
  assert.equal(boot.networkCalls.length,0);
  console.log('HUNTER_QUALITY_INTEGRATION_V1_PASS');
}
run().catch(e=>{console.error(e);process.exitCode=1});
