/**
 * DexScreener public API — no API key required.
 * Used to enforce min market-cap before entry (default $10k).
 *
 * Docs: https://docs.dexscreener.com/api/reference
 * GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}
 */

const https = require('https');

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // address lower -> { at, data }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`DexScreener HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DexScreener timeout'));
    });
  });
}

/**
 * Best-effort market snapshot for a token mint/address.
 * Returns null if DexScreener has no pairs yet (typical for brand-new curve coins).
 *
 * @returns {Promise<{ marketCapUsd: number, liquidityUsd: number, priceUsd: number, volume24h: number, pairUrl: string|null, pairAddress: string|null }|null>}
 */
async function getTokenMarket(address) {
  const key = String(address || '').toLowerCase();
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let data = null;
  try {
    const json = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const pairs = Array.isArray(json.pairs) ? json.pairs : [];
    if (!pairs.length) {
      cache.set(key, { at: Date.now(), data: null });
      return null;
    }

    // Prefer the pair with highest liquidity (most reliable MC).
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const best = pairs[0];
    const created = pairs.map((p) => Number(p.pairCreatedAt)).filter((n) => n > 0);
    const marketCapUsd = Number(best.marketCap || best.fdv || 0) || 0;
    const liquidityUsd = Number(best.liquidity?.usd || 0) || 0;
    const priceUsd = Number(best.priceUsd || 0) || 0;
    const volume24h = Number(best.volume?.h24 || 0) || 0;

    data = {
      marketCapUsd,
      liquidityUsd,
      priceUsd,
      priceNative: Number(best.priceNative || 0) || 0, // price in SOL (or chain native) when available
      volume24h,
      pairUrl: best.url || null,
      pairAddress: best.pairAddress || null,
      pairCreatedAt: created.length ? Math.min(...created) : null, // earliest pair, ms epoch
      dexId: best.dexId || null,
      baseTokenSymbol: (best.baseToken && best.baseToken.symbol) || null,
      baseTokenName: (best.baseToken && best.baseToken.name) || null,
      priceChange5m: Number(best.priceChange?.m5 || 0) || 0,
      priceChange1h: Number(best.priceChange?.h1 || 0) || 0,
      priceChange24h: Number(best.priceChange?.h24 || 0) || 0,
    };
  } catch (err) {
    console.warn(`[dexscreener] lookup failed for ${address}: ${err.message}`);
    data = null;
  }

  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { getTokenMarket };
