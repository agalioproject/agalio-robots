/**
 * Self-learning trade memory.
 * Logs closed trades to Supabase trade_log; builds review + actionable advice.
 */
const config = require('../config');
const logger = require('../utils/logger');
const store = require('../storage/positionsStore');

const usingSupabase = () => !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY);

function headers(extra = {}) {
  const key = config.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key && key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function logTrade(row) {
  if (!usingSupabase()) return false;
  try {
    const body = {
      mode: config.DRY_RUN ? 'paper' : 'live',
      profile: row.profile || null,
      mint: row.mint,
      entry_reason: row.entryReason || null,
      exit_reason: row.exitReason || null,
      cost_sol: row.costSol ?? null,
      proceeds_sol: row.proceedsSol ?? null,
      realized_sol: row.realizedSol ?? null,
      pct: row.pct ?? null,
      hold_sec: row.holdSec ?? null,
      age_days: row.ageDays ?? null,
      liquidity_usd: row.liquidityUsd ?? null,
      volume_1h: row.volume1h ?? null,
      price_change_1h: row.priceChange1h ?? null,
      price_change_6h: row.priceChange6h ?? null,
      buys_1h: row.buys1h ?? null,
      score: row.score ?? null,
      size_usd: row.sizeUsd ?? null,
      take_profit_pct: row.takeProfitPct ?? null,
      stop_loss_pct: row.stopLossPct ?? null,
      max_hold_min: row.maxHoldMin ?? null,
      buy_sig: row.buySig || null,
      sell_sig: row.sellSig || null,
      meta: row.meta || {},
    };
    const res = await fetch(`${config.SUPABASE_URL}/rest/v1/trade_log`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn('trade_log insert failed:', res.status, (await res.text()).slice(0, 150));
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('trade_log insert error:', e.message);
    return false;
  }
}

async function fetchTrades({ limit = 150, days = 30 } = {}) {
  if (!usingSupabase()) return [];
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const url =
      `${config.SUPABASE_URL}/rest/v1/trade_log?` +
      `select=*&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=${limit}`;
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      logger.warn('trade_log fetch failed:', res.status);
      return [];
    }
    return await res.json();
  } catch (e) {
    logger.warn('trade_log fetch error:', e.message);
    return [];
  }
}

function avg(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((s, n) => s + n, 0) / a.length;
}

function buildAdvice(rows) {
  if (!rows.length) {
    return {
      summary: 'No trade history yet. Close trades so the bot can learn.',
      tips: ['Keep Medium until you have ≥10 closed trades with known PnL.'],
      stats: {},
      suggestion: null,
    };
  }

  const norm = rows.map((r) => ({
    realized: Number(r.realized_sol ?? r.realizedSol),
    pct: Number(r.pct),
    profile: r.profile || 'unknown',
    exit: r.exit_reason || r.exitReason || '?',
    age: Number(r.age_days ?? r.ageDays),
    liq: Number(r.liquidity_usd ?? r.liquidityUsd),
    ch1h: Number(r.price_change_1h ?? r.priceChange1h),
    score: Number(r.score),
    hold: Number(r.hold_sec ?? r.holdSec),
    sizeUsd: Number(r.size_usd ?? r.sizeUsd),
  }));

  const known = norm.filter((r) => Number.isFinite(r.realized));
  const weighted = known.map((r, i) => ({ ...r, w: i < known.length / 3 ? 2 : 1 }));
  const wins = known.filter((r) => r.realized > 0);
  const wr = known.length ? (wins.length / known.length) * 100 : null;
  const avgR = avg(known.map((r) => r.realized));
  const avgPct = avg(known.map((r) => r.pct).filter(Number.isFinite));

  const byProfile = {};
  for (const r of weighted) {
    const k = r.profile || 'unknown';
    if (!byProfile[k]) byProfile[k] = { n: 0, wins: 0, sum: 0, wsum: 0 };
    byProfile[k].n += 1;
    byProfile[k].wsum += r.w;
    if (r.realized > 0) byProfile[k].wins += 1;
    byProfile[k].sum += r.realized * r.w;
  }

  const byExit = {};
  for (const r of known) {
    const k = r.exit || '?';
    if (!byExit[k]) byExit[k] = { n: 0, wins: 0, sum: 0 };
    byExit[k].n += 1;
    if (r.realized > 0) byExit[k].wins += 1;
    byExit[k].sum += r.realized;
  }

  const bucketize = (list, key, buckets) =>
    buckets.map((b) => {
      const set = list.filter((r) => Number.isFinite(r[key]) && r[key] >= b.min && r[key] < b.max);
      return {
        name: b.name,
        n: set.length,
        wr: set.length ? (set.filter((r) => r.realized > 0).length / set.length) * 100 : null,
        avg: avg(set.map((r) => r.realized)),
      };
    });

  const ageStats = bucketize(known, 'age', [
    { name: '10–20d', min: 10, max: 20 },
    { name: '20–40d', min: 20, max: 40 },
    { name: '40d+', min: 40, max: 9999 },
  ]);
  const momStats = bucketize(known, 'ch1h', [
    { name: 'ch1h 0–5%', min: 0, max: 5 },
    { name: 'ch1h 5–15%', min: 5, max: 15 },
    { name: 'ch1h 15%+', min: 15, max: 999 },
  ]);
  const liqStats = bucketize(known, 'liq', [
    { name: 'liq $8k–20k', min: 8000, max: 20000 },
    { name: 'liq $20k–50k', min: 20000, max: 50000 },
    { name: 'liq $50k+', min: 50000, max: 1e12 },
  ]);

  const tips = [];
  let suggestion = null;

  const profRank = Object.entries(byProfile)
    .filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].sum / b[1].wsum - a[1].sum / a[1].wsum);
  if (profRank.length) {
    const [best, v] = profRank[0];
    const avgBest = v.sum / v.wsum;
    tips.push(
      `Best profile: "${best}" (${avgBest >= 0 ? '+' : ''}${avgBest.toFixed(4)} SOL/trade weighted, n=${v.n}, WR ${((v.wins / v.n) * 100).toFixed(0)}%).`
    );
    if (['easy', 'medium', 'hard'].includes(best)) suggestion = { type: 'preset', value: best };
  }

  for (const [label, stats] of [
    ['age', ageStats],
    ['momentum', momStats],
    ['liquidity', liqStats],
  ]) {
    const best = stats.filter((a) => a.n >= 2 && a.wr != null).sort((a, b) => (b.avg || 0) - (a.avg || 0))[0];
    if (best) tips.push(`Best ${label}: ${best.name} (WR ${best.wr.toFixed(0)}%, n=${best.n}).`);
  }

  const stop = byExit['stop_loss'];
  const tp = byExit['take_profit'];
  if (stop && stop.n >= 3) tips.push(`Stops hit ${stop.n}× — tighten entries or widen SL slightly.`);
  if (tp && stop && stop.n > tp.n * 2) tips.push('Stops outnumber TPs — cut size or raise filter bar.');
  if (wr != null && wr < 40 && known.length >= 5) tips.push('Win rate <40% — cut size, prefer Medium.');
  if (wr != null && wr >= 55 && known.length >= 8) tips.push('Solid WR — scale size only after more green trades.');
  if (!tips.length) tips.push('Need 15–20 closed trades for sharper advice.');

  return {
    summary: known.length
      ? `${known.length} closed · WR ${wr != null ? wr.toFixed(0) + '%' : '?'} · avg ${avgR != null ? (avgR >= 0 ? '+' : '') + avgR.toFixed(4) + ' SOL' : '?'}`
      : 'No trades with known PnL yet.',
    tips,
    stats: { n: known.length, wins: wins.length, wr, avgR, avgPct, byProfile, byExit, ageStats, momStats, liqStats },
    suggestion,
  };
}

function formatReview(advice, label = 'DAILY REVIEW') {
  const lines = [`📚 ${label}`, advice.summary, ''];
  const { stats } = advice;
  if (stats.byProfile && Object.keys(stats.byProfile).length) {
    lines.push('By profile:');
    for (const [k, v] of Object.entries(stats.byProfile)) {
      lines.push(`  ${k}: n=${v.n} WR=${((v.wins / v.n) * 100).toFixed(0)}%`);
    }
    lines.push('');
  }
  for (const [title, arr] of [
    ['By age', stats.ageStats],
    ['By ch1h', stats.momStats],
    ['By liquidity', stats.liqStats],
  ]) {
    if (!arr) continue;
    lines.push(title + ':');
    for (const a of arr) {
      if (!a.n) continue;
      lines.push(`  ${a.name}: n=${a.n} WR=${a.wr != null ? a.wr.toFixed(0) + '%' : '?'}`);
    }
    lines.push('');
  }
  lines.push('Advice:');
  advice.tips.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  if (advice.suggestion && advice.suggestion.type === 'preset') {
    lines.push('', `💡 Suggested mode: ${advice.suggestion.value}`);
  }
  return lines.join('\n');
}

async function review({ days = 7 } = {}) {
  const rows = await fetchTrades({ limit: 150, days });
  let local = [];
  try {
    const h = await store.get('state', 'history');
    if (Array.isArray(h)) local = h;
  } catch (_) {}
  const merged = rows.length
    ? rows
    : local.map((h) => ({
        realized_sol: h.realizedSol,
        pct: h.pct,
        profile: h.mode,
        exit_reason: h.reason,
        mint: h.mint,
        hold_sec: h.closedAt && h.openedAt ? Math.round((h.closedAt - h.openedAt) / 1000) : null,
        age_days: h.ageDays,
        liquidity_usd: h.liquidityUsd,
        volume_1h: h.volume1h,
        price_change_1h: h.priceChange1h,
        score: h.score,
        size_usd: h.sizeUsd,
      }));
  const advice = buildAdvice(merged);
  return {
    advice,
    text: formatReview(advice, days <= 2 ? 'DAILY REVIEW' : `${days}-DAY REVIEW`),
    n: merged.length,
  };
}

async function advice() {
  const { advice: a, text, n } = await review({ days: 30 });
  return { advice: a, text: text.replace('30-DAY REVIEW', 'ADVICE FROM YOUR TRADES'), n };
}

module.exports = { logTrade, fetchTrades, buildAdvice, formatReview, review, advice };
