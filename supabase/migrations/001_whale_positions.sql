-- ===========================================================================
-- 001 — whale_positions
--
-- Additive only: creates one table and its indexes, and extends the retention
-- helper. Nothing is dropped, altered or backfilled here.
--
-- Existing deployments: paste this into Supabase Studio → SQL Editor → Run,
-- or `npm run db:push` (re-running schema.sql is idempotent and applies the
-- same DDL).
--
-- After applying, rebuild positions from stored trades:
--   npm run positions:rebuild
-- ===========================================================================

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

  amount            numeric(38,12) not null default 0,
  cost_basis_usd    numeric(24,2)  not null default 0,
  avg_entry_price   numeric(24,12),

  total_bought_usd  numeric(24,2) not null default 0,
  total_sold_usd    numeric(24,2) not null default 0,
  realized_pnl_usd  numeric(24,2) not null default 0,
  buy_count         integer not null default 0,
  sell_count        integer not null default 0,

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

create index if not exists whale_positions_open_idx
  on public.whale_positions (whale_address, token_mint)
  where status = 'open';

alter table public.whale_positions enable row level security;

create or replace function public.prune_history(days integer default 90)
returns void
language sql
as $$
  delete from public.whale_trades     where block_time  < now() - (days || ' days')::interval;
  delete from public.whale_portfolios where snapshot_at < now() - (days || ' days')::interval;
  delete from public.whale_positions  where status = 'closed'
                                        and closed_at  < now() - (days || ' days')::interval;
  delete from public.alerts           where created_at  < now() - (days || ' days')::interval;
  delete from public.job_runs         where created_at  < now() - interval '14 days';
$$;
