/**
 * Cached, resumable wallet history walks.
 *
 * The funding graph is bounded by how many pages of history one request can
 * afford. Without a cache that budget resets on every analysis: the same
 * wallets are re-walked from their newest transaction over and over, and no
 * amount of repetition ever reaches further back.
 *
 * Storing the paging cursor changes the shape of the problem. Each visit
 * continues from where the last one stopped, so a wallet gets deeper every time
 * it is seen — and because the same snipers appear across launch after launch,
 * the wallets that matter most are the ones that deepen fastest. Origin, once
 * confirmed, never needs walking again: a wallet's first transaction cannot
 * change.
 *
 * The cache is optional. Every read and write is guarded, and if the table is
 * missing the walk simply behaves as it did before — bounded per request, and
 * honest about it. A forensics page that 500s because an optional cache table
 * was never created would be a bad trade.
 */

import { db } from '@/lib/db/client';
import * as helius from '@/lib/providers/helius';
import type { HeliusEnhancedTransaction } from '@/lib/providers/helius';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Ignore dust: rent top-ups and spam are not funding. */
export const MIN_FUNDING_SOL = 0.01;

/** Earliest inbound sources kept per wallet. Origin needs few. */
const MAX_INBOUND = 5;
/** Outbound recipients kept per wallet, largest first. */
const MAX_OUTBOUND = 200;

/**
 * Outbound edges describe recent behaviour and go stale; inbound origin does
 * not. Only the former is re-walked on age.
 */
const OUTBOUND_TTL_MS = 6 * 3600_000;

/**
 * A hundred transactions inside an hour marks an address as a service.
 * No individual transacts at that rate, and treating one as a meaningful
 * shared funder would group every unrelated wallet that used the same
 * exchange.
 */
const SERVICE_TX_PER_HOUR = 100;

export interface TraceSource {
  address: string;
  sol: number;
  at: number;
  signature: string;
}

export interface TraceRecipient {
  address: string;
  sol: number;
}

export interface WalletTrace {
  address: string;
  inbound: TraceSource[];
  outbound: TraceRecipient[];
  oldestSignature: string | null;
  oldestBlockTime: number | null;
  newestBlockTime: number | null;
  pagesWalked: number;
  txSeen: number;
  originConfirmed: boolean;
  /** Fee payer of the oldest transaction seen; the creator once confirmed. */
  genesisFeePayer: string | null;
  likelyService: boolean | null;
  txPerHour: number | null;
  lastWalkFailed: boolean;
  updatedAt: number;
  /** True when this call did no network work. */
  fromCache: boolean;
}

export interface WalkCounter {
  requests: number;
  failures: number;
  cacheHits: number;
  cacheMisses: number;
  cacheAvailable: boolean;
}

export function newCounter(): WalkCounter {
  return { requests: 0, failures: 0, cacheHits: 0, cacheMisses: 0, cacheAvailable: true };
}

function empty(address: string): WalletTrace {
  return {
    address,
    inbound: [],
    outbound: [],
    oldestSignature: null,
    oldestBlockTime: null,
    newestBlockTime: null,
    pagesWalked: 0,
    txSeen: 0,
    originConfirmed: false,
    genesisFeePayer: null,
    likelyService: null,
    txPerHour: null,
    lastWalkFailed: false,
    updatedAt: 0,
    fromCache: false,
  };
}

// ---------------------------------------------------------------------------
// Persistence — every path tolerates the table not existing
// ---------------------------------------------------------------------------

interface TraceRow {
  address: string;
  inbound: TraceSource[] | null;
  outbound: TraceRecipient[] | null;
  oldest_signature: string | null;
  oldest_block_time: string | null;
  newest_block_time: string | null;
  pages_walked: number;
  tx_seen: number;
  origin_confirmed: boolean;
  genesis_fee_payer: string | null;
  likely_service: boolean | null;
  tx_per_hour: number | null;
  last_walk_failed: boolean;
  updated_at: string;
}

function fromRow(row: TraceRow): WalletTrace {
  return {
    address: row.address,
    inbound: row.inbound ?? [],
    outbound: row.outbound ?? [],
    oldestSignature: row.oldest_signature,
    oldestBlockTime: row.oldest_block_time ? Date.parse(row.oldest_block_time) / 1000 : null,
    newestBlockTime: row.newest_block_time ? Date.parse(row.newest_block_time) / 1000 : null,
    pagesWalked: row.pages_walked ?? 0,
    txSeen: row.tx_seen ?? 0,
    originConfirmed: row.origin_confirmed,
    genesisFeePayer: row.genesis_fee_payer,
    likelyService: row.likely_service,
    txPerHour: row.tx_per_hour === null ? null : Number(row.tx_per_hour),
    lastWalkFailed: row.last_walk_failed,
    updatedAt: Date.parse(row.updated_at),
    fromCache: true,
  };
}

export async function loadTraces(
  addresses: string[],
  counter: WalkCounter
): Promise<Map<string, WalletTrace>> {
  const found = new Map<string, WalletTrace>();
  if (!addresses.length || !counter.cacheAvailable) return found;

  try {
    // Bounded by construction: `address` is the primary key and callers pass at
    // most MAX_TRACED_CANDIDATES addresses, so this cannot hit the row cap.
    const { data, error } = await db()
      .from('wallet_traces')
      .select('*')
      .in('address', [...new Set(addresses)]);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as TraceRow[]) found.set(row.address, fromRow(row));
  } catch {
    // Missing table, or the database is unreachable. Either way the walk still
    // works; it just cannot remember anything.
    counter.cacheAvailable = false;
  }

  return found;
}

async function saveTrace(trace: WalletTrace, counter: WalkCounter): Promise<void> {
  if (!counter.cacheAvailable) return;
  try {
    const { error } = await db()
      .from('wallet_traces')
      .upsert(
        {
          address: trace.address,
          inbound: trace.inbound,
          outbound: trace.outbound,
          oldest_signature: trace.oldestSignature,
          oldest_block_time: trace.oldestBlockTime
            ? new Date(trace.oldestBlockTime * 1000).toISOString()
            : null,
          newest_block_time: trace.newestBlockTime
            ? new Date(trace.newestBlockTime * 1000).toISOString()
            : null,
          pages_walked: trace.pagesWalked,
          tx_seen: trace.txSeen,
          origin_confirmed: trace.originConfirmed,
          genesis_fee_payer: trace.genesisFeePayer,
          likely_service: trace.likelyService,
          tx_per_hour: trace.txPerHour,
          last_walk_failed: trace.lastWalkFailed,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'address' }
      );
    if (error) throw new Error(error.message);
  } catch {
    counter.cacheAvailable = false;
  }
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------

interface Edge {
  from: string;
  to: string;
  sol: number;
  at: number;
  signature: string;
}

/**
 * SOL movement between wallets.
 *
 * Reads `nativeTransfers` first, then falls back to balance deltas — a wallet
 * can be the subject of a transaction whose transfer list never names it, since
 * SOL routed through a program shows up only as a balance change. Reading
 * transfers alone reports such a wallet as having no funding at all.
 */
function nativeEdges(transactions: HeliusEnhancedTransaction[]): Edge[] {
  const edges: Edge[] = [];

  for (const tx of transactions) {
    const named = new Set<string>();

    for (const transfer of tx.nativeTransfers ?? []) {
      const { fromUserAccount: from, toUserAccount: to } = transfer;
      if (!from || !to || from === to) continue;

      const sol = (transfer.amount ?? 0) / LAMPORTS_PER_SOL;
      if (sol < MIN_FUNDING_SOL) continue;

      named.add(from);
      named.add(to);
      edges.push({ from, to, sol, at: tx.timestamp, signature: tx.signature });
    }

    const deltas = (tx.accountData ?? [])
      .filter((entry) => entry.account && Math.abs(entry.nativeBalanceChange) > 0)
      .sort((a, b) => a.nativeBalanceChange - b.nativeBalanceChange);
    if (deltas.length < 2) continue;

    const payer = deltas[0];
    if (payer.nativeBalanceChange >= 0) continue;

    for (const entry of deltas) {
      if (entry.account === payer.account || named.has(entry.account)) continue;
      const sol = entry.nativeBalanceChange / LAMPORTS_PER_SOL;
      if (sol < MIN_FUNDING_SOL) continue;
      edges.push({
        from: payer.account,
        to: entry.account,
        sol,
        at: tx.timestamp,
        signature: tx.signature,
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Ensures a wallet has been walked to at least `targetPages`, resuming from the
 * cached cursor rather than restarting.
 *
 * Returns immediately when the cache already satisfies the request — which is
 * the whole point, since the same sniper wallets recur across launches.
 */
export async function ensureTrace(
  address: string,
  targetPages: number,
  counter: WalkCounter,
  opts: { needOutbound?: boolean } = {}
): Promise<WalletTrace> {
  const cached = (await loadTraces([address], counter)).get(address);
  return extendTrace(cached ?? empty(address), targetPages, counter, opts);
}

/** Walks an already-loaded trace deeper. Used by the batch and cron paths. */
export async function extendTrace(
  base: WalletTrace,
  targetPages: number,
  counter: WalkCounter,
  opts: { needOutbound?: boolean } = {}
): Promise<WalletTrace> {
  const trace: WalletTrace = { ...base, fromCache: true };

  // A confirmed origin is permanent — a wallet's first transaction cannot
  // change — so the only reason to walk again is stale outbound behaviour.
  const outboundStale =
    Boolean(opts.needOutbound) && Date.now() - trace.updatedAt > OUTBOUND_TTL_MS;

  if (trace.originConfirmed && !outboundStale) {
    counter.cacheHits += 1;
    return trace;
  }
  if (trace.pagesWalked >= targetPages && !outboundStale) {
    counter.cacheHits += 1;
    return trace;
  }

  counter.cacheMisses += 1;
  trace.fromCache = false;

  // Restarting from the newest transaction is the only way to refresh outbound
  // behaviour; otherwise continue from where the last walk stopped.
  let before = outboundStale ? undefined : (trace.oldestSignature ?? undefined);
  if (outboundStale) {
    trace.pagesWalked = 0;
    trace.outbound = [];
  }

  const collected: HeliusEnhancedTransaction[] = [];
  let failed = false;
  let reachedGenesis = trace.originConfirmed;

  while (trace.pagesWalked < targetPages) {
    counter.requests += 1;

    let batch: HeliusEnhancedTransaction[];
    try {
      batch = await helius.getEnhancedHistory(address(trace), { limit: 100, before });
    } catch {
      // A rate limit is missing evidence, never evidence of absence.
      failed = true;
      counter.failures += 1;
      break;
    }

    trace.pagesWalked += 1;

    if (!batch.length) {
      reachedGenesis = true;
      break;
    }

    collected.push(...batch);
    trace.txSeen += batch.length;

    const oldest = batch[batch.length - 1];
    trace.oldestSignature = oldest.signature;
    trace.oldestBlockTime = oldest.timestamp;
    if (trace.newestBlockTime === null || batch[0].timestamp > trace.newestBlockTime) {
      trace.newestBlockTime = batch[0].timestamp;
    }

    if (batch.length < 100) {
      reachedGenesis = true;
      break;
    }
    before = oldest.signature;
  }

  trace.originConfirmed = reachedGenesis && !failed;
  trace.lastWalkFailed = failed;

  if (trace.originConfirmed && collected.length) {
    trace.genesisFeePayer = collected[collected.length - 1]?.feePayer ?? trace.genesisFeePayer;
  }

  if (collected.length) {
    const edges = nativeEdges(collected);
    const self = address(trace);

    // Inbound: keep the earliest distinct sources seen so far. New pages are
    // older than anything already stored, so they take precedence.
    const inbound = [...edges.filter((e) => e.to === self), ...toEdges(trace.inbound, self)].sort(
      (a, b) => a.at - b.at
    );
    const seen = new Set<string>();
    const kept: TraceSource[] = [];
    for (const edge of inbound) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      kept.push({ address: edge.from, sol: edge.sol, at: edge.at, signature: edge.signature });
      if (kept.length >= MAX_INBOUND) break;
    }
    trace.inbound = kept;

    // Outbound: union, largest first.
    const totals = new Map<string, number>(trace.outbound.map((r) => [r.address, r.sol]));
    for (const edge of edges) {
      if (edge.from !== self) continue;
      totals.set(edge.to, (totals.get(edge.to) ?? 0) + edge.sol);
    }
    trace.outbound = [...totals.entries()]
      .map(([addr, sol]) => ({ address: addr, sol }))
      .sort((a, b) => b.sol - a.sol)
      .slice(0, MAX_OUTBOUND);

    // Velocity, from the densest window we have seen.
    if (trace.newestBlockTime !== null && trace.oldestBlockTime !== null) {
      const hours = Math.max((trace.newestBlockTime - trace.oldestBlockTime) / 3600, 1 / 60);
      trace.txPerHour = Number((trace.txSeen / hours).toFixed(2));
      trace.likelyService = trace.txPerHour >= SERVICE_TX_PER_HOUR;
    }
  }

  trace.updatedAt = Date.now();
  await saveTrace(trace, counter);
  return trace;
}

/** The address a trace belongs to. Kept as a helper for readability above. */
function address(trace: WalletTrace): string {
  return trace.address;
}

function toEdges(sources: TraceSource[], to: string): Edge[] {
  return sources.map((s) => ({ from: s.address, to, sol: s.sol, at: s.at, signature: s.signature }));
}

/** Wallets whose origin is still unknown, least recently walked first. */
export async function listUnconfirmedTraces(limit: number): Promise<WalletTrace[]> {
  const { data, error } = await db()
    .from('wallet_traces')
    .select('*')
    .eq('origin_confirmed', false)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listUnconfirmedTraces: ${error.message}`);
  return ((data ?? []) as TraceRow[]).map(fromRow);
}
