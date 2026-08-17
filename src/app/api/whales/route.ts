import { z } from 'zod';

import { fail, handleError, listResponse, ok, searchParamsToObject } from '@/lib/api';
import { listWhales } from '@/lib/db/repositories';
import { isValidSolanaAddress } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  tier: z.enum(['shrimp', 'dolphin', 'whale', 'kraken']).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  search: z.string().max(64).optional(),
  sort: z.enum(['score', 'portfolio_value_usd', 'last_active_at', 'trade_count_30d']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/whales
 *
 * Query: tier, minScore, search, sort, page, pageSize
 */
export async function GET(request: Request) {
  try {
    const parsed = querySchema.safeParse(searchParamsToObject(request.url));
    if (!parsed.success) {
      return fail('Invalid query parameters', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    const { rows, count } = await listWhales(parsed.data);
    return ok(listResponse(rows, count, parsed.data.page, parsed.data.pageSize));
  } catch (error) {
    return handleError(error, 'whales.list');
  }
}

const createSchema = z.object({
  address: z.string().refine(isValidSolanaAddress, 'not a valid Solana address'),
  label: z.string().max(64).optional(),
});

/**
 * POST /api/whales — add a wallet to tracking manually and backfill its recent
 * meme-token trades.
 *
 * Body: { address: string, label?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail('Invalid body', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    const { trackWhale } = await import('@/lib/core/whale-tracker');
    const result = await trackWhale(parsed.data.address, {
      label: parsed.data.label ?? null,
    });

    return ok(
      {
        whale: result.whale,
        backfill: {
          parsed: result.backfill.parsed,
          stored: result.backfill.stored,
          alerts: result.backfill.alerts,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error, 'whales.create');
  }
}
