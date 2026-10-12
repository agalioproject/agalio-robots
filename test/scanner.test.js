const { mkt } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../src/scanner/scanner');
const { DEFAULTS } = require('../src/live/liveConfig');

const cfg = (over = {}) => ({ ...DEFAULTS, ...over });
const D = 86400;

test('a healthy coin passes the default (Medium) filters', () => {
  assert.equal(evaluate(mkt(), cfg()).ok, true);
});

test('age window: min and max are both enforced', () => {
  const c = cfg({ minAgeSec: 2, maxAgeSec: 20 * D });
  assert.equal(evaluate(mkt({ ageSec: 1 }), c).ok, false);
  assert.equal(evaluate(mkt({ ageSec: 3 }), c).ok, true);
  assert.equal(evaluate(mkt({ ageSec: 19 * D }), c).ok, true);
  assert.equal(evaluate(mkt({ ageSec: 21 * D }), c).ok, false);
  assert.equal(evaluate(mkt({ ageSec: null }), c).reason, 'age unknown');
  // custom narrower window
  const narrow = cfg({ minAgeSec: 3600, maxAgeSec: 2 * 3600 });
  assert.equal(evaluate(mkt({ ageSec: 1800 }), narrow).ok, false);
  assert.equal(evaluate(mkt({ ageSec: 5400 }), narrow).ok, true);
  assert.equal(evaluate(mkt({ ageSec: 3 * 3600 }), narrow).ok, false);
});

test('CUSTOM filter values are actually used (they used to fall back to Medium)', () => {
  const custom = { riskProfile: 'custom' };
  assert.equal(evaluate(mkt({ liquidityUsd: 5000 }), cfg({ ...custom, minLiquidityUsd: 3000 })).ok, true);
  assert.equal(evaluate(mkt({ liquidityUsd: 5000 }), cfg({ ...custom, minLiquidityUsd: 6000 })).ok, false);
  assert.equal(evaluate(mkt({ volume1h: 500, volume6h: 800 }), cfg({ ...custom, minVolume1hUsd: 0 })).ok, true);
  assert.equal(evaluate(mkt({ volume1h: 500, volume6h: 800 }), cfg({ ...custom, minVolume1hUsd: 4000 })).ok, false);
  assert.equal(evaluate(mkt({ buys1h: 8, sells1h: 4 }), cfg({ ...custom, minBuys1h: 5 })).ok, true);
  assert.equal(evaluate(mkt({ buys1h: 8, sells1h: 8 }), cfg({ ...custom, minBuys1h: 5, minBuyPressure: 1.5 })).ok, false);
  assert.equal(evaluate(mkt({ priceChange5m: -15 }), cfg({ ...custom, maxDrop5mPct: 20 })).ok, true);
  assert.equal(evaluate(mkt({ priceChange5m: -15 }), cfg({ ...custom, maxDrop5mPct: 10 })).ok, false);
  assert.equal(evaluate(mkt({ priceChange24h: -50 }), cfg({ ...custom, maxDrop24hPct: 60 })).ok, true);
  assert.equal(evaluate(mkt({ priceChange24h: -50 }), cfg({ ...custom, maxDrop24hPct: 40 })).ok, false);
});

test('"rising" rule is configurable and can be switched off', () => {
  const falling = mkt({ priceChange1h: -3, priceChange6h: -1 });
  assert.equal(evaluate(falling, cfg()).reason, 'not rising');
  assert.equal(evaluate(falling, cfg({ minChange1hPct: -100, minChange6hPct: -100 })).ok, true);
  assert.equal(evaluate(mkt({ priceChange1h: 1, priceChange6h: 0 }), cfg({ minChange1hPct: 5 })).ok, false);
});

test('rejection reasons are specific, so you can see what to loosen', () => {
  assert.match(evaluate(mkt({ liquidityUsd: 100 }), cfg()).reason, /liquidity/);
  assert.match(evaluate(mkt({ buys1h: 0, sells1h: 3 }), cfg()).reason, /buys/);
});
