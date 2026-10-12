# Telegram controls

Open `/menu`. Every number can be tapped (presets, −/+) or **typed** — open a setting and send a value.

| Menu | What it controls |
|---|---|
| 💰 Capital | % of balance per trade, max per trade (0 = no cap), per chain |
| 🎯 Exit rules | take profit / stop loss / max hold (0 = auto by risk tier); applies to open positions immediately |
| 🔍 Entry filters | risk tier (LOW / LOW+MEDIUM / Any), score ceiling, dev & top-10 %, MEDIUM+ limits, single holder, top holders, min market cap, mint & creator-rug blocks, BSC tax |
| 🧠 Learning | Off / Suggest / Auto; applies suggestions; reset learned data |
| 🚀 Platforms | which Solana launchpads to scan (pump.fun, LaunchLab, Meteora, Moonshot, Boop) |
| 📅 Daily limit | max tokens traded per UTC day |
| 📋 Active plan / ✅ Apply & start | shows exactly what the bot will do now; Apply also un-pauses |

Commands: `/menu /plan /apply /positions /balance /scanner /learning /help` plus a `/set…` command per setting (see `/help`).

## Telegram Mini App (optional)
Set `DASHBOARD_WEBAPP_URL` (or `DASHBOARD_URL`) to your HTTPS dashboard URL; the menu then shows **Open control panel**.
