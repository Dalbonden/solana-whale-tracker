/**
 * Whale activity tracking: chain data → priced, classified, persisted trades.
 *
 * Two entry points feed the same pipeline:
 *   - `syncWhale`      polling path, run by the sync cron. Pages Helius history
 *                      from the whale's stored signature cursor.
 *   - `ingestTransactions`  push path, run by the Helius webhook. Same parsing,
 *                      pricing and alerting, just triggered in real time.
 *
 * Keeping both on one code path is what makes the webhook and the cron safely
 * redundant: whichever sees a transaction first stores it, and the unique
 * constraint makes the second one a no-op.
 */

import { config } from '@/lib/config';
import {
  filterNewTrades,
  getOpenPositions,
  getToken,
  insertTrades,
  markWhaleSynced,
  upsertPositions,
  upsertWhales,
} from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import * as helius from '@/lib/providers/helius';
import type { HeliusEnhancedTransaction } from '@/lib/providers/helius';
import { QUOTE_MINTS } from '@/lib/solana/constants';
import {
  mintsToPrice,
  parseSwaps,
  parseSwapsForWallets,
  valueSwapUsd,
} from '@/lib/solana/parse';
import type { ParsedSwap, Whale, WhaleTrade } from '@/types';

import { generateAlerts } from './alerts';
import { createMemeFilter } from './meme-filter';
import { applyTrade, stateFromRow, stateToRow, type PositionState } from './positions';

export interface IngestResult {
  parsed: number;
  stored: number;
  alerts: number;
  latestSignature: string | null;
  latestBlockTime: Date | null;
}

/** Symbol lookup with a per-invocation cache; ingest hits the same mints a lot. */
const symbolCache = new Map<string, string | null>();

async function symbolFor(mint: string): Promise<string | null> {
  if (symbolCache.has(mint)) return symbolCache.get(mint) ?? null;
  const quote = QUOTE_MINTS[mint];
  if (quote) {
    symbolCache.set(mint, quote.symbol);
    return quote.symbol;
  }
  const token = await getToken(mint).catch(() => null);
  const symbol = token?.symbol ?? null;
  symbolCache.set(mint, symbol);
  return symbol;
}

/**
 * Prices, classifies and stores a batch of parsed swaps, then runs the alert
 * rules over whatever was genuinely new.
 *
 * Runs in two phases against the position ledger:
 *
 *   1. Drop trades already stored, *before* any position arithmetic. The webhook
 *      and the polling cron deliberately overlap, so the same swap arrives
 *      twice routinely. Deduplicating only at insert time would be too late —
 *      the position would already have absorbed the buy twice, and every later
 *      trade in the batch would be classified against an inflated balance.
 *   2. Replay the survivors through the position state machine in chronological
 *      order, then persist trades and positions together.
 *
 * This replaces a per-trade replay of the whale's entire history, which was
 * O(history) on the webhook hot path and grew with every trade ingested.
 */
export async function persistSwaps(swaps: ParsedSwap[]): Promise<IngestResult> {
  if (!swaps.length) {
    return { parsed: 0, stored: 0, alerts: 0, latestSignature: null, latestBlockTime: null };
  }

  const prices = await birdeye.getPrices(mintsToPrice(swaps));

  // Chronological order is what makes the new-position / full-exit flags
  // correct: each trade is classified against the position the earlier ones
  // built.
  const ordered = [...swaps].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());

  const priced = ordered.map((swap) => ({ swap, ...valueSwapUsd(swap, prices) }));

  // --- phase 1: drop what we already have --------------------------------
  const candidates = priced.map(({ swap }) => ({
    signature: swap.signature,
    whale_address: swap.wallet,
    token_mint: swap.tokenMint,
    side: swap.side,
  }));
  const fresh = new Set(
    (await filterNewTrades(candidates)).map(
      (row) => `${row.signature}:${row.whale_address}:${row.token_mint}:${row.side}`
    )
  );
  const incoming = priced.filter(({ swap }) =>
    fresh.has(`${swap.signature}:${swap.wallet}:${swap.tokenMint}:${swap.side}`)
  );

  if (!incoming.length) {
    const newest = ordered[ordered.length - 1];
    return {
      parsed: swaps.length,
      stored: 0,
      alerts: 0,
      latestSignature: newest?.signature ?? null,
      latestBlockTime: newest?.blockTime ?? null,
    };
  }

  // --- phase 2: replay through the position ledger ------------------------
  const openPositions = await getOpenPositions(
    incoming.map(({ swap }) => ({ whale: swap.wallet, mint: swap.tokenMint }))
  );

  const states = new Map<string, PositionState>();
  const symbols = new Map<string, string | null>();
  const rows: Partial<WhaleTrade>[] = [];

  for (const { swap, usdValue, priceUsd } of incoming) {
    const key = `${swap.wallet}:${swap.tokenMint}`;
    const existing = states.get(key) ?? (openPositions.has(key) ? stateFromRow(openPositions.get(key)!) : null);

    const { state, classification } = applyTrade(
      existing,
      {
        signature: swap.signature,
        side: swap.side,
        tokenAmount: swap.tokenAmount,
        usdValue,
        blockTime: swap.blockTime,
      },
      { fullExitResidual: config.alerts.fullExitResidual }
    );
    states.set(key, state);

    const symbol = await symbolFor(swap.tokenMint);
    symbols.set(swap.tokenMint, symbol);

    rows.push({
      signature: swap.signature,
      whale_address: swap.wallet,
      slot: swap.slot,
      block_time: swap.blockTime.toISOString(),
      side: swap.side,
      venue: swap.venue,
      token_mint: swap.tokenMint,
      token_symbol: symbol,
      token_amount: swap.tokenAmount,
      quote_mint: swap.quoteMint,
      quote_symbol: swap.quoteMint ? await symbolFor(swap.quoteMint) : null,
      quote_amount: swap.quoteAmount,
      usd_value: Number(usdValue.toFixed(2)),
      price_usd: priceUsd,
      is_new_position: classification.isNewPosition,
      is_full_exit: classification.isFullExit,
      cost_basis_usd: classification.costBasisUsd,
      realized_pnl_usd: classification.realizedPnlUsd,
      realized_pnl_pct: classification.realizedPnlPct,
      raw: null,
    });
  }

  const stored = await insertTrades(rows);

  // Positions are written after the trades they summarise. A concurrent writer
  // racing us here would leave the ledger slightly ahead of the trade table;
  // `/api/cron/rebuild-positions` recomputes it from the trades and repairs
  // that, which is why the rebuild is idempotent by construction.
  const positionRows = [...states.entries()].map(([key, state]) => {
    const [whaleAddress, tokenMint] = key.split(':');
    return stateToRow(whaleAddress, tokenMint, symbols.get(tokenMint) ?? null, state);
  });
  await upsertPositions(positionRows).catch((error) => {
    // A failed ledger write must not lose the trades that already landed.
    console.error('[positions] upsert failed, rebuild will repair:', (error as Error).message);
  });

  const alerts = stored.length ? await generateAlerts(stored) : [];
  const newest = ordered[ordered.length - 1];

  return {
    parsed: swaps.length,
    stored: stored.length,
    alerts: alerts.length,
    latestSignature: newest?.signature ?? null,
    latestBlockTime: newest?.blockTime ?? null,
  };
}

/**
 * Polls one whale's history forward from its stored cursor and ingests any new
 * meme-token swaps.
 */
export async function syncWhale(whale: Whale): Promise<IngestResult> {
  const isTracked = await createMemeFilter();

  const transactions = await helius.getHistorySince(
    whale.address,
    whale.last_signature,
    config.limits.txPerWhale
  );

  if (!transactions.length) {
    await markWhaleSynced(whale.address, null, null);
    return { parsed: 0, stored: 0, alerts: 0, latestSignature: null, latestBlockTime: null };
  }

  const swaps = transactions.flatMap((tx) => parseSwaps(tx, whale.address, isTracked));
  const result = await persistSwaps(swaps);

  // Advance the cursor to the newest transaction seen, not the newest *trade*.
  // Otherwise a whale whose recent activity is all non-meme transfers would be
  // re-scanned from the same point forever.
  const newestTx = transactions[0];
  await markWhaleSynced(
    whale.address,
    newestTx?.signature ?? null,
    result.latestBlockTime ?? (newestTx ? new Date(newestTx.timestamp * 1000) : null)
  );

  return result;
}

/** Syncs a batch of whales with bounded concurrency. */
export async function syncWhales(whales: Whale[]): Promise<{
  synced: number;
  failed: number;
  totals: IngestResult;
  errors: Array<{ address: string; error: string }>;
}> {
  const { mapWithConcurrency } = await import('@/lib/providers/http');

  const totals: IngestResult = {
    parsed: 0,
    stored: 0,
    alerts: 0,
    latestSignature: null,
    latestBlockTime: null,
  };
  const errors: Array<{ address: string; error: string }> = [];
  let synced = 0;

  await mapWithConcurrency(whales, 4, async (whale) => {
    try {
      const result = await syncWhale(whale);
      totals.parsed += result.parsed;
      totals.stored += result.stored;
      totals.alerts += result.alerts;
      synced++;
    } catch (error) {
      errors.push({ address: whale.address, error: (error as Error).message });
    }
  });

  return { synced, failed: errors.length, totals, errors };
}

/**
 * Webhook path: one payload, many transactions, possibly several tracked
 * wallets per transaction.
 */
export async function ingestTransactions(
  transactions: HeliusEnhancedTransaction[],
  trackedWallets: Set<string>
): Promise<IngestResult> {
  if (!transactions.length || !trackedWallets.size) {
    return { parsed: 0, stored: 0, alerts: 0, latestSignature: null, latestBlockTime: null };
  }

  const isTracked = await createMemeFilter();
  const swaps = transactions.flatMap((tx) =>
    parseSwapsForWallets(tx, trackedWallets, isTracked)
  );

  const result = await persistSwaps(swaps);

  // Keep each whale's cursor and activity timestamp current so the polling
  // cron does not re-scan what the webhook already delivered.
  const perWallet = new Map<string, { signature: string; time: Date }>();
  for (const swap of swaps) {
    const existing = perWallet.get(swap.wallet);
    if (!existing || swap.blockTime > existing.time) {
      perWallet.set(swap.wallet, { signature: swap.signature, time: swap.blockTime });
    }
  }
  for (const [address, latest] of perWallet) {
    await markWhaleSynced(address, latest.signature, latest.time).catch(() => undefined);
  }

  return result;
}

/**
 * Adds a wallet to tracking on demand (manual `POST /api/whales`), then
 * backfills its recent history so the profile page is not empty on first view.
 */
export async function trackWhale(
  address: string,
  overrides: Partial<Whale> = {}
): Promise<{ whale: Partial<Whale>; backfill: IngestResult }> {
  const { evaluateWallet } = await import('./whale-detection');
  const evaluation = await evaluateWallet(address, { source: 'manual' });

  const whale: Partial<Whale> = {
    address,
    is_tracked: true,
    discovery_source: 'manual',
    ...(evaluation.whale ?? {
      portfolio_value_usd: Number(evaluation.metrics.portfolioValueUsd.toFixed(2)),
      meme_value_usd: Number(evaluation.metrics.memeValueUsd.toFixed(2)),
      meme_exposure_pct: Number(evaluation.metrics.memeExposurePct.toFixed(4)),
      score: evaluation.score.score,
      tier: evaluation.score.tier,
    }),
    ...overrides,
  };

  await upsertWhales([whale]);

  const backfill = await syncWhale({
    ...(whale as Whale),
    last_signature: null,
  }).catch(() => ({
    parsed: 0,
    stored: 0,
    alerts: 0,
    latestSignature: null,
    latestBlockTime: null,
  }));

  return { whale, backfill };
}
