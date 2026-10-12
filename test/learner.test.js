require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const learner = require('../src/learning/learner');

const cfg = { learningMode: 'suggest', learningMinTrades: 20, maxRiskScore: 100, minRecommendTier: 'LOW_MEDIUM', takeProfitPct: 0, maxHoldMin: 0 };
let live = { ...cfg };
const trade = (score, pnl, over = {}) => ({ chain: 'solana', tier: score <= 25 ? 'LOW' : 'MEDIUM', score, pnlPct: pnl, reason: pnl > 0 ? 'take_profit' : 'stop_loss', heldMs: 60000, peakPnlPct: Math.max(pnl, 0) + 5, peakAtMs: 120000, ...over });

test('init + collects, no suggestions before enough trades', async () => {
  await learner.init({ applyConfig: async (p) => { live = { ...live, ...p }; }, notify: () => {}, config: () => live });
  for (let i = 0; i < 5; i++) await learner.record(trade(10, 20));
  const s = learner.suggest(live);
  assert.equal(s.ready, false);
  assert.equal(s.suggestions.length, 0);
});

test('suggests a score ceiling where losses start, and a take profit near typical peaks', async () => {
  for (let i = 0; i < 10; i++) await learner.record(trade(10, 25));
  for (let i = 0; i < 8; i++) await learner.record(trade(35, -30));
  const s = learner.suggest(live);
  assert.equal(s.ready, true);
  const score = s.suggestions.find((x) => x.key === 'maxRiskScore');
  assert.ok(score, 'score suggestion present');
  assert.ok(score.suggested <= 25, `ceiling should stop before the losing bucket, got ${score.suggested}`);
  assert.ok(s.suggestions.find((x) => x.key === 'takeProfitPct'));
});

test('apply writes through the applier; never touches size or safety keys', async () => {
  const r = await learner.applySuggestions();
  assert.ok(r.applied.length > 0);
  const allowed = new Set(['maxRiskScore', 'minRecommendTier', 'takeProfitPct', 'maxHoldMin']);
  for (const a of r.applied) assert.ok(allowed.has(a.key), a.key);
  assert.ok(live.maxRiskScore <= 25);
});

test('off mode records nothing', async () => {
  const before = learner.count();
  live = { ...live, learningMode: 'off' };
  await learner.record(trade(10, 10));
  assert.equal(learner.count(), before);
});

test('persists to disk and reset clears it', () => {
  assert.ok(fs.existsSync(process.env.LEARNING_FILE));
  learner.reset();
  assert.equal(learner.count(), 0);
});
