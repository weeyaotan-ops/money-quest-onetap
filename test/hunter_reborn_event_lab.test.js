'use strict';

const assert = require('node:assert/strict');
const {
  buildResearchConfigs,
  extractObservations,
  summarize,
  discover
} = require('../research/hunter_reborn_event_lab');

assert.equal(buildResearchConfigs().length, 20);

function baseSeries(n = 260) {
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    const small = i >= 142 && i < 150;
    const range = small ? 0.20 : 1.00;
    const o = px;
    const c = px + (i % 2 ? 0.05 : -0.05);
    out.push({ ts: i * 3_600_000, o, h: Math.max(o, c) + range / 2, l: Math.min(o, c) - range / 2, c, v: 100 + (i % 7) });
    px = c;
  }
  return out;
}

{
  const candles = baseSeries();
  candles[150] = { ts: 150 * 3_600_000, o: 100, h: 103.2, l: 99.9, c: 103.0, v: 250 };
  candles[151] = { ts: 151 * 3_600_000, o: 103.0, h: 104.2, l: 102.8, c: 104.0, v: 180 };
  candles[152] = { ts: 152 * 3_600_000, o: 104.0, h: 105.2, l: 103.8, c: 105.0, v: 180 };
  const onlyCR = [{ family: 'COMPRESSION_RELEASE', key: 'CR_TEST', q: 0.90, compressionRatio: 0.80 }];
  const x = extractObservations(candles, { configs: onlyCR, horizons: [1, 2], costBps: 0 });
  const hit = x.observations.filter(o => o.config === 'CR_TEST' && o.ts === 150 * 3_600_000);
  assert.equal(hit.length, 2);
  assert.ok(hit.every(o => o.side === 'LONG'));
  assert.ok(hit.every(o => o.netBps > 0));
}

{
  const s = summarize([{ netBps: 20 }, { netBps: -10 }, { netBps: 30 }, { netBps: -5 }]);
  assert.equal(s.n, 4);
  assert.equal(s.meanBps, 8.75);
  assert.equal(s.winRate, 0.5);
  assert.ok(s.profitFactor > 3);
}

{
  const candles = baseSeries(500);
  assert.doesNotThrow(() => discover(candles, { horizons: [1, 2], minTrainN: 10 }));
}

console.log('HUNTER_REBORN_EVENT_LAB_TESTS_OK');
