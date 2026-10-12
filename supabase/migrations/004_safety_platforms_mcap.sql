-- Migration 004: safety toggles, launchpad switches, market-cap & holder gates.
-- Run once in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS).
-- Until run: Telegram still works; values live in memory and reset on restart.

-- DexScreener / entry quality
alter table bot_config add column if not exists min_market_cap_usd numeric not null default 0;  -- 0 = off

-- Holder concentration (0 = off)
alter table bot_config add column if not exists max_single_holder_percent numeric not null default 0;
alter table bot_config add column if not exists max_high_ownership_percent numeric not null default 0;

-- Safety toggles (true = block; false = allow)
alter table bot_config add column if not exists block_mint_authority boolean not null default false;
alter table bot_config add column if not exists block_creator_rug boolean not null default false;

-- Solana launchpad subscriptions (true = listen)
alter table bot_config add column if not exists launchpad_pumpfun boolean not null default true;
alter table bot_config add column if not exists launchpad_launchlab boolean not null default true;
alter table bot_config add column if not exists launchpad_meteora boolean not null default true;
alter table bot_config add column if not exists launchpad_moonshot boolean not null default true;
alter table bot_config add column if not exists launchpad_boop boolean not null default true;
