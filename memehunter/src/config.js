const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (name, fallback = false) => {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const C = Object.freeze({
  PORT: num('PORT', 3000),
  LIVE_TRADING: bool('LIVE_TRADING', false),
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  JUPITER_API_KEY: process.env.JUPITER_API_KEY || '',
  BS58_PRIVATE_KEY: process.env.BS58_PRIVATE_KEY || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',

  TRADE_USDC: Math.max(1, num('TRADE_USDC', 5)),
  MAX_OPEN_POSITIONS: Math.max(1, Math.floor(num('MAX_OPEN_POSITIONS', 1))),
  MAX_TRADES_PER_DAY: Math.max(1, Math.floor(num('MAX_TRADES_PER_DAY', 6))),
  MAX_DAILY_LOSS_USDC: Math.max(1, num('MAX_DAILY_LOSS_USDC', 15)),
  MIN_SOL_GAS: Math.max(0.005, num('MIN_SOL_GAS', 0.02)),
  REENTRY_COOLDOWN_HOURS: Math.max(1, num('REENTRY_COOLDOWN_HOURS', 24)),

  SCAN_MS: Math.max(10_000, num('SCAN_MS', 15_000)),
  POSITION_POLL_MS: Math.max(3_000, num('POSITION_POLL_MS', 5_000)),
  MAX_CANDIDATES_PER_SCAN: Math.max(1, Math.floor(num('MAX_CANDIDATES_PER_SCAN', 3))),

  MIN_PAIR_AGE_MIN: Math.max(0, num('MIN_PAIR_AGE_MIN', 3)),
  MAX_PAIR_AGE_MIN: Math.max(5, num('MAX_PAIR_AGE_MIN', 180)),
  MIN_LIQUIDITY_USD: Math.max(1_000, num('MIN_LIQUIDITY_USD', 25_000)),
  MIN_M5_VOLUME_USD: Math.max(0, num('MIN_M5_VOLUME_USD', 5_000)),
  MIN_M5_BUYS: Math.max(1, Math.floor(num('MIN_M5_BUYS', 15))),
  MIN_BUY_SELL_RATIO: Math.max(0.1, num('MIN_BUY_SELL_RATIO', 1.35)),
  MIN_M5_PRICE_CHANGE_PCT: num('MIN_M5_PRICE_CHANGE_PCT', 3),
  MAX_M5_PRICE_CHANGE_PCT: num('MAX_M5_PRICE_CHANGE_PCT', 60),
  MIN_FDV_USD: Math.max(0, num('MIN_FDV_USD', 50_000)),
  MAX_FDV_USD: Math.max(1, num('MAX_FDV_USD', 3_000_000)),
  MIN_LIQUIDITY_FDV_RATIO: Math.max(0, num('MIN_LIQUIDITY_FDV_RATIO', 0.05)),

  REQUIRE_REVOKED_MINT_AUTHORITY: bool('REQUIRE_REVOKED_MINT_AUTHORITY', true),
  REQUIRE_REVOKED_FREEZE_AUTHORITY: bool('REQUIRE_REVOKED_FREEZE_AUTHORITY', true),
  ALLOW_TOKEN_2022: bool('ALLOW_TOKEN_2022', false),
  MAX_TOP1_HOLDER_PCT: Math.min(100, Math.max(0, num('MAX_TOP1_HOLDER_PCT', 95))),
  MAX_TOP5_HOLDER_PCT: Math.min(100, Math.max(0, num('MAX_TOP5_HOLDER_PCT', 99.5))),

  MAX_ROUNDTRIP_LOSS_PCT: Math.max(0.5, num('MAX_ROUNDTRIP_LOSS_PCT', 5)),
  MAX_ENTRY_QUOTE_DETERIORATION_PCT: Math.max(0.5, num('MAX_ENTRY_QUOTE_DETERIORATION_PCT', 3)),

  STOP_LOSS_PCT: Math.max(1, num('STOP_LOSS_PCT', 8)),
  TAKE_PROFIT_PCT: Math.max(1, num('TAKE_PROFIT_PCT', 15)),
  TRAILING_ARM_PCT: Math.max(1, num('TRAILING_ARM_PCT', 10)),
  TRAILING_GIVEBACK_PCT: Math.max(1, num('TRAILING_GIVEBACK_PCT', 5)),
  MAX_HOLD_MIN: Math.max(1, num('MAX_HOLD_MIN', 20)),
  MAX_SELL_ROUTE_FAILURES: Math.max(1, Math.floor(num('MAX_SELL_ROUTE_FAILURES', 3))),
});

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;
