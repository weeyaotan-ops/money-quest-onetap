'use strict';
// Shadow comparison only: collects candidate funnel metrics without trading or Telegram.
// Run with: node hunter_core_v1/v21_shadow_report.js <path-to-jsonl>
const fs=require('node:fs');
function summarize(lines){
 const stats={scans:0,watch:0,oldCandidates:0,newCandidates:0,newEligible:0,rejected:{},byMode:{}};
 for(const item of lines){
  if(!item||typeof item!=='object')continue;
  stats.scans++;
  stats.watch+=Array.isArray(item.armed)?item.armed.length:0;
  stats.oldCandidates+=Array.isArray(item.candidates)?item.candidates.length:0;
  for(const s of (Array.isArray(item.v21Candidates)?item.v21Candidates:[])){
   stats.newCandidates++;
   stats.byMode[s.mode||'UNKNOWN']=(stats.byMode[s.mode||'UNKNOWN']||0)+1;
   if(s.status==='SHADOW_CANDIDATE')stats.newEligible++;
   else stats.rejected[s.reason||'UNKNOWN']=(stats.rejected[s.reason||'UNKNOWN']||0)+1;
  }
 }
 return stats;
}
if(require.main===module){
 const file=process.argv[2];
 if(!file){console.error('Usage: node v21_shadow_report.js <jsonl>');process.exitCode=2;}
 else {
  const data=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  console.log(JSON.stringify(summarize(data),null,2));
 }
}
module.exports={summarize};
