import { Activity, Bell, Coins, TrendingUp, Waves } from 'lucide-react';
import Link from 'next/link';

import { ActivityFeed } from '@/components/activity-feed';
import { AlertList } from '@/components/alert-list';
import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { TokenLeaderboard } from '@/components/token-leaderboard';
import { WhaleTable } from '@/components/whale-table';
import type { ArchetypeView } from '@/components/archetype-badges';
import { buildArchetypeMetrics } from '@/lib/core/wallet-profile';
import { Button } from '@/components/ui/button';
import {
  getDashboardStats,
  getLeaderboard,
  listAlerts,
  listTrades,
  listWhales,
} from '@/lib/db/repositories';
import { formatUsd } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  let data;
  try {
    const [stats, whales, trades, alerts, leaderboard] = await Promise.all([
      getDashboardStats(),
      listWhales({ pageSize: 10, sort: 'score' }),
      listTrades({ pageSize: 40 }),
      listAlerts({ pageSize: 8 }),
      getLeaderboard(10),
    ]);
    data = { stats, whales, trades, alerts, leaderboard };
  } catch (error) {
    return (
      <div className="space-y-6">
        <Header />
        <SetupNotice error={(error as Error).message} />
      </div>
    );
  }

  const { stats, whales, trades, alerts, leaderboard } = data;

  // Behaviour tags are an enhancement: if the aggregation fails the dashboard
  // still renders, just without badges.
  const profiles = await buildArchetypeMetrics(whales.rows).catch(() => null);
  const archetypes: Record<string, ArchetypeView[]> = {};
  if (profiles) {
    for (const [address, profile] of profiles) archetypes[address] = profile.archetypes;
  }

  const cards: Stat[] = [
    { label: 'Whales tracked', value: stats.whaleCount.toLocaleString(), icon: Waves },
    { label: 'Meme tokens', value: stats.trackedTokens.toLocaleString(), icon: Coins },
    { label: 'Trades 24h', value: stats.trades24h.toLocaleString(), icon: Activity },
    { label: 'Volume 24h', value: formatUsd(stats.volume24hUsd), icon: TrendingUp },
    {
      label: 'Net flow 24h',
      value: `${stats.netFlow24hUsd >= 0 ? '+' : ''}${formatUsd(stats.netFlow24hUsd)}`,
      tone: stats.netFlow24hUsd >= 0 ? 'bull' : 'bear',
      hint: stats.netFlow24hUsd >= 0 ? 'whales net buyers' : 'whales net sellers',
      icon: TrendingUp,
    },
    { label: 'Alerts 24h', value: stats.alerts24h.toLocaleString(), icon: Bell },
  ];

  return (
    <div className="space-y-6">
      <Header />

      <StatCards stats={cards} />

      <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-3">
            <SectionHeader
              title="Meme token leaderboard"
              subtitle="Ranked by net whale flow over the last 24 hours"
              href="/tokens"
            />
            <TokenLeaderboard rows={leaderboard} />
          </section>

          <section className="space-y-3">
            <SectionHeader
              title="Top whales"
              subtitle="Highest composite score across portfolio, size, frequency and meme exposure"
              href="/whales"
            />
            <WhaleTable whales={whales.rows} showSearch={false} archetypes={archetypes} />
          </section>
        </div>

        <div className="min-w-0 space-y-6">
          <ActivityFeed initial={trades.rows} limit={40} />

          <section className="space-y-3">
            <SectionHeader title="Recent alerts" href="/alerts" />
            <AlertList initial={alerts.rows} limit={8} live={false} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Whale dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Solana wallets with size, tracked across meme tokens in real time.
        </p>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  href,
}: {
  title: string;
  subtitle?: string;
  href?: string;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {href && (
        <Button asChild variant="ghost" size="sm">
          <Link href={href}>View all</Link>
        </Button>
      )}
    </div>
  );
}
