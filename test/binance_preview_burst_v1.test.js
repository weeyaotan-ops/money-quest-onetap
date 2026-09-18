'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const gateway=fs.readFileSync(require.resolve('../binance_onetap_gateway.js'),'utf8');
const boot=fs.readFileSync(require.resolve('../hunter_confirm_live_boot.js'),'utf8');

assert.match(gateway,/PREVIEW_BRACKET_FALLBACK/);
assert.match(gateway,/maxLeverage\(symbol,allowNetwork=false\)/);
assert.match(gateway,/if\(!allowNetwork\)return PREVIEW_BRACKET_FALLBACK/);
assert.match(gateway,/maxLeverage\(symbol,force\)/);
assert.match(gateway,/searchParams\.get\('exact'\)==='1'/);
assert.match(boot,/phase==='DELIVERY'\?PREVIEW_URL\+'\?exact=1':PREVIEW_URL/);

// Guardrail: ordinary candidate preflight must not force live bracket/network reads.
assert.doesNotMatch(boot,/phase==='PREFLIGHT'[^\n]*\?exact=1/);
console.log('BINANCE_PREVIEW_BURST_V1_TEST_OK');
