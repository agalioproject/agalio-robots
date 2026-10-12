require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const live = require('../src/live/liveConfig');

test('typed custom values apply, mark the plan Custom, and carry notes when something would cap them', () => {
  live.applyPreset('medium');
  const r = live.setValue('sizeUsd', '50');
  assert.equal(r.ok, true);
  assert.equal(live.getConfig().sizeUsd, 50);
  assert.equal(live.getConfig().riskProfile, 'custom');
  assert.ok(r.notes.some((n) => /Max SOL per trade/.test(n)), 'tells you the SOL cap will limit the $ size');
});

test('rejected values change nothing', () => {
  const before = live.getConfig();
  assert.equal(live.setValue('stopLossPct', '500').ok, false);
  assert.equal(live.setValue('minAgeSec', '30d').ok, false);
  assert.deepStrictEqual(live.getConfig(), before);
});

test('min age cannot exceed max age', () => {
  live.setValue('minAgeSec', '2s');
  assert.equal(live.setValue('maxAgeSec', '1d').ok, true);
  const r = live.setValue('minAgeSec', '3d');
  assert.equal(r.ok, false);
  assert.match(r.error, /lower than/);
  live.setValue('maxAgeSec', '20d');
});

test('nudge buttons stop at the edge instead of breaking', () => {
  live.setValue('stopLossPct', 85);
  assert.equal(live.nudge('stopLossPct', 10).value, 90);
  assert.equal(live.nudge('maxTradesDay', 1000).value, 100);
});

test('toggle switches a safety option', () => {
  const was = live.getConfig().requireNoAuthorities;
  assert.equal(live.toggle('requireNoAuthorities').value, !was);
});

test('settings survive a restart, and unknown leftovers from old versions are dropped', async () => {
  const store = require('../src/storage/positionsStore');
  live.applyLocal({ paused: false });
  live.setValue('minAgeSec', '2s');
  live.setValue('takeProfitPct', 77);
  await store.set('state', 'liveConfig', { ...live.getConfig(), capitalPct: 9, junk: 1 });
  await live.start();
  const c = live.getConfig();
  assert.equal(c.takeProfitPct, 77);
  assert.equal(c.minAgeSec, 2);
  assert.equal('capitalPct' in c, false);
  assert.equal('junk' in c, false);
});
