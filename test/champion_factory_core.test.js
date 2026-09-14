'use strict';
const assert=require('node:assert');
const cf=require('../champion_factory_core');

assert.equal(cf.classifyRegime({er:.45,mom:20,vol:10}),'TREND');
assert.equal(cf.classifyRegime({er:.10,mom:2,vol:5}),'RANGE');
assert.equal(cf.classifyRegime({er:.30,mom:18,vol:10}),'BREAKOUT');
assert.equal(cf.classifyRegime({er:.20,mom:2,vol:22}),'HIGH_VOL');

const good={n:140,expectancy:.22,pf:1.7,dd:4.2,lcb90:.06,symbolConcentration:.30,regimeConcentration:.45,symbolDiversity:.8,regimeDiversity:.75,stability:.8};
const bad={...good,n:12};
assert.equal(cf.evaluateChampion(good).eligible,true);
assert.equal(cf.evaluateChampion(bad).eligible,false);

const portfolio=cf.selectPortfolio([
  {id:'B1',role:'BALANCED',stats:good},
  {id:'T1',role:'TREND',stats:{...good,expectancy:.25}}
]);
const d=cf.routeDecision({market:{er:.5,mom:22,vol:9},portfolio});
assert.equal(d.action,'USE_CHAMPION');
assert.equal(d.championId,'T1');

const none=cf.routeDecision({market:{er:.1,mom:1,vol:4},portfolio:{BALANCED:{id:'B0',role:'BALANCED',stats:bad,proof:cf.evaluateChampion(bad)}}});
assert.equal(none.action,'NO_TRADE');
console.log('champion_factory_core tests passed');
