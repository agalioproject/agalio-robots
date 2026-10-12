require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { gateAssessment } = require('../src/analysis/riskEngine');
const { getConfig } = require('../src/live/liveConfig');

const base = () => ({ ...getConfig(), maxTokensPerDay: 1000 });
const tok = (over = {}) => ({
  chain: 'solana', address: 'x', verdict: 'LOW', score: 10, tradeable: true, recommended: false,
  reasons: [], devPercent: 3, top10Percent: 30, exit: {}, ...over,
});

test('LOW only rejects MEDIUM and HIGH', () => {
  const cfg = { ...base(), minRecommendTier: 'LOW' };
  assert.equal(gateAssessment(tok({ verdict: 'LOW' }), cfg).recommended, true);
  assert.equal(gateAssessment(tok({ verdict: 'MEDIUM', score: 40 }), cfg).blockedBy, 'tier');
  assert.equal(gateAssessment(tok({ verdict: 'HIGH', score: 60 }), cfg).blockedBy, 'tier');
});

test('LOW + MEDIUM allows MEDIUM but not HIGH', () => {
  const cfg = { ...base(), minRecommendTier: 'LOW_MEDIUM' };
  assert.equal(gateAssessment(tok({ verdict: 'MEDIUM', score: 40 }), cfg).recommended, true);
  assert.equal(gateAssessment(tok({ verdict: 'HIGH', score: 60 }), cfg).blockedBy, 'tier');
});

test('ANY allows every tier', () => {
  const cfg = { ...base(), minRecommendTier: 'ANY' };
  assert.equal(gateAssessment(tok({ verdict: 'HIGH', score: 60 }), cfg).recommended, true);
  assert.equal(gateAssessment(tok({ verdict: 'CRITICAL', score: 90 }), cfg).recommended, true);
});

test('entry-quality score ceiling is enforced', () => {
  const cfg = { ...base(), maxRiskScore: 20 };
  assert.equal(gateAssessment(tok({ score: 21, verdict: 'MEDIUM' }), cfg).blockedBy, 'score');
  assert.equal(gateAssessment(tok({ score: 20 }), cfg).recommended, true);
});

test('LOW tokens use main dev/top10 limits, MEDIUM uses its own', () => {
  const cfg = { ...base(), maxDevPercent: 10, maxTop10Percent: 40, mediumMaxDevPercent: 50, mediumMaxTop10Percent: 90, minRecommendTier: 'LOW_MEDIUM' };
  assert.equal(gateAssessment(tok({ devPercent: 12 }), cfg).blockedBy, 'holders');
  assert.equal(gateAssessment(tok({ verdict: 'MEDIUM', score: 40, devPercent: 12, top10Percent: 70 }), cfg).recommended, true);
  assert.equal(gateAssessment(tok({ verdict: 'MEDIUM', score: 40, devPercent: 60 }), cfg).blockedBy, 'holders');
});

test('MEDIUM score ceiling only applies to MEDIUM', () => {
  const cfg = { ...base(), mediumMaxScore: 30, minRecommendTier: 'LOW_MEDIUM' };
  assert.equal(gateAssessment(tok({ verdict: 'MEDIUM', score: 35 }), cfg).blockedBy, 'score');
  assert.equal(gateAssessment(tok({ verdict: 'LOW', score: 25 }), cfg).recommended, true);
});

test('pre-migration (bonding curve) tokens can no longer bypass the settings', () => {
  const cfg = { ...base(), minRecommendTier: 'LOW', maxRiskScore: 20 };
  const pending = (over) => tok({ tradeable: false, pendingGraduation: true, ...over });
  const bad = gateAssessment(pending({ verdict: 'MEDIUM', score: 40 }), cfg);
  assert.equal(bad.gatePassed, undefined);
  assert.equal(bad.pendingGraduation, false);
  const good = gateAssessment(pending({ verdict: 'LOW', score: 10 }), cfg);
  assert.equal(good.gatePassed, true);
  assert.equal(good.pendingGraduation, true);
});

test('paused: passes but does not burn a daily slot', () => {
  const a = gateAssessment(tok(), base(), { consumeSlot: false });
  assert.equal(a.blockedBy, 'paused');
  assert.equal(a.recommended, false);
});

// ---- token age filter ----
const tokenAge = require('../src/analysis/tokenAge');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('age: brand-new coin must wait out the minimum age', async () => {
  tokenAge.markSeen('AgeTestFresh');
  const r = await tokenAge.checkAge('AgeTestFresh', { minAgeSec: 2, maxAgeDays: 20 }, { allowLookup: false });
  assert.equal(r.ok, true);
  assert.ok(r.waitMs > 1000 && r.waitMs <= 2000, `waitMs=${r.waitMs}`);
  await sleep(50);
  const none = await tokenAge.checkAge('AgeTestFresh', { minAgeSec: 0, maxAgeDays: 20 }, { allowLookup: false });
  assert.equal(none.waitMs, 0);
});

test('age: coin older than the max is rejected, unknown age is allowed', async () => {
  tokenAge.markSeen('AgeTestOld', Date.now() - 21 * 86_400_000);
  const old = await tokenAge.checkAge('AgeTestOld', { minAgeSec: 2, maxAgeDays: 20 }, { allowLookup: false });
  assert.equal(old.ok, false);
  assert.match(old.reason, /20-day/);
  const inside = await tokenAge.checkAge('AgeTestOld', { minAgeSec: 2, maxAgeDays: 30 }, { allowLookup: false });
  assert.equal(inside.ok, true);
  const unknown = await tokenAge.checkAge('NeverSeen', { minAgeSec: 2, maxAgeDays: 1 }, { allowLookup: false });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.ageMs, null);
});

test('age: skipMin (graduation re-check) never waits but still enforces the max', async () => {
  tokenAge.markSeen('AgeTestGrad');
  const r = await tokenAge.checkAge('AgeTestGrad', { minAgeSec: 30, maxAgeDays: 20 }, { skipMin: true, allowLookup: false });
  assert.equal(r.waitMs, 0);
});
