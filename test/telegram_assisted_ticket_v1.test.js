'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
// Exercise UI and callbacks with isolated dependencies: zero exchange I/O.
const src=fs.readFileSync(require.resolve('../binance_onetap_gateway.js'),'utf8');
const messages=[];
const fakeRequire=name=>name==='node:http'?{createServer:()=>({listen:()=>{}})}:require(require.resolve(name,{paths:[require('node:path').resolve(__dirname,'..')]}));
const context=vm.createContext({require:fakeRequire,Buffer,URL,process:{env:{TELEGRAM_CHAT_ID:'test-chat',TELEGRAM_AUTH_USER_ID:'test-user',BINANCE_ONETAP_LIVE:'1'}},console:{log(){},warn(){},error(){}},setInterval:()=>({unref(){}}),setTimeout,fetch:()=>{throw Error('NETWORK_FORBIDDEN')},messages});
vm.runInContext(src,context);
vm.runInContext(`
let executions=0;
tg=async(method,payload)=>{messages.push({method,payload});return{message_id:messages.length}};
preview=async(ticket)=>({id:ticket.id,symbol:'BTCUSDT',side:'BUY',entry:100,sl:99,tp:102,leverage:2,qtyStr:'1',notional:100,margin:50,actualRisk:1,equity:100,netProfit:2,netRR:2});
executePending=async(item)=>{executions++;return{ok:false,p:item.preview}};
`,context);
async function run(){
  await vm.runInContext("sendPending({id:'test-one',openedAt:new Date().toISOString()})",context);
  const message=messages.find(x=>x.method==='sendMessage').payload;
  const buttons=message.reply_markup.inline_keyboard[0];
  assert.equal(buttons[0].text,'✅ CONFIRM LIVE');assert.equal(buttons[1].text,'❌ SKIP');
  assert.match(buttons[0].callback_data,/^mh:/);assert.match(buttons[1].callback_data,/^ms:/);
  assert.match(message.text,/TP PNL/);assert.match(message.text,/CONFIRM LIVE/);
  assert.doesNotMatch(message.text,/Auto-execution is OFF/);
  context.query={id:'callback',data:buttons[0].callback_data,message:{chat:{id:'test-chat'}},from:{id:'unauthorized'}};
  await vm.runInContext('handleCallback(query)',context);assert.equal(vm.runInContext('executions',context),0);
  context.query.from.id='test-user';
  await vm.runInContext('handleCallback(query)',context);assert.equal(vm.runInContext('executions',context),1);
  await vm.runInContext('handleCallback(query)',context);assert.equal(vm.runInContext('executions',context),1);
  await vm.runInContext("sendPending({id:'test-skip',openedAt:new Date().toISOString()})",context);
  context.query.data=messages.filter(x=>x.method==='sendMessage').at(-1).payload.reply_markup.inline_keyboard[0][1].callback_data;
  await vm.runInContext('handleCallback(query)',context);assert.equal(vm.runInContext('executions',context),1);
  console.log('TELEGRAM_ASSISTED_TICKET_V1_TEST_OK');
}
run().catch(e=>{console.error(e);process.exitCode=1});
