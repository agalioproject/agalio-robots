import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabaseServer';

const ALLOWED_FIELDS = [
  'paused',
  'enable_solana',
  'enable_bsc',
  'min_recommend_tier',
  'max_tokens_per_day',
  'max_dev_percent',
  'max_top10_percent',
  'capital_pct',
  'max_position_sol',
  'bsc_capital_pct',
  'bsc_max_position_bnb',
  'take_profit_pct',
  'stop_loss_pct',
  'max_hold_min',
  'max_risk_score',
  'medium_max_dev_percent',
  'medium_max_top10_percent',
  'medium_max_score',
  'max_buy_tax_pct',
  'max_sell_tax_pct',
  'max_positions',
  'bsc_max_positions',
  'slippage_pct',
  'exit_slippage_pct',
  'bsc_slippage_pct',
  'priority_fee_lamports',
  'entry_cooldown_sec',
  'min_age_sec',
  'max_age_days',
  'learning_mode',
  'learning_min_trades',
];

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in body) updates[key] = body[key];
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields in request.' }, { status: 400 });
    }

    // Sanity-check the sizing fields (capital % is free between 0.01 and 100;
    // the per-trade caps accept 0 meaning "no cap").
    const RANGES = {
      capital_pct: [0.01, 100],
      bsc_capital_pct: [0.01, 100],
      max_position_sol: [0, 100000],
      bsc_max_position_bnb: [0, 100000],
      take_profit_pct: [0, 10000],
      stop_loss_pct: [0, 99],
      max_hold_min: [0, 1440],
      max_risk_score: [1, 100],
      learning_min_trades: [5, 500],
      min_age_sec: [0, 60],
      max_positions: [1, 10],
      bsc_max_positions: [1, 10],
      slippage_pct: [1, 50],
      exit_slippage_pct: [1, 50],
      bsc_slippage_pct: [0.1, 49],
      priority_fee_lamports: [0, 5000000],
      entry_cooldown_sec: [0, 300],
      max_age_days: [0.01, 20],
      medium_max_dev_percent: [1, 100],
      medium_max_top10_percent: [1, 100],
      medium_max_score: [1, 100],
      max_buy_tax_pct: [0, 100],
      max_sell_tax_pct: [0, 100],
    };
    for (const [key, [lo, hi]] of Object.entries(RANGES)) {
      if (key in updates) {
        const n = Number(updates[key]);
        if (!Number.isFinite(n) || n < lo || n > hi) {
          return NextResponse.json({ error: `${key} must be a number between ${lo} and ${hi}.` }, { status: 400 });
        }
        updates[key] = n;
      }
    }
    if ('min_recommend_tier' in updates && !['LOW', 'LOW_MEDIUM', 'ANY'].includes(updates.min_recommend_tier)) {
      return NextResponse.json({ error: 'min_recommend_tier must be LOW, LOW_MEDIUM or ANY.' }, { status: 400 });
    }
    if ('learning_mode' in updates && !['off', 'suggest', 'auto'].includes(updates.learning_mode)) {
      return NextResponse.json({ error: 'learning_mode must be off, suggest or auto.' }, { status: 400 });
    }
    updates.updated_by = 'dashboard';

    const supabase = getSupabase();
    const { error } = await supabase.from('bot_config').update(updates).eq('id', 1);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
