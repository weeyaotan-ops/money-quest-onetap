(async()=>{
  const SRC='https://raw.githubusercontent.com/weeyaotan-ops/money-quest-onetap/exact-mirror-resting-v2/resting_limit_loader_v2_candidate.js';
  const r=await fetch(SRC,{cache:'no-store'});
  if(!r.ok) throw new Error('CALLBACKFIX_FETCH_'+r.status);
  let loader=await r.text();

  const needle="  console.log('EXACT_MIRROR_RESTING_V2_LOADER',src.length);\n  eval(src);";
  if(!loader.includes(needle)) throw new Error('CALLBACKFIX_PATCH_MISS_LOADER_TAIL');

  const injected=`  const callbackOld = "      if (u.callback_query) await handleCallback(u.callback_query);";\n  const callbackNew = "      if (u.callback_query) void handleCallback(u.callback_query).catch(e => console.error('EXACT_MIRROR_CALLBACK_ERR', String(e.message || e)));";\n  if(!src.includes(callbackOld)) throw new Error('CALLBACKFIX_PATCH_MISS_DISPATCH');\n  src = src.replace(callbackOld, callbackNew);\n  console.log('EXACT_MIRROR_CALLBACK_ASYNC_FIX_ENABLED');\n  console.log('EXACT_MIRROR_RESTING_V2_LOADER',src.length);\n  eval(src);`;

  loader=loader.replace(needle,injected);
  eval(loader);
})().catch(e=>{console.error('EXACT_MIRROR_CALLBACKFIX_BOOT_ERR',e&&e.stack||e);process.exit(1)});
