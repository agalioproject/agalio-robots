# Changelog

## v3.4.0 — Settings that are actually respected

**Fixed**
- Custom values were ignored in several places: custom plans silently used the *Medium* scanner bars; a hidden SOL cap (`maxPositionSol`) silently shrank a typed trade size; typed values were silently clamped (e.g. 500 became 90); `capitalPct` was never used. Every setting is now defined once (`src/live/settings.js`), validated (out-of-range is rejected with the range) and used by the scanner **and** the entry gate.
- Saved settings were loaded without waiting, so the first scan after a restart could run on defaults.
- Slippage, fees, max open positions, daily loss limit and the authority switch were `.env`-only; they are now live settings.
- README listed commands that did not exist (`/risk`, `/pnl`, `/sellall`, `/pause`, `/resume`, `/balance`…); they exist now.
- `npm test` / `npm run check` pointed at files that were not in the repo.

**Added**
- Coin-age window: min 2 seconds … max 20 days, typed with units (`2s`, `15m`, `6h`, `10d`).
- Entry filters in Settings: liquidity, 1h volume, buys, buy/sell ratio, rising rule, 5m/24h drop limits, authority block.
- Typing works the moment a setting is open; `/set <name> <value>`; `/plan`; **✅ Apply & run** starts the bot and scans immediately.
- Learning mode (Off / Suggest / Auto) that tunes take-profit, max hold and entry filters from your own trades, with bounded steps and notifications.
- Last-scan rejection stats in the Report (why nothing was bought).
- 40 offline tests.

**Removed**
- Dead whale-detection / old-strategy config (`WHALE_*`, `DIP_ENTRY_PCT`, `MIN_WHALE_*`, `MIGRATE_POLL_MS`, `CAPITAL_PCT`, duplicate TP/SL/hold env keys, `MIN_LIQUIDITY_USD`).
- Menu: separate PnL and Advice buttons (merged into Report and Learning).

## v3.2.0 — Self-learning trade memory

- New Supabase table `trade_log` stores every closed trade with entry features.
- Telegram: `/review`, `/advice`.

## v3.1.0 — Filters + Custom Entry

- Scanner: age ≥ 10d + rising + activity filters.

## v3.0.0 — Direct Scanner

- Direct scanner, fixed USD modes, real chain fills.
