import type { Metadata } from 'next';

import { AddTokenForm } from '@/components/add-token-form';
import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { TokenLeaderboard } from '@/components/token-leaderboard';
import { getLeaderboard } from '@/lib/db/repositories';
import { formatUsd } from '@/lib/utils';

export const metadata: Metadata = { title: 'Meme tokens' };
export const dynamic = 'force-dynamic';

export default async function TokensPage() {
  let rows;
  try {
    rows = await getLeaderboard(100);
  } catch (error) {
    return (
      <div className="space-y-6">
        <Header />
        <SetupNotice error={(error as Error).message} />
      </div>
    );
  }

  const inflow = rows.filter((row) => row.net_flow_usd_24h > 0);
  const outflow = rows.filter((row) => row.net_flow_usd_24h < 0);
  const totalBuy = rows.reduce((sum, row) => sum + row.whale_buy_usd_24h, 0);
  const totalSell = rows.reduce((sum, row) => sum + row.whale_sell_usd_24h, 0);
  const newPositions = rows.reduce((sum, row) => sum + row.new_positions_24h, 0);

  const cards: Stat[] = [
    { label: 'Tracked tokens', value: String(rows.length) },
    { label: 'Net inflow', value: String(inflow.length), tone: 'bull', hint: 'tokens whales are buying' },
    { label: 'Net outflow', value: String(outflow.length), tone: 'bear', hint: 'tokens whales are selling' },
    { label: 'Whale buys 24h', value: formatUsd(totalBuy), tone: 'bull' },
    { label: 'Whale sells 24h', value: formatUsd(totalSell), tone: 'bear' },
    { label: 'New positions 24h', value: String(newPositions), hint: 'first-time whale entries' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Header />
        <AddTokenForm />
      </div>

      <StatCards stats={cards} />
      <TokenLeaderboard rows={rows} />

      <p className="text-xs text-muted-foreground">
        The universe is seeded with a curated core list and extended automatically by the token cron,
        which admits pump.fun graduates and trending tokens that clear the liquidity, volume and
        market-cap floors.
      </p>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Meme tokens</h1>
      <p className="text-sm text-muted-foreground">
        Ranked by net whale flow over the last 24 hours.
      </p>
    </div>
  );
}
