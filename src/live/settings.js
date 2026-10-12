/**
 * ONE place that defines every setting you can change from Telegram:
 * its range, how it is typed, its buttons and what it does. The Telegram menu, the
 * validation, the scanner, the entry gates and the learning tuner all read from here, so a
 * setting can never exist in the menu without actually being used (and vice versa).
 */
const DAY = 86400;
const MAX_AGE_SEC = 20 * DAY; // hard upper limit for the age window
const MIN_AGE_SEC = 2; // hard lower limit for the age window

// kind: 'num' | 'int' | 'dur' (duration, stored in seconds) | 'bool'
const SETTINGS = {
  // ---------------- Trade ----------------
  sizeUsd: {
    group: 'trade', kind: 'num', label: '💵 Trade size', unit: '$', min: 0.5, max: 500,
    presets: [1, 2, 5, 7, 10, 20, 50], steps: [-5, -1, 1, 5],
    desc: 'Dollar value of every buy. If "Max SOL per trade" is lower than this in SOL terms, that cap wins.',
  },
  maxPositionSol: {
    group: 'trade', kind: 'num', label: '🧢 Max SOL per trade', unit: ' SOL', min: 0, max: 10, zero: 'No cap',
    presets: [0.05, 0.1, 0.2, 0.5, 1, 0], steps: [-0.05, 0.05],
    desc: 'Hard cap on SOL spent per buy, whatever the trade size says. 0 = no cap.',
  },
  takeProfitPct: {
    group: 'trade', kind: 'num', label: '🎯 Take profit', unit: '%', min: 5, max: 500,
    presets: [20, 30, 50, 60, 100, 200], steps: [-20, -10, -5, 5, 10, 20],
    desc: 'The whole position is sold when profit reaches this. Applies to open positions immediately.',
  },
  stopLossPct: {
    group: 'trade', kind: 'num', label: '🛡 Stop loss', unit: '%', min: 5, max: 90,
    presets: [10, 20, 30, 45, 60], steps: [-10, -5, 5, 10],
    desc: 'The whole position is sold when the loss reaches this. Applies to open positions immediately.',
  },
  maxHoldMin: {
    group: 'trade', kind: 'num', label: '⏱ Max hold', unit: ' min', min: 1, max: 1440,
    presets: [2, 5, 8, 15, 30, 60, 120], steps: [-15, -5, -1, 1, 5, 15],
    desc: 'If neither take-profit nor stop-loss has fired by then, the position is sold anyway.',
  },
  maxTradesDay: {
    group: 'trade', kind: 'int', label: '#️⃣ Max trades per day', unit: '', min: 1, max: 100,
    presets: [3, 5, 7, 15, 20, 50], steps: [-5, -1, 1, 5],
    desc: 'The bot stops opening new trades after this many in a UTC day.',
  },
  maxOpen: {
    group: 'trade', kind: 'int', label: '📂 Max open positions', unit: '', min: 1, max: 10,
    presets: [1, 2, 3, 5], steps: [-1, 1],
    desc: 'How many positions may be open at once. More positions = more money at risk at the same time.',
  },
  maxDailyLossPct: {
    group: 'trade', kind: 'num', label: '🛑 Daily loss limit', unit: '%', min: 1, max: 100,
    presets: [5, 10, 15, 25, 50], steps: [-5, 5],
    desc: 'Stops opening new trades for the day once realized losses reach this % of the day-start balance.',
  },

  // ---------------- Entry filters ----------------
  minAgeSec: {
    group: 'filters', kind: 'dur', label: '⏱ Min coin age', min: MIN_AGE_SEC, max: MAX_AGE_SEC, defaultUnit: 's',
    presets: [2, 10, 60, 600, 3600, 6 * 3600, DAY, 3 * DAY, 7 * DAY, 10 * DAY],
    steps: [-DAY, -3600, 3600, DAY],
    desc: 'Only buy coins at least this old (from 2 seconds up to 20 days). Type e.g. 30s, 15m, 6h or 10d.',
  },
  maxAgeSec: {
    group: 'filters', kind: 'dur', label: '📅 Max coin age', min: MIN_AGE_SEC, max: MAX_AGE_SEC, defaultUnit: 'd',
    presets: [3600, 6 * 3600, DAY, 3 * DAY, 7 * DAY, 14 * DAY, 20 * DAY],
    steps: [-DAY, -3600, 3600, DAY],
    desc: 'Never buy a coin older than this (up to 20 days). Type e.g. 12h, 3d or 20d.',
  },
  minLiquidityUsd: {
    group: 'filters', kind: 'num', label: '💧 Min liquidity', unit: '$', min: 0, max: 5_000_000,
    presets: [3000, 8000, 15000, 30000, 50000, 100000], steps: [-5000, -1000, 1000, 5000],
    desc: 'Pool liquidity must be at least this. Checked by the scanner AND again right before buying.',
  },
  minVolume1hUsd: {
    group: 'filters', kind: 'num', label: '📊 Min 1h volume', unit: '$', min: 0, max: 5_000_000,
    presets: [0, 1500, 4000, 8000, 20000, 50000], steps: [-1000, 1000],
    desc: 'Trading volume in the last hour must be at least this (or 6h volume ≥ 3× this).',
  },
  minBuys1h: {
    group: 'filters', kind: 'int', label: '🛒 Min buys in 1h', unit: '', min: 0, max: 5000,
    presets: [0, 5, 12, 20, 40, 100], steps: [-5, -1, 1, 5],
    desc: 'Number of buy transactions in the last hour must be at least this.',
  },
  minBuyPressure: {
    group: 'filters', kind: 'num', label: '⚖️ Min buy/sell ratio', unit: '×', min: 0, max: 10,
    presets: [0, 0.7, 1, 1.2, 1.5, 2], steps: [-0.1, 0.1],
    desc: 'Buys ÷ sells in the last hour must be at least this. 1 = as many buys as sells.',
  },
  minChange1hPct: {
    group: 'filters', kind: 'num', label: '📈 Rising: 1h change >', unit: '%', min: -100, max: 500,
    presets: [-100, 0, 2, 5, 10, 20], steps: [-5, -1, 1, 5],
    desc: 'A coin counts as "rising" if its 1h change is above this OR its 6h change is above the 6h value. -100 = never required.',
  },
  minChange6hPct: {
    group: 'filters', kind: 'num', label: '📈 Rising: 6h change >', unit: '%', min: -100, max: 500,
    presets: [-100, 0, 2, 5, 10, 20], steps: [-5, -1, 1, 5],
    desc: 'See the 1h rule above. Set BOTH to -100 to turn the "must be rising" check off.',
  },
  maxDrop5mPct: {
    group: 'filters', kind: 'num', label: '📉 Max 5m drop', unit: '%', min: 0, max: 100,
    presets: [5, 8, 12, 20, 30, 100], steps: [-5, -1, 1, 5],
    desc: 'Skip coins that fell more than this in the last 5 minutes (a falling knife). 100 = off.',
  },
  maxDrop24hPct: {
    group: 'filters', kind: 'num', label: '📉 Max 24h drop', unit: '%', min: 0, max: 100,
    presets: [20, 30, 40, 60, 100], steps: [-10, -5, 5, 10],
    desc: 'Skip coins that fell more than this over 24 hours. 100 = off.',
  },
  requireNoAuthorities: {
    group: 'filters', kind: 'bool', label: '🔒 Block mint/freeze authority',
    desc: 'ON = never buy a token whose creator can still mint more supply or freeze your tokens.',
  },
  scanIntervalMin: {
    group: 'filters', kind: 'num', label: '📡 Scan every', unit: ' min', min: 1, max: 180,
    presets: [1, 5, 10, 15, 30, 60], steps: [-15, -5, 5, 15, 30],
    desc: 'How often the scanner looks for a new coin. Tapping ✅ Apply & run scans right away.',
  },

  // ---------------- Execution ----------------
  buySlippagePct: {
    group: 'exec', kind: 'num', label: '🟢 Buy slippage', unit: '%', min: 1, max: 50,
    presets: [5, 10, 15, 25, 35, 50], steps: [-5, -1, 1, 5],
    desc: 'How much worse than the quote a BUY may fill. Too low = failed buys; too high = worse prices.',
  },
  sellSlippagePct: {
    group: 'exec', kind: 'num', label: '🔴 Sell slippage (first try)', unit: '%', min: 1, max: 90,
    presets: [10, 20, 30, 40, 55], steps: [-5, -1, 1, 5],
    desc: 'First-attempt slippage on a SELL. Failed sells retry with more room, up to the max below.',
  },
  sellSlippageMaxPct: {
    group: 'exec', kind: 'num', label: '🔴 Sell slippage (max)', unit: '%', min: 1, max: 90,
    presets: [30, 40, 55, 70, 90], steps: [-5, 5],
    desc: 'The most slippage a retried SELL may use. Keep it generous: an exit that cannot fill is no exit.',
  },
  buyPriorityFeeSol: {
    group: 'exec', kind: 'num', label: '⚡ Buy priority fee', unit: ' SOL', min: 0, max: 0.05,
    presets: [0.0001, 0.0003, 0.001, 0.003, 0.01], steps: [-0.0001, 0.0001],
    desc: 'Extra fee that gets a buy in faster. Higher = more reliable, costs more per trade.',
  },
  sellPriorityFeeSol: {
    group: 'exec', kind: 'num', label: '⚡ Sell priority fee', unit: ' SOL', min: 0, max: 0.05,
    presets: [0.0001, 0.0003, 0.001, 0.003, 0.01], steps: [-0.0001, 0.0001],
    desc: 'Extra fee on a sell. It is multiplied on each retry, so failed sells land faster.',
  },

  // ---------------- Learning ----------------
  learningMinTrades: {
    group: 'learning', kind: 'int', label: '🧠 Trades needed to learn', unit: '', min: 5, max: 500,
    presets: [10, 20, 30, 50, 100], steps: [-5, 5],
    desc: 'Learning only suggests changes after this many CLOSED trades. Fewer = faster but noisier.',
  },
};

const GROUPS = {
  trade: { title: '💵 Trade', blurb: 'How much to buy, when to sell, how many trades.' },
  filters: { title: '🔍 Entry filters', blurb: 'Which coins the scanner may pick.' },
  exec: { title: '⚙️ Execution', blurb: 'Slippage and fees on the swaps.' },
};

// Values the Easy / Medium / Hard buttons set. Everything else keeps your own value.
const PRESETS = {
  easy: {
    name: 'Easy', sizeUsd: 2, takeProfitPct: 30, stopLossPct: 20, maxHoldMin: 2, scanIntervalMin: 5, maxTradesDay: 7,
    maxPositionSol: 0.05, minAgeSec: 10 * DAY, maxAgeSec: 20 * DAY, minLiquidityUsd: 8000, minVolume1hUsd: 1500, minBuys1h: 5,
  },
  medium: {
    name: 'Medium', sizeUsd: 5, takeProfitPct: 60, stopLossPct: 30, maxHoldMin: 5, scanIntervalMin: 10, maxTradesDay: 15,
    maxPositionSol: 0.12, minAgeSec: 10 * DAY, maxAgeSec: 20 * DAY, minLiquidityUsd: 15000, minVolume1hUsd: 4000, minBuys1h: 12,
  },
  hard: {
    name: 'Hard', sizeUsd: 7, takeProfitPct: 100, stopLossPct: 45, maxHoldMin: 8, scanIntervalMin: 30, maxTradesDay: 20,
    maxPositionSol: 0.2, minAgeSec: 10 * DAY, maxAgeSec: 20 * DAY, minLiquidityUsd: 30000, minVolume1hUsd: 8000, minBuys1h: 20,
  },
};

// Starting values for settings that are not part of a preset (env values still win as the starting point).
const BASE_DEFAULTS = {
  maxOpen: 1,
  maxDailyLossPct: 25,
  minBuyPressure: 0.7,
  minChange1hPct: 0,
  minChange6hPct: 2,
  maxDrop5mPct: 12,
  maxDrop24hPct: 40,
  requireNoAuthorities: true,
  buySlippagePct: 15,
  sellSlippagePct: 30,
  sellSlippageMaxPct: 55,
  buyPriorityFeeSol: 0.0003,
  sellPriorityFeeSol: 0.0003,
  learningMode: 'suggest', // 'off' | 'suggest' | 'auto'
  learningMinTrades: 20,
};

// ---------------------------------------------------------------- formatting
function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(Number(v.toFixed(6)));
}

function fmtDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return String(sec);
  if (s < 120) return `${fmtNum(Math.round(s * 10) / 10)}s`;
  if (s < 3600) return `${fmtNum(Math.round((s / 60) * 10) / 10)}m`;
  if (s < 2 * DAY) return `${fmtNum(Math.round((s / 3600) * 10) / 10)}h`;
  return `${fmtNum(Math.round((s / DAY) * 10) / 10)}d`;
}

function fmtValue(key, v) {
  const d = SETTINGS[key];
  if (!d) return String(v);
  if (d.kind === 'bool') return v ? 'ON' : 'OFF';
  if (d.kind === 'dur') return fmtDuration(v);
  if (d.zero && Number(v) === 0) return d.zero;
  return `${fmtNum(v)}${d.unit || ''}`;
}

function fmtStep(d, s) {
  const sign = s > 0 ? '+' : '−';
  const a = Math.abs(s);
  return `${sign}${d.kind === 'dur' ? fmtDuration(a) : fmtNum(a)}`;
}

function rangeText(d) {
  if (d.kind === 'bool') return 'ON or OFF';
  const f = (v) => (d.kind === 'dur' ? fmtDuration(v) : `${fmtNum(v)}${d.unit || ''}`);
  return `${f(d.min)} – ${f(d.max)}`;
}

// ---------------------------------------------------------------- parsing + validation
const UNIT_SEC = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: DAY, day: DAY, days: DAY };

/** Turns what the user typed into a number (in the setting's own units). Returns { ok, value } or { ok:false, error } */
function parseInput(key, text) {
  const d = SETTINGS[key];
  if (!d) return { ok: false, error: 'Unknown setting.' };
  let t = String(text == null ? '' : text).trim().toLowerCase();
  if (d.kind === 'bool') {
    if (/^(on|yes|true|1)$/.test(t)) return { ok: true, value: true };
    if (/^(off|no|false|0)$/.test(t)) return { ok: true, value: false };
    return { ok: false, error: 'Send on or off.' };
  }
  if (/^(off|none|no cap|nocap|disable|disabled)$/.test(t) && d.zero) return { ok: true, value: 0 };
  t = t.replace(/[$%×x,]/g, (c) => (c === ',' ? '.' : '')).replace(/\s+/g, '');
  if (d.kind === 'dur') {
    const m = t.match(/^(\d+(?:\.\d+)?)([a-z]*)$/);
    if (!m) return { ok: false, error: `Send a time like 30s, 15m, 6h or 10d (${rangeText(d)}).` };
    const unit = m[2] || d.defaultUnit;
    if (!(unit in UNIT_SEC)) return { ok: false, error: 'Unit must be s, m, h or d — e.g. 30s, 15m, 6h, 10d.' };
    return checkRange(key, Number(m[1]) * UNIT_SEC[unit]);
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return { ok: false, error: `Send a number only (${rangeText(d)}).` };
  return checkRange(key, Number(t));
}

function checkRange(key, n) {
  const d = SETTINGS[key];
  if (!Number.isFinite(n)) return { ok: false, error: 'That is not a valid number.' };
  if (d.kind === 'int' && !Number.isInteger(n)) return { ok: false, error: `Must be a whole number (${rangeText(d)}).` };
  if (n < d.min - 1e-9 || n > d.max + 1e-9) return { ok: false, error: `Must be between ${rangeText(d)}. You sent ${fmtValue(key, n)}.` };
  return { ok: true, value: d.kind === 'dur' ? Math.round(n) : Number(n.toFixed(6)) };
}

/** Cross-setting rules checked against the full config. Returns an error string or null. */
function crossCheck(cfg) {
  if (Number(cfg.minAgeSec) >= Number(cfg.maxAgeSec)) {
    return `Min coin age (${fmtDuration(cfg.minAgeSec)}) must be lower than max coin age (${fmtDuration(cfg.maxAgeSec)}).`;
  }
  if (Number(cfg.sellSlippageMaxPct) < Number(cfg.sellSlippagePct)) {
    return `Max sell slippage (${fmtNum(cfg.sellSlippageMaxPct)}%) must not be below the first-try sell slippage (${fmtNum(cfg.sellSlippagePct)}%).`;
  }
  return null;
}

// Short names for /set <name> <value>
const ALIASES = {
  size: 'sizeUsd', cap: 'maxPositionSol', maxsol: 'maxPositionSol', tp: 'takeProfitPct', sl: 'stopLossPct', hold: 'maxHoldMin',
  maxday: 'maxTradesDay', day: 'maxTradesDay', open: 'maxOpen', loss: 'maxDailyLossPct', minage: 'minAgeSec', maxage: 'maxAgeSec',
  liq: 'minLiquidityUsd', liquidity: 'minLiquidityUsd', vol: 'minVolume1hUsd', volume: 'minVolume1hUsd', buys: 'minBuys1h',
  pressure: 'minBuyPressure', ratio: 'minBuyPressure', rise1h: 'minChange1hPct', rise6h: 'minChange6hPct', drop5m: 'maxDrop5mPct',
  drop24h: 'maxDrop24hPct', authority: 'requireNoAuthorities', scan: 'scanIntervalMin', buyslip: 'buySlippagePct',
  sellslip: 'sellSlippagePct', sellslipmax: 'sellSlippageMaxPct', buyfee: 'buyPriorityFeeSol', sellfee: 'sellPriorityFeeSol',
  learnmin: 'learningMinTrades',
};

function resolveKey(name) {
  const n = String(name || '').trim();
  if (SETTINGS[n]) return n;
  const low = n.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  return Object.keys(SETTINGS).find((k) => k.toLowerCase() === low) || null;
}

const keysInGroup = (g) => Object.keys(SETTINGS).filter((k) => SETTINGS[k].group === g);

module.exports = {
  SETTINGS, GROUPS, PRESETS, BASE_DEFAULTS, ALIASES, DAY, MIN_AGE_SEC, MAX_AGE_SEC,
  fmtNum, fmtDuration, fmtValue, fmtStep, rangeText, parseInput, checkRange, crossCheck, resolveKey, keysInGroup,
};
