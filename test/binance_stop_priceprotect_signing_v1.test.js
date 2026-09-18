'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');

const gateway=fs.readFileSync(require.resolve('../binance_onetap_gateway.js'),'utf8');
const safety=fs.readFileSync(require.resolve('../binance_safety_preload_v1.js'),'utf8');

assert.match(gateway,/STOP_PRICE_PROTECT=process\.env\.BINANCE_STOP_PRICE_PROTECT==='1'/);
assert.match(gateway,/priceProtect:kind==='SL'\?\(STOP_PRICE_PROTECT\?'TRUE':'FALSE'\):'TRUE'/);
assert.match(gateway,/async function algoOrder[\s\S]*return signed\('POST','\/fapi\/v1\/algoOrder',\{[\s\S]*priceProtect:kind==='SL'/);
assert.match(gateway,/function signed\(method,path,params=\{\}\)\{const p=\{\.\.\.params,recvWindow:5000,timestamp:Date\.now\(\)\}/);
assert.match(gateway,/stopPriceProtect:STOP_PRICE_PROTECT/);
assert.doesNotMatch(safety,/global\.fetch\s*=/,'safety preload must never rewrite a signed Binance URL');
assert.match(safety,/signedUrlMutation:false/);

console.log('BINANCE_STOP_PRICEPROTECT_SIGNING_V1_TEST_OK');
