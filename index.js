require('dotenv').config();
const config = require('./src/config');
const logger = require('./src/utils/logger');
const liveConfig = require('./src/live/liveConfig');
const positions = require('./src/trading/positions');
const telegram = require('./src/telegram/bot');
const wallet = require('./src/solana/wallet');
const rpcPool = require('./src/solana/rpc');
const scanner = require('./src/scanner/scanner');
const memory = require('./src/learning/memory');
const { fmtDuration } = require('./src/live/settings');

console.log(`=== De-Government Strategy v${config.VERSION} — Direct Scanner ===`);
console.log(config.DRY_RUN ? 'Mode: DRY RUN (paper trading, nothing is sent)' : 'Mode: LIVE (real money)');
const cfg = liveConfig.getConfig();
console.log(
  `Starting values: ${cfg.riskProfile} · $${cfg.sizeUsd} · TP +${cfg.takeProfitPct}% · SL −${cfg.stopLossPct}% · hold ${cfg.maxHoldMin}m · every ${cfg.scanIntervalMin}m · max ${cfg.maxTradesDay}/day (your saved Telegram settings load next)`
);
console.log(`RPC pool: ${rpcPool.status().map((e) => e.host).join(', ')}`);

async function main() {
  wallet.loadWallet();

  await liveConfig.start(); // load your saved settings BEFORE anything starts using them
  await memory.init();
  positions.setNotifier((text) => telegram.notify(text));
  await positions.init();
  telegram.start();

  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logger.warn('Telegram is not fully configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID): no alerts and no remote control');
  }
  if (!config.DRY_RUN && !config.SUPABASE_URL) {
    logger.warn('No Supabase configured: positions are saved to local files, which Railway wipes on every deploy');
  }

  // Direct scanner — active on start
  scanner.start(async (pick) => {
    const why = `scanner:${pick.score.toFixed(0)}`;
    logger.info(`signal ${pick.mint.slice(0, 8)}… score=${pick.score.toFixed(1)}`);
    const res = await positions.tryEnter(pick.mint, why);
    announceEntry(res, pick.mint, why);
  });

  const now = liveConfig.getConfig();
  logger.info(`scanner active — age ${fmtDuration(now.minAgeSec)}–${fmtDuration(now.maxAgeSec)}, every ${now.scanIntervalMin}m`);
}

function announceEntry(res, mint, why) {
  const cfg = liveConfig.getConfig();
  if (res.ok) {
    const p = res.pos;
    telegram.notify(
      `🟢 ENTERED ${mint.slice(0, 6)}…${mint.slice(-4)} · ${config.DRY_RUN ? 'PAPER' : 'LIVE'}\n` +
        `${why} · mode ${cfg.riskProfile}\n` +
        `in: ${p.sizeSol.toFixed(4)} SOL (≈$${(p.actualUsd ?? cfg.sizeUsd).toFixed(2)}${p.sizeLimitedBy ? ` — limited by ${p.sizeLimitedBy}` : ''}) → ${(Number(p.tokenRaw) / 10 ** p.decimals).toFixed(2)} tokens (${p.fillSource})\n` +
        `TP +${cfg.takeProfitPct}% · SL −${cfg.stopLossPct}% · max hold ${cfg.maxHoldMin}m` +
        (p.buySig ? `\nhttps://solscan.io/tx/${p.buySig}` : '')
    );
  } else if (res.why && !/^(busy|paused|max concurrent|max trades)/.test(res.why)) {
    logger.info(`skip ${mint.slice(0, 8)}…: ${res.why}`);
    if (/buy|sell|tx|landed|tokens|rpc|pumpportal|send/i.test(res.why)) {
      telegram.notify(`⚠️ Entry on ${mint.slice(0, 6)}… did not happen: ${res.why.slice(0, 200)}`);
    }
  }
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal}: saving state and stopping`);
  try {
    scanner.stop();
    await positions.shutdown();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => logger.error('uncaughtException:', (e && e.message) || e));

main().catch((e) => {
  logger.error('Fatal:', e.message);
  process.exit(1);
});
