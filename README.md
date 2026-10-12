# De-Government Strategy v3.4 — Direct Scanner

Solana meme-coin trader: **direct token scan + fixed-size real execution via PumpPortal**.
Free swaps through the PumpPortal local API, free public RPCs. Paper (dry-run) by default.

## Strategy

1. The scanner pulls recent Solana tokens (DexScreener boosts + profiles + search).
2. A token must pass **every entry filter in your settings** (see below). The same filters are checked again right before buying.
3. Buys via PumpPortal (`pool: auto`), reads the exact fill from the chain.
4. Sells the whole position on take-profit, stop-loss or max hold. Failed sells retry with more slippage and fee.
5. Positions persist (Supabase or local file). A restart resumes open trades.

## Control everything from Telegram

Open `/menu`. **Every number can be typed**: open a setting and just send a value (`12.5`, `150%`, `30s`, `6h`, `10d`, `off`) — no extra tap. Out-of-range values are rejected with the allowed range; nothing is silently clamped.

| Menu | What it controls |
|---|---|
| 🟢🟡🔴 Easy / Medium / Hard | One-tap presets (size, TP, SL, hold, scan interval, trades/day, SOL cap, age window, liquidity, volume, buys) |
| ⚙️ Settings → 💵 Trade | size $, max SOL per trade, take profit, stop loss, max hold, trades/day, max open positions, daily loss limit |
| ⚙️ Settings → 🔍 Entry filters | **coin age (min 2 s … max 20 days)**, min liquidity, min 1h volume, min buys, buy/sell ratio, "rising" rule, 5m / 24h drop limits, mint/freeze-authority block, scan interval |
| ⚙️ Settings → ⚙️ Execution | buy slippage, sell slippage (first try / max), buy & sell priority fee |
| 🧠 Learning | Off / Suggest / Auto — see below |
| 📋 Plan / ✅ Apply & run | exactly what the bot will do now; Apply starts the bot **and scans immediately** |
| 📁 Activity | Report (open, closed, today, why the last scan rejected coins), 7-day Review, Balance |

Commands: `/menu /plan /apply /set <name> <value> /report /review /learning /balance /pause /resume /sellall /risk easy|medium|hard /cancel`.
`/set` with no value lists every name, e.g. `/set tp 50`, `/set minage 2s`, `/set maxage 20d`, `/set liq 12000`.

Changes are live the moment you set them (open positions use a new TP/SL/hold immediately). **✅ Apply & run** additionally un-pauses the bot, runs a scan right away, and shows the plan it is now following.

### Entry filters

A coin is only bought if it is inside your age window **and** passes liquidity, volume, buys, buy/sell ratio, the "rising" rule (1h change above X **or** 6h change above Y — set both to −100 to turn it off), the 5-minute and 24-hour drop limits, and (optionally) has no mint/freeze authority. Age is the DexScreener pair-creation time; a coin whose age is unknown is skipped.

Easy / Medium / Hard keep the old behaviour by default: coins 10–20 days old. Lower **Min coin age** (down to 2 s) to include fresh launches.

### Learning mode

Learns from this bot's own closed trades (kept in the bot's own store — no extra table needed). After `Trades needed to learn` closed trades (default 20) it can suggest: take-profit (where trades actually peak), max hold (when they peak), and tighter entry filters (liquidity, volume, buys, buy/sell ratio, min age, max age) when everything below/above a value clearly loses.

- **Off** — nothing suggested or changed.
- **Suggest** (default) — shows suggestions; you tap *Apply suggestions*.
- **Auto** — every 10 new closed trades it applies suggestions in small steps (TP/hold ±30%, filters half-way) and messages you what changed.

It never touches size, SOL cap, max open, daily loss, slippage/fees, stop loss, the authority switch, scan interval, trades/day or your preset. A few dozen trades is a small sample — treat suggestions as hints; run Auto in paper mode first.

## Quick start

```bash
cp .env.example .env
# set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# set WALLET_PRIVATE_KEY only when going live
npm install
npm start
npm test      # 40 offline tests
```

Go live: `DRY_RUN=false`, a dedicated wallet, small size first. On Railway add Supabase (`supabase.sql`, run once) so settings and positions survive redeploys.

`.env` values for the settings above are only the **starting point**; once you change something in Telegram, that wins.
