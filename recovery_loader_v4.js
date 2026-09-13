(async()=>{
  const SRC='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/main/exact_mirror_gateway.js';
  const r=await fetch(SRC,{cache:'no-store'});
  if(!r.ok) throw new Error('EXACT_MIRROR_FETCH_'+r.status);
  const src=await r.text();
  if(!src.includes("version: 'EXACT_MIRROR_V1'")||!src.includes("strategyGate: 'NONE'")) throw new Error('EXACT_MIRROR_SOURCE_INVALID');
  console.log('EXACT_MIRROR_LOADER',src.length);
  eval(src);
})().catch(e=>{console.error('EXACT_MIRROR_BOOT_ERR',e&&e.stack||e);process.exit(1)});
