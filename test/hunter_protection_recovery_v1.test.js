'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const file=require.resolve('../binance_onetap_gateway');
function harness(){
 const localRequire=createRequire(file);
 const c=vm.createContext({Buffer,URL,AbortSignal,Date,process:{env:{}},
  require:n=>n==='node:http'?{createServer:()=>({listen(){}})}:localRequire(n),
  console:{log(){},warn(){},error(){}},setInterval:()=>({unref(){}}),setTimeout,
  fetch:()=>{throw Error('NETWORK_FORBIDDEN')}});
 vm.runInContext(fs.readFileSync(file,'utf8'),c);
 vm.runInContext(`const calls=[];const p={id:'x',symbol:'TESTUSDT',actualRisk:2,riskUsd:5};
 emergencyClose=async()=>{calls.push('close')};
 verifyNoSymbolPosition=async()=>{calls.push('verify');return true};
 cancelAlgo=async()=>{calls.push('cancel')};`,c);
 return s=>vm.runInContext(s,c);
}
(async()=>{
 let count=0;
 for(const [scenario,setup,closed] of [
  ['closed','',true],
  ['still open',"verifyNoSymbolPosition=async()=>{calls.push('verify');return false}",false],
  ['close failed',"emergencyClose=async()=>{calls.push('close');throw Error('rejected')};verifyNoSymbolPosition=async()=>{calls.push('verify');return false}",false],
  ['verification failed',"verifyNoSymbolPosition=async()=>{calls.push('verify');throw Error('timeout')}",false],
  ['already flat',"emergencyClose=async()=>{calls.push('close');throw Error('reduce-only rejected')}",true]
 ]){
  const run=harness();run(setup);
  await assert.rejects(run("recoverProtectionFailure(p,false,'1',{slAlgo:{},tpAlgo:null},Error('TP rejected'))"),closed?/CLOSURE_VERIFIED/:/CLOSURE_UNVERIFIED/);
  assert.equal(run('calls.join(",")'),closed?'close,verify,cancel':'close,verify',scenario);count++;
 }
 const run=harness();run("signed=async()=>[{realizedPnl:-2,commission:.2,commissionAsset:'USDT'}]");
 const stats=await run('settledStats({p,startedAt:Date.now()})');
 assert.equal(stats.actualR,-1.1);assert.equal(stats.riskAmount,2);
 assert.equal(stats.attributionStatus,'UNVERIFIED_TIME_WINDOW');count++;
 run("signed=async()=>[{realizedPnl:2,commission:.01,commissionAsset:'BNB'},{realizedPnl:0,commission:.1,commissionAsset:'USDT'}]");
 const mixed=await run('settledStats({p,startedAt:Date.now()})');
 assert.equal(mixed.net,null);assert.equal(mixed.actualR,null);assert.equal(mixed.commissionAsset,'UNCONVERTED');count++;
 console.log(`${count} protection and R consistency checks passed; all exchange I/O mocked.`);
})().catch(e=>{console.error(e);process.exitCode=1});
