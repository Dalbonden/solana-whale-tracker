import { NextResponse } from 'next/server';

import { analyseLaunch } from '@/lib/core/forensics';
import { getToken } from '@/lib/db/repositories';
import { isValidSolanaAddress } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/tokens/[mint]/forensics — launch behaviour analysis.
 *
 * Reconstructs a token's opening trades and reports which wallets bought first,
 * how much of the opening supply they took, whether they still hold it, and
 * which wallets moved together.
 *
 * Read-only and derived entirely from public chain data. It describes patterns
 * and never asserts identity, intent or wrongdoing — see the module doc in
 * `lib/core/forensics.ts`.
 */
export async function GET(_request: Request, { params }: { params: { mint: string } }) {
  const mint = params.mint;

  if (!isValidSolanaAddress(mint)) {
    return NextResponse.json({ error: 'Not a valid Solana address.' }, { status: 400 });
  }

  try {
    const report = await analyseLaunch(mint);

    // Symbol is a nicety: the analysis works on any mint, tracked or not.
    if (!report.symbol) {
      const token = await getToken(mint).catch(() => null);
      report.symbol = token?.symbol ?? null;
    }

    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
