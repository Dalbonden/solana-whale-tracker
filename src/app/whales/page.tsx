import type { Metadata } from 'next';

import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { WhaleTable } from '@/components/whale-table';
import { listWhales } from '@/lib/db/repositories';
import { formatUsd } from '@/lib/utils';

export const metadata: Metadata = { title: 'Whales' };
export const dynamic = 'force-dynamic';

export default async function WhalesPage({
  searchParams,
}: {
  searchParams: { tier?: string; page?: string };
}) {
  const page = Math.max(1, Number(searchParams.page) || 1);

  let result;
  try {
    result = await listWhales({
      tier: searchParams.tier,
      page,
      pageSize: 100,
      sort: 'score',
    });
  } catch (error) {
    return (
      <div className="space-y-6">
        <Header />
        <SetupNotice error={(error as Error).message} />
      </div>
    );
  }

  const { rows, count } = result;

  const aggregate = rows.reduce(
    (acc, whale) => ({
      portfolio: acc.portfolio + whale.portfolio_value_usd,
      meme: acc.meme + whale.meme_value_usd,
      trades: acc.trades + whale.trade_count_30d,
    }),
    { portfolio: 0, meme: 0, trades: 0 }
  );

  const byTier = rows.reduce<Record<string, number>>((acc, whale) => {
    acc[whale.tier] = (acc[whale.tier] ?? 0) + 1;
    return acc;
  }, {});

  const cards: Stat[] = [
    { label: 'Tracked', value: count.toLocaleString() },
    { label: 'Krakens', value: String(byTier.kraken ?? 0), hint: 'score ≥ 85' },
    { label: 'Whales', value: String(byTier.whale ?? 0), hint: 'score 65–85' },
    { label: 'Dolphins', value: String(byTier.dolphin ?? 0), hint: 'score 45–65' },
    { label: 'Combined portfolio', value: formatUsd(aggregate.portfolio) },
    { label: 'Combined meme value', value: formatUsd(aggregate.meme) },
  ];

  return (
    <div className="space-y-6">
      <Header />
      <StatCards stats={cards} />
      <WhaleTable whales={rows} />

      {count > rows.length && (
        <p className="text-center text-xs text-muted-foreground">
          Showing {rows.length} of {count.toLocaleString()} tracked wallets.
        </p>
      )}
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Whales</h1>
      <p className="text-sm text-muted-foreground">
        Wallets that cleared the portfolio floor and are actively rotating meme exposure.
      </p>
    </div>
  );
}
