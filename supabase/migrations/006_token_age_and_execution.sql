-- Migration 006 — token-age filter + execution settings. Run once in the Supabase SQL editor (safe to re-run).
-- Without it these settings still work from Telegram but reset on restart.
alter table bot_config add column if not exists min_age_sec numeric not null default 2;
alter table bot_config add column if not exists max_age_days numeric not null default 20;
alter table bot_config drop constraint if exists bot_config_min_age_sec_check;
alter table bot_config add constraint bot_config_min_age_sec_check check (min_age_sec >= 0 and min_age_sec <= 60);
alter table bot_config drop constraint if exists bot_config_max_age_days_check;
alter table bot_config add constraint bot_config_max_age_days_check check (max_age_days > 0 and max_age_days <= 20);

-- Execution settings (were .env-only; now editable live in Telegram → Execution)
alter table bot_config add column if not exists max_positions integer not null default 1;
alter table bot_config add column if not exists bsc_max_positions integer not null default 1;
alter table bot_config add column if not exists slippage_pct numeric not null default 25;
alter table bot_config add column if not exists exit_slippage_pct numeric not null default 25;
alter table bot_config add column if not exists bsc_slippage_pct numeric not null default 7;
alter table bot_config add column if not exists priority_fee_lamports numeric not null default 100000;
alter table bot_config add column if not exists entry_cooldown_sec numeric not null default 15;
