'use strict';
const assert=require('node:assert');

const originalFetch=async()=>({ok:true,json:async()=>({})});
global.fetch=originalFetch;
const mod=require('../binance_safety_preload_v1');

assert.equal(mod.signedUrlMutation,false);
assert.strictEqual(global.fetch,originalFetch,'safety preload must never replace fetch or mutate signed Binance URLs');

console.log('binance_safety_preload_v1.test.js PASS',JSON.stringify({signedUrlMutation:false,fetchUnchanged:true}));
