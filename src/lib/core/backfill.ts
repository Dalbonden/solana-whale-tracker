/**
 * Historical trade backfill.
 *
 * `syncWhale` only ever moves forward from a wallet's cursor, so the tracker
 * knows nothing about a whale before the day it was discovered. The visible
 * consequence: almost every position we hold is one we only ever watched being
 * *sold*, cost basis unknown, P&L blank. Waiting for that to resolve itself
 * means waiting months, and it never fully resolves for a wallet that is
 * distributing a bag it accumulated last cycle.
 *
 * So we walk each whale's history backwards instead.
 *
 * The hard part is not fetching — it is pricing. A backfilled trade must be
 * valued at the price when it happened; valuing it at today's price would
 * fabricate a cost basis and produce confident, wrong P&L. That is worse than
 * the blank it replaces, so trades we cannot price historically are skipped
 * rather than stored at a guess.
 */

import { config } from '@/lib/config';
import {
  getOldestTradeSignature,
  insertTrades,
  markBackfill,
  filterNewTrades,
} from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as helius from '@/lib/providers/helius';
import { QUOTE_MINTS } from '@/lib/solana/constants';
import { mintsToPrice, parseSwaps, valueSwapUsd } from '@/lib/solana/parse';
import type { ParsedSwap, Whale, WhaleTrade } from '@/types';

import { createMemeFilter } from './meme-filter';
import { rebuildWhalePositions } from './rebuild-positions';

export interface BackfillResult {
  address: string;
  scanned: number;
  parsed: number;
  priced: number;
  unpriceable: number;
  stored: number;
  positions: number;
  reachedEnd: boolean;
  oldestSignature: string | null;
  oldestBlockTime: string | null;
}

/**
 * Pages one whale's history backwards and ingests any meme swaps found.
 *
 * Resumable: each run starts from the oldest transaction already stored, so
 * repeated calls keep reaching further back instead of re-reading the same
 * page. `reachedEnd` reports that Helius returned nothing older.
 */
export async function backfillWhale(
  whale: Whale,
  opts: { maxTransactions?: number } = {}
): Promise<BackfillResult> {
  const maxTransactions = opts.maxTransactions ?? config.limits.backfillTxPerWhale;
  const isTracked = await createMemeFilter();

  const empty: BackfillResult = {
    address: whale.address,
    scanned: 0,
    parsed: 0,
    priced: 0,
    unpriceable: 0,
    stored: 0,
    positions: 0,
    reachedEnd: false,
    oldestSignature: null,
    oldestBlockTime: null,
  };

  // Resume from where the last run stopped, falling back to the oldest trade we
  // already hold. Without this every run would re-read the newest page.
  const cursor = whale.backfill_cursor ?? (await getOldestTradeSignature(whale.address));

  const transactions: helius.HeliusEnhancedTransaction[] = [];
  let before: string | undefined = cursor ?? undefined;
  let reachedEnd = false;

  while (transactions.length < maxTransactions) {
    const page: helius.HeliusEnhancedTransaction[] = await helius.getEnhancedHistory(
      whale.address,
      { limit: Math.min(100, maxTransactions - transactions.length), before }
    );

    if (!page.length) {
      reachedEnd = true;
      break;
    }

    transactions.push(...page);
    before = page[page.length - 1]?.signature;
    if (page.length < 100) {
      reachedEnd = true;
      break;
    }
  }

  if (!transactions.length) {
    await markBackfill(whale.address, { cursor: cursor ?? null, complete: reachedEnd });
    return { ...empty, reachedEnd, oldestSignature: cursor ?? null };
  }

  const oldest = transactions[transactions.length - 1];
  const swaps = transactions.flatMap((tx) => parseSwaps(tx, whale.address, isTracked));

  if (!swaps.length) {
    // No meme activity in this stretch, but the cursor must still advance or
    // the next run would scan the same quiet period forever.
    await markBackfill(whale.address, { cursor: oldest.signature, complete: reachedEnd });
    return {
      ...empty,
      scanned: transactions.length,
      reachedEnd,
      oldestSignature: oldest.signature,
      oldestBlockTime: new Date(oldest.timestamp * 1000).toISOString(),
    };
  }

  const stored = await priceAndStore(swaps, whale.address);

  await markBackfill(whale.address, { cursor: oldest.signature, complete: reachedEnd });

  // Rebuilding is what actually turns the new trades into cost basis. It is
  // idempotent, so doing it per whale here costs only time.
  const rebuilt = stored.stored > 0 ? await rebuildWhalePositions(whale.address) : null;

  return {
    address: whale.address,
    scanned: transactions.length,
    parsed: swaps.length,
    priced: stored.priced,
    unpriceable: stored.unpriceable,
    stored: stored.stored,
    positions: rebuilt?.positions ?? 0,
    reachedEnd,
    oldestSignature: oldest.signature,
    oldestBlockTime: new Date(oldest.timestamp * 1000).toISOString(),
  };
}

/**
 * Values swaps at the price that applied when each one happened, then stores
 * the ones we could price.
 */
async function priceAndStore(
  swaps: ParsedSwap[],
  address: string
): Promise<{ priced: number; unpriceable: number; stored: number }> {
  const times = swaps.map((s) => Math.floor(s.blockTime.getTime() / 1000));
  const history = await birdeye.buildHistoricalPrices(
    mintsToPrice(swaps),
    Math.min(...times),
    Math.max(...times)
  );

  const rows: Partial<WhaleTrade>[] = [];
  let unpriceable = 0;

  for (const swap of swaps) {
    const at = Math.floor(swap.blockTime.getTime() / 1000);

    // A price map per trade, so `valueSwapUsd` keeps its quote-leg preference
    // and its behaviour stays identical to the live path.
    const prices = new Map<string, number>();
    for (const mint of [swap.tokenMint, swap.quoteMint].filter(Boolean) as string[]) {
      const price = history.priceAt(mint, at);
      if (price !== null) prices.set(mint, price);
    }

    const { usdValue, priceUsd } = valueSwapUsd(swap, prices);
    if (usdValue <= 0) {
      // No historical price for either leg. Storing it at $0 would corrupt the
      // cost basis of every later trade in the position.
      unpriceable += 1;
      continue;
    }

    rows.push({
      signature: swap.signature,
      whale_address: address,
      slot: swap.slot,
      block_time: swap.blockTime.toISOString(),
      side: swap.side,
      venue: swap.venue,
      token_mint: swap.tokenMint,
      token_symbol: null,
      token_amount: swap.tokenAmount,
      quote_mint: swap.quoteMint,
      quote_symbol: swap.quoteMint ? (QUOTE_MINTS[swap.quoteMint]?.symbol ?? null) : null,
      quote_amount: swap.quoteAmount,
      usd_value: Number(usdValue.toFixed(2)),
      price_usd: priceUsd,
      // Position flags are left at their defaults: this trade is historical, so
      // the flags are meaningless until the whole history is replayed. The
      // rebuild recomputes them from the full ordering.
      is_new_position: false,
      is_full_exit: false,
      cost_basis_usd: null,
      realized_pnl_usd: null,
      realized_pnl_pct: null,
      raw: null,
    });
  }

  if (!rows.length) return { priced: 0, unpriceable, stored: 0 };

  // Alerts are deliberately NOT generated. These are historical fills; firing
  // "whale bought WIF" for a trade from three weeks ago would be noise at best
  // and misleading at worst.
  const fresh = await filterNewTrades(rows);
  const inserted = fresh.length ? await insertTrades(fresh) : [];

  return { priced: rows.length, unpriceable, stored: inserted.length };
}

export async function backfillWhales(
  whales: Whale[],
  opts: { maxTransactions?: number } = {}
): Promise<{ results: BackfillResult[]; errors: Array<{ address: string; error: string }> }> {
  const results: BackfillResult[] = [];
  const errors: Array<{ address: string; error: string }> = [];

  // Serial: Birdeye's free tier is roughly one request a second, and this job
  // is not latency sensitive.
  for (const whale of whales) {
    try {
      results.push(await backfillWhale(whale, opts));
    } catch (error) {
      errors.push({ address: whale.address, error: (error as Error).message });
    }
  }

  return { results, errors };
}
