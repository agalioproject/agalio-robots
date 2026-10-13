require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Fake Telegram so the REAL bot module runs end to end.
const handlers = { text: [], on: {} };
const sent = [];
class FakeBot {
  setMyCommands() { return Promise.resolve(); }
  onText(re, cb) { handlers.text.push([re, cb]); }
  on(ev, cb) { handlers.on[ev] = cb; }
  sendMessage(c, t, o) { sent.push({ t, o }); return Promise.resolve({ message_id: 100 + sent.length }); }
  editMessageText(t, o) { sent.push({ t, o }); return Promise.resolve(); }
  answerCallbackQuery() { return Promise.resolve(); }
  deleteMessage() { return Promise.resolve(); }
}
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'node-telegram-bot-api' ? FakeBot : orig.call(this, r, ...a); };

const live = require('../src/live/liveConfig');
const S = require('../src/live/settings');
const bot = require('../src/telegram/bot');
const scanner = require('../src/scanner/scanner');

const cb = (data) => handlers.on.callback_query({ id: '1', data, message: { chat: { id: 42 }, message_id: 7 } });
const say = (text) => handlers.on.message({ chat: { id: 42 }, message_id: 9, text });
const last = () => sent[sent.length - 1];
const command = async (text) => {
  for (const [re, fn] of handlers.text) { const m = text.match(re); if (m) return fn({ chat: { id: 42 }, text }, m); }
};

scanner.rescanNow = () => {}; // never hit the network from tests
test.before(async () => { await live.start(); bot.start(); });

test('open a setting and just TYPE — no extra tap — including time units', async () => {
  await cb('g:filters');
  await cb('v:minAgeSec');
  await say('2s');
  assert.equal(live.getConfig().minAgeSec, 2);
  await say('15m');
  assert.equal(live.getConfig().minAgeSec, 900); // still armed: type again to change again
  await cb('v:maxAgeSec');
  await say('20d');
  assert.equal(live.getConfig().maxAgeSec, 20 * 86400);
});

test('invalid typed values are rejected with the range and change nothing', async () => {
  await cb('v:maxAgeSec');
  await say('25d');
  assert.equal(live.getConfig().maxAgeSec, 20 * 86400);
  assert.match(last().t, /Must be between 2s – 20d/);
  await cb('v:stopLossPct');
  await say('200');
  assert.notEqual(live.getConfig().stopLossPct, 200);
  assert.match(last().t, /Must be between 5% – 90%/);
});

test('typing stops when you leave the setting screen', async () => {
  await cb('v:takeProfitPct');
  await cb('nav:main');
  const tp = live.getConfig().takeProfitPct;
  await say('999');
  assert.equal(live.getConfig().takeProfitPct, tp);
});

test('/set works for every setting and alias', async () => {
  await command('/set tp 55');
  assert.equal(live.getConfig().takeProfitPct, 55);
  await command('/set minage 2s');
  assert.equal(live.getConfig().minAgeSec, 2);
  await command('/set maxage 12h');
  assert.equal(live.getConfig().maxAgeSec, 43200);
  await command('/set maxage 20d');
  await command('/set liq 12000');
  assert.equal(live.getConfig().minLiquidityUsd, 12000);
  await command('/set nonsense 5');
  assert.match(last().t, /Unknown setting/);
  await command('/set');
  assert.match(last().t, /minage/);
});

test('✅ Apply & run starts the bot with the new plan and scans immediately', async () => {
  live.applyLocal({ paused: true });
  let rescans = 0;
  const orig = scanner.rescanNow;
  scanner.rescanNow = () => { rescans += 1; };
  await cb('apply');
  scanner.rescanNow = orig;
  assert.equal(live.getConfig().paused, false);
  assert.equal(rescans, 1);
  const plan = sent.map((x) => x.t).find((t) => /running exactly this plan/.test(t));
  assert.ok(plan, 'bot showed the plan it is now running');
  assert.match(plan, new RegExp(`${S.fmtDuration(live.getConfig().minAgeSec)} to ${S.fmtDuration(live.getConfig().maxAgeSec)} old`));
});

test('every setting is reachable from a menu button and every callback fits 64 bytes', async () => {
  const I = bot._internals;
  const buttons = [];
  const collect = (kb) => kb.inline_keyboard.flat().forEach((b) => buttons.push(b.callback_data));
  collect(I.mainKeyboard()); collect(I.settingsKeyboard()); collect(I.activityKeyboard());
  for (const g of Object.keys(S.GROUPS)) collect(I.groupKeyboard(g));
  collect(I.learningView().keyboard);
  for (const key of Object.keys(S.SETTINGS)) {
    assert.ok(buttons.includes(`v:${key}`) || buttons.includes(`t:${key}`), `${key} has no menu button`);
    collect(I.pickerKeyboard(key)); // booleans get a toggle button instead of presets
  }
  for (const d of buttons) assert.ok(Buffer.byteLength(d) <= 64, d);
});

test('no dead buttons: every callback the menus emit is handled', async () => {
  const I = bot._internals;
  const emitted = new Set();
  const collect = (kb) => kb.inline_keyboard.flat().forEach((b) => emitted.add(b.callback_data));
  collect(I.mainKeyboard()); collect(I.settingsKeyboard()); collect(I.activityKeyboard()); collect(I.learningView().keyboard);
  for (const g of Object.keys(S.GROUPS)) collect(I.groupKeyboard(g));
  for (const d of emitted) {
    sent.length = 0;
    if (d === 'sellall' || d === 'act:bal') continue; // side effects / wallet
    await cb(d);
    assert.ok(sent.length > 0 || /^(pause|apply)$/.test(d), `callback ${d} produced no screen`);
  }
});

test('learning screen renders in all three modes', async () => {
  for (const m of ['off', 'suggest', 'auto']) {
    await cb(`l:mode:${m}`);
    assert.equal(live.getConfig().learningMode, m);
    assert.match(last().t, /LEARNING MODE/);
  }
});

test('every command the README lists exists', async () => {
  for (const c of ['/pause', '/resume', '/report', '/pnl', '/review', '/learning', '/learn', '/advice', '/balance', '/risk', '/custom', '/plan', '/apply', '/menu', '/help', '/set']) {
    assert.ok(handlers.text.some(([re]) => re.test(c)), `${c} is not handled`);
  }
  await command('/risk easy');
  assert.equal(live.getConfig().riskProfile, 'easy');
  await command('/pause');
  assert.equal(live.getConfig().paused, true);
  await command('/resume');
  assert.equal(live.getConfig().paused, false);
});

test('🧹 Fresh start wipes settings, history, counters and learned data — and refuses while a position is open', async () => {
  const positions = require('../src/trading/positions');
  const memory = require('../src/learning/memory');
  live.setValue('takeProfitPct', 123);
  live.setValue('minAgeSec', '2s');
  await memory.logTrade({ mint: 'M1', exitReason: 'take_profit', pct: 10, realizedSol: 0.001 });
  assert.ok(memory.getJournal().length > 0);

  // 1) blocked while something is open
  const realList = positions.listOpen;
  positions.listOpen = () => [{ mint: 'X' }];
  let r = await bot._internals.freshStart();
  assert.equal(r.ok, false);
  assert.equal(live.getConfig().takeProfitPct, 123, 'nothing was wiped');
  assert.match(bot._internals.resetConfirm().text, /still open/);
  positions.listOpen = realList;

  // 2) confirm screen is reachable, then the wipe works
  await command('/reset');
  assert.match(last().t, /permanently deletes/);
  await cb('rs:go');
  const c = live.getConfig();
  assert.equal(c.takeProfitPct, 60);
  assert.equal(c.riskProfile, 'medium');
  assert.equal(c.minAgeSec, 10 * 86400);
  assert.equal(memory.getJournal().length, 0);
  assert.equal(positions.stats().history.length, 0);
  assert.equal(positions.stats().daily.tradesToday, 0);
  assert.equal(c.paused, false, 'paper mode keeps running');
  assert.ok(sent.some((x) => /Fresh start done/.test(x.t)));
});
