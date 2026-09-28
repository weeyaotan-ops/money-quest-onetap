'use strict';

const assert = require('assert');
const { mapKlines } = require('../hunter_core_v1/binance_public');
const { mapCandles, aggregateOi15m, aggregateTaker15m } = require('../hunter_core_v1/okx_public');

const now = 1_000_000;
const binanceRows = [
  [0,'1','2','0.5','1.5','10',900000],
  [1,'1','2','0.5','1.6','11',1100000]
];
const bk = mapKlines(binanceRows, now);
assert.strictEqual(bk.length, 1);
assert.strictEqual(bk[0].close, 1.5);

const okxRows = [
  ['2000','1','2','0.5','1.6','10','0','0','0'],
  ['1000','1','2','0.5','1.5','10','0','0','1']
];
const ok = mapCandles(okxRows);
assert.strictEqual(ok.length, 1);
assert.strictEqual(ok[0].openTime, 1000);

const oi = aggregateOi15m([
  {time:1,value:10},{time:2,value:11},{time:3,value:12},
  {time:4,value:13},{time:5,value:14},{time:6,value:15}
]);
assert.deepStrictEqual(oi.map((x) => x.value), [12,15]);

const taker = aggregateTaker15m([
  {time:1,buyVol:2,sellVol:1},{time:2,buyVol:2,sellVol:1},{time:3,buyVol:2,sellVol:1}
]);
assert.strictEqual(taker.length, 1);
assert.strictEqual(taker[0].buySellRatio, 2);

console.log('hunter_market_data tests: PASS');
