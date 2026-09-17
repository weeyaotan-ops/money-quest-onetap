'use strict';
const assert=require('node:assert');

// Avoid any real network access while loading the preload.
global.fetch=async()=>({ok:true,json:async()=>({})});
const {rewriteStopProtect}=require('../binance_safety_preload_v1');

const stop='https://fapi.binance.com/fapi/v1/algoOrder?algoType=CONDITIONAL&symbol=BTCUSDT&type=STOP_MARKET&priceProtect=TRUE&triggerPrice=100';
const stopOut=String(rewriteStopProtect(stop));
assert.ok(stopOut.includes('type=STOP_MARKET'));
assert.ok(stopOut.includes('priceProtect=FALSE'));

const tp='https://fapi.binance.com/fapi/v1/algoOrder?algoType=CONDITIONAL&symbol=BTCUSDT&type=TAKE_PROFIT_MARKET&priceProtect=TRUE&triggerPrice=120';
const tpOut=String(rewriteStopProtect(tp));
assert.ok(tpOut.includes('type=TAKE_PROFIT_MARKET'));
assert.ok(tpOut.includes('priceProtect=TRUE'));

const normal='https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&type=LIMIT&priceProtect=TRUE';
assert.equal(String(rewriteStopProtect(normal)),normal);

console.log('binance_safety_preload_v1.test.js PASS',JSON.stringify({stopPriceProtect:false,tpUnchanged:true,normalUnchanged:true}));
