-- ===========================================================================
-- Solana Whale Tracker — Postgres schema (Supabase)
--
-- Apply with either:
--   psql "$SUPABASE_DB_URL" -f supabase/schema.sql
--   or paste into Supabase Studio → SQL Editor → Run
--
-- Idempotent: safe to re-run.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- meme_tokens — the universe of tokens we care about. Everything else is
-- ignored by the tracker. Rows can be added at runtime via /api/tokens.
-- ---------------------------------------------------------------------------
create table if not exists public.meme_tokens (
  mint                text primary key,
  symbol              text        not null,
  name                text,
  decimals            smallint    not null default 6,
  logo_uri            text,
  -- how this token entered the universe
  source              text        not null default 'manual'
                        check (source in ('manual','core','pumpfun','birdeye','auto')),
  -- core = the curated always-on list (WIF, BONK, POPCAT, MEW, SAMO, ...)
  is_core             boolean     not null default false,
  is_active           boolean     not null default true,
  -- cached market data, refreshed by the tokens cron
  price_usd           numeric(24,12),
  market_cap_usd      numeric(24,2),
  liquidity_usd       numeric(24,2),
  volume_24h_usd      numeric(24,2),
  price_change_24h    numeric(12,4),
  holder_count        integer,
  -- pump.fun specific
  pumpfun_created_at  timestamptz,
  pumpfun_graduated   boolean     not null default false,
  first_seen_at       timestamptz not null default now(),
  last_refreshed_at   timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists meme_tokens_active_idx  on public.meme_tokens (is_active) where is_active;
create index if not exists meme_tokens_symbol_idx  on public.meme_tokens (upper(symbol));
create index if not exists meme_tokens_volume_idx  on public.meme_tokens (volume_24h_usd desc nulls last);

-- ---------------------------------------------------------------------------
-- whales — wallets that passed the detection thresholds.
-- ---------------------------------------------------------------------------
create table if not exists public.whales (
  address              text primary key,
  label                text,
  -- scoring inputs (recomputed on every portfolio snapshot)
  portfolio_value_usd  numeric(24,2) not null default 0,
  meme_value_usd       numeric(24,2) not null default 0,
  meme_exposure_pct    numeric(6,4)  not null default 0,   -- 0..1
  trade_count_30d      integer       not null default 0,
  avg_trade_size_usd   numeric(24,2) not null default 0,
  max_trade_size_usd   numeric(24,2) not null default 0,
  realized_pnl_usd     numeric(24,2) not null default 0,
  win_rate             numeric(6,4),                        -- 0..1, null until enough closed trades
  distinct_tokens_30d  integer       not null default 0,
  -- composite 0..100 whale score
  score                numeric(6,2)  not null default 0,
  tier                 text          not null default 'shrimp'
                         check (tier in ('shrimp','dolphin','whale','kraken')),
  discovery_source     text,          -- birdeye_top_traders | swap_scan | pumpfun | manual
  is_tracked           boolean       not null default true,
  -- incremental sync cursor: newest signature already ingested
  last_signature       text,
  first_seen_at        timestamptz   not null default now(),
  last_active_at       timestamptz,
  last_synced_at       timestamptz,
  created_at           timestamptz   not null default now(),
  updated_at           timestamptz   not null default now()
);

create index if not exists whales_score_idx    on public.whales (score desc);
create index if not exists whales_tracked_idx  on public.whales (is_tracked, last_synced_at asc nulls first);
create index if not exists whales_active_idx   on public.whales (last_active_at desc nulls last);
create index if not exists whales_tier_idx     on public.whales (tier);

-- ---------------------------------------------------------------------------
-- whale_trades — one row per (transaction, whale, token, side). A single swap
-- produces one row for the meme leg; the quote leg is recorded on the same row.
-- ---------------------------------------------------------------------------
create table if not exists public.whale_trades (
  id              uuid primary key default gen_random_uuid(),
  signature       text          not null,
  whale_address   text          not null references public.whales(address) on delete cascade,
  slot            bigint,
  block_time      timestamptz   not null,
  side            text          not null check (side in ('buy','sell')),
  venue           text          not null default 'unknown'
                    check (venue in ('jupiter','raydium','pumpfun','pumpswap','orca','meteora','phoenix','lifinity','unknown')),
  -- meme leg
  token_mint      text          not null,
  token_symbol    text,
  token_amount    numeric(38,12) not null default 0,
  -- quote leg (SOL / USDC / USDT ...)
  quote_mint      text,
  quote_symbol    text,
  quote_amount    numeric(38,12),
  -- valuation
  usd_value       numeric(24,2)  not null default 0,
  price_usd       numeric(24,12),
  -- position context, computed at ingest time
  is_new_position boolean        not null default false,
  is_full_exit    boolean        not null default false,
  raw             jsonb,
  created_at      timestamptz    not null default now(),
  constraint whale_trades_unique_leg unique (signature, whale_address, token_mint, side)
);

create index if not exists whale_trades_whale_time_idx on public.whale_trades (whale_address, block_time desc);
create index if not exists whale_trades_token_time_idx on public.whale_trades (token_mint, block_time desc);
create index if not exists whale_trades_time_idx       on public.whale_trades (block_time desc);
create index if not exists whale_trades_usd_idx        on public.whale_trades (usd_value desc);
create index if not exists whale_trades_sig_idx        on public.whale_trades (signature);

-- ---------------------------------------------------------------------------
-- whale_portfolios — periodic per-holding snapshots. Diffing two snapshots
-- gives portfolio change over time without recomputing from trades.
-- ---------------------------------------------------------------------------
create table if not exists public.whale_portfolios (
  id                uuid primary key default gen_random_uuid(),
  whale_address     text           not null references public.whales(address) on delete cascade,
  token_mint        text           not null,
  token_symbol      text,
  amount            numeric(38,12) not null default 0,
  usd_value         numeric(24,2)  not null default 0,
  price_usd         numeric(24,12),
  pct_of_portfolio  numeric(6,4),
  is_meme           boolean        not null default false,
  snapshot_at       timestamptz    not null default now(),
  constraint whale_portfolios_unique unique (whale_address, token_mint, snapshot_at)
);

create index if not exists whale_portfolios_lookup_idx on public.whale_portfolios (whale_address, snapshot_at desc);
create index if not exists whale_portfolios_token_idx  on public.whale_portfolios (token_mint, snapshot_at desc);

-- ---------------------------------------------------------------------------
-- whale_positions — position lifecycle, one row per entry→exit cycle.
--
-- whale_portfolios answers "what do they hold right now". This answers "what
-- did this position cost, how long have they held it, and are they up on it" —
-- which needs the cycle, not the snapshot.
--
-- A re-entry after a full exit opens a NEW row rather than reviving the old
-- one, so hold duration and per-cycle P&L stay meaningful. `opened_at` is part
-- of the key for exactly that reason.
-- ---------------------------------------------------------------------------
create table if not exists public.whale_positions (
  id                uuid primary key default gen_random_uuid(),
  whale_address     text not null references public.whales(address) on delete cascade,
  token_mint        text not null,
  token_symbol      text,
  -- The cycle's identity. `opened_at` alone is not unique: Solana packs many
  -- swaps into one second, so the sell that closes a cycle and the buy that
  -- opens the next routinely carry the same timestamp.
  opened_by_signature text not null,
  status            text not null default 'open' check (status in ('open','closed')),

  amount            numeric(38,12) not null default 0,   -- units still held
  cost_basis_usd    numeric(24,2)  not null default 0,   -- basis of the remaining units
  avg_entry_price   numeric(24,12),

  total_bought_usd  numeric(24,2) not null default 0,
  total_sold_usd    numeric(24,2) not null default 0,
  realized_pnl_usd  numeric(24,2) not null default 0,
  buy_count         integer not null default 0,
  sell_count        integer not null default 0,

  -- False when the first activity we saw was a sell: the entry predates
  -- tracking, so basis and therefore P&L are unknowable. Never guessed.
  basis_complete    boolean not null default true,

  opened_at         timestamptz not null,
  closed_at         timestamptz,
  last_trade_at     timestamptz not null,
  updated_at        timestamptz not null default now(),

  constraint whale_positions_unique unique (whale_address, token_mint, opened_by_signature)
);

create index if not exists whale_positions_whale_idx  on public.whale_positions (whale_address, status);
create index if not exists whale_positions_token_idx  on public.whale_positions (token_mint, status);
create index if not exists whale_positions_recent_idx on public.whale_positions (status, last_trade_at desc);

-- The ingest path reads exactly one row per trade: the open cycle for this
-- whale/token. Partial index keeps that lookup on the open set only.
create index if not exists whale_positions_open_idx
  on public.whale_positions (whale_address, token_mint)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- alerts — derived signals. Append-only.
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id             uuid primary key default gen_random_uuid(),
  type           text        not null
                   check (type in ('new_position','large_buy','large_sell','full_exit','rotation','cluster_buy','pumpfun_snipe','whale_discovered')),
  severity       text        not null default 'info'
                   check (severity in ('info','warning','critical')),
  whale_address  text,
  token_mint     text,
  token_symbol   text,
  title          text        not null,
  message        text        not null,
  usd_value      numeric(24,2),
  signature      text,
  metadata       jsonb,
  created_at     timestamptz not null default now(),
  -- Stable dedupe identity. A generated column with a plain unique index is
  -- used rather than a partial/expression index because ON CONFLICT can only
  -- infer a plain index from a column list — which is how the app upserts.
  dedupe_key     text generated always as (
                   type
                   || ':' || coalesce(whale_address, '')
                   || ':' || coalesce(token_mint, '')
                   || ':' || coalesce(signature, '')
                 ) stored
);

create index if not exists alerts_time_idx     on public.alerts (created_at desc);
create index if not exists alerts_type_idx     on public.alerts (type, created_at desc);
create index if not exists alerts_severity_idx on public.alerts (severity, created_at desc);
create index if not exists alerts_whale_idx    on public.alerts (whale_address, created_at desc);
create index if not exists alerts_token_idx    on public.alerts (token_mint, created_at desc);

-- Dedupe guard: at most one alert of a given type per whale+token per signature.
-- Makes replayed webhooks and overlapping cron syncs idempotent.
create unique index if not exists alerts_dedupe_idx on public.alerts (dedupe_key);

-- ---------------------------------------------------------------------------
-- job_runs — observability for crons and the webhook ingest path.
-- ---------------------------------------------------------------------------
create table if not exists public.job_runs (
  id           uuid primary key default gen_random_uuid(),
  job          text        not null,
  status       text        not null check (status in ('ok','partial','error')),
  duration_ms  integer,
  processed    integer     not null default 0,
  created      integer     not null default 0,
  detail       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists job_runs_job_idx on public.job_runs (job, created_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Latest portfolio snapshot per whale/token.
create or replace view public.whale_portfolio_current as
select distinct on (p.whale_address, p.token_mint)
  p.whale_address,
  p.token_mint,
  p.token_symbol,
  p.amount,
  p.usd_value,
  p.price_usd,
  p.pct_of_portfolio,
  p.is_meme,
  p.snapshot_at
from public.whale_portfolios p
where p.amount > 0
order by p.whale_address, p.token_mint, p.snapshot_at desc;

-- Meme token leaderboard: 24h whale flow.
create or replace view public.token_leaderboard as
select
  t.mint,
  t.symbol,
  t.name,
  t.logo_uri,
  t.price_usd,
  t.market_cap_usd,
  t.liquidity_usd,
  t.volume_24h_usd,
  t.price_change_24h,
  coalesce(f.whale_count, 0)                       as whale_count_24h,
  coalesce(f.buy_usd, 0)                           as whale_buy_usd_24h,
  coalesce(f.sell_usd, 0)                          as whale_sell_usd_24h,
  coalesce(f.buy_usd, 0) - coalesce(f.sell_usd, 0) as net_flow_usd_24h,
  coalesce(f.trade_count, 0)                       as whale_trades_24h,
  coalesce(f.new_positions, 0)                     as new_positions_24h,
  f.last_trade_at
from public.meme_tokens t
left join (
  select
    token_mint,
    count(distinct whale_address)                                     as whale_count,
    sum(case when side = 'buy'  then usd_value else 0 end)            as buy_usd,
    sum(case when side = 'sell' then usd_value else 0 end)            as sell_usd,
    count(*)                                                          as trade_count,
    count(*) filter (where is_new_position)                           as new_positions,
    max(block_time)                                                   as last_trade_at
  from public.whale_trades
  where block_time > now() - interval '24 hours'
  group by token_mint
) f on f.token_mint = t.mint
where t.is_active;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- All reads/writes go through Next.js server code using the service role key,
-- which bypasses RLS. We enable RLS with no anon policies so a leaked anon key
-- cannot read the dataset. If you want to expose read-only data directly to the
-- browser (e.g. Supabase Realtime), uncomment the SELECT policies below.
-- ---------------------------------------------------------------------------
alter table public.meme_tokens      enable row level security;
alter table public.whales           enable row level security;
alter table public.whale_trades     enable row level security;
alter table public.whale_portfolios enable row level security;
alter table public.whale_positions  enable row level security;
alter table public.alerts           enable row level security;
alter table public.job_runs         enable row level security;

-- do $$
-- begin
--   create policy "public read tokens"     on public.meme_tokens      for select to anon using (true);
--   create policy "public read whales"     on public.whales           for select to anon using (true);
--   create policy "public read trades"     on public.whale_trades     for select to anon using (true);
--   create policy "public read portfolios" on public.whale_portfolios for select to anon using (true);
--   create policy "public read alerts"     on public.alerts           for select to anon using (true);
-- exception when duplicate_object then null;
-- end $$;

-- ---------------------------------------------------------------------------
-- Retention helper — call from a cron if the tables get large.
-- ---------------------------------------------------------------------------
create or replace function public.prune_history(days integer default 90)
returns void
language sql
as $$
  delete from public.whale_trades     where block_time  < now() - (days || ' days')::interval;
  delete from public.whale_portfolios where snapshot_at < now() - (days || ' days')::interval;
  -- Closed cycles only. Open positions are current state, never history.
  delete from public.whale_positions  where status = 'closed'
                                        and closed_at  < now() - (days || ' days')::interval;
  delete from public.alerts           where created_at  < now() - (days || ' days')::interval;
  delete from public.job_runs         where created_at  < now() - interval '14 days';
$$;

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists whales_touch_updated_at on public.whales;
create trigger whales_touch_updated_at
  before update on public.whales
  for each row execute function public.touch_updated_at();
