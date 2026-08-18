import { fail, handleError, ok } from '@/lib/api';
import { analyzeTokenRisk } from '@/lib/core/token-risk';
import { isValidSolanaAddress } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/tokens/[mint]/risk
 *
 * Holder-concentration and rug-vector analysis.
 *
 * This reports risk, not a forecast. It measures how much damage a large holder
 * *could* do — and whether anyone can mint more supply or freeze balances — but
 * says nothing about whether a token will rise or fall.
 */
export async function GET(_request: Request, { params }: { params: { mint: string } }) {
  try {
    if (!isValidSolanaAddress(params.mint)) return fail('Invalid mint address', 400);
    const risk = await analyzeTokenRisk(params.mint);
    return ok(risk);
  } catch (error) {
    return handleError(error, 'tokens.risk');
  }
}
