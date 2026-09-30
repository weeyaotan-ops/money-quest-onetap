'use strict';

const binance = require('./binance_public');
const okx = require('./okx_public');

async function snapshot(symbol) {
  try {
    const s = await binance.snapshot(symbol);
    return { ...s, provider: 'BINANCE' };
  } catch (binanceError) {
    console.warn(JSON.stringify({
      provider: 'BINANCE',
      symbol,
      status: 'FALLBACK',
      error: binanceError.message
    }));
    const s = await okx.snapshot(symbol);
    return { ...s, fallbackReason: binanceError.message };
  }
}

module.exports = { snapshot };
