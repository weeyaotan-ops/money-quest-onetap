'use strict';

const assert = require('node:assert/strict');
const {
  strategyMetrics,
  pairedBlockBootstrap,
  summarizePairedBootstrap
} = require('../research/hunter_reborn_bootstrap');

{
  const m = strategyMetrics([0.01, -0.005, 0.012, -0.002]);
  assert.ok(Number.isFinite(m.cagr));
  assert.ok(m.maxDrawdown <= 0);
  assert.ok(Number.isFinite(m.sharpe));
}

{
  const core = [];
  const defensive = [];
  for (let i = 0; i < 240; i += 1) {
    const shock = i % 25 === 0 ? -0.08 : (i % 7 === 0 ? 0.025 : 0.002);
    core.push(shock);
    defensive.push(shock * 0.45);
  }

  const a = pairedBlockBootstrap(core, defensive, {
    blockLength: 7,
    replicates: 300,
    seed: 12345
  });
  const b = pairedBlockBootstrap(core, defensive, {
    blockLength: 7,
    replicates: 300,
    seed: 12345
  });

  assert.deepEqual(a, b);

  const s = summarizePairedBootstrap(a);
  assert.equal(s.replicates, 300);
  assert.ok(s.paired.defensiveShallowerDrawdownRate > 0.95);
  assert.ok(s.defensive.maxDrawdown.median > s.core.maxDrawdown.median);
}

console.log('HUNTER_REBORN_BOOTSTRAP_TESTS_OK');
