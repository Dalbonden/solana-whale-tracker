/**
 * Position lifecycle.
 *
 * A position is one entry → exit *cycle*, not a running total. Buying WIF,
 * selling all of it, then buying again three weeks later is two positions, and
 * conflating them would report a 21-day hold on a trade that was held for an
 * hour.
 *
 * This module owns the arithmetic and nothing else — no I/O — so the ingest
 * path and the rebuild job run byte-identical logic. That matters: the whole
 * point of storing positions is that the stored numbers agree with what a
 * replay of the trades would produce.
 *
 * Accounting is average cost, matching what the P&L column already showed
 * before positions existed. Cost basis is only ever built from buys we
 * actually observed, so a wallet that entered before tracking began reports
 * `basis_complete = false` and null P&L rather than a fabricated profit.
 */

import type { TradeSide, WhalePosition } from '@/types';

/**
 * Residual below which a sell counts as closing the position. Callers pass the
 * configured value; this default exists so the module stays free of runtime
 * imports and can be compiled and tested on its own.
 */
export const DEFAULT_FULL_EXIT_RESIDUAL = 0.05;

/** The mutable part of a position — everything the state machine touches. */
export interface PositionState {
  /**
   * Signature of the trade that opened this cycle. Its identity, because
   * `opened_at` is not unique — Solana packs many swaps into one second, so a
   * sell that closes a cycle and a buy that opens the next routinely share a
   * timestamp.
   */
  openedBySignature: string;
  amount: number;
  costBasisUsd: number;
  avgEntryPrice: number | null;
  totalBoughtUsd: number;
  totalSoldUsd: number;
  realizedPnlUsd: number;
  buyCount: number;
  sellCount: number;
  basisComplete: boolean;
  status: 'open' | 'closed';
  openedAt: Date;
  closedAt: Date | null;
  lastTradeAt: Date;
}

export interface TradeInput {
  signature: string;
  side: TradeSide;
  tokenAmount: number;
  usdValue: number;
  blockTime: Date;
}

/** What the alert rules need to know about a trade, once positioned. */
export interface PositionClassification {
  isNewPosition: boolean;
  isFullExit: boolean;
  /** Average USD cost of the tokens sold. Null when basis was never observed. */
  costBasisUsd: number | null;
  /** Profit or loss on a sell. Null for buys and unknown-basis sells. */
  realizedPnlUsd: number | null;
  /** Same as a fraction of cost, e.g. 0.42 = +42%. */
  realizedPnlPct: number | null;
}

export function emptyState(openedAt: Date, openedBySignature: string): PositionState {
  return {
    openedBySignature,
    amount: 0,
    costBasisUsd: 0,
    avgEntryPrice: null,
    totalBoughtUsd: 0,
    totalSoldUsd: 0,
    realizedPnlUsd: 0,
    buyCount: 0,
    sellCount: 0,
    basisComplete: true,
    status: 'open',
    openedAt,
    closedAt: null,
    lastTradeAt: openedAt,
  };
}

export function stateFromRow(row: WhalePosition): PositionState {
  return {
    openedBySignature: row.opened_by_signature,
    amount: Number(row.amount) || 0,
    costBasisUsd: Number(row.cost_basis_usd) || 0,
    avgEntryPrice: row.avg_entry_price === null ? null : Number(row.avg_entry_price),
    totalBoughtUsd: Number(row.total_bought_usd) || 0,
    totalSoldUsd: Number(row.total_sold_usd) || 0,
    realizedPnlUsd: Number(row.realized_pnl_usd) || 0,
    buyCount: row.buy_count ?? 0,
    sellCount: row.sell_count ?? 0,
    basisComplete: row.basis_complete,
    status: row.status,
    openedAt: new Date(row.opened_at),
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
    lastTradeAt: new Date(row.last_trade_at),
  };
}

/**
 * Applies one trade to a position, returning the new state and the
 * classification for that trade.
 *
 * `state` is null when no open cycle exists — either the whale has never
 * touched this token, or the last cycle was closed. A buy in that situation
 * opens a new cycle, which is what `is_new_position` has always meant.
 *
 * Pure: it does not mutate the state passed in.
 */
export function applyTrade(
  state: PositionState | null,
  trade: TradeInput,
  opts: { fullExitResidual?: number } = {}
): { state: PositionState; classification: PositionClassification } {
  const fullExitResidual = opts.fullExitResidual ?? DEFAULT_FULL_EXIT_RESIDUAL;

  // Only a buy can open a cycle. A sell against a closed or unknown position
  // is an unattributable disposal — it belongs in the existing record rather
  // than opening a new one, otherwise a wallet that has only ever been seen
  // selling produces one position row per sale.
  const opening = trade.side === 'buy' && (state === null || state.status === 'closed');
  const next: PositionState =
    state === null || opening ? emptyState(trade.blockTime, trade.signature) : { ...state };

  // Doubt is inherited. If the previous cycle for this token ended without a
  // basis we could observe, the whale may still hold inventory we never saw,
  // and any P&L on the new cycle would be measured against a partial position.
  if (opening && state !== null && !state.basisComplete) {
    next.basisComplete = false;
  }

  next.lastTradeAt = trade.blockTime;

  // -------------------------------------------------------------------------
  // Buy
  // -------------------------------------------------------------------------
  if (trade.side === 'buy') {
    // A buy into a position we have only ever seen sold (basis unknown) does
    // not repair the missing history, but it does start contributing basis, so
    // the flag stays false while the numbers below stay honest about it.
    next.amount += trade.tokenAmount;
    next.costBasisUsd += trade.usdValue;
    next.totalBoughtUsd += trade.usdValue;
    next.buyCount += 1;
    next.status = 'open';
    next.closedAt = null;
    next.avgEntryPrice = next.amount > 0 ? next.costBasisUsd / next.amount : null;

    return {
      state: next,
      classification: {
        isNewPosition: opening,
        isFullExit: false,
        costBasisUsd: null,
        realizedPnlUsd: null,
        realizedPnlPct: null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Sell
  // -------------------------------------------------------------------------
  const heldBefore = next.amount;

  next.totalSoldUsd += trade.usdValue;
  next.sellCount += 1;

  // Selling something we never saw bought. The entry predates tracking, so the
  // basis is genuinely unknown — record the sale, claim no P&L, and mark the
  // cycle incomplete so every downstream metric can exclude it.
  if (heldBefore <= 0) {
    // Only doubt a cycle whose buys we never saw. A dust sale after a clean
    // exit should not retroactively void the P&L of the cycle it followed.
    if (next.buyCount === 0) next.basisComplete = false;

    next.amount = 0;
    next.costBasisUsd = 0;
    next.avgEntryPrice = null;

    // Nothing is held, so the cycle is not open — it is a record of disposals
    // we cannot attribute. Leaving it 'open' would render as a live position
    // holding zero tokens.
    next.status = 'closed';
    next.closedAt = trade.blockTime;

    return {
      state: next,
      classification: {
        isNewPosition: false,
        // Not a full exit: we cannot claim to have closed a position we never
        // saw opened, and the rotation rules key off that claim.
        isFullExit: false,
        costBasisUsd: null,
        realizedPnlUsd: null,
        realizedPnlPct: null,
      },
    };
  }

  // Selling more than we ever saw bought proves inventory we never observed,
  // which makes this cycle's accounting partial by definition.
  if (trade.tokenAmount > heldBefore) next.basisComplete = false;

  // Only the portion covered by observed buys can be scored. Selling more than
  // we ever saw bought means the remainder came from an entry we did not see.
  const attributable = Math.min(trade.tokenAmount, heldBefore);
  const avgCost = next.costBasisUsd > 0 ? next.costBasisUsd / heldBefore : null;

  let costBasisUsd: number | null = null;
  let realizedPnlUsd: number | null = null;
  let realizedPnlPct: number | null = null;

  if (avgCost !== null && attributable > 0 && trade.usdValue > 0 && trade.tokenAmount > 0) {
    const proceeds = trade.usdValue * (attributable / trade.tokenAmount);
    costBasisUsd = avgCost * attributable;
    realizedPnlUsd = proceeds - costBasisUsd;
    realizedPnlPct = costBasisUsd > 0 ? realizedPnlUsd / costBasisUsd : null;
    next.realizedPnlUsd += realizedPnlUsd;
    next.costBasisUsd = Math.max(next.costBasisUsd - costBasisUsd, 0);
  }

  const remaining = Math.max(heldBefore - trade.tokenAmount, 0);
  next.amount = remaining;
  next.avgEntryPrice = remaining > 0 && next.costBasisUsd > 0 ? next.costBasisUsd / remaining : null;

  // "Full exit" is a residual test, not equality: dust left behind by rounding
  // or a fee-on-transfer token should still close the position.
  const isFullExit = remaining / heldBefore <= fullExitResidual;
  if (isFullExit) {
    next.status = 'closed';
    next.closedAt = trade.blockTime;
    // Any residual basis belongs to dust; leaving it would inflate the next
    // cycle's cost if the whale re-enters.
    next.costBasisUsd = 0;
    next.avgEntryPrice = null;
  }

  return {
    state: next,
    classification: { isNewPosition: false, isFullExit, costBasisUsd, realizedPnlUsd, realizedPnlPct },
  };
}

/** Serialises state into the row shape, for upsert. */
export function stateToRow(
  whaleAddress: string,
  tokenMint: string,
  tokenSymbol: string | null,
  state: PositionState
): Partial<WhalePosition> {
  return {
    whale_address: whaleAddress,
    token_mint: tokenMint,
    token_symbol: tokenSymbol,
    opened_by_signature: state.openedBySignature,
    status: state.status,
    amount: state.amount,
    cost_basis_usd: Number(state.costBasisUsd.toFixed(2)),
    avg_entry_price: state.avgEntryPrice,
    total_bought_usd: Number(state.totalBoughtUsd.toFixed(2)),
    total_sold_usd: Number(state.totalSoldUsd.toFixed(2)),
    realized_pnl_usd: Number(state.realizedPnlUsd.toFixed(2)),
    buy_count: state.buyCount,
    sell_count: state.sellCount,
    basis_complete: state.basisComplete,
    opened_at: state.openedAt.toISOString(),
    closed_at: state.closedAt ? state.closedAt.toISOString() : null,
    last_trade_at: state.lastTradeAt.toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read-side derivations
// ---------------------------------------------------------------------------

export interface PositionView extends WhalePosition {
  /** Current price from the token cache, or null when no feed covers it. */
  price_usd: number | null;
  /** Value of the units still held. Null when unpriced. */
  market_value_usd: number | null;
  /** Mark-to-market gain on the open portion. Null without price or basis. */
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
  /** Realised + unrealised. Null when either half is unknowable. */
  total_pnl_usd: number | null;
  /** Position value as a share of the whale's portfolio. Null when unpriced. */
  conviction_pct: number | null;
  /** Hours from entry to exit, or to now while open. */
  hold_hours: number;
}

export function derivePositionView(
  row: WhalePosition,
  priceUsd: number | null,
  portfolioValueUsd: number
): PositionView {
  const amount = Number(row.amount) || 0;
  const costBasis = Number(row.cost_basis_usd) || 0;
  const realized = Number(row.realized_pnl_usd) || 0;

  const marketValue = priceUsd !== null ? amount * priceUsd : null;

  // Unrealised P&L needs both a price and a basis we actually observed.
  // Missing either produces null, never zero — zero reads as "flat", which is
  // a claim we have not earned.
  const unrealized =
    marketValue !== null && row.basis_complete && costBasis > 0 ? marketValue - costBasis : null;

  const endedAt = row.closed_at ? new Date(row.closed_at) : new Date();
  const holdHours = (endedAt.getTime() - new Date(row.opened_at).getTime()) / 3_600_000;

  return {
    ...row,
    price_usd: priceUsd,
    market_value_usd: marketValue,
    unrealized_pnl_usd: unrealized,
    unrealized_pnl_pct: unrealized !== null && costBasis > 0 ? unrealized / costBasis : null,
    total_pnl_usd: row.basis_complete ? realized + (unrealized ?? 0) : null,
    conviction_pct:
      marketValue !== null && portfolioValueUsd > 0 ? marketValue / portfolioValueUsd : null,
    hold_hours: Math.max(holdHours, 0),
  };
}
