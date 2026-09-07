/**
 * USD pricing, sourced in cost order.
 *
 * WHY THIS SITS IN FRONT OF BIRDEYE
 *
 * Birdeye's `multi_price` is plan-gated on our key, so `birdeye.getPrices`
 * degrades to one serial request per mint at roughly one per second — and
 * caps itself at `SERIAL_PRICE_CEILING` (40) so an unbounded list cannot eat a
 * job's whole timeout. That cap is a real ceiling on what the product can
 * value: a wallet holding 2,537 mints got 40 of them priced.
 *
 * It is also a *quota* ceiling. The free tier bills compute units per call, and
 * once those run out every Birdeye endpoint answers 400 — token trades,
 * holders and OHLCV included. Pricing that spends the budget one mint at a time
 * is what exhausts it.
 *
 * Jupiter prices 100 mints per keyless request. Measured on the same wallet:
 * 450 of 2,537 mints priced in ~26 calls and 1.7 seconds. So Jupiter goes
 * first for everything, and Birdeye is spent only on mints that Jupiter could
 * not quote *and* the caller marked as critical.
 *
 * WHAT "MISSING" MEANS
 *
 * A mint absent from the result was not priced by anyone. That is the common
 * case — most of a whale's long tail is dust with no live pool — and it is not
 * the same as a price of zero. Callers must keep treating absence as unknown,
 * or a wallet full of unpriceable dust reads as a wallet that lost everything.
 */

import * as birdeye from './birdeye';
import * as jupiter from './jupiter';

export interface PriceOptions {
  /**
   * Mints worth spending Birdeye's metered budget on when Jupiter has no quote.
   *
   * Defaults to every requested mint, which is right for short lists like the
   * mints in one batch of swaps. Callers pricing a whole wallet inventory
   * should narrow this to the mints that actually drive a number a user sees —
   * otherwise the fallback burns the quota on dust.
   */
  critical?: readonly string[];
}

export interface PriceSources {
  jupiter: number;
  birdeye: number;
  missing: number;
}

/**
 * Prices `mints`, preferring Jupiter and falling back to Birdeye for the
 * mints named in `critical`.
 */
export async function getPricesWithSources(
  mints: readonly string[],
  options: PriceOptions = {}
): Promise<{ prices: Map<string, number>; sources: PriceSources }> {
  const unique = [...new Set(mints)].filter(Boolean);
  if (!unique.length) {
    return { prices: new Map(), sources: { jupiter: 0, birdeye: 0, missing: 0 } };
  }

  const prices = await jupiter.getPrices(unique);
  const fromJupiter = prices.size;

  // Only mints the caller called critical are worth Birdeye's metered budget.
  const critical = options.critical ? [...new Set(options.critical)] : unique;
  const missing = critical.filter((mint) => mint && !prices.has(mint));

  if (missing.length) {
    const fallback = await birdeye.getPrices(missing).catch(() => new Map<string, number>());
    for (const [mint, value] of fallback) {
      if (Number.isFinite(value) && value > 0) prices.set(mint, value);
    }
  }

  const sources: PriceSources = {
    jupiter: fromJupiter,
    birdeye: prices.size - fromJupiter,
    missing: unique.length - prices.size,
  };

  if (process.env.NODE_ENV !== 'production') {
    console.info(
      `[pricing] ${unique.length} mints -> ${sources.jupiter} jupiter, ` +
        `${sources.birdeye} birdeye, ${sources.missing} unpriced`
    );
  }

  return { prices, sources };
}

/** Drop-in replacement for `birdeye.getPrices`. */
export async function getPrices(
  mints: readonly string[],
  options: PriceOptions = {}
): Promise<Map<string, number>> {
  return (await getPricesWithSources(mints, options)).prices;
}

export async function getPrice(mint: string): Promise<number | null> {
  return (await getPrices([mint])).get(mint) ?? null;
}
