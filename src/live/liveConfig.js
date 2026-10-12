const { getSupabase } = require('./supabaseClient');
const staticConfig = require('../config');

// Live, adjustable settings. Falls back to the static .env-based defaults if
// Supabase isn't configured, so the engine still runs standalone.
let cached = {
  paused: false,
  enableSolana: staticConfig.ENABLE_SOLANA,
  enableBsc: staticConfig.ENABLE_BSC,
  minRecommendTier: 'LOW_MEDIUM', // 'LOW' | 'LOW_MEDIUM' | 'ANY'
  maxTokensPerDay: Math.max(staticConfig.MAX_TOKENS_PER_DAY, 50),
  maxDevPercent: 99, // 99 ≈ off
  maxTop10Percent: 99, // 99 ≈ off
  capitalPct: staticConfig.CAPITAL_PCT,
  maxPositionSol: staticConfig.MAX_POSITION_SOL,
  bscCapitalPct: staticConfig.BSC_CAPITAL_PCT,
  bscMaxPositionBnb: staticConfig.BSC_MAX_POSITION_BNB,
  takeProfitPct: 0, // 0 = auto by risk tier
  stopLossPct: 0, // 0 = auto by risk tier
  maxHoldMin: 0, // 0 = auto by risk tier
  maxRiskScore: 100,
  heartbeatMin: Number(process.env.HEARTBEAT_MIN || 60), // 0 = off
  // Limits used for MEDIUM (and worse) tier tokens. LOW-tier tokens use maxDev/maxTop10.
  mediumMaxDevPercent: 99,
  mediumMaxTop10Percent: 99,
  mediumMaxScore: 100,
  // BSC-only
  maxBuyTaxPct: 50,
  maxSellTaxPct: 50,
  minMarketCapUsd: 0, // 0 = off
  minAgeSec: staticConfig.MIN_TOKEN_AGE_SEC, // wait until the coin is at least this many seconds old
  maxAgeDays: staticConfig.MAX_TOKEN_AGE_DAYS, // never buy coins older than this (max 20)
  maxSingleHolderPercent: 0, // 0 = off
  maxHighOwnershipPercent: 0, // 0 = off
  blockMintAuthority: false,
  blockCreatorRug: false,
  launchpadPumpfun: true,
  launchpadLaunchlab: true,
  launchpadMeteora: true,
  launchpadMoonshot: true,
  launchpadBoop: true,
  // Execution (starting values come from .env; all editable live in Telegram → Execution)
  maxPositions: staticConfig.MAX_CONCURRENT_POSITIONS,
  bscMaxPositions: staticConfig.BSC_MAX_CONCURRENT_POSITIONS,
  slippagePct: staticConfig.SLIPPAGE_BPS / 100, // Solana buys
  exitSlippagePct: staticConfig.EXIT_SLIPPAGE_PCT, // Solana sells
  bscSlippagePct: staticConfig.BSC_SLIPPAGE_BPS / 100,
  priorityFeeLamports: staticConfig.PRIORITY_FEE_LAMPORTS,
  entryCooldownSec: staticConfig.ENTRY_COOLDOWN_SEC,
  // Learning mode: 'off' | 'suggest' | 'auto' (see src/learning/learner.js)
  learningMode: 'suggest',
  learningMinTrades: 20,
};

// camelCase key -> bot_config column. `type` drives conversion in mapRow.
const SCHEMA = {
  paused: ['paused', 'bool'],
  enableSolana: ['enable_solana', 'bool'],
  enableBsc: ['enable_bsc', 'bool'],
  minRecommendTier: ['min_recommend_tier', 'str'],
  maxTokensPerDay: ['max_tokens_per_day', 'num'],
  maxDevPercent: ['max_dev_percent', 'num'],
  maxTop10Percent: ['max_top10_percent', 'num'],
  capitalPct: ['capital_pct', 'num'],
  maxPositionSol: ['max_position_sol', 'num'],
  bscCapitalPct: ['bsc_capital_pct', 'num'],
  bscMaxPositionBnb: ['bsc_max_position_bnb', 'num'],
  takeProfitPct: ['take_profit_pct', 'num'],
  stopLossPct: ['stop_loss_pct', 'num'],
  maxHoldMin: ['max_hold_min', 'num'],
  maxRiskScore: ['max_risk_score', 'num'],
  heartbeatMin: ['heartbeat_min', 'num'],
  mediumMaxDevPercent: ['medium_max_dev_percent', 'num'],
  mediumMaxTop10Percent: ['medium_max_top10_percent', 'num'],
  mediumMaxScore: ['medium_max_score', 'num'],
  maxBuyTaxPct: ['max_buy_tax_pct', 'num'],
  maxSellTaxPct: ['max_sell_tax_pct', 'num'],
  minMarketCapUsd: ['min_market_cap_usd', 'num'],
  minAgeSec: ['min_age_sec', 'num'],
  maxAgeDays: ['max_age_days', 'num'],
  maxSingleHolderPercent: ['max_single_holder_percent', 'num'],
  maxHighOwnershipPercent: ['max_high_ownership_percent', 'num'],
  blockMintAuthority: ['block_mint_authority', 'bool'],
  blockCreatorRug: ['block_creator_rug', 'bool'],
  launchpadPumpfun: ['launchpad_pumpfun', 'bool'],
  launchpadLaunchlab: ['launchpad_launchlab', 'bool'],
  launchpadMeteora: ['launchpad_meteora', 'bool'],
  launchpadMoonshot: ['launchpad_moonshot', 'bool'],
  launchpadBoop: ['launchpad_boop', 'bool'],
  maxPositions: ['max_positions', 'num'],
  bscMaxPositions: ['bsc_max_positions', 'num'],
  slippagePct: ['slippage_pct', 'num'],
  exitSlippagePct: ['exit_slippage_pct', 'num'],
  bscSlippagePct: ['bsc_slippage_pct', 'num'],
  priorityFeeLamports: ['priority_fee_lamports', 'num'],
  entryCooldownSec: ['entry_cooldown_sec', 'num'],
  learningMode: ['learning_mode', 'str'],
  learningMinTrades: ['learning_min_trades', 'num'],
};

const COLUMNS = Object.fromEntries(Object.entries(SCHEMA).map(([k, [col]]) => [k, col]));

// Columns that exist only after a migration. Until it has been run, these live
// in memory only (they still work, they just reset on restart).
const CORE_KEYS = [
  'paused', 'enableSolana', 'enableBsc', 'minRecommendTier', 'maxTokensPerDay',
  'maxDevPercent', 'maxTop10Percent', 'capitalPct', 'maxPositionSol', 'bscCapitalPct', 'bscMaxPositionBnb',
];
const MIGRATION_KEYS = Object.keys(SCHEMA).filter((k) => !CORE_KEYS.includes(k));
let migrated = true;

function convert(type, v) {
  if (type === 'bool') return Boolean(v);
  if (type === 'num') return Number(v);
  return String(v);
}

function mapRow(row) {
  if (!row) return cached;
  migrated = MIGRATION_KEYS.every((k) => row[COLUMNS[k]] !== undefined);
  const out = {};
  for (const [key, [col, type]] of Object.entries(SCHEMA)) {
    out[key] = row[col] === undefined || row[col] === null ? cached[key] : convert(type, row[col]);
  }
  return out;
}

async function refresh() {
  const supabase = getSupabase();
  if (!supabase) return cached;
  const { data, error } = await supabase.from('bot_config').select('*').eq('id', 1).single();
  if (error) {
    console.error('[live-config] refresh failed, keeping last known values:', error.message);
    return cached;
  }
  cached = mapRow(data);
  return cached;
}

function getConfig() {
  return cached;
}

// Applies a change to the in-memory config immediately. Used when Supabase
// isn't configured, and after a Supabase write so the value shown is never stale.
function applyLocal(patch) {
  cached = { ...cached, ...patch };
  return cached;
}

// Call once at boot: initial fetch, then realtime updates + a 15s poll fallback.
async function start() {
  const supabase = getSupabase();
  if (!supabase) {
    console.log('[live-config] Supabase not configured — running on static .env config only. Settings changed in Telegram last until restart.');
    return;
  }

  await refresh();
  console.log('[live-config] loaded from Supabase:', JSON.stringify(cached));

  supabase
    .channel('bot_config_changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bot_config' }, (payload) => {
      cached = mapRow(payload.new);
      console.log('[live-config] updated live:', JSON.stringify(cached));
    })
    .subscribe();

  setInterval(refresh, 15000);
}

// False when Supabase is configured but the newest migration hasn't been run.
const isMigrated = () => migrated;

module.exports = { start, getConfig, refresh, applyLocal, COLUMNS, MIGRATION_KEYS, isMigrated };
