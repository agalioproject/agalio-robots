require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const live = require('../src/live/liveConfig');
const swap = require('../src/trading/swap');

test('sell slippage and priority fee follow your Telegram settings, and rise on retries up to your max', () => {
  live.setValue('sellSlippagePct', 20);
  live.setValue('sellSlippageMaxPct', 35);
  live.setValue('sellPriorityFeeSol', 0.001);
  const a1 = swap.sellParams(1);
  assert.equal(a1.slippage, 20);
  assert.equal(a1.priorityFee, 0.001);
  assert.equal(swap.sellParams(2).priorityFee, 0.002);
  assert.equal(swap.sellParams(10).slippage, 35); // capped at YOUR max
});
