/**
 * Position lifecycle. Principle: never guess what happened on-chain, read it.
 * Entry features stored for self-learning; closed trades written to Supabase trade_log.
 */
const config = require('../config');
const logger = require('../utils/logger');
const { getConfig } = require('../live/liveConfig');
const chain = require('../solana/wallet');
const fills = require('../solana/fills');
const swap = require('./swap');
const market = require('../analysis/dexscreener');
const store = require('../storage/positionsStore');
const scanner = require('../scanner/scanner');
const memory = require('../learning/memory');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toSol = (lamports) => Number(lamports) / 1e9;
const short = (mint) => `${mint.slice(0, 6)}…${mint.slice(-4)}`;
const scan = (sig) => (sig ? `https://solscan.io/tx/${sig}` : '');

const open = new Map();
let entering = false;
let notifier = () => {};
let monitorTimer = null;
let monitoring = false;
let daily = { day: null, startSol: 0, realizedSol: 0, paperBalanceSol: null, tradesToday: 0 };
let history = [];

function setNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : () => {};
}

const warnStore = (e) => notifier(`⚠️ Could not save state: ${e.message}`);
const persistPositions = () =>
  store.save('state', 'positions', () => [...open.values()].map((p) => ({ ...p })), warnStore);
const persistDaily = () => store.save('state', 'daily', () => ({ ...daily }), warnStore);
const persistHistory = () => store.save('state', 'history', () => history.slice(), warnStore);

async function currentBalanceSol() {
  return config.DRY_RUN ? daily.paperBalanceSol : chain.getSolBalance();
}

async function rollDay() {
  const day = new Date().toISOString().slice(0, 10);
  if (daily.day === day) return;
  daily.day = day;
  daily.realizedSol = 0;
  daily.tradesToday = 0;
  daily.startSol = await currentBalanceSol();
  persistDaily();
}

async function isHalted() {
  await rollDay();
  if (!(daily.startSol > 0)) return false;
  const limit = (daily.startSol * Number(getConfig().maxDailyLossPct)) / 100;
  return daily.realizedSol <= -limit;
}

/**
 * How much SOL to spend. Starts from your dollar size, then is limited by YOUR "Max SOL per trade"
 * (0 = no cap) and by what the wallet can afford. Says what limited it so the bot never silently
 * trades less than you asked for.
 */
async function sizeSol() {
  const cfg = getConfig();
  const bal = await currentBalanceSol();
  const usable = Math.max(0, bal - config.SOL_FEE_RESERVE);
  const solUsd = await scanner.fetchSolPriceUsd();
  const wanted = Number(cfg.sizeUsd) / solUsd;
  let sol = wanted;
  let limitedBy = null;
  const cap = Number(cfg.maxPositionSol);
  if (cap > 0 && sol > cap) {
    sol = cap;
    limitedBy = `your Max SOL per trade (${cap} SOL)`;
  }
  if (sol > usable * 0.95) {
    sol = usable * 0.95;
    limitedBy = `wallet balance (${usable.toFixed(4)} SOL usable after the ${config.SOL_FEE_RESERVE} SOL fee reserve)`;
  }
  if (sol < config.MIN_POSITION_SOL) sol = 0;
  return { sol: Math.floor(sol * 1e6) / 1e6, wantedSol: wanted, solUsd, limitedBy };
}

async function liveBuy(mint, sol) {
  const wallet = chain.loadWallet();
  const owner = chain.address();
  const solBefore = await chain.getSolLamports();
  let sig;
  try {
    sig = await swap.buy(wallet, mint, sol);
  } catch (e) {
    if (!e.signature || e.onchainError || e.notSent) throw e;
    const verdict = await swap.waitForSignature(e.signature, 75000);
    if (!verdict.ok) throw new Error(`buy did not land: ${verdict.reason} (${e.signature})`);
    sig = e.signature;
  }
  const fill = await fills.readFill(sig, owner, mint);
  if (fill && !fill.failed && fill.tokenDeltaRaw > 0n && fill.solDeltaLamports != null && fill.solDeltaLamports < 0n) {
    return {
      tokenRaw: fill.tokenDeltaRaw,
      decimals: fill.decimals,
      costLamports: -fill.solDeltaLamports,
      signature: sig,
      source: 'tx',
    };
  }
  let bal = { raw: 0n, decimals: null };
  for (let i = 0; i < 6 && bal.raw <= 0n; i++) {
    try {
      bal = await chain.getTokenBalance(mint);
    } catch (_) {}
    if (bal.raw <= 0n) await sleep(700);
  }
  if (bal.raw <= 0n) {
    throw new Error(`buy tx confirmed but no tokens found in the wallet. Check it manually: ${scan(sig)}`);
  }
  const solAfter = await chain.getSolLamports();
  const spent = solBefore - solAfter;
  return {
    tokenRaw: bal.raw,
    decimals: bal.decimals,
    costLamports: spent > 0n ? spent : BigInt(Math.round(sol * 1e9)),
    signature: sig,
    source: spent > 0n ? 'balance' : 'requested-amount',
  };
}

async function paperBuy(mint, sol, mkt) {
  if (config.DRY_RUN_ROUTE_CHECK) await swap.routeCheck(chain.loadWallet(), mint, sol);
  const decimals = 6;
  const tokensUi = (sol * (1 - config.PAPER_FRICTION_PCT / 100)) / mkt.priceNative;
  return {
    tokenRaw: BigInt(Math.floor(tokensUi * 10 ** decimals)),
    decimals,
    costLamports: BigInt(Math.round(sol * 1e9)),
    signature: null,
    source: 'paper',
  };
}

async function tryEnter(mint, reason) {
  const cfg = getConfig();
  if (cfg.paused) return { ok: false, why: 'paused' };
  if (open.has(mint) || entering) return { ok: false, why: 'busy' };
  if (open.size >= Number(cfg.maxOpen)) return { ok: false, why: 'max concurrent' };
  await rollDay();
  const maxTrades = Number(cfg.maxTradesDay) || 7;
  if (daily.tradesToday >= maxTrades) {
    return { ok: false, why: `max trades/day reached (${daily.tradesToday}/${maxTrades})` };
  }
  entering = true;
  try {
    if (await isHalted()) return { ok: false, why: 'daily loss limit reached' };
    const mkt = await market.getTokenMarket(mint);
    if (!mkt) return { ok: false, why: 'no SOL-quoted market found' };
    // Re-check EVERY entry filter right before buying: the market moves between the scan and the buy.
    const ev = scanner.evaluate(mkt, cfg);
    if (!ev.ok) return { ok: false, why: `no longer passes your filters: ${ev.reason}` };
    if (cfg.requireNoAuthorities) {
      const mi = await chain.getMintInfo(mint);
      if (mi.mintAuthority || mi.freezeAuthority) return { ok: false, why: 'mint/freeze authority still active' };
    }
    const size = await sizeSol();
    const sol = size.sol;
    if (sol < config.MIN_POSITION_SOL) return { ok: false, why: `size ${sol} SOL below the ${config.MIN_POSITION_SOL} SOL minimum${size.limitedBy ? ` (limited by ${size.limitedBy})` : ''}` };
    logger.info(`ENTER ${short(mint)} ${sol} SOL (wanted $${cfg.sizeUsd}${size.limitedBy ? `, limited by ${size.limitedBy}` : ''}) (${reason}) ${config.DRY_RUN ? '[PAPER]' : '[LIVE]'}`);
    const fill = config.DRY_RUN ? await paperBuy(mint, sol, mkt) : await liveBuy(mint, sol);
    const costSol = toSol(fill.costLamports);
    const tokensUi = Number(fill.tokenRaw) / 10 ** fill.decimals;
    const scoreMatch = String(reason || '').match(/scanner:(\d+(?:\.\d+)?)/);
    const pos = {
      mint,
      openedAt: Date.now(),
      dryRun: config.DRY_RUN,
      status: 'open',
      costLamports: String(fill.costLamports),
      tokenRaw: String(fill.tokenRaw),
      decimals: fill.decimals,
      sizeSol: costSol,
      sizeUsd: cfg.sizeUsd,
      sizeLimitedBy: size.limitedBy,
      actualUsd: costSol * size.solUsd,
      entryPriceNative: costSol / tokensUi,
      fillSource: fill.source,
      buySig: fill.signature,
      reason,
      mode: cfg.riskProfile,
      ageDays: mkt.ageDays ?? null,
      liquidityUsd: mkt.liquidityUsd ?? null,
      volume1h: mkt.volume1h ?? null,
      priceChange1h: mkt.priceChange1h ?? null,
      priceChange6h: mkt.priceChange6h ?? null,
      buys1h: mkt.buys1h ?? null,
      buyPressure: mkt.sells1h > 0 ? mkt.buys1h / mkt.sells1h : null,
      score: scoreMatch ? Number(scoreMatch[1]) : null,
      takeProfitPct: cfg.takeProfitPct,
      stopLossPct: cfg.stopLossPct,
      maxHoldMin: cfg.maxHoldMin,
      lastPnl: null,
      peakPnl: 0,
      peakAtSec: 0,
      lastPrice: null,
      priceMisses: 0,
      stuckRounds: 0,
    };
    open.set(mint, pos);
    daily.tradesToday = (daily.tradesToday || 0) + 1;
    if (config.DRY_RUN) daily.paperBalanceSol -= costSol;
    persistPositions();
    persistDaily();
    return { ok: true, pos };
  } catch (err) {
    logger.error('buy failed:', err.message);
    return { ok: false, why: err.message };
  } finally {
    entering = false;
  }
}

function markPnl(pos, priceNative) {
  const tokensUi = Number(pos.tokenRaw) / 10 ** pos.decimals;
  const value = tokensUi * priceNative * (1 - config.EXIT_COST_PCT / 100);
  const cost = Number(pos.costLamports) / 1e9;
  return ((value - cost) / cost) * 100;
}

async function checkPosition(pos) {
  const cfg = getConfig();
  const tp = Number(cfg.takeProfitPct) || 30;
  const sl = -Math.abs(Number(cfg.stopLossPct) || 20);
  const maxHoldMs = (Number(cfg.maxHoldMin) || 2) * 60 * 1000;
  let pnl = null;
  try {
    const mkt = await market.getTokenMarket(pos.mint);
    if (mkt) {
      pnl = markPnl(pos, mkt.priceNative);
      pos.lastPrice = mkt.priceNative;
      pos.lastPnl = pnl;
      if (pnl > (pos.peakPnl || 0)) {
        pos.peakPnl = pnl; // best profit seen — Learning uses it to tune take-profit / max hold
        pos.peakAtSec = Math.round((Date.now() - pos.openedAt) / 1000);
      }
      pos.priceMisses = 0;
    } else {
      pos.priceMisses += 1;
    }
  } catch (_) {
    pos.priceMisses += 1;
  }
  if (pos.priceMisses === 6) {
    notifier(`⚠️ No price for ${short(pos.mint)} for a while. Only the max-hold timer can exit it now. /sellall sells it manually.`);
  }
  let reason = null;
  if (pnl != null && pnl >= tp) reason = 'take_profit';
  else if (pnl != null && pnl <= sl) reason = 'stop_loss';
  else if (Date.now() - pos.openedAt >= maxHoldMs) reason = 'max_hold';
  if (reason) exit(pos, reason).catch((e) => logger.error('exit crashed:', e.message));
}

async function monitorTick() {
  if (monitoring) return;
  monitoring = true;
  try {
    for (const pos of [...open.values()]) {
      if (pos.status === 'selling') continue;
      if (pos.status === 'stuck') {
        if (Date.now() >= (pos.retryAt || 0)) exit(pos, pos.exitReason || 'retry').catch(() => {});
        continue;
      }
      await checkPosition(pos);
    }
  } finally {
    monitoring = false;
  }
}

async function paperSell(pos) {
  let price = pos.lastPrice;
  try {
    const mkt = await market.getTokenMarket(pos.mint);
    if (mkt) price = mkt.priceNative;
  } catch (_) {}
  if (!(price > 0)) price = pos.entryPriceNative;
  const tokensUi = Number(pos.tokenRaw) / 10 ** pos.decimals;
  const proceedsSol = tokensUi * price * (1 - config.EXIT_COST_PCT / 100);
  return { proceedsLamports: BigInt(Math.round(proceedsSol * 1e9)), sig: null, source: 'paper' };
}

async function liveSell(pos) {
  const wallet = chain.loadWallet();
  const owner = chain.address();
  const flat = async () => (await chain.getTokenBalance(pos.mint)).raw <= 0n;
  const solBefore = await chain.getSolLamports().catch(() => null);
  try {
    if (await flat()) return { proceedsLamports: null, sig: null, source: 'already-flat' };
  } catch (_) {}
  let lastErr = null;
  let landed = 0;
  for (let attempt = 1; attempt <= config.SELL_RETRIES; attempt++) {
    let sig = null;
    try {
      sig = await swap.sellAll(wallet, pos.mint, attempt);
    } catch (e) {
      lastErr = e;
      if (e.signature && e.timedOut) {
        const verdict = await swap.waitForSignature(e.signature, 45000);
        if (verdict.ok) sig = e.signature;
      }
      if (!sig) {
        logger.warn(`sell ${attempt}/${config.SELL_RETRIES} ${short(pos.mint)}: ${e.message}`);
        try {
          if (await flat()) return { proceedsLamports: null, sig: null, source: 'already-flat' };
        } catch (_) {}
        await sleep(300);
        continue;
      }
    }
    landed += 1;
    let remaining = null;
    for (let i = 0; i < 3; i++) {
      try {
        remaining = (await chain.getTokenBalance(pos.mint)).raw;
      } catch (_) {
        remaining = null;
      }
      if (remaining === 0n) break;
      await sleep(600);
    }
    if (remaining === 0n) {
      if (landed === 1) {
        const fill = await fills.readFill(sig, owner, pos.mint);
        if (fill && !fill.failed && fill.solDeltaLamports != null) {
          return { proceedsLamports: fill.solDeltaLamports, sig, source: 'tx' };
        }
      }
      const solAfter = await chain.getSolLamports().catch(() => null);
      if (solBefore != null && solAfter != null) return { proceedsLamports: solAfter - solBefore, sig, source: 'balance' };
      return { proceedsLamports: null, sig, source: 'unknown' };
    }
    logger.warn(`sell ${attempt} landed but tokens remain in wallet, retrying`);
  }
  throw new Error(`sell failed after ${config.SELL_RETRIES} attempts: ${lastErr ? lastErr.message : 'tokens still in wallet'}`);
}

async function finalizeClose(pos, reason, result) {
  const costSol = toSol(BigInt(pos.costLamports));
  let proceedsSol = null;
  let realizedSol = null;
  if (result.proceedsLamports != null) {
    proceedsSol = toSol(result.proceedsLamports);
    realizedSol = proceedsSol - costSol;
    daily.realizedSol += realizedSol;
    if (pos.dryRun) daily.paperBalanceSol += proceedsSol;
  }
  open.delete(pos.mint);
  const closedAt = Date.now();
  const pct = realizedSol != null ? (realizedSol / costSol) * 100 : null;
  history.unshift({
    mint: pos.mint,
    openedAt: pos.openedAt,
    closedAt,
    reason,
    costSol,
    proceedsSol,
    realizedSol,
    pct,
    buySig: pos.buySig,
    sellSig: result.sig,
    fillSource: pos.fillSource,
    sellSource: result.source,
    paper: !!pos.dryRun,
    mode: pos.mode,
    ageDays: pos.ageDays,
    liquidityUsd: pos.liquidityUsd,
    volume1h: pos.volume1h,
    priceChange1h: pos.priceChange1h,
    score: pos.score,
  });
  history = history.slice(0, 50);
  persistPositions();
  persistDaily();
  persistHistory();
  memory
    .logTrade({
      profile: pos.mode,
      mint: pos.mint,
      entryReason: pos.reason,
      exitReason: reason,
      costSol,
      proceedsSol,
      realizedSol,
      pct,
      holdSec: pos.openedAt ? Math.round((closedAt - pos.openedAt) / 1000) : null,
      ageDays: pos.ageDays,
      liquidityUsd: pos.liquidityUsd,
      volume1h: pos.volume1h,
      priceChange1h: pos.priceChange1h,
      priceChange6h: pos.priceChange6h,
      buys1h: pos.buys1h,
      score: pos.score,
      sizeUsd: pos.sizeUsd,
      takeProfitPct: pos.takeProfitPct,
      stopLossPct: pos.stopLossPct,
      maxHoldMin: pos.maxHoldMin,
      buySig: pos.buySig,
      sellSig: result.sig,
      meta: { peakPnlPct: pos.peakPnl ?? null, peakAtSec: pos.peakAtSec ?? null, buyPressure: pos.buyPressure ?? null, sellSource: result.source },
    })
    .catch(() => {});
  const head = realizedSol == null ? '⚪' : realizedSol >= 0 ? '🟢' : '🔴';
  const money =
    realizedSol == null
      ? 'result unknown (could not read the sale from the chain, check the wallet)'
      : `${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL (${pct.toFixed(1)}%) from ${costSol.toFixed(4)} SOL in`;
  notifier(
    `${head} EXIT ${short(pos.mint)} · ${reason}${pos.dryRun ? ' · PAPER' : ''}\n${money}\n` +
      `${pos.dryRun ? 'paper numbers (price-based)' : `read from the chain (${result.source})`}` +
      (result.sig ? `\n${scan(result.sig)}` : '')
  );
  logger.info(`EXIT ${short(pos.mint)} ${reason} ${realizedSol == null ? 'pnl unknown' : realizedSol.toFixed(4) + ' SOL'}`);
}

async function exit(pos, reason) {
  if (pos.status === 'selling') return;
  pos.status = 'selling';
  pos.exitReason = reason;
  try {
    const result = pos.dryRun ? await paperSell(pos) : await liveSell(pos);
    await finalizeClose(pos, reason, result);
  } catch (err) {
    pos.status = 'stuck';
    pos.stuckRounds = (pos.stuckRounds || 0) + 1;
    pos.retryAt = Date.now() + config.STUCK_RETRY_MS;
    persistPositions();
    logger.error(`sell failed ${short(pos.mint)} (round ${pos.stuckRounds}):`, err.message);
    if (pos.stuckRounds === 1 || pos.stuckRounds % 5 === 0) {
      notifier(
        `🚨 SELL FAILED ${short(pos.mint)} (round ${pos.stuckRounds})\n${err.message.slice(0, 160)}\n` +
          `The position is kept and retried every ${Math.round(config.STUCK_RETRY_MS / 1000)}s. ` +
          `If it keeps failing, sell it by hand:\n${pos.mint}`
      );
    }
  }
}

function exitAll(reason = 'manual') {
  let n = 0;
  for (const pos of open.values()) {
    if (pos.status === 'selling') continue;
    n += 1;
    exit(pos, reason).catch(() => {});
  }
  return n;
}

async function init() {
  let saved = [];
  try {
    const s = await store.get('state', 'positions');
    saved = Array.isArray(s) ? s : [];
  } catch (e) {
    notifier(`⚠️ Could not load saved positions: ${e.message}. Check the wallet manually.`);
  }
  try {
    const d = await store.get('state', 'daily');
    if (d && typeof d === 'object') daily = { ...daily, ...d };
  } catch (e) {
    logger.warn('daily state load failed:', e.message);
  }
  try {
    const h = await store.get('state', 'history');
    if (Array.isArray(h)) history = h;
  } catch (_) {}
  if (config.DRY_RUN && !(daily.paperBalanceSol > 0)) daily.paperBalanceSol = config.DRY_RUN_BALANCE_SOL;
  let restored = 0;
  let dropped = 0;
  for (const p of saved) {
    if (!p || !p.mint) continue;
    if (!p.dryRun) {
      try {
        if ((await chain.getTokenBalance(p.mint)).raw <= 0n) {
          dropped += 1;
          continue;
        }
      } catch (e) {
        logger.warn(`restore: balance check failed for ${short(p.mint)}, keeping it: ${e.message}`);
      }
    }
    open.set(p.mint, { ...p, status: p.status === 'selling' ? 'open' : p.status || 'open', priceMisses: 0 });
    restored += 1;
  }
  if (saved.length) {
    await persistPositions();
    notifier(`♻️ Restored ${restored} open position(s) after restart${dropped ? `, dropped ${dropped} already sold` : ''}`);
  }
  if (!monitorTimer) {
    monitorTimer = setInterval(() => monitorTick().catch((e) => logger.error('monitor:', e.message)), config.PRICE_POLL_MS);
    if (monitorTimer.unref) monitorTimer.unref();
  }
  return { restored, dropped };
}

async function shutdown() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  await store.flush();
}

/**
 * Fresh start for the trading state: history, today's counters, paper balance.
 * Refuses while anything is open or being bought, so a real position can never be orphaned.
 */
async function resetState() {
  if (open.size > 0 || entering) return { ok: false, why: `${open.size || 1} position(s) still open or being bought — sell them first (/sellall) and try again.` };
  history = [];
  daily = { day: null, startSol: 0, realizedSol: 0, paperBalanceSol: config.DRY_RUN ? config.DRY_RUN_BALANCE_SOL : null, tradesToday: 0 };
  await Promise.all([persistPositions(), persistDaily(), persistHistory()]);
  await rollDay();
  return { ok: true };
}

function listOpen() {
  return [...open.values()];
}

function stats() {
  return {
    daily: { ...daily },
    history: history.slice(),
    balanceKind: config.DRY_RUN ? 'paper' : 'wallet',
  };
}

module.exports = {
  tryEnter,
  listOpen,
  resetState,
  exit,
  exitAll,
  init,
  shutdown,
  stats,
  setNotifier,
  monitorTick,
  markPnl,
  isHalted,
  sizeSol, // exported for tests
};
