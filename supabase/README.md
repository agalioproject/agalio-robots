# Supabase setup (copy into any new project)

## New project (recommended)
1. Create a Supabase project.
2. SQL Editor → paste and run **`schema.sql`** (full schema in one shot).
3. Project Settings → API → copy `URL` and `service_role` key into the bot env:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
4. (Optional) Database → Replication → enable realtime for `bot_config`, `assessments`, `positions`.

## Existing project that already has older tables
Run migrations in order if not already applied:
1. `migrations/002_exit_and_scanner_settings.sql`
2. `migrations/003_medium_filters_and_tax.sql`
3. `migrations/004_safety_platforms_mcap.sql`

All migrations use `IF NOT EXISTS` / safe defaults and can be re-run.

## What Telegram persists
After migrations, these survive restarts: capital, filters, exit TP/SL/hold, risk score, market cap, holder gates, mint/rug toggles, launchpad on/off, chain enable, pause.
