const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = require('../config');
const { getConfig, applyLocal, applyPreset, applyCustom } = require('../live/liveConfig');
const positions = require('../trading/positions');
const scanner = require('../scanner/scanner');
const memory = require('../learning/memory');
const { getSolBalance, loadWallet } = require('../solana/wallet');

let bot;
let statusMsgId = null;
let lastStatusKey = '';
const pendingInput = new Map();

function allowed(chatId) {
  if (!TELEGRAM_CHAT_ID) return false;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

function liveStatusLine() {
  const c = getConfig();
  const open = positions.listOpen();
  const sc = scanner.status();
  if (c.paused) return { key: 'paused', text: '⏸  PAUSED\nOpen menu → Start to resume.' };
  if (open.length > 0) {
    const p = open[0];
    const pnl = p.lastPnl != null ? ` · PnL ${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%` : '';
    const held = Math.round((Date.now() - p.openedAt) / 1000);
    return {
      key: `trade:${open.length}:${Math.floor(held / 10)}`,
      text: `🟢  IN TRADE\n${p.mint.slice(0, 6)}…${p.mint.slice(-4)}${pnl}\nheld ${held}s / max ${c.maxHoldMin * 60}s\nTP +${c.takeProfitPct}% · SL −${c.stopLossPct}% · $${c.sizeUsd}`,
    };
  }
  return {
    key: `scan:${c.riskProfile}:${sc.nextInSec}:${c.sizeUsd}:${c.scanIntervalMin}`,
    text: `🔍  SCANNING\n${String(c.riskProfile).toUpperCase()} · $${c.sizeUsd} · next ~${sc.nextInSec}s\nTP+${c.takeProfitPct}% SL−${c.stopLossPct}% hold ${c.maxHoldMin}m · max ${c.maxTradesDay}/d`,
  };
}

function statusText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily } = positions.stats();
  const sc = scanner.status();
  const riskLabel =
    c.riskProfile === 'easy' ? '🟢 Easy' : c.riskProfile === 'hard' ? '🔴 Hard' : c.riskProfile === 'custom' ? '⚙️ Custom' : '🟡 Medium';
  return [
    DRY_RUN ? '🧪 PAPER' : '🔴 LIVE',
    c.paused ? '⏸ PAUSED' : '🟢 RUNNING',
    `Plan: ${riskLabel}`,
    '',
    `Size $${c.sizeUsd} · TP +${c.takeProfitPct}% · SL −${c.stopLossPct}%`,
    `Hold ${c.maxHoldMin}m · Scan every ${c.scanIntervalMin}m`,
    `Max ${c.maxTradesDay}/day · age ≥ ${sc.minAgeDays || 10}d rising`,
    `Today ${daily.tradesToday || 0}/${c.maxTradesDay} · open ${open.length} · next ~${sc.nextInSec}s`,
  ].join('\n');
}

function settingsText() {
  const c = getConfig();
  return [
    '⚙️ SETTINGS',
    `Active plan: ${String(c.riskProfile).toUpperCase()}`,
    c.paused ? '⚠ Bot is PAUSED — Start after changes' : '✓ Plan is LIVE',
    '',
    `💵 Size: $${c.sizeUsd}`,
    `🎯 Take profit: +${c.takeProfitPct}%`,
    `🛡 Stop loss: −${c.stopLossPct}%`,
    `⏱ Max hold: ${c.maxHoldMin} min`,
    `📡 Scan every: ${c.scanIntervalMin} min`,
    `#️⃣ Max trades/day: ${c.maxTradesDay}`,
    '',
    'Tap a row → buttons or Type value. Then Apply & run.',
  ].join('\n');
}

function pnlText() {
  const open = positions.listOpen();
  const { daily, history, balanceKind } = positions.stats();
  const lines = [DRY_RUN ? '🧪 PAPER PnL' : '🔴 LIVE PnL'];
  if (open.length) {
    lines.push('', 'Open:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`;
      const held = Math.round((Date.now() - p.openedAt) / 1000);
      lines.push(`${p.mint.slice(0, 6)}… · ${p.sizeSol.toFixed(4)} SOL · ${pnl} · ${held}s`);
    }
  } else lines.push('', 'No open positions');
  lines.push('', `Today: ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL`, `Trades: ${daily.tradesToday || 0}`);
  if (balanceKind === 'paper' && daily.paperBalanceSol != null) lines.push(`Paper: ${daily.paperBalanceSol.toFixed(4)} SOL`);
  for (const h of history.slice(0, 5)) {
    const r = h.realizedSol == null ? '?' : `${h.realizedSol >= 0 ? '+' : ''}${h.realizedSol.toFixed(4)} SOL`;
    lines.push(`${h.mint.slice(0, 6)}… ${h.reason} ${r}`);
  }
  return lines.join('\n');
}

function reportText() {
  const c = getConfig();
  const open = positions.listOpen();
  const { daily, history } = positions.stats();
  const sc = scanner.status();
  const lines = [
    '📊 REPORT',
    `${DRY_RUN ? 'PAPER' : 'LIVE'} · ${String(c.riskProfile).toUpperCase()} · $${c.sizeUsd}`,
    `TP+${c.takeProfitPct}% · SL−${c.stopLossPct}% · hold ${c.maxHoldMin}m · scan ${c.scanIntervalMin}m`,
    `Today ${daily.tradesToday || 0}/${c.maxTradesDay} · ${daily.realizedSol >= 0 ? '+' : ''}${(daily.realizedSol || 0).toFixed(4)} SOL · next ~${sc.nextInSec}s`,
    '',
  ];
  if (open.length) {
    lines.push('OPEN:');
    for (const p of open) {
      const pnl = p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`;
      lines.push(`• ${p.mint.slice(0, 8)}… ${pnl} · ${p.status}`);
    }
  } else lines.push('No open positions.');
  if (history.length) {
    lines.push('', 'CLOSED:');
    for (const h of history.slice(0, 5)) {
      const r = h.realizedSol == null ? '?' : `${h.realizedSol >= 0 ? '+' : ''}${h.realizedSol.toFixed(4)} SOL`;
      lines.push(`• ${h.mint.slice(0, 6)}… ${h.reason} ${r}`);
    }
  }
  return lines.join('\n');
}

function fieldLabel(field) {
  const c = getConfig();
  return {
    size: `💵 Trade size: $${c.sizeUsd}`,
    tp: `🎯 Take profit: +${c.takeProfitPct}%`,
    sl: `🛡 Stop loss: −${c.stopLossPct}%`,
    hold: `⏱ Max hold: ${c.maxHoldMin} min`,
    scan: `📡 Scan interval: ${c.scanIntervalMin} min`,
    max: `#️⃣ Max trades/day: ${c.maxTradesDay}`,
  }[field] || field;
}

function fieldUnit(field) {
  return { size: 'USD', tp: '%', sl: '%', hold: 'minutes', scan: 'minutes', max: 'trades' }[field] || '';
}

function mainKeyboard() {
  const c = getConfig();
  return {
    inline_keyboard: [
      [{ text: c.paused ? '▶️ Start bot' : '⏸ Pause bot', callback_data: 'toggle_pause' }],
      [
        { text: '🟢 Easy', callback_data: 'risk_easy' },
        { text: '🟡 Medium', callback_data: 'risk_medium' },
        { text: '🔴 Hard', callback_data: 'risk_hard' },
      ],
      [
        { text: '⚙️ Settings', callback_data: 'nav_settings' },
        { text: '📁 Activity', callback_data: 'nav_activity' },
      ],
      [{ text: '🔥 Sell all', callback_data: 'sellall' }],
    ],
  };
}

function settingsKeyboard() {
  const c = getConfig();
  return {
    inline_keyboard: [
      [
        { text: `💵 $${c.sizeUsd}`, callback_data: 'edit_size' },
        { text: `🎯 TP ${c.takeProfitPct}%`, callback_data: 'edit_tp' },
      ],
      [
        { text: `🛡 SL ${c.stopLossPct}%`, callback_data: 'edit_sl' },
        { text: `⏱ ${c.maxHoldMin}m hold`, callback_data: 'edit_hold' },
      ],
      [
        { text: `📡 ${c.scanIntervalMin}m scan`, callback_data: 'edit_scan' },
        { text: `#️⃣ ${c.maxTradesDay}/day`, callback_data: 'edit_max' },
      ],
      [{ text: '✅ Apply & run this plan', callback_data: 'apply_plan' }],
      [{ text: '« Main menu', callback_data: 'nav_main' }],
    ],
  };
}

function activityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Report', callback_data: 'act_report' },
        { text: '📈 PnL', callback_data: 'act_pnl' },
      ],
      [
        { text: '📚 Advice', callback_data: 'act_advice' },
        { text: '📅 Review', callback_data: 'act_review' },
      ],
      [{ text: '💼 Balance', callback_data: 'act_bal' }],
      [{ text: '« Main menu', callback_data: 'nav_main' }],
    ],
  };
}

function adjustKeyboard(field) {
  const steps = {
    size: ['-5', '-1', '+1', '+5', '+10'],
    tp: ['-20', '-10', '-5', '+5', '+10', '+20'],
    sl: ['-10', '-5', '+5', '+10'],
    hold: ['-5', '-1', '+1', '+5', '+15'],
    scan: ['-15', '-5', '+5', '+15', '+30'],
    max: ['-5', '-1', '+1', '+5', '+10'],
  };
  const row = (steps[field] || []).map((s) => ({ text: s, callback_data: `adj_${field}_${s}` }));
  return {
    inline_keyboard: [
      row,
      [{ text: '⌨️ Type a value…', callback_data: `type_${field}` }],
      [
        { text: '« Settings', callback_data: 'nav_settings' },
        { text: '« Menu', callback_data: 'nav_main' },
      ],
    ],
  };
}

function applyAdjust(field, delta) {
  const c = getConfig();
  const patch = {};
  if (field === 'size') patch.sizeUsd = Number(c.sizeUsd) + delta;
  else if (field === 'tp') patch.takeProfitPct = Number(c.takeProfitPct) + delta;
  else if (field === 'sl') patch.stopLossPct = Number(c.stopLossPct) + delta;
  else if (field === 'hold') patch.maxHoldMin = Number(c.maxHoldMin) + delta;
  else if (field === 'scan') patch.scanIntervalMin = Number(c.scanIntervalMin) + delta;
  else if (field === 'max') patch.maxTradesDay = Number(c.maxTradesDay) + delta;
  applyCustom(patch);
  return getConfig();
}

function applyTyped(field, value) {
  const patch = {};
  if (field === 'size') patch.sizeUsd = value;
  else if (field === 'tp') patch.takeProfitPct = value;
  else if (field === 'sl') patch.stopLossPct = value;
  else if (field === 'hold') patch.maxHoldMin = value;
  else if (field === 'scan') patch.scanIntervalMin = value;
  else if (field === 'max') patch.maxTradesDay = value;
  applyCustom(patch);
  return getConfig();
}

function activatePlan() {
  applyLocal({ paused: false });
  const c = getConfig();
  return (
    `✅ Plan active\n` +
    `${String(c.riskProfile).toUpperCase()} · $${c.sizeUsd}\n` +
    `TP +${c.takeProfitPct}% · SL −${c.stopLossPct}%\n` +
    `Hold ${c.maxHoldMin}m · Scan ${c.scanIntervalMin}m · Max ${c.maxTradesDay}/day\n` +
    `Bot is RUNNING with these settings.`
  );
}

async function refreshLiveStatus(force = false) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const { key, text } = liveStatusLine();
  if (!force && key === lastStatusKey) return;
  lastStatusKey = key;
  try {
    if (statusMsgId) {
      await bot.editMessageText(text, { chat_id: TELEGRAM_CHAT_ID, message_id: statusMsgId });
    } else {
      const sent = await bot.sendMessage(TELEGRAM_CHAT_ID, text);
      statusMsgId = sent.message_id;
    }
  } catch (err) {
    if (/message to edit not found|message is not modified|MESSAGE_ID_INVALID/i.test(err.message)) {
      try {
        const sent = await bot.sendMessage(TELEGRAM_CHAT_ID, text);
        statusMsgId = sent.message_id;
      } catch (_) {}
    }
  }
}

async function editOrSend(q, text, keyboard) {
  try {
    await bot.editMessageText(text, {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: keyboard,
    });
  } catch (e) {
    if (!/message is not modified/i.test(e.message)) {
      await bot.sendMessage(q.message.chat.id, text, { reply_markup: keyboard });
    }
  }
}

function start() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[telegram] disabled (no token)');
    return;
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('[telegram] polling');
  setTimeout(() => refreshLiveStatus(true), 2000);
  setInterval(() => refreshLiveStatus(), 15000);

  bot.onText(/\/(start|menu|status|help)/i, (msg) => {
    if (!allowed(msg.chat.id)) return;
    pendingInput.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, statusText(), { reply_markup: mainKeyboard() });
  });

  bot.on('message', (msg) => {
    if (!allowed(msg.chat.id)) return;
    if (!msg.text || msg.text.startsWith('/')) return;
    const pending = pendingInput.get(msg.chat.id);
    if (!pending) return;
    const raw = String(msg.text).trim().replace(/[$,%\s]/g, '');
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      bot.sendMessage(msg.chat.id, 'Send a number only, e.g. 5 or 40');
      return;
    }
    pendingInput.delete(msg.chat.id);
    applyTyped(pending.field, num);
    bot.sendMessage(msg.chat.id, `${fieldLabel(pending.field)}\n\nSaved as CUSTOM. Tap Apply & run when ready.`, {
      reply_markup: settingsKeyboard(),
    });
    refreshLiveStatus(true);
  });

  bot.on('callback_query', async (q) => {
    if (!allowed(q.message.chat.id)) {
      bot.answerCallbackQuery(q.id, { text: 'Unauthorized' });
      return;
    }
    const data = q.data || '';
    const chatId = q.message.chat.id;
    try {
      if (data === 'nav_main') {
        pendingInput.delete(chatId);
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, statusText(), mainKeyboard());
        return;
      }
      if (data === 'nav_settings') {
        pendingInput.delete(chatId);
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, settingsText(), settingsKeyboard());
        return;
      }
      if (data === 'nav_activity') {
        pendingInput.delete(chatId);
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, '📁 ACTIVITY', activityKeyboard());
        return;
      }
      if (data === 'toggle_pause') {
        const next = !getConfig().paused;
        applyLocal({ paused: next });
        await bot.answerCallbackQuery(q.id, { text: next ? 'Paused' : 'Running' });
        await editOrSend(q, statusText(), mainKeyboard());
        refreshLiveStatus(true);
        return;
      }
      if (data === 'risk_easy' || data === 'risk_medium' || data === 'risk_hard') {
        applyPreset(data.replace('risk_', ''));
        applyLocal({ paused: false });
        await bot.answerCallbackQuery(q.id, { text: 'Active' });
        await editOrSend(q, activatePlan() + '\n\n' + statusText(), mainKeyboard());
        refreshLiveStatus(true);
        return;
      }
      if (data === 'apply_plan') {
        await bot.answerCallbackQuery(q.id, { text: 'Plan active' });
        await editOrSend(q, activatePlan() + '\n\n' + statusText(), mainKeyboard());
        refreshLiveStatus(true);
        return;
      }
      if (data.startsWith('edit_')) {
        const field = data.replace('edit_', '');
        pendingInput.delete(chatId);
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, fieldLabel(field) + `\n\nButtons or Type a value (${fieldUnit(field)}):`, adjustKeyboard(field));
        return;
      }
      if (data.startsWith('type_')) {
        const field = data.replace('type_', '');
        pendingInput.set(chatId, { field });
        await bot.answerCallbackQuery(q.id, { text: 'Type a number' });
        await bot.sendMessage(chatId, `⌨️ Send the new value as a number (${fieldUnit(field)}).\nExample: 5\nNext message = value.`);
        return;
      }
      if (data.startsWith('adj_')) {
        const m = data.match(/^adj_([a-z]+)_([+-]?\d+(?:\.\d+)?)$/);
        if (!m) {
          await bot.answerCallbackQuery(q.id, { text: 'Bad' });
          return;
        }
        applyAdjust(m[1], Number(m[2]));
        await bot.answerCallbackQuery(q.id, { text: 'Updated' });
        await editOrSend(q, fieldLabel(m[1]) + '\n\nAdjusted. Type a value or Apply & run.', adjustKeyboard(m[1]));
        refreshLiveStatus(true);
        return;
      }
      if (data === 'act_report') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, reportText(), {
          inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'act_report' }], [{ text: '« Activity', callback_data: 'nav_activity' }]],
        });
        return;
      }
      if (data === 'act_pnl') {
        await bot.answerCallbackQuery(q.id);
        await editOrSend(q, pnlText(), {
          inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'act_pnl' }], [{ text: '« Activity', callback_data: 'nav_activity' }]],
        });
        return;
      }
      if (data === 'act_advice') {
        await bot.answerCallbackQuery(q.id, { text: '…' });
        try {
          const { text, n } = await memory.advice();
          await editOrSend(q, n ? text : 'Not enough history yet.', {
            inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'act_advice' }], [{ text: '« Activity', callback_data: 'nav_activity' }]],
          });
        } catch (e) {
          await editOrSend(q, `Advice error: ${e.message}`, activityKeyboard());
        }
        return;
      }
      if (data === 'act_review') {
        await bot.answerCallbackQuery(q.id, { text: '…' });
        try {
          const { text } = await memory.review({ days: 7 });
          await editOrSend(q, text, {
            inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'act_review' }], [{ text: '« Activity', callback_data: 'nav_activity' }]],
          });
        } catch (e) {
          await editOrSend(q, `Review error: ${e.message}`, activityKeyboard());
        }
        return;
      }
      if (data === 'act_bal') {
        await bot.answerCallbackQuery(q.id);
        try {
          loadWallet();
          const sol = await getSolBalance();
          await editOrSend(q, `💼 ${sol.toFixed(4)} SOL`, {
            inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'act_bal' }], [{ text: '« Activity', callback_data: 'nav_activity' }]],
          });
        } catch (e) {
          await editOrSend(q, `Balance error: ${e.message}`, activityKeyboard());
        }
        return;
      }
      if (data === 'sellall') {
        const n = positions.exitAll('manual');
        await bot.answerCallbackQuery(q.id, { text: n ? `Selling ${n}` : 'None open' });
        return;
      }
      await bot.answerCallbackQuery(q.id);
    } catch (e) {
      try {
        await bot.answerCallbackQuery(q.id, { text: 'Error' });
      } catch (_) {}
    }
  });
}

function notify(text) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, text).catch(() => {});
}

module.exports = { start, notify };
