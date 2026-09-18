'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const boot=fs.readFileSync(require.resolve('../hunter_confirm_live_boot.js'),'utf8');
const preload=fs.readFileSync(require.resolve('../binance_private_egress_preload.js'),'utf8');

assert.match(preload,/method!==\'GET\'/);
assert.match(preload,/u\.host!==HOST/);
assert.match(preload,/x-relay-token/);
assert.match(preload,/Private Binance egress relay unavailable/);
assert.match(boot,/--require=\$\{relay\} --require=\$\{rateGuard\}/);
assert.ok(boot.indexOf('--require=${relay}')<boot.indexOf('--require=${rateGuard}'),'relay must load before rate guard');
console.log('BINANCE_PRIVATE_EGRESS_CLIENT_TEST_OK');
