(async()=>{
  const BASE='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/c5b70fbec00e4288835e25905ba455d6e610b52b/binance_onetap_gateway.js';
  const r=await fetch(BASE);
  if(!r.ok) throw new Error('V4_BASE_FETCH_'+r.status);
  const src=await r.text();
  console.log('ONETAP_V4_SAFE_BASE_FALLBACK',src.length);
  eval(src);
})().catch(e=>{console.error('ONETAP_V4_SAFE_BASE_ERR',e&&e.stack||e);process.exit(1)});
