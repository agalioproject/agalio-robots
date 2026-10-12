require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/live/settings');

test('age window: 2 seconds up to 20 days, with units', () => {
  assert.deepStrictEqual(S.parseInput('minAgeSec', '2s'), { ok: true, value: 2 });
  assert.deepStrictEqual(S.parseInput('minAgeSec', '2'), { ok: true, value: 2 }); // bare number = seconds
  assert.equal(S.parseInput('minAgeSec', '1s').ok, false);
  assert.deepStrictEqual(S.parseInput('maxAgeSec', '20d'), { ok: true, value: 1_728_000 });
  assert.deepStrictEqual(S.parseInput('maxAgeSec', '20'), { ok: true, value: 1_728_000 }); // bare number = days
  assert.equal(S.parseInput('maxAgeSec', '21d').ok, false);
  assert.deepStrictEqual(S.parseInput('maxAgeSec', '12h'), { ok: true, value: 43200 });
  assert.deepStrictEqual(S.parseInput('minAgeSec', '1.5m'), { ok: true, value: 90 });
  assert.equal(S.parseInput('minAgeSec', '5 weeks').ok, false);
});

test('out-of-range values are REJECTED with the range, never silently clamped', () => {
  const r = S.parseInput('stopLossPct', '95');
  assert.equal(r.ok, false);
  assert.match(r.error, /5% – 90%/);
  assert.equal(S.parseInput('maxTradesDay', '7.5').ok, false);
  assert.equal(S.parseInput('sizeUsd', 'abc').ok, false);
  assert.equal(S.parseInput('sizeUsd', '$7.50').value, 7.5);
  assert.equal(S.parseInput('minBuyPressure', '1,2').value, 1.2);
  assert.equal(S.parseInput('maxPositionSol', 'off').value, 0);
  assert.equal(S.parseInput('requireNoAuthorities', 'off').value, false);
});

test('every setting has presets/steps inside its own range', () => {
  for (const [key, d] of Object.entries(S.SETTINGS)) {
    if (d.kind === 'bool') continue;
    assert.ok(d.presets.length && d.steps.length, key);
    for (const p of d.presets) assert.ok(S.checkRange(key, p).ok, `${key} preset ${p} out of range`);
  }
});

test('every preset (Easy/Medium/Hard) only sets valid values and a valid age window', () => {
  for (const [name, p] of Object.entries(S.PRESETS)) {
    const { name: _n, ...vals } = p;
    for (const [k, v] of Object.entries(vals)) assert.ok(S.checkRange(k, v).ok, `${name}.${k}=${v}`);
    assert.equal(S.crossCheck(vals), null);
  }
});

test('min age must stay below max age', () => {
  assert.match(S.crossCheck({ minAgeSec: 100, maxAgeSec: 50, sellSlippagePct: 10, sellSlippageMaxPct: 20 }), /lower than/);
});
