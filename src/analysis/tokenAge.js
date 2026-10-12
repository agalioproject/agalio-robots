// Token-age entry filter: "only buy coins that are at least X seconds and at most Y days old".
//
// How age is known
//   1. When the bot's own detector first sees a token (a fresh launch / new pair)
//      it calls markSeen(). That is the token's launch time to within a second or
//      two, and costs nothing extra on the hot path.
//   2. If the bot has never seen it (pasted into /analyze, or after a restart),
//      the earliest DexScreener pair-creation time is used.
//   3. If neither is available the age is UNKNOWN. Unknown age passes the max-age
//      check (it cannot be proven too old) and is reported as such.
const { getTokenMarket } = require('./dexscreener');

const firstSeen = new Map(); // address lower -> ms
const MAX_TRACKED = 5000;

function markSeen(address, at = Date.now()) {
  const key = String(address || '').toLowerCase();
  if (!key || firstSeen.has(key)) return;
  if (firstSeen.size >= MAX_TRACKED) firstSeen.delete(firstSeen.keys().next().value);
  firstSeen.set(key, at);
}

async function getAgeMs(address, { allowLookup = true } = {}) {
  const key = String(address || '').toLowerCase();
  const seen = firstSeen.get(key);
  if (seen) return { ageMs: Date.now() - seen, source: 'detected' };
  if (!allowLookup) return { ageMs: null, source: 'unknown' };
  try {
    const mkt = await getTokenMarket(address);
    if (mkt && mkt.pairCreatedAt) return { ageMs: Math.max(0, Date.now() - mkt.pairCreatedAt), source: 'dexscreener' };
  } catch (_) {
    /* fall through */
  }
  return { ageMs: null, source: 'unknown' };
}

const fmtAge = (ms) => {
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
};

// -> { ok, ageMs, source, waitMs, reason }
//   ok=false  : too old (never buy)
//   waitMs>0  : too young — wait this long, then it's fine
async function checkAge(address, cfg, { skipMin = false, allowLookup = true } = {}) {
  const minMs = Math.max(0, Number(cfg.minAgeSec) || 0) * 1000;
  const maxMs = Number(cfg.maxAgeDays) > 0 ? Number(cfg.maxAgeDays) * 86_400_000 : 0;
  const { ageMs, source } = await getAgeMs(address, { allowLookup });
  const out = { ok: true, ageMs, source, waitMs: 0, reason: null };
  if (ageMs == null) return out;
  if (maxMs > 0 && ageMs > maxMs) {
    return { ...out, ok: false, reason: `Token is ${fmtAge(ageMs)} old — older than your ${cfg.maxAgeDays}-day limit.` };
  }
  if (!skipMin && ageMs < minMs) out.waitMs = minMs - ageMs;
  return out;
}

module.exports = { markSeen, getAgeMs, checkAge, fmtAge };
