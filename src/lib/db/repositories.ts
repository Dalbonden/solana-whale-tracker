/**
 * Data access. Every query the app runs lives here so that table names and
 * column shapes exist in exactly one place.
 */

import { chunk } from '@/lib/providers/http';
import type {
  Alert,
  AlertSeverity,
  AlertType,
  MemeToken,
  PortfolioHolding,
  TokenLeaderboardRow,
  Whale,
  WhalePosition,
  WhaleTrade,
} from '@/types';

import { db } from './client';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function listTokens(
  opts: { activeOnly?: boolean; limit?: number } = {}
): Promise<MemeToken[]> {
  const { activeOnly = true, limit = 500 } = opts;
  let query = db()
    .from('meme_tokens')
    .select('*')
    .order('volume_24h_usd', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(`listTokens: ${error.message}`);
  return (data ?? []) as MemeToken[];
}

export async function getToken(mint: string): Promise<MemeToken | null> {
  const { data, error } = await db().from('meme_tokens').select('*').eq('mint', mint).maybeSingle();
  if (error) throw new Error(`getToken: ${error.message}`);
  return (data as MemeToken) ?? null;
}

/** Mints of every active token, used as the tracker's filter set. */
export async function listActiveMints(): Promise<string[]> {
  const { data, error } = await db().from('meme_tokens').select('mint').eq('is_active', true);
  if (error) throw new Error(`listActiveMints: ${error.message}`);
  return (data ?? []).map((row) => row.mint as string);
}

export async function upsertTokens(tokens: Partial<MemeToken>[]): Promise<number> {
  if (!tokens.length) return 0;
  let written = 0;
  for (const batch of chunk(tokens, 200)) {
    const { error, count } = await db()
      .from('meme_tokens')
      .upsert(batch, { onConflict: 'mint', count: 'exact', ignoreDuplicates: false });
    if (error) throw new Error(`upsertTokens: ${error.message}`);
    written += count ?? batch.length;
  }
  return written;
}

export async function setTokenActive(mint: string, isActive: boolean): Promise<void> {
  const { error } = await db().from('meme_tokens').update({ is_active: isActive }).eq('mint', mint);
  if (error) throw new Error(`setTokenActive: ${error.message}`);
}

export async function getLeaderboard(limit = 50): Promise<TokenLeaderboardRow[]> {
  const { data, error } = await db()
    .from('token_leaderboard')
    .select('*')
    .order('net_flow_usd_24h', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`getLeaderboard: ${error.message}`);
  return (data ?? []) as TokenLeaderboardRow[];
}

// ---------------------------------------------------------------------------
// Whales
// ---------------------------------------------------------------------------

export interface WhaleQuery {
  tier?: string;
  minScore?: number;
  search?: string;
  sort?: 'score' | 'portfolio_value_usd' | 'last_active_at' | 'trade_count_30d';
  page?: number;
  pageSize?: number;
}

export async function listWhales(query: WhaleQuery = {}): Promise<{ rows: Whale[]; count: number }> {
  const { tier, minScore, search, sort = 'score', page = 1, pageSize = 50 } = query;
  const from = (page - 1) * pageSize;

  let builder = db()
    .from('whales')
    .select('*', { count: 'exact' })
    .eq('is_tracked', true)
    .order(sort, { ascending: false, nullsFirst: false })
    .range(from, from + pageSize - 1);

  if (tier) builder = builder.eq('tier', tier);
  if (typeof minScore === 'number') builder = builder.gte('score', minScore);
  if (search) builder = builder.or(`address.ilike.%${search}%,label.ilike.%${search}%`);

  const { data, error, count } = await builder;
  if (error) throw new Error(`listWhales: ${error.message}`);
  return { rows: (data ?? []) as Whale[], count: count ?? 0 };
}

export async function getWhale(address: string): Promise<Whale | null> {
  const { data, error } = await db().from('whales').select('*').eq('address', address).maybeSingle();
  if (error) throw new Error(`getWhale: ${error.message}`);
  return (data as Whale) ?? null;
}

export async function upsertWhales(whales: Partial<Whale>[]): Promise<number> {
  if (!whales.length) return 0;
  let written = 0;
  for (const batch of chunk(whales, 200)) {
    const { error, count } = await db()
      .from('whales')
      .upsert(batch, { onConflict: 'address', count: 'exact' });
    if (error) throw new Error(`upsertWhales: ${error.message}`);
    written += count ?? batch.length;
  }
  return written;
}

/** Addresses already known, so discovery can skip re-scoring them. */
export async function getKnownWhaleAddresses(): Promise<Set<string>> {
  const { data, error } = await db().from('whales').select('address');
  if (error) throw new Error(`getKnownWhaleAddresses: ${error.message}`);
  return new Set((data ?? []).map((row) => row.address as string));
}

/** Whales due for a sync, oldest cursor first. */
export async function getWhalesToSync(limit: number): Promise<Whale[]> {
  const { data, error } = await db()
    .from('whales')
    .select('*')
    .eq('is_tracked', true)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`getWhalesToSync: ${error.message}`);
  return (data ?? []) as Whale[];
}

export async function markWhaleSynced(
  address: string,
  lastSignature: string | null,
  lastActiveAt: Date | null
): Promise<void> {
  const patch: Record<string, unknown> = { last_synced_at: new Date().toISOString() };
  if (lastSignature) patch.last_signature = lastSignature;
  if (lastActiveAt) patch.last_active_at = lastActiveAt.toISOString();

  const { error } = await db().from('whales').update(patch).eq('address', address);
  if (error) throw new Error(`markWhaleSynced: ${error.message}`);
}

/** Advances a whale's backfill cursor after a backwards pass. */
export async function markBackfill(
  address: string,
  state: { cursor: string | null; complete: boolean }
): Promise<void> {
  const patch: Record<string, unknown> = { backfill_complete: state.complete };
  if (state.cursor) patch.backfill_cursor = state.cursor;

  const { error } = await db().from('whales').update(patch).eq('address', address);
  if (error) throw new Error(`markBackfill: ${error.message}`);
}

/** Oldest trade we hold for a whale — the backfill's starting point. */
export async function getOldestTradeSignature(address: string): Promise<string | null> {
  const { data, error } = await db()
    .from('whale_trades')
    .select('signature')
    .eq('whale_address', address)
    .order('block_time', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getOldestTradeSignature: ${error.message}`);
  return (data?.signature as string) ?? null;
}

/** Whales still worth walking backwards, least-recently-backfilled first. */
export async function getWhalesToBackfill(limit: number): Promise<Whale[]> {
  const { data, error } = await db()
    .from('whales')
    .select('*')
    .eq('backfill_complete', false)
    .order('score', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getWhalesToBackfill: ${error.message}`);
  return (data ?? []) as Whale[];
}

/** Every address the Helius webhook should be subscribed to. */
export async function getTrackedAddresses(): Promise<string[]> {
  const { data, error } = await db()
    .from('whales')
    .select('address')
    .eq('is_tracked', true)
    .order('score', { ascending: false })
    .limit(10_000);
  if (error) throw new Error(`getTrackedAddresses: ${error.message}`);
  return (data ?? []).map((row) => row.address as string);
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface TradeQuery {
  whale?: string;
  mint?: string;
  side?: 'buy' | 'sell';
  venue?: string;
  minUsd?: number;
  since?: string;
  page?: number;
  pageSize?: number;
}

export async function listTrades(
  query: TradeQuery = {}
): Promise<{ rows: WhaleTrade[]; count: number }> {
  const { whale, mint, side, venue, minUsd, since, page = 1, pageSize = 50 } = query;
  const from = (page - 1) * pageSize;

  let builder = db()
    .from('whale_trades')
    .select('*', { count: 'exact' })
    .order('block_time', { ascending: false })
    .range(from, from + pageSize - 1);

  if (whale) builder = builder.eq('whale_address', whale);
  if (mint) builder = builder.eq('token_mint', mint);
  if (side) builder = builder.eq('side', side);
  if (venue) builder = builder.eq('venue', venue);
  if (typeof minUsd === 'number') builder = builder.gte('usd_value', minUsd);
  if (since) builder = builder.gte('block_time', since);

  const { data, error, count } = await builder;
  if (error) throw new Error(`listTrades: ${error.message}`);
  return { rows: (data ?? []) as WhaleTrade[], count: count ?? 0 };
}

/**
 * Inserts trades, ignoring ones already stored. The unique constraint on
 * (signature, whale, mint, side) makes ingest idempotent, which matters because
 * the webhook and the sync cron can deliver the same transaction.
 *
 * Returns only the rows that were actually new — alerts are generated from
 * these, so a replayed webhook cannot double-fire an alert.
 */
export async function insertTrades(trades: Partial<WhaleTrade>[]): Promise<WhaleTrade[]> {
  if (!trades.length) return [];
  const inserted: WhaleTrade[] = [];

  for (const batch of chunk(trades, 100)) {
    const { data, error } = await db()
      .from('whale_trades')
      .upsert(batch, {
        onConflict: 'signature,whale_address,token_mint,side',
        ignoreDuplicates: true,
      })
      .select();
    if (error) throw new Error(`insertTrades: ${error.message}`);
    inserted.push(...((data ?? []) as WhaleTrade[]));
  }

  return inserted;
}

/**
 * Writes back the position flags and P&L a replay derived for each trade.
 *
 * Sent as full rows keyed on `id` rather than a partial patch: PostgREST models
 * an upsert as INSERT ... ON CONFLICT, so the payload has to satisfy the table's
 * NOT NULL columns even though every row here already exists and will take the
 * UPDATE branch.
 */
export async function updateTradeClassifications(trades: Partial<WhaleTrade>[]): Promise<number> {
  if (!trades.length) return 0;
  let written = 0;
  for (const batch of chunk(trades, 200)) {
    const { error } = await db().from('whale_trades').upsert(batch, { onConflict: 'id' });
    if (error) throw new Error(`updateTradeClassifications: ${error.message}`);
    written += batch.length;
  }
  return written;
}

/** Prior trades for a whale/token pair — the basis for position tracking. */
export async function getPositionHistory(
  whale: string,
  mint: string
): Promise<{
  boughtAmount: number;
  soldAmount: number;
  boughtUsd: number;
  soldUsd: number;
  tradeCount: number;
  /** Average USD cost per token across observed buys, or null if none seen. */
  avgCostUsd: number | null;
}> {
  const { data, error } = await db()
    .from('whale_trades')
    .select('side, token_amount, usd_value')
    .eq('whale_address', whale)
    .eq('token_mint', mint);
  if (error) throw new Error(`getPositionHistory: ${error.message}`);

  let boughtAmount = 0;
  let soldAmount = 0;
  let boughtUsd = 0;
  let soldUsd = 0;

  for (const row of data ?? []) {
    const amount = Number(row.token_amount) || 0;
    const usd = Number(row.usd_value) || 0;
    if (row.side === 'buy') {
      boughtAmount += amount;
      boughtUsd += usd;
    } else {
      soldAmount += amount;
      soldUsd += usd;
    }
  }

  return {
    boughtAmount,
    soldAmount,
    boughtUsd,
    soldUsd,
    tradeCount: (data ?? []).length,
    // Average cost basis. Null when we never observed a buy — the position was
    // opened before tracking began, so its basis is genuinely unknown.
    avgCostUsd: boughtAmount > 0 && boughtUsd > 0 ? boughtUsd / boughtAmount : null,
  };
}

/** 30-day activity stats used by the scorer. */
export async function getWhaleActivityStats(address: string): Promise<{
  tradeCount: number;
  avgUsd: number;
  maxUsd: number;
  distinctTokens: number;
  lastActiveAt: Date | null;
}> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await db()
    .from('whale_trades')
    .select('usd_value, token_mint, block_time')
    .eq('whale_address', address)
    .gte('block_time', since);
  if (error) throw new Error(`getWhaleActivityStats: ${error.message}`);

  const rows = data ?? [];
  if (!rows.length) {
    return { tradeCount: 0, avgUsd: 0, maxUsd: 0, distinctTokens: 0, lastActiveAt: null };
  }

  const tokens = new Set<string>();
  let total = 0;
  let max = 0;
  let latest = 0;

  for (const row of rows) {
    const usd = Number(row.usd_value) || 0;
    total += usd;
    if (usd > max) max = usd;
    tokens.add(row.token_mint as string);
    const time = new Date(row.block_time as string).getTime();
    if (time > latest) latest = time;
  }

  return {
    tradeCount: rows.length,
    avgUsd: total / rows.length,
    maxUsd: max,
    distinctTokens: tokens.size,
    lastActiveAt: latest ? new Date(latest) : null,
  };
}

/** Distinct whales that bought a token inside a window (cluster detection). */
export async function countDistinctBuyers(mint: string, windowMinutes: number): Promise<string[]> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await db()
    .from('whale_trades')
    .select('whale_address')
    .eq('token_mint', mint)
    .eq('side', 'buy')
    .gte('block_time', since);
  if (error) throw new Error(`countDistinctBuyers: ${error.message}`);
  return [...new Set((data ?? []).map((row) => row.whale_address as string))];
}

/** Tokens a whale fully exited inside a window (rotation detection). */
export async function getRecentExits(
  whale: string,
  windowMinutes: number
): Promise<Array<{ token_mint: string; token_symbol: string | null; block_time: string }>> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await db()
    .from('whale_trades')
    .select('token_mint, token_symbol, block_time')
    .eq('whale_address', whale)
    .eq('is_full_exit', true)
    .gte('block_time', since)
    .order('block_time', { ascending: false });
  if (error) throw new Error(`getRecentExits: ${error.message}`);
  return (data ?? []) as Array<{ token_mint: string; token_symbol: string | null; block_time: string }>;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Composite identity of a trade leg, matching whale_trades_unique_leg. */
export function tradeKey(t: {
  signature: string;
  whale_address: string;
  token_mint: string;
  side: string;
}): string {
  return `${t.signature}:${t.whale_address}:${t.token_mint}:${t.side}`;
}

/**
 * Drops trades already stored, before they reach the position state machine.
 *
 * `insertTrades` deduplicates too, but it does so *after* classification. That
 * is too late for positions: a replayed webhook would apply the same buy to the
 * position twice, and every later trade in the batch would be classified
 * against an inflated balance. Filtering first makes the ingest path idempotent
 * in the arithmetic, not just in the row count.
 */
export async function filterNewTrades<T extends Partial<WhaleTrade>>(rows: T[]): Promise<T[]> {
  if (!rows.length) return [];

  const signatures = [...new Set(rows.map((r) => r.signature as string))];
  const seen = new Set<string>();

  for (const batch of chunk(signatures, 200)) {
    const { data, error } = await db()
      .from('whale_trades')
      .select('signature, whale_address, token_mint, side')
      .in('signature', batch);
    if (error) throw new Error(`filterNewTrades: ${error.message}`);
    for (const row of data ?? []) {
      seen.add(tradeKey(row as Parameters<typeof tradeKey>[0]));
    }
  }

  return rows.filter((row) => !seen.has(tradeKey(row as Parameters<typeof tradeKey>[0])));
}

/** Open cycles for a set of whale/token pairs, keyed `whale:mint`. */
export async function getOpenPositions(
  pairs: Array<{ whale: string; mint: string }>
): Promise<Map<string, WhalePosition>> {
  const found = new Map<string, WhalePosition>();
  if (!pairs.length) return found;

  const whales = [...new Set(pairs.map((p) => p.whale))];
  const mints = [...new Set(pairs.map((p) => p.mint))];

  // Fetched as a cross-product of the batch's whales and mints, then narrowed
  // in memory. One round trip beats one query per pair, and the open-position
  // set per whale is small.
  for (const batch of chunk(whales, 50)) {
    const { data, error } = await db()
      .from('whale_positions')
      .select('*')
      .in('whale_address', batch)
      .in('token_mint', mints)
      .eq('status', 'open');
    if (error) throw new Error(`getOpenPositions: ${error.message}`);
    for (const row of (data ?? []) as WhalePosition[]) {
      found.set(`${row.whale_address}:${row.token_mint}`, row);
    }
  }

  return found;
}

export async function upsertPositions(rows: Partial<WhalePosition>[]): Promise<number> {
  if (!rows.length) return 0;
  let written = 0;
  for (const batch of chunk(rows, 200)) {
    const { error } = await db()
      .from('whale_positions')
      .upsert(batch, { onConflict: 'whale_address,token_mint,opened_by_signature' });
    if (error) throw new Error(`upsertPositions: ${error.message}`);
    written += batch.length;
  }
  return written;
}

export async function listPositions(
  whale: string,
  opts: { status?: 'open' | 'closed' } = {}
): Promise<WhalePosition[]> {
  let query = db().from('whale_positions').select('*').eq('whale_address', whale);
  if (opts.status) query = query.eq('status', opts.status);

  const { data, error } = await query
    .order('status', { ascending: true })
    .order('last_trade_at', { ascending: false });
  if (error) throw new Error(`listPositions: ${error.message}`);
  return (data ?? []) as WhalePosition[];
}

/** Cached prices for a set of mints, for marking positions to market. */
export async function getTokenPrices(mints: string[]): Promise<Map<string, number | null>> {
  const prices = new Map<string, number | null>();
  if (!mints.length) return prices;

  for (const batch of chunk([...new Set(mints)], 200)) {
    const { data, error } = await db()
      .from('meme_tokens')
      .select('mint, price_usd')
      .in('mint', batch);
    if (error) throw new Error(`getTokenPrices: ${error.message}`);
    for (const row of data ?? []) {
      prices.set(row.mint as string, row.price_usd === null ? null : Number(row.price_usd));
    }
  }

  return prices;
}

/** Every stored trade for a whale, oldest first — the rebuild job's input. */
export async function getAllTradesForWhale(whale: string): Promise<WhaleTrade[]> {
  const rows: WhaleTrade[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db()
      .from('whale_trades')
      .select('*')
      .eq('whale_address', whale)
      .order('block_time', { ascending: true })
      .order('signature', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`getAllTradesForWhale: ${error.message}`);

    rows.push(...((data ?? []) as WhaleTrade[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

/** Clears a whale's positions so a rebuild is a replacement, not a merge. */
export async function deletePositionsForWhale(whale: string): Promise<void> {
  const { error } = await db().from('whale_positions').delete().eq('whale_address', whale);
  if (error) throw new Error(`deletePositionsForWhale: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

export async function insertPortfolioSnapshot(
  holdings: Partial<PortfolioHolding>[]
): Promise<number> {
  if (!holdings.length) return 0;
  let written = 0;
  for (const batch of chunk(holdings, 200)) {
    const { error } = await db()
      .from('whale_portfolios')
      .upsert(batch, { onConflict: 'whale_address,token_mint,snapshot_at', ignoreDuplicates: true });
    if (error) throw new Error(`insertPortfolioSnapshot: ${error.message}`);
    written += batch.length;
  }
  return written;
}

export async function getCurrentPortfolio(whale: string): Promise<PortfolioHolding[]> {
  const { data, error } = await db()
    .from('whale_portfolio_current')
    .select('*')
    .eq('whale_address', whale)
    .order('usd_value', { ascending: false });
  if (error) throw new Error(`getCurrentPortfolio: ${error.message}`);
  return (data ?? []) as PortfolioHolding[];
}

/** Total portfolio value per snapshot, for the value-over-time chart. */
export async function getPortfolioTimeline(
  whale: string,
  days = 30
): Promise<Array<{ snapshot_at: string; total_usd: number; meme_usd: number }>> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const { data, error } = await db()
    .from('whale_portfolios')
    .select('snapshot_at, usd_value, is_meme')
    .eq('whale_address', whale)
    .gte('snapshot_at', since)
    .order('snapshot_at', { ascending: true });
  if (error) throw new Error(`getPortfolioTimeline: ${error.message}`);

  const buckets = new Map<string, { total: number; meme: number }>();
  for (const row of data ?? []) {
    const key = row.snapshot_at as string;
    const bucket = buckets.get(key) ?? { total: 0, meme: 0 };
    const usd = Number(row.usd_value) || 0;
    bucket.total += usd;
    if (row.is_meme) bucket.meme += usd;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([snapshot_at, value]) => ({
    snapshot_at,
    total_usd: Number(value.total.toFixed(2)),
    meme_usd: Number(value.meme.toFixed(2)),
  }));
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertQuery {
  type?: AlertType;
  severity?: AlertSeverity;
  whale?: string;
  mint?: string;
  since?: string;
  page?: number;
  pageSize?: number;
}

export async function listAlerts(
  query: AlertQuery = {}
): Promise<{ rows: Alert[]; count: number }> {
  const { type, severity, whale, mint, since, page = 1, pageSize = 50 } = query;
  const from = (page - 1) * pageSize;

  let builder = db()
    .from('alerts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);

  if (type) builder = builder.eq('type', type);
  if (severity) builder = builder.eq('severity', severity);
  if (whale) builder = builder.eq('whale_address', whale);
  if (mint) builder = builder.eq('token_mint', mint);
  if (since) builder = builder.gt('created_at', since);

  const { data, error, count } = await builder;
  if (error) throw new Error(`listAlerts: ${error.message}`);
  return { rows: (data ?? []) as Alert[], count: count ?? 0 };
}

/**
 * Writes alerts, relying on the `dedupe_key` unique index to drop duplicates
 * when a transaction is re-processed.
 *
 * `dedupe_key` is a generated column, so it is never supplied here — the
 * conflict target is the index over it.
 */
export async function insertAlerts(alerts: Partial<Alert>[]): Promise<Alert[]> {
  if (!alerts.length) return [];
  const { data, error } = await db()
    .from('alerts')
    .upsert(alerts, {
      onConflict: 'dedupe_key',
      ignoreDuplicates: true,
    })
    .select();
  if (error) throw new Error(`insertAlerts: ${error.message}`);
  return (data ?? []) as Alert[];
}

// ---------------------------------------------------------------------------
// Job observability
// ---------------------------------------------------------------------------

export async function recordJobRun(entry: {
  job: string;
  status: 'ok' | 'partial' | 'error';
  durationMs: number;
  processed?: number;
  created?: number;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db().from('job_runs').insert({
    job: entry.job,
    status: entry.status,
    duration_ms: entry.durationMs,
    processed: entry.processed ?? 0,
    created: entry.created ?? 0,
    detail: entry.detail ?? null,
  });
  // Observability must never break the job it observes.
  if (error) console.error(`recordJobRun: ${error.message}`);
}

export async function getRecentJobRuns(limit = 20) {
  const { data, error } = await db()
    .from('job_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getRecentJobRuns: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------

export async function getDashboardStats(): Promise<{
  whaleCount: number;
  trackedTokens: number;
  trades24h: number;
  volume24hUsd: number;
  netFlow24hUsd: number;
  alerts24h: number;
}> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const client = db();

  const [whales, tokens, trades, alerts] = await Promise.all([
    client.from('whales').select('address', { head: true, count: 'exact' }).eq('is_tracked', true),
    client.from('meme_tokens').select('mint', { head: true, count: 'exact' }).eq('is_active', true),
    client.from('whale_trades').select('usd_value, side').gte('block_time', since),
    client.from('alerts').select('id', { head: true, count: 'exact' }).gte('created_at', since),
  ]);

  let volume = 0;
  let net = 0;
  for (const row of trades.data ?? []) {
    const usd = Number(row.usd_value) || 0;
    volume += usd;
    net += row.side === 'buy' ? usd : -usd;
  }

  return {
    whaleCount: whales.count ?? 0,
    trackedTokens: tokens.count ?? 0,
    trades24h: (trades.data ?? []).length,
    volume24hUsd: volume,
    netFlow24hUsd: net,
    alerts24h: alerts.count ?? 0,
  };
}
