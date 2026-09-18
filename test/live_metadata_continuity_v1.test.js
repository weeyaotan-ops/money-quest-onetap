'use strict';
const assert=require('node:assert');
const fs=require('node:fs');
const gateway=fs.readFileSync(require.resolve('../binance_onetap_gateway.js'),'utf8');
const ledger=fs.readFileSync(require.resolve('../real_money_ledger_preload.js'),'utf8');

for(const token of [
  "edge:ticket.edge||ticket.setup||''",
  "timeframe:ticket.timeframe||''",
  "regime:ticket.regime||ticket.shadowStructureRegime||''",
  "edge:r.p.edge,timeframe:r.p.timeframe,regime:r.p.regime",
  "ONETAP_POSITION_CLOSED"
]) assert.ok(gateway.includes(token),'gateway missing '+token);

for(const token of [
  "setup:x.setup||null",
  "edge:x.edge||x.setup||null",
  "timeframe:x.timeframe||null",
  "regime:x.regime||null"
]) assert.ok(ledger.includes(token),'ledger missing '+token);

console.log('live_metadata_continuity_v1.test.js PASS');
