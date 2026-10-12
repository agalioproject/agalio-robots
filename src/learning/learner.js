// Learning mode: learns from this bot's OWN closed trades and tunes the entry
// and exit settings.
//
// What it does
//   - Records every closed trade with the context it was entered in (risk tier,
//     score, category, dev/top-10 %, market cap) and how it played out (P&L, exit
//     reason, peak profit, time to peak).
//   - Once there are enough trades it suggests: entry-quality ceiling (risk
//     score), take-profit, max hold time, and (if MEDIUM is losing) the tier.
//   - Modes (Telegram → 🧠 Learning):
//       off     — records nothing, suggests nothing
//       suggest — records + tells you what it would change; you tap Apply
//       auto    — applies suggestions itself, in small bounded steps
//
// What it will NEVER touch: position size / capital %, safety toggles
// (mint/rug blocks), stop loss, wallets, launchpads, pause state.
//
// Honest limits: with a few dozen trades the numbers are noisy, and past
// results don't promise future ones. Suggestions need `learningMinTrades` closed
// trades before they appear.
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../live/supabaseClient');

const FILE = process.env.LEARNING_FILE || path.join(__dirname, '..', '..', 'learning-data.json');
const MAX_TRADES = 1000;
const ADAPT_EVERY = 10; // auto mode re-tunes after this many NEW closed trades
const MIN_BUCKET = 5; // trades needed in a score bucket before we trust it
const SCORE_BUCKETS = [
  { label: '0–15', lo: 0, hi: 15 },
  { label: '16–25', lo: 16, hi: 25 },
  { label: '26–40', lo: 26, hi: 40 },
  { label: '41–60', lo: 41, hi: 60 },
  { label: '61–100', lo: 61, hi: 100 },
];

let state = { trades: [], lastAdaptCount: 0 };
let applier = null; // async (patch) => cfg   — set by the Telegram bot
let notifier = () => {}; // (text) => void
let getCfg = () => ({});

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.trades)) state = { trades: raw.trades, lastAdaptCount: raw.lastAdaptCount || 0 };
  } catch (_) {
    /* first run */
  }
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch (err) {
    console.error('[learning] failed to persist:', err.message);
  }
}

// On hosts with ephemeral disks (Railway redeploys) the local file is lost, so
// when Supabase is configured we also reload history from its trade_outcomes table.
async function init({ applyConfig, notify, config }) {
  applier = applyConfig;
  notifier = notify || notifier;
  getCfg = config || getCfg;
  load();
  const supabase = getSupabase();
  if (supabase && state.trades.length === 0) {
    try {
      const { data, error } = await supabase.from('trade_outcomes').select('*').order('closed_at', { ascending: false }).limit(MAX_TRADES);
      if (!error && data && data.length) {
        state.trades = data.reverse().map((r) => ({
          ts: Date.parse(r.closed_at), chain: r.chain, tier: r.tier, score: Number(r.score), category: r.category,
          devPercent: r.dev_percent == null ? null : Number(r.dev_percent), top10Percent: r.top10_percent == null ? null : Number(r.top10_percent),
          pnlPct: Number(r.pnl_pct), reason: r.exit_reason, heldMs: Number(r.held_ms), peakPnlPct: Number(r.peak_pnl_pct),
          peakAtMs: Number(r.peak_at_ms), dryRun: Boolean(r.dry_run),
        }));
        state.lastAdaptCount = state.trades.length;
        save();
      }
    } catch (err) {
      console.warn('[learning] could not reload history from Supabase:', err.message);
    }
  }
  console.log(`[learning] loaded ${state.trades.length} past trades`);
}

// ---------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------
async function record(outcome) {
  const cfg = getCfg();
  if (cfg.learningMode === 'off') return;
  const t = {
    ts: Date.now(),
    chain: outcome.chain,
    tier: outcome.tier || null,
    score: Number(outcome.score ?? 0),
    category: outcome.category || null,
    devPercent: outcome.devPercent ?? null,
    top10Percent: outcome.top10Percent ?? null,
    pnlPct: Number(outcome.pnlPct),
    reason: outcome.reason,
    heldMs: Number(outcome.heldMs || 0),
    peakPnlPct: Number(outcome.peakPnlPct || 0),
    peakAtMs: Number(outcome.peakAtMs || 0),
    dryRun: Boolean(outcome.dryRun),
  };
  if (!Number.isFinite(t.pnlPct)) return;
  state.trades.push(t);
  if (state.trades.length > MAX_TRADES) state.trades.shift();
  save();

  const supabase = getSupabase();
  if (supabase) {
    supabase
      .from('trade_outcomes')
      .insert({
        chain: t.chain, tier: t.tier, score: t.score, category: t.category, dev_percent: t.devPercent, top10_percent: t.top10Percent,
        pnl_pct: t.pnlPct, exit_reason: t.reason, held_ms: Math.round(t.heldMs), peak_pnl_pct: t.peakPnlPct, peak_at_ms: Math.round(t.peakAtMs),
        dry_run: t.dryRun,
      })
      .then(({ error }) => {
        if (error) console.warn('[learning] could not save to Supabase (run migration 005?):', error.message);
      });
  }

  try {
    await maybeAutoAdapt();
  } catch (err) {
    console.error('[learning] auto-adapt failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const roundTo = (n, step) => Math.round(n / step) * step;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function summarize(list) {
  const n = list.length;
  const wins = list.filter((t) => t.pnlPct > 0).length;
  return { n, wins, winRate: n ? (wins / n) * 100 : 0, avgPnl: avg(list.map((t) => t.pnlPct)) };
}

function stats() {
  const t = state.trades;
  const group = (keyFn) => {
    const m = {};
    for (const x of t) {
      const k = keyFn(x);
      if (k == null) continue;
      (m[k] = m[k] || []).push(x);
    }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, summarize(v)]));
  };
  return {
    total: summarize(t),
    dryRunCount: t.filter((x) => x.dryRun).length,
    byTier: group((x) => x.tier),
    byCategory: group((x) => x.category),
    byExit: group((x) => x.reason),
    byScore: Object.fromEntries(
      SCORE_BUCKETS.map((b) => [b.label, summarize(t.filter((x) => x.score >= b.lo && x.score <= b.hi))])
    ),
  };
}

// Returns { ready, n, needed, suggestions: [{ key, current, suggested, why }] }
function suggest(cfg = getCfg()) {
  const t = state.trades;
  const needed = Math.max(5, Number(cfg.learningMinTrades) || 20);
  const out = { ready: t.length >= needed, n: t.length, needed, suggestions: [] };
  if (!out.ready) return out;
  const add = (key, current, suggested, why) => {
    if (String(current) !== String(suggested)) out.suggestions.push({ key, current, suggested, why });
  };

  // 1) Entry-quality ceiling: widen until the first score bucket that loses money.
  let ceiling = null;
  for (const b of SCORE_BUCKETS) {
    const inB = t.filter((x) => x.score >= b.lo && x.score <= b.hi);
    if (inB.length < MIN_BUCKET) continue;
    if (avg(inB.map((x) => x.pnlPct)) < 0) break;
    ceiling = b.hi;
  }
  if (ceiling == null) {
    const first = SCORE_BUCKETS.find((b) => t.filter((x) => x.score >= b.lo && x.score <= b.hi).length >= MIN_BUCKET);
    if (first) ceiling = SCORE_BUCKETS[0].hi; // nothing is profitable: be as picky as the lowest bucket
  }
  if (ceiling != null) {
    add('maxRiskScore', cfg.maxRiskScore, ceiling, `Trades scoring above ${ceiling} have lost money on average (or too few to trust).`);
  }

  // 2) Tier: if MEDIUM is a net loser over enough trades, stop buying it.
  const med = t.filter((x) => x.tier === 'MEDIUM');
  if (cfg.minRecommendTier !== 'LOW' && med.length >= 8 && avg(med.map((x) => x.pnlPct)) < 0) {
    add('minRecommendTier', cfg.minRecommendTier, 'LOW', `MEDIUM-tier trades average ${avg(med.map((x) => x.pnlPct)).toFixed(1)}% over ${med.length} trades.`);
  }

  // 3) Take profit: a target above where most trades actually peak rarely fills.
  const peaks = t.filter((x) => x.peakPnlPct > 0).map((x) => x.peakPnlPct);
  if (peaks.length >= Math.min(needed, 10)) {
    const tp = clamp(roundTo(median(peaks), 5), 10, 200);
    add('takeProfitPct', cfg.takeProfitPct, tp, `Half of your trades peaked at about +${tp}% or more, so a target near that actually fills.`);
  }

  // 4) Max hold: when the peak usually happens, plus headroom.
  const peakTimes = t.filter((x) => x.peakPnlPct >= 5 && x.peakAtMs > 0).map((x) => x.peakAtMs / 60000);
  if (peakTimes.length >= 8) {
    const hold = clamp(roundTo(median(peakTimes) * 1.5, 1), 3, 60);
    add('maxHoldMin', cfg.maxHoldMin, hold, `Trades usually peak around ${median(peakTimes).toFixed(1)} min in; holding much longer mostly gives profit back.`);
  }
  return out;
}

// ---------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------
// In auto mode, take-profit and max hold move at most 30% per cycle from a
// value you already set, and the score ceiling at most 15 points.
function bounded(key, current, target) {
  const cur = Number(current);
  if (key === 'maxRiskScore') return clamp(target, cur - 15, cur + 15);
  if ((key === 'takeProfitPct' || key === 'maxHoldMin') && cur > 0) {
    return roundTo(clamp(target, cur * 0.7, cur * 1.3), key === 'takeProfitPct' ? 5 : 1);
  }
  return target;
}

async function applySuggestions({ stepped = false } = {}) {
  if (!applier) throw new Error('Learning is not wired to the config yet.');
  const cfg = getCfg();
  const s = suggest(cfg);
  if (!s.ready) return { applied: [], reason: `Needs ${s.needed} closed trades (have ${s.n}).` };
  const patch = {};
  const applied = [];
  for (const x of s.suggestions) {
    let v = x.suggested;
    if (stepped && typeof v === 'number') v = bounded(x.key, x.current, v);
    if (typeof v === 'number') v = Math.max(1, v);
    if (v === x.current) continue;
    patch[x.key] = v;
    applied.push({ ...x, applied: v });
  }
  if (applied.length) await applier(patch);
  state.lastAdaptCount = state.trades.length;
  save();
  return { applied };
}

async function maybeAutoAdapt() {
  const cfg = getCfg();
  if (cfg.learningMode !== 'auto') return;
  const s = suggest(cfg);
  if (!s.ready || state.trades.length - state.lastAdaptCount < ADAPT_EVERY) return;
  const { applied } = await applySuggestions({ stepped: true });
  if (applied.length) {
    notifier(
      `🧠 Learning updated your settings (from ${state.trades.length} closed trades):\n` +
        applied.map((a) => `• ${LABELS[a.key] || a.key}: ${fmtVal(a.current)} → ${fmtVal(a.applied)} — ${a.why}`).join('\n') +
        `\n\nUndo any of these under 🧠 Learning / the setting's own screen, or switch Learning to Suggest to stop auto-changes.`
    );
  }
}

const LABELS = {
  maxRiskScore: 'Entry quality (max score)',
  minRecommendTier: 'Risk tier',
  takeProfitPct: 'Take profit %',
  maxHoldMin: 'Max hold (min)',
};
const fmtVal = (v) => (v === 'LOW' ? 'LOW only' : v === 'LOW_MEDIUM' ? 'LOW + MEDIUM' : v === 'ANY' ? 'any tier' : v === 0 ? 'auto' : String(v));

function reset() {
  state = { trades: [], lastAdaptCount: 0 };
  save();
  const supabase = getSupabase();
  if (supabase) supabase.from('trade_outcomes').delete().neq('id', 0).then(() => {}, () => {});
}

const count = () => state.trades.length;

module.exports = { init, record, stats, suggest, applySuggestions, reset, count, LABELS, fmtVal };
