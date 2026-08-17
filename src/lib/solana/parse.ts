/**
 * Turns a Helius enhanced transaction into zero or more `ParsedSwap` records
 * for a specific wallet.
 *
 * Approach: rather than decoding each AMM's instruction layout, we compute the
 * wallet's *net balance delta* across the transaction. A swap is, by definition,
 * one mint going up and another going down for the same owner. This is layout-
 * agnostic, so it keeps working when Raydium ships a new pool program or a
 * router changes its CPI shape — and it correctly collapses a multi-hop Jupiter
 * route (SOL → USDC → WIF) into the single economic trade the user made.
 */

import type { HeliusEnhancedTransaction } from '@/lib/providers/helius';
import type { ParsedSwap, Venue } from '@/types';

import { NATIVE_SOL, QUOTE_MINTS, venueFromPrograms } from './constants';

/** Balance deltas below this (in token units) are rounding noise, not trades. */
const DUST_EPSILON = 1e-9;

/**
 * SOL deltas smaller than this are fees/rent, not a swap leg. Priority fees on
 * a busy block can reach ~0.01 SOL, so the floor sits above that.
 */
const SOL_NOISE_FLOOR = 0.02;

function collectProgramIds(tx: HeliusEnhancedTransaction): string[] {
  const ids = new Set<string>();
  for (const instruction of tx.instructions ?? []) {
    if (instruction.programId) ids.add(instruction.programId);
    for (const inner of instruction.innerInstructions ?? []) {
      if (inner.programId) ids.add(inner.programId);
    }
  }
  return [...ids];
}

/**
 * Net change per mint for `wallet`, including native SOL as the wrapped-SOL
 * mint so it can be treated as an ordinary quote leg.
 */
export function computeBalanceDeltas(
  tx: HeliusEnhancedTransaction,
  wallet: string
): Map<string, number> {
  const deltas = new Map<string, number>();

  const add = (mint: string, amount: number) => {
    if (!Number.isFinite(amount) || Math.abs(amount) < DUST_EPSILON) return;
    deltas.set(mint, (deltas.get(mint) ?? 0) + amount);
  };

  for (const account of tx.accountData ?? []) {
    // Native SOL moves are attributed to the wallet account itself.
    if (account.account === wallet && account.nativeBalanceChange) {
      add(NATIVE_SOL, account.nativeBalanceChange / 1e9);
    }

    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== wallet) continue;
      const raw = Number(change.rawTokenAmount?.tokenAmount ?? 0);
      const decimals = change.rawTokenAmount?.decimals ?? 0;
      if (!Number.isFinite(raw)) continue;
      add(change.mint, raw / 10 ** decimals);
    }
  }

  // Fall back to tokenTransfers when the indexer omitted accountData — rare,
  // but it happens on some older/compressed transactions.
  if (deltas.size === 0) {
    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.toUserAccount === wallet) add(transfer.mint, transfer.tokenAmount);
      if (transfer.fromUserAccount === wallet) add(transfer.mint, -transfer.tokenAmount);
    }
  }

  // Drop the fee-only SOL noise so a token transfer is not misread as a swap.
  const sol = deltas.get(NATIVE_SOL);
  if (sol !== undefined && Math.abs(sol) < SOL_NOISE_FLOOR) deltas.delete(NATIVE_SOL);

  return deltas;
}

/**
 * True when the wallet both gained and lost value — i.e. this is a trade, not a
 * deposit, withdrawal, airdrop or plain transfer.
 */
function isSwapShape(deltas: Map<string, number>): boolean {
  let gained = false;
  let lost = false;
  for (const amount of deltas.values()) {
    if (amount > 0) gained = true;
    else if (amount < 0) lost = true;
  }
  return gained && lost;
}

/**
 * Extracts the trades a wallet made in one transaction.
 *
 * `isTracked` decides which mints are worth recording — normally "is this an
 * active meme token". Non-tracked mints can still act as the quote leg.
 */
export function parseSwaps(
  tx: HeliusEnhancedTransaction,
  wallet: string,
  isTracked: (mint: string) => boolean
): ParsedSwap[] {
  if (tx.transactionError) return [];

  const deltas = computeBalanceDeltas(tx, wallet);
  if (deltas.size < 2 || !isSwapShape(deltas)) return [];

  const venue: Venue = venueFromPrograms(collectProgramIds(tx));
  const blockTime = new Date((tx.timestamp || 0) * 1000);
  if (!tx.timestamp) return [];

  // Split legs into quote (SOL/stables) and everything else.
  const quoteLegs: Array<{ mint: string; amount: number }> = [];
  const assetLegs: Array<{ mint: string; amount: number }> = [];

  for (const [mint, amount] of deltas) {
    if (QUOTE_MINTS[mint]) quoteLegs.push({ mint, amount });
    else assetLegs.push({ mint, amount });
  }

  const swaps: ParsedSwap[] = [];

  for (const leg of assetLegs) {
    if (!isTracked(leg.mint)) continue;

    const side = leg.amount > 0 ? 'buy' : 'sell';

    // The quote leg moves opposite the asset leg. Pick the largest such leg —
    // on a multi-hop route the intermediate legs net to ~zero, so the biggest
    // opposing quote movement is the one the user actually paid or received.
    const opposing = quoteLegs
      .filter((quote) => (side === 'buy' ? quote.amount < 0 : quote.amount > 0))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];

    swaps.push({
      signature: tx.signature,
      slot: tx.slot,
      blockTime,
      wallet,
      side,
      venue,
      tokenMint: leg.mint,
      tokenAmount: Math.abs(leg.amount),
      quoteMint: opposing?.mint ?? null,
      quoteAmount: opposing ? Math.abs(opposing.amount) : null,
    });
  }

  return swaps;
}

/**
 * Parses every tracked wallet touched by a transaction. Used by the webhook,
 * where one payload can contain a swap by more than one whale we follow.
 */
export function parseSwapsForWallets(
  tx: HeliusEnhancedTransaction,
  wallets: Set<string>,
  isTracked: (mint: string) => boolean
): ParsedSwap[] {
  const involved = new Set<string>();

  for (const account of tx.accountData ?? []) {
    if (wallets.has(account.account)) involved.add(account.account);
    for (const change of account.tokenBalanceChanges ?? []) {
      if (wallets.has(change.userAccount)) involved.add(change.userAccount);
    }
  }
  if (wallets.has(tx.feePayer)) involved.add(tx.feePayer);

  return [...involved].flatMap((wallet) => parseSwaps(tx, wallet, isTracked));
}

/**
 * Prices a swap in USD.
 *
 * The quote leg is preferred: SOL and USDC have deep, reliable prices, whereas
 * a fresh meme token's price feed may lag or be missing entirely. Valuing
 * "0.4 SOL" is accurate; valuing "18,000,000 SOMEMEME" often is not.
 */
export function valueSwapUsd(
  swap: ParsedSwap,
  prices: Map<string, number>
): { usdValue: number; priceUsd: number | null } {
  if (swap.quoteMint && swap.quoteAmount) {
    const quotePrice = prices.get(swap.quoteMint);
    if (quotePrice) {
      const usdValue = swap.quoteAmount * quotePrice;
      const priceUsd = swap.tokenAmount > 0 ? usdValue / swap.tokenAmount : null;
      return { usdValue, priceUsd };
    }
  }

  const tokenPrice = prices.get(swap.tokenMint);
  if (tokenPrice) {
    return { usdValue: swap.tokenAmount * tokenPrice, priceUsd: tokenPrice };
  }

  return { usdValue: 0, priceUsd: null };
}

/** Every mint that needs a price to value this batch of swaps. */
export function mintsToPrice(swaps: ParsedSwap[]): string[] {
  const mints = new Set<string>();
  for (const swap of swaps) {
    mints.add(swap.tokenMint);
    if (swap.quoteMint) mints.add(swap.quoteMint);
  }
  return [...mints];
}
