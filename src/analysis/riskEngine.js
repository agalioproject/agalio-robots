// Combines on-chain + GoPlus data into a single verdict per token:
// LOW / MEDIUM / HIGH / CRITICAL risk, a category (new / final_stretch /
// migrated / developing), a community-coin flag, and a suggested exit plan
// (take-profit / stop-loss / max hold time).
//
// Several thresholds here (max dev %, max top-10 %, minimum tier that
// counts as "recommended", daily quota) are read from live config
// (src/live/liveConfig.js) instead of being hardcoded, so they can be
// changed from Telegram/the dashboard without a redeploy. If Supabase
// isn't configured, liveConfig falls back to sane static defaults.
//
// This is a heuristic filter, not a guarantee. A "LOW risk" verdict means
// the obvious, checkable rug patterns weren't found right now — it does
// not mean the token can't still go to zero. Liquidity can be pulled,
// wallets can dump, and none of this replaces your own judgment.
const { getSolanaTokenSecurity, getEvmTokenSecurity } = require('./goplus');
const { getBondingCurveState, curveProgressPct } = require('./pumpfunCurve');
const { canSell } = require('../trading/safety');
const { tryConsumeDailySlot } = require('./dailyLimiter');
const { getConfig } = require('../live/liveConfig');
const debull = require('../knowledge/debull');
const { getTokenMarket } = require('./dexscreener');

const RISK_TIERS = [
  { max: 25, label: 'LOW' },
  { max: 50, label: 'MEDIUM' },
  { max: 75, label: 'HIGH' },
  { max: Infinity, label: 'CRITICAL' },
];

function tierFor(score) {
  return RISK_TIERS.find((t) => score <= t.max).label;
}

function reject(chain, address, reason) {
  return {
    chain,
    address,
    verdict: 'UNSAFE',
    tradeable: false,
    recommended: false,
    score: 100,
    reasons: [reason],
    category: null,
    isCommunityCoin: false,
    devPercent: null,
    top10Percent: null,
    curveProgressPct: null,
    migrated: null,
    exit: null,
  };
}


// Absolute holder-concentration gates (apply to every tier). 0 = off.
// The dev% / top-10% limits are tier-aware and applied in entryPolicyBlock().
function ownershipReject(chain, address, cfg, { top10Percent, holders }) {
  const maxHigh = Number(cfg.maxHighOwnershipPercent ?? 0);
  const maxSingle = Number(cfg.maxSingleHolderPercent ?? 0);

  if (maxHigh > 0 && top10Percent != null && top10Percent > maxHigh) {
    return reject(chain, address, `Top holders control ~${top10Percent.toFixed(1)}% of supply (your max ${maxHigh}%).`);
  }
  if (maxSingle > 0 && Array.isArray(holders) && holders.length) {
    for (const h of holders) {
      const tag = String(h.tag || h.account_address || '').toLowerCase();
      if (/bond|curve|pool|raydium|pump|dead|burn|locker/i.test(tag)) continue;
      const pctNorm = Number(h.percent || 0) <= 1.5 ? Number(h.percent || 0) * 100 : Number(h.percent || 0);
      if (pctNorm > maxSingle) {
        return reject(chain, address, `Single holder owns ~${pctNorm.toFixed(1)}% (your max ${maxSingle}%).`);
      }
    }
  }
  return null;
}

function creatorRugReject(chain, address, sec, cfg) {
  if (!cfg.blockCreatorRug) return null;
  if (!sec || typeof sec !== 'object') return null;
  const flags = [sec.creator_rugged, sec.creator_rug_history, sec.is_rug, sec.malicious_address, sec.creator_malicious, sec.known_scammer];
  for (const f of flags) {
    if (f === true || f === '1' || f === 1) {
      return reject(chain, address, 'Creator has a history of rugged / malicious tokens (toggle off in Telegram if you want to allow).');
    }
  }
  const c = sec.creator || sec.creator_info || {};
  if (c && (c.rugged === true || c.rugged === '1' || c.malicious === true || Number(c.rug_count || 0) > 0)) {
    return reject(chain, address, 'Creator history shows prior rugs (toggle off in Telegram if you want to allow).');
  }
  return null;
}


function finalize(input) {
  const tier = tierFor(input.score);
  // Hard rejects (freeze / honeypot / can't-sell / your absolute limits) already
  // returned above. Whether a given tier may be BOUGHT is decided by the live
  // settings in entryPolicyBlock(), not here.
  const tradeable = true;
  return {
    ...input,
    verdict: tier,
    tradeable,
    recommended: false, // set by assessAndGate once the live-config gate + daily quota are checked
    exit: debull.exitPlanFor(tier),
  };
}

// -------------------- Solana / pump.fun --------------------

// requireSellable=false (the default when the graduation watcher is on) lets
// a token that passes every OTHER check but isn't tradeable yet — because its
// pump.fun bonding curve hasn't migrated to a real DEX pool — come back as
// "pendingGraduation" instead of a hard reject. The caller then watches it
// and re-checks the instant it migrates, rather than throwing it away purely
// because Jupiter can't route to a bonding-curve-only token.
async function assessSolanaToken(mint, { requireSellable = true } = {}) {
  const cfg = getConfig();
  const reasons = [];
  let score = 0;

  let sec = null;
  try {
    sec = await getSolanaTokenSecurity(mint);
  } catch (err) {
    reasons.push(`GoPlus lookup failed (${err.message}) — scoring conservatively without it.`);
    score += 10;
  }

  let devPercent = null;
  let top10Percent = null;
  let lpBurnPercent = null;

  if (sec) {
    if (sec.freezable && sec.freezable.status === '1') {
      return reject('solana', mint, 'Freeze authority is still active — the creator can block anyone from trading at will.');
    }
    if (sec.mintable && sec.mintable.status === '1') {
      if (cfg.blockMintAuthority) {
        return reject('solana', mint, 'Mint authority still active — creator can print tokens (disable in Telegram → Safety if you want to allow).');
      }
      score += 25;
      reasons.push('Mint authority is still active — supply can be inflated after you buy.');
    }
    if (Array.isArray(sec.holders) && sec.holders.length) {
      top10Percent = sec.holders.reduce((sum, h) => sum + Number(h.percent || 0), 0) * 100;
      const creatorHolder = sec.holders.find((h) => /creator|deployer/i.test(h.tag || ''));
      if (creatorHolder) devPercent = Number(creatorHolder.percent || 0) * 100;
    }
    if (Array.isArray(sec.dex) && sec.dex.length) {
      lpBurnPercent = Math.max(...sec.dex.map((d) => Number(d.burn_percent || 0)));
    }
  }

  // Configurable safety (Telegram: Filters / Safety / Platforms)
  const rugBlock = creatorRugReject('solana', mint, sec, cfg);
  if (rugBlock) return rugBlock;
  const ownBlock = ownershipReject('solana', mint, cfg, {
    top10Percent,
    holders: sec && Array.isArray(sec.holders) ? sec.holders : null,
  });
  if (ownBlock) return ownBlock;

  if (devPercent != null) {
    score += Math.min(50, Math.floor(devPercent * 1.5));
    reasons.push(`Dev/creator wallet holds ~${devPercent.toFixed(1)}% of supply.`);
  } else {
    reasons.push('Could not confirm dev wallet holding % from available data.');
    score += 5;
  }

  if (top10Percent != null) {
    if (top10Percent > 20) score += Math.min(30, Math.floor((top10Percent - 20) * 0.6));
    reasons.push(`Top 10 holders control ~${top10Percent.toFixed(1)}% of supply.`);
  }

  const curveState = await getBondingCurveState(mint).catch(() => null);
  const progressPct = curveState ? curveProgressPct(curveState) : null;
  const migrated = curveState ? curveState.complete : null;

  if (lpBurnPercent != null && lpBurnPercent < 50 && !migrated) {
    score += 15;
    reasons.push(`Only ~${lpBurnPercent.toFixed(0)}% of LP is burned/locked.`);
  }

  let category = 'developing';
  if (migrated) {
    category = 'migrated';
  } else if (progressPct != null && progressPct >= 80) {
    category = 'final_stretch';
    score += 10;
    reasons.push(`Bonding curve ~${progressPct.toFixed(0)}% complete — close to Raydium migration; expect a volatility spike either way.`);
  } else if (progressPct != null && progressPct < 20) {
    category = 'new';
    reasons.push(`Very early — bonding curve only ~${progressPct.toFixed(0)}% complete, largely unproven.`);
  }

  const isCommunityCoin = devPercent != null && devPercent < 5 && (top10Percent == null || top10Percent < 40);
  if (isCommunityCoin) {
    reasons.push('Holdings look broadly distributed — reads as a community coin rather than a dev-controlled one.');
  }

  // DE-BULL: first pump / brand-new curve is often a trap; final stretch & migrated preferred.
  const catBonus = debull.categoryQualityBonus(category);
  if (catBonus !== 0) {
    score = Math.max(0, score + catBonus);
    if (catBonus > 0) reasons.push('DE-BULL: very new curve — first pump is often a trap (score +' + catBonus + ').');
    else reasons.push('DE-BULL: ' + category + ' preferred over brand-new launches (score ' + catBonus + ').');
  }

  // DexScreener market-cap gate (default $10k). Brand-new curve coins often
  // have no pair yet → treated as MC 0 → blocked until they clear the floor.
  let marketCapUsd = null;
  let liquidityUsd = null;
  const minMc = Number(cfg.minMarketCapUsd ?? 0);
  if (minMc > 0) {
    try {
      const mkt = await getTokenMarket(mint);
      if (mkt) {
        marketCapUsd = mkt.marketCapUsd;
        liquidityUsd = mkt.liquidityUsd;
        reasons.push(`DexScreener MC ~$${Math.round(marketCapUsd).toLocaleString()} · liq ~$${Math.round(liquidityUsd).toLocaleString()}.`);
      } else {
        marketCapUsd = 0;
        reasons.push('DexScreener has no pair yet — market cap treated as $0 (too early).');
      }
    } catch (err) {
      marketCapUsd = 0;
      reasons.push(`DexScreener lookup failed (${err.message}) — treating MC as $0.`);
    }
    if (marketCapUsd < minMc) {
      return reject(
        'solana',
        mint,
        `Market cap ~$${Math.round(marketCapUsd).toLocaleString()} is below your min $${minMc.toLocaleString()} (DexScreener). Wait until it clears $10k+.`
      );
    }
  }

  const finalized = finalize({
    chain: 'solana',
    address: mint,
    score,
    reasons,
    category,
    isCommunityCoin,
    devPercent,
    top10Percent,
    curveProgressPct: progressPct,
    migrated,
    marketCapUsd,
    liquidityUsd,
  });

  // Tier alone already disqualifies it (too risky) — migration status is
  // irrelevant, this is a real reject.
  if (!finalized.tradeable) return finalized;

  // A pre-migration token has no DEX route yet almost by definition, so
  // skip the wasted Jupiter call and go straight to "not sellable" — unless
  // the caller demands a definitive answer right now (requireSellable),
  // e.g. the graduation watcher's own final check.
  const sellable = migrated === false && !requireSellable ? false : await canSell(mint);

  if (sellable) return finalized;

  if (migrated === false && !requireSellable) {
    // Everything else about this token passed — it just isn't tradeable
    // yet because its bonding curve hasn't migrated to a real pool. Hand it
    // to the graduation watcher instead of discarding it.
    return {
      ...finalized,
      tradeable: false,
      pendingGraduation: true,
      reasons: [...finalized.reasons, 'No swap route yet — bonding curve has not migrated. Watching for graduation.'],
    };
  }

  return {
    ...finalized,
    tradeable: false,
    reasons: [
      ...finalized.reasons,
      migrated
        ? 'No sell route found even though the bonding curve shows migrated — could be a very fresh/illiquid pool, or a honeypot.'
        : 'No sell route found right now (possible honeypot or dead liquidity).',
    ],
  };
}

// -------------------- BNB Smart Chain / PancakeSwap --------------------

async function assessBscToken(address) {
  const cfg = getConfig();
  const reasons = [];
  let score = 0;

  let sec = null;
  try {
    sec = await getEvmTokenSecurity(address);
  } catch (err) {
    // Aggressive: missing GoPlus is a score penalty, not a hard reject.
    return finalize({
      chain: 'bsc',
      address,
      score: 60,
      reasons: [`GoPlus lookup failed (${err.message}) — trading without full security data.`],
      category: 'new',
      isCommunityCoin: false,
      devPercent: null,
      top10Percent: null,
      curveProgressPct: null,
      migrated: null,
    });
  }
  if (!sec) {
    return finalize({
      chain: 'bsc',
      address,
      score: 55,
      reasons: ['No security data available yet — trading as unverified early token.'],
      category: 'new',
      isCommunityCoin: false,
      devPercent: null,
      top10Percent: null,
      curveProgressPct: null,
      migrated: null,
    });
  }

  // Only hard-stop on true can't-sell / can't-buy. Everything else is scored and traded.
  if (sec.is_honeypot === '1') {
    return reject('bsc', address, 'Flagged as a honeypot by GoPlus (can buy, cannot sell).');
  }
  if (sec.cannot_sell_all === '1') {
    return reject('bsc', address, 'Contract can prevent holders from selling all of their tokens in one go.');
  }

  const buyTax = Number(sec.buy_tax || 0) * 100;
  const sellTax = Number(sec.sell_tax || 0) * 100;
  if (buyTax >= 100 || sellTax >= 100 || sec.cannot_buy === '1') {
    return reject('bsc', address, 'Cannot actually buy and/or sell this token right now.');
  }
  const maxBuyTax = Number(cfg.maxBuyTaxPct ?? 100);
  const maxSellTax = Number(cfg.maxSellTaxPct ?? 100);
  if (buyTax > maxBuyTax) {
    return reject('bsc', address, `Buy tax is ${buyTax.toFixed(1)}% (your max ${maxBuyTax}%).`);
  }
  if (sellTax > maxSellTax) {
    return reject('bsc', address, `Sell tax is ${sellTax.toFixed(1)}% (your max ${maxSellTax}%).`);
  }
  if (buyTax + sellTax > 10) {
    score += 15;
    reasons.push(`Combined buy+sell tax is ${(buyTax + sellTax).toFixed(1)}% — eats into any quick exit.`);
  }
  if (sec.is_open_source === '0') {
    score += 15;
    reasons.push('Contract is not verified/open-source.');
  }
  if (sec.selfdestruct === '1') {
    score += 25;
    reasons.push('Contract has a self-destruct function.');
  }

  const devPercent = sec.owner_percent != null && sec.owner_percent !== '' ? Number(sec.owner_percent) * 100 : null;
  if (devPercent != null) {
    score += Math.min(50, Math.floor(devPercent * 1.5));
    reasons.push(`Owner/dev wallet holds ~${devPercent.toFixed(1)}% of supply.`);
  } else {
    reasons.push('No confirmed owner address/holding — could mean renounced, could mean hidden.');
    score += 5;
  }

  const holders = Array.isArray(sec.holders) ? sec.holders : [];
  const top10Percent = holders.reduce((sum, h) => sum + Number(h.percent || 0), 0) * 100;
  if (top10Percent > 20) score += Math.min(30, Math.floor((top10Percent - 20) * 0.6));
  if (holders.length) reasons.push(`Top 10 holders control ~${top10Percent.toFixed(1)}% of supply.`);

  const rugBlock = creatorRugReject('bsc', address, sec, cfg);
  if (rugBlock) return rugBlock;
  const ownBlock = ownershipReject('bsc', address, cfg, { top10Percent, holders });
  if (ownBlock) return ownBlock;

  if (sec.is_mintable === '1') {
    if (cfg.blockMintAuthority) {
      return reject('bsc', address, 'Contract can mint new supply (disable mint-authority block in Telegram to allow).');
    }
    score += 25;
    reasons.push('Contract can mint new supply after launch.');
  }
  if (sec.hidden_owner === '1' || sec.can_take_back_ownership === '1') {
    score += 20;
    reasons.push('Ownership can be hidden or reclaimed — renounced ownership may not be real.');
  }

  const lpHolders = Array.isArray(sec.lp_holders) ? sec.lp_holders : [];
  const lpLockedPercent = lpHolders
    .filter((h) => Number(h.is_locked) === 1 || /burn/i.test(h.tag || ''))
    .reduce((sum, h) => sum + Number(h.percent || 0), 0) * 100;
  if (lpHolders.length && lpLockedPercent < 50) {
    score += 20;
    reasons.push(`Only ~${lpLockedPercent.toFixed(0)}% of LP is locked/burned.`);
  } else if (!lpHolders.length) {
    score += 10;
    reasons.push('No LP holder data available yet — liquidity depth unconfirmed.');
  }

  const holderCount = Number(sec.holder_count || 0);
  if (holderCount < 30) {
    score += 10;
    reasons.push(`Only ${holderCount || 'a handful of'} holders so far — very early.`);
  }

  const isCommunityCoin = devPercent != null && devPercent < 5 && top10Percent < 40;
  if (isCommunityCoin) {
    reasons.push('Holdings look broadly distributed — reads as a community coin rather than a dev-controlled one.');
  }

  let marketCapUsd = null;
  let liquidityUsd = null;
  const minMc = Number(cfg.minMarketCapUsd ?? 0);
  if (minMc > 0) {
    try {
      const mkt = await getTokenMarket(address);
      if (mkt) {
        marketCapUsd = mkt.marketCapUsd;
        liquidityUsd = mkt.liquidityUsd;
        reasons.push(`DexScreener MC ~$${Math.round(marketCapUsd).toLocaleString()} · liq ~$${Math.round(liquidityUsd).toLocaleString()}.`);
      } else {
        marketCapUsd = 0;
        reasons.push('DexScreener has no pair yet — market cap treated as $0 (too early).');
      }
    } catch (err) {
      marketCapUsd = 0;
      reasons.push(`DexScreener lookup failed (${err.message}) — treating MC as $0.`);
    }
    if (marketCapUsd < minMc) {
      return reject(
        'bsc',
        address,
        `Market cap ~$${Math.round(marketCapUsd).toLocaleString()} is below your min $${minMc.toLocaleString()} (DexScreener).`
      );
    }
  }

  return finalize({
    chain: 'bsc',
    address,
    score,
    reasons,
    category: 'new',
    isCommunityCoin,
    devPercent,
    top10Percent,
    curveProgressPct: null,
    migrated: null,
    marketCapUsd,
    liquidityUsd,
  });
}

// The ONE place your entry settings are enforced. Returns null if the token may
// be bought, otherwise { code, reason }.
//   - Risk tier setting: LOW only / LOW + MEDIUM / ANY tier
//   - Entry-quality ceiling (overall risk score)
//   - Dev % and top-10 % limits: LOW-tier tokens use the main limits, MEDIUM and
//     worse use the separate MEDIUM limits (plus the MEDIUM score ceiling)
function entryPolicyBlock(a, cfg) {
  const tier = a.verdict;
  const allowed = cfg.minRecommendTier === 'LOW' ? ['LOW'] : cfg.minRecommendTier === 'ANY' ? null : ['LOW', 'MEDIUM'];
  if (allowed && !allowed.includes(tier)) {
    return { code: 'tier', reason: `${tier} risk — your tier setting only allows ${allowed.join(' + ')}.` };
  }

  const maxScore = Number(cfg.maxRiskScore ?? 100);
  if (a.score > maxScore) {
    return { code: 'score', reason: `Risk score ${a.score} is above your entry limit of ${maxScore}.` };
  }

  const isLow = tier === 'LOW';
  const maxDev = Number(isLow ? cfg.maxDevPercent : cfg.mediumMaxDevPercent);
  const maxTop10 = Number(isLow ? cfg.maxTop10Percent : cfg.mediumMaxTop10Percent);
  const label = isLow ? 'your limit' : 'your MEDIUM limit';
  if (maxDev < 100 && a.devPercent != null && a.devPercent > maxDev) {
    return { code: 'holders', reason: `Creator/dev holds ~${a.devPercent.toFixed(1)}% (${label} ${maxDev}%).` };
  }
  if (maxTop10 < 100 && a.top10Percent != null && a.top10Percent > maxTop10) {
    return { code: 'holders', reason: `Top 10 holders control ~${a.top10Percent.toFixed(1)}% (${label} ${maxTop10}%).` };
  }
  if (!isLow && tier === 'MEDIUM' && a.score > Number(cfg.mediumMaxScore ?? 100)) {
    return { code: 'score', reason: `MEDIUM-tier score ${a.score} is above your MEDIUM ceiling of ${cfg.mediumMaxScore}.` };
  }
  return null;
}

// Applies the entry policy, then the "max N/day" gate, to an assessment that's
// ALREADY been produced. The graduation watcher reuses it for its re-check.
// Tokens still waiting on a bonding curve go through the SAME policy — they used
// to skip it, which is how they bypassed your score/tier/holder settings.
function gateAssessment(assessment, cfg, { consumeSlot = true } = {}) {
  if (!assessment.tradeable && !assessment.pendingGraduation) {
    assessment.blockedBy = 'unsafe';
    return assessment;
  }

  const blocked = entryPolicyBlock(assessment, cfg);
  if (blocked) {
    assessment.reasons.push(blocked.reason);
    assessment.blockedBy = blocked.code;
    assessment.recommended = false;
    assessment.pendingGraduation = false; // not worth watching — it fails your settings
    return assessment;
  }
  assessment.gatePassed = true;

  if (assessment.pendingGraduation) {
    assessment.blockedBy = 'pendingGraduation';
    return assessment;
  }

  // While paused (or the chain is off) the token is still fully assessed and
  // reported, but must NOT use up one of today's slots.
  if (!consumeSlot) {
    assessment.reasons.push('Passed every check, but trading is paused or this chain is off — not counted toward the daily limit.');
    assessment.blockedBy = 'paused';
    return assessment;
  }

  const gotSlot = tryConsumeDailySlot(cfg.maxTokensPerDay);
  assessment.recommended = gotSlot;
  if (!gotSlot) {
    assessment.reasons.push(`Passed the safety filter, but today's ${cfg.maxTokensPerDay}-token quota is already used.`);
    assessment.blockedBy = 'quota';
  }
  return assessment;
}

// Runs the full assessment then gates it. `requireSellable: false` (the
// default for Solana while the graduation watcher is enabled) lets tokens
// that only lack a swap route come back as "pendingGraduation" — still not
// tradeable now, but not a permanent reject either.
async function assessAndGate({ chain, address, consumeSlot = true, requireSellable = true }) {
  const cfg = getConfig();
  const assessment =
    chain === 'solana' ? await assessSolanaToken(address, { requireSellable }) : await assessBscToken(address);
  return gateAssessment(assessment, cfg, { consumeSlot });
}

module.exports = { assessSolanaToken, assessBscToken, assessAndGate, gateAssessment };
