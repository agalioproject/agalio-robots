const { mkt } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const live = require('../src/live/liveConfig');

// DexScreener stub: whatever market `current` holds is what the bot "sees".
let current = mkt();
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/tokens/So1111')) return { ok: true, json: async () => ({ pairs: [{ quoteToken: { symbol: 'USDC' }, priceUsd: '200' }] }) };
  if (u.includes('/latest/dex/tokens/')) {
    const m = current;
    return {
      ok: true,
      json: async () => ({
        pairs: [{
          chainId: 'solana', baseToken: { address: u.split('/').pop() }, quoteToken: { address: 'So11111111111111111111111111111111111111112' },
          priceNative: String(m.priceNative), priceUsd: '0.002', liquidity: { usd: m.liquidityUsd }, marketCap: m.marketCapUsd,
          volume: { h1: m.volume1h, h6: m.volume6h, h24: m.volume6h * 3 },
          priceChange: { m5: m.priceChange5m, h1: m.priceChange1h, h6: m.priceChange6h, h24: m.priceChange24h },
          txns: { h1: { buys: m.buys1h, sells: m.sells1h } }, pairCreatedAt: m.ageSec == null ? 0 : Date.now() - m.ageSec * 1000,
        }],
      }),
    };
  }
  throw new Error('unexpected fetch ' + u);
};

const positions = require('../src/trading/positions');

test.before(async () => {
  await live.start();
  await positions.init();
  live.applyLocal({ paused: false });
  live.setValue('requireNoAuthorities', false); // no RPC in tests
});

test('custom $ size is honoured when the SOL cap allows it, and the cap is REPORTED when it does not', async () => {
  live.setValue('sizeUsd', 20);
  live.setValue('maxPositionSol', 0); // no cap
  let s = await positions.sizeSol();
  assert.ok(Math.abs(s.sol - 20 / 200) < 1e-6, `expected 0.1 SOL, got ${s.sol}`);
  assert.equal(s.limitedBy, null);
  live.setValue('maxPositionSol', 0.05);
  s = await positions.sizeSol();
  assert.equal(s.sol, 0.05);
  assert.match(s.limitedBy, /Max SOL per trade/);
});

test('entry re-checks the filters: a coin that no longer qualifies is not bought', async () => {
  live.setValue('maxPositionSol', 0.1);
  live.setValue('minLiquidityUsd', 10000);
  current = mkt({ liquidityUsd: 4000 });
  const r = await positions.tryEnter('MintLowLiq111111111111111111111111111111111', 'test');
  assert.equal(r.ok, false);
  assert.match(r.why, /no longer passes your filters: liquidity/);
});

test('entry enforces the age window you typed', async () => {
  live.setValue('minLiquidityUsd', 3000);
  live.setValue('minAgeSec', '10d');
  current = mkt({ ageSec: 3 * 86400 });
  let r = await positions.tryEnter('MintYoung1111111111111111111111111111111111', 'test');
  assert.equal(r.ok, false);
  assert.match(r.why, /younger than 10d/);
  live.setValue('minAgeSec', '2s');
  current = mkt({ ageSec: 3 * 86400 });
  r = await positions.tryEnter('MintYoung1111111111111111111111111111111111', 'test');
  assert.equal(r.ok, true, r.why);
  assert.ok(r.pos.sizeSol > 0);
});

test('max open positions comes from your setting', async () => {
  live.setValue('maxOpen', 1);
  current = mkt();
  const r = await positions.tryEnter('MintSecond11111111111111111111111111111111111', 'test');
  assert.equal(r.ok, false);
  assert.match(r.why, /max concurrent/);
  live.setValue('maxOpen', 2);
  const r2 = await positions.tryEnter('MintSecond11111111111111111111111111111111111', 'test');
  assert.equal(r2.ok, true, r2.why);
});

test('max trades per day comes from your setting', async () => {
  const { daily } = positions.stats();
  live.setValue('maxOpen', 10);
  live.setValue('maxTradesDay', Math.max(1, daily.tradesToday));
  const r = await positions.tryEnter('MintThird111111111111111111111111111111111111', 'test');
  assert.equal(r.ok, false);
  assert.match(r.why, /max trades\/day/);
});

test.after(async () => {
  positions.exitAll('test');
  await positions.shutdown();
});
