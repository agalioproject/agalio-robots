# DexScreener min market-cap gate

Default: **do not enter** a token until DexScreener reports **market cap ≥ $10,000**.

## How it works

1. On every assessment the bot calls DexScreener:
   `GET https://api.dexscreener.com/latest/dex/tokens/{mint}`
2. Uses the highest-liquidity pair’s `marketCap` (fallback `fdv`).
3. If there is **no pair yet** (brand-new bonding-curve coin), MC is treated as **$0** → **blocked**.
4. If MC < `minMarketCapUsd` → hard reject (UNSAFE), no buy.

## Config

| Source | Key | Default |
|--------|-----|---------|
| Live / Telegram | `minMarketCapUsd` / `/setminmcap` | `10000` |
| Disable gate | `/setminmcap 0` | — |

## Why

Early curve spam often dumps on snipers. Waiting for ~$10k MC filters pure create noise and matches “only coins that already have some market.”

Still not safe — $10k is early. Prefer also final-stretch / migrated when possible.
