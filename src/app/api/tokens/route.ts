import { z } from 'zod';

import { fail, handleError, ok, searchParamsToObject } from '@/lib/api';
import { addTokenToUniverse, invalidateUniverseCache } from '@/lib/core/meme-filter';
import { getLeaderboard, listTokens, setTokenActive } from '@/lib/db/repositories';
import { isValidSolanaAddress } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  /** `leaderboard` adds 24h whale-flow columns; `list` is the raw universe. */
  view: z.enum(['list', 'leaderboard']).default('leaderboard'),
  includeInactive: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** GET /api/tokens — the tracked meme-token universe. */
export async function GET(request: Request) {
  try {
    const parsed = querySchema.safeParse(searchParamsToObject(request.url));
    if (!parsed.success) {
      return fail('Invalid query parameters', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    if (parsed.data.view === 'leaderboard') {
      const rows = await getLeaderboard(parsed.data.limit);
      return ok({ data: rows, count: rows.length });
    }

    const rows = await listTokens({
      activeOnly: !parsed.data.includeInactive,
      limit: parsed.data.limit,
    });
    return ok({ data: rows, count: rows.length });
  } catch (error) {
    return handleError(error, 'tokens.list');
  }
}

const createSchema = z.object({
  mint: z.string().refine(isValidSolanaAddress, 'not a valid mint address'),
  /** Skip the meme classifier — the caller has already decided. */
  force: z.boolean().default(false),
});

/**
 * POST /api/tokens — add a meme token to the tracked universe.
 *
 * Without `force`, the mint must pass `classifyToken`: liquidity, volume and
 * market-cap floors plus meme heuristics. The rejection reason is returned so
 * it is obvious why a token was refused.
 */
export async function POST(request: Request) {
  try {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail('Invalid body', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    const result = await addTokenToUniverse(parsed.data.mint, {
      force: parsed.data.force,
      source: 'manual',
    });

    if (!result.added) {
      return fail(result.reason ?? 'token was not added', 422, {
        mint: parsed.data.mint,
        hint: 'Pass { "force": true } to bypass the meme-token classifier.',
      });
    }

    return ok({ token: result.token }, { status: 201 });
  } catch (error) {
    return handleError(error, 'tokens.create');
  }
}

const patchSchema = z.object({
  mint: z.string().refine(isValidSolanaAddress, 'not a valid mint address'),
  is_active: z.boolean(),
});

/** PATCH /api/tokens — activate or deactivate a token without deleting history. */
export async function PATCH(request: Request) {
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail('Invalid body', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    await setTokenActive(parsed.data.mint, parsed.data.is_active);
    invalidateUniverseCache();
    return ok({ mint: parsed.data.mint, is_active: parsed.data.is_active });
  } catch (error) {
    return handleError(error, 'tokens.patch');
  }
}
