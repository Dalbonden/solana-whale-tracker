import { z } from 'zod';

import { fail, handleError, ok } from '@/lib/api';
import {
  getCurrentPortfolio,
  getPortfolioTimeline,
  getWhale,
  listAlerts,
  listTrades,
  upsertWhales,
} from '@/lib/db/repositories';
import { isValidSolanaAddress } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/whales/[address]
 *
 * Returns the whale record plus its current portfolio, value timeline, recent
 * trades and recent alerts — everything the profile page renders, in one call.
 */
export async function GET(request: Request, { params }: { params: { address: string } }) {
  try {
    const address = params.address;
    if (!isValidSolanaAddress(address)) return fail('Invalid Solana address', 400);

    const whale = await getWhale(address);
    if (!whale) return fail('Whale not tracked', 404, { address });

    const url = new URL(request.url);
    const days = Math.min(Number(url.searchParams.get('days') ?? 30) || 30, 365);
    const tradeLimit = Math.min(Number(url.searchParams.get('trades') ?? 100) || 100, 200);

    const [portfolio, timeline, trades, alerts] = await Promise.all([
      getCurrentPortfolio(address),
      getPortfolioTimeline(address, days),
      listTrades({ whale: address, pageSize: tradeLimit }),
      listAlerts({ whale: address, pageSize: 25 }),
    ]);

    const memeValue = portfolio.reduce((sum, h) => sum + (h.is_meme ? h.usd_value : 0), 0);
    const totalValue = portfolio.reduce((sum, h) => sum + h.usd_value, 0);

    // Realised flow across the stored history: what they put in vs took out.
    let boughtUsd = 0;
    let soldUsd = 0;
    for (const trade of trades.rows) {
      if (trade.side === 'buy') boughtUsd += trade.usd_value;
      else soldUsd += trade.usd_value;
    }

    return ok({
      whale,
      portfolio: {
        holdings: portfolio,
        totalUsd: totalValue,
        memeUsd: memeValue,
        memeExposure: totalValue > 0 ? memeValue / totalValue : 0,
        positions: portfolio.length,
      },
      timeline,
      trades: trades.rows,
      tradeCount: trades.count,
      alerts: alerts.rows,
      flow: { boughtUsd, soldUsd, netUsd: boughtUsd - soldUsd },
    });
  } catch (error) {
    return handleError(error, 'whales.get');
  }
}

const patchSchema = z.object({
  label: z.string().max(64).nullable().optional(),
  is_tracked: z.boolean().optional(),
});

/** PATCH /api/whales/[address] — rename or stop tracking a wallet. */
export async function PATCH(request: Request, { params }: { params: { address: string } }) {
  try {
    const address = params.address;
    if (!isValidSolanaAddress(address)) return fail('Invalid Solana address', 400);

    const existing = await getWhale(address);
    if (!existing) return fail('Whale not tracked', 404, { address });

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail('Invalid body', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    await upsertWhales([{ address, ...parsed.data }]);
    return ok({ whale: { ...existing, ...parsed.data } });
  } catch (error) {
    return handleError(error, 'whales.patch');
  }
}

/**
 * POST /api/whales/[address] — force an immediate resync of this wallet.
 * Useful after adding a whale, or when debugging a missing trade.
 */
export async function POST(request: Request, { params }: { params: { address: string } }) {
  try {
    const address = params.address;
    if (!isValidSolanaAddress(address)) return fail('Invalid Solana address', 400);

    const whale = await getWhale(address);
    if (!whale) return fail('Whale not tracked', 404, { address });

    const { syncWhale } = await import('@/lib/core/whale-tracker');
    const { snapshotWhale } = await import('@/lib/core/portfolio');

    const sync = await syncWhale(whale);
    const snapshot = await snapshotWhale(whale);

    return ok({ sync, snapshot });
  } catch (error) {
    return handleError(error, 'whales.resync');
  }
}
