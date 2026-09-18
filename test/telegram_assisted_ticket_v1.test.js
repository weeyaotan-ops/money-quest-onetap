'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const src=fs.readFileSync(require.resolve('../binance_onetap_gateway.js'),'utf8');

assert.match(src,/🎯 HUNTER TRADE TICKET/);
assert.match(src,/Manual order only\. Auto-execution is OFF\./);
assert.match(src,/TP PNL/);
assert.match(src,/SIZE\s+/);
assert.match(src,/reply_markup:\{inline_keyboard:\[\[\{text:'❌ SKIP'/);
assert.doesNotMatch(src,/inline_keyboard:\[\[\{text:'✅ CONFIRM LIVE'/);

console.log('TELEGRAM_ASSISTED_TICKET_V1_TEST_OK');
