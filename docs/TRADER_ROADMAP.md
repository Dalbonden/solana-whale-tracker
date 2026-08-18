# From whale viewer to trading intelligence

Engineering plan for turning the tracker into something a trader opens every
morning. Written against the codebase as it stands at commit `80399cc`.

The organising idea: **we already detect almost everything. We surface almost
none of it.** Rotations, clusters, snipes, cost basis, holder concentration —
all implemented, all buried in an append-only alert list where nothing
aggregates and nothing scores. The work below is mostly rollup and ranking, not
new ingest.

---

## 0. The prerequisite nobody wants to hear

Every score below is a statistic over the tracked whale set. With ~10 wallets,
a "6 whales are accumulating" cluster is not a signal — it is the entire
universe agreeing by accident. **Nothing in Phase 2 is trustworthy until the
roster is 300+ wallets.**

That is a discovery and rate-limit problem, not a product problem:

- `DISCOVERY_CANDIDATES_PER_RUN` is 120, and discovery is the most expensive
  job in the system.
- Birdeye free tier is ~1 req/sec with `multi_price` and `wallet_token_list`
  gated off, which is why `collectPortfolioMetrics` had to be restricted to
  priceable mints in the first place.

Concretely: run discovery on a wider seed (top holders of every token in the
universe, not just top traders), persist rejected candidates in a
`whale_candidates` table along with their metrics so re-evaluation is free, and
promote from that pool on each pass instead of re-scanning the chain. Roster
growth becomes a database operation rather than an API-budget operation.

Treat this as Phase 1, item 0.

---

## 1. Audit: what exists, what half-exists, what does not

### Already built — do not rebuild

| Capability | Where | State |
|---|---|---|
| Cost basis + realised P&L per trade | `classifyPosition()` in `core/alerts.ts`; `whale_trades.cost_basis_usd`, `realized_pnl_usd`, `realized_pnl_pct` | Working. Average-cost method. Honest `null` when basis predates tracking. |
| Cluster buy detection | `evaluateTrade()` → `countDistinctBuyers()` | Fires an alert. Nothing persists the cluster. |
| Rotation detection | `evaluateTrade()` → `getRecentExits()` | Per-whale pair only. Never aggregated across whales. |
| Pump.fun snipe detection | `evaluateTrade()` → `pumpfun.getLaunchTime()`, with Birdeye OHLCV fallback | Working. |
| Holder concentration / rug vectors | `core/token-risk.ts`, `TokenRiskPanel` | Working: mint + freeze authority, top-1 / top-10 excluding AMM and burn, creator tracking, liquidity ratio. |
| Conviction (position as % of portfolio) | `whale_portfolios.pct_of_portfolio` | **Column is populated and never displayed.** |
| Per-token whale net flow | `token_leaderboard` view | 24h only, unweighted. |
| Whale composite score | `core/whale-detection.ts` | Five factors. Measures *size*, not *skill*. |

### The gap that blocks the most

`whales.win_rate` is **always `null`** — `core/portfolio.ts:115` and
`core/whale-detection.ts:304` both hardcode it. `whales.realized_pnl_usd` is
only ever seeded from Birdeye's top-trader response and is never recomputed
from the trades we observe ourselves.

So today the system cannot answer *"is this whale any good?"* — which is the
question underneath smart money, the P&L leaderboard, flow weighting and
archetypes. Fix this first; four features fall out of it.

### Genuinely missing

Unrealised P&L · hold duration · position lifecycle · whale quality score ·
per-token signal rollup · cluster persistence and cluster P&L · aggregated
rotation edges · narratives · a simplified UI · any published track record.

---

## 2. Foundation: `whale_positions`

One table unlocks unrealised P&L, conviction, hold duration and archetypes.

It is also a performance fix. `classifyPosition()` currently calls
`getPositionHistory()` and replays the whole trade history on *every* ingested
trade — O(history) per trade, on the webhook hot path. An incremental position
row makes it O(1).

```sql
create table if not exists public.whale_positions (
  id                uuid primary key default gen_random_uuid(),
  whale_address     text not null references public.whales(address) on delete cascade,
  token_mint        text not null,
  status            text not null default 'open' check (status in ('open','closed')),

  amount            numeric(38,12) not null default 0,   -- current units held
  cost_basis_usd    numeric(24,2)  not null default 0,   -- remaining basis
  avg_entry_price   numeric(24,12),

  total_bought_usd  numeric(24,2) not null default 0,
  total_sold_usd    numeric(24,2) not null default 0,
  realized_pnl_usd  numeric(24,2) not null default 0,
  buy_count         integer not null default 0,
  sell_count        integer not null default 0,

  -- false when the first trade we saw was a sell: the position predates
  -- tracking, so basis and therefore P&L are unknowable. Never guess it.
  basis_complete    boolean not null default true,

  opened_at         timestamptz not null,
  closed_at         timestamptz,
  last_trade_at     timestamptz not null,

  constraint whale_positions_unique unique (whale_address, token_mint, opened_at)
);

create index on public.whale_positions (whale_address, status);
create index on public.whale_positions (token_mint, status);
create index on public.whale_positions (status, last_trade_at desc);
```

A re-entry after a full exit opens a **new row**, which is what makes hold
duration and per-cycle P&L meaningful.

Derived at read time against `meme_tokens.price_usd`:

```
unrealized_pnl_usd  = amount * price_usd - cost_basis_usd
unrealized_pnl_pct  = unrealized_pnl_usd / nullif(cost_basis_usd, 0)
hold_duration_hours = extract(epoch from now() - opened_at) / 3600
conviction_pct      = (amount * price_usd) / whale.portfolio_value_usd
```

`conviction_pct` is the one traders actually read. A whale putting 0.4% of the
book into a name is noise; 22% is a thesis. Surface it next to every buy.

**Migration:** backfill by replaying `whale_trades` in `block_time` order per
`(whale_address, token_mint)`. Roughly a hundred lines, runs once. Set
`basis_complete = false` wherever the replay hits a sell against a zero
balance.

---

## 3. Whale quality — smart money vs dumb money

> **Superseded by [WHALE_RATING.md](./WHALE_RATING.md).** The score below rates
> whales on realised P&L, which systematically overstates skill (winners get
> sold, losers get held) and cannot tell edge apart from a bull market. The
> rating spec replaces it with mark-to-market alpha against a meme index.
> Keep this section only as the cheap first cut.

### 3.1 Recompute from our own trades

```sql
create or replace view public.whale_realized_stats as
select
  whale_address,
  count(*) filter (where realized_pnl_usd is not null)                        as closed_n,
  count(*) filter (where realized_pnl_usd > 0)                                as wins,
  coalesce(sum(realized_pnl_usd), 0)                                          as realized_pnl_usd,
  coalesce(sum(realized_pnl_usd) filter (where realized_pnl_usd > 0), 0)      as gross_profit,
  abs(coalesce(sum(realized_pnl_usd) filter (where realized_pnl_usd < 0), 0)) as gross_loss,
  avg(realized_pnl_pct)        filter (where realized_pnl_pct is not null)    as avg_pnl_pct,
  stddev_pop(realized_pnl_pct) filter (where realized_pnl_pct is not null)    as pnl_pct_stddev
from public.whale_trades
where side = 'sell'
group by whale_address;
```

### 3.2 Smart money score (0–100)

```ts
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const norm = (x: number, lo: number, hi: number) => clamp01((x - lo) / (hi - lo));

// Profit factor: dollars won per dollar lost. 1.0 = breakeven.
const profitFactor = grossLoss > 0 ? grossProfit / grossLoss
                   : grossProfit > 0 ? 3.0 : 0;

const edge        = norm(profitFactor, 0.8, 3.0);           // 0.8 -> 0, 3.0 -> 1
const consistency = norm(winRate, 0.35, 0.70);              // meme-realistic band
const scale       = norm(Math.log10(Math.max(realizedPnlUsd, 1)), 3, 6); // $1k -> $1M

// Confidence is a MULTIPLIER, not a component. A wallet with three lucky
// closes must score low, not "unknown but high". This is the whole trick.
const confidence  = norm(closedN, 5, 25);

const smartScore  = 100 * confidence * (0.45 * edge + 0.35 * consistency + 0.20 * scale);
```

Persist onto `whales`:

```sql
alter table public.whales
  add column if not exists smart_score        numeric(6,2) not null default 0,
  add column if not exists closed_trades_n    integer      not null default 0,
  add column if not exists profit_factor      numeric(10,4),
  add column if not exists basis_coverage_pct numeric(6,4),  -- share of sells with known basis
  add column if not exists archetypes         text[]        not null default '{}';
```

`basis_coverage_pct` is the honesty column. A whale with 12% coverage has a
`smart_score` built on a twelfth of their behaviour — the UI must say so rather
than presenting the number bare.

### 3.3 Archetypes — derived, never hand-assigned

Tags are non-exclusive; a wallet can be `sniper` + `rotator`.

| Tag | Rule |
|---|---|
| `consistent_winner` | `smart_score >= 65 && closed_n >= 15` |
| `gambler` | `pnl_pct_stddev > 1.5 && win_rate < 0.40` |
| `sniper` | ≥30% of new positions are pump.fun buys inside `ALERT_SNIPE_WINDOW_MINUTES` |
| `rotator` | median hold duration < 24h over ≥8 closed positions |
| `accumulator` | median hold > 7d **and** 30d net flow positive |
| `distributor` | 30d net flow negative while still holding > $100k |
| `bagholder` | >50% of open positions at `unrealized_pnl_pct < -0.30` |
| `whipsawed` | ≥3 positions re-entered within 48h of a full exit |

`distributor` and `bagholder` are the two most valuable tags and the two nobody
ships, because they are unflattering. They are also the ones that stop a user
from copying a wallet that is quietly handing them exit liquidity.

---

## 4. Whale Flow Score — the single number

Per token, per window. Range **−100 to +100**. Signed, because "distribution"
is as actionable as "accumulation".

Four principles, each fixing a way naive flow scores lie:

1. **Normalise by liquidity, never by raw dollars.** $200k into $8M of
   liquidity is a ripple; into $200k it is the whole book. `liquidity_usd` is
   already cached on `meme_tokens`.
2. **`tanh` every component.** One $5M print must not pin the score at maximum.
3. **Weight by whale quality.** $1M from three `gambler` wallets should not
   read like $1M from three `consistent_winner` wallets.
4. **Risk penalises longs only.** High rug risk makes a bullish reading less
   attractive; it makes a bearish reading *more* urgent. Asymmetric by design.

```ts
// window default 6h
const smartWeighted = (t: Trade) => t.usd_value * (0.4 + 0.6 * (smartScore(t.whale) / 100));

const netSmartUsd = sum(smartWeighted(buys)) - sum(smartWeighted(sells));
const depth       = Math.max(liquidityUsd ?? 0, 50_000);   // floor for thin books

const flow    =  35 * Math.tanh(netSmartUsd / (0.05 * depth));
const breadth =  25 * Math.tanh((distinctBuyers - distinctSellers) / 4);
const convict =  20 * Math.tanh((newPositions - fullExits) / 3);

// Acceleration: recent 2h against the 24h run rate. Catches ignition.
const runRate = netUsd24h / 12;
const accel   =  20 * Math.tanh(runRate !== 0 ? (netUsd2h / runRate) - 1 : 0);

const raw     = flow + breadth + convict + accel;          // -100 .. +100
const score   = raw > 0 ? raw * (1 - 0.5 * (riskScore / 100)) : raw;
```

Bands: `>= 60` heavy accumulation · `25…60` accumulation · `−25…25` neutral ·
`−60…−25` distribution · `<= −60` heavy distribution.

**Always render the four components alongside the number.** A score of +71 that
is 90% acceleration is a completely different trade from +71 that is 90%
breadth, and a trader who cannot see which will stop trusting the score the
first time it misses.

```sql
create table if not exists public.token_signals (
  token_mint           text not null references public.meme_tokens(mint) on delete cascade,
  window_label         text not null check (window_label in ('1h','6h','24h')),
  flow_score           numeric(6,2) not null,
  flow_component       numeric(6,2) not null,
  breadth_component    numeric(6,2) not null,
  conviction_component numeric(6,2) not null,
  accel_component      numeric(6,2) not null,
  net_usd              numeric(24,2) not null,
  net_smart_usd        numeric(24,2) not null,
  buyers               integer not null default 0,
  sellers              integer not null default 0,
  new_positions        integer not null default 0,
  full_exits           integer not null default 0,
  risk_score           numeric(6,2),
  computed_at          timestamptz not null default now(),
  primary key (token_mint, window_label)
);

create index on public.token_signals (window_label, flow_score desc);
```

---

## 5. Clusters as entities, not events

Today a cluster is an alert row that never updates. Make it a tracked object
with a lifecycle, so the UI can say: *"forming 3h ago · now 6 whales · $1.2M ·
avg entry $0.0031 · currently +14%."*

Cluster P&L is the retention feature. It is the only thing on the page that
tells a user whether following these signals would have worked.

```sql
create table if not exists public.signal_clusters (
  id               uuid primary key default gen_random_uuid(),
  token_mint       text not null,
  status           text not null default 'forming'
                     check (status in ('forming','active','faded')),
  whale_count      integer not null default 0,
  whale_addresses  text[]  not null default '{}',
  total_usd        numeric(24,2) not null default 0,
  avg_smart_score  numeric(6,2),
  avg_entry_price  numeric(24,12),
  strength         numeric(6,2) not null default 0,
  started_at       timestamptz not null,
  last_updated_at  timestamptz not null default now(),
  faded_at         timestamptz,
  constraint signal_clusters_unique unique (token_mint, started_at)
);
```

```
strength = 100 * (0.40 * norm(whaleCount, 2, 8)
                + 0.35 * (avgSmartScore / 100)
                + 0.25 * norm(totalUsd / liquidityUsd, 0.01, 0.15))

cluster_pnl_pct = currentPrice / avg_entry_price - 1
```

Lifecycle: `forming` at ≥2 whales → `active` at ≥`ALERT_CLUSTER_WHALES` →
`faded` after 24h with no new participant. Extend an existing `active` cluster
rather than opening a second one for the same token.

Move detection **out of `evaluateTrade()` and into the signals cron.**
`countDistinctBuyers()` currently runs once per ingested trade — N queries per
webhook batch, on the hot path.

---

## 6. Rotation maps

Derive from trades, not from the `rotation` alert — that alert only fires when
the destination is a *new* position, so it misses adds to existing names.

```
for each whale sell of token A at time t, size S:
  find that whale's buys of any token B != A within +/- ROTATION_WINDOW
  require 0.5 * S <= buy_usd <= 2.0 * S      -- same capital, not coincidence
  emit edge (A -> B, whale, min(S, buy_usd))

aggregate over all whales in window:
  edge_strength = sum(usd), weighted by each whale's smart_score
  rank edges by strength
```

```sql
create table if not exists public.rotation_edges (
  from_mint    text not null,
  to_mint      text not null,
  window_label text not null,
  whale_count  integer not null,
  total_usd    numeric(24,2) not null,
  smart_usd    numeric(24,2) not null,
  computed_at  timestamptz not null default now(),
  primary key (from_mint, to_mint, window_label)
);
```

UI: a ranked list first — *"BONK → WIF · 5 whales · $2.1M"*. A Sankey is the
right visual, but Recharts has no Sankey primitive; it needs `d3-sankey`, which
is Phase 3 work, and the ranked list carries 90% of the information.

---

## 7. Narratives

Two stages. Do not start with an LLM.

**Stage 1 — dictionary.** Regex over symbol + name into a many-to-many table.
Covers roughly 70% of meme names for near-zero cost.

```ts
export const NARRATIVES: Record<string, RegExp> = {
  dog:       /\b(doge|inu|shib|bonk|wif|floki|dog)\b/i,
  cat:       /\b(cat|mew|popcat|meow|paw)\b/i,
  frog:      /\b(pepe|frog|brett|toad)\b/i,
  political: /\b(trump|biden|maga|boden|potus|kamala)\b/i,
  ai:        /\b(ai|gpt|agent|neural|bot|llm)\b/i,
  celebrity: /\b(musk|kanye|drake|elon)\b/i,
};
```

```sql
create table if not exists public.token_narratives (
  token_mint text not null references public.meme_tokens(mint) on delete cascade,
  narrative  text not null,
  source     text not null default 'dictionary'
               check (source in ('dictionary','manual','model')),
  confidence numeric(4,3) not null default 1.0,
  primary key (token_mint, narrative)
);
```

Narrative flow = whale net flow summed over member tokens per window →
*"whales rotated +$4.2M into AI coins over 24h, out of dog coins −$1.8M."*

**Stage 2 (Phase 3) — the tail is the point.** The 30% a dictionary misses is
where new narratives *start*, which is precisely what has trading value. Embed
token name + description, cluster, and surface unnamed clusters as *"emerging
theme: 6 tokens, +$3M whale inflow, no label yet."* Keep the dictionary as
ground truth and let the model propose only.

---

## 8. Trader Mode — `/pulse`

One screen. No navigation. Answers *"what changed and does it matter"* in five
seconds.

```
┌─────────────────────────────────────────────────────────────────┐
│  PULSE            [6h ▾]   [ ✓ Smart money only ]               │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│ TOP CLUSTER  │ TOP ROTATION │ BIGGEST BUY  │ RISK FLAG          │
│ WIF  ●72     │ BONK → WIF   │ $840k POPCAT │ MEW top-10 81%     │
│ 6 whales     │ 5 whales     │ 9x…3f conv.  │ liquidity −34%     │
│ +14% since   │ $2.1M        │ 18% of book  │ 3 whales exiting   │
├──────────────┴──────────────┴──────────────┴────────────────────┤
│  FLOW LEADERS                                                    │
│  ┌────────┬───────┬─────────┬────────┬────────┬──────┬────────┐ │
│  │ Token  │ Flow  │ Net 6h  │ Whales │ New    │ Risk │ Spark  │ │
│  │ WIF    │ ●+72  │ +$1.8M  │ 6 ↑    │ 4      │ 22   │ ╱╱╱    │ │
│  │ POPCAT │ ●+41  │ +$620k  │ 3 ↑    │ 1      │ 38   │ ╱‾╲    │ │
│  │ BONK   │ ●−58  │ −$2.4M  │ 2 ↓    │ 0      │ 19   │ ╲╲     │ │
│  └────────┴───────┴─────────┴────────┴────────┴──────┴────────┘ │
├──────────────────────────────────────┬──────────────────────────┤
│  NARRATIVE FLOW 24h                  │  SMART MONEY LIVE        │
│  AI        ████████ +$4.2M           │  9x…3f bought WIF $210k  │
│  cat       ████ +$1.1M               │  ↳ 3rd whale in 40m      │
│  dog       ███ −$1.8M                │  ↳ 18% of book · flow+72 │
└──────────────────────────────────────┴──────────────────────────┘
```

New components:

- `<FlowScoreBadge score components />` — number, band colour, tooltip breakdown
- `<SignalCard kind title metric context />` — the four hero tiles
- `<ClusterCard cluster />` — participants, avg entry, live cluster P&L
- `<RotationList edges />`
- `<NarrativeFlowBar rows />`
- `<SmartMoneyToggle />` — URL state; filters every panel to `smart_score >= 60`
- `<ConvictionBar pct />` — position as share of book, reused on whale pages

**"Smart money only" is the single highest-value control on the page.** It
turns the dashboard from "whales did things" into "people who are actually good
did things."

---

## 9. Alert context

The detections already exist and the metadata is already stored. This is
formatting work with a large payoff.

Before:
> `9x…3f bought $210k of WIF on jupiter.`

After:
> **`9x…3f bought $210k WIF`** — smart score 78 · 3rd whale in 40m · 18% of
> their book · flow +72 (breadth-led) · risk 22 · they are +$1.4M lifetime over
> 34 closes

Implementation: an `enrichAlert()` pass in `generateAlerts()` joining the
whale's `smart_score`, the token's current `token_signals` row, the active
cluster, and the position's `conviction_pct`. All four are single indexed
reads.

Add two alert types to the enum and the check constraint:

- `liquidity_drop` — `liquidity_usd` fell >30% in 1h (LP pull or cascade)
- `smart_exit` — a whale with `smart_score >= 65` fully exits

Add `min_severity` and `min_smart_score` as query params on `/api/alerts` and
`/api/stream`, so the feed can be made quiet enough to actually watch.

---

## 10. API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/signals?window=6h&min=25&narrative=ai` | Ranked flow scores. The Trader Mode backbone. |
| `GET /api/tokens/[mint]/flow` | Score + component breakdown + history |
| `GET /api/clusters?status=active` | Live clusters with cluster P&L |
| `GET /api/rotations?window=24h` | Rotation edges, ranked |
| `GET /api/narratives?window=24h` | Narrative flow table |
| `GET /api/whales/[address]/positions` | Open positions: unrealised P&L, conviction, hold duration |
| `GET /api/whales/leaderboard?by=smart\|pnl\|winrate` | Smart money leaderboard |
| `GET /api/stream` | extend with `signal`, `cluster`, `rotation` event types |

Keep the existing `ApiListResponse<T>` envelope throughout.

---

## 11. Cron and webhook changes

**New — `/api/cron/signals`, every 5 minutes.** Recompute `token_signals` for
tokens with trades in the last hour; update cluster lifecycles; expire faded
clusters; recompute `rotation_edges`. Cheap: pure SQL over `whale_trades`, no
external API calls.

**New — `/api/cron/stats`, hourly.** Recompute `whale_realized_stats` →
`smart_score`, `profit_factor`, `basis_coverage_pct`, archetypes.

**Changed — webhook hot path.** After `insertTrades()`, incrementally update
`whale_positions` instead of replaying history in `classifyPosition()`. Remove
the per-trade `countDistinctBuyers()` call; clusters become the signals cron's
job.

**Changed — `/api/cron/tokens`.** Record `liquidity_usd` into a small time
series so `liquidity_drop` can be detected. A `token_liquidity_history` table
with hourly rows is enough.

Render free tier sleeps after inactivity, so external cron pings double as the
keep-alive. `/api/ping` already exists for that.

---

## 12. Documentation and onboarding

The repo currently opens with setup instructions. It should open with **what
question this answers.**

- **README rewrite:** screenshot first, then one paragraph — *"Which Solana
  wallets with real size are buying meme tokens right now, are they any good,
  and is the token safe to touch."* Setup moves below the fold.
- **`docs/METHODOLOGY.md`** — every formula in plain English, with its
  limitations stated. This is what separates a project from a product. Traders
  discount any score they cannot interrogate.
- **`docs/GLOSSARY.md`** — flow score, smart score, conviction, cluster
  strength, basis coverage. Link each UI tooltip to its anchor.
- **`.env.example`** with every variable, its default, and what degrades when
  it is absent. `SOLSCAN_API_KEY` in particular: without it, most large holders
  fall through as "unidentified" and concentration risk reads high.
- **Demo mode** — `DEMO_MODE=true` serves a seeded read-only dataset so a
  visitor with no keys sees the product. Highest-leverage onboarding change in
  this list.
- **Status transparency** — surface `job_runs` on a `/status` page. Showing
  when data was last refreshed buys more trust than any feature here.

### The credibility feature

**`docs/TRACK_RECORD.md`, generated by a backtest job.** For every historical
`flow_score >= 60`, measure the token's forward 1h / 24h / 7d return. Publish
the hit rate — *including when it is bad.*

Every whale tracker claims signal. Almost none publishes a hit rate. Doing so
is both the strongest available trust signal and the only way to learn whether
the weights above are right.

Two traps to respect: use only data that existed at signal time (`token_signals`
carries `computed_at`, so replay from that, never from current state), and
report the full distribution rather than the mean — meme returns are so skewed
that a single 40x makes a losing strategy look profitable.

---

## 13. Roadmap

### Phase 1 — high impact, low effort

| # | Item | Why now |
|---|---|---|
| 0 | Widen discovery; `whale_candidates` pool | Every statistic below needs sample size |
| 1 | `whale_positions` + backfill | Unlocks unrealised P&L, conviction, hold duration; also removes O(n) work from the webhook path |
| 2 | Populate `realized_pnl_usd` + `win_rate` from our own trades | Fixes a column hardcoded to `null` today |
| 3 | `smart_score` + `/api/whales/leaderboard?by=smart` | Smart vs dumb money, from data already stored |
| 4 | Surface `pct_of_portfolio` as conviction | Column already populated, never rendered |
| 5 | Flow Score v1 as a SQL view | No new ingest, no new cron |
| 6 | Alert context enrichment | Detection exists; this is formatting |
| 7 | README rewrite + `GLOSSARY.md` + `.env.example` | Cheap; changes the first impression entirely |

### Phase 2 — medium effort, high value

| # | Item |
|---|---|
| 8 | `token_signals` table + `/api/cron/signals` + `/api/signals` |
| 9 | **Trader Mode `/pulse`** — the feature that changes who can use this |
| 10 | Persistent clusters with lifecycle and cluster P&L |
| 11 | `rotation_edges` + ranked rotation list |
| 12 | Narrative dictionary + narrative flow bar |
| 13 | Smart-money-weighted flow + "smart money only" toggle |
| 14 | `liquidity_drop` and `smart_exit` alerts + liquidity history |
| 15 | Demo mode + `/status` page |

### Phase 3 — deeper engineering

| # | Item | Note |
|---|---|---|
| 16 | Archetype classifier | Needs mature `whale_positions` history |
| 17 | Backtest harness + published `TRACK_RECORD.md` | The credibility feature. Beware look-ahead bias. |
| 18 | Sankey rotation map | Needs `d3-sankey` |
| 19 | Slippage estimator from pool reserves | Requires reading AMM pool accounts directly |
| 20 | Liquidity-collapse detection (LP removal) | Needs pool account subscriptions, not swap parsing. Genuinely hard. |
| 21 | Embedding-based narrative discovery | Dictionary stays ground truth |
| 22 | Telegram / Discord alert delivery | Where traders actually are |
| 23 | Accounts + personal watchlists | Turns a dashboard into a product |

---

## 14. What not to build

- **No trade automation, ever.** The project's founding rule, and also what
  keeps this analytics tooling rather than a regulated product.
- **No price predictions.** `TokenRiskPanel` is careful to frame itself as
  exposure rather than forecast. Every score added here inherits that
  discipline. "Whales are accumulating" is an observation; "this will pump" is
  a liability.
- **No survivorship-biased leaderboards.** Ranking by realised P&L alone
  promotes whoever got lucky and sold. `confidence` as a multiplier and
  `basis_coverage_pct` on display are the guards.
- **No fabricated numbers to fill a column.** The existing code returns `null`
  for unknown cost basis, unknown launch time and unidentified holders. Keep
  that. An honest `—` costs a user a moment; a fabricated number costs them
  money.
