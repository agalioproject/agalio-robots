require('dotenv').config();

function num(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
}

function list(name) {
  return String(process.env[name] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Free public RPCs. You can put any RPC here (paid ones too) via RPC_URLS.
// The bot rotates between them and skips one for a while when it rate-limits.
const DEFAULT_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

const rpcFromEnv = list('RPC_URLS').concat(list('RPC_URL'));

// SAFE DEFAULT — only DRY_RUN=false enables real trades
const DRY_RUN = process.env.DRY_RUN !== 'false';

module.exports = {
  VERSION: '3.4.0',
  DRY_RUN,

  RPC_URLS: rpcFromEnv.length ? rpcFromEnv : DEFAULT_RPC_URLS,
  PUMPPORTAL_TRADE_URL: process.env.PUMPPORTAL_TRADE_URL || 'https://pumpportal.fun/api/trade-local',

  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || null,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,

  SOL_MINT: 'So11111111111111111111111111111111111111112',

  // ---- STARTING values for settings you can change live in Telegram (Settings menu) ----
  // These env values are only the first value; once you change something in Telegram, that wins.
  MIN_POSITION_SOL: num('MIN_POSITION_SOL', 0.02),
  SOL_FEE_RESERVE: num('SOL_FEE_RESERVE', 0.03),
  MAX_CONCURRENT: num('MAX_CONCURRENT', 1),
  MAX_DAILY_LOSS_PCT: num('MAX_DAILY_LOSS_PCT', 25),

  // ---- execution ----
  BUY_SLIPPAGE_PCT: num('BUY_SLIPPAGE_PCT', 15),
  BUY_PRIORITY_FEE_SOL: num('BUY_PRIORITY_FEE_SOL', 0.0003),
  SELL_SLIPPAGE_PCT: num('SELL_SLIPPAGE_PCT', 30),
  SELL_SLIPPAGE_STEP_PCT: num('SELL_SLIPPAGE_STEP_PCT', 10),
  SELL_SLIPPAGE_MAX_PCT: num('SELL_SLIPPAGE_MAX_PCT', 55),
  SELL_PRIORITY_FEE_SOL: num('SELL_PRIORITY_FEE_SOL', 0.0003),
  SELL_RETRIES: num('SELL_RETRIES', 6),
  STUCK_RETRY_MS: num('STUCK_RETRY_MS', 60000),
  BUY_CONFIRM_TIMEOUT_MS: num('BUY_CONFIRM_TIMEOUT_MS', 20000),
  SELL_CONFIRM_TIMEOUT_MS: num('SELL_CONFIRM_TIMEOUT_MS', 15000),
  REBROADCAST_MS: num('REBROADCAST_MS', 1000),

  // ---- entry safety (starting value; live switch in Settings → Entry filters) ----
  REQUIRE_NO_AUTHORITIES: bool('REQUIRE_NO_AUTHORITIES', true),

  EXIT_COST_PCT: num('EXIT_COST_PCT', 2),

  IGNORE_MINTS: list('IGNORE_MINTS'),

  PRICE_POLL_MS: num('PRICE_POLL_MS', 8000),

  // ---- paper trading (DRY_RUN=true) ----
  DRY_RUN_BALANCE_SOL: num('DRY_RUN_BALANCE_SOL', 1),
  PAPER_FRICTION_PCT: num('PAPER_FRICTION_PCT', 2),
  DRY_RUN_ROUTE_CHECK: bool('DRY_RUN_ROUTE_CHECK', false),

  // ---- persistence ----
  STATE_DIR: process.env.STATE_DIR || 'data',
  SUPABASE_URL: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
};
