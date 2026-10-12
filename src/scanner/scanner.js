/**
 * Direct token scanner.
 * Picks coins that pass EVERY entry filter in your settings (Settings → Entry filters):
 * age window, liquidity, volume, buys, buy/sell ratio, "rising" rule, 5m / 24h drop limits.
 * The same filters are checked again right before buying (src/trading/positions.js), and the
 * scanner records WHY coins were rejected so you can see what to loosen.
 */
const logger = require('../utils/logger');
const market = require('../analysis/dexscreener');
const { getConfig } = require('../live/liveConfig');
const { fmtDuration, fmtNum } = require('../live/settings');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let timer = null;
let lastScanAt = 0;
let onSignal = null;
let lastResult = null;
const seen = new Map();
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchSolPriceUsd() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 180;
    const data = await res.json();
    const pair = (data.pairs || []).find((p) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT');
    const px = Number(pair?.priceUsd || 0);
    return px > 10 ? px : 180;
  } catch {
    return 180;
  }
}

async function fetchJson(url, ms = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return res.ok ? res.json() : null;
}

async function fetchCandidates() {
  const mints = new Set();
  const add = (chainId, addr) => {
    if (chainId === 'solana' && addr) mints.add(addr);
  };
  for (const url of ['https://api.dexscreener.com/token-boosts/latest/v1', 'https://api.dexscreener.com/token-profiles/latest/v1']) {
    try {
      for (const item of (await fetchJson(url)) || []) add(item.chainId, item.tokenAddress);
    } catch (e) {
      logger.warn(`${url.split('/').slice(-2, -1)[0]} fetch failed:`, e.message);
    }
  }
  try {
    const data = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=solana');
    for (const p of (data && data.pairs) || []) add(p.chainId, p.baseToken?.address);
  } catch (_) {
    /* optional source */
  }
  return [...mints].slice(0, 50);
}

/**
 * Checks one market snapshot against ALL your entry filters.
 * Returns { ok:true, score } or { ok:false, reason } — reason is a short bucket name for the rejection stats.
 * Pure (no network), so it is unit-tested.
 */
function evaluate(mkt, cfg) {
  if (!mkt || !(mkt.priceNative > 0)) return { ok: false, reason: 'no SOL price' };

  if (mkt.ageSec == null) return { ok: false, reason: 'age unknown' };
  if (mkt.ageSec < cfg.minAgeSec) return { ok: false, reason: `younger than ${fmtDuration(cfg.minAgeSec)}` };
  if (mkt.ageSec > cfg.maxAgeSec) return { ok: false, reason: `older than ${fmtDuration(cfg.maxAgeSec)}` };

  const liq = mkt.liquidityUsd || 0;
  const vol1h = mkt.volume1h || 0;
  const vol6h = mkt.volume6h || 0;
  const ch5 = mkt.priceChange5m || 0;
  const ch1h = mkt.priceChange1h || 0;
  const ch6h = mkt.priceChange6h || 0;
  const ch24h = mkt.priceChange24h || 0;
  const buys1h = mkt.buys1h || 0;
  const sells1h = mkt.sells1h || 0;

  if (liq < cfg.minLiquidityUsd) return { ok: false, reason: `liquidity < $${fmtNum(cfg.minLiquidityUsd)}` };
  if (vol1h < cfg.minVolume1hUsd && vol6h < cfg.minVolume1hUsd * 3) return { ok: false, reason: `volume < $${fmtNum(cfg.minVolume1hUsd)}/h` };
  if (buys1h < cfg.minBuys1h) return { ok: false, reason: `buys < ${cfg.minBuys1h}/h` };

  const buyPressure = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 2 : 0;
  if (buyPressure < cfg.minBuyPressure) return { ok: false, reason: `buy/sell ratio < ${fmtNum(cfg.minBuyPressure)}` };

  const rising = ch1h > cfg.minChange1hPct || ch6h > cfg.minChange6hPct;
  if (!rising) return { ok: false, reason: 'not rising' };
  if (ch5 < -cfg.maxDrop5mPct) return { ok: false, reason: `fell > ${fmtNum(cfg.maxDrop5mPct)}% in 5m` };
  if (ch24h < -cfg.maxDrop24hPct) return { ok: false, reason: `fell > ${fmtNum(cfg.maxDrop24hPct)}% in 24h` };

  let score = 0;
  score += Math.min(ch5, 25) * 1.5;
  score += Math.min(ch1h, 40) * 2;
  score += Math.min(ch6h, 60);
  score += Math.log10(Math.max(liq, 1)) * 10;
  score += Math.log10(Math.max(vol1h, 1)) * 6;
  score += Math.min(buyPressure, 3) * 8;
  score += Math.min(mkt.ageSec / 86400, 60) * 0.3;
  return { ok: true, score };
}

function pruneSeen() {
  const now = Date.now();
  for (const [m, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(m);
}

async function pickOne() {
  const cfg = getConfig();
  pruneSeen();
  const candidates = await fetchCandidates();
  const result = { at: Date.now(), candidates: candidates.length, checked: 0, rejects: {}, picked: null };
  lastResult = result;
  if (!candidates.length) {
    logger.info('scanner: no candidates this cycle');
    return null;
  }

  const scored = [];
  for (const mint of candidates) {
    if (seen.has(mint) || config.IGNORE_MINTS.includes(mint)) continue;
    try {
      const mkt = await market.getTokenMarket(mint);
      result.checked += 1;
      const ev = evaluate(mkt, cfg);
      if (ev.ok) scored.push({ mint, mkt, score: ev.score });
      else result.rejects[ev.reason] = (result.rejects[ev.reason] || 0) + 1;
    } catch (_) {
      result.rejects['lookup failed'] = (result.rejects['lookup failed'] || 0) + 1;
    }
    await sleep(120);
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) {
    const top = Object.entries(result.rejects).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ');
    logger.info(`scanner: ${candidates.length} candidates, none passed your filters — most common: ${top || 'n/a'}`);
    return null;
  }

  const pool = scored.slice(0, 5);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  seen.set(pick.mint, Date.now());
  result.picked = pick.mint;
  logger.info(
    `scanner pick ${pick.mint.slice(0, 8)}… score=${pick.score.toFixed(1)} age=${fmtDuration(pick.mkt.ageSec)} liq=$${Math.round(pick.mkt.liquidityUsd)} ch1h=${(pick.mkt.priceChange1h || 0).toFixed(1)}% buys1h=${pick.mkt.buys1h || 0}`
  );
  return pick;
}

async function tick(force = false) {
  if (running) return;
  const cfg = getConfig();
  if (cfg.paused) return;
  const intervalMs = (Number(cfg.scanIntervalMin) || 10) * 60 * 1000;
  if (!force && Date.now() - lastScanAt < intervalMs - 2000) return;

  running = true;
  lastScanAt = Date.now();
  try {
    const pick = await pickOne();
    if (pick && typeof onSignal === 'function') await onSignal(pick);
  } catch (e) {
    logger.error('scanner tick:', e.message);
  } finally {
    running = false;
  }
}

/** Scan immediately instead of waiting for the interval (used by "Apply & run"). */
function rescanNow() {
  lastScanAt = 0;
  setTimeout(() => tick(true).catch(() => {}), 500).unref();
}

function start(handler) {
  onSignal = handler;
  if (timer) clearInterval(timer);
  setTimeout(() => tick().catch(() => {}), 15000).unref();
  timer = setInterval(() => tick().catch(() => {}), 30000);
  timer.unref();
  const c = getConfig();
  logger.info(`scanner started (age ${fmtDuration(c.minAgeSec)}–${fmtDuration(c.maxAgeSec)}, liq ≥ $${fmtNum(c.minLiquidityUsd)}, every ${c.scanIntervalMin}m)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const interval = (Number(getConfig().scanIntervalMin) || 10) * 60 * 1000;
  return {
    lastScanAt,
    seenCount: seen.size,
    scanning: running,
    lastResult,
    nextInSec: lastScanAt ? Math.max(0, Math.round((interval - (Date.now() - lastScanAt)) / 1000)) : 0,
  };
}

module.exports = { start, stop, status, fetchSolPriceUsd, pickOne, rescanNow, evaluate };
