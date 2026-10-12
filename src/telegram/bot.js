const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = require('../config');
const live = require('../live/liveConfig');
const S = require('../live/settings');
const positions = require('../trading/positions');
const scanner = require('../scanner/scanner');
const memory = require('../learning/memory');
const tuner = require('../learning/tuner');
const { getSolBalance, loadWallet } = require('../solana/wallet');

const { getConfig } = live;
const { SETTINGS, GROUPS, fmtValue, fmtNum, fmtDuration } = S;

let bot;
let statusMsgId = null;
let lastStatusKey = '';
const pending = new Map(); // chatId -> { key, messageId }  (typing a value is armed whenever a setting is open)

const allowed = (chatId) => !!TELEGRAM_CHAT_ID && String(chatId) === String(TELEGRAM_CHAT_ID);
const btn = (text, data) => ({ text, callback_data: data });
const shortLabel = (key) => SETTINGS[key].label.replace(/\s*\(.*?\)/, '');
const mintShort = (m) => `${m.slice(0, 6)}…${m.slice(-4)}`;
const signed = (n, d = 1) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}`;

function profileLabel(c) {
  return { easy: '🟢 Easy', medium: '🟡 Medium', hard: '🔴 Hard', custom: '⚙️ Custom' }[c.riskProfile] || '⚙️ Custom';
}

// ------------------------------------------------------------------ text builders
function filtersLine(c) {
  return `Age ${fmtDuration(c.minAgeSec)}–${fmtDuration(c.maxAgeSec)} · liq ≥ $${fmtNum(c.minLiquidityUsd)} · vol ≥ $${fmtNum(c.minVolume1hUsd)}/h · buys ≥ ${c.minBuys1h}/h`;
}

function liveStatusLine() {
  const c = getConfig();
  const open = positions.listOpen();
  const sc = scanner.status();
  if (c.paused) return { key: 'paused', text: '⏸  PAUSED\nOpen menu → Start to resume.' };
  if (open.length > 0) {
    const p = open[0];
    const pnl = p.lastPnl != null ? ` · PnL ${signed(p.lastPnl)}%` : '';
    const held = Math.round((Date.now() - p.openedAt) / 1000);
    return {
      key: `trade:${open.length}:${Math.floor(held / 10)}`,
      text: `🟢  IN TRADE${open.length > 1 ? ` (${open.length} open)` : ''}\n${mintShort(p.mint)}${pnl}\nheld ${held}s / max ${c.maxHoldMin * 60}s\nTP +${c.takeProfitPct}% · SL −${c.stopLossPct}% · $${c.sizeUsd}`,
    };
  }
  return {
    key: `scan:${c.riskProfile}:${sc.nextInSec}:${c.sizeUsd}:${c.scanIntervalMin}:${c.minAgeSec}:${c.maxAgeSec}`,
    text: `🔍  SCANNING\n${profileLabel(c).replace(/^\S+ /, '').toUpperCase()} · $${c.sizeUsd} · next ~${sc.nextInSec}s\nTP+${c.takeProfitPct}% SL−${c.stopLossPct}% hold ${c.maxHoldMin}m · max ${c.maxTradesDay}/d\n${filtersLine(c)}`,
  };
}

function statusText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily } = positions.stats();
  const sc = scanner.status();
  return [
    DRY_RUN ? '🧪 PAPER' : '🔴 LIVE',
    c.paused ? '⏸ PAUSED' : '🟢 RUNNING',
    `Plan: ${profileLabel(c)}`,
    '',
    `Size $${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}%`,
    `Hold ${c.maxHoldMin}m · Scan every ${c.scanIntervalMin}m`,
    filtersLine(c),
    `Today ${daily.tradesToday || 0}/${c.maxTradesDay} · open ${open.length}/${c.maxOpen} · next ~${sc.nextInSec}s`,
    `🧠 Learning: ${c.learningMode} (${memory.getJournal().length} trades recorded)`,
  ].join('\n');
}

/** Exactly what the bot will do from now on. */
function planText() {
  const c = getConfig();
  const open = positions.listOpen();
  const cap = Number(c.maxPositionSol) > 0 ? `max ${fmtNum(c.maxPositionSol)} SOL per trade` : 'no SOL cap';
  return [
    c.paused ? '⏸ Bot is PAUSED — tap ▶️ Start to begin.' : '🟢 Bot is RUNNING.',
    DRY_RUN ? '🧪 PAPER — no real money moves.' : '🔴 LIVE — real trades.',
    '',
    `FINDS a coin every ${c.scanIntervalMin} min that is:`,
    `• ${fmtDuration(c.minAgeSec)} to ${fmtDuration(c.maxAgeSec)} old`,
    `• liquidity ≥ $${fmtNum(c.minLiquidityUsd)} · volume ≥ $${fmtNum(c.minVolume1hUsd)}/h · ≥ ${c.minBuys1h} buys/h · buy/sell ≥ ${fmtNum(c.minBuyPressure)}×`,
    `• rising (1h > ${fmtNum(c.minChange1hPct)}% or 6h > ${fmtNum(c.minChange6hPct)}%), not down > ${fmtNum(c.maxDrop5mPct)}% in 5m or > ${fmtNum(c.maxDrop24hPct)}% in 24h`,
    `• mint/freeze authority blocked: ${c.requireNoAuthorities ? 'yes' : 'no'}`,
    '',
    `BUYS $${c.sizeUsd} (${cap}) · up to ${c.maxOpen} open · ${c.maxTradesDay}/day · stops for the day at −${c.maxDailyLossPct}%`,
    `SELLS everything at +${c.takeProfitPct}% / −${c.stopLossPct}% or after ${c.maxHoldMin} min`,
    open.length ? `Applies to your ${open.length} open position${open.length > 1 ? 's' : ''} right now.` : 'No open positions yet.',
    `Slippage: buy ${fmtNum(c.buySlippagePct)}% · sell ${fmtNum(c.sellSlippagePct)}–${fmtNum(c.sellSlippageMaxPct)}%`,
    `🧠 Learning: ${c.learningMode}`,
  ].join('\n');
}

function reportText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily, history, balanceKind } = positions.stats();
  const sc = scanner.status();
  const lines = [
    '📊 REPORT',
    `${DRY_RUN ? 'PAPER' : 'LIVE'} · ${profileLabel(c)} · $${c.sizeUsd}`,
    `Today ${daily.tradesToday || 0}/${c.maxTradesDay} trades · ${signed(daily.realizedSol || 0, 4)} SOL`,
  ];
  if (balanceKind === 'paper' && daily.paperBalanceSol != null) lines.push(`Paper balance: ${daily.paperBalanceSol.toFixed(4)} SOL`);
  lines.push('');
  if (open.length) {
    lines.push('OPEN:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? '…' : `${signed(p.lastPnl)}%`;
      lines.push(`• ${mintShort(p.mint)} ${pnl} · ${p.sizeSol.toFixed(4)} SOL · ${Math.round((Date.now() - p.openedAt) / 1000)}s · ${p.status}`);
    }
  } else lines.push('No open positions.');
  if (history.length) {
    lines.push('', 'CLOSED:');
    for (const h of history.slice(0, 5)) {
      lines.push(`• ${mintShort(h.mint)} ${h.reason} ${h.realizedSol == null ? '?' : `${signed(h.realizedSol, 4)} SOL`}`);
    }
  }
  const r = sc.lastResult;
  if (r) {
    lines.push('', `LAST SCAN (${Math.round((Date.now() - r.at) / 60000)} min ago): ${r.checked} checked`);
    const top = Object.entries(r.rejects).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (r.picked) lines.push(`• picked ${mintShort(r.picked)}`);
    else if (top.length) lines.push(`• none passed. Most rejected for: ${top.map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ keyboards
const mainKeyboard = () => {
  const c = getConfig();
  return {
    inline_keyboard: [
      [btn(c.paused ? '▶️ Start bot' : '⏸ Pause bot', 'pause'), btn('📋 Plan', 'plan')],
      [btn('🟢 Easy', 'p:easy'), btn('🟡 Medium', 'p:medium'), btn('🔴 Hard', 'p:hard')],
      [btn('⚙️ Settings', 'nav:settings'), btn('📁 Activity', 'nav:activity')],
      [btn('🧠 Learning', 'l:open'), btn('🔥 Sell all', 'sellall')],
    ],
  };
};

const settingsKeyboard = () => ({
  inline_keyboard: [
    [btn(GROUPS.trade.title, 'g:trade'), btn(GROUPS.filters.title, 'g:filters')],
    [btn(GROUPS.exec.title, 'g:exec'), btn('🧠 Learning', 'l:open')],
    [btn('✅ Apply & run', 'apply')],
    [btn('« Main menu', 'nav:main')],
  ],
});

const activityKeyboard = () => ({
  inline_keyboard: [
    [btn('📊 Report', 'act:report'), btn('📅 Review', 'act:review')],
    [btn('💼 Balance', 'act:bal')],
    [btn('« Main menu', 'nav:main')],
  ],
});

function groupText(group) {
  const c = getConfig();
  const g = GROUPS[group];
  return [
    `${g.title} — ${g.blurb}`,
    '',
    ...S.keysInGroup(group).map((k) => `${SETTINGS[k].label}: ${fmtValue(k, c[k])}`),
    '',
    'Tap a setting, then pick a preset or just TYPE a value.',
    c.paused ? '⏸ Bot is paused — ✅ Apply & run starts it with this plan.' : '✓ Changes are live immediately.',
  ].join('\n');
}

function groupKeyboard(group) {
  const c = getConfig();
  const keys = S.keysInGroup(group);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(
      keys.slice(i, i + 2).map((k) => {
        const d = SETTINGS[k];
        return d.kind === 'bool'
          ? btn(`${c[k] ? '✅' : '⬜'} ${shortLabel(k).replace(/^\S+ /, '')}`, `t:${k}`)
          : btn(`${shortLabel(k)}: ${fmtValue(k, c[k])}`, `v:${k}`);
      })
    );
  }
  rows.push([btn('✅ Apply & run', 'apply')]);
  rows.push([btn('« Settings', 'nav:settings'), btn('« Menu', 'nav:main')]);
  return { inline_keyboard: rows };
}

function pickerText(key, banner) {
  const d = SETTINGS[key];
  const c = getConfig();
  if (d.kind === 'bool') return [banner || null, `${d.label}: ${fmtValue(key, c[key])}`, '', d.desc, '', 'Tap the button, or send on / off.'].filter((x) => x != null).join('\n');
  const typeHint =
    d.kind === 'dur'
      ? `Or type a time like 30s, 15m, 6h or 10d (${S.rangeText(d)}).`
      : `Or just type a number (${S.rangeText(d)}${d.zero ? `, "off" = ${d.zero.toLowerCase()}` : ''}).`;
  return [banner || null, `${d.label}: ${fmtValue(key, c[key])}`, '', d.desc, '', `✏️ ${typeHint} Send it now — no extra tap needed.`].filter((x) => x != null).join('\n');
}

function pickerKeyboard(key) {
  const d = SETTINGS[key];
  const c = getConfig();
  const rows = [];
  if (d.kind === 'bool') {
    rows.push([btn(c[key] ? '⬜ Turn OFF' : '✅ Turn ON', `t:${key}`)]);
    rows.push([btn(`« ${GROUPS[d.group].title}`, `g:${d.group}`), btn('« Menu', 'nav:main')]);
    return { inline_keyboard: rows };
  }
  const pre = d.presets.map((v, i) => btn(`${Math.abs(Number(c[key]) - v) < 1e-9 ? '✅ ' : ''}${fmtValue(key, v)}`, `s:${key}:${i}`));
  for (let i = 0; i < pre.length; i += 3) rows.push(pre.slice(i, i + 3));
  const steps = d.steps.map((st, i) => btn(S.fmtStep(d, st), `n:${key}:${i}`));
  for (let i = 0; i < steps.length; i += 4) rows.push(steps.slice(i, i + 4));
  rows.push([btn('✅ Apply & run', 'apply')]);
  rows.push([btn(`« ${GROUPS[d.group] ? GROUPS[d.group].title : 'Learning'}`, d.group === 'learning' ? 'l:open' : `g:${d.group}`), btn('« Menu', 'nav:main')]);
  return { inline_keyboard: rows };
}

function learningView(banner) {
  const c = getConfig();
  const st = tuner.stats();
  const sug = tuner.suggest(c);
  const mode = (m, label) => btn(`${c.learningMode === m ? '✅ ' : ''}${label}`, `l:mode:${m}`);
  const lines = [
    banner || null,
    '🧠 LEARNING MODE',
    '',
    c.learningMode === 'off'
      ? 'OFF — nothing is suggested or changed.'
      : c.learningMode === 'auto'
      ? 'AUTO — every 10 new closed trades it adjusts take-profit, max hold and the entry filters in small steps, and tells you.'
      : 'SUGGEST — it studies your closed trades and shows what it would change. You decide.',
    'Never touches size, daily loss, slippage/fees, stop loss, the authority switch or your preset.',
    '',
    st.total.n
      ? `Learned from ${st.total.n} closed trades · ${st.total.winRate.toFixed(0)}% win · avg ${signed(st.total.avgPct)}%`
      : 'No closed trades recorded yet.',
    ...Object.entries(st.byExit).map(([k, g]) => `• ${k}: ${g.n} trades · avg ${signed(g.avgPct)}%`),
    '',
  ];
  if (c.learningMode !== 'off') {
    if (!sug.ready) lines.push(`Collecting data: ${sug.n}/${sug.needed} closed trades before it suggests anything.`);
    else if (!sug.suggestions.length) lines.push('✅ Nothing to change — the data does not show a clear improvement.');
    else {
      lines.push('Suggested changes:');
      for (const x of sug.suggestions) lines.push(`• ${SETTINGS[x.key].label}: ${fmtValue(x.key, x.current)} → ${fmtValue(x.key, x.suggested)}\n   ${x.why}`);
    }
  }
  lines.push('', 'A few dozen trades is a small sample and the past does not guarantee the future — treat these as hints.');
  const rows = [[mode('off', 'Off'), mode('suggest', 'Suggest'), mode('auto', 'Auto')]];
  if (c.learningMode !== 'off' && sug.ready && sug.suggestions.length) rows.push([btn('✅ Apply suggestions', 'l:apply')]);
  rows.push([btn(`✏️ Trades needed (${c.learningMinTrades})`, 'v:learningMinTrades'), btn('🔄 Refresh', 'l:open')]);
  rows.push([btn('🗑 Reset learned data', 'l:reset'), btn('« Menu', 'nav:main')]);
  return { text: lines.filter((x) => x != null).join('\n'), keyboard: { inline_keyboard: rows } };
}

// ------------------------------------------------------------------ sending
async function refreshLiveStatus(force = false) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const { key, text } = liveStatusLine();
  if (!force && key === lastStatusKey) return;
  lastStatusKey = key;
  try {
    if (statusMsgId) await bot.editMessageText(text, { chat_id: TELEGRAM_CHAT_ID, message_id: statusMsgId });
    else statusMsgId = (await bot.sendMessage(TELEGRAM_CHAT_ID, text)).message_id;
  } catch (err) {
    if (/message to edit not found|MESSAGE_ID_INVALID/i.test(err.message)) {
      try {
        statusMsgId = (await bot.sendMessage(TELEGRAM_CHAT_ID, text)).message_id;
      } catch (_) {
        /* retry on the next refresh */
      }
    }
  }
}

async function editOrSend(chatId, messageId, text, keyboard) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
    return messageId;
  } catch (e) {
    if (/message is not modified/i.test(e.message)) return messageId;
    const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
    return sent.message_id;
  }
}

/** Save → un-pause → scan now → show the exact plan. Shared by the button and /apply. */
function applyAndRun() {
  const wasPaused = getConfig().paused;
  if (wasPaused) live.applyLocal({ paused: false });
  scanner.rescanNow();
  refreshLiveStatus(true);
  return `✅ ${wasPaused ? 'Started.' : 'Applied.'} The bot is now running exactly this plan and is scanning now:\n\n${planText()}`;
}

const NAV_TEXT = {
  main: statusText,
  settings: () => `⚙️ SETTINGS\nPlan: ${profileLabel(getConfig())}\n\nPick a group. Every value can be typed.`,
  activity: () => '📁 ACTIVITY',
};

// ------------------------------------------------------------------ typed values
function handleTyped(chatId, key, text) {
  const res = live.setValue(key, text);
  if (!res.ok) return { ok: false, text: `❌ ${res.error}\nTry again, or /cancel.` };
  return { ok: true, banner: `✅ ${SETTINGS[key].label} set to ${fmtValue(key, res.value)}${res.notes.length ? '\n' + res.notes.join('\n') : ''}` };
}

const HELP = [
  'Open /menu — everything is buttons, and every number can be TYPED.',
  '',
  'Open any setting and just send a value: 12.5 · 150% · 30s · 6h · 10d · off',
  'Or use a command:  /set <name> <value>   e.g.  /set tp 50 · /set minage 2s · /set maxage 20d',
  '/set with no value lists every name.',
  '',
  '/plan — exactly what the bot is doing now',
  '/apply — save, start and scan right away',
  '/menu · /report · /review · /learning · /balance · /pause · /resume · /sellall · /risk easy|medium|hard · /cancel',
].join('\n');

function setListText() {
  const c = getConfig();
  const names = {};
  for (const [alias, key] of Object.entries(S.ALIASES)) (names[key] = names[key] || []).push(alias);
  return ['Settings you can change with /set <name> <value>:', ''].concat(
    Object.keys(SETTINGS).map((k) => `${(names[k] || [k])[0]} — ${shortLabel(k).replace(/^\S+ /, '')}: ${fmtValue(k, c[k])}  (${S.rangeText(SETTINGS[k])})`)
  ).join('\n');
}

// ------------------------------------------------------------------ start
function start() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[telegram] disabled (no token)');
    return;
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('[telegram] polling');
  tuner.setNotifier((t) => notify(t));
  bot
    .setMyCommands([
      { command: 'menu', description: 'Control panel' },
      { command: 'plan', description: 'What the bot is doing now' },
      { command: 'apply', description: 'Apply settings, start and scan now' },
      { command: 'set', description: 'Change a setting: /set tp 50' },
      { command: 'report', description: 'Positions, results, last scan' },
      { command: 'learning', description: 'Learning mode' },
      { command: 'pause', description: 'Pause the bot' },
      { command: 'resume', description: 'Start the bot' },
      { command: 'sellall', description: 'Sell every open position' },
    ])
    .catch(() => {});
  setTimeout(() => refreshLiveStatus(true), 2000).unref();
  setInterval(() => refreshLiveStatus(), 15000).unref();

  bot.onText(/^\/(start|menu|status)\b/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    pending.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, statusText(), { reply_markup: mainKeyboard() });
  });
  bot.onText(/^\/help\b/i, (msg) => allowed(msg.chat.id) && bot.sendMessage(msg.chat.id, HELP));
  bot.onText(/^\/plan\b/i, (msg) => allowed(msg.chat.id) && bot.sendMessage(msg.chat.id, planText(), { reply_markup: mainKeyboard() }));
  bot.onText(/^\/apply\b/i, (msg) => allowed(msg.chat.id) && bot.sendMessage(msg.chat.id, applyAndRun(), { reply_markup: mainKeyboard() }));
  // Shortcuts that the README has always listed (they used to exist only as buttons)
  const reply = (msg, text, kb) => bot.sendMessage(msg.chat.id, text, kb ? { reply_markup: kb } : undefined);
  bot.onText(/^\/pause\b/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    live.applyLocal({ paused: true });
    refreshLiveStatus(true);
    reply(msg, '⏸ Paused. Open positions are still managed (TP / SL / max hold).', mainKeyboard());
  });
  bot.onText(/^\/resume\b/i, (msg) => allowed(msg.chat.id) && reply(msg, applyAndRun(), mainKeyboard()));
  bot.onText(/^\/sellall\b/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    const n = positions.exitAll('manual');
    reply(msg, n ? `🔥 Selling ${n} position${n > 1 ? 's' : ''}…` : 'No open positions.');
  });
  bot.onText(/^\/(report|pnl)\b/i, (msg) => allowed(msg.chat.id) && reply(msg, reportText()));
  bot.onText(/^\/review\b/i, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    reply(msg, (await memory.review({ days: 7 })).text);
  });
  bot.onText(/^\/(learning|learn|advice)\b/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    const v = learningView();
    reply(msg, v.text, v.keyboard);
  });
  bot.onText(/^\/balance\b/i, async (msg) => {
    if (!allowed(msg.chat.id)) return;
    try {
      loadWallet();
      reply(msg, `💼 ${(await getSolBalance()).toFixed(4)} SOL`);
    } catch (e) {
      reply(msg, `Balance error: ${e.message}`);
    }
  });
  bot.onText(/^\/risk(?:@\w+)?(?:\s+(easy|medium|hard))?\s*$/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    if (!m[1]) return reply(msg, `Plan: ${profileLabel(getConfig())}. Use /risk easy, /risk medium or /risk hard.`);
    live.applyPreset(m[1].toLowerCase());
    reply(msg, `${applyAndRun()}\n\n(The ${m[1].toLowerCase()} preset replaced your custom size / exit / filter values.)`, mainKeyboard());
  });
  bot.onText(/^\/(custom|settings)\b/i, (msg) => allowed(msg.chat.id) && reply(msg, NAV_TEXT.settings(), settingsKeyboard()));

  bot.onText(/^\/cancel\b/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    pending.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Cancelled.');
  });
  bot.onText(/^\/set(?:@\w+)?(?:\s+(\S+))?(?:\s+(.+))?$/i, (msg, m) => {
    if (!allowed(msg.chat.id)) return;
    if (!m[1]) return bot.sendMessage(msg.chat.id, setListText());
    const key = S.resolveKey(m[1]);
    if (!key) return bot.sendMessage(msg.chat.id, `Unknown setting "${m[1]}". Send /set to see the list.`);
    if (m[2] == null) return bot.sendMessage(msg.chat.id, pickerText(key), { reply_markup: pickerKeyboard(key) });
    const r = handleTyped(msg.chat.id, key, m[2]);
    bot.sendMessage(msg.chat.id, r.ok ? r.banner : r.text);
  });

  bot.on('message', async (msg) => {
    if (!allowed(msg.chat.id)) return;
    const text = String(msg.text || '').trim();
    if (!text || text.startsWith('/')) return;
    const p = pending.get(msg.chat.id);
    if (!p) return;
    const r = handleTyped(msg.chat.id, p.key, text);
    if (!r.ok) return bot.sendMessage(msg.chat.id, r.text);
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    p.messageId = await editOrSend(msg.chat.id, p.messageId, pickerText(p.key, r.banner), pickerKeyboard(p.key));
    refreshLiveStatus(true);
  });

  bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    if (!allowed(chatId)) return bot.answerCallbackQuery(q.id, { text: 'Unauthorized' });
    const [kind, a, b] = String(q.data || '').split(':');
    const messageId = q.message.message_id;
    let toast;
    let screen; // { text, keyboard }
    try {
      pending.delete(chatId); // leaving a setting screen stops typing; opening one re-arms it below
      const openPicker = (key, banner) => {
        pending.set(chatId, { key, messageId });
        return { text: pickerText(key, banner), keyboard: pickerKeyboard(key) };
      };
      switch (kind) {
        case 'nav':
          screen = { text: NAV_TEXT[a](), keyboard: { main: mainKeyboard, settings: settingsKeyboard, activity: activityKeyboard }[a]() };
          break;
        case 'g':
          screen = { text: groupText(a), keyboard: groupKeyboard(a) };
          break;
        case 'v':
          if (!SETTINGS[a]) throw new Error('unknown setting');
          screen = openPicker(a);
          break;
        case 's': {
          const val = SETTINGS[a].presets[Number(b)];
          const res = live.setValue(a, val);
          toast = res.ok ? `✅ ${fmtValue(a, res.value)}` : res.error;
          screen = openPicker(a, res.ok ? res.notes.join('\n') || null : `❌ ${res.error}`);
          break;
        }
        case 'n': {
          const res = live.nudge(a, SETTINGS[a].steps[Number(b)]);
          toast = res.ok ? `✅ ${fmtValue(a, res.value)}` : res.error;
          screen = openPicker(a, res.ok ? res.notes.join('\n') || null : `❌ ${res.error}`);
          break;
        }
        case 't': {
          const res = live.toggle(a);
          toast = res.ok ? `${SETTINGS[a].label}: ${fmtValue(a, res.value)}` : res.error;
          screen = { text: groupText(SETTINGS[a].group), keyboard: groupKeyboard(SETTINGS[a].group) };
          break;
        }
        case 'p':
          if (!live.applyPreset(a)) throw new Error('unknown preset');
          toast = `${a} active`;
          screen = { text: `${applyAndRun()}\n\n(The ${a} preset replaced your custom size / exit / filter values.)`, keyboard: mainKeyboard() };
          break;
        case 'apply':
          toast = 'Applied';
          screen = { text: applyAndRun(), keyboard: mainKeyboard() };
          break;
        case 'pause': {
          const next = !getConfig().paused;
          live.applyLocal({ paused: next });
          if (!next) scanner.rescanNow();
          toast = next ? 'Paused' : 'Running';
          screen = { text: statusText(), keyboard: mainKeyboard() };
          refreshLiveStatus(true);
          break;
        }
        case 'plan':
          screen = { text: planText(), keyboard: mainKeyboard() };
          break;
        case 'sellall': {
          const n = positions.exitAll('manual');
          toast = n ? `Selling ${n}` : 'None open';
          break;
        }
        case 'act': {
          const back = { inline_keyboard: [[btn('🔄 Refresh', `act:${a}`)], [btn('« Activity', 'nav:activity')]] };
          if (a === 'report') screen = { text: reportText(), keyboard: back };
          else if (a === 'review') {
            const { text } = await memory.review({ days: 7 });
            screen = { text, keyboard: back };
          } else if (a === 'bal') {
            loadWallet();
            screen = { text: `💼 ${(await getSolBalance()).toFixed(4)} SOL`, keyboard: back };
          }
          break;
        }
        case 'l': {
          if (a === 'mode') {
            live.applyLocal({ learningMode: ['off', 'suggest', 'auto'].includes(b) ? b : 'suggest' });
            toast = `Learning: ${getConfig().learningMode}`;
            screen = learningView();
          } else if (a === 'apply') {
            const r = tuner.applySuggestions();
            toast = r.applied.length ? `Applied ${r.applied.length}` : r.reason || 'Nothing to apply';
            screen = learningView(r.applied.length ? `✅ Applied:\n${r.applied.map((x) => `• ${SETTINGS[x.key].label}: ${fmtValue(x.key, x.current)} → ${fmtValue(x.key, x.applied)}`).join('\n')}` : null);
          } else if (a === 'reset') {
            screen = { text: '🗑 Delete every recorded trade used for learning? This cannot be undone (your settings stay as they are).', keyboard: { inline_keyboard: [[btn('Yes, delete', 'l:resetyes'), btn('Cancel', 'l:open')]] } };
          } else if (a === 'resetyes') {
            memory.resetJournal();
            tuner._reset();
            toast = 'Deleted';
            screen = learningView('🗑 Learned data deleted.');
          } else screen = learningView();
          break;
        }
        default:
          break;
      }
      await bot.answerCallbackQuery(q.id, toast ? { text: toast.slice(0, 190) } : undefined);
      if (screen) {
        const newId = await editOrSend(chatId, messageId, screen.text, screen.keyboard);
        if (pending.has(chatId)) pending.get(chatId).messageId = newId;
      }
      if (['s', 'n', 't', 'p', 'apply'].includes(kind)) refreshLiveStatus(true);
    } catch (e) {
      try {
        await bot.answerCallbackQuery(q.id, { text: `Error: ${String(e.message).slice(0, 120)}` });
      } catch (_) {
        /* the callback may have expired */
      }
    }
  });
}

function notify(text) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, text).catch(() => {});
}

module.exports = { start, notify, _internals: { planText, statusText, reportText, groupText, groupKeyboard, pickerText, pickerKeyboard, learningView, mainKeyboard, settingsKeyboard, activityKeyboard, handleTyped, setListText } };
