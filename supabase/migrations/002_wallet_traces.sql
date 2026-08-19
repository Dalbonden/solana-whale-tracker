-- ===========================================================================
-- 002 — wallet_traces
--
-- Cache for the funding-graph walk. Additive only; nothing is dropped.
--
-- Existing deployments: paste into Supabase Studio → SQL Editor → Run, or
-- `npm run db:push` (re-running schema.sql applies the same DDL).
--
-- The app degrades gracefully without this table: forensics still works, it
-- just re-walks every wallet on each request and cannot reach as far back.
-- ===========================================================================

create table if not exists public.wallet_traces (
  address            text primary key,

  -- Earliest inbound SOL transfers observed, oldest first. Capped: only the
  -- first few matter, because origin is the question, not cash flow.
  inbound            jsonb       not null default '[]'::jsonb,
  -- Distinct wallets this address sent SOL to, with totals. Capped.
  outbound           jsonb       not null default '[]'::jsonb,

  -- Resume cursor. The next walk continues from here instead of restarting at
  -- the newest transaction, which is what lets repeated analyses reach further
  -- back than any single request could afford.
  oldest_signature   text,
  oldest_block_time  timestamptz,
  newest_block_time  timestamptz,

  pages_walked       integer     not null default 0,
  tx_seen            integer     not null default 0,

  -- Fee payer of the oldest transaction seen. Once the walk reaches genesis
  -- this is whoever paid to create the account — which, for a token mint, is
  -- the deployer that launchpad metadata refuses to name.
  genesis_fee_payer  text,

  -- True once paging reached the wallet's first transaction. Only then are the
  -- inbound rows really its origin rather than recent flow.
  origin_confirmed   boolean     not null default false,
  -- Velocity heuristic: exchange hot wallet, market maker or bot dispatcher.
  likely_service     boolean,
  tx_per_hour        numeric(12,2),

  last_walk_failed   boolean     not null default false,
  first_traced_at    timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The deepening cron takes the least recently touched unconfirmed wallets.
create index if not exists wallet_traces_unconfirmed_idx
  on public.wallet_traces (updated_at asc)
  where origin_confirmed = false;

create index if not exists wallet_traces_service_idx
  on public.wallet_traces (likely_service)
  where likely_service = true;

alter table public.wallet_traces enable row level security;
