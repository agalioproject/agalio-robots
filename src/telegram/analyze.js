/**
 * On-demand CA analysis for Telegram: paste a mint/address → full risk +
 * DexScreener snapshot + safe/unsafe + suggested entry levels.
 */
const { assessAndGate } = require('../analysis/riskEngine');
const { getTokenMarket } = require('../analysis/dexscreener');
const tokenAge = require('../analysis/tokenAge');
const { getConfig } = require('../live/liveConfig');
const { resolveExit } = require('../trading/exitRules');

const SOL_CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_CA_RE = /^0x[a-fA-F0-9]{40}$/;

function detectChain(address) {
  if (EVM_CA_RE.test(address)) return 'bsc';
  if (SOL_CA_RE.test(address)) return 'solana';
  return null;
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

/**
 * Full analysis report (plain text for Telegram).
 */
async function analyzeAddress(raw) {
  const address = String(raw || '').trim();
  const chain = detectChain(address);
  if (!chain) {
    return {
      ok: false,
      text:
        'Could not parse that as a Solana mint or EVM address.\n' +
        'Paste a full contract address (Solana base58 or 0x…).',
    };
  }

  const cfg = getConfig();
  const minMc = Number(cfg.minMarketCapUsd ?? 0);

  // Market data first (fast context even if risk engine is slow)
  let mkt = null;
  try {
    mkt = await getTokenMarket(address);
  } catch (_) {
    mkt = null;
  }

  // Full risk assessment — do NOT consume a daily trade slot
  let assessment;
  try {
    assessment = await assessAndGate({
      chain,
      address,
      consumeSlot: false,
      requireSellable: false,
    });
  } catch (err) {
    return {
      ok: false,
      text: `Analysis failed for ${address}:\n${err.message}`,
    };
  }

  const exit = resolveExit(assessment.exit, cfg);
  const safe =
    assessment.tradeable &&
    !assessment.pendingGraduation &&
    (assessment.blockedBy == null || assessment.blockedBy === 'paused');

  // Entry suggestion: only when tradeable and MC gate would pass
  const mc = mkt?.marketCapUsd ?? assessment.marketCapUsd ?? 0;
  const mcOk = minMc <= 0 || mc >= minMc;
  const age = await tokenAge.checkAge(address, cfg, { allowLookup: true });
  const ageOk = age.ok;
  // Same gate the live bot uses (tier, score, dev/top-10 limits), so /analyze never disagrees with a real entry.
  const wouldEnter = Boolean(assessment.gatePassed) && !assessment.pendingGraduation && mcOk && ageOk;

  const lines = [];
  lines.push(safe || wouldEnter ? '✅ ANALYSIS' : '⚠️ ANALYSIS');
  lines.push(`${chain === 'solana' ? '🟣 Solana' : '🟡 BSC'} · \`${address}\``);
  if (mkt?.baseTokenName || mkt?.baseTokenSymbol) {
    lines.push(`${mkt.baseTokenName || ''} ${mkt.baseTokenSymbol ? `($${mkt.baseTokenSymbol})` : ''}`.trim());
  }
  lines.push('');

  // Verdict
  lines.push(`Verdict: *${assessment.verdict || '—'}* · score ${assessment.score}`);
  if (assessment.pendingGraduation) lines.push('Status: pending graduation (curve not migrated yet)');
  if (assessment.category) lines.push(`Category: ${assessment.category}`);
  if (assessment.migrated != null) lines.push(`Migrated: ${assessment.migrated ? 'yes' : 'no'}`);
  if (assessment.curveProgressPct != null) {
    lines.push(`Curve progress: ~${assessment.curveProgressPct.toFixed(0)}%`);
  }
  lines.push('');

  // Market
  lines.push('*Market (DexScreener)*');
  if (mkt) {
    lines.push(`MC ${fmtUsd(mkt.marketCapUsd)} · Liq ${fmtUsd(mkt.liquidityUsd)} · Vol 24h ${fmtUsd(mkt.volume24h)}`);
    lines.push(`Δ 5m ${fmtPct(mkt.priceChange5m)} · 1h ${fmtPct(mkt.priceChange1h)} · 24h ${fmtPct(mkt.priceChange24h)}`);
    if (mkt.pairUrl) lines.push(mkt.pairUrl);
  } else {
    lines.push('No DexScreener pair yet (very early / not indexed).');
  }
  lines.push(`Your min MC gate: ${fmtUsd(minMc)}${mcOk ? ' ✅' : ' ❌ below floor'}`);
  lines.push(
    age.ageMs == null
      ? `Age: unknown (not indexed yet) · your window ${cfg.minAgeSec}s – ${cfg.maxAgeDays} days`
      : `Age: ${tokenAge.fmtAge(age.ageMs)} · your window ${cfg.minAgeSec}s – ${cfg.maxAgeDays} days${ageOk ? ' ✅' : ' ❌ too old'}`
  );
  lines.push('');

  // Holdings / risk flags
  lines.push('*Holdings / flags*');
  if (assessment.devPercent != null) lines.push(`Dev/creator: ${assessment.devPercent.toFixed(1)}%`);
  if (assessment.top10Percent != null) lines.push(`Top-10: ${assessment.top10Percent.toFixed(1)}%`);
  if (assessment.isCommunityCoin) lines.push('Looks community-distributed');
  if (assessment.reasons && assessment.reasons.length) {
    for (const r of assessment.reasons.slice(0, 8)) lines.push(`• ${r}`);
  }
  lines.push('');

  // Entry suggestion
  lines.push('*Entry suggestion*');
  if (wouldEnter) {
    lines.push('Bot would consider this *tradeable* under current filters.');
    lines.push(
      `Suggested size: ~${cfg.capitalPct}% of wallet` +
        (chain === 'solana' && cfg.maxPositionSol > 0 ? ` (cap ${cfg.maxPositionSol} SOL)` : '')
    );
    lines.push(
      `Exit plan: TP +${exit.takeProfitPct}% · SL ${exit.stopLossPct}% · max hold ${(exit.maxHoldMs / 60000).toFixed(0)}m`
    );
    if (mkt && mkt.priceNative > 0) {
      lines.push(`Ref price: ${mkt.priceNative} native · ${mkt.priceUsd ? '$' + mkt.priceUsd : ''}`);
    }
  } else if (assessment.pendingGraduation) {
    lines.push('Not enterable yet — wait for migration / real pool.');
    lines.push(`When live, plan: TP +${exit.takeProfitPct}% · SL ${exit.stopLossPct}%`);
  } else {
    lines.push('Not recommended for auto-entry under current filters.');
    if (assessment.blockedBy) lines.push(`Blocked by: ${assessment.blockedBy}`);
    lines.push(`If you still trade manually, use tight risk: TP +${exit.takeProfitPct}% · SL ${exit.stopLossPct}%`);
  }

  lines.push('');
  lines.push('_Not financial advice. Memes can go to zero._');

  return { ok: true, text: lines.join('\n'), assessment, mkt };
}

module.exports = { analyzeAddress, detectChain, SOL_CA_RE, EVM_CA_RE };
