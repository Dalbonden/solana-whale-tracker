/**
 * Rebuilds the position ledger from stored trades.
 *
 * Two jobs in one:
 *   - backfill, so wallets tracked before `whale_positions` existed get their
 *     history without waiting for new activity;
 *   - repair, because the ingest path writes trades and positions in separate
 *     statements and a crash between them would leave the ledger short.
 *
 * Idempotent by construction: a whale's positions are deleted and recomputed
 * from the trade table, which is the source of truth. Running it twice produces
 * the same rows as running it once.
 */

import { config } from '@/lib/config';
import {
  deletePositionsForWhale,
  getAllTradesForWhale,
  updateTradeClassifications,
  upsertPositions,
} from '@/lib/db/repositories';
import type { WhalePosition, WhaleTrade } from '@/types';

import { applyTrade, stateToRow, type PositionState } from './positions';

/** Money is stored to the cent; nulls stay null rather than becoming 0. */
function round2(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

export interface RebuildResult {
  address: string;
  trades: number;
  positions: number;
  /** Trades whose own P&L fields were recomputed from the replay. */
  reclassified: number;
  open: number;
  incompleteBasis: number;
}

/**
 * Replays one whale's trades into position rows.
 *
 * Pure apart from the two database calls, and deliberately so — the replay uses
 * the same `applyTrade` the webhook uses, which is what guarantees a rebuilt
 * ledger matches an incrementally-built one.
 */
export async function rebuildWhalePositions(address: string): Promise<RebuildResult> {
  const trades = await getAllTradesForWhale(address);

  // Every cycle per token, oldest first. The last entry is the one a new trade
  // continues — closed or not. Retiring closed cycles from this map would be
  // wrong: `applyTrade` alone decides when a cycle ends, and a run of sells we
  // cannot attribute belongs in one record rather than one record per sale.
  const cycles = new Map<string, Array<{ symbol: string | null; state: PositionState }>>();

  // The replay also re-derives each trade's own classification. Backfilled
  // trades are stored with those fields blank — their flags are meaningless
  // until the full history is ordered — so without writing them back, the P&L
  // column stays empty even once the position ledger knows the cost basis.
  const reclassified: Partial<WhaleTrade>[] = [];

  for (const trade of sortTrades(trades)) {
    const mint = trade.token_mint;
    const history = cycles.get(mint) ?? [];
    const current = history[history.length - 1];

    const { state, classification } = applyTrade(
      current?.state ?? null,
      {
        signature: trade.signature,
        side: trade.side,
        tokenAmount: Number(trade.token_amount) || 0,
        usdValue: Number(trade.usd_value) || 0,
        blockTime: new Date(trade.block_time),
      },
      { fullExitResidual: config.alerts.fullExitResidual }
    );

    reclassified.push({
      ...trade,
      is_new_position: classification.isNewPosition,
      is_full_exit: classification.isFullExit,
      cost_basis_usd: round2(classification.costBasisUsd),
      realized_pnl_usd: round2(classification.realizedPnlUsd),
      realized_pnl_pct:
        classification.realizedPnlPct === null
          ? null
          : Number(classification.realizedPnlPct.toFixed(6)),
    });

    const entry = { symbol: trade.token_symbol ?? current?.symbol ?? null, state };

    // A changed opening signature is how the state machine signals "this trade
    // started a new cycle" — no second guess about it needed here.
    if (current && current.state.openedBySignature === state.openedBySignature) {
      history[history.length - 1] = entry;
    } else {
      history.push(entry);
    }

    cycles.set(mint, history);
  }

  const rows: Partial<WhalePosition>[] = [];
  let open = 0;
  for (const [mint, history] of cycles) {
    for (const entry of history) {
      if (entry.state.status === 'open') open += 1;
      rows.push(stateToRow(address, mint, entry.symbol, entry.state));
    }
  }

  await deletePositionsForWhale(address);
  if (rows.length) await upsertPositions(rows);
  const reclassifiedCount = await updateTradeClassifications(reclassified);

  return {
    address,
    trades: trades.length,
    positions: rows.length,
    reclassified: reclassifiedCount,
    open,
    incompleteBasis: rows.filter((row) => row.basis_complete === false).length,
  };
}

/**
 * Chronological order, with a deterministic tiebreak.
 *
 * Two legs of the same swap share a block time. Without a stable secondary key
 * the replay order would depend on what Postgres happened to return, and a buy
 * ordered after the sell it funded would classify as a new position. Sorting
 * buys before sells within a timestamp keeps a same-block round trip readable
 * as open-then-close rather than the reverse.
 */
function sortTrades(trades: WhaleTrade[]): WhaleTrade[] {
  return [...trades].sort((a, b) => {
    const at = new Date(a.block_time).getTime();
    const bt = new Date(b.block_time).getTime();
    if (at !== bt) return at - bt;
    if (a.side !== b.side) return a.side === 'buy' ? -1 : 1;
    return a.signature.localeCompare(b.signature);
  });
}

export async function rebuildPositions(addresses: string[]): Promise<{
  results: RebuildResult[];
  errors: Array<{ address: string; error: string }>;
}> {
  const results: RebuildResult[] = [];
  const errors: Array<{ address: string; error: string }> = [];

  // Serial on purpose. This is a repair job, not a hot path, and hammering
  // PostgREST with parallel deletes-then-upserts per whale buys nothing.
  for (const address of addresses) {
    try {
      results.push(await rebuildWhalePositions(address));
    } catch (error) {
      errors.push({ address, error: (error as Error).message });
    }
  }

  return { results, errors };
}
