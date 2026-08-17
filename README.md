# Solana Whale Tracker

Read-only analytics that finds Solana wallets trading meme tokens with size, tracks what they buy and sell, and surfaces rotation signals in real time.

Everything runs on public blockchain data. The app holds no keys, signs nothing, and cannot trade.

---

## What it does

| Module | What it answers |
| --- | --- |
| **Whale discovery** | Which wallets are whales? Scores every candidate on portfolio value, trade size, trade frequency, meme exposure and token diversity. |
| **Activity tracking** | What are they trading? Decodes swaps on Jupiter, Raydium, Orca, Meteora, Pump.fun and PumpSwap. |
| **Meme filter** | Which tokens count? A curated core list plus a classifier that admits new pump.fun graduates and trending tokens that clear liquidity/volume floors. |
| **Alerts** | What just changed? New positions, full exits, rotations, multi-whale clusters, pump.fun snipes and outsized trades. |
| **Dashboard** | Whale list, whale profiles with portfolio charts, token leaderboard ranked by net whale flow, live activity feed, price charts with whale trades overlaid. |

---

## Architecture

```
                         ┌────────────────────────────┐
   Helius webhook ──────►│  /api/webhooks/helius      │  real-time push
                         └──────────────┬─────────────┘
                                        │
   Vercel Cron ─────────►┌──────────────▼─────────────┐
     /api/cron/sync      │  lib/core/whale-tracker.ts │  parse → price → classify
     /api/cron/discover  │  lib/solana/parse.ts       │
     /api/cron/tokens    │  lib/core/alerts.ts        │
     /api/cron/portfolios└──────────────┬─────────────┘
                                        │
                         ┌──────────────▼─────────────┐
                         │  Supabase (Postgres)       │
                         │  whales · whale_trades ·   │
                         │  whale_portfolios ·        │
                         │  meme_tokens · alerts      │
                         └──────────────┬─────────────┘
                                        │
                         ┌──────────────▼─────────────┐
                         │  Next.js App Router        │
                         │  RSC pages + /api/* + SSE  │
                         └────────────────────────────┘
```

Both ingest paths — webhook and cron — run the *same* pipeline. Whichever sees a transaction first stores it; a unique constraint on `(signature, whale, mint, side)` makes the second one a no-op. That is what lets the webhook be fast and the cron be a safety net without double-counting anything.

### Project layout

```
src/
├── app/
│   ├── page.tsx                       dashboard
│   ├── whales/page.tsx                whale list
│   ├── whales/[address]/page.tsx      whale profile: portfolio, trades, alerts
│   ├── tokens/page.tsx                meme token leaderboard
│   ├── tokens/[mint]/page.tsx         token page: price chart + whale positioning
│   ├── activity/page.tsx              full trade feed with filters
│   ├── alerts/page.tsx                alert stream
│   └── api/
│       ├── whales/route.ts            GET list · POST track a wallet
│       ├── whales/[address]/route.ts  GET profile · PATCH · POST resync
│       ├── trades/route.ts            GET trades
│       ├── tokens/route.ts            GET universe · POST add · PATCH activate
│       ├── tokens/[mint]/chart/route.ts  Birdeye OHLCV + whale trade markers
│       ├── alerts/route.ts            GET alerts
│       ├── stream/route.ts            SSE live feed
│       ├── health/route.ts            integration status
│       ├── webhooks/helius/route.ts   real-time ingest
│       └── cron/{sync,discover,tokens,portfolios,webhook-sync}/route.ts
├── components/                        dashboard UI (shadcn-style primitives in ui/)
├── hooks/use-live-feed.ts             EventSource subscription
├── lib/
│   ├── config.ts                      all env access, one place
│   ├── api.ts                         response envelopes, job auth
│   ├── core/
│   │   ├── whale-detection.ts         scoring model + candidate sourcing
│   │   ├── discovery.ts               discovery orchestration
│   │   ├── whale-tracker.ts           ingest pipeline
│   │   ├── meme-filter.ts             token universe + classifier
│   │   ├── alerts.ts                  signal rules
│   │   └── portfolio.ts               snapshots, rescoring, diffing
│   ├── solana/
│   │   ├── constants.ts               program IDs, quote mints, denylist
│   │   └── parse.ts                   swap decoding
│   ├── providers/{helius,birdeye,solscan,pumpfun,http}.ts
│   └── db/{client,repositories}.ts
└── types/index.ts
supabase/{schema.sql,seed.sql}
scripts/{apply-schema.mjs,bootstrap.mjs}
```

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Get API keys

| Service | Needed for | Where |
| --- | --- | --- |
| **Helius** (required) | RPC, enhanced transaction parsing, real-time webhooks | <https://dashboard.helius.dev> — free tier works to start |
| **Birdeye** (required) | USD prices, token metadata, OHLCV, top traders | <https://bds.birdeye.so> — free tier works; Standard recommended for charts |
| **Supabase** (required) | Postgres database | <https://supabase.com/dashboard> — free tier is fine |
| **Solscan Pro** (optional) | Exchange/market-maker labels, history backfill | <https://pro-api.solscan.io> |

Fill in `.env.local`:

```bash
HELIUS_API_KEY=your_key
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key
BIRDEYE_API_KEY=your_key

NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

CRON_SECRET=$(openssl rand -hex 32)
HELIUS_WEBHOOK_SECRET=$(openssl rand -hex 32)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

> `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. It is read only by server code and must never be exposed to the browser or committed.

### 3. Create the database

Open Supabase → **SQL Editor**, then run:

1. `supabase/schema.sql` — tables, indexes, views, RLS
2. `supabase/seed.sql` — the curated core meme tokens

Or, with a Postgres connection string:

```bash
npm install --no-save pg
SUPABASE_DB_URL="postgresql://postgres:...@db.xxx.supabase.co:5432/postgres" npm run db:push
```

### 4. Run it

```bash
npm run dev
```

Visit <http://localhost:3000>. It will be empty — nothing has been discovered yet.

### 5. Populate

```bash
CRON_SECRET=your_secret npm run bootstrap
```

This runs the jobs in dependency order: build the token universe → discover whales → ingest their trades → snapshot portfolios → register the webhook. The discovery pass takes a few minutes; it evaluates up to 120 candidate wallets and each one costs a portfolio lookup.

Check <http://localhost:3000/api/health> at any point for an integration report.

---

## How detection works

A wallet is scored 0–100 on five weighted signals:

| Signal | Weight | Range mapped to 0→1 |
| --- | --- | --- |
| Portfolio value | 35% | $50K → $50M (log) |
| Largest trade | 25% | $5K → $5M (log) |
| Trade frequency (30d) | 20% | 2 → 150 trades |
| Meme exposure | 15% | 0% → 100% of portfolio |
| Token diversity (30d) | 5% | 1 → 12 distinct tokens |

Portfolio value alone would flag dormant bags and exchange hot wallets. Trade size alone would flag arbitrage bots holding nothing. The blend targets wallets that hold size *and* actively rotate meme exposure.

Hard gates applied before scoring:

- portfolio ≥ `WHALE_MIN_PORTFOLIO_USD` (default $250K), **and**
- meme exposure ≥ `WHALE_MIN_MEME_EXPOSURE` (default 15%), **and**
- largest trade ≥ `WHALE_MIN_TRADE_USD` **or** ≥ `WHALE_MIN_TRADES_30D` trades, **and**
- score ≥ `WHALE_MIN_SCORE` (default 45)

Exchange, market-maker and protocol accounts are excluded outright via Solscan tags — they clear every threshold trivially and say nothing about conviction.

Tiers: `dolphin` ≥ 45, `whale` ≥ 65, `kraken` ≥ 85.

### Swap decoding

Rather than decoding each AMM's instruction layout, `lib/solana/parse.ts` computes the wallet's **net balance delta** across a transaction. A swap is by definition one mint going up and another going down for the same owner. This is layout-agnostic — it survives new pool programs and router changes — and it correctly collapses a multi-hop Jupiter route (SOL → USDC → WIF) into the single economic trade the user actually made.

Trades are priced off the **quote** leg where possible. Valuing "0.4 SOL" is reliable; valuing "18,000,000 SOMEMEME" against a lagging price feed often is not.

### Alert rules

| Type | Fires when | Severity |
| --- | --- | --- |
| `new_position` | Whale buys a token it has never held | warning / critical |
| `cluster_buy` | ≥ 3 distinct whales buy the same token within 60 min | critical |
| `rotation` | Whale fully exits one token and opens another within 180 min | critical |
| `pumpfun_snipe` | Buy within 15 min of a pump.fun launch | critical |
| `full_exit` | Sell leaving < 5% of the position | warning / critical |
| `large_buy` / `large_sell` | Trade ≥ `ALERT_LARGE_TRADE_USD` (default $50K) | info / critical |

All thresholds are environment variables — see `.env.example`.

---

## API

All routes return JSON and are `no-store`.

```
GET    /api/whales?tier=whale&minScore=60&sort=score&page=1&pageSize=50
POST   /api/whales                     { address, label? }
GET    /api/whales/:address?days=30&trades=100
PATCH  /api/whales/:address            { label?, is_tracked? }
POST   /api/whales/:address            force resync + snapshot

GET    /api/trades?whale=&mint=&side=buy&venue=jupiter&minUsd=10000&hours=24
GET    /api/tokens?view=leaderboard&limit=100
POST   /api/tokens                     { mint, force? }
PATCH  /api/tokens                     { mint, is_active }
GET    /api/tokens/:mint/chart?interval=15m&hours=24

GET    /api/alerts?type=cluster_buy&severity=critical&since=<iso>
GET    /api/stream                     Server-Sent Events: trades, alerts
GET    /api/health
```

Job endpoints require `Authorization: Bearer $CRON_SECRET`:

```
GET /api/cron/sync?limit=25
GET /api/cron/discover?max=120
GET /api/cron/tokens?discover=true
GET /api/cron/portfolios?limit=60&prune=true
GET /api/cron/webhook-sync
```

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full Vercel walkthrough, including cron scheduling, Helius webhook registration and the Hobby-plan cron limitation.

---

## Constraints and honest limits

- **Discovery is sampled, not exhaustive.** It looks at top traders and largest holders of tracked tokens. A whale trading only tokens outside the universe will not be found. Add tokens via `POST /api/tokens` or wallets via `POST /api/whales`.
- **Trade history starts when tracking starts.** `is_full_exit` cannot be asserted for a position opened before the wallet was tracked; those sells are recorded without the flag rather than guessed at.
- **Prices are point-in-time.** A trade's USD value is computed at ingest. Backfilled trades are valued at *current* quote prices, so historical values drift — treat old backfilled numbers as approximate.
- **Pump.fun endpoints are unofficial** and change without notice. Every call soft-fails; snipe detection and launch discovery degrade quietly rather than breaking ingest.
- **Free API tiers rate-limit hard.** Discovery over many tokens will hit Birdeye's free limits. Lower `DISCOVERY_CANDIDATES_PER_RUN` or upgrade the plan.

## What this project will not do

No private keys, no wallet connection, no trade execution, no order routing. It reads public chain data and displays it. Signals are observations about other people's transactions, not advice — whales lose money regularly, and a wallet buying is not a reason to buy.

## License

MIT
