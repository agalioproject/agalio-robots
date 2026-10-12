require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const live = require('../src/live/liveConfig');
const memory = require('../src/learning/memory');
const tuner = require('../src/learning/tuner');

const trade = (liq, pct, over = {}) => ({
  profile: 'custom', mint: 'M' + Math.random(), exitReason: pct > 0 ? 'take_profit' : 'stop_loss', realizedSol: pct / 1000, pct,
  holdSec: 120, ageSec: 12 * 86400, liquidityUsd: liq, volume1h: 5000, buys1h: 20, priceChange1h: 4, score: 50, sizeUsd: 5,
  takeProfitPct: 60, stopLossPct: 30, maxHoldMin: 5, meta: { peakPnlPct: pct > 0 ? 40 : 6, peakAtSec: 150, buyPressure: 1.3 }, ...over,
});

test.before(async () => {
  await live.start();
  await memory.init();
  memory.resetJournal();
  live.applyLocal({ learningMode: 'suggest', paused: false });
  live.setValue('learningMinTrades', 20);
});

test('nothing is suggested before enough closed trades', async () => {
  for (let i = 0; i < 6; i++) await memory.logTrade(trade(20000, 20));
  const s = tuner.suggest();
  assert.equal(s.ready, false);
  assert.equal(s.suggestions.length, 0);
});

test('learns that low-liquidity coins lose and suggests raising the liquidity floor', async () => {
  for (let i = 0; i < 10; i++) await memory.logTrade(trade(9000 + i * 100, -25));
  for (let i = 0; i < 10; i++) await memory.logTrade(trade(40000 + i * 1000, 30));
  live.setValue('minLiquidityUsd', 3000);
  const s = tuner.suggest();
  assert.equal(s.ready, true);
  const liq = s.suggestions.find((x) => x.key === 'minLiquidityUsd');
  assert.ok(liq, 'liquidity suggestion present');
  assert.ok(liq.suggested > 3000 && liq.suggested <= 40000, `got ${liq.suggested}`);
  assert.ok(s.suggestions.find((x) => x.key === 'takeProfitPct'), 'take-profit suggestion from peaks');
});

test('only ever suggests TIGHTENING entry filters, and never touches protected settings', () => {
  const allowed = new Set(['takeProfitPct', 'maxHoldMin', 'minLiquidityUsd', 'minVolume1hUsd', 'minBuys1h', 'minBuyPressure', 'minAgeSec', 'maxAgeSec']);
  for (const x of tuner.suggest().suggestions) assert.ok(allowed.has(x.key), x.key);
});

test('Apply suggestions goes through the normal validator and changes the live settings', () => {
  const before = live.getConfig();
  const r = tuner.applySuggestions();
  assert.ok(r.applied.length > 0);
  const c = live.getConfig();
  assert.ok(c.minLiquidityUsd > before.minLiquidityUsd);
  // protected settings untouched
  for (const k of ['sizeUsd', 'maxPositionSol', 'maxOpen', 'maxDailyLossPct', 'stopLossPct', 'buySlippagePct', 'requireNoAuthorities', 'scanIntervalMin', 'maxTradesDay']) {
    assert.strictEqual(c[k], before[k], `${k} must not change`);
  }
});

test('auto mode adapts in small bounded steps, tells you, and then waits for 10 more trades', async () => {
  tuner.applySuggestions(); // sync the baseline
  tuner._reset();
  const messages = [];
  tuner.setNotifier((t) => messages.push(t));
  live.applyLocal({ learningMode: 'auto' });
  live.setValue('minLiquidityUsd', 3000);
  live.setValue('takeProfitPct', 60);
  await memory.logTrade(trade(12000, -20)); // first trade after enabling: enough history exists, so it adapts
  assert.equal(messages.length, 1, 'user was told what changed');
  assert.match(messages[0], /Learning updated your settings/);
  const tp = live.getConfig().takeProfitPct;
  assert.ok(tp >= 42 && tp <= 78, `TP moved at most 30% in one cycle, got ${tp}`);
  for (let i = 0; i < 9; i++) await memory.logTrade(trade(12000, -20));
  assert.equal(messages.length, 1, 'no further changes until 10 NEW trades have closed');
  assert.equal(live.getConfig().takeProfitPct, tp);
});

test('off mode records and changes nothing', async () => {
  live.applyLocal({ learningMode: 'off' });
  const tp = live.getConfig().takeProfitPct;
  const msgs = [];
  tuner.setNotifier((t) => msgs.push(t));
  for (let i = 0; i < 12; i++) await memory.logTrade(trade(12000, -20));
  assert.equal(msgs.length, 0);
  assert.equal(live.getConfig().takeProfitPct, tp);
});

test('bestSplit needs a clear gap on both sides before trusting it', () => {
  const noisy = Array.from({ length: 30 }, (_, i) => ({ pct: i % 2 ? 5 : -5, liq: 1000 + i * 100 }));
  assert.equal(tuner.bestSplit(noisy, 'liq', 'floor'), null);
});
