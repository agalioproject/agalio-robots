const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN, PRICE_POLL_INTERVAL_MS } = require('../config');
const { getSupabase } = require('../live/supabaseClient');
const { analyzeAddress, SOL_CA_RE, EVM_CA_RE } = require('./analyze');
const { getConfig, refresh, applyLocal, COLUMNS, MIGRATION_KEYS, isMigrated } = require('../live/liveConfig');
const { getDailyCount } = require('../analysis/dailyLimiter');
const { scannerText, positionsText, heartbeatText, scannerHeadline, balanceText } = require('./reports');
const runtime = require('../live/runtime');
const learner = require('../learning/learner');
const debull = require('../knowledge/debull');

let bot = null;

function getBot() {
  if (!TELEGRAM_BOT_TOKEN) return null;
  if (bot) return bot;
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  return bot;
}

// ---------------------------------------------------------------------
// Adjustable numeric settings. Each one gets: a value-picker screen with
// presets and -/+ buttons, a "type your own value" option, and a slash
// command (e.g. /setcapital 12.5). Add a new entry here and it shows up
// everywhere automatically.
// ---------------------------------------------------------------------
const SETTINGS = {
  capitalPct: {
    cmd: 'setcapital',
    title: '🟣 Solana — capital per trade',
    unit: '%',
    min: 0.01,
    max: 100,
    presets: [1, 2, 5, 10, 25, 50, 75, 100],
    steps: [1, 5],
    parent: 'm:cap',
    warnAbove: 25,
    describe: (c) => `Each Solana buy uses this % of your SOL balance. ${capNote(c.maxPositionSol, 'SOL')} A small SOL reserve is always kept for fees.`,
  },
  bscCapitalPct: {
    cmd: 'setbsccapital',
    title: '🟡 BSC — capital per trade',
    unit: '%',
    min: 0.01,
    max: 100,
    presets: [1, 2, 5, 10, 25, 50, 75, 100],
    steps: [1, 5],
    parent: 'm:cap',
    warnAbove: 25,
    describe: (c) => `Each BSC buy uses this % of your BNB balance. ${capNote(c.bscMaxPositionBnb, 'BNB')} A small BNB reserve is always kept for gas.`,
  },
  maxPositionSol: {
    cmd: 'setmaxpos',
    title: '🟣 Solana — max per trade',
    unit: ' SOL',
    min: 0,
    max: 100000,
    zeroLabel: 'No cap',
    presets: [0, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    steps: [0.05, 0.25],
    parent: 'm:cap',
    describe: (c) => `Hard ceiling on one Solana buy, no matter what the capital % says (now ${fmt(c.capitalPct)}% of balance). Choose No cap to let the % alone decide the size.`,
  },
  bscMaxPositionBnb: {
    cmd: 'setbscmaxpos',
    title: '🟡 BSC — max per trade',
    unit: ' BNB',
    min: 0,
    max: 100000,
    zeroLabel: 'No cap',
    presets: [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    steps: [0.01, 0.05],
    parent: 'm:cap',
    describe: (c) => `Hard ceiling on one BSC buy, no matter what the capital % says (now ${fmt(c.bscCapitalPct)}% of balance). Choose No cap to let the % alone decide the size.`,
  },
  maxTokensPerDay: {
    cmd: 'setmax',
    title: '🎯 Daily limit',
    unit: '',
    min: 1,
    max: 100,
    int: true,
    presets: [1, 2, 3, 5, 10, 20, 50, 100],
    steps: [1, 5],
    parent: 'menu',
    describe: (c) => `Max tokens recommended (and traded) per UTC day. Used today: ${getDailyCount()}/${c.maxTokensPerDay}.`,
  },
  takeProfitPct: {
    cmd: 'settp',
    title: '🎯 Take profit',
    unit: '%',
    min: 0,
    max: 10000,
    zeroLabel: 'Auto',
    zeroIcon: '🤖',
    zeroWord: 'auto',
    presets: [0, 5, 10, 15, 20, 30, 50, 100],
    steps: [1, 5],
    parent: 'm:exit',
    describe: (c) =>
      c.takeProfitPct > 0
        ? `The bot sells the WHOLE position as soon as profit reaches +${fmt(c.takeProfitPct)}%, on every trade. Applies to open positions immediately.\n\nTip: positions are also sold when the max hold time runs out (now ${c.maxHoldMin > 0 ? fmt(c.maxHoldMin) + ' min' : 'auto: ' + autoHold() + ' min by risk tier'}) — raise it under Max hold if your target needs longer.`
        : `Auto: each token gets a target from its risk tier (${autoPlanText()}). Pick a % to use your own target on every trade instead.`,
  },
  stopLossPct: {
    cmd: 'setsl',
    title: '🛑 Stop loss',
    unit: '%',
    min: 0,
    max: 99,
    zeroLabel: 'Auto',
    zeroIcon: '🤖',
    zeroWord: 'auto',
    presets: [0, 10, 15, 20, 25, 30, 40, 50],
    steps: [1, 5],
    parent: 'm:exit',
    describe: (c) =>
      c.stopLossPct > 0
        ? `The bot sells the WHOLE position if it falls ${fmt(c.stopLossPct)}% below your entry. Applies to open positions immediately.`
        : `Auto: every tier uses ${debull.STOP_LOSS_PCT}%. Pick a % to use your own stop on every trade instead.`,
  },
  maxHoldMin: {
    cmd: 'setmaxhold',
    title: '⏱ Max hold time',
    unit: ' min',
    min: 0,
    max: 1440,
    zeroLabel: 'Auto',
    zeroIcon: '🤖',
    zeroWord: 'auto',
    presets: [0, 5, 10, 20, 30, 60, 120, 240],
    steps: [1, 5],
    parent: 'm:exit',
    describe: () => `If neither take-profit nor stop-loss has fired by then, the bot sells anyway. Auto: ${autoHold()} minutes.`,
  },
  minMarketCapUsd: {
    cmd: 'setminmcap',
    title: '💵 Min market cap (DexScreener)',
    unit: '$',
    min: 0,
    max: 500000,
    presets: [0, 5000, 10000, 25000, 50000, 69000],
    steps: [1000, 5000],
    parent: 'm:filters',
    zeroLabel: 'Off',
    describe: (c) => `Only enter if DexScreener MC ≥ this. 0 = off (no MC gate).`,
  },
  maxPositions: {
    cmd: 'setmaxopen',
    title: '🟣 Max open positions (Solana)',
    unit: '',
    min: 1,
    max: 10,
    int: true,
    presets: [1, 2, 3, 5, 10],
    steps: [1],
    parent: 'm:exec',
    describe: () => `How many Solana positions can be open at once. Each uses its own % of your balance, so more positions = more total money at risk.`,
  },
  bscMaxPositions: {
    cmd: 'setbscmaxopen',
    title: '🟡 Max open positions (BSC)',
    unit: '',
    min: 1,
    max: 10,
    int: true,
    presets: [1, 2, 3, 5, 10],
    steps: [1],
    parent: 'm:exec',
    describe: () => `How many BSC positions can be open at once.`,
  },
  slippagePct: {
    cmd: 'setslippage',
    title: '🟣 Buy slippage (Solana)',
    unit: '%',
    min: 1,
    max: 50,
    presets: [5, 10, 15, 25, 35, 50],
    steps: [1, 5],
    parent: 'm:exec',
    describe: () => `How much worse than the quote a Solana BUY may fill. pump.fun curves move fast — much below ~25% often fails with "TooMuchSolRequired"; higher fills more often but at a worse price.`,
  },
  exitSlippagePct: {
    cmd: 'setexitslippage',
    title: '🟣 Sell slippage (Solana)',
    unit: '%',
    min: 1,
    max: 50,
    presets: [10, 15, 25, 35, 50],
    steps: [1, 5],
    parent: 'm:exec',
    describe: () => `How much worse than the quote a Solana SELL may fill. Keep this generous — a stop-loss that can't fill isn't a stop-loss.`,
  },
  bscSlippagePct: {
    cmd: 'setbscslippage',
    title: '🟡 Slippage (BSC)',
    unit: '%',
    min: 0.1,
    max: 49,
    presets: [3, 5, 7, 10, 15, 25],
    steps: [1, 5],
    parent: 'm:exec',
    describe: () => `Maximum slippage on PancakeSwap buys and sells. Fresh pools are thin; too low = failed trades, too high = worse fills.`,
  },
  priorityFeeLamports: {
    cmd: 'setpriorityfee',
    title: '⚡ Priority fee (Solana)',
    unit: ' lamports',
    min: 0,
    max: 5000000,
    int: true,
    presets: [10000, 50000, 100000, 500000, 1000000],
    steps: [10000, 100000],
    parent: 'm:exec',
    describe: () => `Extra fee that gets your transaction in faster. 100,000 lamports = 0.0001 SOL. Higher = more reliable sniping, costs more per trade.`,
  },
  entryCooldownSec: {
    cmd: 'setcooldown',
    title: '⏳ Entry cooldown (Solana)',
    unit: 's',
    min: 0,
    max: 300,
    int: true,
    presets: [0, 5, 15, 30, 60, 120],
    steps: [5, 15],
    parent: 'm:exec',
    zeroLabel: 'Off',
    describe: () => `Minimum gap between Solana buy attempts. Stops the bot spamming buys after failures. 0 = no gap.`,
  },
  minAgeSec: {
    cmd: 'setminage',
    title: '⏱ Minimum coin age',
    unit: 's',
    min: 0,
    max: 60,
    presets: [0, 2, 5, 10, 20, 30, 60],
    steps: [1, 5],
    parent: 'm:filters',
    zeroLabel: 'Instant',
    describe: () => `The bot waits until a new coin is at least this many seconds old before buying (it holds its place in the queue while waiting). 2s skips the very first instant, where most instant rugs and bot-wars happen. 0 = buy the moment it is found.`,
  },
  maxAgeDays: {
    cmd: 'setmaxage',
    title: '📅 Maximum coin age',
    unit: ' days',
    min: 0.01,
    max: 20,
    presets: [0.25, 1, 3, 7, 14, 20],
    steps: [0.5, 1],
    parent: 'm:filters',
    describe: () => `Never buy a coin older than this (max 20 days). Decimals work: 0.5 = 12 hours. Age comes from when the bot first saw the coin, or DexScreener's pair-creation time; if neither is known the coin is allowed and the age shown as unknown.`,
  },
  maxSingleHolderPercent: {
    cmd: 'setsingle',
    title: '👤 Max single holder %',
    unit: '%',
    min: 0,
    max: 100,
    presets: [0, 15, 25, 40, 50, 100],
    steps: [5, 10],
    parent: 'm:filters',
    zeroLabel: 'Off',
    describe: () => `Reject if one non-pool wallet holds more than this %. 0 = off.`,
  },
  maxHighOwnershipPercent: {
    cmd: 'sethighown',
    title: '🏦 Max high ownership %',
    unit: '%',
    min: 0,
    max: 100,
    presets: [0, 70, 80, 90, 100],
    steps: [5, 10],
    parent: 'm:filters',
    zeroLabel: 'Off',
    describe: () => `Reject if top holders exceed this %. 0 = off.`,
  },
  maxRiskScore: {
    cmd: 'setscore',
    title: '🎚 Entry quality (max risk score)',
    unit: '',
    min: 1,
    max: 100,
    int: true,
    presets: [5, 10, 15, 20, 25, 30, 40, 50],
    steps: [1, 5],
    parent: 'm:filters',
    describe: () => `Only enter tokens whose risk score is at or below this — lower is pickier. LOW tier is ≤ 25, MEDIUM ≤ 50. Every token's score shows in 🔎 Scanner. (Tokens are taken first-come, so this is how you steer toward better ones.)`,
  },
  heartbeatMin: {
    cmd: 'setheartbeat',
    title: '📡 Heartbeat',
    unit: ' min',
    min: 0,
    max: 1440,
    int: true,
    zeroLabel: 'Off',
    zeroIcon: '🔕',
    zeroWord: 'off',
    presets: [0, 15, 30, 60, 120, 240, 360, 720],
    steps: [5, 15],
    parent: 'scan',
    describe: () => `Every N minutes the bot messages you a "still scanning" summary: is the feed alive, how many new tokens it checked, how many passed, and your open positions. Off = only alerts on real events.`,
  },
  mediumMaxDevPercent: {
    cmd: 'setmediumdev',
    title: '🎛 MEDIUM dev% allowance',
    unit: '%',
    min: 1,
    max: 100,
    presets: [30, 35, 40, 45, 50, 60, 75, 100],
    steps: [1, 5],
    parent: 'm:medium',
    describe: (c) => `A LOW-tier token still must clear your ${c.maxDevPercent}% limit. This is the LOOSER ceiling used ONLY for a token that would otherwise become MEDIUM risk — above this, it's rejected outright either way. Only matters while 🛡 Risk tier allows MEDIUM.`,
  },
  mediumMaxTop10Percent: {
    cmd: 'setmediumtop10',
    title: '🎛 MEDIUM top-10% allowance',
    unit: '%',
    min: 1,
    max: 100,
    presets: [60, 70, 80, 85, 90, 95, 100],
    steps: [1, 5],
    parent: 'm:medium',
    describe: (c) => `Same idea for top-10 holder concentration — the looser ceiling used only for MEDIUM-tier candidates. Your LOW-tier limit stays ${c.maxTop10Percent}%.`,
  },
  mediumMaxScore: {
    cmd: 'setmediumscore',
    title: '🎛 MEDIUM entry-quality ceiling',
    unit: '',
    min: 1,
    max: 100,
    int: true,
    presets: [26, 30, 35, 40, 45, 50],
    steps: [1, 5],
    parent: 'm:medium',
    describe: (c) => `A tighter version of your overall entry-quality score (≤ ${c.maxRiskScore}) that applies ONLY to MEDIUM-tier tokens. Set it below ${c.maxRiskScore} to be pickier about MEDIUM without touching LOW-tier entries.`,
  },
  maxBuyTaxPct: {
    cmd: 'setbuytax',
    title: '💸 Max buy tax (BSC)',
    unit: '%',
    min: 0,
    max: 100,
    presets: [3, 5, 8, 10, 15, 20, 30, 50],
    steps: [1, 5],
    parent: 'm:tax',
    describe: () => `Tokens with a buy tax above this are rejected outright. BSC only — Solana/pump.fun tokens don't have this concept.`,
  },
  maxSellTaxPct: {
    cmd: 'setselltax',
    title: '💸 Max sell tax (BSC)',
    unit: '%',
    min: 0,
    max: 100,
    presets: [3, 5, 8, 10, 15, 20, 30, 50],
    steps: [1, 5],
    parent: 'm:tax',
    describe: () => `Tokens with a sell tax above this are rejected outright — this is the one that actually eats into your exit, so keep it tight. BSC only.`,
  },
  learningMinTrades: {
    cmd: 'setlearnmin',
    title: '🧠 Learning — trades needed',
    unit: '',
    min: 5,
    max: 500,
    int: true,
    presets: [10, 20, 30, 50, 100, 200],
    steps: [5, 10],
    parent: 'm:learn',
    describe: () => `Learning only starts suggesting changes after this many CLOSED trades. Fewer = faster but noisier; more = slower but more trustworthy.`,
  },
  maxDevPercent: {
    cmd: 'setdev',
    title: '🔍 Max dev/creator holding',
    unit: '%',
    min: 1,
    max: 100,
    presets: [5, 10, 15, 20, 30, 40, 50, 70],
    steps: [1, 5],
    parent: 'm:filters',
    describe: () => `Tokens where the creator/owner wallet holds more than this % of supply are rejected.`,
  },
  maxTop10Percent: {
    cmd: 'settop10',
    title: '🔍 Max top-10 holders',
    unit: '%',
    min: 1,
    max: 100,
    presets: [30, 40, 50, 60, 70, 80, 90, 100],
    steps: [1, 5],
    parent: 'm:filters',
    describe: () => `Tokens where the top 10 holders control more than this % of supply are rejected.`,
  },
};

const fmt = (n) => String(Number(Number(n).toFixed(4)));
// The automatic exit plan, read from the real source so this text can never drift from what the bot does.
const autoPlanText = () =>
  ['LOW', 'MEDIUM', 'HIGH']
    .map((t) => {
      const p = debull.exitPlanFor(t);
      return `${t} +${p.takeProfitPct}% / ${p.stopLossPct}% / ${Math.round(p.maxHoldMs / 60000)} min`;
    })
    .join(' · ');
const autoHold = () => ['LOW', 'MEDIUM', 'HIGH'].map((t) => `${t} ${Math.round(debull.exitPlanFor(t).maxHoldMs / 60000)}`).join(' · ');
// Display a setting's value, e.g. "12.5%", "0.5 SOL", or "No cap" for a 0 cap.
const valText = (def, v) => (def.zeroLabel && Number(v) === 0 ? def.zeroLabel : `${fmt(v)}${def.unit}`);
const capLabel = (v, unit) => (Number(v) > 0 ? `max ${fmt(v)} ${unit}` : 'no cap');
const capNote = (v, unit) =>
  Number(v) > 0
    ? `Capped at ${fmt(v)} ${unit} per trade — the smaller of the two applies (raise or remove the cap under Max per trade).`
    : `No max-per-trade cap is set, so this % alone decides the size.`;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function validate(def, raw) {
  const n = Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(n)) return { error: 'That is not a number.' };
  if (def.int && !Number.isInteger(n)) return { error: 'Please enter a whole number.' };
  if (n < def.min || n > def.max) {
    return { error: def.zeroLabel ? `Enter a value up to ${fmt(def.max)}${def.unit}, or 0 for ${def.zeroLabel.toLowerCase()}.` : `Must be between ${fmt(def.min)} and ${fmt(def.max)}${def.unit}.` };
  }
  return { value: def.int ? n : round4(n) };
}

// Accepts "12", "12.5", "12,5", "12%", " 0.25 SOL " ... and, for cap settings,
// words like "none" / "no cap" / "off" / "unlimited" (= 0 = no cap).
function parseInput(def, text) {
  const t = String(text).trim();
  if (def.zeroLabel && /^(none|no\s*cap|nocap|off|auto|default|unlimited|no\s*limit|remove)$/i.test(t)) return '0';
  return t.replace(',', '.').replace(/\s*(%|sol|bnb)\s*$/i, '');
}

// ---------------------------------------------------------------------
// Config writes
// ---------------------------------------------------------------------
async function updateConfig(patch) {
  const supabase = getSupabase();
  if (!supabase) {
    // No Supabase: still works, but only until the next restart.
    return applyLocal(patch);
  }
  const fields = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!COLUMNS[k]) throw new Error(`Unknown setting: ${k}`);
    // Settings from migration 002 live in memory only until that SQL has been run.
    if (MIGRATION_KEYS.includes(k) && !isMigrated()) continue;
    fields[COLUMNS[k]] = v;
  }
  if (Object.keys(fields).length) {
    const { error } = await supabase.from('bot_config').update({ ...fields, updated_by: 'telegram' }).eq('id', 1);
    if (error) {
      // Missing optional columns (platforms/safety) → keep in memory so Telegram still works.
      if (!/column|schema cache|does not exist|check constraint|violates/i.test(error.message)) throw error;
      console.warn('[telegram] config column missing in Supabase — applying in memory only:', error.message);
    } else {
      // Force an immediate re-read instead of waiting on the realtime push or
      // the 15s poll, so what we show next is the true, just-applied state.
      await refresh();
    }
  }
  // Pin the values we just set so what's displayed can never be stale.
  return applyLocal(patch);
}

// If TELEGRAM_CHAT_ID isn't set, anyone who finds the bot can control it —
// set it once you know your chat ID (the bot tells you on /start) to lock
// this down to just you.
function isAuthorized(chatId) {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

// ---------------------------------------------------------------------
// Views (text + inline keyboard). Every screen has a way back.
// ---------------------------------------------------------------------
const btn = (text, data) => ({ text, callback_data: data });
const webAppBtn = (text, url) => ({ text, web_app: { url } });
const DASHBOARD_WEBAPP_URL = process.env.DASHBOARD_WEBAPP_URL || process.env.DASHBOARD_URL || '';

const view = (text, inline_keyboard) => ({ text: text.length > 4000 ? text.slice(0, 3990) + '\n…' : text, reply_markup: { inline_keyboard } });

const tierLabel = (t) => (t === 'LOW' ? 'LOW only' : t === 'ANY' ? 'Any tier' : 'LOW + MEDIUM');

function statusText(cfg) {
  const lines = [
    cfg.paused ? '⏸ TRADING STOPPED' : '🟢 TRADING LIVE',
    DRY_RUN ? 'Mode: 🧪 DRY RUN (no real trades)' : 'Mode: 🔴 LIVE (real trades)',
    '',
    `Chains: Solana ${cfg.enableSolana ? 'ON' : 'OFF'} | BSC ${cfg.enableBsc ? 'ON' : 'OFF'}`,
    `Capital per trade: ${fmt(cfg.capitalPct)}% SOL (${capLabel(cfg.maxPositionSol, 'SOL')}) | ${fmt(cfg.bscCapitalPct)}% BNB (${capLabel(cfg.bscMaxPositionBnb, 'BNB')})`,
    `Tier: ${tierLabel(cfg.minRecommendTier)} · score ≤ ${fmt(cfg.maxRiskScore)} · age ${fmt(cfg.minAgeSec)}s–${fmt(cfg.maxAgeDays)}d`,
    `Daily quota used: ${getDailyCount()}/${cfg.maxTokensPerDay}`,
    `Exit: TP ${cfg.takeProfitPct > 0 ? '+' + fmt(cfg.takeProfitPct) + '%' : 'auto'} | SL ${cfg.stopLossPct > 0 ? '−' + fmt(cfg.stopLossPct) + '%' : 'auto'} | max hold ${cfg.maxHoldMin > 0 ? fmt(cfg.maxHoldMin) + 'm' : 'auto'}`,
    `🧠 Learning: ${cfg.learningMode} (${learner.count()} trades recorded)`,
    '',
    scannerHeadline() || 'Scanner: no chain running',
    `Open positions: ${runtime.getOpenPositions().length}`,
  ];
  return lines.join('\n');
}

function mainView(cfg, banner) {
  return view((banner ? `${banner}\n\n` : '') + statusText(cfg), [
    [
      cfg.paused ? btn('▶️ Start trading', 'resume') : btn('⏸ Stop trading', 'pause'),
      btn('🔄 Refresh', 'status'),
    ],
    [
      btn(cfg.enableSolana ? '🟣 Solana: ON' : '🟣 Solana: OFF', 'toggle_solana'),
      btn(cfg.enableBsc ? '🟡 BSC: ON' : '🟡 BSC: OFF', 'toggle_bsc'),
    ],
    [btn('📈 Positions', 'pos'), btn('🔎 Scanner', 'scan')],
    [btn('💼 Wallet', 'bal'), btn('💰 Capital', 'm:cap')],
    [btn('🎯 Exit rules', 'm:exit'), btn('🔍 Entry filters', 'm:filters')],
    [btn('🧠 Learning', 'm:learn'), btn('🚀 Platforms', 'm:pads')],
    [btn('📅 Daily limit', 'v:maxTokensPerDay'), btn('📋 Active plan', 'plan')],
    ...(DASHBOARD_WEBAPP_URL ? [[webAppBtn('🌐 Open control panel', DASHBOARD_WEBAPP_URL)]] : []),
    [btn('⚙️ Execution', 'm:exec'), btn('❓ Help', 'help')],
  ]);
}

function capitalView(cfg, banner) {
  return view(
    (banner ? `${banner}\n\n` : '') +
      `💰 Capital per trade\n\n` +
      `🟣 Solana: ${fmt(cfg.capitalPct)}% of SOL balance (${capLabel(cfg.maxPositionSol, 'SOL')})\n` +
      `🟡 BSC: ${fmt(cfg.bscCapitalPct)}% of BNB balance (${capLabel(cfg.bscMaxPositionBnb, 'BNB')})\n\n` +
      `Set any % from 0.01 to 100. Each buy uses that % of your balance, but never more than the "max per trade" cap — ` +
      `raise it or choose No cap so it doesn't limit you. A small amount is always kept back for fees. ` +
      `Changes apply to the very next trade.`,
    [
      [btn(`🟣 Solana % (${fmt(cfg.capitalPct)}%)`, 'v:capitalPct'), btn(`🟡 BSC % (${fmt(cfg.bscCapitalPct)}%)`, 'v:bscCapitalPct')],
      [btn(`🟣 SOL max (${Number(cfg.maxPositionSol) > 0 ? fmt(cfg.maxPositionSol) : 'no cap'})`, 'v:maxPositionSol'), btn(`🟡 BNB max (${Number(cfg.bscMaxPositionBnb) > 0 ? fmt(cfg.bscMaxPositionBnb) : 'no cap'})`, 'v:bscMaxPositionBnb')],
      [btn('✅ Apply & start', 'apply'), btn('⬅️ Back', 'menu')],
    ]
  );
}



function execView(cfg, banner) {
  return view(
    (banner ? `${banner}\n\n` : '') +
      `⚙️ Execution — how trades are placed\n\n` +
      `Open positions: Solana ${fmt(cfg.maxPositions)} · BSC ${fmt(cfg.bscMaxPositions)}\n` +
      `Slippage: SOL buy ${fmt(cfg.slippagePct)}% · SOL sell ${fmt(cfg.exitSlippagePct)}% · BSC ${fmt(cfg.bscSlippagePct)}%\n` +
      `Priority fee: ${fmt(cfg.priorityFeeLamports)} lamports · Entry cooldown: ${Number(cfg.entryCooldownSec) > 0 ? fmt(cfg.entryCooldownSec) + 's' : 'off'}\n\n` +
      `All of these take effect on the very next trade. Tap one, then pick a preset or type a number.`,
    [
      [btn(`🟣 Max open (${fmt(cfg.maxPositions)})`, 'v:maxPositions'), btn(`🟡 Max open (${fmt(cfg.bscMaxPositions)})`, 'v:bscMaxPositions')],
      [btn(`🟣 Buy slip (${fmt(cfg.slippagePct)}%)`, 'v:slippagePct'), btn(`🟣 Sell slip (${fmt(cfg.exitSlippagePct)}%)`, 'v:exitSlippagePct')],
      [btn(`🟡 BSC slip (${fmt(cfg.bscSlippagePct)}%)`, 'v:bscSlippagePct')],
      [btn(`⚡ Priority fee (${fmt(cfg.priorityFeeLamports)})`, 'v:priorityFeeLamports'), btn(`⏳ Cooldown (${Number(cfg.entryCooldownSec) > 0 ? fmt(cfg.entryCooldownSec) + 's' : 'off'})`, 'v:entryCooldownSec')],
      [btn('✅ Apply & start', 'apply'), btn('⬅️ Back', 'menu')],
    ]
  );
}

function platformsView(cfg, banner) {
  const row = (key, label) => {
    const on = cfg[key] !== false;
    return [btn(`${on ? '✅' : '⬜'} ${label}`, `pad:${key}`)];
  };
  const lines = [
    banner || null,
    '🚀 Launchpads to scan',
    '',
    'Tap a row to turn it ON or OFF.',
    'OFF = bot ignores new coins from that platform.',
    'Applies after the feed reconnects (or restart).',
    '',
    `pump.fun: ${cfg.launchpadPumpfun !== false ? 'ON' : 'OFF'}`,
    `LaunchLab / LetsBonk: ${cfg.launchpadLaunchlab !== false ? 'ON' : 'OFF'}`,
    `Meteora / Believe: ${cfg.launchpadMeteora !== false ? 'ON' : 'OFF'}`,
    `Moonshot: ${cfg.launchpadMoonshot !== false ? 'ON' : 'OFF'}`,
    `Boop.fun: ${cfg.launchpadBoop !== false ? 'ON' : 'OFF'}`,
  ].filter((x) => x != null);
  return view(lines.join('\n'), [
    row('launchpadPumpfun', 'pump.fun'),
    row('launchpadLaunchlab', 'Raydium LaunchLab / LetsBonk'),
    row('launchpadMeteora', 'Meteora DBC / Believe'),
    row('launchpadMoonshot', 'Moonshot'),
    row('launchpadBoop', 'Boop.fun'),
    [btn('« Menu', 'menu')],
  ]);
}


function filtersView(cfg, banner) {
  const t = cfg.minRecommendTier;
  const mark = (v, label) => btn(`${t === v ? '✅ ' : ''}${label}`, `t:${v}`);
  const off = (n, suffix = '') => (Number(n) > 0 ? `${fmt(n)}${suffix}` : 'off');
  return view(
    (banner ? `${banner}\n\n` : '') +
      `🔍 Entry filters — which tokens the bot may buy\n\n` +
      `Risk tier: ${tierLabel(t)}\n` +
      `Entry quality: risk score ≤ ${fmt(cfg.maxRiskScore)}\n` +
      `Dev ≤ ${fmt(cfg.maxDevPercent)}% · Top-10 ≤ ${fmt(cfg.maxTop10Percent)}%  (LOW-tier tokens)\n` +
      `MEDIUM+ tokens use their own limits: dev ≤ ${fmt(cfg.mediumMaxDevPercent)}% · top-10 ≤ ${fmt(cfg.mediumMaxTop10Percent)}% · score ≤ ${fmt(cfg.mediumMaxScore)}\n` +
      `Single holder ≤ ${off(cfg.maxSingleHolderPercent, '%')} · Top holders ≤ ${off(cfg.maxHighOwnershipPercent, '%')} · Min MC ${off(cfg.minMarketCapUsd)}\n` +
      `Coin age: ${Number(cfg.minAgeSec) > 0 ? fmt(cfg.minAgeSec) + 's' : 'instant'} – ${fmt(cfg.maxAgeDays)} days\n` +
      `Mint authority block: ${cfg.blockMintAuthority ? 'ON' : 'OFF'} · Creator-rug block: ${cfg.blockCreatorRug ? 'ON' : 'OFF'}\n\n` +
      `Every limit here is enforced on every buy, including tokens still on a pump.fun curve. Tap a limit, then tap a preset or just type a number.`,
    [
      [mark('LOW', 'LOW only'), mark('LOW_MEDIUM', 'LOW + MEDIUM'), mark('ANY', 'Any tier')],
      [btn(`🎚 Score ≤ ${fmt(cfg.maxRiskScore)}`, 'v:maxRiskScore'), btn(`Dev ≤ ${fmt(cfg.maxDevPercent)}%`, 'v:maxDevPercent'), btn(`Top10 ≤ ${fmt(cfg.maxTop10Percent)}%`, 'v:maxTop10Percent')],
      [btn(`👤 Single holder (${off(cfg.maxSingleHolderPercent, '%')})`, 'v:maxSingleHolderPercent'), btn(`🏦 Top holders (${off(cfg.maxHighOwnershipPercent, '%')})`, 'v:maxHighOwnershipPercent')],
      [btn(`💵 Min market cap (${off(cfg.minMarketCapUsd)})`, 'v:minMarketCapUsd')],
      [btn(`⏱ Min age (${Number(cfg.minAgeSec) > 0 ? fmt(cfg.minAgeSec) + 's' : 'instant'})`, 'v:minAgeSec'), btn(`📅 Max age (${fmt(cfg.maxAgeDays)}d)`, 'v:maxAgeDays')],
      [btn(cfg.blockMintAuthority ? '✅ Block mint authority' : '⬜ Block mint authority', 'safe:mint'), btn(cfg.blockCreatorRug ? '✅ Block creator rugs' : '⬜ Block creator rugs', 'safe:rug')],
      [btn('🎛 MEDIUM limits →', 'm:medium'), btn('💸 Tax limits (BSC) →', 'm:tax')],
      [btn('✅ Apply & start', 'apply'), btn('⬅️ Back', 'menu')],
    ]
  );
}

function exitView(cfg, banner) {
  const tp = cfg.takeProfitPct > 0 ? `+${fmt(cfg.takeProfitPct)}% (yours)` : 'Auto by risk tier';
  const sl = cfg.stopLossPct > 0 ? `−${fmt(cfg.stopLossPct)}% (yours)` : 'Auto by risk tier';
  const hold = cfg.maxHoldMin > 0 ? `${fmt(cfg.maxHoldMin)} min (yours)` : 'Auto by risk tier';
  return view(
    (banner ? `${banner}\n\n` : '') +
      `🎯 Exit rules — when the bot sells\n\n` +
      `🎯 Take profit: ${tp}\n🛑 Stop loss: ${sl}\n⏱ Max hold: ${hold}\n\n` +
      `Auto plan (TP / SL / max hold): ${autoPlanText()}.\n\n` +
      `The bot checks the sell price every ${Math.max(1, Math.round(PRICE_POLL_INTERVAL_MS / 1000))}s and sells the whole position the moment a rule triggers. ` +
      `Changes apply to open positions immediately. You get a message on every entry and every exit with the real profit/loss.`,
    [
      [btn(`🎯 Take profit (${cfg.takeProfitPct > 0 ? '+' + fmt(cfg.takeProfitPct) + '%' : 'auto'})`, 'v:takeProfitPct'), btn(`🛑 Stop loss (${cfg.stopLossPct > 0 ? '−' + fmt(cfg.stopLossPct) + '%' : 'auto'})`, 'v:stopLossPct')],
      [btn(`⏱ Max hold (${cfg.maxHoldMin > 0 ? fmt(cfg.maxHoldMin) + 'm' : 'auto'})`, 'v:maxHoldMin'), btn('📈 Positions', 'pos')],
      [btn('✅ Apply & start', 'apply'), btn('⬅️ Back', 'menu')],
    ]
  );
}

function mediumFiltersView(cfg, banner) {
  const active = cfg.minRecommendTier !== 'LOW';
  return view(
    (banner ? `${banner}\n\n` : '') +
      `🎛 MEDIUM-tier filters\n\n` +
      `${active ? 'Active (MEDIUM tier allowed).' : 'Not applied while tier is LOW only.'}\n\n` +
      `Dev allowance: ${fmt(cfg.mediumMaxDevPercent)}%\nTop-10 allowance: ${fmt(cfg.mediumMaxTop10Percent)}%\nScore ceiling: ${fmt(cfg.mediumMaxScore)}\n\n` +
      `These are separate, usually LOOSER limits for tokens scored MEDIUM or worse. A LOW-tier token is unaffected — it always uses your main Dev / Top-10 limits. Enforced on every buy.`,
    [
      [btn(`Dev ≤ ${fmt(cfg.mediumMaxDevPercent)}%`, 'v:mediumMaxDevPercent'), btn(`Top10 ≤ ${fmt(cfg.mediumMaxTop10Percent)}%`, 'v:mediumMaxTop10Percent')],
      [btn(`Score ≤ ${fmt(cfg.mediumMaxScore)}`, 'v:mediumMaxScore')],
      [btn('🔍 Entry filters', 'm:filters')],
      [btn('⬅️ Back', 'menu')],
    ]
  );
}

function taxFiltersView(cfg, banner) {
  return view(
    (banner ? `${banner}\n\n` : '') +
      `💸 Tax limits — BSC only\n\n` +
      `Max buy tax: ${fmt(cfg.maxBuyTaxPct)}%\nMax sell tax: ${fmt(cfg.maxSellTaxPct)}%\n\n` +
      `A BSC token whose buy or sell tax is above either limit is rejected outright. Sell tax matters most — it's what eats into your exit.`,
    [
      [btn(`Buy tax ≤ ${fmt(cfg.maxBuyTaxPct)}%`, 'v:maxBuyTaxPct'), btn(`Sell tax ≤ ${fmt(cfg.maxSellTaxPct)}%`, 'v:maxSellTaxPct')],
      [btn('🔍 Entry filters', 'm:filters'), btn('⬅️ Back', 'menu')],
    ]
  );
}

// What the bot is actually going to do from now on, in plain words.
function planText(cfg) {
  const open = runtime.getOpenPositions().length;
  const tp = cfg.takeProfitPct > 0 ? `+${fmt(cfg.takeProfitPct)}% (yours)` : 'auto';
  const sl = cfg.stopLossPct > 0 ? `−${fmt(cfg.stopLossPct)}% (yours)` : `${debull.STOP_LOSS_PCT}% (auto)`;
  const hold = cfg.maxHoldMin > 0 ? `${fmt(cfg.maxHoldMin)} min (yours)` : 'auto by tier';
  return [
    cfg.paused ? '⏸ Trading is STOPPED — tap ▶️ Start trading to begin.' : '🟢 Trading is ON.',
    DRY_RUN ? '🧪 DRY RUN — no real money moves.' : '🔴 LIVE — real trades.',
    '',
    'BUY:',
    `• Chains: Solana ${cfg.enableSolana ? 'ON' : 'OFF'} · BSC ${cfg.enableBsc ? 'ON' : 'OFF'}`,
    `• Tiers: ${tierLabel(cfg.minRecommendTier)} · score ≤ ${fmt(cfg.maxRiskScore)} · max ${cfg.maxTokensPerDay}/day (${getDailyCount()} used)`,
    `• Open positions: SOL ${fmt(cfg.maxPositions)} · BSC ${fmt(cfg.bscMaxPositions)} · slippage SOL ${fmt(cfg.slippagePct)}% / sell ${fmt(cfg.exitSlippagePct)}% / BSC ${fmt(cfg.bscSlippagePct)}%`,
    `• Coin age: ${Number(cfg.minAgeSec) > 0 ? fmt(cfg.minAgeSec) + 's' : 'instant'} to ${fmt(cfg.maxAgeDays)} days old`,
    `• Size: ${fmt(cfg.capitalPct)}% of SOL (${capLabel(cfg.maxPositionSol, 'SOL')}) · ${fmt(cfg.bscCapitalPct)}% of BNB (${capLabel(cfg.bscMaxPositionBnb, 'BNB')})`,
    '',
    'SELL (whole position):',
    `• Take profit ${tp}`,
    `• Stop loss ${sl}`,
    `• Max hold ${hold}`,
    open ? `• Applies to your ${open} open position${open > 1 ? 's' : ''} right now.` : '• No open positions yet.',
    '',
    `Learning: ${cfg.learningMode}${cfg.learningMode === 'auto' ? ' (adjusts score ceiling / take-profit / hold by itself)' : ''}`,
  ].join('\n');
}

function planView(cfg, banner) {
  return view((banner ? `${banner}\n\n` : '') + `📋 Active plan\n\n` + planText(cfg), [
    [cfg.paused ? btn('▶️ Start trading', 'resume') : btn('⏸ Stop trading', 'pause')],
    [btn('🎯 Exit rules', 'm:exit'), btn('🔍 Entry filters', 'm:filters')],
    [btn('⬅️ Back', 'menu')],
  ]);
}

function learningView(cfg, banner) {
  const st = learner.stats();
  const sug = learner.suggest(cfg);
  const mode = (m, label) => btn(`${cfg.learningMode === m ? '✅ ' : ''}${label}`, `l:mode:${m}`);
  const line = (name, g) => `• ${name}: ${g.n} trades · ${g.winRate.toFixed(0)}% win · avg ${g.avgPnl >= 0 ? '+' : ''}${g.avgPnl.toFixed(1)}%`;
  const lines = [
    banner || null,
    '🧠 Learning mode',
    '',
    cfg.learningMode === 'off'
      ? 'OFF — nothing is recorded and nothing is suggested.'
      : cfg.learningMode === 'auto'
      ? 'AUTO — every 10 new closed trades it adjusts score ceiling, take-profit and max hold in small steps, and tells you.'
      : 'SUGGEST — it records every closed trade and shows what it would change. You decide.',
    'It never touches position size, safety toggles, stop loss or wallets.',
    '',
    st.total.n
      ? `Recorded: ${st.total.n} closed trades (${st.dryRunCount} dry-run) — ${st.total.winRate.toFixed(0)}% win · avg ${st.total.avgPnl >= 0 ? '+' : ''}${st.total.avgPnl.toFixed(1)}%`
      : 'Recorded: no closed trades yet.',
    ...Object.entries(st.byTier).map(([k, g]) => line(k, g)),
    ...Object.entries(st.byScore).filter(([, g]) => g.n).map(([k, g]) => line(`score ${k}`, g)),
    '',
  ];
  if (cfg.learningMode === 'off') {
    /* no suggestions */
  } else if (!sug.ready) {
    lines.push(`Collecting data: ${sug.n}/${sug.needed} closed trades before it suggests anything.`);
  } else if (!sug.suggestions.length) {
    lines.push('✅ Nothing to change — your current settings already match what the data says.');
  } else {
    lines.push('Suggested changes:');
    for (const x of sug.suggestions) lines.push(`• ${learner.LABELS[x.key] || x.key}: ${learner.fmtVal(x.current)} → ${learner.fmtVal(x.suggested)}\n   ${x.why}`);
  }
  lines.push('', 'Small samples are noisy and the past does not guarantee the future — treat these as hints.');
  const rows = [[mode('off', 'Off'), mode('suggest', 'Suggest'), mode('auto', 'Auto')]];
  if (cfg.learningMode !== 'off' && sug.ready && sug.suggestions.length) rows.push([btn('✅ Apply suggestions', 'l:apply')]);
  rows.push([btn(`✏️ Trades needed (${fmt(cfg.learningMinTrades)})`, 'v:learningMinTrades'), btn('🔄 Refresh', 'm:learn')]);
  rows.push([btn('🗑 Reset learned data', 'l:reset'), btn('⬅️ Back', 'menu')]);
  return view(lines.filter((x) => x != null).join('\n'), rows);
}

function learningResetView() {
  return view('🗑 Delete all recorded trades used for learning? This cannot be undone (your settings stay as they are).', [
    [btn('Yes, delete', 'l:resetyes'), btn('Cancel', 'm:learn')],
  ]);
}

function scannerView(cfg) {
  return view(scannerText(cfg, 60), [
    [btn('🔄 Refresh', 'scan'), btn(`📡 Heartbeat: ${cfg.heartbeatMin > 0 ? fmt(cfg.heartbeatMin) + 'm' : 'off'}`, 'v:heartbeatMin')],
    [btn('📈 Positions', 'pos'), btn('🔍 Entry filters', 'm:filters')],
    [btn('⬅️ Back', 'menu')],
  ]);
}

function positionsView(cfg) {
  return view(positionsText(cfg), [
    [btn('🔄 Refresh', 'pos'), btn('🎯 Exit rules', 'm:exit')],
    [btn('🔎 Scanner', 'scan'), btn('⬅️ Back', 'menu')],
  ]);
}

async function showBalance(b, chatId, messageId) {
  const loading = view('💼 Loading wallet balances…', [[btn('⬅️ Back', 'menu')]]);
  if (messageId) await b.editMessageText(loading.text, { chat_id: chatId, message_id: messageId, reply_markup: loading.reply_markup }).catch(() => {});
  else messageId = (await b.sendMessage(chatId, loading.text, { reply_markup: loading.reply_markup })).message_id;

  const text = await balanceText(getConfig(), chatId);
  const final = view(text, [[btn('🔄 Refresh', 'bal'), btn('⬅️ Back', 'menu')]]);
  await b.editMessageText(final.text, { chat_id: chatId, message_id: messageId, reply_markup: final.reply_markup }).catch(() => {});
}

function pickerView(key, cfg, banner) {
  const def = SETTINGS[key];
  const cur = cfg[key];
  const shortUnit = def.unit.trim() === '%' ? '%' : '';
  const rows = [];

  for (let i = 0; i < def.presets.length; i += 4) {
    rows.push(
      def.presets.slice(i, i + 4).map((p) =>
        btn(`${Number(cur) === p ? '✅ ' : ''}${def.zeroLabel && p === 0 ? (def.zeroIcon || '♾') + ' ' + def.zeroLabel : fmt(p) + shortUnit}`, `s:${key}:${p}`)
      )
    );
  }
  const [small, large] = def.steps;
  rows.push([
    btn(`−${fmt(large)}`, `d:${key}:${-large}`),
    btn(`−${fmt(small)}`, `d:${key}:${-small}`),
    btn(`+${fmt(small)}`, `d:${key}:${small}`),
    btn(`+${fmt(large)}`, `d:${key}:${large}`),
  ]);
  rows.push([btn('✏️ Type your own value', `c:${key}`)]);
  rows.push([btn('⬅️ Back', def.parent)]);

  const warn = def.warnAbove && Number(cur) > def.warnAbove ? `\n⚠️ That's a large share of your balance — one bad token can hurt.\n` : '';
  const typeHint = `\n✏️ Or just type a value now (${def.zeroLabel ? `up to ${fmt(def.max)}${def.unit}, or "${def.zeroWord || 'none'}" for ${def.zeroLabel.toLowerCase()}` : `${fmt(def.min)}–${fmt(def.max)}${def.unit}`}${def.int ? ', whole number' : ''}) and send it.`;
  return view(
    (banner ? `${banner}\n\n` : '') +
      `${def.title}\n\nCurrent: ${valText(def, cur)}\n${warn}\n${def.describe(cfg)}\n\n` +
      `${def.zeroLabel ? `Any value up to ${fmt(def.max)}${def.unit}, or 0 for ${def.zeroLabel.toLowerCase()}.` : `Range ${fmt(def.min)}–${fmt(def.max)}${def.unit}.`} Tap a preset or nudge with −/+.${typeHint}`,
    rows
  );
}

function customPromptView(key) {
  const def = SETTINGS[key];
  return view(
    `✏️ ${def.title}\n\nType the new value and send it (${def.zeroLabel ? `any value up to ${fmt(def.max)}${def.unit}, or "${def.zeroWord || 'none'}" for ${def.zeroLabel.toLowerCase()}` : `${fmt(def.min)}–${fmt(def.max)}${def.unit}`}${def.int ? ', whole number' : ''}).\nExample: ${fmt(def.presets[def.zeroLabel ? 3 : 2])}`,
    [[btn('✖️ Cancel', `v:${key}`)]]
  );
}

const HELP_TEXT =
  `Everything is button-driven — open /menu. Every number can also be TYPED: open any setting and just send a value (e.g. 12.5), or use a command.\n\n` +
  `/menu — control panel · /plan — exactly what the bot will do now · /apply — save + start trading\n` +
  `/positions · /balance · /scanner · /learning\n` +
  `/starttrading, /stoptrading · /solana on|off · /bsc on|off\n\n` +
  `Capital per trade:\n` +
  `/setcapital <pct> · /setbsccapital <pct> (0.01–100)\n` +
  `/setmaxpos <sol|none> · /setbscmaxpos <bnb|none>\n\n` +
  `Exit rules (0 or "auto" = automatic by risk tier):\n` +
  `/settp <pct> · /setsl <pct> · /setmaxhold <min>\n\n` +
  `Entry filters:\n` +
  `/setrisk low|lowmedium|any — which risk tiers may be bought\n` +
  `/setscore <n> — only tokens with risk score ≤ n\n` +
  `/setdev <pct> · /settop10 <pct> — limits for LOW-tier tokens\n` +
  `/setmediumdev · /setmediumtop10 · /setmediumscore — limits for MEDIUM+ tokens\n` +
  `/setsingle <pct> · /sethighown <pct> · /setminmcap <usd> (0 = off)\n` +
  `/setminage <sec> (0–60) · /setmaxage <days> (up to 20) — only buy coins within this age window\n` +
  `/setbuytax · /setselltax — BSC only\n` +
  `Execution: /setmaxopen · /setbscmaxopen · /setslippage · /setexitslippage · /setbscslippage · /setpriorityfee <lamports> · /setcooldown <sec>\n` +
  `/setmax <n> — max tokens per day · /setheartbeat <min|off>\n` +
  `/setlearnmin <n> — closed trades needed before Learning suggests changes\n\n` +
  `Send any value command with no number to get its buttons. /cancel stops typing a value. Paste a contract address any time to analyze it.\n\n` +
  `Every finding, buy, and sell is pushed here the moment it happens.`;

const helpView = () => view(HELP_TEXT, [[btn('📋 Open menu', 'menu')]]);

// ---------------------------------------------------------------------
// Bot wiring
// ---------------------------------------------------------------------
function start() {
  const b = getBot();
  if (!b) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.');
    return;
  }
  console.log('[telegram] bot started (polling mode)');
  learner
    .init({ applyConfig: updateConfig, notify, config: getConfig })
    .catch((err) => console.error('[learning] init failed:', err.message));

  // chatId -> { key, messageId, ts } while waiting for a typed value.
  const pending = new Map();
  const PENDING_TTL_MS = 5 * 60 * 1000;

  b.setMyCommands([
    { command: 'menu', description: 'Open the control panel' },
    { command: 'status', description: 'Show status + buttons' },
    { command: 'positions', description: 'Open positions + live P&L' },
    { command: 'balance', description: 'Wallet balance + address' },
    { command: 'scanner', description: 'Is it scanning? Feed + funnel' },
    { command: 'plan', description: 'What the bot is doing now' },
    { command: 'apply', description: 'Apply settings and start' },
    { command: 'learning', description: 'Learning mode' },
    { command: 'setminage', description: 'Min coin age (seconds)' },
    { command: 'setmaxage', description: 'Max coin age (days)' },
    { command: 'settp', description: 'Take profit %' },
    { command: 'starttrading', description: 'Start trading' },
    { command: 'stoptrading', description: 'Stop trading' },
    { command: 'setcapital', description: 'Solana capital % per trade' },
    { command: 'setbsccapital', description: 'BSC capital % per trade' },
    { command: 'help', description: 'All commands' },
    { command: 'analyze', description: 'Analyze a contract address' },
  ]).catch((err) => console.error('[telegram] setMyCommands failed:', err.message));

  const send = (chatId, v) => b.sendMessage(chatId, v.text, { reply_markup: v.reply_markup });

  async function show(chatId, messageId, v) {
    if (!v || !v.text) {
      console.error('[telegram] show() called with empty view');
      return;
    }
    try {
      await b.editMessageText(v.text, { chat_id: chatId, message_id: messageId, reply_markup: v.reply_markup });
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return;
      // Message too old / can't edit → send a fresh screen so the user still sees the menu
      console.warn('[telegram] editMessageText failed, sending new message:', err.message);
      await b.sendMessage(chatId, v.text, { reply_markup: v.reply_markup });
    }
  }

  const fail = (chatId, err) => b.sendMessage(chatId, `Failed: ${err.message}`);

  // ---- basic commands ----
  b.onText(/^\/start\b/, async (msg) => {
    const intro =
      `Meme coin scanner online.\nYour chat ID: ${msg.chat.id}\n` +
      (TELEGRAM_CHAT_ID ? '' : 'Tip: set TELEGRAM_CHAT_ID to this number so only you control the bot.\n');
    await b.sendMessage(msg.chat.id, intro);
    if (isAuthorized(msg.chat.id)) await send(msg.chat.id, mainView(getConfig()));
  });

  b.onText(/^\/help\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, helpView());
  });

  b.onText(/^\/(menu|status)\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, mainView(getConfig()));
  });

  b.onText(/^\/positions\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, positionsView(getConfig()));
  });

  b.onText(/^\/balance\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await showBalance(b, msg.chat.id);
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/scanner\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, scannerView(getConfig()));
  });

  
  b.onText(/^\/analyze(?:@\w+)?(?:\s+(.+))?\s*$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const arg = (match[1] || '').trim();
    if (!arg) {
      return b.sendMessage(chatId, 'Usage: /analyze <contract address>\nOr just paste a Solana mint / 0x address.');
    }
    await b.sendMessage(chatId, '🔎 Analyzing…');
    try {
      const result = await analyzeAddress(arg.split(/\s+/)[0]);
      await b.sendMessage(chatId, result.text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      await b.sendMessage(chatId, `Analyze failed: ${err.message}`);
    }
  });

  b.onText(/^\/plan\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, planView(getConfig()));
  });

  b.onText(/^\/learning\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    send(msg.chat.id, learningView(getConfig()));
  });

  b.onText(/^\/apply\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await refresh();
      const wasPaused = getConfig().paused;
      if (wasPaused) await updateConfig({ paused: false });
      await send(msg.chat.id, planView(getConfig(), `✅ ${wasPaused ? 'Applied and trading started.' : 'Applied.'} The bot is now using exactly this plan:`));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/cancel\b/i, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    pending.delete(msg.chat.id);
    send(msg.chat.id, mainView(getConfig(), 'Cancelled.'));
  });

  b.onText(/^\/(stoptrading|pause)\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: true });
      await send(msg.chat.id, mainView(getConfig(), '⏹ Trading stopped. No new positions will be entered.'));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/(starttrading|resume)\b/i, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      await updateConfig({ paused: false });
      await send(msg.chat.id, mainView(getConfig(), '▶️ Trading started.'));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/setrisk(?:@\w+)?(?:\s+(low_?medium|low|any))?\s*$/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    if (!match[1]) return send(msg.chat.id, filtersView(getConfig()));
    const m1 = match[1].toLowerCase();
    const tier = m1 === 'low' ? 'LOW' : m1 === 'any' ? 'ANY' : 'LOW_MEDIUM';
    try {
      await updateConfig({ minRecommendTier: tier });
      await send(msg.chat.id, filtersView(getConfig(), `✅ Risk tier set to ${tierLabel(tier)}.`));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  b.onText(/^\/(solana|bsc)(?:@\w+)?\s+(on|off)\s*$/i, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const chain = match[1].toLowerCase();
    const on = match[2].toLowerCase() === 'on';
    try {
      await updateConfig(chain === 'solana' ? { enableSolana: on } : { enableBsc: on });
      await send(msg.chat.id, mainView(getConfig(), `✅ ${chain === 'solana' ? 'Solana' : 'BSC'} ${on ? 'ON' : 'OFF'}.`));
    } catch (err) {
      fail(msg.chat.id, err);
    }
  });

  // ---- numeric settings: /setcapital 12.5 etc. (no number => opens buttons) ----
  for (const [key, def] of Object.entries(SETTINGS)) {
    const re = new RegExp(`^\\/${def.cmd}(?:@\\w+)?(?:\\s+(\\S+))?\\s*$`, 'i');
    b.onText(re, async (msg, match) => {
      if (!isAuthorized(msg.chat.id)) return;
      if (!match[1]) return send(msg.chat.id, pickerView(key, getConfig()));
      const res = validate(def, parseInput(def, match[1]));
      if (res.error) return b.sendMessage(msg.chat.id, `❌ ${res.error}`);
      try {
        await updateConfig({ [key]: res.value });
        await send(msg.chat.id, pickerView(key, getConfig(), `✅ Set to ${valText(def, res.value)}.`));
      } catch (err) {
        fail(msg.chat.id, err);
      }
    });
  }

  // ---- typed values after tapping "✏️ Type your own value" ----
  // Also: if the message is just a contract address, run /analyze.
  b.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;
    if (text.startsWith('/')) {
      if (!/^\/cancel\b/i.test(text)) pending.delete(chatId); // any other command abandons the prompt
      return;
    }
    const p = pending.get(chatId);
    const firstWord = text.split(/\s+/)[0];
    const looksLikeCA = text.length <= 80 && (SOL_CA_RE.test(firstWord) || EVM_CA_RE.test(firstWord));
    if (!p || looksLikeCA) {
      // plain CA paste → analyze
      if (!isAuthorized(chatId)) return;
      const token = firstWord;
      if (looksLikeCA) {
        await b.sendMessage(chatId, '🔎 Analyzing pasted CA…');
        try {
          const result = await analyzeAddress(token);
          await b.sendMessage(chatId, result.text, { parse_mode: 'Markdown', disable_web_page_preview: true });
        } catch (err) {
          await b.sendMessage(chatId, `Analyze failed: ${err.message}`);
        }
      }
      return;
    }
    if (!isAuthorized(chatId)) return;
    if (Date.now() - p.ts > PENDING_TTL_MS) {
      pending.delete(chatId);
      return;
    }

    const def = SETTINGS[p.key];
    const res = validate(def, parseInput(def, text));
    if (res.error) {
      return b.sendMessage(chatId, `❌ ${res.error} Try again, or /cancel.`);
    }
    try {
      await updateConfig({ [p.key]: res.value });
      pending.set(chatId, { ...p, ts: Date.now() }); // stay armed: type again to change it again, /cancel or any button to stop
      b.deleteMessage(chatId, msg.message_id).catch(() => {}); // tidy up the typed number (best effort)
      const v = pickerView(p.key, getConfig(), `✅ Set to ${valText(def, res.value)}.`);
      try {
        await show(chatId, p.messageId, v);
      } catch (_) {
        await send(chatId, v);
      }
    } catch (err) {
      fail(chatId, err);
    }
  });

  // ---- button taps ----
  b.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (!isAuthorized(chatId)) {
      return b.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    }

    const [action, arg1, arg2] = String(query.data || '').split(':');
    let toast;
    let next;

    try {
      pending.delete(chatId); // leaving a "type a value" prompt cancels it, unless we set it again below

      switch (action) {
        case 'menu':
        case 'status':
          toast = action === 'status' ? 'Refreshed' : undefined;
          await refresh();
          next = mainView(getConfig());
          break;

        case 'help':
          next = helpView();
          break;

        case 'pos':
          toast = 'Updated';
          next = positionsView(getConfig());
          break;

        case 'bal':
          await b.answerCallbackQuery(query.id, { text: 'Loading…' });
          try {
            await showBalance(b, chatId, messageId);
          } catch (err) {
            console.error('[telegram] balance lookup failed:', err.message);
            b.sendMessage(chatId, `Failed to load balance: ${err.message}`).catch(() => {});
          }
          return; // showBalance edits the message itself (loading state, then the real balances)

        case 'scan':
          toast = 'Updated';
          next = scannerView(getConfig());
          break;

        case 'pause':
          await updateConfig({ paused: true });
          toast = '⏹ Trading stopped';
          next = mainView(getConfig());
          break;

        case 'resume':
          await updateConfig({ paused: false });
          toast = '▶️ Trading started';
          next = mainView(getConfig());
          break;

        case 'toggle_solana': {
          const on = !getConfig().enableSolana;
          await updateConfig({ enableSolana: on });
          toast = `Solana ${on ? 'ON' : 'OFF'}`;
          next = mainView(getConfig());
          break;
        }

        case 'toggle_bsc': {
          const on = !getConfig().enableBsc;
          await updateConfig({ enableBsc: on });
          toast = `BSC ${on ? 'ON' : 'OFF'}`;
          next = mainView(getConfig());
          break;
        }

        case 'm': // sub-menus
          next =
            arg1 === 'cap' ? capitalView(getConfig())
            : arg1 === 'risk' || arg1 === 'safety' ? filtersView(getConfig())
            : arg1 === 'filters' ? filtersView(getConfig())
            : arg1 === 'exit' ? exitView(getConfig())
            : arg1 === 'medium' ? mediumFiltersView(getConfig())
            : arg1 === 'tax' ? taxFiltersView(getConfig())
            : arg1 === 'exec' ? execView(getConfig())
            : arg1 === 'pads' ? platformsView(getConfig())
            : arg1 === 'learn' ? learningView(getConfig())
            : mainView(getConfig());
          break;

        case 'v': // open a value picker
          if (!SETTINGS[arg1]) throw new Error('Unknown setting');
          pending.set(chatId, { key: arg1, messageId, ts: Date.now() }); // typing a number works straight away
          next = pickerView(arg1, getConfig());
          break;

        case 's': { // set to a preset
          const def = SETTINGS[arg1];
          if (!def) throw new Error('Unknown setting');
          const res = validate(def, arg2);
          if (res.error) throw new Error(res.error);
          await updateConfig({ [arg1]: res.value });
          toast = `✅ ${valText(def, res.value)}`;
          pending.set(chatId, { key: arg1, messageId, ts: Date.now() });
          next = pickerView(arg1, getConfig());
          break;
        }

        case 'd': { // nudge up/down
          const def = SETTINGS[arg1];
          if (!def) throw new Error('Unknown setting');
          const cur = Number(getConfig()[arg1]);
          const target = clamp(round4(cur + Number(arg2)), def.min, def.max);
          if (target === cur) {
            toast = Number(arg2) > 0 ? 'Already at the maximum' : 'Already at the minimum';
          } else {
            await updateConfig({ [arg1]: def.int ? Math.round(target) : target });
            toast = `✅ ${valText(def, target)}`;
          }
          pending.set(chatId, { key: arg1, messageId, ts: Date.now() });
          next = pickerView(arg1, getConfig());
          break;
        }

        case 'c': // ask for a typed value
          if (!SETTINGS[arg1]) throw new Error('Unknown setting');
          pending.set(chatId, { key: arg1, messageId, ts: Date.now() });
          next = customPromptView(arg1);
          break;


        case 'pad': {
          const key = arg1;
          const allowed = ['launchpadPumpfun','launchpadLaunchlab','launchpadMeteora','launchpadMoonshot','launchpadBoop'];
          if (!allowed.includes(key)) throw new Error('Unknown launchpad');
          const cur = getConfig()[key] !== false;
          await updateConfig({ [key]: !cur });
          toast = `${key.replace('launchpad','')} ${!cur ? 'ON' : 'OFF'}`;
          next = platformsView(getConfig());
          break;
        }
        case 'safe': {
          if (arg1 === 'mint') {
            const cur = Boolean(getConfig().blockMintAuthority);
            await updateConfig({ blockMintAuthority: !cur });
            toast = `Mint authority block ${!cur ? 'ON' : 'OFF'}`;
          } else if (arg1 === 'rug') {
            const cur = Boolean(getConfig().blockCreatorRug);
            await updateConfig({ blockCreatorRug: !cur });
            toast = `Creator rug block ${!cur ? 'ON' : 'OFF'}`;
          }
          next = filtersView(getConfig());
          break;
        }
        case 't': { // risk tier
          const tier = ['LOW', 'ANY'].includes(arg1) ? arg1 : 'LOW_MEDIUM';
          await updateConfig({ minRecommendTier: tier });
          toast = `Tier: ${tierLabel(tier)}`;
          next = filtersView(getConfig());
          break;
        }

        case 'apply': { // save → unpause → show exactly what the bot will do now
          await refresh();
          const wasPaused = getConfig().paused;
          if (wasPaused) await updateConfig({ paused: false });
          toast = '✅ Plan applied';
          next = planView(getConfig(), `✅ ${wasPaused ? 'Applied and trading started.' : 'Applied.'} The bot is now using exactly this plan:`);
          break;
        }

        case 'plan':
          next = planView(getConfig());
          break;

        case 'l': { // learning mode
          if (arg1 === 'mode') {
            const m = ['off', 'suggest', 'auto'].includes(arg2) ? arg2 : 'suggest';
            await updateConfig({ learningMode: m });
            toast = `Learning: ${m}`;
            next = learningView(getConfig());
          } else if (arg1 === 'apply') {
            const r = await learner.applySuggestions();
            toast = r.applied.length ? `Applied ${r.applied.length} change${r.applied.length > 1 ? 's' : ''}` : r.reason || 'Nothing to apply';
            next = learningView(getConfig(), r.applied.length ? `✅ Applied:\n${r.applied.map((a) => `• ${learner.LABELS[a.key] || a.key}: ${learner.fmtVal(a.current)} → ${learner.fmtVal(a.applied)}`).join('\n')}` : null);
          } else if (arg1 === 'reset') {
            next = learningResetView();
          } else if (arg1 === 'resetyes') {
            learner.reset();
            toast = 'Learned data deleted';
            next = learningView(getConfig(), '🗑 Learned data deleted.');
          } else {
            next = learningView(getConfig());
          }
          break;
        }

        default:
          toast = 'Unknown button — open /menu';
          next = mainView(getConfig());
      }

      await b.answerCallbackQuery(query.id, toast ? { text: toast } : undefined);
      await show(chatId, messageId, next);
    } catch (err) {
      console.error('[telegram] callback_query failed:', err.message);
      b.answerCallbackQuery(query.id, { text: `Failed: ${err.message}`.slice(0, 190), show_alert: true }).catch(() => {});
    }
  });

  b.on('polling_error', (err) => console.error('[telegram] polling error:', err.message));

  // Periodic "still scanning" summary (interval is adjustable; 0 = off).
  let lastHeartbeatAt = Date.now();
  const hb = setInterval(() => {
    const cfg = getConfig();
    const minutes = Number(cfg.heartbeatMin) || 0;
    if (!minutes) {
      lastHeartbeatAt = Date.now();
      return;
    }
    if (Date.now() - lastHeartbeatAt >= minutes * 60 * 1000) {
      lastHeartbeatAt = Date.now();
      notify(heartbeatText(cfg, minutes));
    }
  }, 30 * 1000);
  if (hb.unref) hb.unref();
}

// Called by the position managers for instant push notifications. Safe to
// call even when Telegram isn't configured — it's a no-op then.
function notify(text) {
  const b = getBot();
  if (!b || !TELEGRAM_CHAT_ID) return;
  b.sendMessage(TELEGRAM_CHAT_ID, text).catch((err) => {
    console.error('[telegram] notify failed:', err.message);
  });
}

// One message a few seconds after boot so you know the bot is up, which mode
// it's in, and that the feeds actually connected.
function announceStartup(delayMs = 8000) {
  const t = setTimeout(() => {
    const cfg = getConfig();
    notify(
      [
        '🚀 Scanner started',
        DRY_RUN ? '🧪 DRY RUN — no real trades' : '🔴 LIVE — real trades',
        scannerHeadline() || 'No chain running',
        `Entry: ${tierLabel(cfg.minRecommendTier)} · score ≤ ${fmt(cfg.maxRiskScore)} · MC ${Number(cfg.minMarketCapUsd) > 0 ? '≥ $' + fmt(cfg.minMarketCapUsd) : 'gate off'} · ${getDailyCount()}/${cfg.maxTokensPerDay} used today`,
        `Exit: TP ${cfg.takeProfitPct > 0 ? '+' + fmt(cfg.takeProfitPct) + '%' : 'auto'} · SL ${cfg.stopLossPct > 0 ? '−' + fmt(cfg.stopLossPct) + '%' : 'auto'}`,
        cfg.paused ? '⏸ Trading is STOPPED — tap /menu → Start trading.' : '🟢 Trading is on.',
        'Send /scanner any time to see what it is checking.',
      ].join('\n')
    );
  }, delayMs);
  if (t.unref) t.unref();
}

module.exports = { start, notify, announceStartup, _views: { execView, mainView, filtersView, exitView, capitalView, planView, learningView, pickerView, mediumFiltersView, taxFiltersView, scannerView, positionsView, platformsView }, _settings: SETTINGS };
