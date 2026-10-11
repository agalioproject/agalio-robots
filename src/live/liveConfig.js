/**
 * Risk presets + live custom overrides.
 * Persisted to store (Supabase/files) so custom settings survive restarts.
 */
const PRESETS = {
  easy: {
    name: 'Easy',
    sizeUsd: 2,
    takeProfitPct: 30,
    stopLossPct: 20,
    maxHoldMin: 2,
    scanIntervalMin: 5,
    maxTradesDay: 7,
    capitalPct: 3,
    maxPositionSol: 0.05,
  },
  medium: {
    name: 'Medium',
    sizeUsd: 5,
    takeProfitPct: 60,
    stopLossPct: 30,
    maxHoldMin: 5,
    scanIntervalMin: 10,
    maxTradesDay: 15,
    capitalPct: 5,
    maxPositionSol: 0.12,
  },
  hard: {
    name: 'Hard',
    sizeUsd: 7,
    takeProfitPct: 100,
    stopLossPct: 45,
    maxHoldMin: 8,
    scanIntervalMin: 30,
    maxTradesDay: 20,
    capitalPct: 8,
    maxPositionSol: 0.2,
  },
};

const DEFAULTS = {
  paused: false,
  riskProfile: 'medium',
  ...PRESETS.medium,
};

let cached = { ...DEFAULTS };
let persistFn = null;

function getConfig() {
  return { ...cached };
}

function applyLocal(patch) {
  cached = { ...cached, ...patch };
  schedulePersist();
  return getConfig();
}

function applyPreset(name) {
  const key = String(name || '').toLowerCase().trim();
  const preset = PRESETS[key];
  if (!preset) return null;
  const { name: _n, ...params } = preset;
  cached = { ...cached, riskProfile: key, ...params };
  schedulePersist();
  return getConfig();
}

function applyCustom(params = {}) {
  const allowed = [
    'sizeUsd', 'takeProfitPct', 'stopLossPct', 'maxHoldMin',
    'scanIntervalMin', 'maxTradesDay', 'maxPositionSol', 'capitalPct',
  ];
  const patch = { riskProfile: 'custom' };
  for (const k of allowed) {
    if (params[k] != null && Number.isFinite(Number(params[k]))) {
      let n = Number(params[k]);
      if (k === 'sizeUsd') n = Math.max(0.5, Math.min(100, n));
      if (k === 'takeProfitPct') n = Math.max(5, Math.min(500, n));
      if (k === 'stopLossPct') n = Math.max(5, Math.min(90, n));
      if (k === 'maxHoldMin') n = Math.max(1, Math.min(240, n));
      if (k === 'scanIntervalMin') n = Math.max(1, Math.min(180, n));
      if (k === 'maxTradesDay') n = Math.max(1, Math.min(100, Math.round(n)));
      if (k === 'maxPositionSol') n = Math.max(0.01, Math.min(5, n));
      patch[k] = n;
    }
  }
  cached = { ...cached, ...patch };
  schedulePersist();
  return getConfig();
}

function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({
    key,
    name: p.name,
    summary: `$${p.sizeUsd} · TP +${p.takeProfitPct}% · SL −${p.stopLossPct}% · hold ${p.maxHoldMin}m · every ${p.scanIntervalMin}m · max ${p.maxTradesDay}/day`,
  }));
}

function schedulePersist() {
  if (typeof persistFn === 'function') {
    try {
      persistFn({ ...cached });
    } catch (_) {}
  }
}

async function start() {
  try {
    const store = require('../storage/positionsStore');
    const saved = await store.get('state', 'liveConfig');
    if (saved && typeof saved === 'object') {
      cached = { ...DEFAULTS, ...saved };
      console.log(
        `[live-config] restored ${cached.riskProfile} · $${cached.sizeUsd} · TP+${cached.takeProfitPct}% · SL−${cached.stopLossPct}% · hold ${cached.maxHoldMin}m · scan ${cached.scanIntervalMin}m`
      );
    } else {
      cached = { ...DEFAULTS };
      console.log('[live-config] defaults (medium)');
    }
    persistFn = (snapshot) => {
      store.save('state', 'liveConfig', () => snapshot, (e) =>
        console.warn('[live-config] persist failed:', e.message)
      );
    };
    schedulePersist();
  } catch (e) {
    console.warn('[live-config] load failed, using defaults:', e.message);
    cached = { ...DEFAULTS };
  }
}

module.exports = {
  getConfig,
  applyLocal,
  applyPreset,
  applyCustom,
  listPresets,
  PRESETS,
  start,
};
