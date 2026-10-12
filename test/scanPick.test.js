const { mkt } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const live = require('../src/live/liveConfig');

const markets = {
  OldCoin: mkt({ ageSec: 30 * 86400 }),
  GoodCoin: mkt({ ageSec: 15 * 86400 }),
  NewCoin: mkt({ ageSec: 3 }),
  ThinCoin: mkt({ ageSec: 12 * 86400, liquidityUsd: 900 }),
};
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('token-boosts')) return { ok: true, json: async () => Object.keys(markets).map((k) => ({ chainId: 'solana', tokenAddress: k })) };
  if (u.includes('token-profiles') || u.includes('dex/search')) return { ok: true, json: async () => (u.includes('search') ? { pairs: [] } : []) };
  const mint = u.split('/').pop();
  const m = markets[mint];
  return {
    ok: true,
    json: async () => ({
      pairs: [{
        chainId: 'solana', baseToken: { address: mint }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, priceNative: '0.00001',
        priceUsd: '0.002', liquidity: { usd: m.liquidityUsd }, marketCap: 1e6, volume: { h1: m.volume1h, h6: m.volume6h, h24: 1e5 },
        priceChange: { m5: m.priceChange5m, h1: m.priceChange1h, h6: m.priceChange6h, h24: m.priceChange24h },
        txns: { h1: { buys: m.buys1h, sells: m.sells1h } }, pairCreatedAt: Date.now() - m.ageSec * 1000,
      }],
    }),
  };
};
const scanner = require('../src/scanner/scanner');

test('scanner picks only coins inside YOUR age window and records why the others were rejected', async () => {
  await live.start();
  live.setValue('minAgeSec', '10d');
  live.setValue('maxAgeSec', '20d');
  const pick = await scanner.pickOne();
  assert.equal(pick.mint, 'GoodCoin');
  const r = scanner.status().lastResult;
  assert.equal(r.picked, 'GoodCoin');
  assert.equal(r.rejects['older than 20d'], 1);
  assert.equal(r.rejects['younger than 10d'], 1); // NewCoin
  assert.equal(r.rejects['liquidity < $15000'], 1); // ThinCoin
});

test('typing a 2-second minimum makes brand-new coins eligible straight away', async () => {
  live.setValue('minAgeSec', '2s');
  const pick = await scanner.pickOne(); // GoodCoin was already picked, so it is skipped for a while
  assert.equal(pick.mint, 'NewCoin');
});
