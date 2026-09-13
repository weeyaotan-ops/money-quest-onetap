(async()=>{
  const V3='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/main/recovery_loader_v3.js';
  const r=await fetch(V3);
  if(!r.ok) throw new Error('V4_FALLBACK_FETCH_'+r.status);
  const src=await r.text();
  console.log('ONETAP_V4_SAFE_FALLBACK_TO_V3',src.length);
  eval(src);
})().catch(e=>{console.error('ONETAP_V4_SAFE_FALLBACK_ERR',e&&e.stack||e);process.exit(1)});
