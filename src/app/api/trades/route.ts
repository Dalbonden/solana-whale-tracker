import { z } from 'zod';

import { fail, handleError, listResponse, ok, searchParamsToObject } from '@/lib/api';
import { listTrades } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  whale: z.string().max(64).optional(),
  mint: z.string().max(64).optional(),
  side: z.enum(['buy', 'sell']).optional(),
  venue: z
    .enum(['jupiter', 'raydium', 'pumpfun', 'pumpswap', 'orca', 'meteora', 'phoenix', 'lifinity', 'unknown'])
    .optional(),
  minUsd: z.coerce.number().min(0).optional(),
  /** Hours of history to include; mutually exclusive with an explicit `since`. */
  hours: z.coerce.number().min(1).max(24 * 90).optional(),
  since: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/trades
 *
 * The activity feed and every trade table read from here.
 * Query: whale, mint, side, venue, minUsd, hours | since, page, pageSize
 */
export async function GET(request: Request) {
  try {
    const parsed = querySchema.safeParse(searchParamsToObject(request.url));
    if (!parsed.success) {
      return fail('Invalid query parameters', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    const { hours, ...rest } = parsed.data;
    const since = rest.since ?? (hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined);

    const { rows, count } = await listTrades({ ...rest, since });

    // Feed-level aggregates so the client does not have to re-derive them.
    let buyUsd = 0;
    let sellUsd = 0;
    for (const trade of rows) {
      if (trade.side === 'buy') buyUsd += trade.usd_value;
      else sellUsd += trade.usd_value;
    }

    return ok({
      ...listResponse(rows, count, parsed.data.page, parsed.data.pageSize),
      summary: { buyUsd, sellUsd, netUsd: buyUsd - sellUsd },
    });
  } catch (error) {
    return handleError(error, 'trades.list');
  }
}
