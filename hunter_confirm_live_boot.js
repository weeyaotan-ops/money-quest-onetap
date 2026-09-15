'use strict';
const {spawn}=require('node:child_process');
const PUBLIC_PORT=String(process.env.PORT||8000);
const PUBLISHER_PORT=String(process.env.HUNTER_PUBLISHER_INNER_PORT||18103);
function run(script,extra={},label=script){const p=spawn(process.execPath,[script],{env:{...process.env,...extra},stdio:['ignore','inherit','inherit']});p.on('exit',(c,s)=>{console.error(label+'_EXIT',c,s);if(label==='HUNTER_CONFIRM_LIVE')process.exit(c||1)});return p}
const adapter=run('hunter_onetap_adapter.js',{HUNTER_ADAPTER_PORT:'18094'},'HUNTER_ADAPTER');
const gateway=run('binance_onetap_gateway.js',{PORT:PUBLIC_PORT,BINANCE_ONETAP_PORT:PUBLIC_PORT,BINANCE_ONETAP_UPSTREAM:'http://127.0.0.1:18094/tickets'},'HUNTER_CONFIRM_LIVE');
const publisher=run('resting_limit_loader_v2_candidate.js',{PORT:PUBLISHER_PORT},'PUBLISHER');
function stop(){for(const p of[adapter,gateway,publisher])try{p.kill('SIGTERM')}catch{}setTimeout(()=>process.exit(0),500).unref()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
console.log('HUNTER_CONFIRM_LIVE_BOOT',JSON.stringify({live:process.env.BINANCE_ONETAP_LIVE==='1',confirmationRequired:true,source:'Money Hunter',publicPort:PUBLIC_PORT,publisherPort:PUBLISHER_PORT}));
