require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { _views: v, _settings: SETTINGS } = require('../src/telegram/bot');
const { getConfig } = require('../src/live/liveConfig');
const debull = require('../src/knowledge/debull');

const cfg = getConfig();
const allButtons = (view) => view.reply_markup.inline_keyboard.flat();
const callbacks = (view) => allButtons(view).map((b) => b.callback_data).filter(Boolean);

test('every view renders and every callback_data fits Telegram’s 64-byte limit', () => {
  for (const [name, fn] of Object.entries(v)) {
    if (name === 'pickerView') continue;
    const view = fn(cfg);
    assert.ok(view.text.length > 0, name);
    for (const cb of callbacks(view)) assert.ok(Buffer.byteLength(cb) <= 64, `${name}: ${cb}`);
  }
  for (const key of Object.keys(SETTINGS)) {
    const view = v.pickerView(key, cfg);
    assert.ok(view.text.includes('type a value'), `${key} tells the user they can type`);
    for (const cb of callbacks(view)) assert.ok(Buffer.byteLength(cb) <= 64, `${key}: ${cb}`);
  }
});

test('main menu has no dead links to removed screens', () => {
  const cbs = callbacks(v.mainView(cfg));
  assert.ok(!cbs.includes('m:risk') && !cbs.includes('m:safety'));
  assert.ok(cbs.includes('m:learn') && cbs.includes('plan') && cbs.includes('m:filters'));
});

test('every picker value button targets a real setting', () => {
  const keys = new Set(Object.keys(SETTINGS));
  for (const view of [v.filtersView(cfg), v.exitView(cfg), v.capitalView(cfg), v.mediumFiltersView(cfg), v.taxFiltersView(cfg), v.learningView(cfg), v.scannerView(cfg)]) {
    for (const cb of callbacks(view)) if (cb.startsWith('v:')) assert.ok(keys.has(cb.slice(2)), cb);
  }
});

test('exit screen shows the REAL auto plan, not stale numbers', () => {
  const text = v.exitView(cfg).text;
  const low = debull.exitPlanFor('LOW');
  assert.ok(text.includes(`LOW +${low.takeProfitPct}%`), text);
  assert.ok(!text.includes('LOW +20%'));
});

test('plan view reflects typed settings', () => {
  const t = v.planView({ ...cfg, takeProfitPct: 42, stopLossPct: 12, capitalPct: 7.5 }).text;
  assert.ok(t.includes('+42% (yours)') && t.includes('−12% (yours)') && t.includes('7.5%'));
});

test('every .env-style execution knob is editable and actually read at trade time', () => {
  const fs = require('fs');
  const read = (f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  const keys = ['maxPositions', 'bscMaxPositions', 'slippagePct', 'exitSlippagePct', 'bscSlippagePct', 'priorityFeeLamports', 'entryCooldownSec'];
  const cbs = callbacks(v.execView(cfg));
  for (const k of keys) {
    assert.ok(SETTINGS[k], `${k} has a menu definition`);
    assert.ok(cbs.includes(`v:${k}`), `${k} has a button on the Execution screen`);
  }
  // consumers read the live value, not a frozen env constant
  assert.match(read('src/trading/jupiter.js'), /getConfig\(\)/);
  assert.match(read('src/trading/pumpPortal.js'), /getConfig\(\)\.slippagePct/);
  assert.match(read('src/bsc/pancakeswap.js'), /getConfig\(\)\.bscSlippagePct/);
  assert.doesNotMatch(read('src/trading/positionManager.js'), /\bMAX_CONCURRENT_POSITIONS\b/);
  assert.doesNotMatch(read('src/bsc/positionManager.js'), /\bBSC_MAX_CONCURRENT_POSITIONS\b/);
});

test('every setting in the menu is a real live-config key (nothing orphaned)', () => {
  const { COLUMNS } = require('../src/live/liveConfig');
  for (const k of Object.keys(SETTINGS)) assert.ok(COLUMNS[k], `${k} missing from liveConfig`);
});
