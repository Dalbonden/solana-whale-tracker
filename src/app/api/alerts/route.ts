import { z } from 'zod';

import { fail, handleError, listResponse, ok, searchParamsToObject } from '@/lib/api';
import { listAlerts } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  type: z
    .enum([
      'new_position',
      'large_buy',
      'large_sell',
      'full_exit',
      'rotation',
      'cluster_buy',
      'pumpfun_snipe',
      'whale_discovered',
    ])
    .optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  whale: z.string().max(64).optional(),
  mint: z.string().max(64).optional(),
  /** Cursor for incremental polling: only alerts created after this timestamp. */
  since: z.string().datetime().optional(),
  hours: z.coerce.number().min(1).max(24 * 30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/alerts
 *
 * Query: type, severity, whale, mint, since (ISO cursor) | hours, page, pageSize
 */
export async function GET(request: Request) {
  try {
    const parsed = querySchema.safeParse(searchParamsToObject(request.url));
    if (!parsed.success) {
      return fail('Invalid query parameters', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    const { hours, ...rest } = parsed.data;
    const since = rest.since ?? (hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined);

    const { rows, count } = await listAlerts({ ...rest, since });

    const bySeverity = { info: 0, warning: 0, critical: 0 };
    for (const alert of rows) bySeverity[alert.severity]++;

    return ok({
      ...listResponse(rows, count, parsed.data.page, parsed.data.pageSize),
      summary: bySeverity,
      /** Pass back as `since` on the next poll. */
      cursor: rows[0]?.created_at ?? since ?? null,
    });
  } catch (error) {
    return handleError(error, 'alerts.list');
  }
}
