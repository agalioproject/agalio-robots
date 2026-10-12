/**
 * Live settings: Easy / Medium / Hard presets + your own custom values.
 * Every value is validated against src/live/settings.js (no silent clamping: a value that is out
 * of range is REJECTED with the allowed range). Persisted so custom settings survive restarts.
 */
const S = require('./settings');
const env = require('../config');
const { PRESETS, BASE_DEFAULTS, SETTINGS } = S;

const DEFAULTS = {
  paused: false,
  riskProfile: 'medium',
  ...(() => {
    const { name: _n, ...p } = PRESETS.medium;
    return p;
  })(),
  ...BASE_DEFAULTS,
  // .env values are only the STARTING point for these; Telegram changes win afterwards.
  maxOpen: env.MAX_CONCURRENT,
  maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
  requireNoAuthorities: env.REQUIRE_NO_AUTHORITIES,
  buySlippagePct: env.BUY_SLIPPAGE_PCT,
  sellSlippagePct: env.SELL_SLIPPAGE_PCT,
  sellSlippageMaxPct: env.SELL_SLIPPAGE_MAX_PCT,
  buyPriorityFeeSol: env.BUY_PRIORITY_FEE_SOL,
  sellPriorityFeeSol: env.SELL_PRIORITY_FEE_SOL,
};

// Only keys we know about are ever kept (drops leftovers from older versions, e.g. capitalPct).
const KNOWN = new Set([...Object.keys(DEFAULTS)]);
const clean = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => KNOWN.has(k)));

let cached = { ...DEFAULTS };
let persistFn = null;
const listeners = new Set();

const getConfig = () => ({ ...cached });

function emit(patch) {
  for (const fn of listeners) {
    try {
      fn(getConfig(), patch);
    } catch (_) {
      /* a listener must never break a settings change */
    }
  }
}

/** Called after every change (the scanner uses it to re-scan right away). */
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function schedulePersist() {
  if (typeof persistFn === 'function') {
    try {
      persistFn({ ...cached });
    } catch (_) {
      /* persistence problems are reported by the store */
    }
  }
}

/** Direct internal change for non-validated keys (paused, learningMode). */
function applyLocal(patch) {
  cached = { ...cached, ...clean(patch) };
  schedulePersist();
  emit(patch);
  return getConfig();
}

/**
 * Set one setting from a raw value (number or typed text). Returns
 * { ok:true, value, cfg, notes } or { ok:false, error }.
 */
function setValue(key, raw) {
  const def = SETTINGS[key];
  if (!def) return { ok: false, error: `Unknown setting: ${key}` };
  const parsed = typeof raw === 'number' || typeof raw === 'boolean' ? (def.kind === 'bool' ? { ok: true, value: Boolean(raw) } : S.checkRange(key, raw)) : S.parseInput(key, raw);
  if (!parsed.ok) return parsed;
  const next = { ...cached, [key]: parsed.value };
  const cross = S.crossCheck(next);
  if (cross) return { ok: false, error: cross };
  cached = { ...next, riskProfile: 'custom' };
  schedulePersist();
  emit({ [key]: parsed.value });
  return { ok: true, value: parsed.value, cfg: getConfig(), notes: notesFor(key, getConfig()) };
}

/** Moves a value by a step (the − / + buttons). Out-of-range results are rejected, not clamped. */
function nudge(key, delta) {
  const def = SETTINGS[key];
  if (!def || def.kind === 'bool') return { ok: false, error: 'Not adjustable.' };
  const target = Number((Number(cached[key]) + Number(delta)).toFixed(6));
  const lo = def.min;
  const hi = def.max;
  // buttons stop at the edge instead of erroring (typing is the strict path)
  const bounded = Math.min(hi, Math.max(lo, target));
  return setValue(key, bounded);
}

function toggle(key) {
  const def = SETTINGS[key];
  if (!def || def.kind !== 'bool') return { ok: false, error: 'Not a switch.' };
  return setValue(key, !cached[key]);
}

function applyPreset(name) {
  const key = String(name || '').toLowerCase().trim();
  const preset = PRESETS[key];
  if (!preset) return null;
  const { name: _n, ...params } = preset;
  cached = { ...cached, riskProfile: key, ...params };
  schedulePersist();
  emit(params);
  return getConfig();
}

/** Things worth telling the user right after a change (so a setting never silently does less than asked). */
function notesFor(key, cfg) {
  const notes = [];
  if ((key === 'sizeUsd' || key === 'maxPositionSol') && Number(cfg.maxPositionSol) > 0) {
    notes.push(`ℹ️ Each buy is limited to ${S.fmtNum(cfg.maxPositionSol)} SOL by "Max SOL per trade" even if the dollar size is higher.`);
  }
  if (key === 'minAgeSec' || key === 'maxAgeSec') {
    notes.push(`ℹ️ Age window now ${S.fmtDuration(cfg.minAgeSec)} – ${S.fmtDuration(cfg.maxAgeSec)}.`);
  }
  if (cfg.paused) notes.push('⏸ Bot is paused — tap ✅ Apply & run to start trading with this plan.');
  return notes;
}

function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({
    key,
    name: p.name,
    summary: `$${p.sizeUsd} · TP +${p.takeProfitPct}% · SL −${p.stopLossPct}% · hold ${p.maxHoldMin}m · every ${p.scanIntervalMin}m · max ${p.maxTradesDay}/day`,
  }));
}

async function start() {
  try {
    const store = require('../storage/positionsStore');
    const saved = await store.get('state', 'liveConfig');
    if (saved && typeof saved === 'object') {
      cached = { ...DEFAULTS, ...clean(saved) };
      const cross = S.crossCheck(cached);
      if (cross) cached = { ...cached, minAgeSec: DEFAULTS.minAgeSec, maxAgeSec: DEFAULTS.maxAgeSec };
      console.log(`[live-config] restored ${cached.riskProfile} · $${cached.sizeUsd} · TP+${cached.takeProfitPct}% · SL−${cached.stopLossPct}% · hold ${cached.maxHoldMin}m · scan ${cached.scanIntervalMin}m`);
    } else {
      cached = { ...DEFAULTS };
      console.log('[live-config] defaults (medium)');
    }
    persistFn = (snapshot) => {
      store.save('state', 'liveConfig', () => snapshot, (e) => console.warn('[live-config] persist failed:', e.message));
    };
    schedulePersist();
  } catch (e) {
    console.warn('[live-config] load failed, using defaults:', e.message);
    cached = { ...DEFAULTS };
  }
}

module.exports = { getConfig, applyLocal, setValue, nudge, toggle, applyPreset, listPresets, onChange, notesFor, PRESETS, DEFAULTS, start };
