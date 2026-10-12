/**
 * Swaps through PumpPortal's FREE local-transaction API: it builds the swap, we sign it with
 * our own key and send it through our own (free) RPCs. No API key, no Helius, no Jupiter.
 * pool:'auto' routes pump.fun curve, PumpSwap, Raydium and similar pools.
 *
 * Every function here only moves a transaction; what actually happened is read from the
 * chain afterwards (see src/solana/fills.js).
 */
const { VersionedTransaction } = require('@solana/web3.js');
const config = require('../config');
const { getConfig } = require('../live/liveConfig');
const { rpc, broadcast, signatureOf } = require('../solana/rpc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask PumpPortal for an unsigned swap tx. Nothing is sent. */
async function buildTx(wallet, body) {
  const res = await fetch(config.PUMPPORTAL_TRADE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: wallet.publicKey.toBase58(), pool: 'auto', ...body }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`pumpportal ${res.status}: ${text}`);
  }
  return VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
}

/** Current status of a signature: { ok:true } | { ok:false, onchain:true, err } | null (unknown yet) */
async function statusOf(signature) {
  const res = await rpc((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }));
  const st = res.value[0];
  if (!st) return null;
  if (st.err) return { ok: false, onchain: true, err: st.err };
  if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { ok: true };
  return null;
}

/**
 * Sign, send (and keep re-sending) until the chain says confirmed or failed.
 * Throws an Error carrying .signature. .onchainError=true means it landed and FAILED.
 * .timedOut=true means we do not know yet: the tx might still land.
 */
async function landTx(tx, wallet, timeoutMs) {
  tx.sign([wallet]);
  const raw = tx.serialize();
  const signature = signatureOf(tx);
  try {
    await broadcast(raw);
  } catch (e) {
    const err = new Error(`send failed: ${e.message}`);
    err.signature = signature;
    err.notSent = true;
    throw err;
  }

  const started = Date.now();
  let lastSend = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    try {
      const st = await statusOf(signature);
      if (st && st.ok) return signature;
      if (st && !st.ok) {
        const err = new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
        err.signature = signature;
        err.onchainError = true;
        throw err;
      }
    } catch (e) {
      if (e.onchainError) throw e;
    }
    if (Date.now() - lastSend >= config.REBROADCAST_MS) {
      lastSend = Date.now();
      broadcast(raw).catch(() => {});
    }
  }
  const err = new Error(`not confirmed within ${Math.round(timeoutMs / 1000)}s (${signature})`);
  err.signature = signature;
  err.timedOut = true;
  throw err;
}

/**
 * After a timeout: a Solana tx is only valid ~60-90s, so keep checking for up to maxMs.
 * Returns { ok:true } | { ok:false, reason }.
 */
async function waitForSignature(signature, maxMs = 75000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const st = await statusOf(signature);
      if (st && st.ok) return { ok: true };
      if (st && !st.ok) return { ok: false, reason: `failed on-chain ${JSON.stringify(st.err)}` };
    } catch (_) {}
    await sleep(1500);
  }
  return { ok: false, reason: 'never landed (tx expired)' };
}

const solAmount = (sol) => Number(Number(sol).toFixed(6));

/** Buy `sol` SOL worth of `mint`. Resolves to the confirmed signature. */
async function buy(wallet, mint, sol) {
  const tx = await buildTx(wallet, {
    action: 'buy',
    mint,
    amount: solAmount(sol),
    denominatedInSol: 'true',
    slippage: getConfig().buySlippagePct,
    priorityFee: getConfig().buyPriorityFeeSol,
  });
  return landTx(tx, wallet, config.BUY_CONFIRM_TIMEOUT_MS);
}

function sellParams(attempt = 1) {
  const c = getConfig(); // your live Telegram settings
  return {
    slippage: Math.min(c.sellSlippagePct + config.SELL_SLIPPAGE_STEP_PCT * (attempt - 1), c.sellSlippageMaxPct),
    priorityFee: Number((c.sellPriorityFeeSol * attempt).toFixed(6)),
  };
}

/** Sell 100% of the wallet's balance of `mint` (PumpPortal reads the balance when it builds). */
async function sellAll(wallet, mint, attempt = 1) {
  const p = sellParams(attempt);
  const tx = await buildTx(wallet, {
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: 'false',
    slippage: p.slippage,
    priorityFee: p.priorityFee,
  });
  return landTx(tx, wallet, config.SELL_CONFIRM_TIMEOUT_MS);
}

async function routeCheck(wallet, mint, sol) {
  await buildTx(wallet, {
    action: 'buy',
    mint,
    amount: solAmount(sol),
    denominatedInSol: 'true',
    slippage: getConfig().buySlippagePct,
    priorityFee: getConfig().buyPriorityFeeSol,
  });
  return true;
}

module.exports = { buildTx, landTx, waitForSignature, statusOf, buy, sellAll, sellParams, routeCheck };
