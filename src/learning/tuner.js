/**
 * Learning mode. Learns from THIS bot's own closed trades (the journal) and tunes entry + exit settings.
 *
 *   off     – nothing is suggested or changed
 *   suggest – shows what it would change; you tap "Apply suggestions"  (default)
 *   auto    – every ADAPT_EVERY new closed trades it applies the suggestions in small bounded steps
 *             and tells you exactly what changed
 *
 * It can tune: take profit, max hold, min liquidity, min 1h volume, min buys, min buy/sell ratio,
 * min coin age and max coin age.
 * It NEVER touches: trade size, max SOL per trade, max open positions, daily loss limit, slippage,
 * fees, the authority switch, scan interval, trades per day, stop loss, or your preset.
 *
 * Honest limits: a few dozen trades are a small sample. Suggestions need `learningMinTrades` closed
 * trades first, are only ever made when the data shows a clear gap, and are hints, not promises.
 */
const memory = require('./memory');
const live = require('../live/liveConfig');
const { fmtValue, SETTINGS } = require('../live/settings');
const logger = require('../utils/logger');

const ADAPT_EVERY = 10;
const MIN_SIDE = 5; // trades needed on each side of a split before trusting it
const MIN_GAP_PCT = 3; // the better side must beat the worse side by this many percentage points
let notifier = () => {};
let lastAdaptCount = null;
let adapting = false;

const setNotifier = (fn) => {
  notifier = typeof fn === 'function' ? fn : () => {};
};

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const roundTo = (n, step) => Math.round(n / step) * step;

/** Closed trades with a known result, newest last. */
function usable() {
  return memory.getJournal().filter((r) => finite(Number(r.pct)));
}

function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => Number(r.pct) > 0).length;
  return { n, wins, winRate: n ? (wins / n) * 100 : 0, avgPct: avg(rows.map((r) => Number(r.pct))) };
}

function stats() {
  const rows = usable();
  const byExit = {};
  for (const r of rows) (byExit[r.exit || '?'] = byExit[r.exit || '?'] || []).push(r);
  return {
    total: summarize(rows),
    byExit: Object.fromEntries(Object.entries(byExit).map(([k, v]) => [k, summarize(v)])),
  };
}

/**
 * Looks for a value of `field` that splits trades into a clearly worse group and a clearly better one.
 * side 'floor': trades BELOW the split lose -> suggest raising the minimum to the split.
 * side 'ceil' : trades ABOVE the split lose -> suggest lowering the maximum to the split.
 */
function bestSplit(rows, field, side) {
  const withF = rows.filter((r) => finite(Number(r[field]))).map((r) => ({ f: Number(r[field]), pct: Number(r.pct) }));
  if (withF.length < MIN_SIDE * 2) return null;
  const sorted = withF.map((r) => r.f).sort((a, b) => a - b);
  const cands = [0.2, 0.35, 0.5, 0.65].map((q) => sorted[Math.floor(q * (sorted.length - 1))]);
  let best = null;
  for (const c of [...new Set(cands)]) {
    const low = withF.filter((r) => r.f < c);
    const high = withF.filter((r) => r.f >= c);
    const bad = side === 'floor' ? low : high;
    const good = side === 'floor' ? high : low;
    if (bad.length < MIN_SIDE || good.length < Math.max(MIN_SIDE, withF.length * 0.4)) continue;
    const badAvg = avg(bad.map((r) => r.pct));
    const goodAvg = avg(good.map((r) => r.pct));
    if (badAvg >= 0 || goodAvg - badAvg < MIN_GAP_PCT) continue;
    const gap = goodAvg - badAvg;
    if (!best || gap > best.gap) best = { value: c, gap, badAvg, goodAvg, badN: bad.length, goodN: good.length };
  }
  return best;
}

const niceDown = (v, step) => Math.floor(v / step) * step;

/** -> { ready, n, needed, suggestions:[{key,current,suggested,why}] } */
function suggest(cfg = live.getConfig()) {
  const rows = usable();
  const needed = Math.max(5, Number(cfg.learningMinTrades) || 20);
  const out = { ready: rows.length >= needed, n: rows.length, needed, suggestions: [] };
  if (!out.ready) return out;
  const add = (key, current, suggested, why) => {
    if (Number(current) !== Number(suggested)) out.suggestions.push({ key, current, suggested, why });
  };

  // Take profit: where trades actually peak
  const peaks = rows.map((r) => Number(r.peakPnl)).filter((n) => finite(n) && n > 0);
  if (peaks.length >= Math.min(needed, 10)) {
    const tp = clamp(roundTo(median(peaks), 5), SETTINGS.takeProfitPct.min, SETTINGS.takeProfitPct.max);
    add('takeProfitPct', cfg.takeProfitPct, tp, `Half of your trades peaked at about +${tp}% or more, so a target near that actually fills.`);
  }

  // Max hold: when the peak usually happens
  const peakMin = rows.filter((r) => Number(r.peakPnl) >= 5 && finite(Number(r.peakAtSec))).map((r) => Number(r.peakAtSec) / 60);
  if (peakMin.length >= 8) {
    const hold = clamp(roundTo(median(peakMin) * 1.5, 1), SETTINGS.maxHoldMin.min, SETTINGS.maxHoldMin.max);
    add('maxHoldMin', cfg.maxHoldMin, hold, `Trades usually peak around ${median(peakMin).toFixed(1)} min in; holding much longer mostly gives profit back.`);
  }

  // Entry-filter floors: raise a minimum when everything below some value loses
  const floors = [
    ['minLiquidityUsd', 'liq', 1000, 'liquidity'],
    ['minVolume1hUsd', 'vol1h', 500, '1h volume'],
    ['minBuys1h', 'buys1h', 1, 'buys per hour'],
    ['minBuyPressure', 'buyPressure', 0.1, 'buy/sell ratio'],
    ['minAgeSec', 'ageSec', 3600, 'coin age'],
  ];
  for (const [key, field, step, label] of floors) {
    const s = bestSplit(rows, field, 'floor');
    if (!s) continue;
    const target = clamp(niceDown(s.value, step), SETTINGS[key].min, SETTINGS[key].max);
    if (target <= Number(cfg[key])) continue; // only ever TIGHTEN entry filters automatically
    add(key, cfg[key], target, `Trades with ${label} below ${fmtValue(key, target)} averaged ${s.badAvg.toFixed(1)}% (${s.badN} trades) vs ${s.goodAvg.toFixed(1)}% above (${s.goodN}).`);
  }
  // Max age: lower it when the oldest coins lose
  const ceil = bestSplit(rows, 'ageSec', 'ceil');
  if (ceil) {
    const target = clamp(roundTo(ceil.value, 3600), SETTINGS.maxAgeSec.min, SETTINGS.maxAgeSec.max);
    if (target < Number(cfg.maxAgeSec) && target > Number(cfg.minAgeSec)) {
      add('maxAgeSec', cfg.maxAgeSec, target, `Coins older than ${fmtValue('maxAgeSec', target)} averaged ${ceil.badAvg.toFixed(1)}% (${ceil.badN} trades) vs ${ceil.goodAvg.toFixed(1)}% for younger ones (${ceil.goodN}).`);
    }
  }
  return out;
}

// Auto mode moves TP / hold at most 30% per cycle, and filters half-way to the target.
function bounded(key, current, target) {
  const cur = Number(current);
  if (key === 'takeProfitPct' || key === 'maxHoldMin') return clamp(Math.round(target), Math.ceil(cur * 0.7), Math.floor(cur * 1.3));
  return cur + (target - cur) / 2;
}

/** Applies the current suggestions through the normal validated setter. */
function applySuggestions({ stepped = false } = {}) {
  const s = suggest();
  if (!s.ready) return { applied: [], reason: `Needs ${s.needed} closed trades (have ${s.n}).` };
  const applied = [];
  for (const x of s.suggestions) {
    let v = stepped ? bounded(x.key, x.current, x.suggested) : x.suggested;
    if (SETTINGS[x.key].kind === 'int') v = Math.round(v);
    if (SETTINGS[x.key].kind === 'dur') v = Math.round(v);
    const res = live.setValue(x.key, Number(Number(v).toFixed(4)));
    if (res.ok) applied.push({ ...x, applied: res.value });
    else logger.warn(`learning: could not apply ${x.key}=${v}: ${res.error}`);
  }
  lastAdaptCount = memory.getJournal().length;
  return { applied };
}

/** Called after every closed trade. */
function afterTrade() {
  const cfg = live.getConfig();
  if (cfg.learningMode !== 'auto' || adapting) return;
  const n = usable().length;
  if (lastAdaptCount == null) lastAdaptCount = 0;
  if (n < Math.max(5, Number(cfg.learningMinTrades) || 20) || n - lastAdaptCount < ADAPT_EVERY) return;
  adapting = true;
  try {
    const { applied } = applySuggestions({ stepped: true });
    if (applied.length) {
      notifier(
        `🧠 Learning updated your settings (from ${n} closed trades):\n` +
          applied.map((a) => `• ${SETTINGS[a.key].label}: ${fmtValue(a.key, a.current)} → ${fmtValue(a.key, a.applied)}\n   ${a.why}`).join('\n') +
          `\n\nChange any of these in Settings, or switch Learning to Suggest to stop automatic changes.`
      );
    }
  } finally {
    adapting = false;
  }
}

module.exports = { setNotifier, stats, suggest, applySuggestions, afterTrade, bestSplit, _reset: () => { lastAdaptCount = null; } };
