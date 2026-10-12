-- Migration 005 — run ONCE in the Supabase SQL editor. Safe to re-run.
-- Until you run it the bot still works: the new settings apply from Telegram
-- but live in memory only (they reset on restart), and /status says so.
--
-- 1. Risk tier "ANY" (buy every tier that survives the hard rejects).
-- 2. Learning mode settings.
-- 3. trade_outcomes table (what Learning learns from; survives redeploys).
-- 4. Makes the positions / assessments tables match what the engine actually
--    writes (the old schema.sql used different column names, so the dashboard
--    history could silently stay empty).

-- 1) tier -----------------------------------------------------------------
alter table bot_config drop constraint if exists bot_config_min_recommend_tier_check;
alter table bot_config add constraint bot_config_min_recommend_tier_check
  check (min_recommend_tier in ('LOW', 'LOW_MEDIUM', 'ANY'));

-- 2) learning -------------------------------------------------------------
alter table bot_config add column if not exists learning_mode text not null default 'suggest';
alter table bot_config drop constraint if exists bot_config_learning_mode_check;
alter table bot_config add constraint bot_config_learning_mode_check check (learning_mode in ('off', 'suggest', 'auto'));
alter table bot_config add column if not exists learning_min_trades integer not null default 20;

-- 3) learning data --------------------------------------------------------
create table if not exists trade_outcomes (
  id bigserial primary key,
  chain text not null,
  tier text,
  score numeric,
  category text,
  dev_percent numeric,
  top10_percent numeric,
  pnl_pct numeric not null,
  exit_reason text,
  held_ms bigint,
  peak_pnl_pct numeric,
  peak_at_ms bigint,
  dry_run boolean not null default false,
  closed_at timestamptz not null default now()
);
create index if not exists trade_outcomes_closed_at_idx on trade_outcomes (closed_at desc);

-- 4) tables the engine writes to -------------------------------------------
alter table positions add column if not exists address text;
alter table positions add column if not exists dry_run boolean;
alter table positions add column if not exists entry_tx text;
alter table positions add column if not exists exit_tx text;
alter table positions add column if not exists exit_reason text;
alter table positions add column if not exists pnl_pct numeric;
alter table positions add column if not exists pnl_native numeric;
alter table positions add column if not exists closed_at timestamptz;

alter table assessments add column if not exists verdict text;
alter table assessments add column if not exists category text;
alter table assessments add column if not exists is_community_coin boolean;
alter table assessments add column if not exists dev_percent numeric;
alter table assessments add column if not exists top10_percent numeric;
alter table assessments add column if not exists curve_progress_pct numeric;
alter table assessments add column if not exists migrated boolean;
alter table assessments add column if not exists exit_plan jsonb;

-- Old column names from the previous schema.sql must not block inserts.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'positions' and column_name = 'mint') then
    alter table positions alter column mint drop not null;
  end if;
end $$;
