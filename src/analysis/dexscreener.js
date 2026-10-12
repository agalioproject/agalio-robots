const { SOL_MINT } = require('../config');

/**
 * Market snapshot from DexScreener (free, no key).
 * Includes the pair age (ageSec, null if DexScreener does not know it) for the age-window filter.
 * priceNative only used when pair is quoted in SOL.
 */
async function getTokenMarket(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  const pairs = (data.pairs || []).filter(
    (p) =>
      p.chainId === 'solana' &&
      p.baseToken &&
      p.baseToken.address === mint &&
      p.quoteToken &&
      p.quoteToken.address === SOL_MINT
  );
  if (!pairs.length) return null;
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceNative = Number(best.priceNative || 0) || 0;
  if (!(priceNative > 0)) return null;

  // Earliest pair of this token = when it was really launched (a later pool may be a migration).
  const created = pairs.map((x) => Number(x.pairCreatedAt || 0)).filter((n) => n > 0);
  const createdAt = created.length ? Math.min(...created) : 0;
  const ageSec = createdAt > 0 ? Math.max(0, (Date.now() - createdAt) / 1000) : null; // null = unknown
  const ageDays = ageSec == null ? 0 : ageSec / 86400;

  const txnsH1 = (best.txns && best.txns.h1) || {};
  const buys1h = Number(txnsH1.buys || 0) || 0;
  const sells1h = Number(txnsH1.sells || 0) || 0;

  return {
    marketCapUsd: Number(best.marketCap || best.fdv || 0) || 0,
    liquidityUsd: Number(best.liquidity?.usd || 0) || 0,
    priceUsd: Number(best.priceUsd || 0) || 0,
    priceNative,
    volume24h: Number(best.volume?.h24 || 0) || 0,
    volume1h: Number(best.volume?.h1 || 0) || 0,
    volume6h: Number(best.volume?.h6 || 0) || 0,
    priceChange5m: Number(best.priceChange?.m5 || 0) || 0,
    priceChange1h: Number(best.priceChange?.h1 || 0) || 0,
    priceChange6h: Number(best.priceChange?.h6 || 0) || 0,
    priceChange24h: Number(best.priceChange?.h24 || 0) || 0,
    pairCreatedAt: createdAt,
    ageSec,
    ageDays,
    buys1h,
    sells1h,
    pairUrl: best.url || null,
    dexId: best.dexId || null,
  };
}

module.exports = { getTokenMarket };
