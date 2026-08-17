import type { Metadata } from 'next';
import Link from 'next/link';

import { AlertList } from '@/components/alert-list';
import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { listAlerts } from '@/lib/db/repositories';
import { cn } from '@/lib/utils';
import type { AlertType } from '@/types';

export const metadata: Metadata = { title: 'Alerts' };
export const dynamic = 'force-dynamic';

const FILTERS: Array<{ value: AlertType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'cluster_buy', label: 'Clusters' },
  { value: 'rotation', label: 'Rotations' },
  { value: 'new_position', label: 'New positions' },
  { value: 'pumpfun_snipe', label: 'Snipes' },
  { value: 'full_exit', label: 'Exits' },
  { value: 'large_buy', label: 'Large buys' },
  { value: 'large_sell', label: 'Large sells' },
];

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: { type?: string };
}) {
  const active = (searchParams.type ?? 'all') as AlertType | 'all';

  let data;
  try {
    const [filtered, recent] = await Promise.all([
      listAlerts({
        type: active === 'all' ? undefined : active,
        pageSize: 100,
      }),
      listAlerts({ since: new Date(Date.now() - 24 * 3600_000).toISOString(), pageSize: 200 }),
    ]);
    data = { filtered, recent };
  } catch (error) {
    return (
      <div className="space-y-6">
        <Header />
        <SetupNotice error={(error as Error).message} />
      </div>
    );
  }

  const { filtered, recent } = data;

  const counts = recent.rows.reduce<Record<string, number>>((acc, alert) => {
    acc[alert.type] = (acc[alert.type] ?? 0) + 1;
    acc[`sev:${alert.severity}`] = (acc[`sev:${alert.severity}`] ?? 0) + 1;
    return acc;
  }, {});

  const cards: Stat[] = [
    { label: 'Alerts 24h', value: String(recent.rows.length) },
    { label: 'Critical', value: String(counts['sev:critical'] ?? 0), tone: 'bear' },
    { label: 'Rotations', value: String(counts.rotation ?? 0) },
    { label: 'Clusters', value: String(counts.cluster_buy ?? 0) },
    { label: 'New positions', value: String(counts.new_position ?? 0), tone: 'bull' },
    { label: 'Snipes', value: String(counts.pumpfun_snipe ?? 0) },
  ];

  return (
    <div className="space-y-6">
      <Header />
      <StatCards stats={cards} />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === 'all' ? '/alerts' : `/alerts?type=${filter.value}`}
            className={cn(
              'rounded-md border px-3 py-1 text-xs transition-colors',
              active === filter.value
                ? 'border-border bg-secondary text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {filter.label}
          </Link>
        ))}
      </div>

      <AlertList initial={filtered.rows} limit={100} live={active === 'all'} />
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
      <p className="text-sm text-muted-foreground">
        Derived signals: new positions, rotations, whale clusters, snipes and outsized trades.
      </p>
    </div>
  );
}
