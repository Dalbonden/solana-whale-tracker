import type { Metadata } from 'next';

import { ForensicsReport } from '@/components/forensics-report';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Launch forensics',
  description:
    'Behavioural analysis of who bought a Solana token first, using public on-chain data.',
};

export default function ForensicsPage({
  searchParams,
}: {
  searchParams: { mint?: string };
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Launch forensics</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Reconstructs a token&apos;s opening trades to show who bought first, how much of the
          opening supply they took, whether they still hold it, and which wallets moved together.
          Everything comes from public blockchain data.
        </p>
      </div>

      <ForensicsReport initialMint={searchParams.mint ?? ''} />
    </div>
  );
}
