'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const gatewayPath=require.resolve('../binance_onetap_gateway.js');
const gatewayRequire=createRequire(gatewayPath);
const source=fs.readFileSync(gatewayPath,'utf8');
const epoch=Date.parse('2026-01-01T00:00:00Z');
function harness(env={}){
  const clock={now:epoch};
  class Clock extends Date { static now(){return clock.now} }
  const context=vm.createContext({clock,Date:Clock,Buffer,URL,
    require:name=>name==='node:http'?{createServer:()=>({listen(){}})}:gatewayRequire(name),
    process:{env:{BINANCE_ONETAP_LIVE:'1',TELEGRAM_CHAT_ID:'chat',TELEGRAM_AUTH_USER_ID:'user',...env}},
    console:{log(){},warn(){},error(){}},setInterval:()=>({unref(){}}),setTimeout,
    fetch:()=>{throw Error('NETWORK_FORBIDDEN')}});
  vm.runInContext(source,context);
  vm.runInContext(`
    const calls=[];
    const p={id:'signal',symbol:'BTCUSDT',side:'BUY',entry:100,sl:98,tp:104,leverage:2,qty:1,qtyStr:'1',notional:100,margin:50,actualRisk:2,equity:200,netProfit:4,netRR:2};
    const ticket={id:'signal',signalAt:clock.now-110000,openedAt:clock.now};
    const item={ticket,expiresAt:clock.now+90000,preview:p};
    const realPreview=preview;
    preview=async()=>{calls.push('preview');return p};
    tg=async(method,payload)=>{calls.push({method,payload});return{message_id:1}};
    changeLeverage=async()=>{calls.push('leverage')};
    dualMode=async()=>{calls.push('dual');return false};
    entryOrder=async()=>{calls.push('entry');return{executedQty:0}};
  `,context);
  return {clock,context,run:code=>vm.runInContext(code,context)};
}
async function main(){
  // Source time wins over a fresher receipt time. Bad dates fail before network I/O.
  const h=harness();
  for(const t of [{},{signalAt:'bad',openedAt:epoch},{signalAt:epoch+1},{signalAt:epoch-120000}]){
    h.context.bad=t;
    assert.equal((await h.run('realPreview(bad)')).blocked,'SIGNAL_EXPIRED_OR_INVALID');
    await h.run("sendPending({...bad,id:'bad-'+notified.size})");
  }
  assert.equal(h.run('calls.length'),0);
  await h.run('sendPending(ticket)');
  assert.equal(h.run('[...pending.values()][0].expiresAt'),epoch+10000);
  assert.match(h.run("calls.find(x=>x.method==='sendMessage').payload.text"),/VALID   10s/);
  h.clock.now=epoch+10000;
  await h.run("handleCallback({id:'q',data:'mh:'+pending.keys().next().value,message:{chat:{id:'chat'}},from:{id:'user'}})");
  assert.equal(h.run("calls.includes('entry')"),false);
  assert.equal(h.run('pending.size'),0);

  // A long UI TTL cannot override a shorter configured source age limit.
  const short=harness({BINANCE_MAX_SIGNAL_AGE_MS:'30000'});
  assert.equal(short.run('MAX_SIGNAL_AGE'),30000);
  assert.equal(short.run('signalDeadline({signalAt:clock.now-30000})'),0);

  // Expiry during Telegram delivery preview suppresses the outgoing ticket.
  const delivery=harness();
  delivery.run('preview=async()=>{clock.now+=10000;return p}');
  await delivery.run('sendPending(ticket)');
  assert.equal(delivery.run('pending.size'),0);
  assert.equal(delivery.run("calls.some(x=>x.method==='sendMessage')"),false);

  // Recheck after each asynchronous execution preparation, immediately before entry.
  for(const stage of ['before','preview','leverage','dual']){
    const x=harness();
    if(stage==='before')x.clock.now+=10000;
    else if(stage==='preview')x.run("preview=async()=>{clock.now+=10000;return p}");
    else if(stage==='leverage')x.run("changeLeverage=async()=>{clock.now+=10000}");
    else x.run("dualMode=async()=>{clock.now+=10000;return false}");
    await assert.rejects(x.run('executePending(item)'),/SIGNAL_EXPIRED_OR_INVALID/);
    assert.equal(x.run("calls.includes('entry')"),false,stage);
  }
  const ttl=harness();ttl.run('item.expiresAt=clock.now');
  await assert.rejects(ttl.run('executePending(item)'),/SIGNAL_EXPIRED_OR_INVALID/);
  const fresh=harness();
  assert.equal((await fresh.run('executePending(item)')).reason,'IOC_NOT_FILLED');
  assert.equal(fresh.run("calls.filter(x=>x==='entry').length"),1);

  // Expiry after a fill must never prevent the SL and TP from being submitted.
  const filled=harness();
  filled.run(`
    p.meta={stepSize:'1'};
    entryOrder=async()=>{clock.now+=15000;return{executedQty:1}};
    fillStats=async()=>({avgPrice:100,entryCommission:0,commissionAsset:'USDT'});
    algoOrder=async(p,kind)=>{calls.push(kind);return{}};
    monitorTrade=async()=>{};
  `);
  assert.equal((await filled.run('executePending(item)')).ok,true);
  assert.equal(filled.run("calls.includes('SL')&&calls.includes('TP')"),true);
  console.log('HUNTER_CONFIRMATION_FRESHNESS_V1_TEST_OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
