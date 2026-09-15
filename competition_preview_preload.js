'use strict';
/*
 * Compatibility marker only.
 * /competition-preview is now implemented inside binance_onetap_gateway.js
 * and calls the exact same preview(ticket, true) used immediately before
 * live execution. Keeping this preload avoids changing boot wiring while
 * removing the old duplicated approximate preflight implementation.
 */
console.log('COMPETITION_PREFLIGHT_READY',JSON.stringify({route:'/competition-preview',readOnly:true,mode:'EXACT_GATEWAY_PREVIEW',duplicatedLogic:false}));
